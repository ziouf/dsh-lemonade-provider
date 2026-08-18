/**
 * Host proxy for the Lemonade-specific API (https://lemonade-server.ai/docs/api/lemonade/),
 * mounted by src/index.ts on the dsh web server under the /dsh-lemonade/api
 * prefix route (ctx.webServer.register). The browser client half calls these
 * routes same-origin; the host resolves the base URL from the llm-lemonade
 * settings section and the optional API key through the credentials seam, so
 * the key never reaches the browser.
 *
 * @module dsh-lemonade-provider/server-api
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';

/** Route prefix registered on ctx.webServer. */
export const API_ROUTE = '/dsh-lemonade/api';
/** Maximum accepted request body and proxied response body in bytes. */
export const MAX_BODY_BYTES = 1_000_000;
/** Fetch timeout for proxied Lemonade calls. */
export const API_TIMEOUT_MS = 10_000;
const TIMEOUT_CODE = 'LEMONADE_API_TIMEOUT';

/** Host-side connection facts the proxy resolves per request. */
export interface LemonadeApiConfig {
  baseURL(): string;
  requireAuth(): boolean;
  /** Credential reference for the regular API key (LEMONADE_API_KEY). */
  apiKeyRef(): CredentialRef;
  /** Credential reference for the admin API key (LEMONADE_ADMIN_API_KEY). */
  adminApiKeyRef(): CredentialRef;
  /**
   * Resolve one credential reference to its current value (never throws).
   * @param ref - the reference to resolve through the credentials seam / env.
   * @returns the usable key, or undefined when unconfigured.
   */
  resolveKey(ref: CredentialRef): Promise<string | undefined>;
}

/** Successful wire result. */
export interface LemonadeWireOk {
  ok: true;
  value: unknown;
}
/** Failed wire result. */
export interface LemonadeWireError {
  ok: false;
  error: { message: string; code: string; status?: number };
}
export type LemonadeWireResult = LemonadeWireOk | LemonadeWireError;

const okResult = (value: unknown): LemonadeWireResult => ({ ok: true, value });
const errResult = (message: string, code: string, status?: number): LemonadeWireResult => ({
  ok: false,
  error: { message, code, ...(status === undefined ? {} : { status }) },
});

/** Map a Lemonade HTTP status to a stable harness-style code. */
export function mapLemonadeStatus(status: number): string {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 409) return 'CONFLICT';
  if (status === 400) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return 'HTTP_' + status;
}

/** Client-input error normalized to a wire result. */
/** Ops that target internal/control endpoints, authenticated with the admin key. */
const ADMIN_OPS = new Set([
  'metrics',
  'internalTelemetryFlush',
  'internalAliases',
  'internalAliasesSet',
  'internalAliasesDelete',
]);
const isAdminOp = (op: string): boolean => ADMIN_OPS.has(op);

class RequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Build the stable Lemonade endpoint for one op. */
function resolveTarget(
  op: string,
  args: readonly string[],
  query: URLSearchParams,
  body: unknown,
): { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: unknown } {
  const record = asRecord(body);
  const pick = (keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
    return out;
  };
  const qs = (extra: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value.length > 0) params.set(key, value);
    }
    const text = params.toString();
    return text.length > 0 ? '?' + text : '';
  };
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  /**
   * The Lemonade model-management endpoints take the model id under
   * `model_name` (the spec: load/unload/delete). This client historically sent
   * `model`; accept both and forward the canonical `model_name`.
   */
  const modelName = (): string | undefined => {
    const named = record.model_name;
    if (typeof named === 'string' && named.length > 0) return named;
    const alias = record.model;
    return typeof alias === 'string' && alias.length > 0 ? alias : undefined;
  };
  switch (op) {
    case 'health': return { method: 'GET', url: '/v1/health' };
    case 'live': return { method: 'GET', url: '/live' };
    case 'models':
      return { method: 'GET', url: '/v1/models' + qs({ show_all: str(query.get('show_all') ?? record.show_all) }) };
    case 'modelFiles': {
      const id = args[0];
      if (id === undefined || id.length === 0) throw new RequestError('model id required', 'INVALID_REQUEST', 400);
      return { method: 'GET', url: '/v1/models/' + encodeURIComponent(id) + '/files' };
    }
    case 'load': {
      const mn = modelName();
      if (mn === undefined) throw new RequestError('model required', 'INVALID_REQUEST', 400);
      return {
        method: 'POST',
        url: '/v1/load',
        body: {
          model_name: mn,
          ...pick(['pinned', 'save_options', 'ctx_size', 'llamacpp_backend', 'llamacpp_args', 'whispercpp_backend', 'whispercpp_args', 'steps', 'cfg_scale', 'width', 'height', 'merge_args']),
        },
      };
    }
    case 'unload': {
      const mn = modelName();
      // model_name optional: omitted unloads every loaded model (spec).
      return { method: 'POST', url: '/v1/unload', body: mn === undefined ? {} : { model_name: mn } };
    }
    case 'delete': {
      const mn = modelName();
      if (mn === undefined) throw new RequestError('model required', 'INVALID_REQUEST', 400);
      return { method: 'POST', url: '/v1/delete', body: { model_name: mn } };
    }
    case 'checkUpdates': return { method: 'POST', url: '/v1/models/check-updates' };
    case 'registrySearch':
      return {
        method: 'GET',
        url: '/v1/registry/search' + qs({
          query: str(query.get('query') ?? query.get('q') ?? record.query),
          source: str(query.get('source') ?? record.source),
          format: str(query.get('format') ?? record.format),
          limit: str(query.get('limit') ?? (record.limit !== undefined ? String(record.limit) : undefined)),
        }),
      };
    case 'pullVariants':
      return {
        method: 'GET',
        url: '/v1/pull/variants' + qs({
          checkpoint: str(query.get('checkpoint') ?? record.checkpoint),
        }),
      };
    case 'pull':
      // Spec: model_name (Yes, user.* namespace), recipe (Yes), checkpoint (Yes*),
      // plus checkpoints dict, reasoning/vision/embedding/reranking, mmproj.
      return {
        method: 'POST',
        url: '/v1/pull',
        body: pick(['model_name', 'recipe', 'checkpoint', 'checkpoints', 'reasoning', 'vision', 'embedding', 'reranking', 'mmproj', 'stream', 'subscribe']),
      };
    case 'downloads': return { method: 'GET', url: '/v1/downloads' };
    case 'downloadsControl': return { method: 'POST', url: '/v1/downloads/control', body: pick(['id', 'action']) };
    case 'stats': return { method: 'GET', url: '/v1/stats' };
    case 'systemStats': return { method: 'GET', url: '/v1/system-stats' };
    case 'systemInfo': return { method: 'GET', url: '/v1/system-info' };
    case 'cloudAuthSet': return { method: 'POST', url: '/v1/cloud/auth', body: pick(['provider', 'api_key']) };
    case 'cloudAuthDelete': {
      const provider = args[0];
      if (provider === undefined || provider.length === 0) throw new RequestError('provider required', 'INVALID_REQUEST', 400);
      return { method: 'DELETE', url: '/v1/cloud/auth/' + encodeURIComponent(provider) };
    }
    // Admin / internal endpoints (authenticated with the admin API key).
    case 'metrics':
      return { method: 'GET', url: '/metrics' };
    case 'internalTelemetryFlush':
      return { method: 'POST', url: '/internal/telemetry/flush' };
    case 'internalAliases':
      return { method: 'GET', url: '/internal/aliases' };
    case 'internalAliasesSet':
      return { method: 'POST', url: '/internal/aliases', body: pick(['alias', 'target', 'model']) };
    case 'internalAliasesDelete': {
      const alias = args[0];
      if (alias === undefined || alias.length === 0) throw new RequestError('alias required', 'INVALID_REQUEST', 400);
      return { method: 'DELETE', url: '/internal/aliases/' + encodeURIComponent(alias) };
    }
    default: throw new RequestError('unknown Lemonade api op: ' + op, 'NOT_FOUND', 404);
  }
}

async function readResponseText(response: Response): Promise<{ text: string; tooLarge: boolean }> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return { text: '', tooLarge: true };
  return { text: new TextDecoder().decode(buffer), tooLarge: false };
}

/**
 * Dispatch one proxied Lemonade API call.
 * @param cfg - connection facts (thunks resolved per call).
 * @param method - HTTP method from the client (GET/POST/DELETE).
 * @param op - first path segment after the route prefix.
 * @param segments - remaining path segments after the route prefix.
 * @param query - parsed query string.
 * @param body - parsed request body (undefined when none).
 * @param signal - optional caller cancellation.
 */
