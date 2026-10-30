/**
 * Finds the stretch of one of Claude Code's own replies that a terminal
 * selection shows, so a clean copy can hand back what the agent wrote instead
 * of a rebuild of what the TUI drew (#15527).
 *
 * The TUI wraps with real newlines and a hanging indent, hides emphasis and
 * code-span markers, escapes and heading hashes, numbers lists its own way,
 * and draws quote bars, table borders and code blocks without their fences.
 * So both sides are reduced to the characters that survive all of that, each
 * remembering where it sat and what lay between it and the one before. A
 * selection matches where its characters run unbroken inside a reply's and
 * every gap agrees. In prose that means space where the reply has space (or a
 * wrap where it has none, for a token the TUI broke), a list item where the
 * reply has one, and every marker the TUI draws there, drawn. Code, which the
 * TUI draws as it is, must match line for line, shifted right by the same
 * indent throughout, wraps aside. The span handed back is that stretch of the
 * reply, widened at each end only over markers the TUI hides.
 *
 * Nothing is guessed the other way. A selection that starts or ends partway
 * through a word, leaves an emphasis or code span half open, could be two
 * different stretches, or isn't in any reply gets null, and the caller keeps
 * its own reconstruction.
 */

// The TUI's own message, tool-output and bullet marks. Box drawing is chrome too.
const CHROME = new Set(["⏺", "⎿", "•", "◦", "▪", "‣"]);
// Markdown's inline markers, and the hashes and pipes the TUI may leave off or redraw.
const MARKERS = new Set(["*", "_", "`", "~", "\\", "#", "|"]);

// Indent, quote marks and a list marker: bullets, numbers, and the letters and
// roman numerals Claude Code numbers nested lists with.
const LINE_PREFIX =
  /^([\s>⏺⎿▎▌│┃]*)(?:([-*+•◦▪‣]|\d{1,3}[.)]|[a-z][.)]|[ivxlcdm]{2,6}[.)])(?=\s|$)\s*)?/u;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
