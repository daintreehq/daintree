import { isProjectViewObservable } from "@/lib/viewCacheState";

/**
 * How often a terminal that stays in front of the user is reported again, so
 * one watched for an hour never reads as unseen for an hour. Well inside the
 * five minutes before a row says "Unseen".
 */
export const CANOPY_SEEN_HEARTBEAT_MS = 60_000;

/** Looks at one run closer together than this are one look. */
const COALESCE_MS = 2_000;
const MAX_TRACKED = 500;

const lastSent = new Map<string, number>();

/**
 * Someone can be looking at this view: it is not cached or hidden, and its
 * window has focus. A pane focused in a window behind another app is not seen.
 */
export function canopyViewIsWatched(): boolean {
  return isProjectViewObservable() && typeof document !== "undefined" && document.hasFocus();
}

/**
 * Tells main the user had this run's terminal in front of them. Repeats within
 * a moment are dropped — arrowing down a long list must not spend the IPC
 * budget — and so is a refused report: a missed look only ages a rank, which
 * the next look puts right.
 */
export function reportCanopySeen(runId: string): void {
  const markSeen = window.electron?.canopy?.markSeen;
  if (!markSeen) return;
  const now = Date.now();
  const last = lastSent.get(runId);
  if (last !== undefined && now - last < COALESCE_MS) return;
  if (lastSent.size >= MAX_TRACKED) lastSent.clear();
  lastSent.set(runId, now);
  markSeen(runId).catch(() => {});
}

export function __resetCanopySeenForTests(): void {
  lastSent.clear();
}
