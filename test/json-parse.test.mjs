/**
 * Tests for the depth-bounded JSON parser (json-parse.js), which rejects a
 * "JSON bomb" (a deeply nested tree) before it can blow the stack:
 *   - valid JSON values parse (object, array, nested, string with escapes,
 *     number, boolean, null),
 *   - input deeper than `maxDepth` is rejected with a JsonParseError carrying
 *     the position and `isDepthOverflow: true`,
 *   - a malformed value is rejected with `isDepthOverflow: false`.
 *
 * Runs on the compiled lib/ (pnpm build then pnpm test).
 */
import assert from 'node:assert/strict';
import { parseJsonValue, JsonParseError } from '../lib/json-parse.js';

let passed = 0;
const ok = (c, label) => { assert.ok(c, label); passed += 1; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); passed += 1; };

const MAX_DEPTH = 64;

try {
  // Valid JSON round-trips through the custom parser.
  const parsed = parseJsonValue('{"a":[1,2,{"b":"\\u00e9"}],"c":null,"d":true,"e":false,"f":-3.5e2}', { maxDepth: MAX_DEPTH });
  eq(parsed, { a: [1, 2, { b: 'é' }], c: null, d: true, e: false, f: -350 }, 'valid JSON parses');

  // Empty object and array.
  eq(parseJsonValue('{}', { maxDepth: MAX_DEPTH }), {}, 'empty object');
  eq(parseJsonValue('[]', { maxDepth: MAX_DEPTH }), [], 'empty array');

  // A deeply nested structure above maxDepth throws a JSON-bomb JsonParseError.
  let bombErr = null;
  try {
    parseJsonValue('['.repeat(200) + '1' + ']'.repeat(200), { maxDepth: MAX_DEPTH });
  } catch (error) {
    bombErr = error;
  }
  ok(bombErr instanceof JsonParseError, 'deep input throws JsonParseError');
  ok(bombErr !== null && bombErr.isDepthOverflow === true, 'deep input sets isDepthOverflow');
  ok(bombErr !== null && typeof bombErr.position === 'number', 'deep input carries position');

  // A malformed (but not deeply nested) value is a parse error, not a bomb.
  let malformedErr = null;
  try {
    parseJsonValue('{', { maxDepth: MAX_DEPTH });
  } catch (error) {
    malformedErr = error;
  }
  ok(malformedErr instanceof JsonParseError, 'malformed throws JsonParseError');
  ok(malformedErr !== null && malformedErr.isDepthOverflow === false, 'malformed sets isDepthOverflow false');
  ok(malformedErr !== null && malformedErr.position === 1, 'malformed position points at the offender');

  console.log('\n✓ ' + passed + ' assertions OK (json-parse)');
} catch (error) {
  console.error(error);
  process.exit(1);
}
