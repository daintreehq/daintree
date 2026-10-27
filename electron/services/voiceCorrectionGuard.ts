import {
  findProtectedRanges,
  scanProtectedSpans,
  type ProtectedRange,
  type ProtectedSpan,
} from "../../shared/utils/voiceProtectedSpans.js";

/**
 * Deterministic checks that an AI cleanup kept the meaning of the dictated
 * text. Correction is a polish pass: a leftover mishearing is recoverable, a
 * changed path, flag, number or "don't" is not, so anything these checks
 * can't vouch for falls back to the raw text. They are structural, not a
 * semantic proof: a one-word swap like "keep" to "delete" still gets through,
 * and negations are only recognised in English.
 *
 * Two edits may drop more words than the budget allows, each only where the
 * raw text shows why: the words just before an explicit self-correction
 * ("use the old API, no wait, the new one"), and the counting words of a
 * spoken list the cleanup laid out as one. Neither may drop a negation, a
 * number or a protected span.
 */

export type CorrectionRejectReason = "protected_span" | "number" | "negation" | "edit_size";

export type CorrectionGuardResult = { ok: true } | { ok: false; reason: CorrectionRejectReason };

const NUMBER_RE = /(?<![\p{L}\p{N}_])[-+]?\p{Nd}+(?:[.,:/-]\p{Nd}+)*%?/gu;
const DIGIT_RUN_RE = /\p{Nd}+/gu;
const HAN_NUMERAL_RE = /[零〇一二三四五六七八九十百千万亿两]/gu;
const NUMBER_WORDS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
]);

const NEGATION_WORDS = new Set([
  "not",
  "no",
  "never",
  "nothing",
  "none",
  "nobody",
  "nowhere",
  "neither",
  "nor",
  "without",
  "nope",
]);
// "can't", "cannot", "can not" and "dont" all negate the same way, so a
// cleanup that only changes the contraction keeps the meaning.
const NOT_FORMS = new Set([
  "cannot",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "cant",
  "couldnt",
  "wont",
  "wouldnt",
  "shouldnt",
  "hasnt",
  "havent",
  "hadnt",
  "mustnt",
  "neednt",
  "aint",
]);
const CONTRACTED_NOT_RE = /n['’]t$/u;
const APOSTROPHE_RE = /['’]/gu;

// Words a cleanup is expected to drop, left out of every word comparison:
// filler, and the spoken formatting commands it turns into line breaks.
const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mm"]);
const SOFT_FILLERS = new Set(["like", "so", "basically", "actually", "literally", "well"]);
const DROPPED_PAIRS = new Set([
  "you know",
  "i mean",
  "new paragraph",
  "next paragraph",
  "new line",
  "next line",
  "line break",
]);

/**
 * How many words a cleanup may drop and add, filler aside: a share of the
 * passage, with a floor for short ones. Answers and rewrites add words;
 * summaries drop them.
 */
export interface CorrectionGuardLimits {
  readonly removedRatio: number;
  readonly addedRatio: number;
  readonly minRemoved: number;
  readonly minAdded: number;
  /**
   * What else a cleanup that resolved a self-correction or laid out a list
   * may drop besides the words those allowances cover: a stutter, not a clause.
   */
  readonly minAllowanceRemoved: number;
  /**
   * Whether a symbol typed for its spoken name ("origin slash develop" as
   * origin/develop, "project underscore id" as project_id) stands for the
   * word it replaces rather than counting as an edit, and a flag the speaker
   * spelled out ("dash dash watch" as --watch) may appear.
   */
  readonly spokenSymbols: boolean;
}

// Cleanup removes filler and merges misheard phrases into one term, so it may
// drop more words than it adds. Set on the cleanup benchmark (#14786): spoken
// symbols, not the budget, were what held back cleanups that kept the meaning,
// and a wider budget let a dropped clause through.
export const CORRECTION_GUARD_LIMITS: CorrectionGuardLimits = {
  removedRatio: 0.15,
  addedRatio: 0.15,
  minRemoved: 4,
  minAdded: 2,
  minAllowanceRemoved: 2,
  spokenSymbols: true,
};

// The symbols a speaker names aloud in paths, flags and identifiers. A dot or
// colon counts as typed only inside a word, so a sentence's own full stop or
// colon never stands for a spoken one.
const SPOKEN_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["slash", "/"],
  ["backslash", "\\"],
  ["dot", "."],
  ["colon", ":"],
  ["underscore", "_"],
  ["dash", "-"],
  ["hyphen", "-"],
]);
// The symbols a spoken name can be typed as.
const TYPED_SYMBOLS = new Set(SPOKEN_SYMBOLS.values());
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
// "dash dash watch" is --watch, "dash dash no dash verify" is --no-verify,
// and "dash v" is -v: a single dash takes a single letter. A doubled dash
// starts the next flag ("dash dash watch dash dash verbose").
const SPOKEN_FLAG_RE =
  /(?<![\p{L}\p{N}])(?:dash|hyphen)\s+(?:(?<long>dash|hyphen)\s+)?(?<name>(?!(?:dash|hyphen)\b)\p{L}[\p{L}\p{N}]*(?:\s+(?:dash|hyphen)\s+(?!(?:dash|hyphen)\b)[\p{L}\p{N}]+)*)/giu;
