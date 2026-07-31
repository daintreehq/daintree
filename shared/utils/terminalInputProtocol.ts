import { getEffectiveAgentConfig } from "../config/agentRegistry.js";

// Bracketed paste escape sequences
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

// Threshold for when to use bracketed paste
export const PASTE_THRESHOLD_CHARS = 200;

/**
 * Get the soft-newline sequence for a given agent type.
 * Reads from agent registry capabilities. For normal terminals (undefined or "terminal"),
 * returns plain LF. For unknown agent IDs, defaults to ESC+CR (most agent CLIs use this).
 */
export function getSoftNewlineSequence(agentType?: string): string {
  if (!agentType || agentType === "terminal") return "\n";
  const config = getEffectiveAgentConfig(agentType);
  if (config) {
    return config.capabilities?.softNewlineSequence ?? "\x1b\r";
  }
  return "\x1b\r";
}

/**
 * Check if text contains a complete bracketed paste sequence.
 */
export function containsFullBracketedPaste(data: string): boolean {
  if (!data.startsWith(BRACKETED_PASTE_START)) {
    return false;
  }
  return data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length) !== -1;
}

/**
 * Determine if text should use bracketed paste formatting.
 */
export function shouldUseBracketedPaste(
  text: string,
  thresholdChars = PASTE_THRESHOLD_CHARS
): boolean {
  return text.includes("\n") || text.length > thresholdChars;
}

/**
 * Format text with bracketed paste if needed.
 *
 * Embedded ESC bytes are replaced with their visible representation (U+241B)
 * before wrapping. Without that, text containing `\x1b[201~` — legal in a POSIX
 * filename, and reachable from a dropped path — would terminate the wrapper
 * early and hand the remainder to the program as ordinary input, which can
 * include a submit. This mirrors xterm's own `bracketTextForPaste`.
 */
export function formatWithBracketedPaste(text: string): string {
  const sanitized = text.replace(/\x1b/g, "␛");
  return `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`;
}
