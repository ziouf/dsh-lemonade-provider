/**
 * Translate Lemonade's OpenAI-compatible SSE payloads into the harness
 * `StreamChunk` protocol.
 *
 * One stateful block is kept per content, reasoning, or tool-call index; an
 * empty initial delta does not open a block. Block-ends, usage, and finish are
 * deferred to the terminal emission at the end of the payload stream, so no
 * chunk ever follows `finish`.
 *
 * Lemonade's docs do not guarantee the `[DONE]` sentinel, so a clean EOF
 * (the payload iterator simply ends) is treated as a normal completion, unlike
 * providers that promise the sentinel. `[DONE]`, when present, is consumed
 * and skipped.
 *
 * @module dsh-lemonade-provider/translate
 */
import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { EventSourceParserStream } from 'eventsource-parser/stream';

/** Parse an SSE byte stream into its `data` payloads. */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === '[DONE]') return;
  }
}

/** One in-progress harness block while assembling the terminal emission. */
interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  callId?: string;
  name?: string;
}

/**
 * Map the wire `finish_reason` vocabulary to the harness FinishReason.
 * Unrecognized values (content_filter, …) become a severity-typed error
 * finish with the uppercased value as the code.
 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

/**
 * Map wire usage fields. OpenAI's `prompt_tokens` is a TOTAL that includes
 * cache hits (`prompt_tokens_details.cached_tokens`); the harness TokenUsage
 * convention is DISJOINT counts, so cache reads are subtracted out.
 */
function mapUsage(usage: Record<string, unknown>): TokenUsage {
  const details = usage['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const completionDetails = usage['completion_tokens_details'] as Record<string, unknown> | undefined;
  const cacheRead = typeof details?.['cached_tokens'] === 'number' ? details['cached_tokens'] : undefined;
  const reasoning = typeof completionDetails?.['reasoning_tokens'] === 'number' ? completionDetails['reasoning_tokens'] : undefined;
  return {
    inputTokens: (usage['prompt_tokens'] as number) - (cacheRead ?? 0),
    outputTokens: usage['completion_tokens'] as number,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text };
    case 'reasoning': return { type: 'reasoning', text: block.text };
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    };
  }
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: {
        index?: number;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
    finish_reason?: unknown;
  }[];
  usage?: Record<string, unknown>;
}

/**
 * Consume SSE data payloads (optionally ending with `[DONE]`) and yield
 * harness StreamChunks. Malformed JSON payloads abort the stream with
 * `MALFORMED_RESPONSE`. A `stop` (or absent) finish with no opened blocks is a
 * degenerate provider completion and maps to an `EMPTY_RESPONSE` error finish.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;
  let textBlock: OpenBlock | undefined;
  let reasoningBlock: OpenBlock | undefined;
  const toolBlocks = new Map<number, OpenBlock>();
  const order: OpenBlock[] = [];
  let pendingFinish: FinishReason | undefined;
  let pendingUsage: TokenUsage | undefined;

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' };
    order.push(block);
    return block;
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') continue;
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(payload) as WireChunk;
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }
      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }
      for (const call of delta.tool_calls ?? []) {
        const callIndex = call.index ?? toolBlocks.size;
        let block = toolBlocks.get(callIndex);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(callIndex, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        if (typeof call.id === 'string') block.callId = call.id;
        if (typeof call.function?.name === 'string') block.name = call.function.name;
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
        block.text += fragment;
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  // Terminal emission: nothing follows the finish chunk.
  for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  const reason: FinishReason = pendingFinish ?? { kind: 'stop' };
  yield {
    type: 'finish',
    reason: reason.kind === 'stop' && order.length === 0
      ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
      : reason,
  };
}
