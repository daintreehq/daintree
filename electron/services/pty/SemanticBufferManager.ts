import type { TerminalInfo } from "./types.js";
import {
  SEMANTIC_BUFFER_MAX_LINES,
  SEMANTIC_BUFFER_MAX_LINE_LENGTH,
  SEMANTIC_BUFFER_TRUNCATION_MARKER,
  SEMANTIC_FLUSH_INTERVAL_MS,
} from "./types.js";

const PENDING_SEMANTIC_DATA_MAX_CHARS = 64 * 1024;
const LF = 10;
const CR = 13;
// Breaks within this distance are found by a plain backward loop. Past it the search switches to
// indexOf, which V8 runs as memchr: its backward searches, lastIndexOf included, only run at loop
// speed, so a 64-KiB line would otherwise cost far more to scan than the old split did.
const BACKWARD_SCAN_LIMIT = 256;

function capLine(line: string): string {
  if (line.length > SEMANTIC_BUFFER_MAX_LINE_LENGTH) {
    return line.substring(0, SEMANTIC_BUFFER_MAX_LINE_LENGTH) + SEMANTIC_BUFFER_TRUNCATION_MARKER;
  }
  return line;
}

function capRange(text: string, start: number, end: number): string {
  if (end - start > SEMANTIC_BUFFER_MAX_LINE_LENGTH) {
    return (
      text.slice(start, start + SEMANTIC_BUFFER_MAX_LINE_LENGTH) + SEMANTIC_BUFFER_TRUNCATION_MARKER
    );
  }
  return text.slice(start, end);
}

function isTruncatedLine(line: string): boolean {
  return (
    line.length === SEMANTIC_BUFFER_MAX_LINE_LENGTH + SEMANTIC_BUFFER_TRUNCATION_MARKER.length &&
    line.endsWith(SEMANTIC_BUFFER_TRUNCATION_MARKER)
  );
}

function isLineBreak(code: number): boolean {
  return code === LF || code === CR;
}

function firstLineBreak(text: string): number {
  const lf = text.indexOf("\n");
  // Searching for CR only before the first LF keeps LF-only output from scanning the whole chunk.
  const cr = (lf === -1 ? text : text.slice(0, lf)).indexOf("\r");
  return cr === -1 ? lf : cr;
}

// The slice bounds both searches; indexOf on the whole text could run on to its end.
function hasLineBreak(text: string, start: number, end: number): boolean {
  const range = text.slice(start, end);
  return range.indexOf("\n") !== -1 || range.indexOf("\r") !== -1;
}

function scanBackForLineBreak(text: string, end: number, floor: number): number {
  for (let i = end - 1; i >= floor; i--) {
    if (isLineBreak(text.charCodeAt(i))) return i;
  }
  return -1;
}

/** Index of the last CR or LF in [floor, end), or floor - 1 when there is none. */
function lastLineBreak(text: string, end: number, floor: number): number {
  let hi = Math.max(floor, end - BACKWARD_SCAN_LIMIT);
  const near = scanBackForLineBreak(text, end, hi);
  if (near !== -1) return near;

  // Gallop back through doubling windows to the first that holds a break, then halve it down to
  // the last break in it, keeping a break in [lo, hi) and none in [hi, end).
  let lo = hi;
  for (let width = BACKWARD_SCAN_LIMIT; ; width *= 2) {
    if (hi === floor) return floor - 1;
    lo = Math.max(floor, hi - width);
    if (hasLineBreak(text, lo, hi)) break;
    hi = lo;
  }
  while (hi - lo > BACKWARD_SCAN_LIMIT) {
    const mid = lo + ((hi - lo) >> 1);
    if (hasLineBreak(text, mid, hi)) lo = mid;
    else hi = mid;
  }
  return scanBackForLineBreak(text, hi, lo);
}

/**
 * The last SEMANTIC_BUFFER_MAX_LINES entries of `text.slice(start)` split on CRLF, CR and LF,
 * capped, with empty entries dropped unless `keepEmpty`. Only the returned entries are built, so a
 * newline-heavy burst costs the same as a short one.
 */
function retainedLines(text: string, start: number, keepEmpty: boolean): string[] {
  const lines: string[] = [];
  let end = text.length;
  for (;;) {
    const lineBreak = lastLineBreak(text, end, start);
    if (end - lineBreak > 1 || keepEmpty) {
      lines.push(capRange(text, lineBreak + 1, end));
      if (lines.length === SEMANTIC_BUFFER_MAX_LINES) break;
    }
    if (lineBreak < start) break;
    end =
      lineBreak > start &&
      text.charCodeAt(lineBreak) === LF &&
      text.charCodeAt(lineBreak - 1) === CR
        ? lineBreak - 1
        : lineBreak;
  }
  return lines.reverse();
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
    const lastIndex = terminal.semanticBuffer.length - 1;
    const last = terminal.semanticBuffer[lastIndex];
    // The first flush filters out its trailing empty entry, so a completed line can be the last
    // retained one; the next chunk then starts a new line rather than continuing it.
    const continuesLastLine =
      lastIndex >= 0 &&
      !isLineBreak(chunk.charCodeAt(0)) &&
      !(this.lastChunkEndedWithNewline && last !== "");
    this.lastChunkEndedWithNewline = isLineBreak(chunk.charCodeAt(chunk.length - 1));

    let restStart = 0;
    if (continuesLastLine) {
      const firstBreak = firstLineBreak(chunk);
      // A capped line has already discarded its tail; dropping the continuation keeps it bounded
      // and stops the next fragment from being joined onto the marker.
      if (!isTruncatedLine(last)) {
        // One character past the cap is enough to truncate, and spares copying a long fragment.
        const fragmentEnd = Math.min(
          firstBreak === -1 ? chunk.length : firstBreak,
          SEMANTIC_BUFFER_MAX_LINE_LENGTH + 1
        );
        terminal.semanticBuffer[lastIndex] = capLine(last + chunk.slice(0, fragmentEnd));
      }
      restStart =
        firstBreak === -1
          ? -1
          : firstBreak +
            (chunk.charCodeAt(firstBreak) === CR && chunk.charCodeAt(firstBreak + 1) === LF
              ? 2
              : 1);
    }

    if (restStart !== -1) {
      terminal.semanticBuffer.push(
        ...retainedLines(chunk, restStart, terminal.semanticBuffer.length > 0)
      );
    }

    if (terminal.semanticBuffer.length > SEMANTIC_BUFFER_MAX_LINES) {
      terminal.semanticBuffer = terminal.semanticBuffer.slice(-SEMANTIC_BUFFER_MAX_LINES);
    }
  }
}
