import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import type { AgentUpdateInstalledChangedPayload } from "@shared/types/ipc/agent";

function isPayload(payload: unknown): payload is AgentUpdateInstalledChangedPayload {
  if (!payload || typeof payload !== "object") return false;
  const { terminalId, updateInstalled } = payload as Partial<AgentUpdateInstalledChangedPayload>;
  if (typeof terminalId !== "string" || terminalId.length === 0) return false;
  if (updateInstalled === null) return true;
  return (
    !!updateInstalled &&
    typeof updateInstalled.observedAt === "number" &&
    Number.isFinite(updateInstalled.observedAt) &&
    typeof updateInstalled.namesRestart === "boolean"
  );
}

/**
 * Copy the host's update-installed observation onto its pane (#17905). The
 * host sends every set and clear; a view attached after one reads it off the
 * terminal's record on restore instead.
 */
export function setupUpdateInstalledListeners(): DisposableStore {
  const d = new DisposableStore();
  d.add(
    toDisposable(
      window.electron.events.on("agent:update-installed-changed", (payload) => {
        if (!isPayload(payload)) return;
        usePanelStore
          .getState()
          .setUpdateInstalled(payload.terminalId, payload.updateInstalled ?? undefined);
      })
    )
  );
  return d;
}
