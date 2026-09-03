import { shouldSuppressEdits } from "./diffEditSuppression";

/**
 * Intra-block change marking for the rendered Markdown diff.
 *
 * A flat word LCS over a whole paragraph is the wrong instrument for prose. It
 * anchors on stop words, so a rewritten sentence and its replacement latch onto
 * each other's "the", "a" and "of" and the marks come back as confetti; and once
 * the marks cover enough of the block, the coverage rule that saves the source
 * line diff throws all of them away and leaves two undifferentiated walls of
 * text. That rule is right for code — a line that changed 60% of its characters
 * IS a different line — and wrong for prose, where a paragraph that kept two
 * thirds of its clauses is exactly the case a reader most needs marks for.
 *
 * So this aligns SENTENCES first and only word-diffs inside an aligned pair,
 * which is what the prose-diff engines do (Draftable, Litera, Pandiff, and the
 * scholarly collation tools). Three consequences that matter:
 *
 *   - A sentence that survived intact is never marked, whatever happened around
 *     it. A sentence that was inserted is marked whole, once, rather than word
 *     by word against an unrelated neighbour.
 *   - Word marks are scoped to a sentence pair the reader can already see is
 *     related, so a stop-word match cannot reach across a paragraph.
 *   - Coverage is judged per sentence, and a sentence that lost the argument
 *     collapses to ONE mark covering itself rather than to nothing. The reader
 *     still learns which sentence changed, which is the whole question.
 */

/** Half-open character range into a block's visible text. */
export interface TextRange {
  start: number;
  end: number;
}

export interface InlineRanges {
  /** Ranges deleted from the old block. */
  old: readonly TextRange[];
  /** Ranges inserted into the new block. */
  new: readonly TextRange[];
}

export const NO_RANGES: InlineRanges = { old: [], new: [] };

/**
 * Per-side token ceiling. Unchanged from the flat implementation: it bounds one
 * word matrix at roughly 16MB, and sentence alignment only ever makes the
 * matrices smaller.
 */
export const MAX_INLINE_TOKENS = 2000;

/**
 * Similarity two sentences must reach to align as a pair rather than stand as a
 * separate deletion and insertion.
 *
 * Lower than the block threshold on purpose. Two blocks that fail to pair render
 * as two full slabs, so a false pair there is expensive; two sentences that fail
 * to pair just lose their finer marks inside a block the reader is already
 * looking at, so the cost of a miss runs the other way.
 */
export const SENTENCE_PAIR_THRESHOLD = 0.3;

/**
 * The longest unchanged run that may be swallowed into a mark spanning it.
 *
 * `diff_cleanupSemantic`'s island rule is purely relative — an equality shorter
 * than both of its neighbouring edits is coincidence rather than meaning, so it
 * gets absorbed. This keeps that rule and adds a ceiling, because the relative
 * test alone will happily swallow a whole clause when it sits between two long
 * rewrites, and a mark that covers text nobody touched is a lie the reader can
 * catch.
 *
 * Twenty-four characters is about four short words: enough to absorb the
 * "working" and "was" that survive a rewritten sentence and were cutting one
 * legible mark into five, and short enough that anything a reader would think
 * of as a surviving phrase stays out of the mark.
 */
export const ISLAND_MAX_CHARS = 24;

/**
 * How many times the island pass may run. Each pass can only shrink the mark
 * count, so it terminates on its own; the bound is here so a future change to
 * `absorbs` cannot turn a fixed-point loop into a hang inside a render.
 */
const MAX_ISLAND_PASSES = 8;

export interface InlineCellBudget {
  remaining: number;
}

const WORD_TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  return text.match(WORD_TOKEN_RE) ?? [];
}

/**
 * Sentence boundaries in a block's visible text.
 *
 * Two kinds, and the second is not optional. A newline is a boundary because
 * hard breaks and fenced content are already visible divisions. And a terminator
 * followed *immediately* by a capital with no space is a boundary too: a list's
 * flattened text concatenates its items with no separator at all, so without
 * this rule `"…not a wrapper.The state you see…"` is one 240-character
 * "sentence" and every list in the document aligns as a single blob.
 *
 * Deliberately conservative about full stops. A terminator followed by a space
 * and a LOWER-case letter is left alone, which keeps `e.g.`, `i.e.`, `vs.` and
 * `Mr. smith` intact at the cost of occasionally under-segmenting. Under-
 * segmenting degrades to today's behaviour for that one sentence; over-
 * segmenting invents alignments that were never there.
 */
