import { scoreClip, type ClipScore } from "../../../e2e/helpers/voiceReplayScore";
import {
  resolveOpenAITranscriptionTuning,
  type OpenAITranscriptionTuning,
} from "../../../electron/services/voice/openaiTranscriptionTuning";
import { collectSegments, type SessionObservation } from "./voicePreviewFinalScore";

/**
 * Scoring for `npm run perf voice-tuning` (#14625): the same clips through the
 * real OpenAI provider under different delay tiers and segmentation, scored on
 * what lands in the draft (the finals) and when. Pure, so the run, `--rescore`
 * and the unit tests share it.
 */

export const VOICE_TUNING_SCHEMA_VERSION = 1;
export const VOICE_TUNING_SCORING_VERSION = 1;

export interface TuningArm {
  /** As given on the command line, and the key results are filed under. */
  id: string;
  tuning: Readonly<OpenAITranscriptionTuning>;
}

const ARM_RE = /^([a-z]+)(?::(?:cap(\d+(?:\.\d+)?)|gap(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)))?$/;

/**
 * `<delay>` runs production's segmentation at that tier; `<delay>:cap<s>`
 * cuts continuous speech only at a cap of that many seconds; `<delay>:gap<min>-<max>`
 * cuts it at the first short pause after `min` seconds, or at `max`.
 */
