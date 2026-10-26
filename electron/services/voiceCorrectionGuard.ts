/**
 * Deterministic checks that an AI cleanup kept the meaning of the dictated
 * text. Correction is a polish pass: a leftover mishearing is recoverable, a
 * changed path, flag, number or "don't" is not, so anything these checks
 * can't vouch for falls back to the raw text. They are structural, not a
 * semantic proof: a one-word swap like "keep" to "delete" still gets through,
 * and negations are only recognised in English.
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
    "(?<path>(?<![\\w.~:%+-])[\\w.~:%+-]*[/\\\\][^\\s`,;，。、；：！？]*)",
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

// Words a cleanup is expected to drop, left out of every word comparison.
const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mm"]);
const SOFT_FILLERS = new Set(["like", "so", "basically", "actually", "literally", "well"]);
const FILLER_PAIRS = new Set(["you know", "i mean"]);

// Cleanup removes filler and merges misheard phrases into one term, so it may
// drop more words than it adds. Answers and rewrites add words; summaries drop them.
const MIN_REMOVED_BUDGET = 4;
const MIN_ADDED_BUDGET = 2;
const EDIT_BUDGET_RATIO = 0.15;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function trimProsePunctuation(span: string): string {
  let text = span;
  for (;;) {
    const last = text.at(-1) ?? "";
    const opener = CLOSERS[last];
    const unbalanced =
      PROSE_PUNCTUATION.has(last) ||
      (opener !== undefined && text.split(opener).length < text.split(last).length) ||
      (QUOTES.has(last) && text.split(last).length % 2 === 0);
    if (!unbalanced) break;
    text = text.slice(0, -1);
  }
  for (;;) {
    const first = text[0] ?? "";
    const closer = Object.keys(CLOSERS).find((key) => CLOSERS[key] === first);
    const unbalanced =
      (closer !== undefined && text.split(first).length > text.split(closer).length) ||
      (QUOTES.has(first) && text.split(first).length % 2 === 0);
    if (!unbalanced) break;
    text = text.slice(1);
  }
  return text;
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

function keepsNumbers(raw: string, corrected: string): boolean {
  const numberWords = (text: string) => segmentWords(text).filter((w) => NUMBER_WORDS.has(w));
  return (
    sameSequence(raw.match(NUMBER_RE) ?? [], corrected.match(NUMBER_RE) ?? []) &&
    sameSequence(raw.match(DIGIT_RUN_RE) ?? [], corrected.match(DIGIT_RUN_RE) ?? []) &&
    sameSequence(raw.match(HAN_NUMERAL_RE) ?? [], corrected.match(HAN_NUMERAL_RE) ?? []) &&
    sameSequence(numberWords(raw), numberWords(corrected))
  );
}

/** Words with apostrophes dropped, every "not" form unified, and filler removed. */
function contentWords(text: string): string[] {
  const words = segmentWords(text).map((word) => {
    if (CONTRACTED_NOT_RE.test(word)) return "not";
    const bare = word.replace(APOSTROPHE_RE, "");
    return NOT_FORMS.has(bare) ? "not" : bare;
  });
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (FILLER_PAIRS.has(`${words[i]} ${words[i + 1]}`)) {
      i++;
      continue;
    }
    if (!HESITATIONS.has(words[i]) && !SOFT_FILLERS.has(words[i])) kept.push(words[i]);
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
 * a rewrite or shift what a negation governs.
 */
function mergeJoinedWords(raw: readonly string[], corrected: readonly string[]): string[] {
  const available = countBy(corrected);
  const take = (word: string) => {
    const left = available.get(word) ?? 0;
    if (left === 0) return false;
    available.set(word, left - 1);
    return true;
  };
  const merged: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = i + 1 < raw.length ? raw[i] + raw[i + 1] : null;
    const triple = pair !== null && i + 2 < raw.length ? pair + raw[i + 2] : null;
    if (triple !== null && take(triple)) {
      merged.push(triple);
      i += 2;
    } else if (pair !== null && take(pair)) {
      merged.push(pair);
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

function withinEditBudget(raw: readonly string[], corrected: readonly string[]): boolean {
  const scaled = Math.ceil(raw.length * EDIT_BUDGET_RATIO);
  const removed = missingFrom(raw, countBy(corrected));
  const added = missingFrom(corrected, countBy(raw));
  return (
    removed <= Math.max(MIN_REMOVED_BUDGET, scaled) && added <= Math.max(MIN_ADDED_BUDGET, scaled)
  );
}

/** Checks a cleanup of `raw` against the meaning guards. */
export function validateCorrection(raw: string, corrected: string): CorrectionGuardResult {
  if (!keepsProtectedSpans(raw, corrected)) return { ok: false, reason: "protected_span" };
  if (!keepsNumbers(raw, corrected)) return { ok: false, reason: "number" };

  const correctedWords = contentWords(corrected);
  const rawWords = mergeJoinedWords(contentWords(raw), correctedWords);
  if (!sameSequence(negationAnchors(rawWords), negationAnchors(correctedWords))) {
    return { ok: false, reason: "negation" };
  }
  if (!withinEditBudget(rawWords, correctedWords)) return { ok: false, reason: "edit_size" };

  return { ok: true };
}