export function sentenceRanges(text: string, structural: readonly number[] = []): TextRange[] {
  const ranges: TextRange[] = [];
  const forced = new Set(structural);
  let start = 0;
  const push = (end: number): void => {
    if (end > start) ranges.push({ start, end });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    // A structural boundary is not a judgment call. A table cell's contents
    // cannot be a continuation of the previous cell's sentence, whatever the
    // punctuation happens to say.
    if (i > 0 && forced.has(i)) push(i);
    const char = text[i]!;
    if (char === "\n") {
      push(i + 1);
      continue;
    }
    if (!".!?…".includes(char)) continue;
    // Consume a run of terminators plus any closing punctuation that belongs to
    // the sentence being closed, so `?!"` and `.)` end where the reader thinks.
    let cursor = i + 1;
    while (cursor < text.length && ".!?…".includes(text[cursor]!)) cursor++;
    while (cursor < text.length && `"'’”)]`.includes(text[cursor]!)) cursor++;
    const next = text[cursor];
    if (next === undefined) break;
    if (next === " " || next === "\t") {
      // A space then a capital, a digit or an opening quote starts a new
      // sentence; a space then a lower-case letter is an abbreviation.
      const after = text[cursor + 1];
      if (after !== undefined && !/[\p{Ll}]/u.test(after)) {
        push(cursor + 1);
        i = cursor;
      }
      continue;
    }
    // No space at all. Only a capital counts here — `3.5` and `v1.2` must not
    // split, and neither must a bare `.` inside a path or a version.
    if (/[\p{Lu}]/u.test(next)) {
      push(cursor);
      i = cursor - 1;
    }
  }
  push(text.length);
  return ranges;
}

/** The range's text with surrounding whitespace removed, and its new bounds. */
function trimRange(text: string, range: TextRange): TextRange {
  let { start, end } = range;
  while (start < end && !/\S/.test(text[start]!)) start++;
  while (end > start && !/\S/.test(text[end - 1]!)) end--;
  return { start, end };
}

