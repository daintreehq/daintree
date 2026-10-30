/**
 * Finds the stretch of one of Claude Code's own replies that a terminal
 * selection shows, so a clean copy can hand back what the agent wrote instead
 * of a rebuild of what the TUI drew (#15527).
 *
 * The TUI wraps with real newlines and a hanging indent, hides emphasis and
 * code-span markers, escapes and heading hashes, numbers lists its own way,
 * and draws quote bars, table borders and code blocks without their fences.
 * So both sides are reduced to the characters that survive all of that, each
 * remembering where it sat and what lay between it and the one before: the
 * whitespace, the line breaks, what opened the line, and which markers. A
 * selection matches where its characters run unbroken inside a reply's and
 * every gap agrees. In prose that means space where the reply has space (or a
 * wrap where it has none, for a token the TUI broke), a list item where the
 * reply has one, and every marker the TUI draws there, drawn. In code, which
 * the TUI draws as it is, the gaps must match exactly, wraps aside. The span
 * handed back is that stretch of the reply, widened at each end only over
 * markers the TUI hides.
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
const DELIMITERS = new Set(["*", "_", "~", "`"]);

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
  newlines: number;
  /** Whitespace since the last line break. */
  space: string;
  /** The leading whitespace of the line it ends on, once it has crossed a break. */
  indent: string | null;
  /** Markers and chrome, in order. */
  marks: string;
  /** Per mark, "1" where the TUI draws it. */
  shown: string;
  /** What opens the line it ends on, as {@link ParsedLine} has it. */
  prefix: string;
  marker: boolean;
  quote: boolean;
  /** It lies between two characters of code in the same block. */
  code: boolean;
}

const NO_GAP: Gap = {
  newlines: 0,
  space: "",
  indent: null,
  marks: "",
  shown: "",
  prefix: "",
  marker: false,
  quote: false,
  code: false,
};

interface Skeleton {
  source: string;
  text: string;
  /** Where each UTF-16 unit of `text` sits in the original. */
  at: number[];
  /** Per UTF-16 unit of `text`, the gap before it; null when there is none. */
  gaps: (Gap | null)[];
  /** Per offset of the original, 1 where a marker is drawn as it is. Only a reply's is filled in. */
  shown: Uint8Array;
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

/**
 * Which of a prose line's markers the TUI draws: the contents of a code span,
 * an escaped character, a hash past a heading's, a pipe outside a table, and
 * any backtick, star, underscore or tilde run with nothing to pair with. The
 * pairs, the escapes' backslashes and the heading's hashes it hides.
 */
function markProse(text: string, line: ParsedLine, shown: Uint8Array): void {
  const { contentStart: from, end } = line;
  const content = text.slice(from, end);
  const headingEnd = from + (HEADING.exec(content)?.[0].length ?? 0);
  const table = content.startsWith("|");
  const runOf = (index: number) => {
    let next = index;
    while (next < end && text[next] === text[index]) next++;
    return next - index;
  };
  const openers: { ch: string; at: number; length: number }[] = [];
  for (let i = from; i < end;) {
    const ch = text[i]!;
    if (ch === "`") {
      const length = runOf(i);
      let close = -1;
      for (let j = i + length; j < end;) {
        const run = text[j] === "`" ? runOf(j) : 1;
        if (run === length && text[j] === "`") {
          close = j;
          break;
        }
        j += run;
      }
      if (close === -1) {
        shown.fill(1, i, i + length);
        i += length;
      } else {
        shown.fill(1, i + length, close);
        i = close + length;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < end && ESCAPABLE.test(text[i + 1]!)) {
        shown[i + 1] = 1;
        i += 2;
      } else {
        shown[i] = 1;
        i++;
      }
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const length = runOf(i);
      const before = i > from ? charBefore(text, i) : " ";
      const after = i + length < end ? charAt(text, i + length) : " ";
      const intraword = ch === "_" && WORD.test(before) && WORD.test(after);
      let partner = -1;
      if (!intraword && !isWhitespace(before)) {
        for (let k = openers.length - 1; k >= 0 && partner === -1; k--) {
          if (openers[k]!.ch === ch) partner = k;
        }
      }
      if (partner !== -1) {
        // Openers left inside the pair never closed, so they're drawn.
        for (const left of openers.splice(partner).slice(1)) {
          shown.fill(1, left.at, left.at + left.length);
        }
      } else if (!intraword && !isWhitespace(after)) {
        openers.push({ ch, at: i, length });
      } else {
        shown.fill(1, i, i + length);
      }
      i += length;
      continue;
    }
    if (ch === "#") shown[i] = i >= headingEnd ? 1 : 0;
    else if (ch === "|") shown[i] = table ? 0 : 1;
    else if (isChrome(ch)) shown[i] = 1;
    i++;
  }
  for (const left of openers) shown.fill(1, left.at, left.at + left.length);
}

/**
 * A reply's skeleton (`reply`), with its fences found and what the TUI draws
 * of each marker worked out, or a selection's, which has neither.
 */
function skeletonOf(text: string, reply: boolean): Skeleton {
  const lines: ParsedLine[] = [];
  const blocks: Block[] = [];
  let chars = "";
  const at: number[] = [];
  const gaps: (Gap | null)[] = [];
  const shown = new Uint8Array(reply ? text.length : 0);
  let gap: Gap | null = null;
  const pending = (): Gap => (gap ??= { ...NO_GAP });
  let open: Block | null = null;
  let lastBlock: number | null = null;
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
    if (lines.length > 0) {
      const next = pending();
      next.newlines++;
      next.space = "";
      Object.assign(next, { indent: null, prefix: "", marker: false, quote: false });
    }
    lines.push(line);
    const code = line.block !== null;
    if (line.fence) {
      start = end + 1;
      continue;
    }
    if (isRule(raw)) {
      for (let i = start; i < end; i++) {
        if (isWhitespace(text[i]!)) continue;
        const next = pending();
        next.marks += text[i];
        next.shown += code ? "1" : "0";
        if (reply && code) shown[i] = 1;
      }
      start = end + 1;
      continue;
    }
    if (reply) {
      if (code) shown.fill(1, line.contentStart, end);
      else markProse(text, line, shown);
    }
    Object.assign(pending(), {
      indent: /^\s*/u.exec(raw)![0],
      prefix: line.prefix,
      marker: line.marker !== null,
      quote: line.quote,
    });
    for (let i = line.contentStart; i < end;) {
      const ch = charAt(text, i);
      if (isWhitespace(ch)) {
        pending().space += ch;
      } else if (isDropped(ch)) {
        const next = pending();
        next.marks += ch;
        next.shown += shown[i] ? "1" : "0";
      } else {
        if (code && lastBlock === line.block) pending().code = true;
        chars += ch;
        for (let unit = 0; unit < ch.length; unit++) {
          at.push(i + unit);
          gaps.push(unit === 0 ? gap : null);
        }
        gap = null;
        lastBlock = line.block;
      }
      i += ch.length;
    }
    start = end + 1;
  }
  return { source: text, text: chars, at, gaps, shown, lines, blocks };
}

