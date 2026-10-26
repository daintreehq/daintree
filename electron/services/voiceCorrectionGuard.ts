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

type SpanKind = "code" | "ref" | "url" | "flag" | "path";

interface ProtectedSpan {
  kind: SpanKind;
  text: string;
  start: number;
  end: number;
}

// Order matters: earlier alternatives claim their text first, so a path inside
// backticks or an @-reference is one span, not two. Each alternative may only
// start at the beginning of a run (the lookbehinds), which keeps the scan
// linear on long unspaced text such as CJK or a pasted blob.
const PROTECTED_SPAN_RE = new RegExp(
  [
    "(?<code>```[\\s\\S]*?```|`[^`\\n]+`)",
    "(?<ref>(?<![\\w@])@[^\\s`]+)",
    "(?<url>(?<![\\w+.-])[a-z][a-z0-9+.-]*:\\/\\/[^\\s`]+)",
    "(?<flag>(?<![\\w-])--?[A-Za-z][^\\s`=,;]*(?:=[^\\s`,;]+)?)",
    "(?<path>(?<![\\p{L}\\p{N}_.~:%+-])[\\p{L}\\p{N}_.~:%+-]*[/\\\\][^\\s`,;，。、；：！？]*)",
    "(?<dotfile>(?<![\\w.-])\\.[A-Za-z][\\w.-]*)",
    "(?<dotted>(?<![\\w.-])[\\w-]+(?:\\.[\\w-]+)+)",
  ].join("|"),
  "gu"
);
// The last part of a dotted word must look like a file extension ("index.ts",
// "Node.js"), and abbreviations made of single letters ("e.g", "a.m") don't count.
const FILE_EXTENSION_RE = /^[A-Za-z][A-Za-z0-9]{0,7}$/u;
const SINGLE_LETTER_PARTS_RE = /^\w(?:\.\w)+$/u;

const PROSE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = new Set(["'", '"']);

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

// Cleanup removes filler and merges misheard phrases into one term, so it may
// drop more words than it adds. Answers and rewrites add words; summaries drop them.
const MIN_REMOVED_BUDGET = 4;
const MIN_ADDED_BUDGET = 2;
const EDIT_BUDGET_RATIO = 0.15;

// What else a cleanup that resolved a self-correction or laid out a list may
// drop besides the words those allowances cover: a stutter, not a clause.
const MIN_ALLOWANCE_REMOVED_BUDGET = 2;

// Phrases a speaker uses to take back what they just said. Each has to end its
// phrase, so "no wait time" and "a scratch that button" stay ordinary words,
// and a bare "no" or "sorry" counts only between commas, where it can't be an
// answer. The bounded whitespace keeps the lookarounds linear.
const RETRACTION_RE =
  /\b(?:no,?\s+wait|wait,?\s+no|scratch\s+that|strike\s+that)\b(?=\s{0,3}(?:[,.;:!?—–]|$))|\b(?:or\s+rather|i\s+mean)\b|(?<=,\s{0,3})\b(?:no|sorry)\b(?=\s{0,3},)/giu;
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
// so "first failures" and "one retry" stay words, and a digit followed by
// more digits ("1.5") is a number, not an item.
const ENUMERATOR_RE = new RegExp(
  String.raw`(?<=^|[.!?;:,\n]\s{0,3})(?:and\s+)?(?:then\s+)?(?<prefix>(?:number|step|item)\s+)?(?<word>(?:first|second|third)(?:ly)?|fourth|fifth|sixth|seventh|eighth|ninth|tenth|${CARDINAL_WORDS.join("|")}|\d{1,2}|next|then|finally|lastly)(?<after>\s{0,3}[,.:;)](?!\d)|\s+(?=\p{L}))`,
  "giu"
);
const LIST_MARKER_RE = /^([ \t]*)(?:(\d{1,2})[.)]|[-*•])(?=[ \t])/gm;
// Aligning two passages costs their lengths multiplied; past this the
// allowances are skipped and the plain checks decide.
const MAX_ALIGNMENT_CELLS = 250_000;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Strips prose punctuation and unbalanced brackets or quotes from the ends of a span. */
function trimProsePunctuation(span: string): string {
  const counts = countBy([...span]);
  const count = (char: string) => counts.get(char) ?? 0;
  let start = 0;
  let end = span.length;
  while (end > start) {
    const last = span[end - 1];
    const opener = CLOSERS[last];
    const unbalanced =
      PROSE_PUNCTUATION.has(last) ||
      (opener !== undefined && count(opener) < count(last)) ||
      (QUOTES.has(last) && count(last) % 2 === 1);
    if (!unbalanced) break;
    counts.set(last, count(last) - 1);
    end--;
  }
  while (start < end) {
    const first = span[start];
    const closer = OPENERS[first];
    const unbalanced =
      (closer !== undefined && count(first) > count(closer)) ||
      (QUOTES.has(first) && count(first) % 2 === 1);
    if (!unbalanced) break;
    counts.set(first, count(first) - 1);
    start++;
  }
  return span.slice(start, end);
}

