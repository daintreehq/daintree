import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { flushPanelPersistence } from "@/store/slices";
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

  // Flush pending terminal persistence before the view is torn down to
  // prevent data loss. `beforeunload` does NOT fire on WebContentsView detach
  // (project switch, window close, app quit) in Electron — `visibilitychange`
  // is the reliable signal, firing on detach while the renderer is still alive
  // and IPC channels are open, so the async flush completes (#9914). Matches
  // the pattern documented in `useFlushOnHide`.
  const handleVisibilityChange = () => {
    if (!document.hidden) return;
    flushPanelPersistence();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  d.add(
    toDisposable(() => document.removeEventListener("visibilitychange", handleVisibilityChange))
  );
  // Cover the race where the document is already hidden when listeners
  // register (e.g. a fast project switch between render and this effect).
  if (document.hidden) flushPanelPersistence();

  return d;
}
