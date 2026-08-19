/**
 * ✨ Lemonade Server LLM provider plugin for the DeepSeek Harness.
 *
 * Registers a `LemonadeAdapter` for the `lemonade` provider route on
 * `ctx.llm`, speaking the OpenAI-compatible Chat Completions API at a local
 * (or remote) Lemonade Server. Connection facts resolve per request instead of
 * at load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-lemonade` user-settings section (`ctx.settings`) and resolves the
 * optional API key through the credential seam (`ctx.credentials`) or the
 * launch environment, so a changed base URL, catalog, or key reaches the next
 * request without a restart, while an in-flight stream keeps the facts it
 * started with. The one registration-captured fact — the retry policy —
 * re-registers the route in place when it changes.
 *
 * @module dsh-lemonade-provider
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  INVALID_CREDENTIAL_CODE,
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  normalizeApiKey,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  LemonadeAdapter,
  discoverModels,
} from './adapter.js';
import type { LemonadeCatalogModel, LemonadeOptions } from './adapter.js';
import { API_ROUTE, createLemonadeApiHandler } from './server-api.js';

/** Short plugin name used in logs and configuration surfaces. */
export const name = 'llm-lemonade';
/** The provider route this plugin registers. */
export const PROVIDER = 'lemonade';
/** Hard service dependency: the LLM registry seat. */
export const inject = ['llm'];
/** Settings namespace this plugin owns. */
export const NS = settingsNamespace('llm-lemonade');

/** Environment variable naming this server's endpoint, honored from trusted layers only. */
export const BASE_URL_ENV = 'LEMONADE_BASE_URL';
/** Default environment variable naming the optional API key. */
export const DEFAULT_API_KEY_ENV = 'LEMONADE_API_KEY';
/** Default environment variable naming the optional admin API key (internal endpoints). */
export const DEFAULT_ADMIN_API_KEY_ENV = 'LEMONADE_ADMIN_API_KEY';

/** The static advisory model catalog schema (user-pinned entries). */
export const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  vision: z.boolean(),
});

/**
 * Resolved plugin configuration schema. All fields except `baseURL` have
 * defaults; `baseURL` itself can come from `LEMONADE_BASE_URL` when unset.
 */
export const Config: z<LemonadeResolvedConfig> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  adminApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_ADMIN_API_KEY_ENV),
  requireAuth: z.boolean().default(false),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/** Resolved plugin configuration (what the schema produces). */
export interface LemonadeResolvedConfig {
  baseURL: string;
  apiKeyEnv: string;
  adminApiKeyEnv: string;
  requireAuth: boolean;
  defaultContextWindow: number;
  maxTokens: number;
  models: LemonadeCatalogModel[];
  streamIdleTimeoutMs: number;
  retryPolicy?: RetryPolicyConfig;
}

/** Raw composition entry: every field optional (schema defaults apply on resolution). */
export type LemonadeRawConfig = Partial<LemonadeResolvedConfig>;

/** Validate and detach the advisory model catalog. */
export function resolveModels(models: readonly LemonadeCatalogModel[] | undefined): LemonadeCatalogModel[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error('llm-lemonade: catalog model ids must be non-empty');
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-lemonade: catalog model "${model.id}" has an empty name`);
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-lemonade: catalog model "${model.id}" contextWindow must be a positive integer`);
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-lemonade: catalog model "${model.id}" maxTokens must be a positive integer`);
    }
    if (seen.has(model.id)) throw new Error(`llm-lemonade: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
    };
  });
}

function normalizeBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('llm-lemonade: baseURL must not be empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`llm-lemonade: baseURL cannot be parsed: "${trimmed}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`llm-lemonade: baseURL must use http or https, got "${trimmed}"`);
  }
  // The path prefix is ALWAYS /api: any configured path (including a
  // root base or a legacy trailing /v1) is normalized to scheme://host/api,
  // and every endpoint builder appends exactly one /v1 on top.
  return url.protocol + '//' + url.host + '/api';
}

/**
 * The explicit step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 *
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, when the product CLI provided them.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(
  config: LemonadeRawConfig,
  environment?: LaunchEnvironmentSnapshot,
): LemonadeOptions {
  if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-lemonade: defaultContextWindow must be a positive integer');
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-lemonade: maxTokens must be a positive safe integer');
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-lemonade: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  const rawBase = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL;
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    adminApiKeyEnv: credentialRef(config.adminApiKeyEnv ?? DEFAULT_ADMIN_API_KEY_ENV),
    baseURL: normalizeBaseURL(rawBase),
    requireAuth: config.requireAuth === true,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-lemonade: retryPolicy'),
  };
}

/**
 * Resolve one credential reference through the credentials seam, falling back
 * to the launch environment. Never returns a blank value; `undefined` when the
 * key is unconfigured. Shared by the adapter bearer-token resolver (which may
 * additionally enforce `requireAuth`) and by the host proxy key resolver.
 */
