import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import type {
  AgentUpdateInstalledChangedPayload,
  UpdateInstalledObservation,
} from "@shared/types/ipc/agent";

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
 * The latest set or clear for each terminal this view held no pane for when it
 * arrived. One that lands between a restore's inventory read and its pane's
 * commit would otherwise be lost for the rest of the run: the footer stays up,
 * so the host never says it again. Events reach every view, so a terminal
 * another view owns stays here; one entry per terminal ever observed.
 */
const unclaimed = new Map<string, UpdateInstalledObservation | null>();

function applyTo(terminalId: string, updateInstalled: UpdateInstalledObservation | null): boolean {
  const state = usePanelStore.getState();
  if (!state.panelsById[terminalId]) return false;
  state.setUpdateInstalled(terminalId, updateInstalled ?? undefined);
  return true;
}

/**
 * Copy the host's update-installed observation onto its pane (#17905). The
 * host sends every set and clear; a view attached later reads it off the
 * terminal's record on restore, and takes any event that beat its pane in.
 */
export function setupUpdateInstalledListeners(): DisposableStore {
  const d = new DisposableStore();
  d.add(
    toDisposable(
      window.electron.events.on("agent:update-installed-changed", (payload) => {
        if (!isPayload(payload)) return;
        if (applyTo(payload.terminalId, payload.updateInstalled)) {
          unclaimed.delete(payload.terminalId);
        } else {
          unclaimed.set(payload.terminalId, payload.updateInstalled);
        }
      })
    )
  );
  d.add(
    toDisposable(
      usePanelStore.subscribe((state, previous) => {
        if (unclaimed.size === 0 || state.panelsById === previous.panelsById) return;
        for (const [terminalId, updateInstalled] of unclaimed) {
          if (!state.panelsById[terminalId]) continue;
          // Newer than the inventory the pane was restored from: events and
          // that read leave the host in order, and this is the last event.
          unclaimed.delete(terminalId);
          applyTo(terminalId, updateInstalled);
        }
      })
    )
  );
  d.add(toDisposable(() => unclaimed.clear()));
  return d;
}
