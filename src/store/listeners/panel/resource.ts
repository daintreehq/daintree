import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { flushPanelPersistence } from "@/store/slices";
import { draftInputPersistence } from "@/store/persistence/draftInputPersistence";
import { DisposableStore, toDisposable } from "@/utils/disposable";

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
  // inputs (#11352) — before the view is torn down to prevent data loss.
  // `beforeunload` does NOT fire on WebContentsView detach (project switch,
  // single-window close) in Electron — `visibilitychange` is the reliable
  // signal, firing on detach while the renderer is still alive and IPC channels
  // are open, so the async flush completes (#9914). Matches the pattern
  // documented in `useFlushOnHide`. (Full app quit ends in `app.exit()`, which
  // may not surface a renderer visibility flush — that gap is pre-existing and
  // shared with panel persistence, out of scope here.)
  const flushOnHide = () => {
    flushPanelPersistence();
    draftInputPersistence.flushAll();
  };
  const handleVisibilityChange = () => {
    if (!document.hidden) return;
    flushOnHide();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  d.add(
    toDisposable(() => document.removeEventListener("visibilitychange", handleVisibilityChange))
  );
  // Cover the race where the document is already hidden when listeners
  // register (e.g. a fast project switch between render and this effect).
  if (document.hidden) flushOnHide();

  return d;
}
