/**
 * Finds the stretch of one of Claude Code's own replies that a terminal
 * selection shows, so a clean copy can hand back what the agent wrote instead
 * of a rebuild of what the TUI drew (#15527).
 *
 * The TUI wraps with real newlines and a hanging indent, hides emphasis and
 * code markers, escapes and heading hashes, numbers lists its own way, and
 * draws quote bars, table borders and code blocks without their fences. So
 * both sides are reduced to the characters that survive all of that, each
 * remembering where it sat and what lay between it and the one before:
 * whitespace or not, and which markers. A selection matches where its
 * characters run unbroken inside a reply's and every gap agrees: space where
 * the reply has space (or a wrap where it has none, for a token the TUI broke),
 * and every marker the TUI would have drawn, drawn. The span handed back is
 * that stretch of the reply, widened at each end to the markers that belong to
 * it.
 *
 * Nothing is guessed the other way. A selection that starts or ends partway
 * through a word, leaves an emphasis or code span half open, could be two
 * different stretches, or isn't in any reply gets null, and the caller keeps
 * its own reconstruction.
 */

// Markers the TUI draws nothing for in prose. In code they're drawn as they are.
const HIDDEN = new Set(["*", "_", "`", "~", "\\"]);
// Markers the TUI may draw differently: a hash is a heading's or a tag's, a
// pipe may come out as a box-drawing border.
const RESTYLED = new Set(["#", "|"]);
// The TUI's own message, tool-output and bullet marks.
const CHROME = new Set(["⏺", "⎿", "•", "◦", "▪", "‣"]);

// Indent, quote marks and a list marker: bullets, numbers, and the letters and
// roman numerals Claude Code numbers nested lists with.
const LINE_PREFIX =
  /^([\s>⏺⎿▎▌│┃]*)(?:([-*+•◦▪‣]|\d{1,3}[.)]|[a-z][.)]|[ivxlcdm]{2,6}[.)])(?=\s|$)\s*)?/u;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
// Horizontal rules and table separators, which the TUI redraws or leaves out.
const RULE = /^[\s\-–—_*=:|+─-╿]*$/u;
const RULE_MARKS = /[-–—_*=─-╿]/gu;

const WORD = /[\p{L}\p{N}]/u;

// Past this many places a selection could be, it's too common to place.
const MAX_OCCURRENCES = 64;

interface ParsedLine {
  start: number;
  /** Before the newline. */
  end: number;
  /** Past the indent, quote marks and list marker. */
  contentStart: number;
  /** Where its list marker starts, if it has one. */
  marker: number | null;
  quote: boolean;
  /** A fence delimiter, dropped like the TUI drops it. */
  fence: boolean;
  /** The fenced block this line is code in. */
  block: number | null;
}

interface Block {
  open: number;
  close: number | null;
  marks: string;
}

/** What lies between a kept character and the one kept before it. */
interface Gap {
  space: boolean;
  newline: boolean;
  /** Markers and chrome, in order. */
  marks: string;
  /** Per mark, "1" where the TUI draws it whatever the context: code, a tag's hash, a word's underscore. */
  shown: string;
}

interface Skeleton {
  text: string;
  /** Where each UTF-16 unit of `text` sits in the original. */
  at: number[];
  /** Per UTF-16 unit of `text`, the gap before it; null when there is none. */
  gaps: (Gap | null)[];
  lines: ParsedLine[];
  blocks: Block[];
}

function isChrome(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return CHROME.has(ch) || (code >= 0x2500 && code <= 0x259f);
}

function isDropped(ch: string): boolean {
  return HIDDEN.has(ch) || RESTYLED.has(ch) || isChrome(ch) || /\s/u.test(ch);
}

function isRule(text: string): boolean {
  return RULE.test(text) && (text.match(RULE_MARKS)?.length ?? 0) >= 3;
}

function charAt(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function charBefore(text: string, index: number): string {
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) return text.slice(index - 2, index);
  return text.charAt(index - 1);
}

// A heading's hashes, which the TUI leaves off.
const HEADING = /^#{1,6}(?=\s|$)/;

