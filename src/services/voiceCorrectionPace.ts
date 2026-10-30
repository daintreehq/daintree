/**
 * How long a dictated passage's AI cleanup takes on this machine, learned
 * from the ones that came back, so a send waiting on one can show its pace.
 *
 * A cleanup is the request and the model's thinking until its first text,
 * then the text itself, which runs to about the passage's length. The two are
 * learned apart, so a long think never reads as slow writing, and for each
 * model and effort apart, so a change of either starts from its own pace
 * rather than the last one's. Each part is a line through the passage's
 * length, since a longer passage takes longer to read and think about as well
 * as to write, fitted by least squares with older cleanups weighing less each
 * time a new one lands. Two points on a prior line seed each fit: a cleanup
 * without reasoning starts with no thinking time in it.
 *
 * Device-local and best effort: a blocked or corrupt store reads as the prior.
 * Nothing is kept but lengths and timings.
 */

import { isVoiceCleanupModel, type VoiceReasoningEffort } from "@shared/config/voiceCorrection";
import type { VoiceCorrectionModel, VoiceCorrectionPace } from "@shared/types/ipc/api";

const STORAGE_PREFIX = "daintree-voice-cleanup-pace:";
// One fit of whole cleanups across every model and effort, which can't be
// split into either part.
const RETIRED_STORAGE_KEY = "daintree-voice-correction-pace";
const EFFORTS: readonly VoiceReasoningEffort[] = ["none", "low", "medium", "high"];

/** Each landed cleanup keeps this much of the weight of those before it. */
const DECAY = 0.8;
// Haiku 5.5 on the cleanup benchmark (`npm run perf voice-cleanup`, 2026-10-30).
const PRIOR_REQUEST: Line = { baseMs: 1200, msPerChar: 1.25 };
const PRIOR_THINKING: Line = { baseMs: 100, msPerChar: 3 };
const PRIOR_OUTPUT: Line = { baseMs: 20, msPerChar: 0.8 };
const PRIOR_POINTS = [60, 300];
const PRIOR_WEIGHT = 0.5;
const MAX_MS_PER_CHAR = 20;
const MAX_SAMPLE_MS = 30_000;
// Lengths closer together than a character apart say nothing about the slope.
const MIN_LENGTH_VARIANCE = 1;

interface Line {
  baseMs: number;
  msPerChar: number;
}

interface PaceSums {
  w: number;
  x: number;
  y: number;
  xx: number;
  xy: number;
}

interface Pace {
  firstText: PaceSums;
  output: PaceSums;
}

function firstTextPrior(effort: VoiceReasoningEffort): Line {
  if (effort === "none") return PRIOR_REQUEST;
  return {
    baseMs: PRIOR_REQUEST.baseMs + PRIOR_THINKING.baseMs,
    msPerChar: PRIOR_REQUEST.msPerChar + PRIOR_THINKING.msPerChar,
  };
}

function priorSums(line: Line): PaceSums {
  const sums: PaceSums = { w: 0, x: 0, y: 0, xx: 0, xy: 0 };
  for (const chars of PRIOR_POINTS) {
    addSample(sums, chars, line.baseMs + line.msPerChar * chars, PRIOR_WEIGHT);
  }
  return sums;
}

function priorPace(effort: VoiceReasoningEffort): Pace {
  return { firstText: priorSums(firstTextPrior(effort)), output: priorSums(PRIOR_OUTPUT) };
}

function addSample(sums: PaceSums, chars: number, ms: number, weight: number): void {
  sums.w += weight;
  sums.x += weight * chars;
  sums.y += weight * ms;
  sums.xx += weight * chars * chars;
  sums.xy += weight * chars * ms;
}

function decay(sums: PaceSums): void {
  for (const key of ["w", "x", "y", "xx", "xy"] as const) sums[key] *= DECAY;
}

/**
 * The fitted line at `chars`, drawn through the weighted mean of what was
 * seen, so a run of equal lengths still lands where they did, on the prior's
 * slope. No slope so steep that a shorter passage would take no time at all.
 */
function fitAt(s: PaceSums, prior: Line, chars: number): number {
  const meanX = s.x / s.w;
  const meanY = s.y / s.w;
  const variance = s.xx / s.w - meanX * meanX;
  const fitted =
    variance >= MIN_LENGTH_VARIANCE
      ? Math.max(0, (s.xy / s.w - meanX * meanY) / variance)
      : prior.msPerChar;
  const slope = Math.min(MAX_MS_PER_CHAR, fitted, meanX > 0 ? meanY / meanX : fitted);
  return Math.max(0, meanY + slope * (Math.max(0, chars) - meanX));
}

function paceAt(pace: Pace, effort: VoiceReasoningEffort, chars: number): number {
  return (
    fitAt(pace.firstText, firstTextPrior(effort), chars) + fitAt(pace.output, PRIOR_OUTPUT, chars)
  );
}

function isPaceSums(value: unknown): value is PaceSums {
  if (typeof value !== "object" || value === null) return false;
  const finite = (["w", "x", "y", "xx", "xy"] as const).every((key) => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === "number" && Number.isFinite(field);
  });
  // No fit this module writes weighs less than its prior.
  return finite && (value as PaceSums).w >= PRIOR_WEIGHT;
}

function isPace(value: unknown): value is Pace {
  return (
    typeof value === "object" &&
    value !== null &&
    isPaceSums(Reflect.get(value, "firstText")) &&
    isPaceSums(Reflect.get(value, "output"))
  );
}

// Every project view reads and writes the one stored fit for each model and
// effort, so a cleanup one view records reaches the next estimate in all of
// them. A fit this view couldn't store stands in for the stored one until a
// write goes through.
const unsaved = new Map<string, Pace>();

function readPace(key: string, effort: VoiceReasoningEffort): Pace {
  const kept = unsaved.get(key);
  if (kept) return kept;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (isPace(parsed)) return parsed;
  } catch {
    // Blocked or corrupt: the prior.
  }
  return priorPace(effort);
}

/** The expected time for a cleanup at `effort` on `model` of a passage `chars` long. */
export function estimateCorrectionMs(
  model: VoiceCorrectionModel,
  effort: VoiceReasoningEffort,
  chars: number
): number {
  const ms = paceAt(readPace(`${model}:${effort}`, effort), effort, chars);
  // Sums that parse but can't have come from real cleanups read as the prior.
  return Number.isFinite(ms) ? ms : paceAt(priorPace(effort), effort, chars);
}

/** Counts a passage `chars` long whose cleanup came back, by what it ran on and how long each part took. */
export function recordCorrectionPace(chars: number, sample: VoiceCorrectionPace): void {
  const { model, effort, firstTextMs, outputMs } = sample;
  if (chars <= 0 || !isVoiceCleanupModel(model) || !EFFORTS.includes(effort)) return;
  const valid = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms <= MAX_SAMPLE_MS;
  if (!valid(firstTextMs) || !valid(outputMs)) return;
  const key = `${model}:${effort}`;
  const pace = readPace(key, effort);
  decay(pace.firstText);
  decay(pace.output);
  addSample(pace.firstText, chars, firstTextMs, 1);
  addSample(pace.output, chars, outputMs, 1);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(pace));
    unsaved.delete(key);
    window.localStorage.removeItem(RETIRED_STORAGE_KEY);
  } catch {
    // Quota or blocked storage: the fit still holds for this session.
    unsaved.set(key, pace);
  }
}
