// Every runtime binding is exported as a value on its own line: routing one
// through `export type` erases it to `undefined` with no compile error.
export type {
  TourAudioStatus,
  TourCaption,
  TourChapter,
  TourChapterTiming,
  TourPlaybackStatus,
  TourPlayerState,
  TourTimingManifest,
} from "./tourTypes.js";

export { TourPlayer } from "./TourPlayer.js";
export type { TourAudio, TourPlayerDeps } from "./TourPlayer.js";

export {
  alignWordStarts,
  buildCaptions,
  buildTiming,
  estimateTiming,
  estimateWordStarts,
  narrationFingerprint,
  parseNarration,
  stripDirectionTags,
} from "./tourNarration.js";
export type { AlignedWords, ParsedNarration, WordAlignment } from "./tourNarration.js";

export { resolveChapterTiming, resolveTourTimings, tourMinutes } from "./tourTiming.js";
