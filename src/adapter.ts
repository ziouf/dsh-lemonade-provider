/**
 * `LemonadeAdapter`: fetch + SSE against a Lemonade Server (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks.
 *
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the optional bearer token through a
 * per-request resolver, so the registering plugin owns validation, layering,
 * and credential policy.
 *
 * @module dsh-lemonade-provider/adapter
 */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmDiscoveredModel,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { serializeRequest, type ResolveImage } from './serialize.js';
import { parseSse, translate } from './translate.js';

/** Default endpoint (baseURL is the server root; /v1 paths are appended by each endpoint builder). */
export const DEFAULT_BASE_URL = 'http://localhost:13305';
/** Default combined request/response context capacity for models with no metadata. */
export const DEFAULT_CONTEXT_WINDOW = 32768;
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 8192;
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Maximum time one live model-listing query may take. */
export const LISTING_TIMEOUT_MS = 5_000;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';

/** One entry of the user-pinned advisory model catalog. */
export interface LemonadeCatalogModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  vision?: boolean;
}

/** Validated connection facts resolved from raw config and the environment. */
export interface LemonadeOptions {
  apiKeyEnv: CredentialRef;
  adminApiKeyEnv: CredentialRef;
  baseURL: string;
  requireAuth: boolean;
  defaultContextWindow: number;
  maxTokens: number;
  models: LemonadeCatalogModel[];
  streamIdleTimeoutMs: number;
  retryPolicy: ResolvedRetryPolicy;
}

/** The adapter's dependency thunks, owned by the registering plugin. */
export interface LemonadeAdapterConfig {
  /** Current connection facts; re-resolved per operation, never cached across calls. */
  options(): LemonadeOptions;
  /** Current bearer token, or `undefined` when the endpoint is unauthenticated. */
  resolveApiKey(): Promise<string | undefined>;
  /** The attachment service, when one is mounted (needed to send images). */
  resolveAttachments(): AttachmentStore | undefined;
}

/** One Lemonade model entry as read from `GET /v1/models`. */
export interface LemonadeModelEntry {
  id: string;
  maxContextWindow?: number;
  labels?: string[];
  vision?: boolean;
}

/**
 * Deployment labels that route a model to a non-chat endpoint; such models are
 * excluded from the chat model listing. Characteristic labels (vision,
 * reasoning, tool-calling, …) and chat-capable modality labels are kept.
 */
const NON_CHAT_LABELS = new Set(['transcription', 'embeddings', 'reranking', 'image', 'edit', 'tts']);

/** Map an HTTP status to a stable LlmError code. */
function httpErrorCode(
  status: number,
  error: { code?: unknown; type?: unknown; message?: unknown } | undefined,
): string {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000;
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers: Headers): ProviderRequestId | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-lemonade-request-id');
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

/**
 * Read one Lemonade model listing, filtering out models that are not chat
 * completions targets (non-downloaded entries, and entries whose deployment
 * labels route them to another endpoint).
 */
export async function fetchModelEntries(
  baseURL: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<LemonadeModelEntry[]> {
  const url = `${baseURL}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...attributionHeaders() };
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal });
  } catch (error) {
    if (signal?.aborted) throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error });
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error });
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    );
  }
  let body: { data?: unknown } | undefined;
  try {
    body = await response.json() as { data?: unknown };
  } catch (error) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error });
  }
  const data = body?.data;
  if (!Array.isArray(data)) {
    throw new LlmError(`${url} has no "data" array; enter this server's models by hand`, 'DISCOVERY_FAILED');
  }
  const entries: LemonadeModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? (record['id'] as string) : '';
    if (id.length === 0 || seen.has(id)) continue;
    // Skip alias entries (Lemonade Server exposes model aliases alongside real
    // models; an alias has a "model" field pointing to its target).
    if (typeof record['model'] === 'string' && record['model'].length > 0) continue;
    if (record['downloaded'] === false) continue;
    const labels = Array.isArray(record['labels'])
      ? (record['labels'] as unknown[]).filter((label): label is string => typeof label === 'string')
      : [];
    if (labels.some((label) => NON_CHAT_LABELS.has(label))) continue;
    seen.add(id);
    const maxContextWindow =
      typeof record['max_context_window'] === 'number' && (record['max_context_window'] as number) > 0
        ? (record['max_context_window'] as number)
        : undefined;
    entries.push({
      id,
      ...(maxContextWindow !== undefined ? { maxContextWindow } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(labels.includes('vision') ? { vision: true } : {}),
    });
  }
  return entries;
}