// What joins the parts of a typed identifier, path or filename into one word.
const IDENTIFIER_JOIN_RE = /[._:]+/u;

// Phrases a speaker uses to take back what they just said. "no wait" and
// "scratch that" are set off by punctuation on both sides, so "there is no wait,"
// and "a scratch that button" stay ordinary words, and a bare "no" or "sorry"
// counts only between commas, where it can't be an answer. The bounded
// whitespace keeps the lookarounds linear.
const RETRACTION_RE =
  /(?<=^|[,;:.!?—–\n]\s{0,3})\b(?:no,?\s+wait|wait,?\s+no|scratch\s+that|strike\s+that)\b(?=\s{0,3}(?:[,.;:!?—–]|$))|\b(?:or\s+rather|i\s+mean)\b|(?<=,\s{0,3})\b(?:no|sorry)\b(?=\s{0,3},)/giu;
// "Scratch that." on its own takes back the whole sentence before it.
const SENTENCE_RETRACTION_RE = /^(?:scratch|strike)\s+that$/iu;
// A mid-sentence correction reaches back no further than its own clause, and
// starts at the last copy of the replacement's first word ("the old API, no
// wait, the new one"). Without one it covers as many words as the
// replacement, and no more than three.
const RETRACTION_WORD_LIMIT = 12;
const RETRACTION_FALLBACK_WORDS = 3;
// How much of the replacement has to survive to show the correction was made.
const REPLACEMENT_WORDS = 3;
const SENTENCE_BREAK_RE = /[.!?\n。！？][\s.!?。！？]*/gu;
const CLAUSE_BREAK_RE = /[,;:.!?\n—–，、；：。！？][\s,;:.!?—–，、；：。！？]*/gu;

const ORDINAL_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];
const CARDINAL_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
// A spoken item number that opens a clause: "First,", "and third,", "step
// two", "one," or "3)". It needs its own punctuation or a step/number prefix,
// so "first failures" and "one retry" stay words, and a digit inside a longer
// number ("1.5", "9.1") is part of that number, not an item.
const ENUMERATOR_RE = new RegExp(
  String.raw`(?<=^|[.!?;:,\n]\s{0,8})(?<!\p{Nd}[.,:])(?:and\s+)?(?:then\s+)?(?<prefix>(?:number|step|item)\s+)?(?<word>(?:${ORDINAL_WORDS.join("|")})(?:ly)?|${CARDINAL_WORDS.join("|")}|\d{1,2}|next|then|finally|lastly)(?<after>\s{0,3}[,.:;)](?!\p{Nd})|\s+(?=\p{L}))`,
  "giu"
);
const LIST_MARKER_RE = /^([ \t]*)(?:(\d{1,2})[.)]|[-*•])(?=[ \t])/gm;
// Aligning two passages costs their lengths multiplied; past this the
// allowances are skipped and the plain checks decide.
const MAX_ALIGNMENT_CELLS = 250_000;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let found = 0;
  for (const value of haystack) {
    if (found < needle.length && value === needle[found]) found++;
  }
  return found === needle.length;
}

interface SpelledFlag extends Range {
  /** The flag as it's typed, lowercase. */
  flag: string;
}

/** Where `raw` spells a flag out word by word, outside any code, reference, URL or path. */
function spelledFlags(raw: string, protectedRanges: readonly Range[]): SpelledFlag[] {
  return Array.from(raw.matchAll(SPOKEN_FLAG_RE), (match): SpelledFlag | null => {
    const { long, name } = match.groups!;
    const parts = name.split(/\s+(?:dash|hyphen)\s+/iu);
    if (!long && (parts.length > 1 || parts[0].length > 1)) return null;
    const range = { start: match.index, end: match.index + match[0].length };
    if (overlaps(protectedRanges, range)) return null;
    return { ...range, flag: `${long ? "--" : "-"}${parts.join("-")}`.toLowerCase() };
  }).filter((spelled) => spelled !== null);
}

interface ExpectedSpan {
  text: string;
  /** Where a spelled-out flag was spoken; it may be typed or left as words. */
  spelled?: Range;
}