/** Indices of a longest common subsequence, by exact equality. */
function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[]
): Array<[number, number]> {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        left[i] === right[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/** Multiset overlap of lower-cased tokens, in [0, 1]. */
function sentenceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const bag = new Map<string, number>();
  let aCount = 0;
  for (const token of tokenize(a)) {
    if (!/\S/.test(token)) continue;
    const key = token.toLowerCase();
    bag.set(key, (bag.get(key) ?? 0) + 1);
    aCount++;
  }
  let bCount = 0;
  let overlap = 0;
  for (const token of tokenize(b)) {
    if (!/\S/.test(token)) continue;
    const key = token.toLowerCase();
    bCount++;
    const available = bag.get(key) ?? 0;
    if (available > 0) {
      bag.set(key, available - 1);
      overlap++;
    }
  }
  if (!aCount || !bCount) return 0;
  return (2 * overlap) / (aCount + bCount);
}

/**
 * Turn a stream of per-token marks into the smallest set of spans that still
 * tells the truth.
 *
 * Two passes, and the order is the whole trick. The word LCS emits one mark per
 * unmatched token, so `"aaaa bbbb cccc"` arrives as three marks with the spaces
 * between them unmatched. Applying the island rule to that stream compares each
 * island against the single token next to it rather than against the run it
 * belongs to, and the rule never fires — which is exactly the bug this replaced.
 *
 *   1. Coalesce. Marks separated by nothing but whitespace are one mark; that is
 *      a rendering fact, not a judgment. This is what produces runs whose
 *      lengths mean something.
 *   2. Absorb islands, repeatedly. `diff_cleanupSemantic`'s rule: an unchanged
 *      run shorter than both of the runs either side of it is coincidence rather
 *      than meaning, so it joins them. Repeated to a fixed point because
 *      absorbing one island lengthens a run, which can qualify it to absorb the
 *      next — and a single pass would leave that half-done and order-dependent.
 */
function cleanupRanges(
  text: string,
  ranges: readonly TextRange[],
  structural: readonly number[] = []
): TextRange[] {
  const forced = new Set(structural);
  const coalesced: TextRange[] = [];
  for (const range of ranges) {
    // A range that trims away to nothing was a whitespace-only edit, and it
    // keeps its untrimmed bounds: the mark is the only visible signal an
    // indentation or spacing change has, which is why the line diff exempts
    // whitespace edits from suppression too.
    const inner = trimRange(text, range);
    const next = inner.end > inner.start ? inner : range;
    if (next.end <= next.start) continue;
    const previous = coalesced[coalesced.length - 1];
    if (previous && next.start <= previous.end) {
      previous.end = Math.max(previous.end, next.end);
      continue;
    }
    // Adjacent words, separated only by the space between them — unless a
    // structural boundary falls between, where there is no space to speak of.
    const spans = (from: number, to: number): boolean => {
      for (let offset = from + 1; offset <= to; offset++) if (forced.has(offset)) return true;
      return false;
    };
    if (
      previous &&
      !/\S/.test(text.slice(previous.end, next.start)) &&
      !spans(previous.end, next.start)
    ) {
      previous.end = next.end;
      continue;
    }
    coalesced.push({ ...next });
  }

  let current = coalesced;
  for (let pass = 0; pass < MAX_ISLAND_PASSES; pass++) {
    const merged: TextRange[] = [];
    let changed = false;
    for (const range of current) {
      const previous = merged[merged.length - 1];
      if (previous && absorbs(text, previous, range, forced)) {
        previous.end = range.end;
        changed = true;
        continue;
      }
      merged.push({ ...range });
    }
    current = merged;
    if (!changed) break;
  }
  return current;
}

/** Whether the unchanged run between two marks is coincidence rather than meaning. */
function absorbs(
  text: string,
  previous: TextRange,
  next: TextRange,
  forced: ReadonlySet<number>
): boolean {
  const island = text.slice(previous.end, next.start).trim();
  // A line break is a structural boundary — a list item, a hard break — and a
  // mark spanning one claims a correspondence across two separate things.
  if (text.slice(previous.end, next.start).includes("\n")) return false;
  // So is a cell or item boundary, which carries no character at all.
  for (let offset = previous.end + 1; offset <= next.start; offset++) {
    if (forced.has(offset)) return false;
  }
  if (island.length > ISLAND_MAX_CHARS) return false;
  return island.length < Math.min(previous.end - previous.start, next.end - next.start);
}

/** Word-level marks for one aligned sentence pair, as absolute offsets. */
function wordRangesFor(
  oldText: string,
  newText: string,
  oldOffset: number,
  newOffset: number,
  budget: InlineCellBudget | undefined,
  into: { old: TextRange[]; new: TextRange[] }
): void {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const cells = (oldTokens.length + 1) * (newTokens.length + 1);
  // Out of budget: the sentence still reports as changed, whole, which is the
  // finer emphasis degrading rather than the change disappearing.
  if (budget && cells > budget.remaining) {
    into.old.push({ start: oldOffset, end: oldOffset + oldText.length });
    into.new.push({ start: newOffset, end: newOffset + newText.length });
    return;
  }
  if (budget) budget.remaining -= cells;

  const matches = longestCommonSubsequence(oldTokens, newTokens);
  const oldMatched = new Set(matches.map(([index]) => index));
  const newMatched = new Set(matches.map(([, index]) => index));

  const collect = (
    tokens: readonly string[],
    matched: ReadonlySet<number>,
    offset: number
  ): TextRange[] => {
    const ranges: TextRange[] = [];
    let cursor = 0;
    let runStart: number | null = null;
    tokens.forEach((token, index) => {
      if (matched.has(index)) {
        if (runStart !== null) {
          ranges.push({ start: offset + runStart, end: offset + cursor });
          runStart = null;
        }
      } else if (runStart === null) {
        runStart = cursor;
      }
      cursor += token.length;
    });
    if (runStart !== null) ranges.push({ start: offset + runStart, end: offset + cursor });
    return ranges;
  };

  const oldRanges = collect(oldTokens, oldMatched, oldOffset);
  const newRanges = collect(newTokens, newMatched, newOffset);

  /**
   * The coverage rule, moved down a level and given somewhere to land.
   *
   * At the block level, exceeding it meant "show nothing", which is how a
   * rewritten paragraph became two walls of text. At the sentence level it
   * means "this sentence was rewritten, say so once" — the marks stop claiming
   * a word-by-word correspondence they no longer have, and the reader still
   * gets the sentence located for them.
   */
  const collapse = (
    sentence: string,
    offset: number,
    ranges: readonly TextRange[]
  ): TextRange[] => {
    let edited = 0;
    let editedText = "";
    for (const range of ranges) {
      edited += range.end - range.start;
      editedText += sentence.slice(range.start - offset, range.end - offset);
    }
    if (!shouldSuppressEdits(sentence.length, edited, editedText)) return [...ranges];
    return [{ start: offset, end: offset + sentence.length }];
  };

  into.old.push(...collapse(oldText, oldOffset, oldRanges));
  into.new.push(...collapse(newText, newOffset, newRanges));
}

/**
 * Marks for one modified block pair.
 *
 * Returns {@link NO_RANGES} when every sentence on a side is marked, because a
 * side marked end to end says exactly what the block's own fill already said,
 * at the cost of painting it twice.
 */
export interface InlineSide {
  /** The block's visible text. */
  text: string;
  /** Offsets where a structural child begins — see `sentenceRanges`. */
  segments?: readonly number[];
}

export function inlineChangeRanges(
  oldSide: InlineSide,
  newSide: InlineSide,
  budget?: InlineCellBudget
): InlineRanges {
  const oldText = oldSide.text;
  const newText = newSide.text;
  if (!oldText || !newText) return NO_RANGES;
  if (tokenize(oldText).length > MAX_INLINE_TOKENS) return NO_RANGES;
  if (tokenize(newText).length > MAX_INLINE_TOKENS) return NO_RANGES;

  const oldSentences = sentenceRanges(oldText, oldSide.segments);
  const newSentences = sentenceRanges(newText, newSide.segments);
  const oldKeys = oldSentences.map((range) => oldText.slice(range.start, range.end).trim());
  const newKeys = newSentences.map((range) => newText.slice(range.start, range.end).trim());

  const anchors = longestCommonSubsequence(oldKeys, newKeys);
  const collected = { old: [] as TextRange[], new: [] as TextRange[] };

  /**
   * Align the sentences between two identical anchors, then mark what is left.
   *
   * Greedy forward pairing rather than a second score-maximizing matrix: inside
   * one gap the candidates are few and already in reading order, and a sentence
   * pairs with the next unclaimed candidate that clears the threshold. A
   * crossing pair (the third sentence rewritten into the first) reads as one
   * deletion plus one insertion, which is the honest answer — it is what
   * happened.
   */
  const alignGap = (oldFrom: number, oldTo: number, newFrom: number, newTo: number): void => {
    let newCursor = newFrom;
    for (let i = oldFrom; i < oldTo; i++) {
      const oldRange = oldSentences[i]!;
      const oldSentence = oldText.slice(oldRange.start, oldRange.end);
      let bestIndex = -1;
      let bestScore = SENTENCE_PAIR_THRESHOLD;
      for (let j = newCursor; j < newTo; j++) {
        const newRange = newSentences[j]!;
        const score = sentenceSimilarity(oldSentence, newText.slice(newRange.start, newRange.end));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = j;
        }
      }
      if (bestIndex === -1) {
        collected.old.push({ ...oldRange });
        continue;
      }
      // Everything skipped over to reach the match is an insertion.
      for (let j = newCursor; j < bestIndex; j++) collected.new.push({ ...newSentences[j]! });
      const newRange = newSentences[bestIndex]!;
      wordRangesFor(
        oldSentence,
        newText.slice(newRange.start, newRange.end),
        oldRange.start,
        newRange.start,
        budget,
        collected
      );
      newCursor = bestIndex + 1;
    }
    for (let j = newCursor; j < newTo; j++) collected.new.push({ ...newSentences[j]! });
  };

  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldIndex, newIndex] of anchors) {
    alignGap(oldCursor, oldIndex, newCursor, newIndex);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  alignGap(oldCursor, oldSentences.length, newCursor, newSentences.length);

  const oldRanges = cleanupRanges(oldText, collected.old, oldSide.segments);
  const newRanges = cleanupRanges(newText, collected.new, newSide.segments);

  const covers = (text: string, ranges: readonly TextRange[]): boolean => {
    const marked = ranges.reduce((total, range) => total + (range.end - range.start), 0);
    return marked >= text.trim().length;
  };
  if (covers(oldText, oldRanges) && covers(newText, newRanges)) return NO_RANGES;

  return { old: oldRanges, new: newRanges };
}