// Horizontal rules and table separators, which the TUI redraws in prose.
const RULE = /^[\s\-–—_*=:|+\u2500-\u257f]*$/u;
const RULE_MARKS = /[-–—_*=\u2500-\u257f]/gu;
// A heading's hashes, which the TUI leaves off.
const HEADING = /^#{1,6}(?=\s|$)/;
// Punctuation a backslash escapes, which the TUI draws without it.
const ESCAPABLE = /[!-/:-@[-`{-~]/;
// A word runs on through letters, digits, combining marks and underscores.
const WORD = /[\p{L}\p{N}\p{M}_]/u;

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
  /** Its quote marks and list marker as written, without the whitespace. */
  prefix: string;
  /** A fence delimiter, dropped like the TUI drops it. */
  fence: boolean;
  /** A horizontal rule or table separator. */
  rule: boolean;
  /** The fenced block this line is code in. */
  block: number | null;
}

interface Block {
  open: number;
  close: number | null;
  marks: string;
}

/** What lies between a kept character of prose and the one kept before it. */
interface Gap {
  newlines: number;
  /** Whitespace since the last line break. */
  space: string;
  /** Markers and chrome, in order. */
  marks: string;
  /** Per mark, "1" where the TUI draws it. */
  shown: string;
  /** A list marker or quote marks open the line it ends on. */
  marker: boolean;
  quote: boolean;
}

const NO_GAP: Gap = { newlines: 0, space: "", marks: "", shown: "", marker: false, quote: false };

interface Skeleton {
  source: string;
  text: string;
  /** Where each UTF-16 unit of `text` sits in the original. */
  at: number[];
  /** Per UTF-16 unit of `text`, the gap before it; null when there is none. */
  gaps: (Gap | null)[];
  /** Per offset of the original, 1 where a marker is drawn as it is. Only a reply's is filled in. */
  shown: Uint8Array;
  /** Per offset, 1 + the index in `pairs` of the delimiter pair a hidden marker belongs to. */
  pair: Int32Array;
  /** Each pair's opening offset and the end of its closing run. */
  pairs: [number, number][];
  lines: ParsedLine[];
  blocks: Block[];
}

function isChrome(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return CHROME.has(ch) || (code >= 0x2500 && code <= 0x259f);
}

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

function isDropped(ch: string): boolean {
  return MARKERS.has(ch) || isChrome(ch) || isWhitespace(ch);
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

/** The lines, with a reply's fences found. A selection's fence-like lines are code the TUI drew. */
function parseLines(text: string, reply: boolean): { lines: ParsedLine[]; blocks: Block[] } {
  const lines: ParsedLine[] = [];
  const blocks: Block[] = [];
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
      prefix: prefix[1]!.replace(/[^>]/g, "") + (prefix[2] ?? ""),
      fence: false,
      rule: false,
      block: null,
    };
    const fence = reply ? FENCE.exec(raw) : null;
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
    line.rule = !line.fence && isRule(raw);
    lines.push(line);
    start = end + 1;
  }
  return { lines, blocks };
}

interface Opener {
  ch: string;
  at: number;
  length: number;
}

/**
 * Which of a reply's prose markers the TUI draws, paragraph by paragraph: the
 * contents of a code span, an escaped character, a hash past a heading's, a
 * pipe outside a table, and any backtick, star, underscore or tilde run with
 * nothing to pair with. The pairs, the escapes' and hard breaks' backslashes,
 * and the heading's hashes it hides, and each pair is recorded so a span can
 * be held to taking both ends of one.
 */
function markInline(text: string, skeleton: Skeleton): void {
  const { lines, shown, pair, pairs } = skeleton;
  const content = (line: ParsedLine) => text.slice(line.contentStart, line.end);
  const prose = (line: ParsedLine) =>
    line.block === null && !line.fence && !line.rule && content(line).trim() !== "";
  const alone = (line: ParsedLine) => HEADING.test(content(line)) || content(line).startsWith("|");
  const continues = (n: number) =>
    n > 0 &&
    n < lines.length &&
    prose(lines[n]!) &&
    prose(lines[n - 1]!) &&
    lines[n]!.marker === null &&
    !alone(lines[n]!) &&
    !alone(lines[n - 1]!);
  const runOf = (index: number, end: number) => {
    let next = index;
    while (next < end && text[next] === text[index]) next++;
    return next - index;
  };
  const pairUp = (open: number, close: number, length: number) => {
    const id = pairs.push([open, close + length]);
    pair.fill(id, open, open + length);
    pair.fill(id, close, close + length);
  };
  // A code span closes at the next run of the same length within its paragraph.
  const codeClose = (n: number, from: number, length: number): number => {
    for (let m = n; m === n || continues(m); m++) {
      const line = lines[m]!;
      for (let j = m === n ? from : line.contentStart; j < line.end;) {
        const run = text[j] === "`" ? runOf(j, line.end) : 1;
        if (text[j] === "`" && run === length) return j;
        j += run;
      }
    }
    return -1;
  };

  let openers: Opener[] = [];
  const leave = (left: Opener[]) => {
    for (const opener of left) shown.fill(1, opener.at, opener.at + opener.length);
  };
  let resume = -1;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!continues(n)) {
      leave(openers);
      openers = [];
    }
    if (!prose(line)) continue;
    const from = resume > line.start ? resume : line.contentStart;
    if (from > line.end) continue;
    const headingEnd = line.contentStart + (HEADING.exec(content(line))?.[0].length ?? 0);
    const table = content(line).startsWith("|");
    for (let i = from; i < line.end;) {
      const ch = text[i]!;
      if (ch === "`") {
        const length = runOf(i, line.end);
        const close = codeClose(n, i + length, length);
        if (close === -1) {
          shown.fill(1, i, i + length);
          i += length;
          continue;
        }
        pairUp(i, close, length);
        shown.fill(1, i + length, close);
        i = close + length;
        if (close >= line.end) {
          resume = i;
          break;
        }
        continue;
      }
      if (ch === "\\") {
        // At the end of a line that goes on, a hard break, drawn as one.
        if (i + 1 === line.end && continues(n + 1)) {
          i++;
        } else if (i + 1 < line.end && ESCAPABLE.test(text[i + 1]!)) {
          shown[i + 1] = 1;
          i += 2;
        } else {
          shown[i] = 1;
          i++;
        }
        continue;
      }
      if (ch === "*" || ch === "_" || ch === "~") {
        const length = runOf(i, line.end);
        const before = i > line.contentStart ? charBefore(text, i) : " ";
        const after = i + length < line.end ? charAt(text, i + length) : " ";
        const intraword = ch === "_" && WORD.test(before) && WORD.test(after);
        // A closing run closes the innermost openers it covers: `***` can
        // close a `*` and then a `**`.
        let left = length;
        while (!intraword && !isWhitespace(before) && left > 0) {
          let k = openers.length - 1;
          while (k >= 0 && openers[k]!.ch !== ch) k--;
          if (k === -1 || openers[k]!.length > left) break;
          const [opener, ...unclosed] = openers.splice(k);
          leave(unclosed);
          pairUp(opener!.at, i + length - left, opener!.length);
          left -= opener!.length;
        }
        if (left === length && !intraword && !isWhitespace(after)) {
          openers.push({ ch, at: i, length });
        } else {
          shown.fill(1, i + length - left, i + length);
        }
        i += length;
        continue;
      }
      if (ch === "#") shown[i] = i >= headingEnd ? 1 : 0;
      else if (ch === "|") shown[i] = table ? 0 : 1;
      else if (isChrome(ch)) shown[i] = 1;
      i++;
    }
  }
  leave(openers);
}

