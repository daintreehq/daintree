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

/** Each view's outstanding holds, one token apiece: a stale release finds nothing to drop. */
const holds = new Map<number, Set<symbol>>();
const releaseListeners = new Set<(webContentsId: number) => void>();

/**
 * Keep the view with this `webContents.id` alive until the returned release is
 * called, or `ttlMs` has passed when given. Releasing twice is harmless.
 */
export function holdDictationView(webContentsId: number, ttlMs?: number): () => void {
  const token = Symbol("dictation-view-hold");
  let tokens = holds.get(webContentsId);
  if (!tokens) {
    tokens = new Set();
    holds.set(webContentsId, tokens);
  }
  tokens.add(token);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const current = holds.get(webContentsId);
    if (!current?.delete(token) || current.size > 0) return;
    holds.delete(webContentsId);
    for (const listener of [...releaseListeners]) {
      try {
        listener(webContentsId);
      } catch {
        // One listener failing must not keep the others from reclaiming.
      }
    }
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

/** Test-only: forget every hold. A release from before the reset then drops nothing. */
export function _resetDictationViewHoldsForTests(): void {
  holds.clear();
}
