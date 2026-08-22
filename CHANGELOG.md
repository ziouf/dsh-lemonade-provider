# Changelog

All notable changes to this project are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and the [Conventional Commits](https://www.conventionalcommits.org/)
naming scheme used for release detection (`feat` → minor, `fix`/`perf` → patch).

## [0.4.0] - 2025-11-09

### Added

- **Batch model operations.** New `batchLoad`, `batchUnload`, and `batchDelete`
  client ops, proxied one HTTP call per selected model through the host. The
  Lemonade tab now offers a select-all checkbox, per-row checkboxes, and
  **Load selected** / **Unload selected** / **Delete selected** buttons; a
  progress line reports `done/total` and a final notice reports how many
  operations failed. The batch delete uses a custom confirmation modal instead
  of the native `confirm()` dialog.
- **Live log streaming.** New `logsStream` route registers a server-to-browser
  SSE feed that relays the Lemonade server's own logs. The browser opens a
  plain SSE connection to the host proxy (which holds the credentials); the
  proxy opens a WebSocket *client* to Lemonade's `/logs/stream` (the log port
  is discovered from `GET /v1/health` → `websocket_port`, which shares the
  Realtime Audio port), subscribes with `{ type: 'logs.subscribe',
  after_seq: null, key? }`, and re-emits every `logs.snapshot` / `logs.entry`
  message as an SSE event. A client→Lemonade relay is mandatory because Node's
  runtime exposes no server-side WebSocket API and the `ws` package is not
  installable. The Lemonade tab exposes this through a **Logs** pane.
- **Model info endpoint.** New `modelInfo` client op proxied by the host to
   `GET {baseURL}/v1/models/{model}/info`, exposing per-model metadata
   (quantization, size, …) in the Lemonade tab.
- **LoRA adapter management.** New `loraList`, `loraLoad`, and `loraUnload`
   client ops proxied to `GET`/`POST`/`DELETE {baseURL}/v1/extensions/lora/*`,
   so adapters can be listed, mounted, and detached from the UI.

### Changed

- **Configurable model-listing timeout.** The live model-listing request now
   honours a new `listingTimeoutMs` setting (default `5000` ms) instead of a
   file-level constant, so operators can tune the discovery query without a code
   change.

### Improved

- **SSE degradation.** Malformed SSE payloads and mid-stream `[DONE]` sentinels
   are now handled gracefully instead of aborting a generation: transiently bad
   payloads are skipped (up to a threshold) and a stray mid-stream `[DONE]` logs
   a soft warning rather than killing the stream.
- **Error reporting.** `apiCall` now distinguishes a network failure, a raw HTTP
   error, and the host's own wire error, and surfaces an explicit status; the
   host proxy validates JSON nesting depth (rejects "JSON bombs") and request
   paths before they reach the server.
- **Client UX.** Status notices auto-dismiss after a few seconds; the model-
   and alias-delete actions prompt in a confirmation modal.

### Testing

- Added test suites for the depth-bounded JSON parser (`json-parse`) and the
   SSE-translation layer (`translate`), covering the degradation paths above.
- Extended the server-api audit suite with the `modelInfo` and LoRA endpoints
   and the batch operations.
- Added a `logs-relay` suite covering the WebSocket→SSE log relay.
