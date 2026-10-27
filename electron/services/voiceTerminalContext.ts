import type { PtyClient } from "./PtyClient.js";
import { logDebug } from "../utils/logger.js";
import { readAgentReplyForCorrection, type VoiceAgentReply } from "./voiceAgentReply.js";
import { readTerminalLines } from "./voiceContextKeyterms.js";

const P = "[VoiceTerminalContext]";

// The window redaction runs over: a wrapped key's later lines must sit in the
// same pass as the line that gave it away.
const SNAPSHOT_LINES = 200;
export const MAX_CORRECTION_TERMINAL_LINES = 150;
// Keeps a wall of output or a very wide terminal from ballooning the request;
// the newest text survives.
export const MAX_CORRECTION_TERMINAL_CHARS = 6000;
const MAX_LINE_CHARS = 300;
export const TERMINAL_READ_BUDGET_MS = 500;

/**
 * Prepares terminal lines for the cleanup request: credential-shaped lines
 * emptied, long lines cut, blank runs folded, then the newest lines kept
 * within the line and character bounds. Null when nothing readable is left.
 */
export function boundTerminalOutput(lines: readonly string[]): string | null {
  // Colour codes can split a credential name from its value, so they go before
  // the redactor sees the line. Strict, because the text is sent as written.
  const redacted = readTerminalLines(lines.slice(-SNAPSHOT_LINES), true);
  const kept: string[] = [];
  for (const raw of redacted) {
    const line = raw.trimEnd().slice(0, MAX_LINE_CHARS);
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept[kept.length - 1] === "") kept.pop();

  const recent = kept.slice(-MAX_CORRECTION_TERMINAL_LINES);
  let size = 0;
  let start = recent.length;
  while (start > 0) {
    const next = size + recent[start - 1]!.length + 1;
    if (next > MAX_CORRECTION_TERMINAL_CHARS) break;
    size = next;
    start--;
  }
  const text = recent.slice(start).join("\n").trim();
  return text === "" ? null : text;
}

/**
 * What the dictated terminal recently printed, ready to send with the cleanup
 * request. The caller has already decided the terminal may be read. A slow or
 * failed read yields null, so cleanup runs without it.
 */
export async function readTerminalOutputForCorrection(
  ptyClient: PtyClient | undefined,
  terminalId: string | undefined,
  budgetMs: number = TERMINAL_READ_BUDGET_MS
): Promise<string | null> {
  if (!ptyClient || !terminalId) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
      timer.unref();
    });
    const snapshot = await Promise.race([ptyClient.getTerminalSnapshot(terminalId), timeout]);
    return Array.isArray(snapshot?.lines) ? boundTerminalOutput(snapshot.lines) : null;
  } catch {
    logDebug(`${P} Terminal read failed`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What cleanup is sent of the dictated terminal: its screen, and its agent's last reply when the transcript has one. */
export interface TerminalCorrectionContext {
  terminalOutput: string | null;
  agentReply: VoiceAgentReply | null;
}

export const NO_TERMINAL_CORRECTION_CONTEXT: TerminalCorrectionContext = {
  terminalOutput: null,
  agentReply: null,
};

/**
 * The dictated terminal's screen and its agent's last reply, read side by side
 * within one budget. Either coming back empty leaves the other.
 */
export async function readTerminalContextForCorrection(
  ptyClient: PtyClient | undefined,
  terminalId: string | undefined,
  budgetMs: number = TERMINAL_READ_BUDGET_MS
): Promise<TerminalCorrectionContext> {
  const [terminalOutput, agentReply] = await Promise.all([
    readTerminalOutputForCorrection(ptyClient, terminalId, budgetMs),
    readAgentReplyForCorrection(ptyClient, terminalId, budgetMs),
  ]);
  return { terminalOutput, agentReply };
}
