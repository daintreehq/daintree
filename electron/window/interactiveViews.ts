/**
 * Views whose renderer reported `app:first-interactive`: its state hydrated
 * and every hook listening for main's requests is mounted, so a push sent now
 * is heard. Preload doesn't buffer pushes, and one sent to a view still
 * loading is lost. A main-frame navigation (a reload) or a destroyed view
 * drops the mark until the new document reports again.
 */
const interactive = new Set<number>();
const waiters = new Map<number, Set<() => void>>();
const followed = new WeakSet<Electron.WebContents>();

export function markViewInteractive(webContents: Electron.WebContents): void {
  const { id } = webContents;
  if (!followed.has(webContents)) {
    followed.add(webContents);
    webContents.on("did-navigate", () => interactive.delete(id));
    webContents.once("destroyed", () => {
      interactive.delete(id);
      waiters.delete(id);
    });
  }
  interactive.add(id);
  const ready = waiters.get(id);
  waiters.delete(id);
  for (const then of ready ?? []) then();
}

/** Runs `then` once the view is interactive, at once when it is. Returns a cancel. */
export function whenViewInteractive(
  webContents: Electron.WebContents,
  then: () => void
): () => void {
  const { id } = webContents;
  if (interactive.has(id)) {
    then();
    return () => {};
  }
  let pending = waiters.get(id);
  if (!pending) waiters.set(id, (pending = new Set()));
  pending.add(then);
  const waiting = pending;
  return () => {
    waiting.delete(then);
    if (waiting.size === 0 && waiters.get(id) === waiting) waiters.delete(id);
  };
}

/** @internal Tests only. */
export function _resetInteractiveViewsForTest(): void {
  interactive.clear();
  waiters.clear();
}
