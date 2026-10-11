import type { CanopyLookPlace } from "@shared/types/ipc/canopy";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * How often a terminal that stays in front of the user is reported again, so
 * one watched for an hour never reads as unseen for an hour. Well inside the
 * five minutes before a row says "Unseen".
 */
export const CANOPY_SEEN_HEARTBEAT_MS = 60_000;

/** Reports of the same look at one run closer together than this are one report. */
const COALESCE_MS = 2_000;
const MAX_TRACKED = 500;

const lastSent = new Map<string, { at: number; looking: boolean }>();

/**
 * Someone can be looking at this view: it is not cached or hidden, and its
 * window has focus. A pane focused in a window behind another app is not seen.
 */
export function canopyViewIsWatched(): boolean {
  return isProjectViewObservable() && typeof document !== "undefined" && document.hasFocus();
}

/**
 * Tells main the user started (`looking`) or stopped having this run's
 * terminal in front of them, in its own pane or in Canopy's panel (`place`). A look that lasts reads what the run did; one
 * that ends also counts as seen up to then. Repeats of the same report within
 * a moment are dropped — arrowing down a long list must not spend the IPC
 * budget — but a look ending is always told, and so is a refused report: a
 * missed one only ages a rank, which the next look puts right.
 */
export function reportCanopySeen(
  runId: string,
  looking: boolean,
  place: CanopyLookPlace = "pane"
): void {
  const markSeen = window.electron?.canopy?.markSeen;
  if (!markSeen) return;
  const now = Date.now();
  const key = `${place}:${runId}`;
  const last = lastSent.get(key);
  if (last !== undefined && last.looking === looking && now - last.at < COALESCE_MS) return;
  if (lastSent.size >= MAX_TRACKED) lastSent.clear();
  lastSent.set(key, { at: now, looking });
  markSeen(runId, looking, place).catch(() => {});
}

/** Sends to one run closer together than this are one report. */
const SENT_COALESCE_MS = 1_000;
const lastSentInput = new Map<string, number>();

/**
 * Tells main the user sent this run something from its pane — Enter typed in
 * it, or its composer — so the work it starts is theirs rather than news.
 * Called only from those input entry points, never on behalf of an action, a
 * broadcast or a plugin: that is the whole of the signal.
 */
export function reportCanopySent(runId: string): void {
  const noteSent = window.electron?.canopy?.noteSent;
  // Every pane's Enter comes through here: with Canopy not on, nothing is told.
  if (!noteSent || useCanopyStore.getState().mode !== "on") return;
  const now = Date.now();
  const last = lastSentInput.get(runId);
  if (last !== undefined && now - last < SENT_COALESCE_MS) return;
  if (lastSentInput.size >= MAX_TRACKED) lastSentInput.clear();
  lastSentInput.set(runId, now);
  noteSent(runId).catch(() => {});
}

export function __resetCanopySeenForTests(): void {
  lastSent.clear();
  lastSentInput.clear();
}
