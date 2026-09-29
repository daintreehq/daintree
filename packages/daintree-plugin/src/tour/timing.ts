import {
  alignWordStarts,
  buildTiming,
  type ParsedNarration,
  type WordAlignment,
} from "../../../tour/src/tourNarration.js";
import type { TourChapterTiming } from "../../../tour/src/tourTypes.js";

/** Breathing room after the last word, so the next chapter doesn't clip it. */
export const TAIL_SECONDS = 0.6;
/** Below this share of words pinned to real speech, the cues can't be trusted. */
export const MIN_ALIGNED_SHARE = 0.6;

export interface ChapterTimingResult {
  timing: TourChapterTiming;
  /** Narration words pinned to a spoken word; the rest were interpolated. */
  matched: number;
  total: number;
}

/**
 * Timing for one chapter from its audio's word alignment: every cue lands on
 * the word it marks. Throws when too few words line up to trust the result,
 * so a recording that strays from the script never ships misplaced cues.
 */
export function timeChapter(
  label: string,
  parsed: ParsedNarration,
  alignment: WordAlignment,
  audioSeconds: number,
  audioUrl: string | null
): ChapterTimingResult {
  const { starts, matched } = alignWordStarts(parsed.words, alignment);
  const total = parsed.words.length;
  if (alignment.words.length === 0 || total === 0 || matched / total < MIN_ALIGNED_SHARE) {
    throw new Error(
      `${label}: only ${matched}/${total} words lined up with the audio — ` +
        "check the recording reads the narration as written."
    );
  }
  const timing = buildTiming(parsed, starts, audioSeconds + TAIL_SECONDS, audioUrl);
  return { timing, matched, total };
}

/** Millisecond precision is finer than any cue needs and keeps float noise out of diffs. */
export function roundTiming<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "number" ? Math.round(v * 1000) / 1000 : v
    )
  ) as T;
}
