/**
 * Deterministic checks that an AI cleanup kept the meaning of the dictated
 * text. Correction is a polish pass: a leftover mishearing is recoverable, a
 * changed path, flag, number or "don't" is not, so anything these checks
 * can't vouch for falls back to the raw text. They are structural, not a
 * semantic proof: a one-word swap like "keep" to "delete" still gets through.
 */

export type CorrectionRejectReason = "protected_span" | "number" | "negation" | "edit_size";

export type CorrectionGuardResult = { ok: true } | { ok: false; reason: CorrectionRejectReason };

// Order matters: earlier alternatives claim their text first, so a path inside
// backticks or an @-reference is one span, not two.
const PROTECTED_SPAN_RE = new RegExp(
  [
    "```[\\s\\S]*?```",
    "`[^`\\n]+`",
    "(?<![\\w@])@[^\\s`]+",
    "\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s`]+",
    "(?<![\\w-])--?[A-Za-z][\\w-]*(?:=[^\\s`]+)?",
    "[^\\s`]*[/\\\\][^\\s`]*",
    "\\b[\\w-]{2,}\\.[A-Za-z][A-Za-z0-9]{0,7}\\b",
  ].join("|"),
  "gu"
);
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/u;
const LEADING_PUNCTUATION_RE = /^[([{'"]+/u;
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
// A span only counts as kept when it stands alone: "--watch" inside
// "--watch=false" or "foo.ts" inside "foo.tsx" is a change, not a match.
const SPAN_BOUNDARY_RE = /[\p{L}\p{N}_/\\@=-]/u;

const NUMBER_RE = /(?<![\p{L}\p{N}_])[-+]?\p{Nd}+(?:[.,:/-]\p{Nd}+)*%?/gu;
const DIGIT_RUN_RE = /\p{Nd}+/gu;

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

const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mm"]);

/** Words a cleanup may add, or remove, before it counts as a rewrite. */
const MIN_EDIT_BUDGET = 2;
const EDIT_BUDGET_RATIO = 0.3;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export interface ProtectedRange {
  start: number;
  end: number;
}

/** Character ranges of the protected spans in `text`, for edits that must skip them. */
export function findProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (const match of text.matchAll(PROTECTED_SPAN_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** Every protected span in `text`, in order, with surrounding prose punctuation trimmed. */
export function extractProtectedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const [match] of text.matchAll(PROTECTED_SPAN_RE)) {
    if (match.startsWith("`")) {
      spans.push(match);
      continue;
    }
    const span = match.replace(TRAILING_PUNCTUATION_RE, "").replace(LEADING_PUNCTUATION_RE, "");
    if (HAS_WORD_CHAR_RE.test(span)) spans.push(span);
  }
  return spans;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function isStandalone(text: string, start: number, end: number): boolean {
  if (SPAN_BOUNDARY_RE.test(text[start - 1] ?? "") || SPAN_BOUNDARY_RE.test(text[end] ?? "")) {
    return false;
  }
  return !(text[end] === "." && HAS_WORD_CHAR_RE.test(text[end + 1] ?? ""));
}

function countStandalone(text: string, span: string): number {
  let count = 0;
  for (let at = text.indexOf(span); at !== -1; at = text.indexOf(span, at + 1)) {
    if (isStandalone(text, at, at + span.length)) count++;
  }
  return count;
}

function keepsProtectedSpans(raw: string, corrected: string): boolean {
  for (const [span, count] of countBy(extractProtectedSpans(raw))) {
    if (countStandalone(corrected, span) < count) return false;
  }
  return true;
}

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameMultiset(a: string[], b: string[]): boolean {
  return sameSequence([...a].sort(), [...b].sort());
}

function keepsNumbers(raw: string, corrected: string): boolean {
  return (
    sameSequence(raw.match(NUMBER_RE) ?? [], corrected.match(NUMBER_RE) ?? []) &&
    sameMultiset(raw.match(DIGIT_RUN_RE) ?? [], corrected.match(DIGIT_RUN_RE) ?? [])
  );
}

/** Lowercased words with apostrophes dropped and hesitation sounds removed. */
function contentWords(text: string): string[] {
  const words: string[] = [];
  for (const segment of wordSegmenter.segment(text.toLowerCase())) {
    if (!segment.isWordLike) continue;
    const word = CONTRACTED_NOT_RE.test(segment.segment)
      ? "not"
      : segment.segment.replace(APOSTROPHE_RE, "");
    if (!HESITATIONS.has(word)) words.push(NOT_FORMS.has(word) ? "not" : word);
  }
  return words;
}

/**
 * Each negation paired with the word it governs, so a "not" that moves to
 * another verb is caught as well as one that is added or dropped.
 */
function negationAnchors(words: string[]): string[] {
  const anchors: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (NEGATION_WORDS.has(words[i])) anchors.push(`${words[i]}:${words[i + 1] ?? ""}`);
  }
  return anchors;
}

/**
 * Joins adjacent raw words the cleanup merged into one ("type script" to
 * "typescript"), so a fixed mishearing doesn't count as a rewrite.
 */
function mergeJoinedWords(raw: string[], corrected: Set<string>): string[] {
  const merged: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = raw[i] + (raw[i + 1] ?? "");
    const triple = pair + (raw[i + 2] ?? "");
    if (i + 2 < raw.length && corrected.has(triple) && !corrected.has(raw[i])) {
      merged.push(triple);
      i += 2;
    } else if (i + 1 < raw.length && corrected.has(pair) && !corrected.has(raw[i])) {
      merged.push(pair);
      i += 1;
    } else {
      merged.push(raw[i]);
    }
  }
  return merged;
}

function missingFrom(source: string[], target: Map<string, number>): number {
  let missing = 0;
  for (const [word, count] of countBy(source)) {
    missing += Math.max(0, count - (target.get(word) ?? 0));
  }
  return missing;
}

function withinEditBudget(rawWords: string[], correctedWords: string[]): boolean {
  const raw = mergeJoinedWords(rawWords, new Set(correctedWords));
  const budget = Math.max(MIN_EDIT_BUDGET, Math.ceil(raw.length * EDIT_BUDGET_RATIO));
  const removed = missingFrom(raw, countBy(correctedWords));
  const added = missingFrom(correctedWords, countBy(raw));
  return removed <= budget && added <= budget;
}

/** Checks a cleanup of `raw` against the meaning guards. */
export function validateCorrection(raw: string, corrected: string): CorrectionGuardResult {
  if (!keepsProtectedSpans(raw, corrected)) return { ok: false, reason: "protected_span" };
  if (!keepsNumbers(raw, corrected)) return { ok: false, reason: "number" };

  const rawWords = contentWords(raw);
  const correctedWords = contentWords(corrected);
  if (!sameMultiset(negationAnchors(rawWords), negationAnchors(correctedWords))) {
    return { ok: false, reason: "negation" };
  }
  if (!withinEditBudget(rawWords, correctedWords)) return { ok: false, reason: "edit_size" };

  return { ok: true };
}