/**
 * A reply's skeleton (`reply`), with its fences found and what the TUI draws
 * of each marker worked out, or a selection's, which has neither.
 */
function skeletonOf(text: string, reply: boolean): Skeleton {
  const { lines, blocks } = parseLines(text, reply);
  const skeleton: Skeleton = {
    source: text,
    text: "",
    at: [],
    gaps: [],
    shown: new Uint8Array(reply ? text.length : 0),
    pair: new Int32Array(reply ? text.length : 0),
    pairs: [],
    lines,
    blocks,
  };
  if (reply) {
    for (const line of lines) {
      if (line.block !== null) skeleton.shown.fill(1, line.start, line.end);
    }
    markInline(text, skeleton);
  }

  let chars = "";
  const { at, gaps, shown } = skeleton;
  let gap: Gap | null = null;
  const pending = (): Gap => (gap ??= { ...NO_GAP });
  lines.forEach((line, n) => {
    if (n > 0) {
      const next = pending();
      next.newlines++;
      next.space = "";
      next.marker = false;
      next.quote = false;
    }
    if (line.fence) return;
    if (line.rule) {
      for (let i = line.start; i < line.end; i++) {
        if (isWhitespace(text[i]!)) continue;
        const next = pending();
        next.marks += text[i];
        next.shown += shown[i] ? "1" : "0";
      }
      return;
    }
    Object.assign(pending(), { marker: line.marker !== null, quote: line.quote });
    for (let i = line.contentStart; i < line.end;) {
      const ch = charAt(text, i);
      if (isWhitespace(ch)) {
        pending().space += ch;
      } else if (isDropped(ch)) {
        const next = pending();
        next.marks += ch;
        next.shown += shown[i] ? "1" : "0";
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
  });
  skeleton.text = chars;
  return skeleton;
}

/**
 * Whether the selection's gap in prose is one the TUI could have drawn for
 * the reply's: space for space, a wrap for nothing (a token broken at the
 * margin), a list item for a list item, and each marker it draws present,
 * with only its own chrome extra.
 */
function gapsAgree(reply: Gap | null, selected: Gap | null): boolean {
  const r = reply ?? NO_GAP;
  const s = selected ?? NO_GAP;
  const replySpace = r.newlines > 0 || r.space !== "";
  const selectedSpace = s.newlines > 0 || s.space !== "";
  if (replySpace && !selectedSpace) return false;
  if (!replySpace && selectedSpace && s.newlines === 0) return false;
  if (s.marker !== r.marker || (s.quote && !r.quote)) return false;
  let i = 0;
  let j = 0;
  while (i < r.marks.length || j < s.marks.length) {
    if (i < r.marks.length && j < s.marks.length && r.marks[i] === s.marks[j]) {
      i++;
      j++;
    } else if (j < s.marks.length && isChrome(s.marks[j]!)) {
      j++;
    } else if (i < r.marks.length && r.shown[i] === "0") {
      i++;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Whether a line of code, or the head of one, was drawn as `drawn`: the same
 * text after the indent, and the indent the same number of columns further
 * right as everywhere else in the span. The TUI never takes indent away.
 */
function shiftedAlike(
  code: string,
  drawn: string,
  shift: { value: number | null },
  wholeLine: boolean
): boolean {
  const reply = wholeLine ? code.trimEnd() : code;
  const selected = wholeLine ? drawn.trimEnd() : drawn;
  if (wholeLine && !reply) return !selected;
  const replyIndent = reply.length - reply.trimStart().length;
  const selectedIndent = selected.length - selected.trimStart().length;
  if (reply.slice(replyIndent) !== selected.slice(selectedIndent)) return false;
  // A tab is drawn as however many columns reach the next stop.
  if (reply.slice(0, replyIndent).includes("\t")) return true;
  const delta = selectedIndent - replyIndent;
  if (delta < 0) return false;
  shift.value ??= delta;
  return shift.value === delta;
}

/**
 * Whether the selection's gap beside code is the reply's as the TUI draws
 * code: within one block, line for line; leaving a block, the rest of its last
 * line; entering one, the head of its first.
 */
function codeGapAgrees(
  reply: string,
  selected: string,
  leaving: boolean,
  entering: boolean,
  within: boolean,
  shift: { value: number | null }
): boolean {
  const replyLines = reply.split("\n");
  const selectedLines = selected.split("\n");
  // The terminal keeps no blanks at the end of a row.
  const restAgrees = () => replyLines[0]!.trimEnd() === selectedLines[0]!.trimEnd();
  if (within) {
    if (replyLines.length === 1) {
      if (selectedLines.length > 1) {
        // Wrapped at the margin.
        return reply.replace(/\s/gu, "") === selected.replace(/\s/gu, "");
      }
      return reply.includes("\t")
        ? reply.replace(/\s+/gu, " ") === selected.replace(/\s+/gu, " ")
        : reply === selected;
    }
    if (selectedLines.length !== replyLines.length || !restAgrees()) return false;
    for (let i = 1; i < replyLines.length - 1; i++) {
      if (!shiftedAlike(replyLines[i]!, selectedLines[i]!, shift, true)) return false;
    }
    return shiftedAlike(replyLines.at(-1)!, selectedLines.at(-1)!, shift, false);
  }
  if (leaving && !restAgrees()) return false;
  return !entering || shiftedAlike(replyLines.at(-1)!, selectedLines.at(-1)!, shift, false);
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

/** The selection's skeleton, with what its first and last lines carry beyond it. */
interface SelectionEdges {
  source: string;
  skeleton: string;
  at: number[];
  gaps: (Gap | null)[];
  /** Where the line the skeleton starts on starts. */
  firstLineStart: number;
  /** A list marker opens that line. */
  marker: boolean;
  quote: boolean;
  /** Its quote marks and list marker, as {@link ParsedLine} has them. */
  prefix: string;
  /** Markers the selection took before its first kept character and after its last. */
  lead: string;
  trail: string;
}

function selectedMarks(text: string): string {
  let marks = "";
  for (const ch of text) {
    if (MARKERS.has(ch)) marks += ch;
  }
  return marks;
}

function selectionEdges(selection: string): SelectionEdges | null {
  const parsed = skeletonOf(selection, false);
  if (!parsed.text) return null;
  const firstAt = parsed.at[0]!;
  const lastAt = parsed.at[parsed.at.length - 1]!;
  const first = parsed.lines[lineIndexOf(parsed.lines, firstAt)]!;
  const last = parsed.lines[lineIndexOf(parsed.lines, lastAt)]!;
  // Whole lines selected before or after it, a rule or a fence the TUI drew,
  // would have nothing in the span to answer for them.
  for (const ch of selection.slice(0, first.start) + selection.slice(last.end)) {
    if (!isWhitespace(ch) && !isChrome(ch)) return null;
  }
  const lastEnd = lastAt + charAt(selection, lastAt).length;
  return {
    source: selection,
    skeleton: parsed.text,
    at: parsed.at,
    gaps: parsed.gaps,
    firstLineStart: first.start,
    marker: first.marker !== null,
    quote: first.quote,
    prefix: first.prefix,
    lead: selectedMarks(selection.slice(first.contentStart, firstAt)),
    trail: selectedMarks(selection.slice(lastEnd, last.end)),
  };
}

/** A marker the TUI draws nothing for. */
function isHidden(reply: Skeleton, index: number): boolean {
  return MARKERS.has(reply.source.charAt(index)) && reply.shown[index] === 0;
}

function onlyHidden(reply: Skeleton, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (!isWhitespace(reply.source.charAt(i)) && !isHidden(reply, i)) return false;
  }
  return true;
}

/** Whether every delimiter pair with an end between `from` and `to` has both. */
function balanced(reply: Skeleton, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const id = reply.pair[i]!;
    if (id === 0) continue;
    const [open, close] = reply.pairs[id - 1]!;
    if (open < from || close > to) return false;
  }
  return true;
}

/**
 * Where the span starts: the selection's own marks taken back from its first
 * character, then, in prose, the markers the TUI hid before them. Two starts,
 * with and without those, for the balance check to choose between.
 */
function startsOf(
  reply: Skeleton,
  line: ParsedLine,
  from: number,
  floor: number,
  edges: SelectionEdges
): { with: number; without: number } | null {
  const { source } = reply;
  const code = line.block !== null;
  const atContentStart = floor <= line.start;
  const prefixed = edges.marker || edges.quote;
  if (prefixed && !atContentStart) return null;
  if (edges.marker && line.marker === null) return null;
  if (edges.quote && !line.quote) return null;
  if (code && edges.prefix && edges.prefix !== line.prefix) return null;

  let start = from;
  let wanted = edges.lead.length;
  for (let i = from; i > Math.max(floor, line.contentStart) && wanted > 0;) {
    const ch = charBefore(source, i);
    i -= ch.length;
    if (ch === edges.lead[wanted - 1]) {
      wanted--;
      start = i;
    } else if (!isWhitespace(ch) && !isHidden(reply, i)) {
      break;
    }
  }
  if (wanted > 0) return null;

  if (code) {
    const whole =
      atContentStart &&
      (edges.prefix !== "" || (line.prefix === "" && !source.slice(line.start, start).trim()));
    return whole ? { with: line.start, without: line.start } : { with: start, without: start };
  }
  if (atContentStart && onlyHidden(reply, line.contentStart, start)) {
    // A list marker or quote marks only when the selection took them too.
    const keepsPrefix = (edges.marker || line.marker === null) && (edges.quote || !line.quote);
    if (prefixed && !keepsPrefix) return null;
    const lineStart = keepsPrefix ? line.start : line.contentStart;
    return { with: lineStart, without: prefixed ? lineStart : start };
  }
  if (prefixed) return null;
  let widened = start;
  while (widened > Math.max(floor, line.contentStart) && isHidden(reply, widened - 1)) widened--;
  return { with: widened, without: start };
}

/** The mirror of {@link startsOf}, at the span's end. */
function endsOf(
  reply: Skeleton,
  line: ParsedLine,
  from: number,
  ceiling: number,
  edges: SelectionEdges
): { with: number; without: number } | null {
  const { source } = reply;
  const code = line.block !== null;
  const atContentEnd = ceiling >= line.end;
  let end = from;
  let taken = 0;
  for (let i = from; i < Math.min(ceiling, line.end) && taken < edges.trail.length;) {
    const ch = charAt(source, i);
    if (ch === edges.trail[taken]) {
      taken++;
      end = i + ch.length;
    } else if (!isWhitespace(ch) && !isHidden(reply, i)) {
      break;
    }
    i += ch.length;
  }
  if (taken < edges.trail.length) return null;

  if (code) return { with: end, without: end };
  if (atContentEnd && onlyHidden(reply, end, line.end)) return { with: line.end, without: end };
  let widened = end;
  while (widened < ceiling && isHidden(reply, widened)) widened++;
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

/** Whether every gap between the matched characters is one the TUI could have drawn. */
function gapsMatch(
  reply: Skeleton,
  first: number,
  last: number,
  edges: SelectionEdges,
  shift: { value: number | null }
): boolean {
  const { source, at, lines } = reply;
  let line = lineIndexOf(lines, at[first]!);
  for (let k = first + 1; k <= last; k++) {
    const before = at[k - 1]! + 1;
    const after = at[k]!;
    const previous = lines[line]!;
    while (line + 1 < lines.length && lines[line + 1]!.start <= after) line++;
    const next = lines[line]!;
    const leaving = previous.block !== null;
    const entering = next.block !== null;
    if (leaving || entering) {
      const within = leaving && previous.block === next.block;
      const drawn = edges.source.slice(edges.at[k - first - 1]! + 1, edges.at[k - first]!);
      if (!codeGapAgrees(source.slice(before, after), drawn, leaving, entering, within, shift)) {
        return false;
      }
      if (within) continue;
    }
    if (!gapsAgree(reply.gaps[k] ?? null, edges.gaps[k - first] ?? null)) return false;
  }
  return true;
}

/**
 * The span itself: the edges chosen so no emphasis or code span is left half
 * open, and a fenced block the span runs into or out of kept whole.
 */
function spanText(
  reply: Skeleton,
  first: number,
  last: number,
  edges: SelectionEdges
): string | null {
  const { source, at, lines, blocks } = reply;
  const from = at[first]!;
  const to = at[last]! + 1;
  const startLine = lines[lineIndexOf(lines, from)]!;
  const endLine = lines[lineIndexOf(lines, to - 1)]!;
  const floor = first > 0 ? Math.max(at[first - 1]! + 1, startLine.start) : startLine.start;
  const ceiling = last + 1 < at.length ? Math.min(at[last + 1]!, endLine.end) : endLine.end;

  const shift = { value: null as number | null };
  // Code the selection picks up from the start of its row sets the indent shift.
  const head = edges.source.slice(edges.firstLineStart, edges.at[0]!);
  if (startLine.block !== null && floor <= startLine.start && /^\s/u.test(head)) {
    if (!shiftedAlike(source.slice(startLine.start, from), head, shift, false)) return null;
  }
  if (!gapsMatch(reply, first, last, edges, shift)) return null;

  // Partway through a word at either end.
  let before = from;
  while (before > 0 && isHidden(reply, before - 1)) before--;
  if (before > 0 && WORD.test(charAt(source, from)) && WORD.test(charBefore(source, before))) {
    return null;
  }
  let after = to;
  while (after < source.length && isHidden(reply, after)) after++;
  if (
    after < source.length &&
    WORD.test(charBefore(source, to)) &&
    WORD.test(charAt(source, after))
  ) {
    return null;
  }

  const starts = startsOf(reply, startLine, from, floor, edges);
  const ends = endsOf(reply, endLine, to, ceiling, edges);
  if (!starts || !ends) return null;
  const choice = [
    [starts.with, ends.with],
    [starts.without, ends.with],
    [starts.with, ends.without],
    [starts.without, ends.without],
  ].find(([start, end]) => balanced(reply, start!, end!));
  if (!choice) return null;
  let [start, end] = choice as [number, number];

  let opening = "";
  let closing = "";
  const startBlock = startLine.block === null ? null : blocks[startLine.block]!;
  const endBlock = endLine.block === null ? null : blocks[endLine.block]!;
  if (startBlock && startBlock !== endBlock) {
    const fence = lines[startBlock.open]!;
    if (start === lines[startBlock.open + 1]!.start) start = fence.start;
    else opening = `${source.slice(fence.start, fence.end)}\n`;
  }
  if (endBlock && endBlock !== startBlock) {
    const lastCode = endBlock.close === null ? null : lines[endBlock.close - 1]!;
    if (lastCode === endLine && !source.slice(end, endLine.end).trim()) {
      end = lines[endBlock.close!]!.end;
    } else {
      closing = `\n${endBlock.marks}`;
    }
  }

  const text = (opening + source.slice(start, end) + closing).replace(/\s+$/u, "");
  const firstIsFree = start > startLine.start && !opening;
  // Code picked up partway through a line has nothing to measure its indent by.
  if (firstIsFree && startLine.block !== null) return text;
  return dedent(text.replace(/^\s*\n/u, ""), firstIsFree);
}

/**
 * The stretch of `replies` (newest first) that `selection` shows, as the agent
 * wrote it, or null when it can't be placed in exactly one way.
 */
export function findReplySpan(selection: string, replies: readonly string[]): string | null {
  const edges = selectionEdges(selection.replace(/\r\n/g, "\n").replace(/\u00a0/g, " "));
  if (!edges) return null;
  let found: string | null = null;
  let occurrences = 0;
  for (const raw of replies) {
    const reply = skeletonOf(raw.replace(/\r\n/g, "\n"), true);
    for (
      let index = reply.text.indexOf(edges.skeleton);
      index !== -1;
      index = reply.text.indexOf(edges.skeleton, index + 1)
    ) {
      if (++occurrences > MAX_OCCURRENCES) return null;
      const text = spanText(reply, index, index + edges.skeleton.length - 1, edges);
      // Each place it could be must give the same text, a place it can't be
      // included: that may be the one selected, and which can't be known.
      if (text === null || (found !== null && text !== found)) return null;
      found = text;
    }
  }
  return found;
}
