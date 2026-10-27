import { alignWords, normaliseWords } from "../../../e2e/helpers/voiceReplayScore";
import {
  buildCodeNameIndex,
  diffCodeNames,
  matchCodeNames,
} from "../../../electron/services/voiceCodeNames";
import { scanProtectedSpans } from "../../../shared/utils/voiceProtectedSpans";
import { FIX_KINDS, type CleanupCase, type FixKind } from "./voiceCleanupCorpus";

/**
 * Scoring for the dictation cleanup benchmark (`npm run perf voice-cleanup`).
 * Pure, so the script and the unit tests share one definition of each number.
 *
 * Word scores run over `normaliseWords`, which ignores case, punctuation and
 * spacing, so they say whether the right words came through in the right
 * order; a spelling's hyphens count as spacing too. Whether they were written right (`--watch`, `useShallow`, a numbered
 * list) is what `fixes` checks, character for character, and whether the code,
 * references, flags, paths and numbers the speaker gave came through untouched
 * is what the keep checks see, since the word scores can't. Fixes are scored
 * by kind: a misread one is a word an agent would have taken for something
 * else, a form one only how the speaker's own words are written.
 */

// The saved run's shape: bump only when a rescore can no longer read one, since
// a rescore scores every saved reply again from its text. A trial holds its
// reply landed once, as production lands it, since the meaning guard went.
export const VOICE_CLEANUP_SCHEMA_VERSION = 4;
// Schema 3 runs (#14786) landed each reply under every guard they named; a
// rescore still reads them and lands each saved reply once, as schema 4 does.
export const VOICE_CLEANUP_READABLE_SCHEMAS: readonly number[] = [3, VOICE_CLEANUP_SCHEMA_VERSION];
// Bump when a definition below changes, so runs scored differently aren't compared.
export const VOICE_CLEANUP_SCORING_VERSION = 6;

/** Today's send yardstick (#14793): the wait a send used to give cleanup. */
export const SEND_WAIT_TARGET_MS = 2000;
/** Where the service's short timeout ends, and where "prompt-length" starts here. */
export const PROMPT_LENGTH_MIN_CHARS = 140;