/**
 * Whether `typed` holds every required span of `expected` in order, with each
 * spelled-out flag present or not where it falls among them. A typed flag
 * stands for a spelled one only if `holds` says it was typed in its place.
 */
function sameWithOptional(
  expected: readonly ExpectedSpan[],
  typed: readonly ProtectedSpan[],
  holds: (spelled: Range, typed: Range) => boolean
): boolean {
  const matches = (entry: ExpectedSpan, span: ProtectedSpan) =>
    entry.spelled
      ? entry.text === span.text.toLowerCase() && holds(entry.spelled, span)
      : entry.text === span.text;
  const memo = new Map<number, boolean>();
  const from = (i: number, j: number): boolean => {
    if (j === typed.length) return expected.slice(i).every((entry) => entry.spelled);
    if (i === expected.length) return false;
    const key = i * (typed.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result =
      (matches(expected[i], typed[j]) && from(i + 1, j + 1)) ||
      (expected[i].spelled !== undefined && from(i + 1, j));
    memo.set(key, result);
    return result;
  };
  return from(0, 0);
}

/**
 * Code, references, URLs and flags come back exactly, in order, and none are
 * invented, except a flag the speaker spelled out, typed where they said it,
 * when `spoken` places the words. Paths and filenames come back exactly, in
 * order, but new ones may appear, because fixing "next jess" to "Next.js" is
 * the point of cleanup.
 */
function keepsProtectedSpans(
  raw: string,
  corrected: string,
  spoken: SpokenSymbols | null
): boolean {
  const rawSpans = scanProtectedSpans(raw);
  const correctedSpans = scanProtectedSpans(corrected);
  const texts = (spans: ProtectedSpan[], strict: boolean) =>
    spans.filter((span) => (span.kind !== "path") === strict).map((span) => span.text);
  if (!isSubsequence(texts(rawSpans, false), texts(correctedSpans, false))) return false;
  const spelled = spoken ? spelledFlags(raw, findProtectedRanges(raw)) : [];
  // Past the alignment limit a spelled flag stays words, as the word checks do.
  if (
    spelled.length === 0 ||
    (rawSpans.length + spelled.length + 1) * (correctedSpans.length + 1) > MAX_ALIGNMENT_CELLS
  ) {
    return sameSequence(texts(rawSpans, true), texts(correctedSpans, true));
  }
  const expected = [
    ...rawSpans
      .filter((span) => span.kind !== "path")
      .map((span) => ({ at: span.start, text: span.text })),
    ...spelled.map((flag) => ({ at: flag.start, text: flag.flag, spelled: flag })),
  ].sort((a, b) => a.at - b.at);
  return sameWithOptional(
    expected,
    correctedSpans.filter((span) => span.kind !== "path"),
    spoken!.holdsFlag
  );
}

interface SpokenSymbols {
  /** The raw words without those naming a symbol typed where they were spoken. */
  tokens: WordToken[];
  /** Whether a typed flag holds the words a flag was spelled out with, in their place. */
  holdsFlag: (spelled: Range, typed: Range) => boolean;
}

/**
 * Places what was spoken as symbols by the word alignment: a name like
 * "slash" or "dash" is freed only where the cleanup typed its symbol against
 * the very words it was spoken between, so a hyphen typed elsewhere can't
 * take away a word that was meant. Past the alignment limit nothing is freed
 * and no spelled flag may be typed.
 */
function placeSpokenSymbols(
  raw: readonly WordToken[],
  correctedText: string,
  corrected: readonly WordToken[]
): SpokenSymbols {
  const isSymbol = (index: number) => SPOKEN_SYMBOLS.has(raw[index].word);
  const alignment = raw.some((_, index) => isSymbol(index))
    ? alignWords(
        raw.map((token) => token.word),
        corrected.map((token) => token.word)
      )
    : null;
  if (!alignment) return { tokens: [...raw], holdsFlag: () => false };
  const landedAt = (index: number) =>
    index >= 0 && index < raw.length && alignment.kept[index]
      ? corrected[alignment.landed[index]]
      : undefined;
  const isTyped = (at: number) => TYPED_SYMBOLS.has(correctedText[at] ?? "");
  // The symbols typed in [start, end), counted. A dot or colon counts only
  // inside a word, never as a sentence's own.
  const typedIn = (start: number, end: number): Map<string, number> => {
    const inside =
      WORD_CHAR_RE.test(correctedText[start - 1] ?? "") &&
      WORD_CHAR_RE.test(correctedText[end] ?? "");
    const counts = new Map<string, number>();
    for (let at = start; at < end; at++) {
      const symbol = correctedText[at];
      if (!inside && (symbol === "." || symbol === ":")) continue;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    return counts;
  };
  const free = new Uint8Array(raw.length);
  for (let first = 0; first < raw.length; first++) {
    if (!isSymbol(first)) continue;
    let last = first;
    while (last + 1 < raw.length && isSymbol(last + 1)) last++;
    const before = landedAt(first - 1);
    const after = landedAt(last + 1);
    // Typed right after the word before, else right before the word after:
    // between them when they landed side by side with only symbols between.
    const runs: Array<[number, number]> = [];
    if (before) {
      let end = before.end;
      while (isTyped(end)) end++;
      runs.push([before.end, end]);
    }
    if (after) {
      let start = after.start;
      while (start > 0 && isTyped(start - 1)) start--;
      runs.push([start, after.start]);
    }
    let typed = new Map<string, number>();
    for (const [start, end] of runs) {
      typed = typedIn(start, end);
      if (typed.size > 0) break;
    }
    for (let index = first; index <= last; index++) {
      if (alignment.kept[index]) continue;
      const symbol = SPOKEN_SYMBOLS.get(raw[index].word)!;
      const left = typed.get(symbol) ?? 0;
      if (left === 0) continue;
      typed.set(symbol, left - 1);
      free[index] = 1;
    }
    first = last;
  }
  return {
    tokens: raw.filter((_, index) => !free[index]),
    // The words it was spelled with sit inside the typed flag, and it sits
    // between the words it was spoken between (another spelled flag's words
    // count), so it can't move to another command or outlive a dropped one.
    holdsFlag: (spelled, typed) => {
      const from = firstTokenFrom(raw, spelled.start);
      if (from > 0 && raw[from - 1].end > spelled.start) return false;
      let next = from;
      let named = false;
      for (; next < raw.length && raw[next].start < spelled.end; next++) {
        if (isSymbol(next)) continue;
        const landed = landedAt(next);
        if (!landed || landed.start < typed.start || landed.end > typed.end) return false;
        named = true;
      }
      if (!named) return false;
      const firstTyped = firstTokenFrom(corrected, typed.start);
      const lastTyped = firstTokenFrom(corrected, typed.end) - 1;
      let before = from - 1;
      while (before >= 0 && isSymbol(before)) before--;
      while (next < raw.length && isSymbol(next)) next++;
      const beside = (index: number, at: number) =>
        index < 0 || index >= raw.length
          ? at < 0 || at >= corrected.length
          : alignment.kept[index] && alignment.landed[index] === at;
      return beside(before, firstTyped - 1) && beside(next, lastTyped + 1);
    },
  };
}

function numberWords(tokens: readonly WordToken[]): string[] {
  return tokens.flatMap((token) => (NUMBER_WORDS.has(token.word) ? [token.word] : []));
}

function numbersMatch(
  raw: string,
  corrected: string,
  rawNumberWords: readonly string[],
  correctedNumberWords: readonly string[]
): boolean {
  return (
    sameSequence(raw.match(NUMBER_RE) ?? [], corrected.match(NUMBER_RE) ?? []) &&
    sameSequence(raw.match(DIGIT_RUN_RE) ?? [], corrected.match(DIGIT_RUN_RE) ?? []) &&
    sameSequence(raw.match(HAN_NUMERAL_RE) ?? [], corrected.match(HAN_NUMERAL_RE) ?? []) &&
    sameSequence(rawNumberWords, correctedNumberWords)
  );
}

/**
 * Numbers stay exactly as spoken, except that the counting words of a list
 * ("one, add…", "step 2,") may become its item numbers ("1. Add…"), when the
 * spoken count, ordinals included, runs the same 1, 2, 3… as the list does.
 */
function keepsNumbers(
  raw: string,
  corrected: string,
  rawTokens: readonly WordToken[],
  correctedTokens: readonly WordToken[],
  enumerators: readonly Enumerator[],
  markerValues: readonly number[]
): boolean {
  const correctedNumberWords = numberWords(correctedTokens);
  if (numbersMatch(raw, corrected, numberWords(rawTokens), correctedNumberWords)) return true;
  const counted = enumerators.filter((enumerator) => enumerator.value !== undefined);
  if (
    counted.length === 0 ||
    !sameSequence(
      counted.map((enumerator) => String(enumerator.value)),
      markerValues.map(String)
    )
  ) {
    return false;
  }
  const spokenCounts = counted.map((enumerator) => ({
    start: enumerator.valueStart,
    end: enumerator.end,
  }));
  return numbersMatch(
    blankRanges(raw, spokenCounts),
    corrected,
    numberWords(rawTokens.filter((token) => !overlaps(spokenCounts, token))),
    correctedNumberWords
  );
}

interface Range {
  start: number;
  end: number;
}

interface WordToken extends Range {
  word: string;
}

interface Enumerator extends Range {
  value: number | undefined;
  valueStart: number;
}

interface ListLayout {
  /** The text with each item marker blanked out, offsets unchanged. */
  text: string;
  items: number;
  /** The numbers a counted list's markers carry, in order. */
  values: number[];
}

interface Breaks {
  /** Where each sentence starts, ascending, beginning with 0. */
  sentences: number[];
  clauses: number[];
}

/** `text` with each range, in order and not overlapping, replaced by spaces. */
function blankRanges(text: string, ranges: readonly Range[]): string {
  const pieces: string[] = [];
  let last = 0;
  for (const { start, end } of ranges) {
    pieces.push(text.slice(last, start), " ".repeat(end - start));
    last = end;
  }
  pieces.push(text.slice(last));
  return pieces.join("");
}

/** Line-start list markers. A numbered list counts only when it runs 1, 2, 3… */
function readListLayout(text: string): ListLayout {
  const markers = [...text.matchAll(LIST_MARKER_RE)];
  const values = markers.flatMap((match) => (match[2] === undefined ? [] : [Number(match[2])]));
  const counted = values.every((value, index) => value === index + 1);
  const blanked = markers
    .filter((match) => match[2] === undefined || counted)
    .map((match) => ({
      start: match.index + match[1].length,
      end: match.index + match[0].length,
    }));
  return {
    text: blankRanges(text, blanked),
    items: blanked.length,
    values: counted ? values : [],
  };
}

/** Whether `range` overlaps any of `ranges`, which are in order and don't overlap. */
function overlaps(ranges: readonly Range[], range: Range): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid].end <= range.start) low = mid + 1;
    else high = mid;
  }
  return low < ranges.length && ranges[low].start < range.end;
}

