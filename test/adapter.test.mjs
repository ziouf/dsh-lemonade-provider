/**
 * Suite de tests du protocole LemonadeAdapter : serveur HTTP simulé (mock)
 * qui émule l'API OpenAI de Lemonade, puis assertions sur les chunks émis,
 * la gestion d'erreurs, la découverte de modèles et la sérialisation vision.
 *
 * S'exécute sur le build compilé (lib/) : pnpm build puis pnpm test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { LemonadeAdapter, fetchModelEntries, discoverModels, DEFAULT_BASE_URL } = await import('../lib/adapter.js');
const { resolveAdapterOptions, Config, name, inject, PROVIDER } = await import('../lib/index.js');

const sysMsg = (text) => ({ id: 's1', role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } });
const userMsg = (text) => ({ id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

const sseId = (i) => 'chatcmpl-' + i;

let lastRequestBody = null;

function makeServer() {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [
          { id: 'Qwen3-0.6B-GGUF', object: 'model', owned_by: 'lemonade', recipe: 'llamacpp', max_context_window: 40960, downloaded: true, labels: ['reasoning'] },
          { id: 'Gemma-3-4b-it-GGUF', object: 'model', owned_by: 'lemonade', max_context_window: 32768, downloaded: true, labels: ['vision'] },
          { id: 'SD-Turbo', object: 'model', owned_by: 'lemonade', recipe: 'sd-cpp', downloaded: true, labels: ['image'] },
          { id: 'NotDownloaded-1B', object: 'model', owned_by: 'lemonade', downloaded: false },
          { id: 'BGE-Embedding', object: 'model', owned_by: 'lemonade', downloaded: true, labels: ['embeddings'] },
        ] }));
        return;
      }
      if (url.pathname === '/v1/chat/completions') {
        let body;
        try { body = JSON.parse(raw); } catch { body = {}; }
        lastRequestBody = body;
        const model = body.model ?? '';
        if (model === 'boom') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2', 'x-request-id': 'req_boom' });
          res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const emit = (obj) => { res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
        if (model === 'empty') {
          emit({ id: sseId(0), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (model === 'nodone') {
          emit({ id: sseId(0), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'hello' } }] });
          res.end();
          return;
        }
        emit({ id: sseId(0), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: 'think' } }] });
        emit({ id: sseId(1), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'Paris' } }] });
        emit({ id: sseId(2), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: ' has ~2.2M people' } }] });
        emit({ id: sseId(3), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] } }] });
        emit({ id: sseId(4), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] });
        emit({ id: sseId(5), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        emit({ id: sseId(6), object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
}

const server = makeServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseURL = 'http://127.0.0.1:' + port; // root — /v1 is appended by the adapter

function makeAdapter(overrides = {}) {
  return new LemonadeAdapter({
    options: () => ({
      apiKeyEnv: 'LEMONADE_API_KEY',
      baseURL,
      requireAuth: false,
      defaultContextWindow: 32768,
      maxTokens: 8192,
      models: [],
      streamIdleTimeoutMs: 5000,
      retryPolicy: undefined,
      ...overrides.options,
    }),
    resolveApiKey: overrides.resolveApiKey ?? (async () => undefined),
    resolveAttachments: overrides.resolveAttachments ?? (() => undefined),
  });
}

async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: 'lemonade', model: 'Qwen3-0.6B-GGUF', ...options })) {
    chunks.push(chunk);
  }
  return chunks;
}

let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed += 1; };
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); passed += 1; };
const seq = async (label, fn) => { await fn(); console.log('  ✓', label); };

try {
  await seq('stream normal (reasoning + text + tool-call + usage)', async () => {
    const adapter = makeAdapter();
    const chunks = await collect(adapter, {
      messages: [sysMsg('be helpful'), userMsg('weather in Paris?')],
      tools: [{ name: 'get_weather', description: 'current weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      maxTokens: 123,
      temperature: 0.7,
    });
    const kinds = chunks.map((c) => c.type);
    eq(kinds, ['block-start', 'reasoning-delta', 'block-start', 'text-delta', 'text-delta', 'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'block-end', 'block-end', 'usage', 'finish'], 'séquence de chunks');
    eq(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' }, 'block-start reasoning');
    eq(chunks[1], { type: 'reasoning-delta', index: 0, text: 'think' }, 'reasoning-delta');
    eq(chunks[3], { type: 'text-delta', index: 1, text: 'Paris' }, 'text-delta 1');
    eq(chunks[4], { type: 'text-delta', index: 1, text: ' has ~2.2M people' }, 'text-delta 2');
    ok(chunks[6].type === 'tool-call-delta' && chunks[6].id === 'call_0' && chunks[6].name === 'get_weather' && chunks[6].argumentsDelta === '{"city":', 'tool-call-delta premier morceau');
    ok(chunks[7].type === 'tool-call-delta' && chunks[7].argumentsDelta === '"Paris"}', 'tool-call-delta second morceau');
    ok(chunks[8].type === 'block-end' && chunks[8].block.type === 'reasoning' && chunks[8].block.text === 'think', 'block-end reasoning');
    ok(chunks[9].type === 'block-end' && chunks[9].block.type === 'text' && chunks[9].block.text === 'Paris has ~2.2M people', 'block-end text');
    ok(chunks[10].type === 'block-end' && chunks[10].block.type === 'tool-call' && chunks[10].block.name === 'get_weather' && chunks[10].block.arguments === '{"city":"Paris"}', 'block-end tool-call');
    eq(chunks[11], { type: 'usage', usage: { inputTokens: 80, outputTokens: 50, cacheReadTokens: 20 } }, 'usage disjoint (cached retiré)');
    eq(chunks[12].type, 'finish', 'finish terminal');
    eq(chunks[12].reason, { kind: 'tool-calls' }, 'finish reason tool-calls');
    const req = lastRequestBody;
    eq(req.model, 'Qwen3-0.6B-GGUF', 'model envoyé');
    eq(req.stream, true, 'stream: true');
    eq(req.stream_options, { include_usage: true }, 'stream_options.include_usage');
    eq(req.max_tokens, 123, 'max_tokens');
    eq(req.temperature, 0.7, 'temperature');
    ok(Array.isArray(req.tools) && req.tools[0].type === 'function' && req.tools[0].function.name === 'get_weather', 'tools au format OpenAI');
    eq(req.messages[0], { role: 'system', content: 'be helpful' }, 'message système en tête');
    eq(req.messages[1], { role: 'user', content: 'weather in Paris?' }, 'message user');
  });

  await seq('réponse vide -> finish error EMPTY_RESPONSE', async () => {
    const adapter = makeAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({ provider: 'lemonade', model: 'empty', messages: [userMsg('bonjour')] })) chunks.push(chunk);
    eq(chunks.length, 1, 'un seul chunk');
    eq(chunks[0].type, 'finish', 'finish');
    eq(chunks[0].reason.kind, 'error', 'finish erreur');
    eq(chunks[0].reason.failure.code, 'EMPTY_RESPONSE', 'code EMPTY_RESPONSE');
  });

  await seq('EOF propre sans [DONE] -> succès', async () => {
    const adapter = makeAdapter();
    const chunks = await collect(adapter, { model: 'nodone', messages: [userMsg('salut')] });
    ok(chunks.length >= 2, 'au moins text + finish');
    const text = chunks.find((c) => c.type === 'text-delta');
    eq(text.text, 'hello', 'contenu texte');
    const finish = chunks[chunks.length - 1];
    eq(finish.type, 'finish', 'dernier chunk finish');
    eq(finish.reason, { kind: 'stop' }, 'stop');
  });

  await seq('erreur HTTP 429 -> RATE_LIMIT + retry-after + request id', async () => {
    const adapter = makeAdapter();
    let thrown;
    try {
      await collect(adapter, { model: 'boom', messages: [userMsg('x')] });
    } catch (error) { thrown = error; }
    ok(thrown !== undefined, 'le stream jette une erreur');
    eq(thrown.code, 'RATE_LIMIT', 'code RATE_LIMIT');
    eq(thrown.failure.status, 429, 'status 429');
    eq(thrown.failure.providerRetryAfterMs, 2000, 'providerRetryAfterMs depuis retry-after');
    eq(thrown.failure.requestId, 'req_boom', 'request id');
  });

  await seq('image sans service d\'attachements -> UNSUPPORTED_CONTENT', async () => {
    const adapter = makeAdapter();
    const imgMsg = { id: 'u2', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 } }], source: { kind: 'user' } };
    let thrown;
    try { await collect(adapter, { messages: [imgMsg] }); } catch (error) { thrown = error; }
    ok(thrown !== undefined, 'jette');
    eq(thrown.code, 'UNSUPPORTED_CONTENT', 'code UNSUPPORTED_CONTENT');
  });

  await seq('image avec attachements -> image_url data URL', async () => {
    const fakeAttachments = {
      readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    };
    const adapter = makeAdapter({ resolveAttachments: () => fakeAttachments });
    await collect(adapter, {
      messages: [{ id: 'u3', role: 'user', content: [
        { type: 'text', text: 'quest-ce que cest ?' },
        { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png', bytes: 4, width: 2, height: 2 } },
      ], source: { kind: 'user' } }],
    });
    const req = lastRequestBody;
    eq(req.messages[0].role, 'user', 'user');
    const hasText = req.messages[0].content[0].type === 'text' && req.messages[0].content[0].text === 'quest-ce que cest ?';
    const hasImage = req.messages[0].content[1].type === 'image_url' && req.messages[0].content[1].image_url.url === 'data:image/png;base64,AQIDBA==';
    ok(hasText && hasImage, 'contenu mixte text + image_url data URL');
  });

  await seq('assistant tool_calls + message tool', async () => {
    const adapter = makeAdapter();
    await collect(adapter, {
      messages: [
        { id: 'm1', role: 'assistant', content: [
          { type: 'text', text: '' },
          { type: 'tool-call', id: 'call_9', name: 'get_weather', arguments: '{"city":"Lyon"}' },
        ], source: { kind: 'model', provider: 'lemonade', model: 'Qwen3-0.6B-GGUF' } },
        { id: 'm2', role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_9', content: [{ type: 'text', text: 'pluie' }] },
        ], source: { kind: 'tool', callId: 'call_9' } },
        userMsg('continuer'),
      ],
    });
    const req = lastRequestBody;
    const assistant = req.messages[0];
    eq(assistant.role, 'assistant', 'assistant');
    ok(assistant.tool_calls && assistant.tool_calls[0].id === 'call_9' && assistant.tool_calls[0].function.name === 'get_weather', 'tool_calls assistant');
    eq(assistant.content, null, 'content null quand que des tool calls');
    const toolMsg = req.messages[1];
    eq(toolMsg.role, 'tool', 'role tool');
    eq(toolMsg.tool_call_id, 'call_9', 'tool_call_id');
    eq(toolMsg.content, 'pluie', 'contenu tool result');
  });

  await seq('listModels (configuré → sélection seule)', async () => {
    const adapter = makeAdapter({ options: { models: [{ id: 'user.MyModel', name: 'My Model' }, { id: 'autre' }] } });
    const list = await adapter.listModels('lemonade');
    eq(list.map((m) => m.id), ['user.MyModel', 'autre'], 'seulement les modèles configurés');
  });
  await seq('listModels (non configuré → liste serveur live)', async () => {
    const adapter = makeAdapter();
    const list = await adapter.listModels('lemonade');
    ok(list.length >= 2 && list.some((m) => m.id === 'Qwen3-0.6B-GGUF'), 'liste serveur si aucune sélection');
  });

  await seq('découverte /v1/models (filtrage endpoint + downloaded)', async () => {
    const entries = await fetchModelEntries(baseURL, undefined);
    const ids = entries.map((e) => e.id);
    eq(ids, ['Qwen3-0.6B-GGUF', 'Gemma-3-4b-it-GGUF'], 'modèles chat uniquement, dans l\'ordre');
    const qwen = entries.find((e) => e.id === 'Qwen3-0.6B-GGUF');
    eq(qwen.maxContextWindow, 40960, 'max_context_window repris');
    ok(!qwen.vision && entries.find((e) => e.id === 'Gemma-3-4b-it-GGUF').vision === true, 'label vision');
    const discovered = await discoverModels(baseURL, undefined);
    eq(discovered[0], { id: 'Qwen3-0.6B-GGUF', contextWindow: 40960 }, 'LlmDiscoveredModel');
  });

  await seq('resolveAdapterOptions + exports du plugin', async () => {
    const opts = resolveAdapterOptions({ baseURL: 'http://localhost:13305' });
    eq(opts.baseURL, 'http://localhost:13305/api', 'prefix /api ajouté automatiquement');
    const withV1 = resolveAdapterOptions({ baseURL: 'http://localhost:13305/v1' });
    eq(withV1.baseURL, 'http://localhost:13305/api', '/v1 normalisé vers /api');
    const withApiV1 = resolveAdapterOptions({ baseURL: 'https://lemonade.cmarin.fr/api/v1' });
    eq(withApiV1.baseURL, 'https://lemonade.cmarin.fr/api', 'trailing /v1 retiré');
    const withApi = resolveAdapterOptions({ baseURL: 'http://localhost:13305/api' });
    eq(withApi.baseURL, 'http://localhost:13305/api', '/api préservé');
    eq(opts.defaultContextWindow, 32768, 'context default');
    eq(opts.maxTokens, 8192, 'maxTokens default');
    eq(String(opts.apiKeyEnv), 'LEMONADE_API_KEY', 'référence de clé par défaut');
    eq(opts.requireAuth, false, 'requireAuth par défaut');
    const trimmed = resolveAdapterOptions({ baseURL: ' http://localhost:13305/v1/ ' });
    eq(trimmed.baseURL, 'http://localhost:13305/api', 'baseURL normalisé (bouts + prefix /api)');
    const cat = resolveAdapterOptions({ models: [{ id: 'X-1B', contextWindow: 16384 }] });
    eq(cat.models, [{ id: 'X-1B', contextWindow: 16384 }], 'catalogue détaché');
    assert.throws(() => resolveAdapterOptions({ models: [{ id: 'X-1B' }, { id: 'X-1B' }] }), /duplicate/);
    assert.throws(() => resolveAdapterOptions({ defaultContextWindow: 0 }), /positive integer/);
    eq(name, 'llm-lemonade', 'name du plugin');
    eq(inject, ['llm'], 'inject');
    eq(PROVIDER, 'lemonade', 'route provider');
    ok(Config !== undefined, 'schema Config exporté');
    ok(DEFAULT_BASE_URL === 'http://localhost:13305', 'default base url root');
  });

  console.log('\n' + '\u2713 ' + passed + ' assertions OK');
} finally {
  server.close();
}
