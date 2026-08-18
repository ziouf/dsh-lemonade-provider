/**
 * Serialize harness messages into Lemonade's OpenAI-compatible chat
 * completions wire format.
 *
 * User text is joined; user image blocks become OpenAI `image_url` data-URL
 * parts (Lemonade serves vision models through the same endpoint); assistant
 * text becomes `content`, tool calls become `tool_calls`, and tool results
 * become standalone `{role: 'tool'}` messages. Reasoning blocks are not
 * replayed on the wire: Lemonade's OpenAI route has no reasoning passback
 * field (unlike DeepSeek's `reasoning_content`), and re-sending thinking
 * text as plain content would corrupt the conversation.
 *
 * @module dsh-lemonade-provider/serialize
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';

/** One OpenAI function tool call as sent on the wire. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI content parts for user messages that carry images. */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One OpenAI chat-completions wire message. */
export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Resolve one durable image reference into the data: URL sent as an
 * `image_url` part. Provided by the adapter from the attachment service.
 */
export type ResolveImage = (attachment: ImageAttachmentRef, signal?: AbortSignal) => Promise<string>;

/** Join the text blocks of a message (user and tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Serialize a user message's content. Text-only messages stay a plain string;
 * a message carrying one or more image blocks becomes an array of parts that
 * preserves block order.
 */
async function serializeUserContent(
  blocks: readonly ContentBlock[],
  resolveImage: ResolveImage,
  signal: AbortSignal | undefined,
): Promise<string | WireContentPart[]> {
  const parts: WireContentPart[] = [];
  let hasImage = false;
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url: await resolveImage(block.attachment, signal) } });
    }
    // tool-result blocks are expanded into standalone tool messages by the caller.
  }
  if (!hasImage) return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return parts;
}

/** Serialize one assistant message (text + tool calls; reasoning dropped). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content);
  const toolCalls: WireToolCall[] = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }));
  if (toolCalls.length === 0) return { role: 'assistant', content: text };
  // OpenAI canonical form: content is null when the turn is tool calls only.
  return { role: 'assistant', content: text.length > 0 ? text : null, tool_calls: toolCalls };
}

/**
 * Serialize the conversation in order. A mixed user message contributes its
 * text/image content first and each tool result as a standalone wire message
 * after it.
 *
 * @param messages - the harness conversation, in order.
 * @param resolveImage - resolves image blocks; required whenever one is present.
 * @param signal - cancellation forwarded to attachment reads.
 */
async function serializeMessages(
  messages: readonly Message[],
  resolveImage: ResolveImage,
  signal: AbortSignal | undefined,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    );
    const content = await serializeUserContent(message.content, resolveImage, signal);
    const hasText = typeof content === 'string' ? content.length > 0 : true;
    if (hasText || toolResults.length === 0) wire.push({ role: 'user', content });
    for (const result of toolResults) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' });
    }
  }
  return wire;
}

/**
 * Build the full wire request body. Always streaming with usage reporting on
 * (Lemonade's llamacpp backends honor `stream_options.include_usage`; servers
 * that ignore it simply never send a usage chunk, and the translate step
 * tolerates that). Optional sampling fields are omitted rather than sent as
 * null so provider defaults apply.
 *
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param resolveImage - resolves image blocks; `undefined` when no attachment
 *   service is available, in which case image content is refused up front.
 */
export async function serializeRequest(
  options: GenerateOptions,
  resolveImage: ResolveImage | undefined,
): Promise<Record<string, unknown>> {
  if (resolveImage === undefined && options.messages.some((message) => contentHasImage(message.content))) {
    throw new LlmError('The Lemonade adapter requires the attachment service to send image content.', 'UNSUPPORTED_CONTENT');
  }
  const messages: WireMessage[] = [];
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system });
  messages.push(...(await serializeMessages(
    options.messages,
    resolveImage ?? (() => { throw new LlmError('no image resolver', 'UNSUPPORTED_CONTENT'); }),
    options.signal,
  )));
  const tools: { type: 'function'; function: ToolSchema & { description: string } }[] | undefined =
    options.tools?.length
      ? options.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }))
      : undefined;
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}
