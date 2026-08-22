/**
 * Host proxy tests for the Lemonade logs relay: serveLogsStream (compiled from
 * src/server-api.ts) receives an SSE request and relays a WebSocket client
 * connection to the Lemonade /logs/stream endpoint as Server-Sent-Events.
 *
 * A minimal, dependency-free WebSocket *server* implements the frame handshake
 * so the relay (which connects as a WS client) has a real upstream to talk to.
 * Run after pnpm build.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

const { createLemonadeApiHandler } = await import('../lib/server-api.js');

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed += 1; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); passed += 1; };
const seq = async (label, fn) => { await fn(); console.log('  ✓', label); }

/** Build a WebSocket server that accepts the handshake, sends `frames`, and records client→server text frames. */
function wsServer(frames) {
  const server = createServer((req, res) => res.end());
  const incoming = [];
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // Drain and record client→server frames (the relay's subscribe message).
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        let mask;
        if (buf[1] & 0x80) { mask = buf.slice(off, off + 4); off += 4; }
        if (buf.length < off + len) break;
        let payload = buf.slice(off, off + len);
        if (buf[1] & 0x80) {
          const out = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
          payload = out;
        }
        if ((buf[0] & 0x0f) === 0x1) incoming.push(payload.toString('utf8'));
        buf = buf.slice(off + len);
      }
    });
    // So the relay has time to connect and send its subscribe frame.
    setTimeout(() => {
      for (const frame of frames) {
        const payload = Buffer.from(frame, 'utf8');
        const header = Buffer.allocUnsafe(2 + (payload.length > 125 ? 2 : 0));
        header[0] = 0x80 | 0x1; // FIN + text
        if (payload.length < 126) { header[1] = payload.length; }
        else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
        socket.write(Buffer.concat([header, payload]));
      }
    }, 300);
  });
  server.incoming = incoming;
  return server;
}

// A fake Lemonade server exposing /v1/health (with websocket_port).
const logsFrames = [];
const logsWs = wsServer(logsFrames);
await new Promise((r) => logsWs.listen(0, '127.0.0.1', r));
const logsPort = logsWs.address().port;

const lemonade = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '9.3.3', websocket_port: logsPort }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});
await new Promise((r) => lemonade.listen(0, '127.0.0.1', r));
const lemonadePort = lemonade.address().port;

const handler = createLemonadeApiHandler({
  baseURL: () => 'http://127.0.0.1:' + lemonadePort,
  requireAuth: () => false,
  apiKeyRef: () => 'LEMONADE_API_KEY',
  adminApiKeyRef: () => 'LEMONADE_ADMIN_API_KEY',
  resolveKey: async (ref) => ({ LEMONADE_API_KEY: 'reg-key', LEMONADE_ADMIN_API_KEY: 'admin-key' }[String(ref)] || undefined),
});

const proxy = createServer((req, res) => { void handler(req, res); });
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = proxy.address().port;

/** Open the logsStream SSE and collect the first `bytesToRead` bytes then close. */
function collectSse(bytesToRead) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: '/dsh-lemonade/api/logsStream', method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        res.on('error', () => {}); // destroy() below triggers 'error'; ignore it
        res.on('data', (c) => {
          out += c;
          if (out.length >= bytesToRead) { res.destroy(); finish(out); }
        });
      },
    );
    req.on('error', reject);
    setTimeout(() => { req.destroy(); finish(out); }, 15000);
    req.end();
  });
}

const http = await import('node:http');

try {
  await seq('relays a single logged line as an SSE data event', async () => {
    logsFrames.length = 0;
    logsFrames.push(JSON.stringify({ type: 'logs.entry', seq: 1, entry: { level: 'INFO', msg: 'model loaded' } }));
    const sse = await collectSse(400);
    ok(sse.indexOf('data: {') >= 0, 'SSE stream contains the relayed JSON');
    ok(sse.indexOf('"msg":"model loaded"') >= 0, 'relayed payload content');
    logsFrames.length = 0;
  });

  await seq('does not leak the resolved API key upstream', async () => {
    logsFrames.length = 0;
    logsWs.incoming.length = 0;
    await collectSse(50);
    await new Promise((r) => setTimeout(r, 400));
    const parsed = logsWs.incoming.map((s) => { try { return JSON.parse(s); } catch { return undefined; } }).find((m) => m && m.type === 'logs.subscribe');
    ok(!!parsed, 'subscribe frame was sent upstream');
    eq(parsed && parsed.type, 'logs.subscribe', 'subscribe frame sent');
    eq(parsed && parsed.after_seq, null, 'subscribes from the beginning');
    eq(parsed && parsed.key, 'reg-key', 'authenticates via the resolved regular key');
    logsFrames.length = 0;
  });

  await seq('returns a short JSON wire error for an unknown op', async () => {
    const res = await fetch('http://127.0.0.1:' + proxyPort + '/dsh-lemonade/api/nope');
    eq(res.status, 404, 'unknown op → 404');
    const body = await res.json();
    ok(body.ok === false, 'not ok');
    ok(typeof body.error.message === 'string', 'carries a message');
  });

  console.log('\n✓ ' + passed + ' assertions OK (logs-relay)');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  proxy.close();
  lemonade.close();
  logsWs.close();
}
