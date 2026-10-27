/**
 * The views a dictation still needs (#14773). Destroying the view a session
 * was started from cancels the session and the words still on their way, and
 * the cleanup that follows a stop writes into that view's draft, so neither
 * cache pressure nor an idle sweep may take it while either is pending. Each
 * hold is released by whoever took it; one that may wrap work nothing else
 * bounds carries its own deadline, so a release that never comes can't pin a
 * view for the rest of the app's life.
 *
 * Dependency-free so the eviction controller can read it synchronously.
 */

const holds = new Map<number, number>();
const releaseListeners = new Set<(webContentsId: number) => void>();

/**
 * Keep the view with this `webContents.id` alive until the returned release is
 * called, or `ttlMs` has passed when given. Releasing twice is harmless.
 */
export function holdDictationView(webContentsId: number, ttlMs?: number): () => void {
  holds.set(webContentsId, (holds.get(webContentsId) ?? 0) + 1);
  let released = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    const left = (holds.get(webContentsId) ?? 1) - 1;
    if (left > 0) {
      holds.set(webContentsId, left);
      return;
    }
    holds.delete(webContentsId);
    for (const listener of [...releaseListeners]) listener(webContentsId);
  };
  if (ttlMs !== undefined) {
    timer = setTimeout(release, ttlMs);
    timer.unref?.();
  }
  return release;
}

/** Whether a dictation still needs this view. A destroyed one needs nothing. */
export function isDictationViewHeld(wc: Electron.WebContents): boolean {
  if (wc.isDestroyed()) return false;
  return holds.has(wc.id);
}

/**
 * Called with a view's `webContents.id` once its last hold lifts, so a cache
 * the hold kept over its cap can be brought back under it. Returns the
 * unsubscribe.
 */
export function onDictationViewReleased(listener: (webContentsId: number) => void): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}

/** Test-only: forget every hold. */
export function _resetDictationViewHoldsForTests(): void {
  holds.clear();
}
