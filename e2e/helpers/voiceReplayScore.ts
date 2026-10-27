import { createHash } from "node:crypto";

/**
 * Scoring for the dictation replay benchmark (`npm run perf voice-replay`).
 * Pure so the spec, the compare script and the unit tests share one definition
 * of every number the benchmark reports.
 */

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
};

// Symbols dictated as words. Dropped like the symbols themselves, so a
// provider that writes `--watch` and one that writes "dash dash watch" heard
// the same thing.
const SPOKEN_SYMBOLS: ReadonlySet<string> = new Set([
  "dash",
  "hyphen",
  "slash",
  "backslash",
  "dot",
  "underscore",
  "colon",
  "semicolon",
  "comma",
  "period",
  "backtick",
  "tilde",
  "plus",
]);

// Where written punctuation stood, kept as a token so it ends a spelled-out
// run exactly as a dictated symbol word does.
const BOUNDARY = "\u0000";

/**
 * camelCase split, lowercase, punctuation and dictated symbols dropped, small
 * number words to digits, and spelled-out runs merged ("n p m" → "npm").
 * Spacing is the one thing a provider may get wrong for free:
 * `VoiceRecordingService` and "voice recording service" are the same words,
 * and so are `src/index.ts` and "src slash index dot ts". WER then measures
 * the words heard rather than how the provider chose to format them.
 */
export function normaliseWords(text: string): string[] {
  const words = text
    // Lower-to-upper and acronym-to-word boundaries only: `E2E` and `TS2345`
    // stay whole, as their spelled-out forms merge.
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, ` ${BOUNDARY} `)
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => NUMBER_WORDS[word] ?? word);
  const merged: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // Only a spelled-out run with a letter in it merges: "t s 2 3" is `ts23`,
    // but "one two" stays two numbers.
    if (run.length > 1 && run.some((char) => /\p{L}/u.test(char))) merged.push(run.join(""));
    else merged.push(...run);
    run = [];
  };
  for (const word of words) {
    // "A P I dot T S" ends the run at the symbol, as `api.ts` does: `api ts`.
    if (word === BOUNDARY || SPOKEN_SYMBOLS.has(word)) {
      flush();
      continue;
    }
    if (word.length === 1) {
      run.push(word);
      continue;
    }
    flush();
    merged.push(word);
  }
  flush();
  return merged;
}

export type AlignmentOp = "match" | "sub" | "del" | "ins";

export interface Alignment {
  substitutions: number;
  deletions: number;
  insertions: number;
  /** The op aligned with each reference word, in reference order. */
  referenceOps: AlignmentOp[];
  /** The op aligned with each hypothesis word, in hypothesis order. */
  hypothesisOps: Array<Exclude<AlignmentOp, "del">>;
  /** The hypothesis words aligned as insertions, in hypothesis order. */
  inserted: string[];
}

const DIAGONAL = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * Word-level Levenshtein alignment. Among the paths with the fewest edits it
 * takes the one with the most exact matches, so "commit and push" against
 * "commit push now" keeps `push` matched (a deletion and an insertion) instead
 * of reading it as two substitutions and a lost last word.
 */
export function alignWords(reference: readonly string[], hypothesis: readonly string[]): Alignment {
  const n = reference.length;
  const m = hypothesis.length;
  const grid = () => Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cost = grid();
  const matches = grid();
  const move = grid();
  for (let i = 1; i <= n; i++) {
    cost[i]![0] = i;
    move[i]![0] = DELETE;
  }
  for (let j = 1; j <= m; j++) {
    cost[0]![j] = j;
    move[0]![j] = INSERT;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      const candidates: Array<[number, number, number]> = [
        [cost[i - 1]![j - 1]! + (same ? 0 : 1), matches[i - 1]![j - 1]! + (same ? 1 : 0), DIAGONAL],
        [cost[i - 1]![j]! + 1, matches[i - 1]![j]!, DELETE],
        [cost[i]![j - 1]! + 1, matches[i]![j - 1]!, INSERT],
      ];
      let best = candidates[0]!;
      for (const candidate of candidates) {
        if (candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] > best[1])) {
          best = candidate;
        }
      }
      [cost[i]![j], matches[i]![j], move[i]![j]] = best;
    }
  }

  const referenceOps = new Array<AlignmentOp>(n);
  const hypothesisOps = new Array<Exclude<AlignmentOp, "del">>(m);
  const inserted: string[] = [];
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = move[i]![j];
    if (step === DIAGONAL) {
      const same = reference[i - 1] === hypothesis[j - 1];
      referenceOps[i - 1] = same ? "match" : "sub";
      hypothesisOps[j - 1] = same ? "match" : "sub";
      if (!same) substitutions++;
      i--;
      j--;
    } else if (step === DELETE) {
      referenceOps[i - 1] = "del";
      deletions++;
      i--;
    } else {
      insertions++;
      hypothesisOps[j - 1] = "ins";
      inserted.unshift(hypothesis[j - 1]!);
      j--;
    }
  }
  return { substitutions, deletions, insertions, referenceOps, hypothesisOps, inserted };
}

