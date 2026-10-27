import type { PtyClient } from "./PtyClient.js";
import { logDebug } from "../utils/logger.js";
import { redactSecretShapedLines } from "./voiceKeytermSecrets.js";

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
  const redacted = redactSecretShapedLines(lines.slice(-SNAPSHOT_LINES));
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
