/**
 * The views still flushing unsaved edits after being cached (#15633). A cached
 * view never gets `visibilitychange`, so `APP_VIEW_CACHED` is the renderer's
 * only cue to persist drafts such as Settings' explicit-save buffers, and those
 * flushes are sequential IPC: a freeze landing between two steps suspends the
 * rest, and an eviction drops them. So a view whose renderer has flush work
 * registered is held — kept unfrozen and out of eviction's reach — from the
 * cached edge until the renderer says that work settled, or until a deadline,
 * so a renderer that never answers can't pin its view.
 *
 * Only a renderer that reported registered work is held: everything else is
 * cached exactly as before, with no round trip.
 *
 * Dependency-free apart from IPC so the freeze and eviction paths can read it
 * synchronously.
 */

import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { CHANNELS } from "../ipc/channels.js";

export const CACHED_VIEW_FLUSH_TIMEOUT_MS = 3_000;

/** Views whose renderer last said it has flush work registered for the cached edge. */
const armed = new Set<number>();
const watched = new Set<number>();
/** Each view's flushes still in flight, keyed by the id sent with the edge. */
const pending = new Map<
  number,
  Map<string, { settle: () => void; timer: ReturnType<typeof setTimeout> }>
>();
const settleListeners = new Set<(webContentsId: number) => void>();

/** Record a view's pushed answer. Exported for tests that cannot reach `ipcMain`. */
export function recordCachedViewFlushArmed(wc: Electron.WebContents, isArmed: boolean): void {
  if (wc.isDestroyed()) return;
  const id = wc.id;
  if (!isArmed) {
    armed.delete(id);
    return;
  }
  armed.add(id);
  if (watched.has(id)) return;
  watched.add(id);
  wc.once("destroyed", () => {
    armed.delete(id);
    watched.delete(id);
  });
}

/**
 * Send `APP_VIEW_CACHED`. When the renderer has flush work registered, the
 * view is held until it answers for this edge or `timeoutMs` passes.
 */
export function sendViewCached(
  wc: Electron.WebContents,
  timeoutMs = CACHED_VIEW_FLUSH_TIMEOUT_MS
): void {
  if (wc.isDestroyed()) return;
  const id = wc.id;
  if (!armed.has(id)) {
    try {
      wc.send(CHANNELS.APP_VIEW_CACHED);
    } catch {
      // A destroyed/closing renderer has nothing to flush.
    }
    return;
  }

  const flushId = randomUUID();
  let flushes = pending.get(id);
  if (!flushes) {
    flushes = new Map();
    pending.set(id, flushes);
  }
  const settle = () => {
    clearTimeout(timer);
    const current = pending.get(id);
    if (!current?.delete(flushId) || current.size > 0) return;
    pending.delete(id);
    for (const listener of [...settleListeners]) {
      try {
        listener(id);
      } catch {
        // One listener failing must not keep the others from freezing or reclaiming.
      }
    }
  };
  const timer = setTimeout(settle, timeoutMs);
  timer.unref?.();
  flushes.set(flushId, { settle, timer });
  try {
    wc.send(CHANNELS.APP_VIEW_CACHED, { flushId });
  } catch {
    settle();
  }
}

/** The renderer's answer for one cached edge. Exported for tests that cannot reach `ipcMain`. */
export function settleCachedViewFlush(wc: Electron.WebContents, flushId: unknown): void {
  if (typeof flushId !== "string") return;
  pending.get(wc.id)?.get(flushId)?.settle();
}

/** Whether a cached-edge flush may still be running in this view. A destroyed one runs nothing. */
export function isCachedViewFlushPending(wc: Electron.WebContents): boolean {
  if (wc.isDestroyed()) return false;
  return pending.has(wc.id);
}

/**
 * Called with a view's `webContents.id` once its last pending flush settles or
 * times out, so the freeze and eviction it held off can run. Returns the
 * unsubscribe.
 */
export function onCachedViewFlushSettled(listener: (webContentsId: number) => void): () => void {
  settleListeners.add(listener);
  return () => {
    settleListeners.delete(listener);
  };
}

/** Listen for the renderer's armed state and per-edge answers. Returns the teardown. */
export function installCachedViewFlushListeners(): () => void {
  const onArmed = (event: Electron.IpcMainEvent, isArmed: unknown) => {
    if (typeof isArmed !== "boolean") return;
    recordCachedViewFlushArmed(event.sender, isArmed);
  };
  const onFlushed = (event: Electron.IpcMainEvent, flushId: unknown) => {
    settleCachedViewFlush(event.sender, flushId);
  };
  ipcMain.on(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED, onArmed);
  ipcMain.on(CHANNELS.APP_VIEW_CACHED_FLUSHED, onFlushed);
  return () => {
    ipcMain.removeListener(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED, onArmed);
    ipcMain.removeListener(CHANNELS.APP_VIEW_CACHED_FLUSHED, onFlushed);
  };
}

/** Test-only: forget every armed view and pending flush, firing no listeners. */
export function _resetCachedViewFlushForTests(): void {
  for (const flushes of pending.values()) {
    for (const { timer } of flushes.values()) clearTimeout(timer);
  }
  armed.clear();
  watched.clear();
  pending.clear();
}
