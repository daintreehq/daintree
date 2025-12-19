// Bracketed paste escape sequences
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

// Threshold for when to use bracketed paste
export const PASTE_THRESHOLD_CHARS = 200;

/**
 * Get the soft-newline sequence for a given agent type.
 * Shift+Enter behavior differs by agent CLI.
 * For normal terminal types, returns plain LF (standard newline).
 */
export function getSoftNewlineSequence(agentType?: string): string {
  // Codex uses plain LF (\n / Ctrl+J)
  if (agentType === "codex") {
    return "\n";
  }
  // Claude and Gemini agents use ESC+CR
  if (agentType === "claude" || agentType === "gemini") {
    return "\x1b\r";
  }
  // Normal terminals (type "terminal" or undefined) use plain LF
  return "\n";
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
 */
export function formatWithBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}