function findEnumerators(text: string, protectedRanges: readonly Range[]): Enumerator[] {
  const enumerators: Enumerator[] = [];
  for (const match of text.matchAll(ENUMERATOR_RE)) {
    const { prefix, word, after } = match.groups!;
    if (prefix === undefined && !/[,.:;)]/.test(after)) continue;
    const end = match.index + match[0].length - after.length;
    const range = { start: match.index, end };
    if (overlaps(protectedRanges, range)) continue;
    const lower = word.toLowerCase().replace(/ly$/u, "");
    const named = Math.max(CARDINAL_WORDS.indexOf(lower), ORDINAL_WORDS.indexOf(lower));
    const value = named >= 0 ? named + 1 : /^\d+$/.test(word) ? Number(word) : undefined;
    enumerators.push({ ...range, value, valueStart: end - word.length });
  }
  return enumerators;
}

function findRetractions(text: string, protectedRanges: readonly Range[]): Range[] {
  return Array.from(text.matchAll(RETRACTION_RE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  })).filter((marker) => !overlaps(protectedRanges, marker));
}

function breakStarts(text: string, pattern: RegExp): number[] {
  return [0, ...Array.from(text.matchAll(pattern), (match) => match.index + match[0].length)];
}

function lastAtMost(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (sorted[mid] <= value) low = mid;
    else high = mid - 1;
  }
  return sorted[low];
}

