import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { flushPanelPersistence } from "@/store/slices";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
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

  // Memory pressure: reduce scrollback on all background terminals
  d.add(
    toDisposable(
      window.electron.terminal.onReclaimMemory(() => {
        terminalInstanceService.reduceScrollbackAllBackground(SCROLLBACK_BACKGROUND);
      })
    )
  );

  // Flush pending terminal persistence on window close to prevent data loss
  const beforeUnloadHandler = () => {
    flushPanelPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);
  d.add(toDisposable(() => window.removeEventListener("beforeunload", beforeUnloadHandler)));

  return d;
}
