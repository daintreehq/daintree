const BRACKETED_PASTE_START = "\x1b[200~";

/**
 * Input that submits a line: Return pressed, not Return carried inside pasted
 * text. A bracketed paste wraps everything it inserts, newlines included, so a
 * multiline paste is a draft being written rather than an answer being sent.
 */
export function isTerminalSubmission(data: string): boolean {
  if (data.includes(BRACKETED_PASTE_START)) return false;
  return data.endsWith("\r") || data.endsWith("\n");
}

/** How input to a terminal answers what its screen asked, if it does. */
export type TerminalAnswer = "submit" | "key";

/**
 * Keys that answer an approval menu on their own: a digit picks an option
 * (Claude, Gemini), Y / N / A answer Codex, and Escape declines. Arrows, Tab
 * and editing keys only move around the menu.
 */
const ANSWER_KEY = /^[1-9yYnNaA]$/;
const ESCAPE = "\x1b";

/**
 * Whether `data`, typed into a terminal, answers its screen: `"submit"` for
 * Return, `"key"` for a key that answers an approval menu by itself, and null
 * for anything else. Stricter than {@link isTerminalSubmission}: the soft
 * newlines agents take for Shift+Enter (a bare LF, or ESC CR) only add a line
 * to a reply still being written, and the reports a terminal writes on its own
 * behalf never match a single key.
 */
export function terminalAnswerOf(data: string): TerminalAnswer | null {
  if (data.includes(BRACKETED_PASTE_START)) return null;
  if (data === ESCAPE || ANSWER_KEY.test(data)) return "key";
  if (data.endsWith("\x1b\r")) return null;
  return data.endsWith("\r") ? "submit" : null;
}
