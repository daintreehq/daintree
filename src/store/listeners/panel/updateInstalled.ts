import { DisposableStore, toDisposable } from "@/utils/disposable";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import {
  noteUpdateInstalledEvent,
  resetUpdateInstalledEvents,
} from "@/store/updateInstalledEvents";
import type {
  AgentUpdateInstalledChangedPayload,
  UpdateInstalledObservation,
} from "@shared/types/ipc/agent";

function isPayload(payload: unknown): payload is AgentUpdateInstalledChangedPayload {
  if (!payload || typeof payload !== "object") return false;
  const { terminalId, updateInstalled, timestamp } =
    payload as Partial<AgentUpdateInstalledChangedPayload>;
  if (typeof terminalId !== "string" || terminalId.length === 0) return false;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
  if (updateInstalled === null) return true;
  return (
    !!updateInstalled &&
    typeof updateInstalled.observedAt === "number" &&
    Number.isFinite(updateInstalled.observedAt) &&
    typeof updateInstalled.namesRestart === "boolean"
  );
}

/**
 * How long an event for a terminal with no pane here is kept: long enough to
 * outlast a restore, short enough that another project's terminals don't pile
 * up. Measured on this machine's clock, which a remote host's isn't.
 */
const UNCLAIMED_TTL_MS = 2 * 60_000;

interface Unclaimed {
  payload: AgentUpdateInstalledChangedPayload;
  receivedAt: number;
}

/**
 * The latest set or clear for each terminal this view held no pane for when it
 * arrived. One that lands between a restore's inventory read and its pane's
 * commit would otherwise be lost for the rest of the run: the footer stays up,
 * so the host never says it again.
 */
const unclaimed = new Map<string, Unclaimed>();

/**
 * Whether a buffered event is newer than what the pane was restored with. Both
 * times come from the host's clock: a clear is stamped when it was made, after
 * the observation it cleared, and an observation by when it was seen.
 */
function isNewer(
  payload: AgentUpdateInstalledChangedPayload,
  current: UpdateInstalledObservation | undefined
): boolean {
  if (current === undefined) return true;
  const at = payload.updateInstalled?.observedAt ?? payload.timestamp;
  return payload.updateInstalled === null ? at >= current.observedAt : at > current.observedAt;
}

function prune(now: number): void {
  for (const [terminalId, entry] of unclaimed) {
    if (now - entry.receivedAt >= UNCLAIMED_TTL_MS) unclaimed.delete(terminalId);
  }
}

/**
 * Copy the host's update-installed observation onto its pane (#17905). The
 * host sends every set and clear; a view attached later reads it off the
 * terminal's record on restore, and takes any newer event that beat its pane in.
 */
export function setupUpdateInstalledListeners(): DisposableStore {
  const d = new DisposableStore();
  d.add(
    toDisposable(
      window.electron.events.on("agent:update-installed-changed", (payload) => {
        if (!isPayload(payload)) return;
        const state = usePanelStore.getState();
        const panel = state.panelsById[payload.terminalId];
        if (panel) {
          unclaimed.delete(payload.terminalId);
          // A pane mid-restart drops it, so it mustn't stop a host read from
          // repairing the pane should the restart fail.
          if (isPtyPanel(panel) && panel.isRestarting) return;
          noteUpdateInstalledEvent(payload.terminalId);
          state.setUpdateInstalled(payload.terminalId, payload.updateInstalled ?? undefined);
          return;
        }
        const now = Date.now();
        prune(now);
        unclaimed.set(payload.terminalId, { payload, receivedAt: now });
      })
    )
  );
  d.add(
    toDisposable(
      usePanelStore.subscribe((state, previous) => {
        if (unclaimed.size === 0 || state.panelsById === previous.panelsById) return;
        prune(Date.now());
        for (const [terminalId, { payload }] of unclaimed) {
          const panel = state.panelsById[terminalId];
          if (!panel) continue;
          unclaimed.delete(terminalId);
          const current = "updateInstalled" in panel ? panel.updateInstalled : undefined;
          if (!isNewer(payload, current)) continue;
          usePanelStore
            .getState()
            .setUpdateInstalled(terminalId, payload.updateInstalled ?? undefined);
        }
      })
    )
  );
  d.add(
    toDisposable(() => {
      unclaimed.clear();
      resetUpdateInstalledEvents();
    })
  );
  return d;
}
