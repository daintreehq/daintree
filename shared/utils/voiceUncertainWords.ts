/**
 * Words the recogniser was unsure of, carried as character spans from the
 * provider's transcript to the cleanup prompt. Each hop keeps positions, never
 * word text, so a repeated word can't hand its flag to another copy of itself,
 * and a span a rewrite reached is dropped rather than guessed at.
 */

/** A span of characters, `from` inclusive and `to` exclusive. */
export interface VoiceTextSpan {
  from: number;
  to: number;
}

/** One recognised word: its text as the transcript writes it and the provider's confidence in it. */
export interface RecognisedWord {
  text: string;
  confidence: number;
}

/** A replacement of `before.slice(from, to)` with `insert`. */
export interface VoiceTextEdit {
  from: number;
  to: number;
  insert: string;
}

const SPACE_RE = /\s/;
const LEADING_PUNCTUATION_RE = /^[\p{Ps}\p{Pi}"'¿¡]+/u;
const TRAILING_PUNCTUATION_RE = /[\p{Pe}\p{Pf}"'.,;:!?…。、，！？：；]+$/u;
// The same split the main process makes a completion's pieces with.
const LINE_SPLIT_RE = /\s*\n\s*/g;

function skipSpaceForward(text: string, at: number): number {
  while (at < text.length && SPACE_RE.test(text[at]!)) at++;
  return at;
}

function skipSpaceBackward(text: string, at: number, floor: number): number {
  while (at > floor && SPACE_RE.test(text[at - 1]!)) at--;
  return at;
}

/**
 * Where each word sits in `text`, or null where it can't be placed for sure.
 * Words are matched in order at the cursor from the start until one doesn't
 * fit, then from the end back towards that run, so a formatter that rewrote
 * words in the middle ("twenty five dollars" written "$25") leaves only those
 * words unplaced. A run of words with no space between them (scripts written
 * without spaces) counts only once it reaches a space or the end, so a word
 * that is only the start of a longer one is never placed. Nothing is searched
 * for, so a word is never matched to another copy of itself.
 */
export function locateWords(text: string, words: readonly string[]): Array<VoiceTextSpan | null> {
  const spans: Array<VoiceTextSpan | null> = words.map(() => null);
  let pending: Array<[number, VoiceTextSpan]> = [];
  let at = skipSpaceForward(text, 0);
  let placedTo = 0;
  let next = 0;
  for (; next < words.length; next++) {
    const word = words[next]!;
    if (!word || !text.startsWith(word, at)) break;
    pending.push([next, { from: at, to: at + word.length }]);
    at += word.length;
    if (at === text.length || SPACE_RE.test(text[at]!)) {
      for (const [index, span] of pending) spans[index] = span;
      pending = [];
      placedTo = at;
      at = skipSpaceForward(text, at);
    }
  }
  if (next === words.length && pending.length === 0) return spans;
  const firstUnplaced = next - pending.length;

  pending = [];
  let end = skipSpaceBackward(text, text.length, placedTo);
  for (let index = words.length - 1; index >= firstUnplaced; index--) {
    const word = words[index]!;
    const from = end - word.length;
    if (!word || from < placedTo || !text.startsWith(word, from)) break;
    pending.push([index, { from, to: end }]);
    end = from;
    if (end === 0 || SPACE_RE.test(text[end - 1]!)) {
      for (const [placed, span] of pending) spans[placed] = span;
      pending = [];
      end = skipSpaceBackward(text, end, placedTo);
    }
  }
  return spans;
}

/** The span with prose punctuation either side left out, or null when nothing else is in it. */
function trimPunctuation(text: string, span: VoiceTextSpan): VoiceTextSpan | null {
  const slice = text.slice(span.from, span.to);
  const lead = LEADING_PUNCTUATION_RE.exec(slice)?.[0].length ?? 0;
  const trail = TRAILING_PUNCTUATION_RE.exec(slice.slice(lead))?.[0].length ?? 0;
  const from = span.from + lead;
  const to = span.to - trail;
  return from < to ? { from, to } : null;
}

/**
 * The spans in `text` of the words recognised with confidence below `below`.
 * A word that can't be placed, or whose confidence isn't a number, isn't
 * flagged. Prose punctuation the transcript attached to a word stays outside
 * its span.
 */
export function flagUncertainWords(
  text: string,
  words: readonly RecognisedWord[],
  below: number
): VoiceTextSpan[] {
  const located = locateWords(
    text,
    words.map((word) => word.text)
  );
  const flagged: VoiceTextSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const span = located[i];
    const { confidence } = words[i]!;
    if (!span || !Number.isFinite(confidence) || confidence >= below) continue;
    const trimmed = trimPunctuation(text, span);
    if (trimmed) flagged.push(trimmed);
  }
  return flagged;
}

/**
 * Carries spans through a rewrite that changes only the end of the text, such
 * as stripping a trailing command: the spans inside what `after` keeps of
 * `before` stay where they are, and the rest are dropped. Only for such
 * rewrites, since two strings alone can't say which copy of a repeated word
 * survived anywhere else.
 */
export function spansInKeptStart(
  before: string,
  after: string,
  spans: readonly VoiceTextSpan[]
): VoiceTextSpan[] {
  const shorter = Math.min(before.length, after.length);
  let kept = 0;
  while (kept < shorter && before.charCodeAt(kept) === after.charCodeAt(kept)) kept++;
  return sliceSpans(spans, 0, kept);
}

/** Moves every span by `delta`. */
export function shiftSpans(spans: readonly VoiceTextSpan[], delta: number): VoiceTextSpan[] {
  return spans.map((span) => ({ from: span.from + delta, to: span.to + delta }));
}

/**
 * Carries spans through known edits, given in order and not overlapping. A
 * span an edit replaced any part of, or inserted into, is dropped; the rest
 * move with the edits before them.
 */
export function carrySpansThroughEdits(
  spans: readonly VoiceTextSpan[],
  edits: readonly VoiceTextEdit[]
): VoiceTextSpan[] {
  if (edits.length === 0) return [...spans];
  return spans.flatMap((span) => {
    let delta = 0;
    for (const edit of edits) {
      if (edit.from >= span.to) break;
      const touches = edit.from === edit.to ? edit.from > span.from : edit.to > span.from;
      if (touches) return [];
      delta += edit.insert.length - (edit.to - edit.from);
    }
    return [{ from: span.from + delta, to: span.to + delta }];
  });
}

/** The spans inside `from`–`to`, relative to `from`. */
export function sliceSpans(
  spans: readonly VoiceTextSpan[],
  from: number,
  to: number
): VoiceTextSpan[] {
  return spans.flatMap((span) =>
    span.from >= from && span.to <= to ? [{ from: span.from - from, to: span.to - from }] : []
  );
}

/**
 * The spans of each piece `text.split(/\s*\n\s*\/)` makes once trimmed,
 * relative to that piece. A span that crosses a line break belongs to no piece.
 */
export function splitSpansByLine(text: string, spans: readonly VoiceTextSpan[]): VoiceTextSpan[][] {
  const pieces: VoiceTextSpan[][] = [];
  const take = (from: number, to: number) => {
    const slice = text.slice(from, to);
    const lead = slice.length - slice.trimStart().length;
    pieces.push(sliceSpans(spans, from + lead, from + slice.trimEnd().length));
  };
  let start = 0;
  for (const match of text.matchAll(LINE_SPLIT_RE)) {
    take(start, match.index);
    start = match.index + match[0].length;
  }
  take(start, text.length);
  return pieces;
}
