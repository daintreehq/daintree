import type { TerminalInfo } from "./types.js";
import {
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  SEMANTIC_FLUSH_INTERVAL_MS,
} from "./types.js";

const PENDING_SEMANTIC_DATA_MAX_CHARS = 64 * 1024;

export class SemanticBufferManager {
  private pendingSemanticData = "";
  private semanticFlushTimer: NodeJS.Timeout | null = null;
  private maxLines = SEMANTIC_BUFFER_MAX_LINES;

  constructor(private terminalInfo: TerminalInfo) {}

  /**
   * Retention hook: cap the semantic line buffer per the terminal's retention
   * tier. Lowering the cap trims the existing buffer immediately (newest lines
   * kept); raising it only affects future accumulation.
   */
  setMaxLines(lines: number): void {
    if (!Number.isFinite(lines) || lines < 0) return;
    this.maxLines = Math.floor(lines);
    // Zero disables the buffer entirely. Handled explicitly because
    // `slice(-0)` is `slice(0)` — it would KEEP everything instead of nothing.
    if (this.maxLines === 0) {
      this.terminalInfo.semanticBuffer = [];
      return;
    }
    const buffer = this.terminalInfo.semanticBuffer;
    if (buffer.length > this.maxLines) {
      this.terminalInfo.semanticBuffer = buffer.slice(-this.maxLines);
    }
  }

  onData(data: string): void {
    this.pendingSemanticData += data;
    if (this.pendingSemanticData.length > PENDING_SEMANTIC_DATA_MAX_CHARS) {
      this.pendingSemanticData = this.pendingSemanticData.slice(-PENDING_SEMANTIC_DATA_MAX_CHARS);
    }

    if (this.semanticFlushTimer) {
      return;
    }

    this.semanticFlushTimer = setTimeout(() => {
      if (this.pendingSemanticData) {
        this.updateSemanticBuffer(this.pendingSemanticData);
        this.pendingSemanticData = "";
      }
      this.semanticFlushTimer = null;
    }, SEMANTIC_FLUSH_INTERVAL_MS);
  }

  flush(): void {
    if (this.semanticFlushTimer) {
      clearTimeout(this.semanticFlushTimer);
      this.semanticFlushTimer = null;
    }
    if (this.pendingSemanticData) {
      this.updateSemanticBuffer(this.pendingSemanticData);
      this.pendingSemanticData = "";
    }
  }

  getLastCommand(): string | undefined {
    const buffer = this.terminalInfo.semanticBuffer;
    if (buffer.length === 0) return undefined;

    for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 10; i--) {
      let line = buffer[i].trim();

      if (line.length === 0) continue;

      line = line.replace(/^[^@]*@[^:]*:[^\s]*\s*[$>%#]\s*/, "");
      line = line.replace(/^~?[^\s]*[$>%#]\s*/, "");
      line = line.replace(/^[$>%#]\s*/, "");

      if (line.length > 0) {
        return line;
      }
    }
    return undefined;
  }

  dispose(): void {
    if (this.semanticFlushTimer) {
      clearTimeout(this.semanticFlushTimer);
      this.semanticFlushTimer = null;
    }
  }

  private updateSemanticBuffer(chunk: string): void {
    const terminal = this.terminalInfo;
    // A zero cap means the buffer is disabled — appending and then slicing
    // with -0 would grow it without bound.
    if (this.maxLines === 0) {
      if (terminal.semanticBuffer.length > 0) terminal.semanticBuffer = [];
      return;
    }
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    if (terminal.semanticBuffer.length > 0 && lines.length > 0 && !normalized.startsWith("\n")) {
      terminal.semanticBuffer[terminal.semanticBuffer.length - 1] += lines[0];
      lines.shift();
    }

    const processedLines = lines
      .filter((line) => line.length > 0 || terminal.semanticBuffer.length > 0)
      .map((line) => {
        if (line.length > SEMANTIC_BUFFER_MAX_LINE_LENGTH) {
          return line.substring(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH) + "... [truncated]";
        }
        return line;
      });

    terminal.semanticBuffer.push(...processedLines.slice(-this.maxLines));

    if (terminal.semanticBuffer.length > this.maxLines) {
      terminal.semanticBuffer = terminal.semanticBuffer.slice(-this.maxLines);
    }
  }
}
