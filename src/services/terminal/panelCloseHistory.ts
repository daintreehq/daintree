import type { ActionSource } from "@shared/types/actions";
import { isPtyPanel } from "@shared/types/panel";
import type { usePanelStore } from "@/store/panelStore";
import { getCurrentProjectId } from "@/store/storeAccessors";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
import { logWarn } from "@/utils/logger";
import { isForegroundDispatch } from "@/services/actions/definitions/dispatchSource";
import { nextCloseSeq, trackNativeFieldEdits } from "./closeUndoOrder";

/**
 * The person's own closes in this project view, newest first, for Cmd+Z to take
 * back (#17107). In memory only, one per renderer, so one per project view.
 * A close here sent panels to the trash; one made by an agent, an MCP client
 * or a plugin is never recorded, and stays on the trash and Cmd+Shift+T.
 */

export const MAX_CLOSE_STEPS = 10;

/** How many of the panels after a closed one are kept to place a replacement. */
const MAX_FOLLOWERS = 8;

export interface ClosedPanel {
  id: string;
  worktreeId: string | null;
  location: "grid" | "dock";
  /**
   * The agent a resumed replacement would run once the trash has let the
   * panel go; null for anything with no conversation to come back to.
   */
  agentId: string | null;
  /** The panels that followed it in the roster, nearest first. */
  followers: string[];
  /** `trashed` while the panel itself can come back, `expired` once it's gone. */
  status: "trashed" | "expired";
  expiredAt?: number;
}

export interface ClosedGroup {
  id: string;
  location: "grid" | "dock";
  worktreeId: string | undefined;
  panelIds: string[];
  activeTabId: string | null;
}

export interface CloseStep {
  seq: number;
  closedAt: number;
  projectId: string | null;
  panels: ClosedPanel[];
  /** Every tab group a closed panel belonged to, as it was. */
  groups: ClosedGroup[];
  /** The panel to focus once the step is back. */
  focusId: string | null;
}

interface CloseSnapshot {
  panels: ClosedPanel[];
  groups: ClosedGroup[];
  focusId: string | null;
}

type PanelStoreApi = Pick<typeof usePanelStore, "getState" | "subscribe">;
type PanelState = ReturnType<PanelStoreApi["getState"]>;

let steps: CloseStep[] = [];
let unsubscribe: (() => void) | null = null;
// Handed over by the store orchestrator rather than imported: every close
// path records here, and a static store import would drag the store's client
// graph into each of their tests.
let panelStore: PanelStoreApi | null = null;

/** Connects the history to this view's panel store; `null` disconnects it. */
export function connectPanelCloseHistory(api: PanelStoreApi | null): void {
  unsubscribe?.();
  unsubscribe = null;
  panelStore = api;
  setSteps(api === null ? [] : steps);
}

function snapshotClose(state: PanelState, panelIds: readonly string[]): CloseSnapshot | null {
  const closing = new Set(panelIds);
  const panels: ClosedPanel[] = [];
  for (const id of panelIds) {
    if (!Object.hasOwn(state.panelsById, id)) continue;
    const panel = state.panelsById[id];
    if (!panel) continue;
    const location =
      panel.location === "dock"
        ? "dock"
        : panel.location === "grid" || panel.location === undefined
          ? "grid"
          : null;
    if (location === null) continue;
    const index = state.panelIds.indexOf(id);
    panels.push({
      id,
      worktreeId: panel.worktreeId ?? null,
      location,
      agentId:
        isPtyPanel(panel) && panel.launchAgentId && isRuntimeAgentTerminal(panel)
          ? panel.launchAgentId
          : null,
      followers:
        index === -1
          ? []
          : state.panelIds
              .slice(index + 1)
              .filter((other) => !closing.has(other))
              .slice(0, MAX_FOLLOWERS),
      status: "trashed",
    });
  }
  if (panels.length === 0) return null;

  const groups: ClosedGroup[] = [];
  for (const group of state.tabGroups.values()) {
    if (!group.panelIds.some((id) => closing.has(id))) continue;
    groups.push({
      id: group.id,
      location: group.location === "dock" ? "dock" : "grid",
      worktreeId: group.worktreeId,
      panelIds: [...group.panelIds],
      activeTabId: group.activeTabId ?? null,
    });
  }

  const focused = state.focusedId;
  const focusedGroup = groups.find((group) => focused !== null && group.panelIds.includes(focused));
  const focusId =
    focused !== null && panels.some((panel) => panel.id === focused)
      ? focused
      : (focusedGroup?.activeTabId ??
        groups.find((group) => group.activeTabId !== null)?.activeTabId ??
        panels[0]!.id);
  return { panels, groups, focusId };
}