export function parseTuningArm(id: string): TuningArm {
  const match = ARM_RE.exec(id);
  if (!match) {
    throw new Error(
      `can't read arm "${id}"; use <delay>, <delay>:cap<s> or <delay>:gap<min>-<max>`
    );
  }
  const [, delay, cap, gapMin, gapMax] = match;
  const seconds = (value: string) => Math.round(Number(value) * 1000);
  const overrides: Partial<OpenAITranscriptionTuning> = {
    delay: delay as OpenAITranscriptionTuning["delay"],
  };
  if (cap !== undefined) {
    overrides.minSegmentMs = null;
    overrides.maxSegmentMs = seconds(cap);
  } else if (gapMin !== undefined && gapMax !== undefined) {
    overrides.minSegmentMs = seconds(gapMin);
    overrides.maxSegmentMs = seconds(gapMax);
  }
  try {
    return { id, tuning: resolveOpenAITranscriptionTuning(overrides) };
  } catch (error) {
    throw new Error(`arm "${id}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface TuningSession extends SessionObservation {
  arm: string;
}

/** Milliseconds from `start()`, null when the session never got there. */
export interface TuningTiming {
  readyMs: number | null;
  firstDeltaMs: number | null;
  firstFinalMs: number | null;
  /** The stop to the last final with words, negative when it landed before the stop. */
  stopToLastFinalMs: number | null;
  /** `stopGracefully()` to its return: how long a send waits on the provider. */
  drainMs: number;
}

export interface ScoredTuningSession {
  arm: string;
  clip: string;
  pass: number;
  hypothesis: string;
  score: ClipScore;
  timing: TuningTiming;
  segments: number;
  /** Segments whose final came back with no words. */
  emptyFinals: number;
  pauses: number;
}

export interface ExcludedTuningSession {
  arm: string;
  clip: string;
  pass: number;
  reasons: string[];
}

export function scoreTuningSession(
  session: TuningSession,
  reference: string,
  terms: readonly string[]
): ScoredTuningSession | ExcludedTuningSession {
  const { segments, anomalies } = collectSegments(session);
  const key = { arm: session.arm, clip: session.clip, pass: session.pass };
  if (anomalies.length > 0) return { ...key, reasons: anomalies };
  const finals = segments.map((segment) => segment.final.trim());
  const worded = session.events.filter(
    (event) => (event.type === "delta" || event.type === "complete") && event.text.trim() !== ""
  );
  const lastFinal = worded.filter((event) => event.type === "complete").at(-1);
  return {
    ...key,
    hypothesis: finals.filter(Boolean).join(" "),
    score: scoreClip(reference, finals.filter(Boolean).join(" "), terms),
    timing: {
      readyMs: session.readyMs,
      firstDeltaMs: worded.find((event) => event.type === "delta")?.at ?? null,
      firstFinalMs: worded.find((event) => event.type === "complete")?.at ?? null,
      stopToLastFinalMs:
        lastFinal && session.stopMs !== undefined ? lastFinal.at - session.stopMs : null,
      drainMs: session.drainMs,
    },
    segments: segments.length,
    emptyFinals: finals.filter((text) => text === "").length,
    pauses: session.vad.pauses ?? 0,
  };
}

export function isExcluded(
  result: ScoredTuningSession | ExcludedTuningSession
): result is ExcludedTuningSession {
  return "reasons" in result;
}

export interface Distribution {
  median: number | null;
  p95: number | null;
  count: number;
}

export const TUNING_TIMING_KEYS = [
  "readyMs",
  "firstDeltaMs",
  "firstFinalMs",
  "stopToLastFinalMs",
  "drainMs",
] as const satisfies readonly (keyof TuningTiming)[];

export interface ArmSummary {
  arm: string;
  sessions: number;
  referenceWords: number;
  /** Total edits over total reference words, so long clips weigh more. */
  pooledWer: number;
  meanWer: number;
  termsTotal: number;
  termRecall: number;
  firstWordKeptRate: number;
  lastWordKeptRate: number;
  segmentsPerSession: number;
  emptyFinals: number;
  timing: Record<(typeof TUNING_TIMING_KEYS)[number], Distribution>;
}

/** Against the first arm, session by session over the same clip and pass. */
export interface PairedDelta {
  arm: string;
  against: string;
  pairs: number;
  /** Mean of this arm's edits minus the other's, per session. */
  meanEditDelta: number;
  fewerEdits: number;
  moreEdits: number;
  sameEdits: number;
  /** Median per-session difference in stop to last final. */
  medianStopToLastFinalDeltaMs: number | null;
}

export interface TuningSummary {
  arms: string[];
  sessions: number;
  excluded: ExcludedTuningSession[];
  /** Clip and pass pairs every arm scored; only these are summarised. */
  cohort: number;
  armSummaries: ArmSummary[];
  paired: PairedDelta[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = sorted(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function distribution(values: readonly (number | null)[]): Distribution {
  const present = sorted(values.filter((value): value is number => value !== null));
  const p95 =
    present.length === 0
      ? null
      : present[Math.max(0, Math.min(present.length - 1, Math.ceil(0.95 * present.length) - 1))]!;
  return { median: median(present), p95, count: present.length };
}

function edits(score: ClipScore): number {
  return score.substitutions + score.deletions + score.insertions;
}

function cohortKey(result: { clip: string; pass: number }): string {
  return `${result.clip}\u0000${result.pass}`;
}

function summariseArm(arm: string, rows: readonly ScoredTuningSession[]): ArmSummary {
  const referenceWords = rows.reduce((n, row) => n + row.score.referenceWords, 0);
  const termsTotal = rows.reduce((n, row) => n + row.score.termsTotal, 0);
  const timing = {} as ArmSummary["timing"];
  for (const key of TUNING_TIMING_KEYS) {
    timing[key] = distribution(rows.map((row) => row.timing[key]));
  }
  return {
    arm,
    sessions: rows.length,
    referenceWords,
    pooledWer: ratio(
      rows.reduce((n, row) => n + edits(row.score), 0),
      referenceWords
    ),
    meanWer: ratio(
      rows.reduce((n, row) => n + row.score.wer, 0),
      rows.length
    ),
    termsTotal,
    termRecall: ratio(
      rows.reduce((n, row) => n + row.score.termsRecalled, 0),
      termsTotal
    ),
    firstWordKeptRate: ratio(rows.filter((row) => row.score.firstWordKept).length, rows.length),
    lastWordKeptRate: ratio(rows.filter((row) => row.score.lastWordKept).length, rows.length),
    segmentsPerSession: ratio(
      rows.reduce((n, row) => n + row.segments, 0),
      rows.length
    ),
    emptyFinals: rows.reduce((n, row) => n + row.emptyFinals, 0),
    timing,
  };
}

/**
 * Every arm over the clip and pass pairs all of them scored, so a session one
 * arm lost can't flatter it by leaving out a hard clip.
 */
export function summariseTuning(
  arms: readonly string[],
  results: readonly (ScoredTuningSession | ExcludedTuningSession)[]
): TuningSummary {
  const excluded = results.filter(isExcluded);
  const scored = results.filter((result): result is ScoredTuningSession => !isExcluded(result));
  const byArm = new Map<string, Map<string, ScoredTuningSession>>();
  for (const arm of arms) byArm.set(arm, new Map());
  for (const result of scored) byArm.get(result.arm)?.set(cohortKey(result), result);
  const [first, ...rest] = arms;
  const cohort = first
    ? [...byArm.get(first)!.keys()].filter((key) => rest.every((arm) => byArm.get(arm)!.has(key)))
    : [];
  const rowsFor = (arm: string) => cohort.map((key) => byArm.get(arm)!.get(key)!);
  const paired: PairedDelta[] = rest.map((arm) => {
    const deltas = cohort.map(
      (key) => edits(byArm.get(arm)!.get(key)!.score) - edits(byArm.get(first!)!.get(key)!.score)
    );
    const timingDeltas = cohort.flatMap((key) => {
      const mine = byArm.get(arm)!.get(key)!.timing.stopToLastFinalMs;
      const theirs = byArm.get(first!)!.get(key)!.timing.stopToLastFinalMs;
      return mine === null || theirs === null ? [] : [mine - theirs];
    });
    return {
      arm,
      against: first!,
      pairs: cohort.length,
      meanEditDelta: ratio(
        deltas.reduce((n, delta) => n + delta, 0),
        deltas.length
      ),
      fewerEdits: deltas.filter((delta) => delta < 0).length,
      moreEdits: deltas.filter((delta) => delta > 0).length,
      sameEdits: deltas.filter((delta) => delta === 0).length,
      medianStopToLastFinalDeltaMs: median(timingDeltas),
    };
  });
  return {
    arms: [...arms],
    sessions: results.length,
    excluded,
    cohort: cohort.length,
    armSummaries: arms.map((arm) => summariseArm(arm, rowsFor(arm))),
    paired,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(stat: Distribution): string {
  return stat.median === null ? "–" : `${Math.round(stat.median)} / ${Math.round(stat.p95!)}`;
}

/** The comparison table, with no transcript text: safe for a terminal. */
export function renderTuningTable(summary: TuningSummary): string[] {
  const lines = [
    `${summary.cohort} clip-and-pass pairs scored by every arm; ${summary.excluded.length} of ${summary.sessions} sessions excluded.`,
    "",
    "| Arm | Pooled WER | Mean WER | Term recall | First word | Last word | Segments | Empty finals | First delta ms | First final ms | Stop to last final ms | Drain ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of summary.armSummaries) {
    lines.push(
      `| ${arm.arm} | ${pct(arm.pooledWer)} | ${pct(arm.meanWer)} | ${pct(arm.termRecall)} | ${pct(arm.firstWordKeptRate)} | ${pct(arm.lastWordKeptRate)} | ${arm.segmentsPerSession.toFixed(2)} | ${arm.emptyFinals} | ${ms(arm.timing.firstDeltaMs)} | ${ms(arm.timing.firstFinalMs)} | ${ms(arm.timing.stopToLastFinalMs)} | ${ms(arm.timing.drainMs)} |`
    );
  }
  lines.push("", "Timings are median / p95.");
  if (summary.paired.length > 0) {
    lines.push(
      "",
      "| Arm | Against | Pairs | Mean edits per session | Fewer / more / same | Median stop to last final |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    for (const pair of summary.paired) {
      const timing = pair.medianStopToLastFinalDeltaMs;
      lines.push(
        `| ${pair.arm} | ${pair.against} | ${pair.pairs} | ${pair.meanEditDelta >= 0 ? "+" : ""}${pair.meanEditDelta.toFixed(2)} | ${pair.fewerEdits} / ${pair.moreEdits} / ${pair.sameEdits} | ${timing === null ? "–" : `${timing >= 0 ? "+" : ""}${Math.round(timing)} ms`} |`
      );
    }
  }
  return lines;
}