/**
 * Whether the selection's gap is one the TUI could have drawn for the reply's.
 * In code: the same whitespace, line breaks, line openers and marks, with the
 * indent shifted by the same amount throughout (`shift`), and a wrap allowed
 * where the reply has no break. In prose: space for space, a wrap for nothing
 * (a token broken at the margin), a list item for a list item, and each marker
 * the TUI draws present, with only its own chrome extra.
 */
function gapsAgree(
  reply: Gap | null,
  selected: Gap | null,
  shift: { value: number | null }
): boolean {
  const r = reply ?? NO_GAP;
  const s = selected ?? NO_GAP;
  if (r.code) {
    if (r.newlines === 0 && s.newlines === 0) {
      // A tab is drawn as however many spaces reach the next stop.
      if (r.space.includes("\t") ? !s.space : s.space !== r.space) return false;
    } else if (r.newlines === 0) {
      if (s.prefix) return false;
    } else {
      if (s.newlines !== r.newlines || s.prefix !== r.prefix) return false;
      if (r.indent !== null && s.indent !== null && !r.indent.includes("\t")) {
        const delta = s.indent.length - r.indent.length;
        if (shift.value === null) shift.value = delta;
        else if (shift.value !== delta) return false;
      }
    }
    return s.marks === r.marks;
  }

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
  /** That line's quote marks and list marker, as {@link ParsedLine} has them. */
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
  const lastEnd = lastAt + charAt(selection, lastAt).length;
  return {
    skeleton: parsed.text,
    gaps: parsed.gaps,
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

/** Whether every emphasis, strike and code span the TUI hid the markers of on `line` between `from` and `to` closes there. */
function balanced(reply: Skeleton, line: ParsedLine, from: number, to: number): boolean {
  // Runs, not characters: `**` is one delimiter.
  const counts = new Map<string, number>();
  for (let i = Math.max(from, line.contentStart); i < to; i++) {
    const ch = reply.source.charAt(i);
    if (!DELIMITERS.has(ch) || reply.shown[i] !== 0) continue;
    if (i > from && reply.source.charAt(i - 1) === ch && reply.shown[i - 1] === 0) continue;
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  return [...counts.values()].every((count) => count % 2 === 0);
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
  if ((edges.marker || edges.quote) && !atContentStart) return null;
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
    const lineStart = edges.marker || line.marker === null ? line.start : line.contentStart;
    return { with: lineStart, without: edges.marker ? lineStart : start };
  }
  if (edges.marker) return null;
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

/**
 * The span itself: the edges chosen so no emphasis or code span is left half
 * open on a line of prose the selection only partly covers, and a fenced block
 * the span runs into or out of kept whole.
 */
function spanText(
  reply: Skeleton,
  first: number,
  last: number,
  edges: SelectionEdges
): string | null {
  const { source, at, lines, blocks } = reply;
  const shift = { value: null as number | null };
  for (let k = first + 1; k <= last; k++) {
    if (!gapsAgree(reply.gaps[k] ?? null, edges.gaps[k - first] ?? null, shift)) return null;
  }
  const from = at[first]!;
  const to = at[last]! + 1;
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

  const startLine = lines[lineIndexOf(lines, from)]!;
  const endLine = lines[lineIndexOf(lines, to - 1)]!;
  const floor = first > 0 ? Math.max(at[first - 1]! + 1, startLine.start) : startLine.start;
  const ceiling = last + 1 < at.length ? Math.min(at[last + 1]!, endLine.end) : endLine.end;
  const starts = startsOf(reply, startLine, from, floor, edges);
  const ends = endsOf(reply, endLine, to, ceiling, edges);
  if (!starts || !ends) return null;

  const proseEdges = (start: number, end: number) => {
    const head = startLine.block === null;
    const tail = endLine.block === null;
    if (startLine === endLine) return !head || balanced(reply, startLine, start, end);
    return (
      (!head || balanced(reply, startLine, start, startLine.end)) &&
      (!tail || balanced(reply, endLine, endLine.start, end))
    );
  };
  const choice = [
    [starts.with, ends.with],
    [starts.without, ends.with],
    [starts.with, ends.without],
    [starts.without, ends.without],
  ].find(([start, end]) => proseEdges(start!, end!));
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
  const firstIsFree = start > startLine.start && !head;
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
