import { useSyncExternalStore } from "react";
import type { ProjectSurfaceSlotKey } from "@shared/types/plugin";

/**
 * The slots whose host frame is on screen in this project view, and which of a
 * slot's frames came first, so a plugin that set up several slots is asked
 * once, in one frame, rather than once per frame. Module state is already per
 * project: each project view has its own V8 context.
 *
 * Kept per frame rather than per slot, so a second frame of the same slot never
 * asks the question twice, and the first one unmounting hands it to the next.
 *
 * A frame need not draw the slot's content: a file panel showing a file that a
 * plugin's default editor covers frames that file editor slot, so the question
 * is asked where the default shows.
 */
const frames = new Map<ProjectSurfaceSlotKey, string[]>();
let snapshot: ReadonlyMap<ProjectSurfaceSlotKey, string> = new Map();
const listeners = new Set<() => void>();

function publish(): void {
  const next = new Map<ProjectSurfaceSlotKey, string>();
  for (const [slot, ids] of frames) {
    if (ids[0] !== undefined) next.set(slot, ids[0]);
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Register frame `frameId` for `slot`; returns its unregister. Call from an
 * effect.
 */
export function frameSurfaceSlot(slot: ProjectSurfaceSlotKey, frameId: string): () => void {
  frames.set(slot, [...(frames.get(slot) ?? []), frameId]);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (frames.get(slot) ?? []).filter((id) => id !== frameId);
    if (left.length > 0) frames.set(slot, left);
    else frames.delete(slot);
    publish();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

/** Each framed slot, mapped to the frame that hosts its questions. */
export function useFramedSurfaceSlots(): ReadonlyMap<ProjectSurfaceSlotKey, string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