export interface TextScore {
  referenceWords: number;
  /** Word edits against the closest accepted reference. */
  edits: number;
  /** Reference words the raw transcript had wrong that this text has right. */
  repaired: number;
  /** Reference words the raw transcript had wrong: what `repaired` is out of. */
  repairable: number;
  /** Reference words the raw transcript had right that this text lost or changed. */
  broken: number;
  /** Words in neither the raw transcript nor the reference: what an answer or a rewrite adds. */
  novelWords: number;
  /** Words inserted that the raw transcript didn't already have extra: a repeated or invented phrase. */
  addedWords: number;
  /** Misread fixes landed: words an agent would have read wrong. */
  misreadsLanded: number;
  /** Form fixes landed: the speaker's own words, written as they'd have typed them. */
  formsLanded: number;
  missedFixes: string[];
  dropsLanded: number;
  missedDrops: string[];
  keepsKept: number;
  /** Explicit keeps, plus every protected span and number in the raw transcript. */
  keepsTotal: number;
  lostKeeps: string[];
  /** The same words, order and lines as an accepted reference, ignoring case and punctuation. */
  matchesReference: boolean;
  /** Byte for byte the raw transcript. */
  untouched: boolean;
  /** Words in the longest sentence or line. */
  longestSentence: number;
  /** Whether a run-on came back broken up within the case's `maxSentenceWords`; null when it sets none. */
  split: boolean | null;
  /**
   * The message the speaker would have typed: an accepted reference's words
   * and lines, every fix and drop landed, nothing kept lost, and any run-on
   * broken up.
   */
  agentReady: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count++;
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Copies of a kept span, letter for letter except the first one's case:
 * capitalising the word a sentence opens with is cleanup, not a change.
 */
function countKept(haystack: string, keep: string): number {
  const [first = "", ...rest] = [...keep];
  const lead =
    first.toLowerCase() === first.toUpperCase()
      ? escapeRegExp(first)
      : `[${first.toLowerCase()}${first.toUpperCase()}]`;
  return haystack.match(new RegExp(lead + escapeRegExp(rest.join("")), "gu"))?.length ?? 0;
}

/**
 * Whole words, any case, with any punctuation or spacing between them: "um"
 * isn't found in "umbrella", and "can you can you" is still the stutter
 * "can you, can you" was.
 */
function countPhrase(haystack: string, phrase: string): number {
  const words = straightenApostrophes(phrase)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .map(escapeRegExp);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${words.join("[\\s\\p{P}]+")}(?![\\p{L}\\p{N}])`,
    "giu"
  );
  return straightenApostrophes(haystack).match(pattern)?.length ?? 0;
}

function straightenApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019]/gu, "'");
}

const DIGIT_RUN_RE = /(?<!\p{N})\p{N}+(?:[.,:]\p{N}+)*(?!\p{N})/gu;

function countDigitRun(haystack: string, run: string): number {
  return (haystack.match(DIGIT_RUN_RE) ?? []).filter((found) => found === run).length;
}

interface KeepCheck {
  label: string;
  count: (text: string) => number;
}

/** Whole protected spans as `scanProtectedSpans` finds them, so `---watch` is no copy of `--watch`. */
function countProtectedSpan(haystack: string, span: string): number {
  return scanProtectedSpans(haystack).filter((found) => found.text === span).length;
}

/**
 * Everything a cleanup must hand back as it was: the code, references, URLs,
 * flags and paths `scanProtectedSpans` finds in the raw transcript, and its
 * numbers, then the case's own keeps. Each must come back as often as the raw
 * transcript has it. A keep that is also a protected span or a number is held
 * to that stricter check.
 */
function keepChecks(entry: CleanupCase): KeepCheck[] {
  const checks: KeepCheck[] = [];
  const seen = new Set<string>();
  for (const { text: span } of scanProtectedSpans(entry.raw)) {
    if (seen.has(span)) continue;
    seen.add(span);
    checks.push({ label: span, count: (text) => countProtectedSpan(text, span) });
  }
  for (const run of entry.raw.match(DIGIT_RUN_RE) ?? []) {
    if (seen.has(run)) continue;
    seen.add(run);
    checks.push({ label: run, count: (text) => countDigitRun(text, run) });
  }
  for (const keep of entry.keep ?? []) {
    if (seen.has(keep)) continue;
    seen.add(keep);
    checks.push({ label: keep, count: (text) => countKept(text, keep) });
  }
  return checks;
}

// A list the cleanup lays out numbers its items: "1. " at the start of a line.
const LIST_ITEM_NUMBER_RE = /^[ \t]*\d{1,2}(?=[.)][ \t])/gmu;
// A number standing as a word, not a digit inside an identifier such as `e2e`.
const STANDALONE_NUMBER_RE = /(?<![\p{L}\p{N}])\p{N}+(?:[.,:]\p{N}+)*(?![\p{L}\p{N}])/gu;

/** Numbers a reference has that the raw transcript doesn't, its list item numbers aside. */
function invented(raw: string, reference: string): string[] {
  const available = countWords(raw.match(STANDALONE_NUMBER_RE) ?? []);
  const extra: string[] = [];
  for (const run of reference.replace(LIST_ITEM_NUMBER_RE, "").match(STANDALONE_NUMBER_RE) ?? []) {
    const left = available.get(run) ?? 0;
    if (left > 0) available.set(run, left - 1);
    else extra.push(run);
  }
  return extra;
}

const SENTENCE_END_RE = /(?<=[.!?])\s+|\n+/u;
const SENTENCE_WORD_RE = /[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu;

/** Words in the longest sentence or line, the way a reader would count them. */
export function longestSentence(text: string): number {
  return Math.max(
    0,
    ...text.split(SENTENCE_END_RE).map((sentence) => sentence.match(SENTENCE_WORD_RE)?.length ?? 0)
  );
}

// Three or more capitals joined by hyphens, as cleanup types a spelling
// ("T-E-R-R-A"), and not part of a longer hyphened word. Two letters or
// lowercase ones are more often an expression or an identifier ("x-y", "a-b-c").
const SPELLING_RE = /(?<![\p{L}\p{N}-])\p{Lu}(?:-\p{Lu}){2,}(?![\p{L}\p{N}-])/gu;

/**
 * `normaliseWords`, with a spelling typed as hyphened capitals read as the
 * word its letters make, which is what it makes of them spoken: "T-E-R-R-A",
 * "T E R R A" and "Terra" are one word, and only the fixes see how the
 * letters were written. Joined first, so a one-letter word beside it ("a")
 * stays its own word.
 */
function cleanupWords(text: string): string[] {
  return normaliseWords(text.replace(SPELLING_RE, (run) => run.replaceAll("-", "")));
}

function lineWords(text: string): string[] {
  return text
    .split("\n")
    .map((line) => cleanupWords(line).join(" "))
    .filter((line) => line.length > 0);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function countWords(words: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function edits(alignment: ReturnType<typeof alignWords>): number {
  return alignment.substitutions + alignment.deletions + alignment.insertions;
}

/** A passage's fixes of one kind, in the order the corpus gives them. */
export function fixesOf(entry: CleanupCase, kind: FixKind): string[] {
  return Object.keys(entry.fixes).filter((fix) => entry.fixes[fix] === kind);
}

export function acceptedReferences(entry: CleanupCase): string[] {
  return [entry.reference, ...(entry.alsoAccept ?? [])];
}

/**
 * Scores one cleaned text against its case. Repairs and breakages are counted
 * per reference word, against whichever accepted reference the text is
 * closest to, with the raw transcript aligned to that same reference.
 */
export function scoreText(entry: CleanupCase, text: string): TextScore {
  const textWords = cleanupWords(text);
  const rawWords = cleanupWords(entry.raw);
  const references = acceptedReferences(entry);

  let best: { words: string[]; text: ReturnType<typeof alignWords> } | null = null;
  for (const reference of references) {
    const words = cleanupWords(reference);
    const alignment = alignWords(words, textWords);
    if (!best || edits(alignment) < edits(best.text)) best = { words, text: alignment };
  }
  const { words: referenceWords, text: textAlignment } = best!;
  const rawAlignment = alignWords(referenceWords, rawWords);

  let repaired = 0;
  let repairable = 0;
  let broken = 0;
  for (let i = 0; i < referenceWords.length; i++) {
    const rawRight = rawAlignment.referenceOps[i] === "match";
    const textRight = textAlignment.referenceOps[i] === "match";
    if (!rawRight) repairable++;
    if (!rawRight && textRight) repaired++;
    if (rawRight && !textRight) broken++;
  }

  const allowed = countWords(rawWords);
  for (const [word, count] of countWords(referenceWords)) {
    allowed.set(word, Math.max(allowed.get(word) ?? 0, count));
  }
  let novelWords = 0;
  for (const word of textWords) {
    const left = allowed.get(word) ?? 0;
    if (left > 0) allowed.set(word, left - 1);
    else novelWords++;
  }
  // Inserted words the raw transcript didn't insert too: kept filler is no
  // addition, but taking some out doesn't pay for words put in elsewhere.
  const rawInserted = countWords(rawAlignment.inserted);
  let addedWords = 0;
  for (const word of textAlignment.inserted) {
    const left = rawInserted.get(word) ?? 0;
    if (left > 0) rawInserted.set(word, left - 1);
    else addedWords++;
  }

  const missedFixes = Object.keys(entry.fixes).filter(
    (fix) => countOccurrences(text, fix) < Math.max(1, countOccurrences(entry.reference, fix))
  );
  const landedOf = (kind: FixKind) =>
    fixesOf(entry, kind).filter((fix) => !missedFixes.includes(fix)).length;
  const drops = entry.drops ?? [];
  const missedDrops = drops.filter(
    (drop) => countPhrase(text, drop) > countPhrase(entry.reference, drop)
  );
  const keeps = keepChecks(entry);
  const lostKeeps = keeps
    .filter((keep) => keep.count(text) < keep.count(entry.raw))
    .map((keep) => keep.label);

  const lines = lineWords(text);
  const matchesReference = references.some((reference) => sameLines(lines, lineWords(reference)));
  const longest = longestSentence(text);
  const split = entry.maxSentenceWords === undefined ? null : longest <= entry.maxSentenceWords;
  return {
    referenceWords: referenceWords.length,
    edits: edits(textAlignment),
    repaired,
    repairable,
    broken,
    novelWords,
    addedWords,
    misreadsLanded: landedOf("misread"),
    formsLanded: landedOf("form"),
    missedFixes,
    dropsLanded: drops.length - missedDrops.length,
    missedDrops,
    keepsKept: keeps.length - lostKeeps.length,
    keepsTotal: keeps.length,
    lostKeeps,
    matchesReference,
    untouched: text === entry.raw,
    longestSentence: longest,
    split,
    agentReady:
      matchesReference &&
      missedFixes.length === 0 &&
      missedDrops.length === 0 &&
      lostKeeps.length === 0 &&
      split !== false,
  };
}

/** The words a passage's unsure spans cover, placed in order so a repeated word is found once each. */
export function locateUncertain(
  raw: string,
  phrases: readonly string[]
): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const phrase of phrases) {
    const from = raw.indexOf(phrase, cursor);
    if (from === -1) throw new Error(`unsure phrase "${phrase}" is not in the raw transcript`);
    spans.push({ from, to: from + phrase.length });
    cursor = from + phrase.length;
  }
  return spans;
}

// Each identifier as an added line of a diff of its own, so only those main's
// diff reading keeps reach the index.
function diffIdentifiers(identifiers: readonly string[]): string[] {
  return diffCodeNames(identifiers.map((identifier) => `+${identifier}`).join("\n"));
}

/**
 * The code names a passage spells out word by word, found as main finds them
 * (`readCodeNames`): its repository's files, its session's repository names
 * and its branch's identifiers indexed and matched by production's own code.
 * None for a passage dictated with no repository.
 */
export function codeNamesOf(entry: CleanupCase): string[] {
  const repositoryNames = entry.session?.repositoryNames ?? [];
  if (!entry.codebase && repositoryNames.length === 0) return [];
  const index = buildCodeNameIndex(entry.codebase?.files ?? [], [
    ...repositoryNames,
    ...diffIdentifiers(entry.codebase?.identifiers ?? []),
  ]);
  return matchCodeNames(entry.raw, index);
}

/**
 * Corpus mistakes that would make a score meaningless, found before any
 * request is paid for. Empty when the corpus is sound.
 */
export function corpusProblems(corpus: readonly CleanupCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of corpus) {
    if (seen.has(entry.id)) problems.push(`${entry.id}: duplicate id`);
    seen.add(entry.id);
    for (const [fix, kind] of Object.entries(entry.fixes)) {
      if (!FIX_KINDS.includes(kind)) {
        problems.push(`${entry.id}: fix "${fix}" is not classed as a misread or a form`);
      }
      if (!entry.reference.includes(fix))
        problems.push(`${entry.id}: fix "${fix}" is not in the reference`);
      if (countOccurrences(entry.raw, fix) >= Math.max(1, countOccurrences(entry.reference, fix))) {
        problems.push(`${entry.id}: fix "${fix}" is already in the raw transcript`);
      }
    }
    for (const drop of entry.drops ?? []) {
      if (countPhrase(entry.raw, drop) <= countPhrase(entry.reference, drop)) {
        problems.push(`${entry.id}: drop "${drop}" leaves nothing to take out`);
      }
    }
    for (const keep of keepChecks(entry)) {
      const required = keep.count(entry.raw);
      if (required === 0) problems.push(`${entry.id}: keep "${keep.label}" is not in the raw`);
      for (const reference of acceptedReferences(entry)) {
        if (keep.count(reference) < required) {
          problems.push(`${entry.id}: keep "${keep.label}" does not survive into "${reference}"`);
        }
      }
    }
    // The prompt keeps numbers as they were transcribed, so a reference can't
    // ask for a digit the speaker's words never were.
    for (const reference of acceptedReferences(entry)) {
      for (const run of invented(entry.raw, reference)) {
        problems.push(`${entry.id}: "${reference}" has the number ${run}, which the raw doesn't`);
      }
    }
    if (entry.maxSentenceWords !== undefined) {
      if (longestSentence(entry.raw) <= entry.maxSentenceWords) {
        problems.push(`${entry.id}: the raw has no sentence over ${entry.maxSentenceWords} words`);
      }
      for (const reference of acceptedReferences(entry)) {
        if (longestSentence(reference) > entry.maxSentenceWords) {
          problems.push(
            `${entry.id}: "${reference}" has a sentence over ${entry.maxSentenceWords} words`
          );
        }
      }
    }
    if (entry.uncertain?.length && entry.style !== "deepgram") {
      problems.push(`${entry.id}: only Deepgram flags unsure words`);
    }
    try {
      locateUncertain(entry.raw, entry.uncertain ?? []);
    } catch (error) {
      problems.push(`${entry.id}: ${(error as Error).message}`);
    }
    for (const identifier of entry.codebase?.identifiers ?? []) {
      if (diffIdentifiers([identifier])[0] !== identifier) {
        problems.push(`${entry.id}: identifier "${identifier}" is not one main reads from a diff`);
      }
    }
    // A code-name passage whose repository gives cleanup no name tests nothing
    // its bare twin doesn't.
    if (entry.source === "codenames" && entry.codebase && codeNamesOf(entry).length === 0) {
      problems.push(`${entry.id}: its codebase gives cleanup no code name`);
    }
  }
  return problems;
}

export interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  cachedInput: number;
  /** Input written to the prompt cache, for its default 30-minute lifetime. */
  cacheWrite: number;
  output: number;
}

/**
 * Standard-tier text prices, as published on each model's page on 2026-10-27.
 * A cache write costs 1.25 times the input rate (OpenAI's prompt caching guide).
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-6.1-terra": { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  /** Uncached input written to the cache; absent from a run that didn't record it. */
  cacheWriteTokens?: number;
  outputTokens: number;
}

/**
 * Dollars for one request. Cached and cache-written tokens are part of
 * `inputTokens` and reasoning tokens part of `outputTokens`, so none is
 * counted twice. Null when the model has no price or the reply carried no usage.
 */
export function requestCost(model: string, usage: TokenUsage | undefined): number | null {
  const price = MODEL_PRICES[model];
  if (!price || !usage) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const written = Math.min(uncached, usage.cacheWriteTokens ?? 0);
  return (
    ((uncached - written) * price.input +
      written * price.cacheWrite +
      usage.cachedTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

/** Nearest-rank, the convention the replay benchmark uses. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** A deterministic shuffle, so a seed replays the same request order. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What became of one passage. */
export type Disposition = "applied" | "declined" | "rejected" | "failed" | "skipped";

/** A reply landed as production lands it: what a send would carry. */
export interface Landing {
  disposition: Disposition;
  rejectReason?: string;
  landed: string;
  landedScore: TextScore;
}

export interface Trial {
  caseId: string;
  /** `model:effort/prompt`. */
  variant: string;
  repeat: number;
  /** The reply as it parsed, before any check; absent when the request failed or was skipped. */
  reply?: { action: "no_change" | "replace"; correctedText: string; confidence: string };
  /** What the model proposed: its replacement, else the raw transcript. */
  proposal: string;
  proposalScore: TextScore;
  /** The reply landed through production's command and confidence checks. */
  landing: Landing;
  /** The service's own round trip, request out to reply read. */
  roundTripMs: number | null;
  /** Request out to the first corrected text a streamed reply showed; absent when it didn't stream or showed none. */
  firstTextMs?: number | null;
  /** All of `correct()`, the wait for a preconnect and the checks included. */
  totalMs: number;
  usage?: TokenUsage & { cacheWriteTokens: number; reasoningTokens: number };
  costUsd: number | null;
}

export interface QualitySummary {
  /** Reference words repaired over those the raw transcripts had wrong. */
  repairRate: number;
  /** The denominators, so a cohort with none of a check reads as such. */
  totals: {
    repairable: number;
    misreads: number;
    forms: number;
    drops: number;
    keeps: number;
    splits: number;
  };
  broken: number;
  novelWords: number;
  addedWords: number;
  /** Trials that lost a word or a kept span the raw transcript had right, or added a word it never said. */
  trialsWithMeaningRisk: number;
  /** Misread fixes landed: the score a model or prompt choice rests on. */
  misreadRate: number;
  /** Form fixes landed: how it's written, which an agent reads right either way. */
  formRate: number;
  dropRate: number;
  keepRate: number;
  /** Run-ons broken up, over the trials of passages that set `maxSentenceWords`. */
  splitRate: number;
  referenceMatchRate: number;
  /** Trials whose text was the message the speaker would have typed (`TextScore.agentReady`). */
  agentReadyRate: number;
  /** Pooled over normalised reference words. */
  rawWer: number;
  wer: number;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  /** Share of requests that took longer than SEND_WAIT_TARGET_MS. */
  overTarget: number;
}

export interface VariantSummary {
  variant: string;
  trials: number;
  dispositions: Record<Disposition, number>;
  rejectReasons: Record<string, number>;
  landed: QualitySummary;
  proposed: QualitySummary;
  /** Passages already right that came back byte for byte. */
  cleanUntouched: { kept: number; of: number };
  /** Requests that came back with a reply the service could read; failures are left out. */
  roundTrip: LatencySummary;
  promptLengthRoundTrip: LatencySummary;
  /** Request out to the first corrected text, for a streamed run: when the composer starts to change. */
  firstText: LatencySummary;
  promptLengthFirstText: LatencySummary;
  /** Every trial's whole `correct()`, failures and the wait for a preconnect included. */
  total: LatencySummary;
  tokens: {
    meanInput: number;
    cachedShare: number;
    meanOutput: number;
    meanReasoning: number;
    cacheWrites: number;
  };
  meanCostUsd: number | null;
  totalCostUsd: number | null;
}

/** A lost or changed word the raw had right, a word it never said, or a kept span gone. */
export function hasMeaningRisk(score: TextScore): boolean {
  return (
    score.broken > 0 || score.novelWords > 0 || score.addedWords > 0 || score.lostKeeps.length > 0
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function summariseQuality(
  rows: ReadonlyArray<{ entry: CleanupCase; score: TextScore }>
): QualitySummary {
  let repaired = 0;
  let repairable = 0;
  let broken = 0;
  let novelWords = 0;
  let addedWords = 0;
  let risky = 0;
  let misreads = 0;
  let misreadsTotal = 0;
  let forms = 0;
  let formsTotal = 0;
  let drops = 0;
  let dropsTotal = 0;
  let keeps = 0;
  let keepsTotal = 0;
  let splits = 0;
  let splitsTotal = 0;
  let matches = 0;
  let ready = 0;
  let rawEdits = 0;
  let rawReferenceWords = 0;
  let textEdits = 0;
  let referenceWords = 0;
  for (const { entry, score } of rows) {
    repaired += score.repaired;
    repairable += score.repairable;
    broken += score.broken;
    novelWords += score.novelWords;
    addedWords += score.addedWords;
    if (hasMeaningRisk(score)) risky++;
    misreads += score.misreadsLanded;
    forms += score.formsLanded;
    misreadsTotal += fixesOf(entry, "misread").length;
    formsTotal += fixesOf(entry, "form").length;
    drops += score.dropsLanded;
    dropsTotal += entry.drops?.length ?? 0;
    keeps += score.keepsKept;
    keepsTotal += score.keepsTotal;
    if (score.split !== null) splitsTotal++;
    if (score.split === true) splits++;
    if (score.matchesReference) matches++;
    if (score.agentReady) ready++;
    // Against the reference the raw transcript is closest to, which needn't be
    // the one this text is: the baseline must be the same for every variant.
    const raw = scoreText(entry, entry.raw);
    rawEdits += raw.edits;
    rawReferenceWords += raw.referenceWords;
    textEdits += score.edits;
    referenceWords += score.referenceWords;
  }
  return {
    repairRate: ratio(repaired, repairable),
    totals: {
      repairable,
      misreads: misreadsTotal,
      forms: formsTotal,
      drops: dropsTotal,
      keeps: keepsTotal,
      splits: splitsTotal,
    },
    broken,
    novelWords,
    addedWords,
    trialsWithMeaningRisk: risky,
    misreadRate: ratio(misreads, misreadsTotal),
    formRate: ratio(forms, formsTotal),
    dropRate: ratio(drops, dropsTotal),
    keepRate: ratio(keeps, keepsTotal),
    splitRate: ratio(splits, splitsTotal),
    referenceMatchRate: ratio(matches, rows.length),
    agentReadyRate: ratio(ready, rows.length),
    rawWer: ratio(rawEdits, rawReferenceWords),
    wer: ratio(textEdits, referenceWords),
  };
}

function summariseLatency(values: readonly number[]): LatencySummary {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
    overTarget: ratio(values.filter((ms) => ms > SEND_WAIT_TARGET_MS).length, values.length),
  };
}

function firstTexts(rows: ReadonlyArray<{ trial: Trial }>): number[] {
  return rows.flatMap(({ trial }) =>
    typeof trial.firstTextMs === "number" ? [trial.firstTextMs] : []
  );
}

/** One variant's trials: what landed, what the model proposed, and what the requests took. */
export function summariseVariant(
  variant: string,
  trials: readonly Trial[],
  corpus: readonly CleanupCase[]
): VariantSummary {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const rows = trials
    .filter((trial) => trial.variant === variant)
    .map((trial) => ({ trial, entry: byId.get(trial.caseId)!, landing: trial.landing }))
    .filter((row) => row.entry && row.landing);
  const dispositions: Record<Disposition, number> = {
    applied: 0,
    declined: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
  const rejectReasons: Record<string, number> = {};
  for (const { landing } of rows) {
    dispositions[landing.disposition]++;
    if (landing.rejectReason) {
      rejectReasons[landing.rejectReason] = (rejectReasons[landing.rejectReason] ?? 0) + 1;
    }
  }
  const clean = rows.filter(({ entry }) => entry.raw === entry.reference);
  // A request that failed fast would flatter the cleanups that came back.
  const timed = rows.filter(
    ({ trial, landing }) => trial.roundTripMs !== null && landing.disposition !== "failed"
  );
  const billed = rows.flatMap(({ trial }) => (trial.usage ? [trial.usage] : []));
  const costs = rows.map(({ trial }) => trial.costUsd);
  const knownCosts = costs.every((cost) => cost !== null) ? (costs as number[]) : null;
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const totalInput = sum(billed.map((usage) => usage.inputTokens));
  return {
    variant,
    trials: rows.length,
    dispositions,
    rejectReasons,
    landed: summariseQuality(
      rows.map(({ entry, landing }) => ({ entry, score: landing.landedScore }))
    ),
    proposed: summariseQuality(
      rows.map(({ entry, trial }) => ({ entry, score: trial.proposalScore }))
    ),
    cleanUntouched: {
      kept: clean.filter(({ landing }) => landing.landedScore.untouched).length,
      of: clean.length,
    },
    roundTrip: summariseLatency(timed.map(({ trial }) => trial.roundTripMs!)),
    promptLengthRoundTrip: summariseLatency(
      timed
        .filter(({ entry }) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS)
        .map(({ trial }) => trial.roundTripMs!)
    ),
    firstText: summariseLatency(firstTexts(timed)),
    promptLengthFirstText: summariseLatency(
      firstTexts(timed.filter(({ entry }) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS))
    ),
    total: summariseLatency(rows.map(({ trial }) => trial.totalMs)),
    tokens: {
      meanInput: ratio(totalInput, billed.length),
      cachedShare: ratio(sum(billed.map((usage) => usage.cachedTokens)), totalInput),
      meanOutput: ratio(sum(billed.map((usage) => usage.outputTokens)), billed.length),
      meanReasoning: ratio(sum(billed.map((usage) => usage.reasoningTokens)), billed.length),
      cacheWrites: sum(billed.map((usage) => usage.cacheWriteTokens)),
    },
    meanCostUsd: knownCosts && knownCosts.length ? sum(knownCosts) / knownCosts.length : null,
    totalCostUsd: knownCosts ? sum(knownCosts) : null,
  };
}
