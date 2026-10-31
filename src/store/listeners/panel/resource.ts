import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { flushPanelPersistence } from "@/store/slices";
import { draftInputPersistence } from "@/store/persistence/draftInputPersistence";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { isProjectViewCached, subscribeProjectViewCachedFlush } from "@/lib/viewCacheState";

export function setupResourceListeners(): DisposableStore {
  const d = new DisposableStore();

  // Resource metrics listener
  d.add(
    toDisposable(
      window.electron.terminal.onResourceMetrics((data) => {
        const rmStore = useResourceMonitoringStore.getState();
        if (rmStore.enabled) {
          rmStore.updateMetrics(data.metrics);
        }
      })
    )
  );

  // Flush pending terminal persistence — panel/tab-group layout and draft
  // inputs (#11352) — once nobody can see this view, so a change made inside
  // the debounce window isn't lost. A project switch caches the view, which
  // fires no `beforeunload` and no `visibilitychange` (a cached view reports
  // "visible" forever, see `viewCacheState`), so main's cached edge is the cue
  // there; main keeps the view unfrozen and resident until the returned promise
  // settles, within a bounded wait (#15651). Hiding or minimizing the window
  // still flips `document.hidden`. Matches `useFlushOnHide`. (Full app quit
  // ends in `app.exit()`, which may surface neither — that gap is pre-existing
  // and out of scope here.)
  // A driver's drafts also go up as they're typed, so watchers can follow them.
  d.add(toDisposable(draftInputPersistence.startLiveSync()));

  const flushOnHide = (): Promise<unknown> => {
    const panels = flushPanelPersistence();
    draftInputPersistence.flushAll();
    // `flushAll` queues each project's write synchronously, so this sees them.
    return Promise.all([panels, draftInputPersistence.whenIdle()]);
  };
  const handleVisibilityChange = () => {
    if (!document.hidden) return;
    void flushOnHide();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  d.add(
    toDisposable(() => document.removeEventListener("visibilitychange", handleVisibilityChange))
  );
  d.add(toDisposable(subscribeProjectViewCachedFlush(flushOnHide)));
  // Both signals are edges: cover a view already hidden or cached when the
  // listeners register (e.g. a fast project switch between render and this).
  if (document.hidden || isProjectViewCached()) void flushOnHide();

  return d;
}
