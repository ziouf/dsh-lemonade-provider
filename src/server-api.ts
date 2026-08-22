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
import { JsonParseError, parseJsonValue } from './json-parse.js';

/** Route prefix registered on ctx.webServer. */
export const API_ROUTE = '/dsh-lemonade/api';
/** Maximum accepted request body and proxied response body in bytes. */
export const MAX_BODY_BYTES = 1_000_000;
/** Maximum JSON nesting depth accepted in a proxied request body. */
export const MAX_JSON_DEPTH = 64;
/** Maximum path length after the route prefix (op + args). */
export const MAX_SEGMENTS = 5;
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
    case 'modelInfo': {
      const id = args[0];
      if (id === undefined || id.length === 0) throw new RequestError('model id required', 'INVALID_REQUEST', 400);
      return { method: 'GET', url: '/v1/models/' + encodeURIComponent(id) + '/info' };
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
    case 'loraList': return { method: 'GET', url: '/v1/extensions/lora/list' };
    case 'loraLoad': {
      const adapter = args[0];
      if (adapter === undefined || adapter.length === 0) throw new RequestError('adapter id required', 'INVALID_REQUEST', 400);
      return { method: 'POST', url: '/v1/extensions/lora/' + encodeURIComponent(adapter) };
    }
    case 'loraUnload': {
      const adapter = args[0];
      if (adapter === undefined || adapter.length === 0) throw new RequestError('adapter id required', 'INVALID_REQUEST', 400);
      return { method: 'DELETE', url: '/v1/extensions/lora/' + encodeURIComponent(adapter) };
    }
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
  // Batch operations are intercepted before resolveTarget: they are not a
  // single Lemonade endpoint but a sequence of one dispatched through postLemonade.
  if (op === 'batchLoad' || op === 'batchUnload' || op === 'batchDelete') {
    const ids = collectBatchIds(body);
    if (ids.length === 0) {
      return errResult('batch ' + op + ' requires a non-empty "models" list', 'INVALID_REQUEST', 400);
    }
    const build = (id: string): { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: unknown } => {
      switch (op) {
        case 'batchLoad': return { method: 'POST', url: '/v1/load', body: { model_name: id } };
        case 'batchUnload': return { method: 'POST', url: '/v1/unload', body: { model_name: id } };
        default: return { method: 'POST', url: '/v1/delete', body: { model_name: id } };
      }
    };
    const kind = op === 'batchLoad' ? 'load' : op === 'batchUnload' ? 'unload' : 'delete';
    return batchRun(cfg, kind, ids, build);
  }
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
  return postLemonade(cfg, target.url, target.method, target.body, isAdminOp(op), signal);
}

/** One sub-call of a batch operation: its resolved target plus its id. */
interface BatchCall {
  id: string;
  target: { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: unknown };
}

/**
 * Extract the target model ids from a batch-operation body. Lemonade uses the
 * `model_name` field per spec, so accept both `models` and `model_name` (single
 * or list) and ignore any other keys.
 */
