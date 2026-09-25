/**
 * A chapter of a tour as authored: narration text with inline cue
 * markers (`[[cue-id]]`) placed immediately before the word the cue fires on.
 * Scenes animate off cue times, never off wall-clock literals, so re-recording
 * the narration re-times every animation for free.
 */
export interface TourChapter {
  id: string;
  title: string;
  /** The chapter's one or two sentence synopsis. The player shows captions instead. */
  summary: string;
  narration: string;
}

export interface TourCaption {
  start: number;
  end: number;
  text: string;
}

/** Resolved timing for one chapter: generated from real audio when available. */
export interface TourChapterTiming {
  duration: number;
  cues: Record<string, number>;
  captions: TourCaption[];
  audioUrl: string | null;
}

export interface TourTimingManifest {
  /** Bumped whenever the narration source changes shape; stale entries are ignored. */
  version: number;
  voice: string;
  chapters: Record<string, TourChapterTiming & { narrationHash: string; voice?: string }>;
}

export type TourPlaybackStatus = "idle" | "playing" | "paused" | "ended";

export type TourAudioStatus = "none" | "loading" | "ready" | "failed";

export interface TourPlayerState {
  chapterIndex: number;
  status: TourPlaybackStatus;
  muted: boolean;
  audioStatus: TourAudioStatus;
  /** The timeline is running without the voice (no audio, refused, failed, or stalled past the hold). */
  silent: boolean;
}