async function resolveCredential(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  let value: string | undefined;
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) value = (await credentials.resolve(ref))?.value;
  if (value === undefined) value = launchEnvironmentOf(ctx).get(ref)?.value;
  if (value === undefined || value.length === 0) return undefined;
  return assertUsableApiKey(value, 'llm-lemonade', String(ref));
}

/**
 * Resolve the optional bearer token, enforcing `requireAuth` when configured.
 * The credentials-or-env resolution itself is delegated to resolveCredential.
 */
function makeResolveApiKey(ctx: Context, options: () => LemonadeOptions): () => Promise<string | undefined> {
  return async () => {
    const connection = options();
    const ref = connection.apiKeyEnv;
    const value = await resolveCredential(ctx, ref);
    if (value === undefined) {
      if (connection.requireAuth) {
        throw new LlmError(
          `llm-lemonade: no API key for provider route "${PROVIDER}"; store ${String(ref)} through the credentials service (the web Models page writes it), or export ${String(ref)} in the launching environment`,
          'MISSING_CREDENTIAL',
        );
      }
      return undefined;
    }
    return value;
  };
}

/**
 * Register a {@link LemonadeAdapter} for the `lemonade` provider route.
 * See the module header for the layering story.
 */
export function apply(ctx: Context, config: LemonadeRawConfig): void {
  let current = () => config;
  let lastRaw: unknown;
  let lastGood: LemonadeOptions | undefined;
  const options = (): LemonadeOptions => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw as LemonadeRawConfig, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error('llm-lemonade: keeping the last good configuration after an invalid settings section');
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  const resolveApiKey = makeResolveApiKey(ctx, options);
  const adapter = new LemonadeAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  });

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Lemonade', settingsNs: NS, settingsPath: [] },
  ]);

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  ctx.llm.registerModelDiscovery(NS, async (request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> => {
    const baseURL = request.baseURL !== undefined && request.baseURL.length > 0 ? normalizeBaseURL(request.baseURL) : options().baseURL;
    let apiKey: string | undefined;
    if (request.apiKey !== undefined) {
      const checked = normalizeApiKey(request.apiKey);
      if (!checked.ok) {
        throw new LlmError(
          checked.reason === 'empty'
            ? 'this server\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
            : 'this server\'s API key contains characters no HTTP header can carry; paste the raw key only',
          INVALID_CREDENTIAL_CODE,
        );
      }
      apiKey = checked.value;
    } else {
      apiKey = await resolveApiKey();
    }
    return discoverModels(baseURL, apiKey, request.signal);
  });

  // Lemonade-specific API proxy: browser client half calls these routes
  // same-origin; the keys are resolved host-side and never reach the browser.
  // Per-endpoint key selection (regular vs admin) lives in server-api.ts.
  const resolveKey = (ref: CredentialRef): Promise<string | undefined> => resolveCredential(ctx, ref);
  const apiCfg = {
    baseURL: () => options().baseURL,
    requireAuth: () => options().requireAuth,
    apiKeyRef: () => options().apiKeyEnv,
    adminApiKeyRef: () => options().adminApiKeyEnv,
    resolveKey,
  };
  // Register the proxy route once the webServer service is available. It is
  // mounted late (after the llm service this plugin depends on), so a strict
  // ctx.get() at apply time is usually undefined; instead grab it eagerly
  // (non-strict) and fall back to binding the route when 'webServer' is
  // provided. Absent webServer (headless profile), nothing is registered and
  // the host half keeps working as a plain model provider.
  let routesRegistered = false;
  const registerRoutes = (): void => {
    if (routesRegistered) return;
    const server = ctx.get('webServer', false);
    if (server === undefined) return;
    routesRegistered = true;
    ctx.effect(() => server.register({ kind: 'prefix', path: API_ROUTE, handler: createLemonadeApiHandler(apiCfg) }));
  };
  registerRoutes();
  if (!routesRegistered) {
    ctx.on('internal/service', (name: string | symbol) => {
      if (name === 'webServer') registerRoutes();
    });
  }

  installSettingsSection(ctx, NS, Config, config as LemonadeResolvedConfig, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });
}

export { LemonadeAdapter };
export type { LemonadeOptions } from './adapter.js';
