import type { TerminalInfo } from "./types.js";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  getSoftNewlineSequence as getSoftNewlineSequenceShared,
  containsFullBracketedPaste,
  neutralizeControlCharacters,
} from "../../../shared/utils/terminalInputProtocol.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";

export { BRACKETED_PASTE_START, BRACKETED_PASTE_END, PASTE_THRESHOLD_CHARS };

export const SUBMIT_ENTER_DELAY_MS = 200;
export const OUTPUT_SETTLE_DEBOUNCE_MS = 200;
export const OUTPUT_SETTLE_MAX_WAIT_MS = 2000;
export const OUTPUT_SETTLE_POLL_INTERVAL_MS = 50;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The submission text boundary: every path that puts a *body* into a terminal
 * goes through here, and nothing downstream of it may assume the text is safe.
 *
 * Line endings fold to `\n` first — the submission paths re-encode that into
 * whichever newline protocol the destination speaks — and then every remaining
 * control character is neutralised. Doing it here rather than per branch is the
 * point: bracketed paste already defended itself, but the soft-newline branch
 * (agents that declare no bracketed paste, Gemini among them) and the plain
 * short-text branch wrote the body through untouched, so page-derived text —
 * DOM ids and class names the Site Builder quotes into a prompt — could reach
 * the agent as terminal input rather than as prompt text.
 *
 * Trusted protocol bytes are added AFTER this runs, by the caller that means
 * them. Raw keystrokes never come through here at all.
 */
export function normalizeSubmitText(text: string): string {
  const folded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return neutralizeControlCharacters(folded);
}

export function splitTrailingNewlines(text: string): { body: string; enterCount: number } {
  let body = text;
  let enterCount = 0;
  while (body.endsWith("\n")) {
    body = body.slice(0, -1);
    enterCount++;
  }
  if (enterCount === 0) {
    enterCount = 1;
  }
  return { body, enterCount };
}

function getEffectiveAgentId(terminal: TerminalInfo): string | undefined {
  // Input protocol follows the live process. A demoted shell returns plain
  // behavior (no agent-specific submit delay, bracketed-paste, soft-newline)
  // regardless of what this terminal was originally launched as.
  return terminal.detectedAgentId;
}

export function normalizeSubmitEnterDelay(delayMs: number | null | undefined): number {
  if (delayMs === undefined || delayMs === null || isNaN(delayMs) || delayMs < 0) {
    return SUBMIT_ENTER_DELAY_MS;
  }
  return Math.min(delayMs, 5000);
}

export function supportsBracketedPaste(terminal: TerminalInfo): boolean {
  const agentId = getEffectiveAgentId(terminal);
  if (!agentId) return true;
  const config = getEffectiveAgentConfig(agentId);
  return config?.capabilities?.supportsBracketedPaste ?? true;
}

export function getSoftNewlineSequence(terminal: TerminalInfo): string {
  const agentId = getEffectiveAgentId(terminal);
  return getSoftNewlineSequenceShared(agentId);
}

export function getSubmitEnterDelay(terminal: TerminalInfo): number {
  const agentId = getEffectiveAgentId(terminal);
  if (!agentId) return SUBMIT_ENTER_DELAY_MS;
  const config = getEffectiveAgentConfig(agentId);
  return normalizeSubmitEnterDelay(config?.capabilities?.submitEnterDelayMs);
}

export function isBracketedPaste(data: string): boolean {
  return containsFullBracketedPaste(data);
}

// xterm.js 6.0 dispatches DEC ?1004 focus reports as isolated 3-byte writes
// when the textarea gains/loses focus and the TUI has enabled focus tracking.
// Tests `=== "\x1b[I"` rather than substring to avoid false positives on the
// occasional sequence whose payload happens to contain CSI I/O (#8865).
export function isFocusReport(data: string): boolean {
  return data === "\x1b[I" || data === "\x1b[O";
}

// Sequences xterm writes on its own behalf: focus and mouse reports, and the
// replies to cursor-position (plain and DEC-private), device-status (including
// the colour-scheme report), device-attribute, mode, window, OSC and DCS
// queries. None of them puts text in a composer.
const TERMINAL_REPORT_SEQUENCE =
  // eslint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\x1b\[(?:[IO]|M[\s\S]{3}|<\d+;\d+;\d+[Mm]|\??\d+;\d+(?:;\d+)?R|\??[\d;]*n|[?>][\d;]*c|\??[\d;]*\$y|[\d;]*t)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

/**
 * True when `data` consists only of terminal-generated reports (#12491).
 *
 * Deliberately narrow: anything it does not recognise counts as typing, so an
 * unfamiliar key sequence errs toward "the composer may hold something".
 */
export function isTerminalReportOnly(data: string): boolean {
  if (data.length === 0) return true;
  return data.replace(TERMINAL_REPORT_SEQUENCE, "").length === 0;
}
