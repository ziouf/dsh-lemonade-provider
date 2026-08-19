# dsh-lemonade-provider

A **dsh** plugin that integrates [Lemonade Server](https://lemonade-server.ai) as
a model provider for DeepSeek Harness.

Lemonade exposes an OpenAI-compatible API (Chat Completions). This plugin wires
this API to the Harness's `ctx.llm` service under the **`lemonade`** provider
route:

- **Chat Completions** streaming (SSE) via `POST {baseURL}/chat/completions`
- **Model discovery** live from `GET {baseURL}/models`
- **Optional API key** (`LEMONADE_API_KEY`) — only needed when
  the server is configured with authentication
- **Vision support**: Harness image blocks are sent as `image_url`
  (data URL) to `vision` models
- **Tool calling** in standard OpenAI format

## Prerequisites

- A running Lemonade Server (default `http://localhost:13305`)
- Node.js ≥ 22
- A dsh installation (profile), e.g. the `web` profile

> The package must be **built beforehand**: `pnpm install && pnpm build`
> ("Development" section below) — dsh loads code from `lib/`.

## Installation in a profile

From the profile directory (e.g. `~/.dsh/profiles/web`):

```sh
pnpm add file:../dsh-lemonade-provider
```

Or, via the dsh command line:

```sh
dsh plugin --profile web add file:../dsh-lemonade-provider
```

Then add an entry to the profile's `cordis.patch.yml` (see
[example/cordis.patch.yml](example/cordis.patch.yml)):

```yaml
- id: llm-lemonade
  name: 'llm-lemonade'
  config:
    baseURL: http://localhost:13305
```

> `baseURL` is the server root (an old `/v1` suffix from legacy configs is also
> supported). If `LEMONADE_BASE_URL` is set, it is used when `baseURL` is omitted.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `baseURL` | string | `http://localhost:13305` (or `LEMONADE_BASE_URL`) | Normalized to `scheme://host/api` — `/api` appended if missing, `/v1/…` appended per endpoint |
| `apiKeyEnv` | string (credential-ref) | `LEMONADE_API_KEY` | Regular API key (for /v1/* endpoints) |
| `adminApiKeyEnv` | string (credential-ref) | `LEMONADE_ADMIN_API_KEY` | Optional admin API key (for internal /internal/* and /metrics endpoints) |
| `requireAuth` | boolean | `false` | Fail when the key is absent (protected remote) |
| `models` | array | `[]` | User-pinned advisory model catalog |
| `defaultContextWindow` | number | `32768` | Context window used when the server doesn't declare one |
| `maxTokens` | number | `8192` | Default output cap |
| `streamIdleTimeoutMs` | number | `300000` | SSE stream idle timeout |
| `retryPolicy` | object | default values | Provider retry policy |

Each entry in `models`: `id` (required), `name`, `description`,
`contextWindow`, `maxTokens`, `vision` (boolean).

## Model Discovery

The Harness Models page can query `GET {baseURL}/models` through the
discovery registered for the `llm-lemonade` settings namespace. Undownloaded
models and those routed to other endpoints (embeddings, image,
TTS, transcription, …) are excluded from the proposed list; the declared
context window (`max_context_window`) is reused when present.

## UI Configuration (Settings → Models)

The dsh Settings/Models page has no third-party exit gate: its editor only
knows the `llm-deepseek` and `llm-pi-ai` namespaces. The plugin therefore wires
its edit card to the `pi-ai` card on the Models page through a targeted patch
of the bundled `dsh-client-ui-settings-models` bundle (`llm-lemonade` route →
`pi-ai` family). After any npm cache reinstallation (`npm exec`), rerun:

```sh
node scripts/patch-models-ui.mjs
node scripts/patch-models-ui-admin.mjs
```

The form (Settings → Models -> Lemonade row) allows entering the API key
(optional, stored via the credentials service under `LEMONADE_API_KEY`),
the **optional admin key** (`LEMONADE_ADMIN_API_KEY` — internal endpoints
`/internal/*` and `/metrics`, via the `patch-models-ui-admin.mjs` patch),
the base URL (falling back to "customized"), and selecting models served by
Lemonade via "Fetch available models" (`llm.discoverModels`).

## Lemonade View (Conversation Tab)

A **Lemonade** tab (next to Chat/Trajectory) exposes the entry points of the
Lemonade-specific API (health/liveness, telemetry, models with
Load/Unload/Delete/Files/Update, controllable downloads, and cloud keys).
The browser calls the dsh server on the same origin (`/dsh-lemonade/api/<op>`);
the host proxy to Lemonade (`src/server-api.ts`) resolves baseURL + key
(these never leave the host). Key selection is **per endpoint**: regular
endpoints (/v1/*, /live) authenticate with `LEMONADE_API_KEY`, and control
endpoints (`/internal/*`, `/metrics`) with `LEMONADE_ADMIN_API_KEY` (falling
back to the regular key). The route is registered via
`ctx.webServer.register({ kind: 'prefix', path: '/dsh-lemonade/api', ... })`
when the `webServer` service is available.

### Client browser bundle

The browser half lives in `src/client/index.js` and is copied verbatim to
`lib/client.js` by the build (`scripts/copy-client.mjs`). The bundle registers
itself with the module loader under the **package name** — `@cmarin/dsh-lemonade`
— because the harness keys plugin client modules by package name in its boot
manifest:

```js
window.__ModuleLoader__.load({ id: "@cmarin/dsh-lemonade", factory: (require) => { /* … */ } })
```

The registration id must match the graph row id exactly; a mismatch makes the
harness fail with *"loaded without registering `<id>` via `__ModuleLoader__.load`"*.
Because `lib/` is gitignored (build output), always rebuild after touching
`src/client/index.js` and reinstall the package in the profile before reloading
the GUI.

## Development

```sh
pnpm install
pnpm build      # compile TypeScript to lib/
pnpm test       # protocol tests (simulated SSE server)
```

### Structure

- `src/index.ts` — plugin: config schema, `apply`, discovery, credentials
- `src/adapter.ts` — `LemonadeAdapter extends LlmAdapter` (fetch + SSE)
- `src/serialize.ts` — Harness messages → OpenAI wire format
- `src/translate.ts` — SSE payloads → `StreamChunk` chunks
- `src/client/index.js` — browser half (Lemonade conversation tab), copied to `lib/client.js`
- `test/adapter.test.mjs` — dependency-free test suite (mock HTTP)

### License

MIT
