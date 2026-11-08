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
 * Whether the window from `start` could end an OSC: a BEL, or an ST whose ESC
 * is raw `ESC \` or one a removed CSI joins to the `\`. An OSC that crosses
 * the window start has to.
 */
function windowMayEndOsc(text: string, start: number): boolean {
  return (
    text.indexOf("\x07", start) !== -1 ||
    text.indexOf("\x1b\\", start) !== -1 ||
    text.indexOf("\x1b\x1b", start) !== -1
  );
}

/**
 * Guards window starts against an OSC that begins before one and runs past
 * it, which would make the window strip to different lines than the whole
 * text. A window start follows a CR or LF, and of stripAnsi's passes only OSC
 * (run after CSI removal) can match one. Its opener is a raw ESC followed by
 * `]`, or by an ESC that begins a removed CSI ahead of the `]`; its payload
 * holds no BEL and no ESC that survives CSI removal, so a BEL or ST between
 * the last opener and the start closes it first. Erring towards "may cross"
 * only costs a whole-text strip. Starts only move back, so each search
 * resumes below its last hit and reads the prefix at most once.
 */
function oscBoundaryGuard(text: string): (start: number) => boolean {
  let oscOpener = Number.POSITIVE_INFINITY;
  let escPair = Number.POSITIVE_INFINITY;
  let bel = Number.POSITIVE_INFINITY;
  let st = Number.POSITIVE_INFINITY;
  const lastBefore = (needle: string, cached: number, start: number) =>
    cached >= start ? text.lastIndexOf(needle, start - 1) : cached;
  return (start) => {
    oscOpener = lastBefore("\x1b]", oscOpener, start);
    escPair = lastBefore("\x1b\x1b", escPair, start);
    const opener = Math.max(oscOpener, escPair);
    if (opener === -1) return false;
    bel = lastBefore("\x07", bel, start);
    st = lastBefore("\x1b\\", st, start);
    return Math.max(bel, st) < opener;
  };
}

/**
 * The last `count` (a positive integer) non-blank lines of `text` once
 * ANSI-stripped and right-trimmed, exactly as stripping, splitting and
 * filtering the whole text would give them, but stripping only a window of
 * trailing raw lines. Agent TUIs repaint in multi-kilobyte chunks and only
 * the tail is ever read.
 *
 * `marker`, a non-global pattern, must match every line the caller is
 * looking for. Text that would be stripped whole without a match yields no
 * lines, so a cursor-addressed repaint with no line break is not stripped.
 */
export function getTrailingNonBlankLines(text: string, count: number, marker?: RegExp): string[] {
  let start = trailingLinesStart(text, count * 2);
  let oscMayCross: ((start: number) => boolean) | undefined;
  for (;;) {
    if (
      start === 0 ||
      (windowMayEndOsc(text, start) && (oscMayCross ??= oscBoundaryGuard(text))(start))
    ) {
      if (marker && !marker.test(text)) return [];
      return lastNonBlankLines(stripAnsi(text), count);
    }
    const lines = lastNonBlankLines(stripAnsi(text.slice(start)), count);
    if (lines.length >= count) return lines;
    // Blank lines filled the window. Doubling its span rather than its line
    // count keeps a long blank line from being re-stripped on every widening.
    start = lineStartAtOrBefore(text, Math.max(0, 2 * start - text.length));
  }
}
