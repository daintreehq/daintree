import type { TerminalActivityPayload } from "@shared/types";
import { terminalRegistryController } from "@/controllers";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";

const activityBuffer = new Map<string, TerminalActivityPayload>();
let activityRafId: number | null = null;

function flushActivityBuffer(): void {
  activityRafId = null;
  if (activityBuffer.size === 0) return;
  const panelStore = usePanelStore.getState();
  for (const data of activityBuffer.values()) {
    panelStore.updateActivity(
      data.terminalId,
      data.headline,
      data.status,
      data.type,
      data.timestamp,
      data.lastCommand
    );
  }
  activityBuffer.clear();
}

function cancelActivityBuffer(): void {
  if (activityRafId !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(activityRafId);
  }
  activityRafId = null;
  activityBuffer.clear();
}

export function setupActivityListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(toDisposable(cancelActivityBuffer));

  d.add(
    toDisposable(
      terminalRegistryController.onActivity((data: TerminalActivityPayload) => {
        activityBuffer.set(data.terminalId, data);
        if (activityRafId === null) {
          activityRafId = requestAnimationFrame(flushActivityBuffer);
        }
      })
    )
  );

  return d;
}
