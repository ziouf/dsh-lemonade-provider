/**
 * Tests for the graceful-SSE-degradation behavior in translate.ts:
 *
 *   parseSse (the graceful front-end) skips transiently malformed payloads:
 *     - non-JSON data lines are skipped (not fatal),
 *     - non-object JSON payloads (e.g. a bare number) are skipped,
 *     - after MAX_SKIP consecutive skips the stream aborts.
 *
 *   translate (the assembler) owns the mid-stream [DONE] soft-warning:
 *     - a [DONE] followed by another payload warns MID_STREAM_DONE_WARNING and
 *       the stream still completes normally (the sentinel is not fatal),
 *     - a clean terminal [DONE] warns nothing.
 *
 * Runs on the compiled lib/ (pnpm build then pnpm test).
 */
import assert from 'node:assert/strict';
import { translate, parseSse } from '../lib/translate.js';

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed += 1; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); passed += 1; };

const sseId = (i) => 'chatcmpl-' + i;

/** Encode a raw `data:` body into an SSE byte stream (one `data:` line per entry). */
const sseBytes = (bodies) => {
  const encoder = new TextEncoder();
  const chunks = bodies.map((b) => encoder.encode('data: ' + b + '\n\n'));
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
};

/** Collect the translated chunks (no comment/skip callbacks). */
const collectTranslate = async (parts, onSkip) => {
  const out = [];
  for await (const chunk of translate((async function* () { for (const p of parts) yield p; })(), onSkip)) out.push(chunk);
  return out;
};

/** Collect raw data payloads emitted by parseSse. */
const collectParseSse = async (bodies, onSkip) => {
  const out = [];
  for await (const data of parseSse(sseBytes(bodies), undefined, onSkip)) out.push(data);
  return out;
};

/** The terminal finish chunk is the last emitted chunk. */
const lastFinish = (chunks) => chunks.at(-1);

try {
  // ---- parseSse: malformed / non-object payloads are skipped (not fatal) ----

  // A non-JSON line followed by a good payload: the bad line is skipped.
  await (async () => {
    const skips = [];
    const data = await collectParseSse(['not json at all', JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' } }] })], (reason) => skips.push(reason));
    eq(data.length, 1, 'one payload survives after skipping the non-JSON line');
    eq(skips.length, 1, 'the non-JSON line reported once');
  })();

  // A bare-number payload (valid JSON but not an object) is skipped.
  await (async () => {
    const data = await collectParseSse(['42', JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' } }] })]);
    eq(data.length, 1, 'non-object payload skipped');
    eq(JSON.parse(data[0]).choices[0].delta.content, 'ok', 'good payload kept');
  })();

  // After MAX_SKIP (20) consecutive malformed payloads the stream aborts.
  await (async () => {
    const skips = [];
    const bodies = [];
    for (let i = 0; i < 21; i++) bodies.push('nope');
    const data = await collectParseSse(bodies, (reason) => skips.push(reason));
    eq(data.length, 0, 'no payload survives after exhausting tolerance');
    ok(skips.some((s) => s.includes('exhausted tolerance')), 'tolerance-abort reported');
  })();

  // ---- translate: mid-stream [DONE] is a soft warning, not fatal ----

  // A [DONE] followed by another payload warns but the stream still completes.
  await (async () => {
    const skips = [];
    const chunks = await collectTranslate([
      JSON.stringify({ id: sseId(0), object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Paris' } }] }),
      '[DONE]',
      JSON.stringify({ id: sseId(1), object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ' !' } }] }),
    ], (reason) => skips.push(reason));
    ok(skips.includes('lemonade-sse: mid-stream [DONE] detected; the stream may end prematurely'), 'mid-stream [DONE] warns');
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    eq(text, 'Paris !', 'stream continues past a mid-stream [DONE]');
    eq(lastFinish(chunks).reason.kind, 'stop', 'still finishes normally');
  })();

  // A clean terminal [DONE] warns nothing.
  await (async () => {
    const skips = [];
    const chunks = await collectTranslate([
      JSON.stringify({ id: sseId(0), object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'clean' } }] }),
      '[DONE]',
    ], (reason) => skips.push(reason));
    eq(skips.length, 0, 'terminal [DONE] does not warn');
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    eq(text, 'clean', 'content emitted');
  })();

  console.log('\n✓ ' + passed + ' assertions OK (translate)');
} catch (error) {
  console.error(error);
  process.exit(1);
}