/**
 * A term counts as recalled when its compact form (normalised words, joined)
 * equals a run of hypothesis words joined. Spacing is the one thing a provider
 * may get wrong for free: "use effect" recalls `useEffect` and `nextjs` recalls
 * "Next.js", but "use affect" recalls nothing.
 */
export function termRecalled(term: string, hypothesisWords: readonly string[]): boolean {
  const compact = normaliseWords(term).join("");
  if (compact.length === 0) return true;
  for (let start = 0; start < hypothesisWords.length; start++) {
    let joined = "";
    for (let end = start; end < hypothesisWords.length && joined.length < compact.length; end++) {
      joined += hypothesisWords[end];
      if (joined === compact) return true;
    }
  }
  return false;
}

export interface ClipScore {
  referenceWords: number;
  hypothesisWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** (S + D + I) / N over normalised words. */
  wer: number;
  termsTotal: number;
  termsRecalled: number;
  missedTerms: string[];
  firstWordKept: boolean;
  lastWordKept: boolean;
}

export function scoreClip(
  reference: string,
  hypothesis: string,
  terms: readonly string[]
): ClipScore {
  const ref = normaliseWords(reference);
  const hyp = normaliseWords(hypothesis);
  const alignment = alignWords(ref, hyp);
  const edits = alignment.substitutions + alignment.deletions + alignment.insertions;
  const missedTerms = terms.filter((term) => !termRecalled(term, hyp));
  return {
    referenceWords: ref.length,
    hypothesisWords: hyp.length,
    substitutions: alignment.substitutions,
    deletions: alignment.deletions,
    insertions: alignment.insertions,
    wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : edits / ref.length,
    termsTotal: terms.length,
    termsRecalled: terms.length - missedTerms.length,
    missedTerms,
    firstWordKept: alignment.referenceOps[0] === "match",
    lastWordKept: alignment.referenceOps[ref.length - 1] === "match",
  };
}

/**
 * Milliseconds from the key press that started the session, on the renderer's
 * clock. Null when the session never reached that point.
 */
export interface SessionTiming {
  /**
   * getUserMedia resolved. The fake microphone file starts playing about here:
   * acquisition, not the first sample delivered, so the stop is scheduled from
   * an approximation.
   */
  micOpenMs: number | null;
  /** First `recording` status: the provider is ready and audio is streaming. */
  recordingMs: number | null;
  firstDeltaMs: number | null;
  firstFinalMs: number | null;
  /** The key press that stopped the session. */
  stopMs: number | null;
  /** How far the stop press landed after the clip's planned end. */
  stopLateMs: number | null;
  /**
   * From the stop press to the last final transcript. Negative when the last
   * final arrived before the stop.
   */
  stopToLastFinalMs: number | null;
  /** From the stop press to `session-ended`. */
  stopToEndedMs: number | null;
  /** Clip length played as the microphone. */
  audioMs: number;
}

export const TIMING_KEYS = [
  "micOpenMs",
  "recordingMs",
  "firstDeltaMs",
  "firstFinalMs",
  "stopToLastFinalMs",
  "stopToEndedMs",
] as const satisfies readonly (keyof SessionTiming)[];

export type TimingKey = (typeof TIMING_KEYS)[number];

