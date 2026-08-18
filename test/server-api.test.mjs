/**
 * Host proxy tests for the Lemonade-specific API: mock Lemonade HTTP server +
 * serveLemonadeApi (compiled from src/server-api.ts). Run after pnpm build.
 * Covers per-endpoint key selection (regular vs LEMONADE_ADMIN_API_KEY).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { serveLemonadeApi, mapLemonadeStatus } = await import('../lib/server-api.js');

const requests = [];
function makeServer() {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      requests.push({ method: req.method, url: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status, value, contentType) => {
        res.writeHead(status, { 'content-type': contentType ?? 'application/json' });
        res.end(typeof value === 'string' && contentType !== 'application/json' ? value : JSON.stringify(value));
      };
      const p = url.pathname;
      if (p === '/v1/health') return send(200, { status: 'ok', version: '9.3.3', model_loaded: null, all_models_loaded: [] });
      if (p === '/v1/models') return send(200, { object: 'list', data: [{ id: 'Qwen3-0.6B-GGUF', recipe: 'llamacpp', size: 0.38, downloaded: true }] });
      if (p === '/v1/load') return send(200, { status: 'ok', model_name: body && body.model_name });
      if (p === '/v1/unload') return send(200, { status: 'ok' });
      if (p === '/v1/delete') return send(200, body && body.model_name === 'ERR' ? { status: 'error', message: 'not found: ERR' } : { status: 'ok' });
      if (p === '/v1/models/X/files') return send(200, { model_id: 'X', files: [{ name: 'model.gguf', role: 'main', size_bytes: 123, exists: true }] });
      if (p === '/v1/downloads') return send(200, []);
      if (p === '/internal/aliases' && req.method === 'GET') return send(200, { aliases: [{ alias: 'a1', target: 'user.custom', downloaded: true }, { alias: 'a2', target: 'm2' }] });
      if (p === '/internal/aliases' && req.method === 'POST') return send(200, { status: 'ok', alias: body && body.alias, target: body && body.target });
      if (p === '/internal/aliases/a1' && req.method === 'DELETE') return send(200, { status: 'deleted', alias: 'a1' });
      if (p === '/internal/telemetry/flush') return send(200, { status: 'flushed' });
      if (p === '/metrics') return send(200, '# lemonade_server_up 1', 'text/plain; version=0.0.4');
      if (p === '/live') return send(200, { status: 'ok' });
      if (p === '/v1/stats') return send(200, {});
      if (p === '/v1/system-stats') return send(200, {});
      if (p === '/v1/system-info') return send(200, {});
      if (p === '/v1/registry/search') return send(200, { result: [] });
      if (p === '/v1/pull/variants') return send(200, {});
      if (p === '/v1/pull') return send(200, {});
      if (p === '/v1/models/check-updates') return send(200, {});
      if (p === '/v1/cloud/auth') return send(200, {});
      if (p.startsWith('/v1/cloud/auth/')) return send(200, {});
      if (p === '/v1/boom401') return send(401, { error: { message: 'unauthorized', type: 'auth' } });
      send(404, { error: { message: 'not found' } });
    });
  });
}
const server = makeServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseURL = 'http://127.0.0.1:' + port;
const REG = 'LEMONADE_API_KEY';
const ADMIN = 'LEMONADE_ADMIN_API_KEY';

function cfg(overrides = {}) {
  const keys = overrides.keys ?? { [REG]: 'reg-key', [ADMIN]: 'admin-key' };
  return {
    baseURL: () => overrides.baseURL ?? baseURL,
    requireAuth: () => overrides.requireAuth ?? false,
    apiKeyRef: () => REG,
    adminApiKeyRef: () => ADMIN,
    resolveKey: async (ref) => keys[String(ref)] || undefined,
  };
}

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed += 1; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); passed += 1; };
const seq = async (label, fn) => { await fn(); console.log('  ✓', label); };
const call = (cfgObj, method, op, args = [], query = {}, body) =>
  serveLemonadeApi(cfgObj, method, op, args, new URLSearchParams(query), body);

try {
  await seq('regular endpoint uses the regular API key', async () => {
    requests.length = 0;
    const r = await call(cfg(), 'GET', 'health');
    eq(r.ok, true, 'ok');
    eq(requests[0].auth, 'Bearer reg-key', 'regular key used');
  });

  await seq('admin endpoint uses the admin API key', async () => {
    requests.length = 0;
    const r = await call(cfg(), 'GET', 'internalAliases');
    eq(r.ok, true, 'aliases ok');
    eq(requests[0].url, '/internal/aliases', 'path');
    eq(requests[0].auth, 'Bearer admin-key', 'admin key used for /internal');
    const flush = await call(cfg(), 'POST', 'internalTelemetryFlush');
    eq(flush.ok, true, 'flush ok');
    eq(requests[requests.length - 1].url, '/internal/telemetry/flush', 'flush path');
    eq(requests[requests.length - 1].auth, 'Bearer admin-key', 'admin key for flush');
  });

  await seq('internalAliasesSet + delete (admin key)', async () => {
    requests.length = 0;
    const s = await call(cfg(), 'POST', 'internalAliasesSet', [], {}, { alias: 'a1', target: 'user.custom' });
    eq(s.ok, true, 'set ok');
    eq(requests[0].auth, 'Bearer admin-key', 'admin key on set');
    requests.length = 0;
    const d = await call(cfg(), 'DELETE', 'internalAliasesDelete', ['a1']);
    eq(d.ok, true, 'delete ok');
    eq(requests[0].url, '/internal/aliases/a1', 'delete path');
    eq(requests[0].auth, 'Bearer admin-key', 'admin key on delete');
    const d2 = await call(cfg(), 'DELETE', 'internalAliasesDelete', []);
    ok(!d2.ok && d2.error.status === 400, '400 without alias');
  });

  await seq('metrics returns raw text with admin key', async () => {
    requests.length = 0;
    const r = await call(cfg(), 'GET', 'metrics');
    eq(r.ok, true, 'ok');
    eq(r.ok ? r.value : null, '# lemonade_server_up 1', 'raw text value');
    eq(requests[0].auth, 'Bearer admin-key', 'admin key on metrics');
  });

  await seq('admin op falls back to the regular key when admin unset', async () => {
    const c = cfg({ keys: { [REG]: 'reg-key' } });
    requests.length = 0;
    const r = await call(c, 'GET', 'metrics');
    eq(requests[0].auth, 'Bearer reg-key', 'regular key fallback for metrics');
  });

  await seq('regular op falls back to the admin key when regular unset (superior credential)', async () => {
    const c = cfg({ keys: { [ADMIN]: 'admin-key' } });
    requests.length = 0;
    const r = await call(c, 'GET', 'health');
    eq(requests[0].auth, 'Bearer admin-key', 'admin key used for regular when regular unset');
  });

  await seq('requireAuth + no keys → MISSING_CREDENTIAL on regular, not gated on admin', async () => {
    const c = cfg({ requireAuth: true, keys: {} });
    requests.length = 0;
    const r = await call(c, 'GET', 'health');
    ok(!r.ok && r.error.code === 'MISSING_CREDENTIAL', 'regular gated');
    eq(requests.length, 0, 'no network call');
    const adminR = await call(c, 'GET', 'internalAliases');
    eq(adminR.ok, true, 'admin op not gated (server decides)');
    eq(requests[0].auth, undefined, 'unauthenticated admin op');
  });

  await seq('regular operations composite (load/models/downloads)', async () => {
    requests.length = 0;
    const okL = await call(cfg(), 'POST', 'load', [], {}, { model: 'Qwen3-0.6B-GGUF' });
    eq(okL.ok, true, 'load ok');
    eq(requests[0].body.model_name, 'Qwen3-0.6B-GGUF', 'load body model_name (spec)');
    eq(requests[0].body.model, undefined, 'client "model" aliased away');
    eq(requests[0].auth, 'Bearer reg-key', 'load uses regular key');
    const okDownload = await call(cfg(), 'GET', 'downloads');
    eq(okDownload.ok, true, 'downloads ok');
  });

  await seq('unload/delete use model_name; load/delete require a model', async () => {
    requests.length = 0;
    const ul = await call(cfg(), 'POST', 'unload', [], {}, { model: 'X' });
    eq(ul.ok, true, 'unload ok');
    eq(requests[0].body.model_name, 'X', 'unload body model_name');
    eq(requests[0].body.model, undefined, 'unload aliases model to model_name');
    const ulAll = await call(cfg(), 'POST', 'unload', [], {}, {});
    eq(ulAll.ok, true, 'unload without model ok (unloads all — spec)');
    eq(requests[requests.length - 1].body.model_name, undefined, 'unload-all sends empty body');
    requests.length = 0;
    const del = await call(cfg(), 'POST', 'delete', [], {}, { model: 'Y' });
    eq(del.ok, true, 'delete ok');
    eq(requests[0].body.model_name, 'Y', 'delete body model_name');
    const noLoad = await call(cfg(), 'POST', 'load', [], {}, {});
    ok(!noLoad.ok && noLoad.error.status === 400, 'load without model → 400');
    const noDel = await call(cfg(), 'POST', 'delete', [], {}, {});
    ok(!noDel.ok && noDel.error.status === 400, 'delete without model → 400');
  });

  await seq('audit: stats/systemInfo/checkUpdates/modelFiles', async () => {
    const st = await call(cfg(), 'GET', 'stats');
    eq(st.ok, true, 'stats ok');
    const ss = await call(cfg(), 'GET', 'systemStats');
    eq(ss.ok, true, 'systemStats ok');
    const si = await call(cfg(), 'GET', 'systemInfo');
    eq(si.ok, true, 'systemInfo ok');
    const cu = await call(cfg(), 'POST', 'checkUpdates');
    eq(cu.ok, true, 'checkUpdates ok');
    requests.length = 0;
    const mf = await call(cfg(), 'GET', 'modelFiles', ['X']);
    eq(mf.ok, true, 'modelFiles ok');
    eq(requests[0].url, '/v1/models/X/files', 'modelFiles path');
    const mfBad = await call(cfg(), 'GET', 'modelFiles', []);
    ok(!mfBad.ok && mfBad.error.status === 400, 'modelFiles without id → 400');
  });

  await seq('audit: registrySearch + pullVariants + pull (spec fields)', async () => {
    requests.length = 0;
    const rs = await call(cfg(), 'GET', 'registrySearch', [], { query: 'qwen', format: 'gguf' });
    eq(rs.ok, true, 'registrySearch ok');
    eq(requests[0].url.indexOf('query=qwen') >= 0 && requests[0].url.indexOf('format=gguf') >= 0, true, 'search params forwarded');
    requests.length = 0;
    const pv = await call(cfg(), 'GET', 'pullVariants', [], { checkpoint: 'unsloth/Qwen3-8B-GGUF' });
    eq(pv.ok, true, 'pullVariants ok');
    eq(requests[0].url.indexOf('checkpoint=') >= 0, true, 'variants checkpoint forwarded');
    requests.length = 0;
    const p = await call(cfg(), 'POST', 'pull', [], {}, { model_name: 'user.Qwen3-8B-GGUF', recipe: 'llamacpp', checkpoint: 'unsloth/Qwen3-8B-GGUF:Q4_K_M' });
    eq(p.ok, true, 'pull ok');
    eq(requests[0].body.model_name, 'user.Qwen3-8B-GGUF', 'pull model_name');
    eq(requests[0].body.recipe, 'llamacpp', 'pull recipe');
    eq(requests[0].body.checkpoint, 'unsloth/Qwen3-8B-GGUF:Q4_K_M', 'pull checkpoint');
  });

  await seq('audit: HTTP 200 with {status:error} body → wire error', async () => {
    const r = await call(cfg(), 'POST', 'delete', [], {}, { model: 'ERR' });
    eq(r.ok, false, 'not ok');
    ok(!r.ok && r.error.code === 'LEMONADE_ERROR', 'code LEMONADE_ERROR');
    eq(r.ok ? null : r.error.message, 'not found: ERR', 'server message surfaced');
  });

  await seq('root endpoints (internal/live/metrics) skip the /api prefix', async () => {
    const apiCfg = cfg({ baseURL: 'http://127.0.0.1:' + port + '/api' });
    requests.length = 0;
    await call(apiCfg, 'GET', 'health');
    eq(requests[0].url, '/api/v1/health', 'v1 endpoints under /api');
    requests.length = 0;
    const al = await call(apiCfg, 'GET', 'internalAliases');
    eq(al.ok, true, 'aliases ok (root)');
    eq(requests[0].url, '/internal/aliases', 'internal NOT under /api');
    requests.length = 0;
    const live = await call(apiCfg, 'GET', 'live');
    eq(live.ok, true, 'live ok');
    eq(requests[0].url, '/live', 'live at root (no /api)');
    requests.length = 0;
    const met = await call(apiCfg, 'GET', 'metrics');
    eq(met.ok, true, 'metrics ok');
    eq(requests[0].url, '/metrics', 'metrics at root (no /api)');
  });

  await seq('mapping + errors', async () => {
    eq(mapLemonadeStatus(401), 'AUTH', 'AUTH');
    eq(mapLemonadeStatus(429), 'RATE_LIMIT', 'RATE_LIMIT');
    eq(mapLemonadeStatus(409), 'CONFLICT', 'CONFLICT');
    eq(mapLemonadeStatus(500), 'SERVER', 'SERVER');
    const bad = await call(cfg(), 'GET', 'doesNotExist');
    ok(!bad.ok && bad.error.status === 404, '404');
    const meth = await call(cfg(), 'GET', 'unload');
    ok(!meth.ok && meth.error.status === 405, '405 (method mismatch on unload)');
  });

  console.log('\n✓ ' + passed + ' assertions OK (server-api)');
} finally {
  server.close();
}
