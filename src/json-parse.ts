/**
 * Depth-bounded JSON parser for proxied Lemonade request bodies.
 *
 * A hostile client can send a "JSON bomb": a tree whose width is small but
 * whose depth is enormous. A naive `JSON.parse` walks such input with a stack
 * proportional to the depth, which can blow the V8 stack. This parser walks it
 * with an explicit recursion depth cap (`maxDepth`) and rejects deeper input
 * with a {@link JsonParseError} carrying the byte offset of the offending
 * token, so the caller can surface a precise message without the request ever
 * reaching a downstream consumer.
 *
 * Only what the Lemonade proxy needs is supported: objects, arrays, strings
 * (with escapes), numbers, and the `true`/`false`/`null` literals. Whitespace
 * between tokens is skipped. Trailing characters after the value are rejected.
 *
 * @module dsh-lemonade-provider/json-parse
 */

/** Error thrown by {@link parseJsonValue} on malformed input or depth overflow. */
export class JsonParseError extends Error {
  /** Byte offset of the offending token (or where parsing ended). */
  readonly position: number;
  /** True when the cap on nesting depth was exceeded rather than the text being malformed. */
  readonly isDepthOverflow: boolean;

  constructor(message: string, position: number, isDepthOverflow = false) {
    super(message);
    this.name = 'JsonParseError';
    this.position = position;
    this.isDepthOverflow = isDepthOverflow;
  }
}

/** Parse one UTF-8 JSON value from `text`.
 * @param text - the raw request body.
 * @param options - parser options; only `maxDepth` is honoured today.
 * @returns the parsed value (never `undefined`; use `parseJsonValue` for that).
 * @throws {JsonParseError} when the text is not a single valid JSON value or exceeds `maxDepth`.
 */
export function parseJsonValue(text: string, options?: { maxDepth?: number }): unknown {
  const maxDepth = options?.maxDepth ?? 64;
  const len = text.length;
  let pos = 0;

  const skipWhitespace = (): void => {
    while (pos < len) {
      const c = text[pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++;
      else break;
    }
  };

  const fail = (message: string, isDepthOverflow = false): never => {
    throw new JsonParseError(message, pos, isDepthOverflow);
  };

  const parseValue = (depth: number): unknown => {
    skipWhitespace();
    const c = text[pos] ?? '';
    if (pos >= len) fail('unexpected end of input');
    if (c === '{') return parseObject(depth + 1);
    if (c === '[') return parseArray(depth + 1);
    if (c === '"') return parseString();
    if (c === 't' || c === 'f') return parseBooleanLiteral();
    if (c === 'n') return parseNullLiteral();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail('unexpected character "' + c + '"');
  };

  const parseObject = (depth: number): Record<string, unknown> => {
    if (depth > maxDepth) fail('request body exceeds JSON depth ' + maxDepth, true);
    const out: Record<string, unknown> = {};
    pos++; // consume '{'
    skipWhitespace();
    if (text[pos] === '}') { pos++; return out; }
    for (;;) {
      skipWhitespace();
      if (text[pos] !== '"') fail('expected object key string');
      const key = parseString();
      skipWhitespace();
      if (text[pos] !== ':') fail('expected ":" after key');
      pos++;
      out[key] = parseValue(depth);
      skipWhitespace();
      const close = text[pos];
      if (close === ',') { pos++; continue; }
      if (close === '}') { pos++; return out; }
      fail('expected "," or "}" in object');
    }
  };

  const parseArray = (depth: number): unknown[] => {
    if (depth > maxDepth) fail('request body exceeds JSON depth ' + maxDepth, true);
    const out: unknown[] = [];
    pos++; // consume '['
    skipWhitespace();
    if (text[pos] === ']') { pos++; return out; }
    for (;;) {
      out.push(parseValue(depth));
      skipWhitespace();
      const close = text[pos];
      if (close === ',') { pos++; continue; }
      if (close === ']') { pos++; return out; }
      fail('expected "," or "]" in array');
    }
  };

  const parseString = (): string => {
    pos++; // consume opening '"'
    let out = '';
    for (;;) {
      if (pos >= len) fail('unterminated string');
      const c = text[pos++];
      if (c === '"') return out;
      if (c === '\\') {
        if (pos >= len) fail('unterminated escape');
        const e = text[pos++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(pos, pos + 4);
            if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default: fail('invalid escape \\' + e);
        }
      } else {
        out += c;
      }
    }
  };

  const parseBooleanLiteral = (): boolean => {
    if (text.startsWith('true', pos)) { pos += 4; return true; }
    if (text.startsWith('false', pos)) { pos += 5; return false; }
    throw fail('invalid literal');
  };

  const parseNullLiteral = (): null => {
    if (text.startsWith('null', pos)) { pos += 4; return null; }
    throw fail('invalid literal');
  };

  const parseNumber = (): number => {
    const start = pos;
    if (text[pos] === undefined || text[pos] === '-') {
      if (text[pos] === '-') pos++;
    }
    while (pos < len) {
      const c = text[pos];
      if (c === undefined) break;
      if ((c >= '0' && c <= '9') || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') pos++;
      else break;
    }
    const numText = text.slice(start, pos);
    const num = Number(numText);
    if (!Number.isFinite(num)) fail('invalid number "' + numText + '"');
    return num;
  };

  skipWhitespace();
  const value = parseValue(0);
  skipWhitespace();
  if (pos !== len) fail('trailing characters after JSON value');
  return value;
}