/** Whether the TUI draws the marker at `index` wherever it sits. */
function alwaysShown(text: string, index: number, line: ParsedLine, headingEnd: number): boolean {
  const ch = text.charAt(index);
  if (line.block !== null || isChrome(ch)) return true;
  if (ch === "#") return index >= headingEnd;
  // Emphasis never opens or closes inside a word with underscores.
  if (ch === "_") {
    return WORD.test(charBefore(text, index)) && WORD.test(charAt(text, index + 1));
  }
  return false;
}

function skeletonOf(text: string): Skeleton {
  const lines: ParsedLine[] = [];
  const blocks: Block[] = [];
  let chars = "";
  const at: number[] = [];
  const gaps: (Gap | null)[] = [];
  let gap: Gap | null = null;
  const pending = (): Gap => (gap ??= { space: false, newline: false, marks: "", shown: "" });
  let open: Block | null = null;
  let start = 0;
  for (const raw of text.split("\n")) {
    const end = start + raw.length;
    const prefix = LINE_PREFIX.exec(raw)!;
    const line: ParsedLine = {
      start,
      end,
      contentStart: start + prefix[0].length,
      marker: prefix[2] ? start + prefix[1]!.length : null,
      quote: prefix[1]!.includes(">"),
      fence: false,
      block: null,
    };
    const fence = FENCE.exec(raw);
    if (fence) {
      const [, marks, rest] = fence;
      if (!open) {
        open = { open: lines.length, close: null, marks: marks! };
        blocks.push(open);
        line.fence = true;
      } else if (
        marks![0] === open.marks[0] &&
        marks!.length >= open.marks.length &&
        !rest!.trim()
      ) {
        open.close = lines.length;
        open = null;
        line.fence = true;
      } else {
        line.block = blocks.length - 1;
      }
    } else if (open) {
      line.block = blocks.length - 1;
    }
    if (lines.length > 0) {
      pending().space = true;
      pending().newline = true;
    }
    lines.push(line);
    if (!fence && !isRule(raw)) {
      if (/\s/u.test(prefix[0])) pending().space = true;
      const heading = line.block === null ? HEADING.exec(raw.slice(prefix[0].length)) : null;
      const headingEnd = line.contentStart + (heading ? heading[0].length : 0);
      for (let i = line.contentStart; i < end;) {
        const ch = charAt(text, i);
        if (/\s/u.test(ch)) {
          pending().space = true;
        } else if (isDropped(ch)) {
          const next = pending();
          next.marks += ch;
          next.shown += alwaysShown(text, i, line, headingEnd) ? "1" : "0";
        } else {
          chars += ch;
          for (let unit = 0; unit < ch.length; unit++) {
            at.push(i + unit);
            gaps.push(unit === 0 ? gap : null);
          }
          gap = null;
        }
        i += ch.length;
      }
    }
    start = end + 1;
  }
  return { text: chars, at, gaps, lines, blocks };
}

/**
 * Whether the selection's gap is one the TUI could have drawn for the reply's:
 * space for space, a wrap for nothing (a token broken at the margin), and each
 * marker it drew present, with only its own chrome extra.
 */
function gapsAgree(reply: Gap | null, selected: Gap | null): boolean {
  const replySpace = reply?.space ?? false;
  const selectedSpace = selected?.space ?? false;
  if (replySpace && !selectedSpace) return false;
  if (!replySpace && selectedSpace && !selected!.newline) return false;
  const marks = reply?.marks ?? "";
  const shown = reply?.shown ?? "";
  const drawn = selected?.marks ?? "";
  let i = 0;
  let j = 0;
  while (i < marks.length || j < drawn.length) {
    if (i < marks.length && j < drawn.length && marks[i] === drawn[j]) {
      i++;
      j++;
    } else if (j < drawn.length && isChrome(drawn[j]!)) {
      j++;
    } else if (i < marks.length && shown[i] === "0") {
      i++;
    } else {
      return false;
    }
  }
  return true;
}