function firstAfter(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return sorted[low] ?? Infinity;
}

function firstTokenFrom(tokens: readonly WordToken[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tokens[mid].start < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** How many words the phrase starting at token `from` has, up to its clause break. */
function phraseLength(tokens: readonly WordToken[], from: number, breaks: Breaks): number {
  return firstTokenFrom(tokens, firstAfter(breaks.clauses, tokens[from].start)) - from;
}

/**
 * Frees the words a self-correction took back, once the cleanup shows it
 * resolved one: the correction phrase is gone, the start of its replacement
 * survives and sits where the dropped words were, with nothing added in
 * between, and the words dropped are the ones running up to the phrase. A
 * negation among them is never freed.
 */
function freeRetraction(
  text: string,
  tokens: readonly WordToken[],
  alignment: Alignment,
  marker: Range,
  breaks: Breaks,
  free: Uint8Array
): void {
  const { kept } = alignment;
  const markerStart = firstTokenFrom(tokens, marker.start);
  const markerEnd = firstTokenFrom(tokens, marker.end);
  if (markerStart === 0) return;
  for (let i = markerStart; i < markerEnd; i++) if (kept[i]) return;

  const sentence = lastAtMost(breaks.sentences, marker.start);
  const nextSentence = firstAfter(breaks.sentences, marker.end);
  const hasReplacement = markerEnd < tokens.length;
  const replacementLength = hasReplacement ? phraseLength(tokens, markerEnd, breaks) : 0;
  for (let i = markerEnd; i < markerEnd + Math.min(replacementLength, REPLACEMENT_WORDS); i++) {
    if (!kept[i]) return;
  }

  let first: number;
  const ownSentence =
    SENTENCE_RETRACTION_RE.test(text.slice(marker.start, marker.end)) &&
    firstTokenFrom(tokens, sentence) === markerStart &&
    (!hasReplacement || nextSentence <= tokens[markerEnd].start);
  if (ownSentence) {
    first = firstTokenFrom(tokens, lastAtMost(breaks.sentences, sentence - 1));
  } else {
    if (!hasReplacement) return;
    // The replacement follows in the same sentence, or opens the next one when
    // the correction ended its own ("…the staging server, no wait. At the…").
    if (
      nextSentence <= tokens[markerEnd].start &&
      /[^\s.!?。！？]/u.test(text.slice(marker.end, nextSentence))
    ) {
      return;
    }
    first = Math.max(
      firstTokenFrom(tokens, lastAtMost(breaks.clauses, tokens[markerStart - 1].start)),
      markerStart - RETRACTION_WORD_LIMIT
    );
    let restart = markerStart - 1;
    while (restart >= first && tokens[restart].word !== tokens[markerEnd].word) restart--;
    first =
      restart >= first
        ? restart
        : Math.max(first, markerStart - Math.min(replacementLength, RETRACTION_FALLBACK_WORDS));
  }
  first = Math.max(first, markerStart - RETRACTION_WORD_LIMIT);

  let run = markerStart;
  while (run > first && !kept[run - 1]) run--;
  if (run === markerStart) return;
  if (hasReplacement) {
    const landed = alignment.landed[markerEnd];
    if (landed > 0 && !alignment.matched[landed - 1]) return;
  }
  for (let i = run; i < markerStart; i++) {
    if (!NEGATION_WORDS.has(tokens[i].word)) free[i] = 1;
  }
  for (let i = markerStart; i < markerEnd; i++) free[i] = 1;
}

/** Frees the counting words of a list the cleanup laid out, one per line it wrote. */
function freeEnumerators(
  tokens: readonly WordToken[],
  kept: readonly boolean[],
  enumerators: readonly Enumerator[],
  items: number,
  free: Uint8Array
): void {
  let freed = 0;
  for (const enumerator of enumerators) {
    if (freed >= items) return;
    const first = firstTokenFrom(tokens, enumerator.start);
    const end = firstTokenFrom(tokens, enumerator.end);
    if (first === end || kept.slice(first, end).some(Boolean)) continue;
    free.fill(1, first, end);
    freed++;
  }
}

function normalizeWord(word: string): string {
  if (!word.includes("'") && !word.includes("’")) return NOT_FORMS.has(word) ? "not" : word;
  if (CONTRACTED_NOT_RE.test(word)) return "not";
  const bare = word.replace(APOSTROPHE_RE, "");
  return NOT_FORMS.has(bare) ? "not" : bare;
}

/**
 * Words with apostrophes dropped, every "not" form unified, and filler
 * removed. With `splitIdentifiers`, `project_id`, `db:generate` and
 * `api.ts` are read as the words a speaker names them by.
 */
function contentTokens(text: string, splitIdentifiers: boolean): WordToken[] {
  const tokens: WordToken[] = [];
  const push = (word: string, start: number) => {
    tokens.push({
      word: normalizeWord(word.toLowerCase()),
      start,
      end: start + word.length,
    });
  };
  for (const segment of wordSegmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    if (!splitIdentifiers || !IDENTIFIER_JOIN_RE.test(segment.segment)) {
      push(segment.segment, segment.index);
      continue;
    }
    let offset = segment.index;
    for (const part of segment.segment.split(/([._:]+)/u)) {
      if (part && !IDENTIFIER_JOIN_RE.test(part)) push(part, offset);
      offset += part.length;
    }
  }
  const kept: WordToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (DROPPED_PAIRS.has(`${tokens[i].word} ${tokens[i + 1]?.word}`)) {
      i++;
      continue;
    }
    if (!HESITATIONS.has(tokens[i].word) && !SOFT_FILLERS.has(tokens[i].word)) {
      kept.push(tokens[i]);
    }
  }
  return kept;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * Joins adjacent raw words the cleanup merged into one ("type script" to
 * "typescript", "o auth" to "oauth"), so a fixed mishearing doesn't count as
 * a rewrite or shift what a negation governs. Only joined words the raw text
 * didn't already contain can fund a merge, and a negation is never joined
 * away ("not able" is not "notable").
 */
function mergeJoinedWords(raw: readonly WordToken[], corrected: readonly string[]): WordToken[] {
  const available = countBy(corrected);
  for (const { word } of raw) {
    if (available.has(word)) available.set(word, available.get(word)! - 1);
  }
  // Nothing the cleanup wrote is missing from the raw words, so nothing was joined.
  if (![...available.values()].some((left) => left > 0)) return [...raw];
  const take = (parts: readonly WordToken[]) => {
    const word = parts.map((part) => part.word).join("");
    const left = available.get(word) ?? 0;
    if (left <= 0 || parts.some((part) => NEGATION_WORDS.has(part.word))) return false;
    available.set(word, left - 1);
    return true;
  };
  const join = (parts: readonly WordToken[]): WordToken => ({
    word: parts.map((part) => part.word).join(""),
    start: parts[0].start,
    end: parts[parts.length - 1].end,
  });
  const merged: WordToken[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = i + 1 < raw.length ? raw.slice(i, i + 2) : null;
    const triple = i + 2 < raw.length ? raw.slice(i, i + 3) : null;
    if (triple !== null && take(triple)) {
      merged.push(join(triple));
      i += 2;
    } else if (pair !== null && take(pair)) {
      merged.push(join(pair));
      i += 1;
    } else {
      merged.push(raw[i]);
    }
  }
  return merged;
}

/**
 * Each negation paired with the word it governs and which occurrence of that
 * word it is, so a "not" that is added, dropped, or moved to another verb (even
 * another copy of the same verb) changes the set.
 */
function negationAnchors(words: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const occurrence = words.map((word) => {
    const index = seen.get(word) ?? 0;
    seen.set(word, index + 1);
    return index;
  });
  const anchors: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!NEGATION_WORDS.has(words[i])) continue;
    anchors.push(
      i + 1 < words.length ? `${words[i]}:${words[i + 1]}#${occurrence[i + 1]}` : `${words[i]}:`
    );
  }
  return anchors.sort();
}

