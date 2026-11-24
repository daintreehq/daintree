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

const TAIL_SCAN_CHARS = 4096;

/**
 * Offset just past the `breaks`-th line break from the end of `text`, or 0
 * when it has fewer. CRLF counts as one break, as the line split does.
 * Line-shaped output has its breaks in the last few kilobytes; a
 * cursor-addressed repaint has almost none, and walking all of it a
 * character at a time costs more than the native search the rest gets.
 */
export function trailingLinesStart(text: string, breaks: number): number {
  let crossed = 0;
  const floor = Math.max(0, text.length - TAIL_SCAN_CHARS);
  let i = text.length - 1;
  for (; i >= floor; i--) {
    const code = text.charCodeAt(i);
    if (code !== CR && code !== LF) continue;
    if (++crossed === breaks) return i + 1;
    if (code === LF && i > 0 && text.charCodeAt(i - 1) === CR) i--;
  }
  return i < 0 ? 0 : nthBreakStartFromEnd(text, i + 1, breaks - crossed);
}

/** `trailingLinesStart` over `text.slice(0, end)`, searched front to back. */
function nthBreakStartFromEnd(text: string, end: number, breaks: number): number {
  const starts: number[] = [];
  let found = 0;
  let cr = text.indexOf("\r");
  let lf = text.indexOf("\n");
  for (;;) {
    const at = Math.min(cr === -1 ? end : cr, lf === -1 ? end : lf);
    if (at >= end) break;
    const crlf = at === cr && lf === at + 1 && at + 1 < end;
    const next = crlf ? at + 2 : at + 1;
    starts[found++ % breaks] = next;
    if (cr !== -1 && cr < next) cr = text.indexOf("\r", next);
    if (lf !== -1 && lf < next) lf = text.indexOf("\n", next);
  }
  return found < breaks ? 0 : starts[(found - breaks) % breaks];
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
 * Whether any OSC could cover a character of the raw line `[start, end)` or
 * the break that ends it: one opens inside it, or one opened before it runs
 * past its start (the same test `oscBoundaryGuard` makes, without its
 * cache, since lines are visited front to back).
 */
// eslint-disable-next-line no-control-regex
const OSC_OPENER = /\x1b[\]\x1b]/g;

function oscMayReachLine(text: string, start: number, end: number): boolean {
  // One regex pass: ESC is the commonest byte in a repaint, which makes a
  // string search for either two-byte opener slower than this.
  OSC_OPENER.lastIndex = start;
  const opener = OSC_OPENER.exec(text);
  if (opener !== null && opener.index < end - 1) return true;
  if (start === 0) return false;
  const lastOpener = Math.max(
    text.lastIndexOf("\x1b]", start - 1),
    text.lastIndexOf("\x1b\x1b", start - 1)
  );
  if (lastOpener === -1) return false;
  return (
    Math.max(text.lastIndexOf("\x07", start - 1), text.lastIndexOf("\x1b\\", start - 1)) <
    lastOpener
  );
}

const WHITESPACE = /\s/;

/**
 * Whether the raw character at `i`, outside any OSC, is visible non-blank
 * text whatever surrounds it. Of stripAnsi's passes a non-ASCII character can
 * only fall inside an OSC, and a lowercase letter only as a CSI's final byte,
 * which follows `[` or a parameter or intermediate byte.
 */
function survivesStripping(text: string, i: number): boolean {
  const code = text.charCodeAt(i);
  if (code >= 0x80) return !WHITESPACE.test(text[i]);
  if (code < 0x61 || code > 0x7a) return false;
  const previous = text.charCodeAt(i - 1);
  return previous !== 0x5b && !(previous >= 0x20 && previous <= 0x3f);
}

/**
 * A long raw line's stripped text up to and including its first character
 * that `survivesStripping`, and from its last. A deletion never spans a
 * character that survives, so the line strips to `head`, then whatever lies
 * between, then `tail`: its first non-blank character is in `head` and its
 * last in `tail`.
 */
function lineEdges(
  text: string,
  start: number,
  end: number
): { head: string; tail: string } | undefined {
  if (oscMayReachLine(text, start, end)) return undefined;
  let first = start;
  while (first < end && !survivesStripping(text, first)) first++;
  if (first === end) return undefined;
  let last = end - 1;
  while (!survivesStripping(text, last)) last--;
  return {
    head: stripAnsi(text.slice(start, first + 1)),
    tail: stripAnsi(text.slice(last, end)),
  };
}

const LONG_LINE_CHARS = 1024;

/**
 * Strips `text` from `from`, which must not fall inside an escape sequence.
 * With `edgesMayMatch`, a raw line longer than `LONG_LINE_CHARS` whose edges
 * rule it out comes back as just `head + tail`: still non-blank, and still
 * ruled out by its edges, but never stripped whole.
 */
function stripFrom(
  text: string,
  from: number,
  edgesMayMatch: ((head: string, tail: string) => boolean) | undefined
): string {
  if (!edgesMayMatch) return stripAnsi(from === 0 ? text : text.slice(from));
  let stripped = "";
  let unstripped = from;
  let nextCr = -2;
  let nextLf = -2;
  for (let lineStart = from; lineStart < text.length;) {
    if (nextCr !== -1 && nextCr < lineStart) nextCr = text.indexOf("\r", lineStart);
    if (nextLf !== -1 && nextLf < lineStart) nextLf = text.indexOf("\n", lineStart);
    const lineEnd = Math.min(
      nextCr === -1 ? text.length : nextCr,
      nextLf === -1 ? text.length : nextLf
    );
    if (lineEnd - lineStart > LONG_LINE_CHARS) {
      const edges = lineEdges(text, lineStart, lineEnd);
      if (edges && !edgesMayMatch(edges.head, edges.tail)) {
        stripped += stripAnsi(text.slice(unstripped, lineStart)) + edges.head + edges.tail;
        unstripped = lineEnd;
      }
    }
    lineStart = lineEnd + 1;
  }
  return stripped + stripAnsi(text.slice(unstripped));
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
 *
 * `edgesMayMatch` must accept every line the caller is looking for, given
 * `head`, the line's stripped text through its first lowercase letter or
 * non-ASCII character, and `tail`, from its last. With it, a cursor-addressed
 * repaint that strips to one long line is read at its two ends instead of
 * stripped whole, and comes back as those ends joined when they rule it out.
 */
export function getTrailingNonBlankLines(
  text: string,
  count: number,
  marker?: RegExp,
  edgesMayMatch?: (head: string, tail: string) => boolean
): string[] {
  let start = trailingLinesStart(text, count * 2);
  let oscMayCross: ((start: number) => boolean) | undefined;
  for (;;) {
    if (
      start === 0 ||
      (windowMayEndOsc(text, start) && (oscMayCross ??= oscBoundaryGuard(text))(start))
    ) {
      if (marker && !marker.test(text)) return [];
      return lastNonBlankLines(stripFrom(text, 0, edgesMayMatch), count);
    }
    const lines = lastNonBlankLines(stripFrom(text, start, edgesMayMatch), count);
    if (lines.length >= count) return lines;
    // Blank lines filled the window. Doubling its span rather than its line
    // count keeps a long blank line from being re-stripped on every widening.
    start = lineStartAtOrBefore(text, Math.max(0, 2 * start - text.length));
  }
}
