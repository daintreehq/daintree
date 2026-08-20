import type { TerminalInfo } from "./types.js";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  getSoftNewlineSequence as getSoftNewlineSequenceShared,
  containsFullBracketedPaste,
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

export function normalizeSubmitText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