function collectBatchIds(body: unknown): string[] {
  const record = asRecord(body);
  const collect = (key: 'models' | 'model_name'): string[] => {
    const raw = record[key];
    if (Array.isArray(raw)) {
      return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
    return typeof raw === 'string' && raw.length > 0 ? [raw] : [];
  };
  const ids = collect('models').concat(collect('model_name'));
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Run a batch of sub-calls against Lemonade, dispatching each sequentially
 * through {@link postLemonade} (reusing per-endpoint key selection, the
 * /api-vs-root rule, the shared timer, and status/body normalization). Each
 * sub-call error is recorded alongside the successful ones rather than
 * aborting the whole batch; the wire result carries `ok: true` with a
 * structured payload listing every item and its status.
 *
 * @param cfg - connection facts (thunks resolved per call).
 * @param kind - the operation class ("load", "unload", "delete").
 * @param ids - the identifiers to apply the operation to.
 * @param build - build one sub-call target for an id (path/body), or throw.
 */
async function batchRun(
  cfg: LemonadeApiConfig,
  kind: 'load' | 'unload' | 'delete',
  ids: readonly string[],
  build: (id: string) => { method: 'GET' | 'POST' | 'DELETE'; url: string; body?: unknown },
): Promise<LemonadeWireResult> {
  const calls: BatchCall[] = [];
  for (const id of ids) {
    try {
      calls.push({ id, target: build(id) });
    } catch (error) {
      if (error instanceof RequestError) return errResult(error.message, error.code, error.status);
      throw error;
    }
  }
  const results = [];
  for (const call of calls) {
    const wire = await postLemonade(cfg, call.target.url, call.target.method, call.target.body, false, undefined);
    results.push({
      id: call.id,
      ok: wire.ok,
      message: wire.ok ? undefined : (wire.error && (wire.error.message || wire.error.code)),
      status: wire.ok ? undefined : wire.error.status,
    });
  }
  const failed = results.filter((r) => !r.ok).length;
  return okResult({ kind, total: results.length, failed, results });
}

/**
 * Perform the HTTP round-trip to Lemonade and normalize the response into a
 * wire result. Shared by {@link serveLemonadeApi} (single op) and the batch
 * ops: it resolves the per-endpoint API key (from the target url), builds the
 * fully-qualified URL (root vs /api prefix), runs the fetch under the shared
 * timer, and applies the status/body normalization. `admin` selects the admin
 * vs regular credential and drives the root-path rule.
 */
async function postLemonade(
  cfg: LemonadeApiConfig,
  url: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: unknown,
  admin: boolean,
  signal?: AbortSignal,
): Promise<LemonadeWireResult> {
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
  const isRootPath = url.startsWith('/internal/') || url === '/live' || url === '/metrics';
  const base = isRootPath ? configured.replace(/\/api$/i, '') : configured;
  const fullUrl = base + url;
  const headers: Record<string, string> = { accept: 'application/json', ...attributionHeaders() };
  if (apiKey !== undefined) headers.authorization = 'Bearer ' + apiKey;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const timer = deadline(signal, API_TIMEOUT_MS, TIMEOUT_CODE);
  let response: Response;
  try {
    response = await fetch(fullUrl, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timer.signal,
    });
  } catch (error) {
    if (timeoutOf(timer.signal, TIMEOUT_CODE) !== undefined) {
      return errResult('Lemonade API timeout after ' + API_TIMEOUT_MS + 'ms', 'TIMEOUT');
    }
    if (signal !== undefined && signal.aborted) return errResult('Lemonade request aborted by caller', 'ABORTED');
    return errResult('could not reach ' + fullUrl, 'TRANSPORT');
  } finally {
    // Wrap cleanup in try/catch so a timer teardown error (it should never
    // throw) can't mask the original throw/return from the block above.
    try {
      timer[Symbol.dispose]();
    } catch {
      // ignore — the timer is disposable and teardown errors are non-fatal
    }
  }

  const decoded = await readResponseText(response);
  if (decoded.tooLarge) {
    return errResult('Lemonade response exceeds ' + MAX_BODY_BYTES + ' bytes', 'PAYLOAD_TOO_LARGE', 413);
  }
  let value: unknown = null;
  if (decoded.text.length > 0) {
    if (url === '/metrics') {
      // Prometheus text exposition format, not JSON.
      value = decoded.text;
    } else {
      try {
        value = JSON.parse(decoded.text);
      } catch {
        return errResult('Lemonade answered with non-JSON at ' + fullUrl, 'BAD_RESPONSE', 502);
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

/**
 * Parse one request body as JSON with a hard nesting-depth cap, so a hostile
 * client cannot send a "JSON bomb" (a tree whose width is small but whose
 * depth is enormous, whose naive JSON.parse stack would blow). Throws a
 * RequestError (INVALID_REQUEST 400) on malformed input or on exceeding the
 * depth cap, carrying the byte offset of the offending token so the client can
 * point at the exact character.
 */
/**
 * Parse one request body as JSON with a hard nesting-depth cap, so a hostile
 * client cannot send a "JSON bomb" (a tree whose width is small but whose
 * depth is enormous, whose naive JSON.parse stack would blow). A malformed or
 * too-deep body becomes a {@link RequestError} (INVALID_REQUEST 400) carrying
 * the byte offset of the offending token, so the client can point at the exact
 * character; a body over {@link MAX_BODY_BYTES} stays a 413.
 */
function parseJsonRequest(text: string): unknown {
  try {
    return parseJsonValue(text, { maxDepth: MAX_JSON_DEPTH });
  } catch (error) {
    if (error instanceof JsonParseError) {
      const detail = error.isDepthOverflow
        ? 'request body exceeds JSON depth ' + MAX_JSON_DEPTH
        : 'request body is not valid JSON near offset ' + error.position;
      throw new RequestError(detail, 'INVALID_REQUEST', 400);
    }
    throw error;
  }
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
  return parseJsonRequest(text);
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

/** Write one Server-Sent-Event line (`event:` + `data:`), splitting multi-line payloads. */
function writeSse(res: ServerResponse, event: string, data: string): void {
  res.write('event: ' + event + '\n');
  const parts = data.replace(/\r\n/g, '\n').split('\n');
  for (const line of parts) {
    res.write('data: ' + line + '\n');
  }
  res.write('\n');
}

/**
 * Serve the Lemonade server log stream to the browser as an SSE feed.
 *
 * The browser holds a plain HTTP/SSE connection to the host proxy (which owns
 * the credentials); the proxy, in turn, opens a WebSocket *client* to the
 * Lemonade log endpoint and re-emits every upstream message as an SSE event. A
 * client→Lemonade relay is mandatory here: Node's runtime exposes no
 * server-side WebSocket API and the `ws` package is not installable, so the
 * relay can never accept an upgrade itself. The log port is discovered from
 * /v1/health (`websocket_port`, which shares the Realtime Audio port and
 * therefore differs from the main API port), the log message is authenticated
 * through the regular API key, and the response is held open and closed when
 * the browser disconnects.
 */
async function serveLogsStream(
  cfg: LemonadeApiConfig,
  res: ServerResponse,
  signal?: AbortSignal,
): Promise<void> {
  const key = await cfg.resolveKey(cfg.apiKeyRef());
  const configured = (cfg.baseURL() || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const healthUrl = configured + '/v1/health';

  const openHeaders: Record<string, string> = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
    // Disable proxy buffering that would defeat the streaming contract.
    'x-accel-buffering': 'no',
  };
  res.writeHead(200, openHeaders);
  writeSse(res, 'comment', 'streaming logs');

  // Discover the WebSocket port from health before touching the log endpoint.
  let health: { status?: string; websocket_port?: number } | undefined;
  try {
    const resp = await fetch(healthUrl, { headers: { accept: 'application/json' } });
    const text = await resp.text().catch(() => '');
    if (text.trim().length > 0) {
      const parsed = JSON.parse(text) as { status?: string; websocket_port?: number };
      health = parsed;
    }
  } catch {
    writeSse(res, 'error', 'could not reach ' + healthUrl);
    res.end();
    return;
  }
  const port = health && typeof health.websocket_port === 'number' ? health.websocket_port : undefined;
  if (!port || port <= 0) {
    writeSse(res, 'error', 'Lemonade server did not advertise a websocket_port');
    res.end();
    return;
  }
  // Reuse the host of the configured base URL, but speak ws over the log port.
  const base = new URL(configured);
  const wsUrl = 'ws://' + base.hostname + ':' + port + '/logs/stream';

  let clientClosed = false;
  const upstreamAbort = () => {
    if (clientClosed) return;
    try { ws.close(1001); } catch { /* noop */ }
  };
  if (signal) {
    if (signal.aborted) upstreamAbort();
    else signal.addEventListener?.('abort', upstreamAbort);
  }
  // When the browser drops the SSE, close the upstream WebSocket cleanly.
  res.on('close', () => {
    clientClosed = true;
    if (signal) signal.removeEventListener?.('abort', upstreamAbort);
    try { ws.close(1001); } catch { /* noop */ }
  });

  const ws = new WebSocket(wsUrl);
  const decode = (data: ArrayBuffer | Buffer | string): string => {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return (data as Buffer).toString('utf8');
  };

  ws.addEventListener('open', () => {
    if (clientClosed) return;
    try {
      ws.send(JSON.stringify({ type: 'logs.subscribe', after_seq: null, ...(key !== undefined ? { key } : {}) }));
    } catch {
      writeSse(res, 'error', 'failed to subscribe to the log stream');
      res.end();
      return;
    }
    writeSse(res, 'comment', 'connected');
  });

  ws.addEventListener('message', (event) => {
    if (clientClosed) return;
    const raw = decode(event.data);
    try {
      JSON.parse(raw);
      writeSse(res, 'data', raw);
    } catch {
      writeSse(res, 'data', raw);
    }
  });

  ws.addEventListener('close', (event) => {
    if (clientClosed) return;
    writeSse(res, 'error', 'log stream closed by Lemonade (code ' + event.code + (event.reason ? ' ' + event.reason : '') + ')');
    res.end();
  });

  ws.addEventListener('error', () => {
    if (clientClosed) return;
    writeSse(res, 'error', 'log stream error');
    try { ws.close(1001); } catch { /* noop */ }
    res.end();
  });
}

/**
 * Build the node:http handler mounting the Lemonade-specific API proxy at the
 * /dsh-lemonade/api prefix route (ctx.webServer.register). Never throws out:
 * every outcome is normalized to a JSON wire result.
 */
export function createLemonadeApiHandler(
  cfg: LemonadeApiConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rest = url.pathname.startsWith(API_ROUTE) ? url.pathname.slice(API_ROUTE.length) : url.pathname;
    const segments = rest.split('/').filter((part) => part.length > 0);
    if (segments.length > MAX_SEGMENTS) {
      throw new RequestError('request path is too deep (' + segments.length + '/' + MAX_SEGMENTS + ')', 'INVALID_REQUEST', 400);
    }
    const op = segments[0] ?? '';
    const args = segments.slice(1);
    const method = req.method ?? 'GET';
    const body =
      method === 'POST' || method === 'PUT' || method === 'PATCH'
        ? await readRequestBody(req)
        : undefined;

    // The log stream is a long-lived SSE relay, not a short wire result: the
    // proxy owns the WebSocket to Lemonade and re-emits it as SSE to the browser.
    if (op === 'logsStream') {
      // IncomingMessage's type carries no request signal; derive one and fire
      // it when the browser drops the underlying socket.
      const controller = new AbortController();
      req.socket?.on?.('close', () => controller.abort());
      await serveLogsStream(cfg, res, controller.signal);
      return;
    }

    let result: LemonadeWireResult;
    try {
      result = await serveLemonadeApi(cfg, method, op, args, url.searchParams, body);
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