/** The processing the session's microphone track reported running. */
export interface MicTrackProcessing {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface SessionResult {
  clip: string;
  config: string;
  repeat: number;
  /** The final transcripts the pipeline emitted, joined in arrival order. This is what's scored. */
  hypothesis: string;
  /** What the composer held after the session ended, for inspection; not scored. */
  draft: string | null;
  score: ClipScore;
  timing: SessionTiming;
  /** Every status the session reported, in order, so a reconnect is visible. */
  statuses: string[];
  /** `session-ended` reason. `stopped` means it drained, not that every word arrived. */
  endReason: string | null;
  errors: string[];
  /** Null when no microphone opened; absent from runs that predate it. */
  mic?: MicTrackProcessing | null;
}

export interface TimingStat {
  median: number | null;
  p95: number | null;
  /** Sessions that reached this point; the rest are null in their rows. */
  count: number;
}

export interface ConfigSummary {
  config: string;
  sessions: number;
  /** Total edits over total reference words, so long clips weigh more. */
  pooledWer: number;
  meanWer: number;
  termRecall: number;
  firstWordKeptRate: number;
  lastWordKeptRate: number;
  erroredSessions: number;
  timing: Record<TimingKey, TimingStat>;
}

/** A short content hash, for telling a changed reference or WAV from a changed result. */
export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summariseConfig(config: string, sessions: readonly SessionResult[]): ConfigSummary {
  const rows = sessions.filter((session) => session.config === config);
  let edits = 0;
  let referenceWords = 0;
  let termsTotal = 0;
  let termsRecalled = 0;
  for (const { score } of rows) {
    edits += score.substitutions + score.deletions + score.insertions;
    referenceWords += score.referenceWords;
    termsTotal += score.termsTotal;
    termsRecalled += score.termsRecalled;
  }
  const timing = {} as Record<TimingKey, TimingStat>;
  for (const key of TIMING_KEYS) {
    const values = rows
      .map((row) => row.timing[key])
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    timing[key] = { median: median(values), p95: percentile(values, 95), count: values.length };
  }
  return {
    config,
    sessions: rows.length,
    pooledWer: ratio(edits, referenceWords),
    meanWer: ratio(
      rows.reduce((sum, row) => sum + row.score.wer, 0),
      rows.length
    ),
    termRecall: ratio(termsRecalled, termsTotal),
    firstWordKeptRate: ratio(rows.filter((row) => row.score.firstWordKept).length, rows.length),
    lastWordKeptRate: ratio(rows.filter((row) => row.score.lastWordKept).length, rows.length),
    erroredSessions: rows.filter((row) => row.errors.length > 0 || row.endReason !== "stopped")
      .length,
    timing,
  };
}

export const VOICE_REPLAY_SCHEMA_VERSION = 1;

/**
 * Bumped whenever `normaliseWords` or `termRecalled` changes meaning: scores
 * from two versions measure different things and are never compared.
 */
export const VOICE_REPLAY_SCORING_VERSION = 1;

export interface VoiceReplayConfigRecord {
  id: string;
  provider: string;
  /** Settings patch applied for the run. Keys never appear here: they reach the app by env. */
  settings: Record<string, unknown>;
  /** Terms added to the dictionary before dictating, in order. */
  dictionary: string[];
  /** Absent from runs that predate it, which all ran Chromium's default. */
  micProcessing?: "default" | "off";
}

export interface VoiceReplayClipRecord {
  id: string;
  source: "synthesised" | "recorded";
  audioMs: number;
  longestUtteranceMs: number;
  /** Hash of the WAV played, so a new voice or recording reads as a changed clip. */
  audioHash: string;
  /** Hash of the reference and its terms: dropping a term must not read as better recall. */
  referenceHash: string;
}

export interface VoiceReplayRun {
  schemaVersion: number;
  scoringVersion: number;
  label: string;
  createdAt: string;
  /** False while sessions are still being written; a partial run is never a baseline. */
  complete: boolean;
  gitSha: string | null;
  platform: string;
  repeats: number;
  stopTailMs: number;
  configs: VoiceReplayConfigRecord[];
  /** Configs that were asked for but could not run, with the reason. */
  skippedConfigs: Array<{ id: string; reason: string }>;
  clips: VoiceReplayClipRecord[];
  sessions: SessionResult[];
  /**
   * Sessions the harness never got to dictate (a launch or setup that threw).
   * Kept out of every score: they say nothing about the provider.
   */
  failures: Array<{ clip: string; config: string; repeat: number; message: string }>;
  summaries: ConfigSummary[];
}

export interface MetricDelta {
  metric: string;
  baseline: number | null;
  run: number | null;
  /** run − baseline, null when either side is missing. */
  delta: number | null;
  /** Whether a positive delta is an improvement. */
  higherIsBetter: boolean;
}

export interface ConfigComparison {
  config: string;
  /** Sessions (clip and repeat) present on both sides over unchanged clips; only these are compared. */
  sharedSessions: number;
  /** Sessions on one side only, left out of every metric. */
  unmatchedSessions: number;
  /** Whether the two sides ran this config with different settings or dictionary. */
  settingsDiffer: boolean;
  metrics: MetricDelta[];
}

export interface RunComparison {
  configs: ConfigComparison[];
  /** Configs present on one side only. */
  onlyInBaseline: string[];
  onlyInRun: string[];
  /** Clips whose reference, terms or audio changed between the two runs: left out of every metric. */
  changedClips: string[];
  /** Harness differences that move every config's numbers, such as the stop tail. */
  harnessNotes: string[];
}

const ACCURACY_METRICS: ReadonlyArray<{
  metric: string;
  read: (summary: ConfigSummary) => number;
  higherIsBetter: boolean;
}> = [
  { metric: "pooled WER", read: (s) => s.pooledWer, higherIsBetter: false },
  { metric: "mean WER", read: (s) => s.meanWer, higherIsBetter: false },
  { metric: "term recall", read: (s) => s.termRecall, higherIsBetter: true },
  { metric: "first word kept", read: (s) => s.firstWordKeptRate, higherIsBetter: true },
  { metric: "last word kept", read: (s) => s.lastWordKeptRate, higherIsBetter: true },
  { metric: "errored sessions", read: (s) => s.erroredSessions, higherIsBetter: false },
];

function delta(
  metric: string,
  baseline: number | null,
  run: number | null,
  higherIsBetter: boolean
): MetricDelta {
  return {
    metric,
    baseline,
    run,
    delta: baseline !== null && run !== null ? run - baseline : null,
    higherIsBetter,
  };
}

const sessionKey = (session: SessionResult) => `${session.clip}\u0000${session.repeat}`;

/**
 * Compares two runs config by config, over the sessions both sides ran for
 * that config on unchanged clips. Each side is re-summarised over exactly that
 * cohort, so a filtered run, a failed launch or a fixture edit never reads as
 * an accuracy change.
 */
export function compareRuns(baseline: VoiceReplayRun, run: VoiceReplayRun): RunComparison {
  if (baseline.scoringVersion !== run.scoringVersion) {
    throw new Error(
      `scoring version ${baseline.scoringVersion} vs ${run.scoringVersion}: rescore or rerun the baseline`
    );
  }
  const clipIdentity = (clip: VoiceReplayClipRecord) => `${clip.referenceHash}:${clip.audioHash}`;
  const baselineClips = new Map(baseline.clips.map((clip) => [clip.id, clipIdentity(clip)]));
  const changedClips = run.clips
    .filter(
      (clip) => baselineClips.has(clip.id) && baselineClips.get(clip.id) !== clipIdentity(clip)
    )
    .map((clip) => clip.id);
  const changed = new Set(changedClips);

  const baselineConfigs = new Map(baseline.configs.map((config) => [config.id, config]));
  const runConfigs = new Map(run.configs.map((config) => [config.id, config]));

  const configs: ConfigComparison[] = [];
  for (const [id, runConfig] of runConfigs) {
    const baselineConfig = baselineConfigs.get(id);
    if (!baselineConfig) continue;
    const eligible = (source: VoiceReplayRun) =>
      new Map(
        source.sessions
          .filter((session) => session.config === id && !changed.has(session.clip))
          .map((session) => [sessionKey(session), session])
      );
    const before = eligible(baseline);
    const after = eligible(run);
    const shared = [...after.keys()].filter((key) => before.has(key));
    const sharedSet = new Set(shared);
    const unmatched =
      [...before.keys()].filter((key) => !sharedSet.has(key)).length +
      [...after.keys()].filter((key) => !sharedSet.has(key)).length;
    const b = summariseConfig(
      id,
      shared.map((key) => before.get(key)!)
    );
    const r = summariseConfig(
      id,
      shared.map((key) => after.get(key)!)
    );
    const hasRows = shared.length > 0;
    const metrics = ACCURACY_METRICS.map(({ metric, read, higherIsBetter }) =>
      delta(metric, hasRows ? read(b) : null, hasRows ? read(r) : null, higherIsBetter)
    );
    for (const key of TIMING_KEYS) {
      metrics.push(delta(`${key} median`, b.timing[key].median, r.timing[key].median, false));
      metrics.push(delta(`${key} p95`, b.timing[key].p95, r.timing[key].p95, false));
    }
    configs.push({
      config: id,
      sharedSessions: shared.length,
      unmatchedSessions: unmatched,
      settingsDiffer:
        baselineConfig.provider !== runConfig.provider ||
        JSON.stringify(baselineConfig.settings) !== JSON.stringify(runConfig.settings) ||
        JSON.stringify(baselineConfig.dictionary) !== JSON.stringify(runConfig.dictionary) ||
        (baselineConfig.micProcessing ?? "default") !== (runConfig.micProcessing ?? "default"),
      metrics,
    });
  }

  const harnessNotes: string[] = [];
  if (baseline.stopTailMs !== run.stopTailMs) {
    harnessNotes.push(
      `The stop tail moved from ${baseline.stopTailMs} ms to ${run.stopTailMs} ms: last-word survival and stop timings aren't comparable.`
    );
  }

  return {
    configs,
    onlyInBaseline: [...baselineConfigs.keys()].filter((id) => !runConfigs.has(id)),
    onlyInRun: [...runConfigs.keys()].filter((id) => !baselineConfigs.has(id)),
    changedClips,
    harnessNotes,
  };
}

function formatValue(metric: string, value: number | null, signed = false): string {
  if (value === null) return "—";
  const sign = signed && value > 0 ? "+" : "";
  if (metric.endsWith(" median") || metric.endsWith(" p95"))
    return `${sign}${Math.round(value)} ms`;
  if (metric === "errored sessions") return `${sign}${value}`;
  return `${sign}${(value * 100).toFixed(1)}${signed ? " pt" : "%"}`;
}

function verdict(metric: MetricDelta): string {
  if (metric.delta === null || metric.delta === 0) return "";
  return metric.delta > 0 === metric.higherIsBetter ? "better" : "worse";
}

/** The comparison as Markdown: one table per config, then every exclusion that shaped it. */
export function renderComparison(
  baseline: VoiceReplayRun,
  run: VoiceReplayRun,
  comparison: RunComparison
): string {
  const lines = [
    `## Voice replay: ${baseline.label} (${baseline.createdAt}) vs ${run.label} (${run.createdAt})`,
    "",
  ];
  for (const config of comparison.configs) {
    lines.push(
      `### ${config.config}: ${config.sharedSessions} shared session(s)` +
        (config.unmatchedSessions > 0
          ? `, ${config.unmatchedSessions} unmatched and left out`
          : ""),
      ""
    );
    if (config.settingsDiffer) {
      lines.push(
        "Settings or dictionary differ between the two runs: this compares configurations, not code.",
        ""
      );
    }
    lines.push("| Metric | Baseline | Run | Delta | |", "|---|---:|---:|---:|---|");
    for (const metric of config.metrics) {
      lines.push(
        `| ${metric.metric} | ${formatValue(metric.metric, metric.baseline)} | ` +
          `${formatValue(metric.metric, metric.run)} | ${formatValue(metric.metric, metric.delta, true)} | ${verdict(metric)} |`
      );
    }
    lines.push("");
  }
  for (const note of comparison.harnessNotes) lines.push(note);
  if (comparison.changedClips.length > 0) {
    lines.push(`Changed clips, left out: ${comparison.changedClips.join(", ")}`);
  }
  if (comparison.onlyInBaseline.length > 0) {
    lines.push(`Only in the baseline: ${comparison.onlyInBaseline.join(", ")}`);
  }
  if (comparison.onlyInRun.length > 0)
    lines.push(`Only in this run: ${comparison.onlyInRun.join(", ")}`);
  if (run.failures.length > 0) {
    lines.push(`Harness failures in this run: ${run.failures.length} (see its JSON)`);
  }
  lines.push(
    "",
    "One run of each is a reading, not a result: rerun both before trusting a small difference."
  );
  return lines.join("\n");
}