function isFileName(token: string): boolean {
  const extension = token.slice(token.lastIndexOf(".") + 1);
  return FILE_EXTENSION_RE.test(extension) && !SINGLE_LETTER_PARTS_RE.test(token);
}

function scanProtectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const match of text.matchAll(PROTECTED_SPAN_RE)) {
    const groups = match.groups ?? {};
    const start = match.index;
    const end = start + match[0].length;
    if (groups.code !== undefined) {
      spans.push({ kind: "code", text: match[0], start, end });
      continue;
    }
    const kind: SpanKind | null =
      groups.ref !== undefined
        ? "ref"
        : groups.url !== undefined
          ? "url"
          : groups.flag !== undefined
            ? "flag"
            : groups.path !== undefined || groups.dotfile !== undefined
              ? "path"
              : isFileName(match[0])
                ? "path"
                : null;
    if (!kind) continue;
    const trimmed = trimProsePunctuation(match[0]);
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    const offset = match[0].indexOf(trimmed);
    spans.push({
      kind,
      text: trimmed,
      start: start + offset,
      end: start + offset + trimmed.length,
    });
  }
  return spans;
}

export interface ProtectedRange {
  start: number;
  end: number;
}

/** Character ranges of the protected spans in `text`, for edits that must skip them. */
export function findProtectedRanges(text: string): ProtectedRange[] {
  return scanProtectedSpans(text).map(({ start, end }) => ({ start, end }));
}

/** Every protected span in `text`, in order, with surrounding prose punctuation trimmed. */
export function extractProtectedSpans(text: string): string[] {
  return scanProtectedSpans(text).map((span) => span.text);
}

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

/**
 * Code, references, URLs and flags come back exactly, in order, and none are
 * invented. Paths and filenames come back exactly, in order, but new ones may
 * appear, because fixing "next jess" to "Next.js" is the point of cleanup.
 */
function keepsProtectedSpans(raw: string, corrected: string): boolean {
  const rawSpans = scanProtectedSpans(raw);
  const correctedSpans = scanProtectedSpans(corrected);
  const texts = (spans: ProtectedSpan[], strict: boolean) =>
    spans.filter((span) => (span.kind !== "path") === strict).map((span) => span.text);
  return (
    sameSequence(texts(rawSpans, true), texts(correctedSpans, true)) &&
    isSubsequence(texts(rawSpans, false), texts(correctedSpans, false))
  );
}

function segmentWords(text: string): string[] {
  const words: string[] = [];
  for (const segment of wordSegmenter.segment(text.toLowerCase())) {
    if (segment.isWordLike) words.push(segment.segment);
  }
  return words;
}

function numbersMatch(raw: string, corrected: string): boolean {
  const numberWords = (text: string) => segmentWords(text).filter((w) => NUMBER_WORDS.has(w));
  return (
    sameSequence(raw.match(NUMBER_RE) ?? [], corrected.match(NUMBER_RE) ?? []) &&
    sameSequence(raw.match(DIGIT_RUN_RE) ?? [], corrected.match(DIGIT_RUN_RE) ?? []) &&
    sameSequence(raw.match(HAN_NUMERAL_RE) ?? [], corrected.match(HAN_NUMERAL_RE) ?? []) &&
    sameSequence(numberWords(raw), numberWords(corrected))
  );
}

/**
 * Numbers stay exactly as spoken, except that the counting words of a list
 * ("one, add…", "step 2,") may become its item numbers ("1. Add…"), when they
 * count out the same 1, 2, 3… as the list does.
 */
