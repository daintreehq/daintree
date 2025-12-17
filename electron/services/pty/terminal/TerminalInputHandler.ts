/**
 * TerminalInputHandler - Handles terminal input formatting and chunking.
 *
 * Extracted from TerminalProcess to separate input concerns:
 * - Bracketed paste detection and atomic sending
 * - Input chunking for safe PTY writing
 * - Submit queue management
 * - Soft newline handling for different agent types
 */

import type { TerminalType } from "../../../../shared/types/domain.js";

// Constants from TerminalProcess
export const WRITE_MAX_CHUNK_SIZE = 8192;
export const WRITE_INTERVAL_MS = 5;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
export const SUBMIT_BRACKETED_PASTE_THRESHOLD_CHARS = 200;
export const SUBMIT_ENTER_DELAY_MS = 200;

/**
 * Check if data contains a full bracketed paste.
 * Bracketed paste should be sent atomically to preserve paste detection.
 */
export function isBracketedPaste(data: string): boolean {
  if (!data.startsWith(BRACKETED_PASTE_START)) {
    return false;
  }
  return data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length) !== -1;
}

/**
 * Split input into chunks for safe PTY writing.
 * Chunks at max size OR before escape sequences to prevent mid-sequence splits.
 */
export function chunkInput(data: string, maxChunkSize: number = WRITE_MAX_CHUNK_SIZE): string[] {
  if (data.length === 0) {
    return [];
  }
  if (data.length <= maxChunkSize) {
    return [data];
  }

  const chunks: string[] = [];
  let start = 0;

  for (let i = 0; i < data.length - 1; i++) {
    if (i - start + 1 >= maxChunkSize || data[i + 1] === "\x1b") {
      chunks.push(data.substring(start, i + 1));
      start = i + 1;
    }
  }

  if (start < data.length) {
    chunks.push(data.substring(start));
  }

  return chunks;
}

/**
 * Normalize submit text by converting line endings.
 */
export function normalizeSubmitText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Split trailing newlines from text and count them.
 */
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

/**
 * Check if a terminal is a Gemini terminal.
 */
export function isGeminiTerminal(type?: TerminalType, detectedAgentType?: string): boolean {
  return type === "gemini" || detectedAgentType === "gemini";
}

/**
 * Check if a terminal is a Codex terminal.
 */
export function isCodexTerminal(type?: TerminalType, detectedAgentType?: string): boolean {
  return type === "codex" || detectedAgentType === "codex";
}

/**
 * Check if terminal supports bracketed paste.
 */
export function supportsBracketedPaste(type?: TerminalType, detectedAgentType?: string): boolean {
  return !isGeminiTerminal(type, detectedAgentType);
}

/**
 * Get the soft newline sequence for a terminal type.
 */
export function getSoftNewlineSequence(type?: TerminalType, detectedAgentType?: string): string {
  return isCodexTerminal(type, detectedAgentType) ? "\n" : "\x1b\r";
}

/**
 * Wrap text in bracketed paste sequences.
 */
export function wrapInBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

export interface InputQueueCallbacks {
  write: (data: string) => void;
  onError?: (error: unknown, context: { operation: string; traceId?: string }) => void;
}

/**
 * Manages input write queue for chunked writes.
 */
export class InputWriteQueue {
  private queue: string[] = [];
  private timeout: NodeJS.Timeout | null = null;
  private intervalMs: number;

  constructor(
    private callbacks: InputQueueCallbacks,
    intervalMs: number = WRITE_INTERVAL_MS
  ) {
    this.intervalMs = intervalMs;
  }

  /**
   * Enqueue data chunks for writing.
   */
  enqueue(data: string): void {
    const chunks = chunkInput(data);
    this.queue.push(...chunks);
    this.startWrite();
  }

  /**
   * Get the current queue length.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if a write timeout is pending.
   */
  get isPending(): boolean {
    return this.timeout !== null;
  }

  /**
   * Wait for the queue to drain.
   */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.timeout === null) {
      return;
    }

    return new Promise((resolve) => {
      const check = () => {
        if (this.queue.length === 0 && this.timeout === null) {
          resolve();
          return;
        }
        setTimeout(check, 0);
      };
      check();
    });
  }

  /**
   * Clear the queue and cancel any pending write.
   */
  clear(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.queue = [];
  }

  private startWrite(): void {
    if (this.timeout !== null || this.queue.length === 0) {
      return;
    }

    this.doWrite();

    if (this.queue.length > 0) {
      this.timeout = setTimeout(() => {
        this.timeout = null;
        this.startWrite();
      }, this.intervalMs);
    }
  }

  private doWrite(): void {
    if (this.queue.length === 0) {
      return;
    }

    const chunk = this.queue.shift()!;
    try {
      this.callbacks.write(chunk);
    } catch (error) {
      this.callbacks.onError?.(error, { operation: "write(chunk)" });
    }
  }
}
