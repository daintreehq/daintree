/**
 * How long a dictated passage's AI correction takes on this machine, learned
 * from the ones that came back, so a send waiting on one can show its pace.
 *
 * A correction is one model call per passage, all in flight at once, so it
 * takes a fixed latency plus a cost per character of the longest passage.
 * That line is fitted by least squares with older corrections weighing less
 * each time a new one lands, so a change of model or network moves it within
 * a few sends. Two points on a prior line seed the fit: the first corrections
 * have a pace to show, and a run of equal-length passages still has a slope.
 *
 * Device-local and best effort: a blocked or corrupt store reads as the prior.
 */

const STORAGE_KEY = "daintree-voice-correction-pace";

/** Each landed correction keeps this much of the weight of those before it. */
const DECAY = 0.8;
const PRIOR_BASE_MS = 700;
const PRIOR_MS_PER_CHAR = 2.5;
const PRIOR_POINTS = [60, 300];
const PRIOR_WEIGHT = 0.5;
const MAX_MS_PER_CHAR = 20;
const MAX_SAMPLE_MS = 30_000;

interface PaceSums {
  w: number;
  x: number;
  y: number;
  xx: number;
  xy: number;
}

function priorSums(): PaceSums {
  const sums: PaceSums = { w: 0, x: 0, y: 0, xx: 0, xy: 0 };
  for (const chars of PRIOR_POINTS) {
    addSample(sums, chars, PRIOR_BASE_MS + PRIOR_MS_PER_CHAR * chars, PRIOR_WEIGHT);
  }
  return sums;
}

function addSample(sums: PaceSums, chars: number, ms: number, weight: number): void {
  sums.w += weight;
  sums.x += weight * chars;
  sums.y += weight * ms;
  sums.xx += weight * chars * chars;
  sums.xy += weight * chars * ms;
}

function isPaceSums(value: unknown): value is PaceSums {
  if (typeof value !== "object" || value === null) return false;
  return (["w", "x", "y", "xx", "xy"] as const).every((key) => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === "number" && Number.isFinite(field);
  });
}

// Every project view reads and writes the one stored fit, so a sample one
// view records reaches the next estimate in all of them. This copy only
// stands in when the store is blocked.
let fallback: PaceSums | null = null;

function readSums(): PaceSums {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (isPaceSums(parsed) && parsed.w > 0) return parsed;
  } catch {
    // Blocked or corrupt: the copy this view kept, else the prior.
  }
  return fallback ?? priorSums();
}

/** The expected time for a correction whose longest passage is `chars` long. */
export function estimateCorrectionMs(chars: number): number {
  const s = readSums();
  const variance = s.w * s.xx - s.x * s.x;
  const slope =
    variance > 0
      ? Math.min(MAX_MS_PER_CHAR, Math.max(0, (s.w * s.xy - s.x * s.y) / variance))
      : PRIOR_MS_PER_CHAR;
  const base = Math.max(0, (s.y - slope * s.x) / s.w);
  return base + slope * Math.max(0, chars);
}

/** Counts a correction that came back: its longest passage and how long the call took. */
export function recordCorrectionPace(chars: number, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_SAMPLE_MS || chars <= 0) return;
  const s = readSums();
  for (const key of ["w", "x", "y", "xx", "xy"] as const) s[key] *= DECAY;
  addSample(s, chars, ms, 1);
  fallback = s;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota or blocked storage: the fit still holds for this session.
  }
}
