import { buildResumeCommand } from "@shared/types/agentSettings";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useResumedSessionPanelStore } from "@/store/resumedSessionPanelStore";
import { getWorktreeIdSet, getWorktreePathIndex } from "@/store/storeAccessors";
import { resumeSessionForPerson } from "@/services/agentResumeForPerson";
import { logError } from "@/utils/logger";
import {
  peekUndoCloseStep,
  returnUndoCloseStep,
  takeUndoCloseStep,
  type ClosedGroup,
  type ClosedPanel,
  type CloseStep,
} from "./panelCloseHistory";
import { settleRestoreFocus } from "./settledRestores";

/**
 * How long after the trash let an agent's panel go a press waits for its
 * conversation to be captured: the graceful shutdown that captures it takes
 * a few seconds of its own.
 */
export const CAPTURE_WAIT_MS = 10_000;

type PanelState = ReturnType<typeof usePanelStore.getState>;

export interface UndoCloseOptions {
  /**
   * Asked before falling through to an older close once a newer one had
   * nothing left: whether something newer than that older close (typing in
   * the focused field) should have the key instead.
   */
  yieldsTo?: (step: CloseStep) => boolean;
  /** Runs instead when it yields, so the press still undoes something. */
  onYield?: () => void;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Takes back the newest close in this project that can still come back,
 * skipping any with nothing left (a shell the trash let go, an agent whose
 * conversation wasn't captured). Presses queue, so each takes the next older
 * close and the last one pressed ends with focus. Resolves whether anything
 * came back.
 */
export function undoLastClose(options: UndoCloseOptions = {}): Promise<boolean> {
  const run = queue.then(
    () => restoreNewestClose(options),
    () => restoreNewestClose(options)
  );
  queue = run.catch(() => undefined);
  return run;
}

async function restoreNewestClose({ yieldsTo, onYield }: UndoCloseOptions): Promise<boolean> {
  for (let first = true; ; first = false) {
    const next = peekUndoCloseStep();
    // Past a close with nothing left, the field's own typing is the newest
    // thing in reach: with no older close, or one older than that typing.
    if (next === null || (!first && yieldsTo?.(next) === true)) {
      if (!first) onYield?.();
      return false;
    }
    const step = takeUndoCloseStep();
    if (step === null) return false;
    try {
      const outcome = await restoreStep(step);
      if (outcome === "restored") return true;
      if (outcome === "deferred") {
        returnUndoCloseStep(step);
        return false;
      }
    } catch (error) {
      logError("Failed to reopen a closed panel", error);
    }
  }
}

async function restoreStep(step: CloseStep): Promise<"restored" | "nothing" | "deferred"> {
  // Closed id → the id it is open under now: the same for a panel the trash
  // still held, a new one for a resumed conversation.
  const restored = new Map<string, string>();
  restoreFromTrash(step, restored);
  const expired = step.panels.filter((closed) => closed.status === "expired");
  for (const [index, closed] of expired.entries()) {
    const id = await resumeExpired(step, closed);
    // Waiting on a capture can outlast the view being on screen. Spawning
    // into a project the person has left would change what they can't see,
    // so whatever hasn't come back yet waits in the history for their return.
    if (id === "hidden") {
      if (restored.size === 0) return "deferred";
      // What came back already answers under its new id, so the rest can
      // still rejoin it.
      const renamed = (id: string) => restored.get(id) ?? id;
      returnUndoCloseStep({
        ...step,
        panels: expired.slice(index),
        groups: step.groups.map((group) => ({
          ...group,
          panelIds: group.panelIds.map(renamed),
          activeTabId: group.activeTabId === null ? null : renamed(group.activeTabId),
        })),
      });
      break;
    }
    if (id !== null) restored.set(closed.id, id);
  }
  if (restored.size === 0) return "nothing";
  for (const group of step.groups) rejoinGroup(group, restored);
  focusRestored(step, restored);
  return "restored";
}

function isInTrash(state: PanelState, id: string): boolean {
  return Object.hasOwn(state.panelsById, id) && state.panelsById[id]?.location === "trash";
}

function worktreeExists(worktreeId: string | null): boolean {
  if (worktreeId === null) return true;
  const known = getWorktreeIdSet();
  return known === null || known.has(worktreeId);
}

function revealWorktree(worktreeId: string | null): void {
  if (worktreeId === null) return;
  const selection = useWorktreeSelectionStore.getState();
  if (selection.activeWorktreeId !== worktreeId) {
    selection.selectWorktree(worktreeId, { source: "user" });
  }
}

/**
 * The panels the trash still holds come back as they were: same process,
 * scrollback and place. A panel whose worktree has since been deleted goes
 * where the trash's own Restore puts it, into the active worktree, and stays
 * in the trash when there is none.
 */
function restoreFromTrash(step: CloseStep, restored: Map<string, string>): void {
  const state = usePanelStore.getState();
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  // `undefined` restores in place, a worktree id re-homes an orphan.
  const targets = new Map<string, string | undefined>();
  for (const closed of step.panels) {
    if (closed.status !== "trashed" || !isInTrash(state, closed.id)) continue;
    if (worktreeExists(closed.worktreeId)) targets.set(closed.id, undefined);
    else if (activeWorktreeId) targets.set(closed.id, activeWorktreeId);
  }
  if (targets.size === 0) return;

  const ids = [...targets.keys()];
  const focusId = step.focusId !== null && targets.has(step.focusId) ? step.focusId : ids[0]!;
  for (const id of ids) {
    if (panelKindHasPty(state.panelsById[id]?.kind ?? "terminal")) settleRestoreFocus(id);
  }
  revealWorktree(targets.get(focusId) ?? state.panelsById[focusId]?.worktreeId ?? null);

  // A group closed whole comes back through the trash's group restore, which
  // rebuilds it; the rest one by one. The focused one goes last, and takes
  // focus, leaving fullscreen and Home the way a trash restore does.
  const groupOf = (id: string) => usePanelStore.getState().trashedTerminals.get(id)?.groupRestoreId;
  const focusGroup = groupOf(focusId);
  // Group restore id → one of its members, whose target the group shares.
  const groups = new Map<string, string>();
  for (const id of ids) {
    const groupRestoreId = groupOf(id);
    if (groupRestoreId !== undefined) {
      if (!groups.has(groupRestoreId)) groups.set(groupRestoreId, id);
      continue;
    }
    if (id === focusId) continue;
    usePanelStore.getState().restoreTerminal(id, targets.get(id), { keepFocus: true });
  }
  for (const [groupRestoreId, memberId] of groups) {
    if (groupRestoreId === focusGroup) continue;
    usePanelStore.getState().restoreTrashedGroup(groupRestoreId, targets.get(memberId));
  }
  if (focusGroup !== undefined) {
    usePanelStore.getState().restoreTrashedGroup(focusGroup, targets.get(focusId));
  } else {
    usePanelStore.getState().restoreTerminal(focusId, targets.get(focusId));
  }

  const after = usePanelStore.getState();
  for (const id of ids) {
    if (Object.hasOwn(after.panelsById, id) && !isInTrash(after, id)) restored.set(id, id);
  }
}

/**
 * An agent the trash has let go comes back as its own conversation, resumed
 * by its captured session id in a new panel where the old one was. Never the
 * newest journal record, and never "resume latest": a close with no captured
 * session has nothing to bring back.
 */
async function resumeExpired(
  step: CloseStep,
  closed: ClosedPanel
): Promise<string | "hidden" | null> {
  if (closed.agentId === null) return null;
  const record = await findCapturedSession(step, closed);
  if (record === "hidden" || isViewHidden()) return "hidden";
  if (record === null || buildResumeCommand(record.agentId, record.sessionId) === undefined) {
    return null;
  }
  // Already brought back another way (Canopy's Trash, Resume Sessions): this
  // close is done, and the press goes on to an older one.
  if (isSessionOpen(record.sessionId)) return null;
  let outcome;
  try {
    outcome = await resumeSessionForPerson(record, getWorktreePathIndex());
  } catch (error) {
    logError("Failed to resume a closed agent's session", error);
    return null;
  }
  if (outcome.outcome === "created") {
    useResumedSessionPanelStore
      .getState()
      .markResumed(outcome.terminalId, (id) =>
        Object.hasOwn(usePanelStore.getState().panelsById, id)
      );
    placeResumed(closed, outcome.terminalId);
  }
  return outcome.terminalId;
}

function isSessionOpen(sessionId: string): boolean {
  const { panelIds, panelsById } = usePanelStore.getState();
  return panelIds.some((id) => {
    const panel = panelsById[id];
    return (
      panel !== undefined &&
      isPtyPanel(panel) &&
      panel.location !== "trash" &&
      panel.location !== "dialog" &&
      panel.agentSessionId === sessionId
    );
  });
}

function pickCapture(
  records: readonly AgentSessionRecord[],
  step: CloseStep,
  closed: ClosedPanel
): AgentSessionRecord | null {
  let best: AgentSessionRecord | null = null;
  for (const record of records) {
    if (record.terminal?.id !== closed.id || record.savedAt < step.closedAt) continue;
    if (best === null || record.savedAt > best.savedAt) best = record;
  }
  return best;
}

async function listSessions(projectId: string | null): Promise<AgentSessionRecord[]> {
  try {
    return (
      (await window.electron?.agentSessionHistory?.list(undefined, projectId ?? undefined)) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Waits for the next journaled session, the deadline, or the view going out
 * of sight, and resolves whether it went out of sight: a return before either
 * of the others would hide that it ever left.
 */
function waitForRecordedSession(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    // All are bound before any can fire: each only calls back on a later task.
    const done = (hidden: boolean) => {
      clearTimeout(timer);
      unsubscribe?.();
      document.removeEventListener("visibilitychange", onVisibility);
      resolve(hidden);
    };
    const onVisibility = () => {
      if (document.hidden) done(true);
    };
    const timer = setTimeout(() => done(false), Math.max(0, ms));
    const unsubscribe = window.electron?.events?.on("agent-session:recorded", () => done(false));
    document.addEventListener("visibilitychange", onVisibility);
  });
}

function isViewHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

async function findCapturedSession(
  step: CloseStep,
  closed: ClosedPanel
): Promise<AgentSessionRecord | "hidden" | null> {
  // Out of sight at any point, even briefly, and the lookup stops: the close
  // waits for the person's next press instead.
  let wentHidden = isViewHidden();
  const onVisibility = () => {
    if (document.hidden) wentHidden = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  try {
    const deadline = (closed.expiredAt ?? step.closedAt) + CAPTURE_WAIT_MS;
    for (;;) {
      const found = pickCapture(await listSessions(step.projectId), step, closed);
      if (wentHidden || isViewHidden()) return "hidden";
      if (found !== null || Date.now() >= deadline) return found;
      if (await waitForRecordedSession(deadline - Date.now())) return "hidden";
    }
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

function placeResumed(closed: ClosedPanel, id: string): void {
  if (closed.location === "dock" && usePanelStore.getState().panelsById[id]?.location !== "dock") {
    usePanelStore.getState().moveTerminalToPosition(id, 0, "dock", closed.worktreeId);
  }
  const order = usePanelStore.getState().panelIds.filter((other) => other !== id);
  const follower = closed.followers.find((other) => order.includes(other));
  order.splice(follower === undefined ? order.length : order.indexOf(follower), 0, id);
  usePanelStore.getState().restoreTerminalOrder(order);
}

function isOpenAt(
  state: PanelState,
  id: string,
  location: "grid" | "dock",
  worktreeId: string | undefined
): boolean {
  if (!Object.hasOwn(state.panelsById, id)) return false;
  const panel = state.panelsById[id];
  if (!panel) return false;
  const at =
    panel.location === "dock"
      ? "dock"
      : panel.location === "grid" || panel.location === undefined
        ? "grid"
        : null;
  return at === location && (panel.worktreeId ?? undefined) === worktreeId;
}

/**
 * Puts restored panels back into the tab group they left: a closed tab rejoins
 * its group at its old place, and a group the close dissolved is rebuilt from
 * whichever of its members are open where the restored ones landed (an orphan
 * re-homed to the active worktree takes its group along). A member that has
 * joined a group of the person's own since stays there.
 */
function rejoinGroup(group: ClosedGroup, restored: ReadonlyMap<string, string>): void {
  const state = usePanelStore.getState();
  const restoredIds = new Set(restored.values());
  const mapped = group.panelIds.map((id) => restored.get(id) ?? id);
  const anchor = mapped.find((id) => restoredIds.has(id));
  if (anchor === undefined) return;
  const worktreeId = state.panelsById[anchor]?.worktreeId ?? undefined;
  // The group as it stands now: its own id, or one rebuilt from nothing but
  // its own members (by the trash's group restore, or an earlier undo). A
  // group holding anything else is one the person made since.
  const memberSet = new Set(mapped);
  let target = state.tabGroups.get(group.id);
  if (target === undefined) {
    for (const id of mapped) {
      const current = state.getPanelGroup(id);
      if (current !== undefined && current.panelIds.every((member) => memberSet.has(member))) {
        target = current;
        break;
      }
    }
  }
  const targetId = target?.id;
  const members = mapped.filter((id) => {
    if (!isOpenAt(state, id, group.location, worktreeId)) return false;
    const current = state.getPanelGroup(id);
    return current === undefined || current.id === targetId;
  });
  if (members.length < 2) return;

  if (targetId === undefined) {
    const active =
      group.activeTabId === null
        ? undefined
        : (restored.get(group.activeTabId) ?? group.activeTabId);
    state.createTabGroup(
      group.location,
      worktreeId,
      members,
      active !== undefined && members.includes(active) ? active : undefined
    );
    return;
  }

  for (const id of members) {
    const latest = usePanelStore.getState();
    if (latest.getPanelGroup(id)?.id === targetId) continue;
    const rank = members.indexOf(id);
    const current = latest.tabGroups.get(targetId)?.panelIds ?? [];
    let index = 0;
    current.forEach((member, position) => {
      const memberRank = members.indexOf(member);
      if (memberRank !== -1 && memberRank < rank) index = position + 1;
    });
    latest.addPanelToGroup(targetId, id, index);
  }
}

function focusRestored(step: CloseStep, restored: ReadonlyMap<string, string>): void {
  const focusId =
    (step.focusId !== null ? restored.get(step.focusId) : undefined) ??
    restored.values().next().value;
  if (focusId === undefined) return;
  const state = usePanelStore.getState();
  const group = state.getPanelGroup(focusId);
  if (group !== undefined) state.setActiveTab(group.id, focusId);
  state.activateTerminal(focusId);
}
