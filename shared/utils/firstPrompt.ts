import type { TerminalFirstPrompt, TerminalFirstPromptVia } from "../types/panel.js";

/**
 * The record rides the panel into the project's state file on every layout
 * save, so a prompt gets a ceiling well above a long task brief and well below
 * anything that would make that save noticeable.
 */
export const FIRST_PROMPT_MAX_CHARS = 8_000;

/** `text` cut at the cap, never between the two halves of a surrogate pair. */
function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= FIRST_PROMPT_MAX_CHARS) return { text, truncated: false };
  let end = FIRST_PROMPT_MAX_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * The record for a prompt delivered at `at`, or undefined when there is nothing
 * to record: a launch or send with no text is not a prompt.
 */
export function buildFirstPrompt(
  text: string | undefined,
  via: TerminalFirstPromptVia,
  at: number
): TerminalFirstPrompt | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const capped = capText(text);
  return {
    text: capped.text,
    via,
    at,
    ...(capped.truncated && { truncated: true as const }),
  };
}

/**
 * Normalize an untrusted persisted value. The snapshot schema passes unknown
 * keys through, so a hand-edited or corrupted record falls back to no record
 * rather than reach Review Hub as a non-string or an unknown label.
 */
export function sanitizeFirstPrompt(value: unknown): TerminalFirstPrompt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const text = "text" in value ? value.text : undefined;
  const via = "via" in value ? value.via : undefined;
  const at = "at" in value ? value.at : undefined;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  if (via !== "launch" && via !== "send") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const capped = capText(text);
  const truncated = capped.truncated || ("truncated" in value && value.truncated === true);
  return {
    text: capped.text,
    via,
    at,
    ...(truncated && { truncated: true as const }),
  };
}
