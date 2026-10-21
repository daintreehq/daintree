import type { TerminalInfo } from "./types.js";
import {
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  SEMANTIC_BUFFER_TRUNCATION_MARKER,
  SEMANTIC_FLUSH_INTERVAL_MS,
} from "./types.js";

const PENDING_SEMANTIC_DATA_MAX_CHARS = 64 * 1024;

function capLine(line: string): string {
  if (line.length > SEMANTIC_BUFFER_MAX_LINE_LENGTH) {
    return line.substring(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH) + SEMANTIC_BUFFER_TRUNCATION_MARKER;
  }
  return line;
}

function isTruncatedLine(line: string): boolean {
  return (
    line.length === SEMANTIC_BUFFER_MAX_LINE_LENGTH + SEMANTIC_BUFFER_TRUNCATION_MARKER.length &&
    line.endsWith(SEMANTIC_BUFFER_TRUNCATION_MARKER)
  );
}

export class SemanticBufferManager {
  private pendingSemanticData = "";
  private semanticFlushTimer: NodeJS.Timeout | null = null;
  private lastChunkEndedWithNewline = false;

  constructor(private terminalInfo: TerminalInfo) {}

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
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    const lastIndex = terminal.semanticBuffer.length - 1;
    const last = terminal.semanticBuffer[lastIndex];
    // The first flush filters out its trailing empty entry, so a completed line can be the last
    // retained one; the next chunk then starts a new line rather than continuing it.
    const continuesLastLine =
      lastIndex >= 0 &&
      !normalized.startsWith("\n") &&
      !(this.lastChunkEndedWithNewline && last !== "");
    this.lastChunkEndedWithNewline = normalized.endsWith("\n");

    if (continuesLastLine) {
      // A capped line has already discarded its tail; dropping the continuation keeps it bounded
      // and stops the next fragment from being joined onto the marker.
      if (!isTruncatedLine(last)) {
        terminal.semanticBuffer[lastIndex] = capLine(last + lines[0]);
      }
      lines.shift();
    }

    const processedLines = lines
      .filter((line) => line.length > 0 || terminal.semanticBuffer.length > 0)
      .map(capLine);

    terminal.semanticBuffer.push(...processedLines.slice(-SEMANTIC_BUFFER_MAX_LINES));

    if (terminal.semanticBuffer.length > SEMANTIC_BUFFER_MAX_LINES) {
      terminal.semanticBuffer = terminal.semanticBuffer.slice(-SEMANTIC_BUFFER_MAX_LINES);
    }
  }
}
