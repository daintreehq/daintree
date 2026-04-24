import type { TerminalInfo } from "./types.js";
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  getSoftNewlineSequence as getSoftNewlineSequenceShared,
  containsFullBracketedPaste,
} from "../../../shared/utils/terminalInputProtocol.js";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import { WRITE_MAX_CHUNK_SIZE } from "./types.js";

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
  return terminal.detectedAgentId ?? terminal.launchAgentId;
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
  const delayMs = config?.capabilities?.submitEnterDelayMs;
  if (delayMs === undefined || delayMs === null || isNaN(delayMs) || delayMs < 0) {
    return SUBMIT_ENTER_DELAY_MS;
  }
  return Math.min(delayMs, 5000);
}

export function isBracketedPaste(data: string): boolean {
  return containsFullBracketedPaste(data);
}

export function chunkInput(data: string): string[] {
  if (data.length === 0) {
    return [];
  }
  if (data.length <= WRITE_MAX_CHUNK_SIZE) {
    return [data];
  }

  const chunks: string[] = [];
  let start = 0;

  for (let i = 0; i < data.length - 1; i++) {
    if (i - start + 1 >= WRITE_MAX_CHUNK_SIZE || data[i + 1] === "\x1b") {
      chunks.push(data.substring(start, i + 1));
      start = i + 1;
    }
  }

  if (start < data.length) {
    chunks.push(data.substring(start));
  }

  return chunks;
}