function keepsNumbers(
  raw: string,
  corrected: string,
  enumerators: readonly Enumerator[],
  markerValues: readonly number[]
): boolean {
  if (numbersMatch(raw, corrected)) return true;
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
  const spoken = blankRanges(
    raw,
    counted.map((enumerator) => ({ start: enumerator.valueStart, end: enumerator.end }))
  );
  return numbersMatch(spoken, corrected);
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
    const cardinal = CARDINAL_WORDS.indexOf(word.toLowerCase());
    const value = cardinal >= 0 ? cardinal + 1 : /^\d+$/.test(word) ? Number(word) : undefined;
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
 * survives, and the words dropped are the ones running up to the phrase. A
 * negation among them is never freed.
 */
function freeRetraction(
  text: string,
  tokens: readonly WordToken[],
  kept: readonly boolean[],
  marker: Range,
  breaks: Breaks,
  free: Uint8Array
): void {
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
    if (!hasReplacement || nextSentence <= tokens[markerEnd].start) return;
    first = firstTokenFrom(tokens, lastAtMost(breaks.clauses, tokens[markerStart - 1].start));
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
  if (CONTRACTED_NOT_RE.test(word)) return "not";
  const bare = word.replace(APOSTROPHE_RE, "");
  return NOT_FORMS.has(bare) ? "not" : bare;
}

/** Words with apostrophes dropped, every "not" form unified, and filler removed. */
function contentTokens(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const segment of wordSegmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    tokens.push({
      word: normalizeWord(segment.segment.toLowerCase()),
      start: segment.index,
      end: segment.index + segment.segment.length,
    });
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

function withinBudget(length: number, removed: number, added: number): boolean {
  const scaled = Math.ceil(length * EDIT_BUDGET_RATIO);
  return (
    removed <= Math.max(MIN_REMOVED_BUDGET, scaled) && added <= Math.max(MIN_ADDED_BUDGET, scaled)
  );
}

function compareWords(raw: readonly string[], corrected: readonly string[]): CorrectionGuardResult {
  if (!sameSequence(negationAnchors(raw), negationAnchors(corrected))) {
    return { ok: false, reason: "negation" };
  }
  const removed = missingFrom(raw, countBy(corrected));
  const added = missingFrom(corrected, countBy(raw));
  return withinBudget(raw.length, removed, added)
    ? { ok: true }
    : { ok: false, reason: "edit_size" };
}

/**
 * Which raw words the cleanup kept, by longest common subsequence. Matches are
 * taken from the end, so of a repeated phrase it's the earlier copy that was
 * dropped, which is where a retraction sits.
 */
function alignWords(raw: readonly string[], corrected: readonly string[]): boolean[] | null {
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
  const kept = new Array<boolean>(raw.length).fill(false);
  let i = raw.length;
  let j = corrected.length;
  while (i > 0 && j > 0) {
    if (raw[i - 1] === corrected[j - 1]) {
      kept[i - 1] = true;
      i--;
      j--;
    } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return kept;
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
  free: Uint8Array
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
  const scaled = Math.ceil(retained.length * EDIT_BUDGET_RATIO);
  return retained.length - matched <= Math.max(MIN_ALLOWANCE_REMOVED_BUDGET, scaled) &&
    corrected.length - matched <= Math.max(MIN_ADDED_BUDGET, scaled)
    ? { ok: true }
    : { ok: false, reason: "edit_size" };
}

/** Checks a cleanup of `raw` against the meaning guards. */
export function validateCorrection(raw: string, corrected: string): CorrectionGuardResult {
  if (!keepsProtectedSpans(raw, corrected)) return { ok: false, reason: "protected_span" };

  // Raw list markers are set aside only when the cleanup kept the same ones,
  // so a dictated "1." can't vanish as layout.
  const correctedLayout = readListLayout(corrected);
  const rawLayout = readListLayout(raw);
  const rawText = sameSequence(rawLayout.values.map(String), correctedLayout.values.map(String))
    ? rawLayout.text
    : raw;
  const protectedRanges = findProtectedRanges(raw);
  const enumerators = correctedLayout.items >= 2 ? findEnumerators(rawText, protectedRanges) : [];
  if (!keepsNumbers(rawText, correctedLayout.text, enumerators, correctedLayout.values)) {
    return { ok: false, reason: "number" };
  }

  const correctedWords = contentTokens(correctedLayout.text).map((token) => token.word);
  const rawTokens = mergeJoinedWords(contentTokens(rawText), correctedWords);
  const verdict = compareWords(
    rawTokens.map((token) => token.word),
    correctedWords
  );
  if (verdict.ok) return verdict;

  const retractions = findRetractions(rawText, protectedRanges);
  if (retractions.length === 0 && enumerators.length === 0) return verdict;
  const kept = alignWords(
    rawTokens.map((token) => token.word),
    correctedWords
  );
  if (!kept) return verdict;

  const breaks: Breaks = {
    sentences: breakStarts(rawText, SENTENCE_BREAK_RE),
    clauses: breakStarts(rawText, CLAUSE_BREAK_RE),
  };
  const free = new Uint8Array(rawTokens.length);
  for (const marker of retractions) freeRetraction(rawText, rawTokens, kept, marker, breaks, free);
  freeEnumerators(rawTokens, kept, enumerators, correctedLayout.items, free);
  return compareRetainedWords(rawTokens, correctedWords, kept, free);
}