function lineIndexOf(lines: readonly ParsedLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lines[mid]!.start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What the selection's first and last lines carry beyond their skeleton. */
interface SelectionEdges {
  skeleton: string;
  gaps: (Gap | null)[];
  /** A list marker opens the line the skeleton starts on. */
  marker: boolean;
  quote: boolean;
  /** Markers the selection took before its first kept character and after its last. */
  lead: string;
  trail: string;
}

function selectedMarks(text: string): string {
  let marks = "";
  for (const ch of text) {
    if (HIDDEN.has(ch) || RESTYLED.has(ch)) marks += ch;
  }
  return marks;
}

function selectionEdges(selection: string): SelectionEdges | null {
  const parsed = skeletonOf(selection);
  if (!parsed.text) return null;
  const firstAt = parsed.at[0]!;
  const lastAt = parsed.at[parsed.at.length - 1]!;
  const first = parsed.lines[lineIndexOf(parsed.lines, firstAt)]!;
  const last = parsed.lines[lineIndexOf(parsed.lines, lastAt)]!;
  const lastEnd = lastAt + charAt(selection, lastAt).length;
  return {
    skeleton: parsed.text,
    gaps: parsed.gaps,
    marker: first.marker !== null,
    quote: first.quote,
    lead: selectedMarks(selection.slice(first.contentStart, firstAt)),
    trail: selectedMarks(selection.slice(lastEnd, last.end)),
  };
}

/** Whether every emphasis, strike and code span opened in `text` also closes there. */
function balanced(text: string): boolean {
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  return (
    count(/`/g) % 2 === 0 &&
    count(/\*\*/g) % 2 === 0 &&
    count(/__/g) % 2 === 0 &&
    count(/~~/g) % 2 === 0
  );
}

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/**
 * Where the span starts: the selection's own marks taken back from its first
 * character, then, in prose, what the TUI hid around them. Two starts, with
 * and without the hidden markers, for the balance check to choose between.
 */
function startsOf(
  source: string,
  line: ParsedLine,
  from: number,
  floor: number,
  edges: SelectionEdges
): { with: number; without: number } | null {
  const code = line.block !== null;
  const atContentStart = floor <= line.start;
  if ((edges.marker || edges.quote) && !atContentStart) return null;
  if (edges.marker && line.marker === null) return null;
  if (edges.quote && !line.quote) return null;

  let start = from;
  let wanted = edges.lead.length;
  for (let i = from; i > Math.max(floor, line.contentStart) && wanted > 0;) {
    const ch = charBefore(source, i);
    i -= ch.length;
    if (ch === edges.lead[wanted - 1]) {
      wanted--;
      start = i;
    } else if (!isWhitespace(ch) && (code || !HIDDEN.has(ch))) {
      break;
    }
  }
  if (wanted > 0) return null;

  if (atContentStart) {
    const lineStart = edges.marker || line.marker === null ? line.start : line.contentStart;
    if (code) {
      const whole = edges.marker || !source.slice(lineStart, start).trim();
      return whole ? { with: lineStart, without: lineStart } : { with: start, without: start };
    }
    return { with: lineStart, without: start };
  }
  if (code) return { with: start, without: start };
  let widened = start;
  while (widened > floor && HIDDEN.has(charBefore(source, widened))) widened--;
  return { with: widened, without: start };
}

/** The mirror of {@link startsOf}, at the span's end. */
function endsOf(
  source: string,
  line: ParsedLine,
  from: number,
  ceiling: number,
  edges: SelectionEdges
): { with: number; without: number } | null {
  const code = line.block !== null;
  const atContentEnd = ceiling >= line.end;
  let end = from;
  let taken = 0;
  for (let i = from; i < Math.min(ceiling, line.end) && taken < edges.trail.length;) {
    const ch = charAt(source, i);
    i += ch.length;
    if (ch === edges.trail[taken]) {
      taken++;
      end = i;
    } else if (!isWhitespace(ch) && (code || !HIDDEN.has(ch))) {
      break;
    }
  }
  if (taken < edges.trail.length) return null;

  if (code) return { with: end, without: end };
  if (atContentEnd) return { with: line.end, without: end };
  let widened = end;
  while (widened < ceiling && HIDDEN.has(source.charAt(widened))) widened++;
  return { with: widened, without: end };
}

function dedent(text: string, firstIsFree: boolean): string {
  const lines = text.split("\n");
  let common = Infinity;
  lines.forEach((line, i) => {
    if (!line.trim() || (i === 0 && firstIsFree)) return;
    common = Math.min(common, line.length - line.trimStart().length);
  });
  if (common === Infinity || common === 0) return text;
  return lines
    .map((line, i) => (i === 0 && firstIsFree ? line : line.slice(Math.min(common, line.length))))
    .join("\n");
}

/**
 * The span itself: the edges chosen so no emphasis or code span is left half
 * open on a line of prose the selection only partly covers, and a fenced block
 * the span runs into or out of kept whole.
 */
function spanText(
  source: string,
  reply: Skeleton,
  first: number,
  last: number,
  edges: SelectionEdges
): string | null {
  const { at, lines, blocks } = reply;
  for (let k = first + 1; k <= last; k++) {
    if (!gapsAgree(reply.gaps[k] ?? null, edges.gaps[k - first] ?? null)) return null;
  }
  const from = at[first]!;
  const to = at[last]! + 1;
  // Partway through a word at either end.
  let before = from;
  while (before > 0 && HIDDEN.has(charBefore(source, before))) before--;
  if (before > 0 && WORD.test(charAt(source, from)) && WORD.test(charBefore(source, before))) {
    return null;
  }
  let after = to;
  while (after < source.length && HIDDEN.has(source.charAt(after))) after++;
  if (
    after < source.length &&
    WORD.test(charBefore(source, to)) &&
    WORD.test(charAt(source, after))
  ) {
    return null;
  }

  const startLine = lines[lineIndexOf(lines, from)]!;
  const endLine = lines[lineIndexOf(lines, to - 1)]!;
  const floor = first > 0 ? Math.max(at[first - 1]! + 1, startLine.start) : startLine.start;
  const ceiling = last + 1 < at.length ? Math.min(at[last + 1]!, endLine.end) : endLine.end;
  const starts = startsOf(source, startLine, from, floor, edges);
  const ends = endsOf(source, endLine, to, ceiling, edges);
  if (!starts || !ends) return null;

  const proseEdge = (start: number, end: number) => {
    const head = startLine.block === null && !startLine.fence;
    const tail = endLine.block === null && !endLine.fence;
    if (startLine === endLine) return !head || balanced(source.slice(start, end));
    return (
      (!head || balanced(source.slice(start, startLine.end))) &&
      (!tail || balanced(source.slice(endLine.start, end)))
    );
  };
  const choice = [
    [starts.with, ends.with],
    [starts.without, ends.with],
    [starts.with, ends.without],
    [starts.without, ends.without],
  ].find(([start, end]) => proseEdge(start!, end!));
  if (!choice) return null;
  let [start, end] = choice as [number, number];

  let head = "";
  let tail = "";
  const startBlock = startLine.block === null ? null : blocks[startLine.block]!;
  const endBlock = endLine.block === null ? null : blocks[endLine.block]!;
  if (startBlock && startBlock !== endBlock) {
    const opening = lines[startBlock.open]!;
    if (start === lines[startBlock.open + 1]!.start) start = opening.start;
    else head = `${source.slice(opening.start, opening.end)}\n`;
  }
  if (endBlock && endBlock !== startBlock) {
    const lastCode = endBlock.close === null ? null : lines[endBlock.close - 1]!;
    if (lastCode === endLine && !source.slice(end, endLine.end).trim()) {
      end = lines[endBlock.close!]!.end;
    } else {
      tail = `\n${endBlock.marks}`;
    }
  }

  const text = (head + source.slice(start, end) + tail).replace(/\s+$/u, "");
  return dedent(text.replace(/^\s*\n/u, ""), start > startLine.start && !head);
}

/**
 * The stretch of `replies` (newest first) that `selection` shows, as the agent
 * wrote it, or null when it can't be placed in exactly one way.
 */
export function findReplySpan(selection: string, replies: readonly string[]): string | null {
  const edges = selectionEdges(selection.replace(/\r\n/g, "\n").replace(/ /g, " "));
  if (!edges) return null;
  let found: string | null = null;
  let occurrences = 0;
  for (const raw of replies) {
    const source = raw.replace(/\r\n/g, "\n");
    const reply = skeletonOf(source);
    for (
      let index = reply.text.indexOf(edges.skeleton);
      index !== -1;
      index = reply.text.indexOf(edges.skeleton, index + 1)
    ) {
      if (++occurrences > MAX_OCCURRENCES) return null;
      const text = spanText(source, reply, index, index + edges.skeleton.length - 1, edges);
      // Each place it could be must give the same text, or which one was
      // selected can't be known.
      if (text === null || (found !== null && text !== found)) return null;
      found = text;
    }
  }
  return found;
}