// A panel restored another way (the trash pill, Cmd+Shift+T, Canopy) leaves
// the history; one the trash let go stays only if a conversation can resume.
function reconcile(state: PanelState): void {
  let changed = false;
  const next: CloseStep[] = [];
  for (const step of steps) {
    let stepChanged = false;
    const panels: ClosedPanel[] = [];
    for (const closed of step.panels) {
      if (closed.status === "expired") {
        panels.push(closed);
        continue;
      }
      const panel = Object.hasOwn(state.panelsById, closed.id)
        ? state.panelsById[closed.id]
        : undefined;
      if (panel?.location === "trash") {
        panels.push(closed);
        continue;
      }
      stepChanged = true;
      if (panel === undefined && closed.agentId !== null) {
        panels.push({ ...closed, status: "expired", expiredAt: Date.now() });
      }
    }
    changed ||= stepChanged;
    if (panels.length === 0) continue;
    next.push(stepChanged ? { ...step, panels } : step);
  }
  if (changed) setSteps(next);
}

function setSteps(next: CloseStep[]): void {
  steps = next;
  if (steps.length === 0) {
    unsubscribe?.();
    unsubscribe = null;
  } else if (unsubscribe === null && panelStore !== null) {
    unsubscribe = panelStore.subscribe((state, previous) => {
      if (state.panelsById !== previous.panelsById) reconcile(state);
    });
  }
}

function record(store: PanelStoreApi, seq: number, snapshot: CloseSnapshot): void {
  const { panelsById } = store.getState();
  // A remove-on-exit or dialog panel is discarded rather than trashed: there
  // is nothing of it to bring back.
  const panels = snapshot.panels.filter((closed) => panelsById[closed.id]?.location === "trash");
  if (panels.length === 0) return;
  const step: CloseStep = {
    seq,
    closedAt: Date.now(),
    projectId: getCurrentProjectId(),
    panels,
    groups: snapshot.groups,
    focusId: panels.some((closed) => closed.id === snapshot.focusId)
      ? snapshot.focusId
      : panels[0]!.id,
  };
  setSteps([...steps, step].sort((a, b) => b.seq - a.seq).slice(0, MAX_CLOSE_STEPS));
}

/**
 * Snapshots a close the person is making, before anything moves, and returns
 * the runner for its commit: the close is recorded once the commit has sent
 * its panels to the trash. A commit that never runs (a guard said no) records
 * nothing.
 */
export function prepareUserClose(panelIds: readonly string[]): (commit: () => void) => void {
  const store = panelStore;
  if (store === null) return (commit) => commit();
  const seq = nextCloseSeq();
  trackNativeFieldEdits();
  // Whatever goes wrong here, the close itself still happens.
  let snapshot: CloseSnapshot | null = null;
  try {
    snapshot = snapshotClose(store.getState(), panelIds);
  } catch (error) {
    logWarn("Couldn't record a close for undo", { error });
  }
  return (commit) => {
    commit();
    if (snapshot === null) return;
    try {
      record(store, seq, snapshot);
    } catch (error) {
      logWarn("Couldn't record a close for undo", { error });
    }
  };
}

/**
 * The commit to hand the close coordinator: recorded when a person asked for
 * the close, as it was otherwise.
 */
export function userCloseCommit(
  source: ActionSource | undefined,
  panelIds: readonly string[],
  commit: () => void
): () => void {
  if (!isForegroundDispatch(source)) return commit;
  const run = prepareUserClose(panelIds);
  return () => run(commit);
}

/** The newest close in this project that may still come back. */
export function peekUndoCloseStep(): CloseStep | null {
  const projectId = getCurrentProjectId();
  return steps.find((step) => step.projectId === projectId) ?? null;
}

/** Takes the newest close out of the history, for restoring it. */
export function takeUndoCloseStep(): CloseStep | null {
  const step = peekUndoCloseStep();
  if (step !== null) setSteps(steps.filter((entry) => entry !== step));
  return step;
}

/** Test seam. */
export function resetPanelCloseHistoryForTests(): void {
  setSteps([]);
}
