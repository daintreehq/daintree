import type { VoiceReasoningEffort } from "../../shared/config/voiceCorrection.js";

export const CLAUDE_ORIGIN = "https://api.anthropic.com/";
export const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_API_VERSION = "2026-10-21";
// Thinking counts toward max_tokens, so a request that may think gets room for
// it on top of the whole passage coming back.
const THINKING_HEADROOM_TOKENS = 4096;

const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

export function claudeHeaders(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VERSION };
}

interface ClaudeTextBlock {
  type: "text";
  text: string;
  cache_control?: typeof CACHE_BREAKPOINT;
}

/**
 * The thinking and effort a cleanup asks for. "none" turns thinking off, as
 * the OpenAI requests do: Haiku takes "disabled", while Sonnet 5.5 refuses it
 * and stops thinking only between tool calls, of which a cleanup makes none.
 */
function thinkingFor(model: string, effort: VoiceReasoningEffort) {
  if (effort !== "none") return { thinking: { type: "adaptive" }, effort };
  const thinking = model.startsWith("claude-sonnet-")
    ? { type: "between_tools" }
    : { type: "disabled" };
  return { thinking, effort: "low" as const };
}

/**
 * A Messages request with the developer prompt as the system prompt and the
 * user turn as given, its schema enforced. The system prompt is the first
 * cache breakpoint. With several user blocks (the recent prompts, then the
 * passage), the last prompt block is the second: a cleanup after one more send
 * finds the earlier write within the API's lookback and reads it, until the
 * window of prompts moves on.
 */
export function claudeRequestBody(options: {
  model: string;
  effort: VoiceReasoningEffort;
  system: string;
  user: string | readonly string[];
  schema: object;
  maxTokens: number;
}) {
  const { model, effort, system, user, schema, maxTokens } = options;
  const { thinking, effort: requestEffort } = thinkingFor(model, effort);
  const content: string | ClaudeTextBlock[] =
    typeof user === "string"
      ? user
      : user.map((text, index) => ({
          type: "text",
          text,
          ...(index === user.length - 2 ? { cache_control: CACHE_BREAKPOINT } : {}),
        }));
  return {
    model,
    max_tokens: maxTokens + (effort === "none" ? 0 : THINKING_HEADROOM_TOKENS),
    thinking,
    output_config: {
      effort: requestEffort,
      format: { type: "json_schema", schema },
    },
    system: [{ type: "text", text: system, cache_control: CACHE_BREAKPOINT }],
    messages: [{ role: "user", content }],
  };
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number };
}

export interface ClaudeMessage {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: ClaudeUsage;
}

/** Usage as the OpenAI requests count it: cached and cache-written tokens inside the input. */
export function readClaudeUsage(usage: ClaudeUsage | undefined) {
  if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    return undefined;
  }
  const cachedTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cachedTokens + cacheWriteTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** The first text block, which is where structured output writes the JSON. */
export function claudeMessageText(message: ClaudeMessage): string | undefined {
  return message.content?.find((block) => block.type === "text" && block.text)?.text;
}

/** The error type of a failed request's body; its message can echo request content. */
export function claudeErrorCode(body: unknown): string | undefined {
  const type = (body as { error?: { type?: unknown } } | null)?.error?.type;
  return typeof type === "string" ? type : undefined;
}

export interface ClaudeStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  message?: ClaudeMessage;
  usage?: ClaudeUsage;
  error?: { type?: unknown };
}

/**
 * Rebuilds a streamed reply as the whole message would have read: the first
 * text block's text, the stop reason, and the usage the start and the final
 * delta report between them. `take` returns the text an event adds, and
 * `settled` the message once the stream has said it is done.
 */
export class ClaudeStreamReader {
  private textIndex: number | null = null;
  private usage: ClaudeUsage = {};
  private stopReason: string | null = null;
  private done = false;

  take(event: ClaudeStreamEvent): string | null {
    switch (event.type) {
      case "message_start":
        this.usage = { ...event.message?.usage };
        return null;
      case "content_block_start":
        if (this.textIndex === null && event.content_block?.type === "text") {
          this.textIndex = event.index ?? 0;
        }
        return null;
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && event.index === this.textIndex) {
          return event.delta.text ?? null;
        }
        return null;
      case "message_delta":
        if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason;
        this.usage = { ...this.usage, ...event.usage };
        return null;
      case "message_stop":
        this.done = true;
        return null;
      default:
        return null;
    }
  }

  settled(text: string): ClaudeMessage | null {
    if (!this.done) return null;
    return {
      content: text ? [{ type: "text", text }] : [],
      stop_reason: this.stopReason,
      usage: this.usage,
    };
  }
}
