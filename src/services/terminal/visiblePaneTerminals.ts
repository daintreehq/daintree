import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { onHostResync } from "@/store/hostResyncSignal";
import { logWarn } from "@/utils/logger";

/**
 * Tells main which terminals this view shows in a pane, so those panes own
 * their PTY's size ahead of any Canopy panel (#16737). One report per view: a
 * view can run several terminal services, so each registers what it shows and
 * the report is their union, sent whole and only when it changed. A cached
 * view shows nothing, whatever its panes last measured.
 */
type Source = () => Iterable<string>;

const sources = new Set<Source>();
// Terminals whose owner keeps them mounted and attached while it hides them,
// which nothing the terminal service sees reports: the Assistant sliding off-canvas.
const hiddenByOwner = new Map<string, number>();
let offLifecycle: (() => void) | null = null;
let offResync: (() => void) | null = null;
let queued = false;
// What main was last sent, so an unchanged union sends nothing; null when
// what it has is unknown and the next flush must send whatever it is.
let sent: string | null = null;
let attempt = 0;
let warned = false;

function shownTerminals(): string[] {
  if (isProjectViewCached()) return [];
  const ids = new Set<string>();
  for (const source of sources) {
    for (const id of source()) if (!hiddenByOwner.has(id)) ids.add(id);
  }
  return [...ids].sort();
}

function flush(): void {
  queued = false;
  if (typeof window === "undefined") return;
  const report = window.electron?.canopy?.setVisiblePaneTerminals;
  if (!report) return;
  const ids = shownTerminals();
  const key = JSON.stringify(ids);
  if (key === sent) return;
  sent = key;
  const mine = ++attempt;
  Promise.resolve(report(ids)).then(
    () => {
      warned = false;
    },
    (error: unknown) => {
      // Main kept what it had, so the next change, or the host coming back, sends it all again.
      if (mine === attempt) sent = null;
      if (warned) return;
      warned = true;
      logWarn("[visiblePaneTerminals] Couldn't tell the host which panes are shown", { error });
    }
  );
}

/** Something a pane shows may have changed: report once this task is done. */
export function noteVisiblePanesChanged(): void {
  if (queued || sources.size === 0) return;
  queued = true;
  queueMicrotask(flush);
}

function start(): void {
  if (offLifecycle !== null) return;
  offLifecycle = subscribeProjectViewLifecycle((phase) => {
    // Now, not after a microtask: main may freeze a cached view straight away.
    if (phase === "cached") flush();
    else noteVisiblePanesChanged();
  });
  offResync = onHostResync(() => {
    sent = null;
    noteVisiblePanesChanged();
  });
}

function stop(): void {
  offLifecycle?.();
  offLifecycle = null;
  offResync?.();
  offResync = null;
  queued = false;
  sent = null;
  attempt += 1;
}

/**
 * The terminal's owner hides it without detaching it; it is shown again once
 * the returned function runs.
 */
export function hidePaneTerminal(terminalId: string): () => void {
  hiddenByOwner.set(terminalId, (hiddenByOwner.get(terminalId) ?? 0) + 1);
  noteVisiblePanesChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (hiddenByOwner.get(terminalId) ?? 1) - 1;
    if (count > 0) hiddenByOwner.set(terminalId, count);
    else hiddenByOwner.delete(terminalId);
    noteVisiblePanesChanged();
  };
}

/**
 * Add what a terminal service shows to the view's report. The returned
 * function takes it out again, and once nothing is registered tells main the
 * view shows nothing.
 */
export function registerVisiblePaneSource(source: Source): () => void {
  sources.add(source);
  start();
  noteVisiblePanesChanged();
  return () => {
    if (!sources.delete(source)) return;
    if (sources.size > 0) {
      noteVisiblePanesChanged();
      return;
    }
    flush();
    stop();
  };
}