function missingFrom(source: readonly string[], target: Map<string, number>): number {
  let missing = 0;
  for (const [word, count] of countBy(source)) {
    missing += Math.max(0, count - (target.get(word) ?? 0));
  }
  return missing;
}

function withinBudget(
  length: number,
  removed: number,
  added: number,
  limits: CorrectionGuardLimits,
  minRemoved = limits.minRemoved
): boolean {
  return (
    removed <= Math.max(minRemoved, Math.ceil(length * limits.removedRatio)) &&
    added <= Math.max(limits.minAdded, Math.ceil(length * limits.addedRatio))
  );
}

function compareWords(
  raw: readonly string[],
  corrected: readonly string[],
  limits: CorrectionGuardLimits
): CorrectionGuardResult {
  if (!sameSequence(negationAnchors(raw), negationAnchors(corrected))) {
    return { ok: false, reason: "negation" };
  }
  const removed = missingFrom(raw, countBy(corrected));
  const added = missingFrom(corrected, countBy(raw));
  return withinBudget(raw.length, removed, added, limits)
    ? { ok: true }
    : { ok: false, reason: "edit_size" };
}

interface Alignment {
  /** Whether each raw word survived. */
  kept: boolean[];
  /** Where each raw word landed in the cleanup, or -1. */
  landed: Int32Array;
  /** Whether each word of the cleanup came from the raw text. */
  matched: boolean[];
}

