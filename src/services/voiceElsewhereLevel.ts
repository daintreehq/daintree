import type { VoiceLiveLevel } from "@shared/types";

// A chunk is about 100ms of audio; a reading older than a few of them means
// none are coming (this view was off screen, or capture stopped), so the meter
// falls to rest instead of holding the last sound.
const STALE_AFTER_MS = 400;

// The input level of a session another view owns, as main last sent it. Kept
// out of the recording store: it changes with every chunk of audio, and only
// the toolbar meter's frame loop reads it.
let reading: (VoiceLiveLevel & { at: number }) | null = null;

export function setElsewhereLevel(level: VoiceLiveLevel | null, now = performance.now()): void {
  reading = level ? { ...level, at: now } : null;
}

/** The level for `sessionId`, or 0 when the last reading is stale or another session's. */
export function getElsewhereLevel(sessionId: string, now = performance.now()): number {
  if (!reading || reading.sessionId !== sessionId) return 0;
  return now - reading.at > STALE_AFTER_MS ? 0 : reading.level;
}
