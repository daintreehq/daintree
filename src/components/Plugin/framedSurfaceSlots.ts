import { useSyncExternalStore } from "react";
import type { ProjectSurfaceSlot } from "@shared/types/plugin";

/**
 * The slots whose host frame is on screen in this project view, so a plugin
 * that set up several of them is asked once, in one of their frames, rather
 * than once per frame. Module state is already per project: each project view
 * has its own V8 context.
 *
 * Counted rather than a plain set, so a frame unmounting can never unregister a
 * second mount of the same slot that is still standing.
 */
const mounts = new Map<ProjectSurfaceSlot, number>();
let snapshot: ReadonlySet<ProjectSurfaceSlot> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = new Set(mounts.keys());
  for (const listener of listeners) listener();
}

/** Register a frame for `slot`; returns its unregister. Call from an effect. */
export function frameSurfaceSlot(slot: ProjectSurfaceSlot): () => void {
  mounts.set(slot, (mounts.get(slot) ?? 0) + 1);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (mounts.get(slot) ?? 1) - 1;
    if (left > 0) mounts.set(slot, left);
    else mounts.delete(slot);
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

export function useFramedSurfaceSlots(): ReadonlySet<ProjectSurfaceSlot> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