/**
 * Which raw words the cleanup kept, by longest common subsequence. Matches are
 * taken from the end, so of a repeated phrase it's the earlier copy that was
 * dropped, which is where a retraction sits.
 */
function alignWords(raw: readonly string[], corrected: readonly string[]): Alignment | null {
  const width = corrected.length + 1;
  if ((raw.length + 1) * width > MAX_ALIGNMENT_CELLS) return null;
  const table = new Uint16Array((raw.length + 1) * width);
  for (let i = 1; i <= raw.length; i++) {
    for (let j = 1; j < width; j++) {
      table[i * width + j] =
        raw[i - 1] === corrected[j - 1]
          ? table[(i - 1) * width + j - 1] + 1
          : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
    }
  }
  const landed = new Int32Array(raw.length).fill(-1);
  const matched = new Array<boolean>(corrected.length).fill(false);
  let i = raw.length;
  let j = corrected.length;
  while (i > 0 && j > 0) {
    if (raw[i - 1] === corrected[j - 1]) {
      landed[i - 1] = j - 1;
      matched[j - 1] = true;
      i--;
      j--;
    } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return { kept: Array.from(landed, (index) => index >= 0), landed, matched };
}

/**
 * The word checks again, with the words the allowances freed taken out of the
 * raw text first. Everything else the cleanup dropped or added, in order,
 * still counts, against a tighter budget, and a negation that stayed has to
 * keep the word it governed.
 */
function compareRetainedWords(
  raw: readonly WordToken[],
  corrected: readonly string[],
  kept: readonly boolean[],
  free: Uint8Array,
  limits: CorrectionGuardLimits
): CorrectionGuardResult {
  for (let i = 0; i + 1 < raw.length; i++) {
    if (NEGATION_WORDS.has(raw[i].word) && kept[i] && !kept[i + 1] && free[i + 1]) {
      return { ok: false, reason: "negation" };
    }
  }
  const retained = raw.filter((_, index) => kept[index] || !free[index]).map((t) => t.word);
  if (!sameSequence(negationAnchors(retained), negationAnchors(corrected))) {
    return { ok: false, reason: "negation" };
  }
  const matched = kept.filter(Boolean).length;
  return withinBudget(
    retained.length,
    retained.length - matched,
    corrected.length - matched,
    limits,
    limits.minAllowanceRemoved
  )
    ? { ok: true }
    : { ok: false, reason: "edit_size" };
}

/**
 * Checks a cleanup of `raw` against the meaning guards. `limits` is the
 * cleanup benchmark's way to try other edit budgets on the same replies.
 */
export function validateCorrection(
  raw: string,
  corrected: string,
  limits: CorrectionGuardLimits = CORRECTION_GUARD_LIMITS
): CorrectionGuardResult {
  // Raw list markers are set aside only when the cleanup kept the same ones,
  // so a dictated "1." can't vanish as layout.
  const correctedLayout = readListLayout(corrected);
  const rawLayout = readListLayout(raw);
  const rawText = sameSequence(rawLayout.values.map(String), correctedLayout.values.map(String))
    ? rawLayout.text
    : raw;
  // Number words come from the same pass as the word checks: no filler or
  // spoken command contains one.
  const correctedTokens = contentTokens(correctedLayout.text, limits.spokenSymbols);
  const spokenTokens = contentTokens(rawText, limits.spokenSymbols);
  const correctedWords = correctedTokens.map((token) => token.word);
  const joinedTokens = mergeJoinedWords(spokenTokens, correctedWords);
  const spoken = limits.spokenSymbols
    ? placeSpokenSymbols(joinedTokens, correctedLayout.text, correctedTokens)
    : null;
  if (!keepsProtectedSpans(raw, corrected, spoken)) {
    return { ok: false, reason: "protected_span" };
  }

  // Only the allowances need these, so a plain cleanup costs what it did before.
  let protectedRanges: ProtectedRange[] | undefined;
  const rawProtectedRanges = () => (protectedRanges ??= findProtectedRanges(raw));
  const enumerators =
    correctedLayout.items >= 2 ? findEnumerators(rawText, rawProtectedRanges()) : [];
  if (
    !keepsNumbers(
      rawText,
      correctedLayout.text,
      spokenTokens,
      correctedTokens,
      enumerators,
      correctedLayout.values
    )
  ) {
    return { ok: false, reason: "number" };
  }

  const rawTokens = spoken ? spoken.tokens : joinedTokens;
  const verdict = compareWords(
    rawTokens.map((token) => token.word),
    correctedWords,
    limits
  );
  if (verdict.ok) return verdict;

  const retractions = findRetractions(rawText, rawProtectedRanges());
  if (retractions.length === 0 && enumerators.length === 0) return verdict;
  const alignment = alignWords(
    rawTokens.map((token) => token.word),
    correctedWords
  );
  if (!alignment) return verdict;

  const breaks: Breaks = {
    sentences: breakStarts(rawText, SENTENCE_BREAK_RE),
    clauses: breakStarts(rawText, CLAUSE_BREAK_RE),
  };
  const free = new Uint8Array(rawTokens.length);
  for (const marker of retractions) {
    freeRetraction(rawText, rawTokens, alignment, marker, breaks, free);
  }
  freeEnumerators(rawTokens, alignment.kept, enumerators, correctedLayout.items, free);
  return compareRetainedWords(rawTokens, correctedWords, alignment.kept, free, limits);
}

/**
 * Checks a spoken rewrite of selected text. A rewrite is meant to change the
 * words, so only the protected spans are held to cleanup's rule; the number,
 * negation and edit-size checks would refuse "make it a numbered list" or
 * "make it shorter".
 */
export function validateRewrite(selection: string, rewritten: string): CorrectionGuardResult {
  return keepsProtectedSpans(selection, rewritten, null)
    ? { ok: true }
    : { ok: false, reason: "protected_span" };
}