export async function serveLemonadeApi(
  cfg: LemonadeApiConfig,
  method: string,
  op: string,
  args: readonly string[],
  query: URLSearchParams,
  body: unknown,
  signal?: AbortSignal,
): Promise<LemonadeWireResult> {
  let target: { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: unknown };
  try {
    target = resolveTarget(op, args, query, body);
  } catch (error) {
    if (error instanceof RequestError) return errResult(error.message, error.code, error.status);
    throw error;
  }
  if (method !== target.method) {
    return errResult(
      'method ' + method + ' not allowed for ' + op + ' (expected ' + target.method + ')',
      'METHOD_NOT_ALLOWED',
      405,
    );
  }
  // Per-endpoint key selection: internal/control endpoints (/internal/*, /metrics)
  // authenticate with the admin key (falling back to the regular key, which
  // lemonade accepts for /metrics); regular endpoints use the regular key (the
  // admin key is a superior credential and also works when it is the only one set).
  const admin = isAdminOp(op);
  const regularKey = await cfg.resolveKey(cfg.apiKeyRef());
  const adminKey = await cfg.resolveKey(cfg.adminApiKeyRef());
  const apiKey = admin ? (adminKey ?? regularKey) : (regularKey ?? adminKey);
  if (!admin && apiKey === undefined && cfg.requireAuth()) {
    return errResult(
      'llm-lemonade: the Lemonade server requires a key (requireAuth) and none is set; store LEMONADE_API_KEY or LEMONADE_ADMIN_API_KEY via Settings > Models > Lemonade',
      'MISSING_CREDENTIAL',
    );
  }
  const configured = (cfg.baseURL() || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  // /internal/*, /live and /metrics are ROOT-level (no /api, no /v1) per spec;
  // everything else is served under the /api prefix.
  const isRootPath = target.url.startsWith('/internal/') || target.url === '/live' || target.url === '/metrics';
  const base = isRootPath ? configured.replace(/\/api$/i, '') : configured;
  const url = base + target.url;
  const headers: Record<string, string> = { accept: 'application/json', ...attributionHeaders() };
  if (apiKey !== undefined) headers.authorization = 'Bearer ' + apiKey;
  if (target.body !== undefined) headers['content-type'] = 'application/json';

  const timer = deadline(signal, API_TIMEOUT_MS, TIMEOUT_CODE);
  let response: Response;
  try {
    response = await fetch(url, {
      method: target.method,
      headers,
      ...(target.body === undefined ? {} : { body: JSON.stringify(target.body) }),
      signal: timer.signal,
    });
  } catch (error) {
    if (timeoutOf(timer.signal, TIMEOUT_CODE) !== undefined) {
      return errResult('Lemonade API timeout after ' + API_TIMEOUT_MS + 'ms', 'TIMEOUT');
    }
    if (signal !== undefined && signal.aborted) return errResult('Lemonade request aborted by caller', 'ABORTED');
    return errResult('could not reach ' + url, 'TRANSPORT');
  } finally {
    timer[Symbol.dispose]();
  }

  const decoded = await readResponseText(response);
  if (decoded.tooLarge) {
    return errResult('Lemonade response exceeds ' + MAX_BODY_BYTES + ' bytes', 'PAYLOAD_TOO_LARGE', 413);
  }
  let value: unknown = null;
  if (decoded.text.length > 0) {
    if (op === 'metrics') {
      // Prometheus text exposition format, not JSON.
      value = decoded.text;
    } else {
      try {
        value = JSON.parse(decoded.text);
      } catch {
        return errResult('Lemonade answered with non-JSON at ' + url, 'BAD_RESPONSE', 502);
      }
    }
  }
  if (!response.ok) {
    let message = 'Lemonade API error (HTTP ' + response.status + ')';
    if (value !== null && typeof value === 'object') {
      const record = asRecord(value);
      const nested = record.error !== null && typeof record.error === 'object' ? asRecord(record.error) : undefined;
      if (nested && typeof nested.message === 'string' && nested.message.length > 0) message = nested.message;
      else if (typeof record.message === 'string' && record.message.length > 0) message = record.message;
    }
    return errResult(message, mapLemonadeStatus(response.status), response.status);
  }
  // Lemonade write endpoints (load/unload/delete/pull) answer HTTP 200 with
  // { status: 'error', message } on failure; surface it as a wire error.
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.status === 'error' && typeof record.message === 'string' && record.message.length > 0) {
      return errResult(record.message, 'LEMONADE_ERROR', response.status);
    }
  }
  return okResult(value);
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError('request body exceeds ' + MAX_BODY_BYTES + ' bytes', 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError('request body is not valid JSON', 'INVALID_REQUEST', 400);
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/**
 * Stream the Lemonade server logs (WS /logs/stream) as newline-delimited JSON
 * to the browser. The spec: the log WebSocket shares the Realtime Audio port,
 * discovered via /v1/health (websocket_port) — not the main HTTP port — then
 * `ws://<host>:<port>/logs/stream`, subscribe with `{ type: 'logs.subscribe',
 * after_seq: <int|null> }`, and the server answers `logs.snapshot` (up to
 * 5000 retained entries) then `logs.entry` lines. Messages are relayed as-is
 * (`{ type: 'logs.snapshot' | 'logs.entry' | 'error', ... }`); the response is
 * held open and closed when the browser disconnects.
 */

/**
 * Build the node:http handler mounting the Lemonade-specific API proxy at the
 * /dsh-lemonade/api prefix route (ctx.webServer.register). Never throws out:
 * every outcome is normalized to a JSON wire result.
 */
export function createLemonadeApiHandler(
  cfg: LemonadeApiConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let result: LemonadeWireResult;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rest = url.pathname.startsWith(API_ROUTE) ? url.pathname.slice(API_ROUTE.length) : url.pathname;
      const segments = rest.split('/').filter((part) => part.length > 0);
      const op = segments[0] ?? '';
      const args = segments.slice(1);
      const body =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
          ? await readRequestBody(req)
          : undefined;
      result = await serveLemonadeApi(cfg, req.method ?? 'GET', op, args, url.searchParams, body);
    } catch (error) {
      result =
        error instanceof RequestError
          ? errResult(error.message, error.code, error.status)
          : errResult('Lemonade API proxy failed: ' + String((error as Error)?.message ?? error), 'SERVER', 500);
    }
    const status = result.ok ? 200 : (result.error.status ?? 500);
    writeJson(res, status, result);
  };
}