/**
 * Interrogate one Lemonade endpoint for the models it advertises, mapped to
 * the harness discovery vocabulary (id + optional context window).
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  const entries = await fetchModelEntries(baseURL, apiKey, signal);
  return entries.map((entry) => ({
    id: entry.id,
    ...(entry.maxContextWindow !== undefined ? { contextWindow: entry.maxContextWindow } : {}),
  }));
}

/** Build display metadata for one model. */
function modelInfo(
  provider: string,
  id: string,
  live: LemonadeModelEntry | undefined,
  configured?: LemonadeCatalogModel,
): LlmModelInfo {
  return {
    provider,
    id,
    name: configured?.name ?? id,
    ...(configured?.description !== undefined ? { description: configured.description } : {}),
    inputModalities: live?.vision === true || configured?.vision === true ? ['text', 'image'] : ['text'],
  };
}

/**
 * The Lemonade adapter. One instance serves every model name it is registered
 * under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both the initial fetch and the body reads. Caller
 * aborts map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class LemonadeAdapter extends LlmAdapter {
  private readonly config: LemonadeAdapterConfig;

  /** The most recent successful live listing, keyed by model id (advisory cache, never authoritative). */
  private lastKnown = new Map<string, LemonadeModelEntry>();

  constructor(config: LemonadeAdapterConfig) {
    super();
    this.config = config;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Lemonade' };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const options = this.config.options();
    // The configured catalog IS the selection: when models are pinned in the
    // plugin configuration, the model selector offers ONLY those.
    if (options.models.length > 0) {
      return options.models.map((model) => modelInfo(provider, model.id, undefined, model));
    }
    // No configured selection: advertise whatever the server currently offers.
    try {
      const apiKey = await this.config.resolveApiKey();
      const entries = await fetchModelEntries(options.baseURL, apiKey, AbortSignal.timeout(LISTING_TIMEOUT_MS));
      this.lastKnown = new Map(entries.map((entry) => [entry.id, entry]));
      return entries.map((entry) => modelInfo(provider, entry.id, entry));
    } catch {
      return [];
    }
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const options = this.config.options();
    const configured = options.models.find((entry) => entry.id === model);
    const live = this.lastKnown.get(model);
    const contextWindow = configured?.contextWindow ?? live?.maxContextWindow ?? options.defaultContextWindow;
    return {
      ...modelInfo(provider, model, live, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? options.maxTokens,
    };
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const connection = this.config.options();
    const apiKey = await this.config.resolveApiKey();
    const consumer = new AbortController();
    const watchdog = idleWatchdog(
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
      connection.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    );
    const iterator = this.request(options, watchdog.signal, connection, apiKey, () => watchdog.pulse())[Symbol.asyncIterator]();
    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Lemonade stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError('Lemonade request aborted by caller', 'ABORTED', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Lemonade API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
    } finally {
      consumer.abort('Lemonade stream consumer stopped');
      watchdog[Symbol.dispose]();
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return(undefined);
        } catch {
          // transport teardown — the streaming error (if any) already surfaced above
        }
      }
    }
  }

  /** Build the image resolver from the mounted attachment service, if any. */
  private async resolveImage(signal?: AbortSignal): Promise<ResolveImage | undefined> {
    const attachments = this.config.resolveAttachments();
    if (attachments === undefined) return undefined;
    return async (ref) => {
      const stored = await attachments.readImage(ref, signal);
      const base64 = Buffer.from(stored.data).toString('base64');
      return `data:${stored.ref.mediaType};base64,${base64}`;
    };
  }

  private async *request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: LemonadeOptions,
    apiKey: string | undefined,
    onComment: () => void,
  ): AsyncGenerator<StreamChunk> {
    const resolveImage = await this.resolveImage(signal);
    const body = await serializeRequest(options, resolveImage);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
    };
    const url = `${connection.baseURL}/v1/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`Lemonade API request to ${url} failed`, 'TRANSPORT', { cause: error });
    }
    if (!response.ok) {
      let message = `Lemonade API error (HTTP ${response.status})`;
      let providerError: { message?: unknown; type?: unknown; code?: unknown } | undefined;
      try {
        const parsed = await response.json() as { error?: unknown };
        if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
          providerError = parsed.error as { message?: unknown; type?: unknown; code?: unknown };
          if (typeof providerError.message === 'string' && providerError.message.length > 0) {
            message = providerError.message;
          }
        }
      } catch {
        // no parseable error body — keep the generic message
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay !== undefined ? { providerRetryAfterMs: delay } : {}),
        ...(id !== undefined ? { requestId: id } : {}),
      });
    }
    if (!response.body) throw new LlmError('Lemonade API returned no response body', 'EMPTY_RESPONSE');
    yield* translate(parseSse(response.body, onComment));
  }
}
