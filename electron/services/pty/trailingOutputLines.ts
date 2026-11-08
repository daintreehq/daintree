import { stripAnsi } from "./AgentPatternDetector.js";

const LINE_BREAK_PATTERN = /\r\n|\r|\n/;

function lastNonBlankLines(stripped: string, count: number): string[] {
  return stripped
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

const CR = 13;
const LF = 10;

/**
 * Offset just past the `breaks`-th line break from the end of `text`, or 0
 * when it has fewer. CRLF counts as one break, as the line split does.
 */
function trailingLinesStart(text: string, breaks: number): number {
  let crossed = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (code !== CR && code !== LF) continue;
    if (++crossed === breaks) return i + 1;
    if (code === LF && i > 0 && text.charCodeAt(i - 1) === CR) i--;
  }
  return 0;
}

function lineStartAtOrBefore(text: string, offset: number): number {
  let i = offset;
  while (i > 0) {
    const code = text.charCodeAt(i - 1);
    if (code === CR || code === LF) break;
    i--;
  }
  return i;
}

/**
 * Whether stripping could remove an escape sequence that starts before
 * `start` and runs past it, so the text from `start` would not strip to the
 * same lines as the whole. `start` follows a CR or LF, and of stripAnsi's
 * passes only OSC (run after CSI removal) can match one. An OSC opener there
 * is a raw ESC followed by `]`, or by an ESC that begins a removed CSI ahead
 * of the `]`; its payload holds no BEL and no ESC that survives CSI removal,
 * so a BEL or ST between the last opener and `start` closes it first. Erring
 * towards true only costs a whole-text strip.
 */
function oscMayCrossWindowStart(text: string, start: number): boolean {
  const opener = Math.max(text.lastIndexOf("\x1b]", start - 1), text.lastIndexOf("\x1b\x1b", start - 1));
  if (opener === -1) return false;
  const bel = text.indexOf("\x07", opener + 1);
  if (bel !== -1 && bel < start) return false;
  const st = text.indexOf("\x1b\\", opener + 1);
  return st === -1 || st >= start;
}

/**
 * The last `count` (a positive integer) non-blank lines of `text` once
 * ANSI-stripped and right-trimmed, exactly as stripping, splitting and
 * filtering the whole text would give them, but stripping only a window of
 * trailing raw lines. Agent TUIs repaint in multi-kilobyte chunks and only
 * the tail is ever read.
 */
export function getTrailingNonBlankLines(text: string, count: number): string[] {
  let start = trailingLinesStart(text, count * 2);
  for (;;) {
    if (start === 0 || oscMayCrossWindowStart(text, start)) {
      return lastNonBlankLines(stripAnsi(text), count);
    }
    const lines = lastNonBlankLines(stripAnsi(text.slice(start)), count);
    if (lines.length >= count) return lines;
    // Blank lines filled the window. Doubling its span rather than its line
    // count keeps a long blank line from being re-stripped on every widening.
    start = lineStartAtOrBefore(text, Math.max(0, 2 * start - text.length));
  }
}
