import { alignWords, normaliseWords } from "../../../e2e/helpers/voiceReplayScore";
import { scanProtectedSpans } from "../../../shared/utils/voiceProtectedSpans";
import type { CleanupCase } from "./voiceCleanupCorpus";

/**
 * Scoring for the dictation cleanup benchmark (`npm run perf voice-cleanup`).
 * Pure, so the script and the unit tests share one definition of each number.
 *
 * Word scores run over `normaliseWords`, which ignores case, punctuation and
 * spacing, so they say whether the right words came through in the right
 * order. Whether they were written right (`--watch`, `useShallow`, a numbered
 * list) is what `fixes` checks, character for character, and whether the code,
 * references, flags, paths and numbers the speaker gave came through untouched
 * is what the keep checks see, since the word scores can't.
 */

export const VOICE_CLEANUP_SCHEMA_VERSION = 2;
// Bump when a definition below changes, so runs scored differently aren't compared.
export const VOICE_CLEANUP_SCORING_VERSION = 2;

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
  fixesLanded: number;
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
  const words = phrase
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .map(escapeRegExp);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${words.join("[\\s\\p{P}]+")}(?![\\p{L}\\p{N}])`,
    "giu"
  );
  return haystack.match(pattern)?.length ?? 0;
}

const DIGIT_RUN_RE = /(?<!\p{N})\p{N}+(?:[.,:]\p{N}+)*(?!\p{N})/gu;

function countDigitRun(haystack: string, run: string): number {
  return (haystack.match(DIGIT_RUN_RE) ?? []).filter((found) => found === run).length;
}

interface KeepCheck {
  label: string;
  count: (text: string) => number;
}

/**
 * Everything a cleanup must hand back as it was: the case's own keeps, and the
 * code, references, URLs, flags, paths and numbers in the raw transcript, by
 * the rule the meaning guard enforces. Each must come back as often as the raw
 * transcript has it.
 */
function keepChecks(entry: CleanupCase): KeepCheck[] {
  const checks: KeepCheck[] = (entry.keep ?? []).map((keep) => ({
    label: keep,
    count: (text) => countKept(text, keep),
  }));
  const seen = new Set(entry.keep ?? []);
  for (const { text: span } of scanProtectedSpans(entry.raw)) {
    if (seen.has(span)) continue;
    seen.add(span);
    checks.push({ label: span, count: (text) => countOccurrences(text, span) });
  }
  for (const run of entry.raw.match(DIGIT_RUN_RE) ?? []) {
    if (seen.has(run)) continue;
    seen.add(run);
    checks.push({ label: run, count: (text) => countDigitRun(text, run) });
  }
  return checks;
}

function lineWords(text: string): string[] {
  return text
    .split("\n")
    .map((line) => normaliseWords(line).join(" "))
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

export function acceptedReferences(entry: CleanupCase): string[] {
  return [entry.reference, ...(entry.alsoAccept ?? [])];
}

/**
 * Scores one cleaned text against its case. Repairs and breakages are counted
 * per reference word, against whichever accepted reference the text is
 * closest to, with the raw transcript aligned to that same reference.
 */
export function scoreText(entry: CleanupCase, text: string): TextScore {
  const textWords = normaliseWords(text);
  const rawWords = normaliseWords(entry.raw);
  const references = acceptedReferences(entry);

  let best: { words: string[]; text: ReturnType<typeof alignWords> } | null = null;
  for (const reference of references) {
    const words = normaliseWords(reference);
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

  const missedFixes = entry.fixes.filter(
    (fix) => countOccurrences(text, fix) < Math.max(1, countOccurrences(entry.reference, fix))
  );
  const drops = entry.drops ?? [];
  const missedDrops = drops.filter(
    (drop) => countPhrase(text, drop) > countPhrase(entry.reference, drop)
  );
  const keeps = keepChecks(entry);
  const lostKeeps = keeps
    .filter((keep) => keep.count(text) < keep.count(entry.raw))
    .map((keep) => keep.label);

  const lines = lineWords(text);
  return {
    referenceWords: referenceWords.length,
    edits: edits(textAlignment),
    repaired,
    repairable,
    broken,
    novelWords,
    addedWords,
    fixesLanded: entry.fixes.length - missedFixes.length,
    missedFixes,
    dropsLanded: drops.length - missedDrops.length,
    missedDrops,
    keepsKept: keeps.length - lostKeeps.length,
    keepsTotal: keeps.length,
    lostKeeps,
    matchesReference: references.some((reference) => sameLines(lines, lineWords(reference))),
    untouched: text === entry.raw,
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
    for (const fix of entry.fixes) {
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
    if (entry.uncertain?.length && entry.style !== "deepgram") {
      problems.push(`${entry.id}: only Deepgram flags unsure words`);
    }
    try {
      locateUncertain(entry.raw, entry.uncertain ?? []);
    } catch (error) {
      problems.push(`${entry.id}: ${(error as Error).message}`);
    }
  }
  return problems;
}

export interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  cachedInput: number;
  output: number;
}

/** Standard-tier text prices, as published on each model's page on 2026-10-27. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-6.1-terra": { input: 1, cachedInput: 0.05, output: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * Dollars for one request. Cached tokens are part of `inputTokens` and
 * reasoning tokens part of `outputTokens`, so neither is counted twice.
 * Null when the model has no price or the reply carried no usage.
 */
export function requestCost(model: string, usage: TokenUsage | undefined): number | null {
  const price = MODEL_PRICES[model];
  if (!price || !usage) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (uncached * price.input +
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

export interface Trial {
  caseId: string;
  variant: string;
  repeat: number;
  disposition: Disposition;
  rejectReason?: string;
  /** What the service handed back: the text a send would carry. */
  landed: string;
  /** What the model proposed, before the checks: the landed text unless it was rejected. */
  proposal: string;
  landedScore: TextScore;
  proposalScore: TextScore;
  /** The service's own round trip, request out to reply read. */
  roundTripMs: number | null;
  /** All of `correct()`, the wait for a preconnect and the checks included. */
  totalMs: number;
  usage?: TokenUsage & { cacheWriteTokens: number; reasoningTokens: number };
  costUsd: number | null;
}

export interface QualitySummary {
  /** Reference words repaired over those the raw transcripts had wrong. */
  repairRate: number;
  /** The denominators, so a cohort with none of a check reads as such. */
  totals: { repairable: number; fixes: number; drops: number; keeps: number };
  broken: number;
  novelWords: number;
  addedWords: number;
  /** Trials that lost a word the raw transcript had right, or added one it never said. */
  trialsWithMeaningRisk: number;
  fixRate: number;
  dropRate: number;
  keepRate: number;
  referenceMatchRate: number;
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
  let fixes = 0;
  let fixesTotal = 0;
  let drops = 0;
  let dropsTotal = 0;
  let keeps = 0;
  let keepsTotal = 0;
  let matches = 0;
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
    if (score.broken > 0 || score.novelWords > 0 || score.addedWords > 0) risky++;
    fixes += score.fixesLanded;
    fixesTotal += entry.fixes.length;
    drops += score.dropsLanded;
    dropsTotal += entry.drops?.length ?? 0;
    keeps += score.keepsKept;
    keepsTotal += score.keepsTotal;
    if (score.matchesReference) matches++;
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
    totals: { repairable, fixes: fixesTotal, drops: dropsTotal, keeps: keepsTotal },
    broken,
    novelWords,
    addedWords,
    trialsWithMeaningRisk: risky,
    fixRate: ratio(fixes, fixesTotal),
    dropRate: ratio(drops, dropsTotal),
    keepRate: ratio(keeps, keepsTotal),
    referenceMatchRate: ratio(matches, rows.length),
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

export function summariseVariant(
  variant: string,
  trials: readonly Trial[],
  corpus: readonly CleanupCase[]
): VariantSummary {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const rows = trials
    .filter((trial) => trial.variant === variant)
    .map((trial) => ({ trial, entry: byId.get(trial.caseId)! }))
    .filter((row) => row.entry);
  const dispositions: Record<Disposition, number> = {
    applied: 0,
    declined: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
  const rejectReasons: Record<string, number> = {};
  for (const { trial } of rows) {
    dispositions[trial.disposition]++;
    if (trial.rejectReason) {
      rejectReasons[trial.rejectReason] = (rejectReasons[trial.rejectReason] ?? 0) + 1;
    }
  }
  const clean = rows.filter(({ entry }) => entry.raw === entry.reference);
  // A request that failed fast would flatter the cleanups that came back.
  const timed = rows.filter(
    ({ trial }) => trial.roundTripMs !== null && trial.disposition !== "failed"
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
    landed: summariseQuality(rows.map(({ entry, trial }) => ({ entry, score: trial.landedScore }))),
    proposed: summariseQuality(
      rows.map(({ entry, trial }) => ({ entry, score: trial.proposalScore }))
    ),
    cleanUntouched: {
      kept: clean.filter(({ trial }) => trial.landedScore.untouched).length,
      of: clean.length,
    },
    roundTrip: summariseLatency(timed.map(({ trial }) => trial.roundTripMs!)),
    promptLengthRoundTrip: summariseLatency(
      timed
        .filter(({ entry }) => entry.raw.length >= PROMPT_LENGTH_MIN_CHARS)
        .map(({ trial }) => trial.roundTripMs!)
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
