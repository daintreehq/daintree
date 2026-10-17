/** The part of a WebContents this uses, so a narrowed view of one can be watched too. */
export interface DestroyableWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
  isDestroyed?(): boolean;
}

interface Watcher {
  webContents: DestroyableWebContents;
  entries: Set<{ callback: () => void }>;
  listener: () => void;
}

const watchers = new Map<number, Watcher>();
const destroyedWebContents = new WeakSet<DestroyableWebContents>();

/**
 * Runs `callback` when `webContents` is destroyed; the returned function
 * unwatches. Every watcher of one WebContents shares a single `destroyed`
 * listener, removed with its last watcher.
 *
 * A project view already carries a `destroyed` listener from most subsystems
 * that track it, and an unpackaged build exits on the eleventh
 * (devDiagnostics' MaxListenersExceededWarning guard). A host view also has
 * its endpoint, relays and preview capability watching it, and plugin requests
 * watch whichever view they wait on, which was enough to cross that line, so
 * per-view and per-request watchers join this one instead.
 *
 * A WebContents already destroyed, or still running its `destroyed` watchers,
 * would never fire a listener added now, so the callback runs on the next
 * microtask instead.
 */
export function onWebContentsDestroyed(
  webContents: DestroyableWebContents,
  callback: () => void
): () => void {
  if (destroyedWebContents.has(webContents) || isDestroyed(webContents)) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) runCallback(callback);
    });
    return () => {
      cancelled = true;
    };
  }

  const id = webContents.id;
  let watcher = watchers.get(id);
  if (!watcher || watcher.webContents !== webContents) {
    const entries = new Set<{ callback: () => void }>();
    const listener = (): void => {
      destroyedWebContents.add(webContents);
      if (watchers.get(id)?.listener === listener) watchers.delete(id);
      for (const entry of [...entries]) runCallback(entry.callback);
    };
    watcher = { webContents, entries, listener };
    watchers.set(id, watcher);
    webContents.once("destroyed", listener);
  }
  const current = watcher;
  const entry = { callback };
  current.entries.add(entry);
  return () => {
    if (!current.entries.delete(entry) || current.entries.size > 0) return;
    if (watchers.get(id) === current) watchers.delete(id);
    try {
      current.webContents.removeListener("destroyed", current.listener);
    } catch {
      // Already torn down.
    }
  };
}

function isDestroyed(webContents: DestroyableWebContents): boolean {
  return typeof webContents.isDestroyed === "function" && webContents.isDestroyed();
}

function runCallback(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.error("[webContentsDestroyed] destroyed callback failed:", error);
  }
}
