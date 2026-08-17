import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import {
  useWorktreeMoveDecisionStore,
  type WorktreeMoveDecisionMember,
  type WorktreeMoveDecisionRequest,
} from "@/store/worktreeMoveDecisionStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { classifyLaunchRootAlignment, resolveLaunchCwd } from "@/utils/worktreeAlignment";
import { getAgentConfig } from "@/config/agents";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { logWarn } from "@/utils/logger";

export type WorktreeMoveOutcome = "transfer" | "move-only" | "cancel";

/**
 * Whether the panel's process can still act on the filesystem right now.
 *
 * Mirrors the exit vocabulary `deriveTerminalChrome` uses. A panel that has
 * exited needs no decision — it can't write anything — but it still needs its
 * next-launch cwd aligned, because a restart would relaunch it in the old
 * worktree and reproduce the bug.
 */
export function isPanelProcessLive(panel: PanelInstance | undefined): boolean {
  if (!panel || !isPtyPanel(panel)) return false;
  if (!panelKindHasPty(panel.kind ?? "terminal")) return false;
  if (panel.location === "trash") return false;
  if (panel.agentState === "exited") return false;
  if (panel.runtimeStatus === "exited" || panel.runtimeStatus === "error") return false;
  if (typeof panel.exitCode === "number") return false;
  return true;
}

/** Worktrees as `inferWorktreeIdFromCwd` wants them, from the live view store. */
function readWorktreePaths(): { id: string; path: string; name?: string }[] {
  const view = getCurrentViewStoreOrNull();
  if (!view) return [];
  return [...view.getState().worktrees.values()].map((w) => ({
    id: w.id,
    path: w.path,
    name: w.name,
  }));
}

function worktreeLabel(worktreeId: string | undefined): string | undefined {
  if (!worktreeId) return undefined;
  const match = readWorktreePaths().find((w) => w.id === worktreeId);
  return match?.name ?? match?.path ?? worktreeId;
}

/** HEAD of a worktree as last polled, for the drift backstop's baseline. */
export function readWorktreeHeadOid(worktreeId: string | undefined): string | undefined {
  if (!worktreeId) return undefined;
  return getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId)?.worktreeChanges
    ?.headOid;
}

/**
 * Panels a single move gesture relocates. A grouped drag moves the whole tab
 * group, so every member is in scope even though only one was dragged.
 */
export function collectMovedPanelIds(terminalId: string): {
  panelIds: string[];
  groupId?: string;
} {
  const group = usePanelStore.getState().getPanelGroup(terminalId);
  if (!group) return { panelIds: [terminalId] };
  const state = usePanelStore.getState();
  const panelIds = group.panelIds.filter((pid) => {
    const panel = state.panelsById[pid];
    return panel && panel.location !== "trash" && !state.trashedTerminals.has(pid);
  });
  return { panelIds: panelIds.length > 0 ? panelIds : [terminalId], groupId: group.id };
}

/**
 * Point a panel's next launch at the worktree it is now filed under.
 *
 * Only for panels whose process has already exited: they can't write anything
 * now, but their next restart would reuse the stale cwd and reproduce the bug.
 * Scoped to a proven mismatch — a cwd under no worktree at all is `unknown`, and
 * re-homing one of those would silently move a shell the user deliberately
 * launched somewhere else.
 */
export function alignDeadPanelCwd(panelId: string, worktreeId: string): void {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || !isPtyPanel(panel)) return;
  const worktrees = readWorktreePaths();
  if (classifyLaunchRootAlignment(panel.cwd, worktrees, worktreeId) !== "launch-root-mismatch") {
    return;
  }
  const destination = worktrees.find((w) => w.id === worktreeId);
  if (!destination?.path) return;
  usePanelStore.getState().updateTerminalCwd(panelId, destination.path);
}

function setDecisionInputLock(panelIds: readonly string[], locked: boolean): void {
  for (const panelId of panelIds) {
    // Instance-level, never the store action: the store action persists
    // `isInputLocked: true` to disk, and a lock held only until the user answers
    // must not survive a quit mid-decision (restart.ts documents the same).
    terminalInstanceService.setInputLocked(panelId, locked);
  }
}

/**
 * Make the destination the active worktree so the decision is actually on
 * screen. The rescue path follows conditionally; this one has to follow every
 * time — a dialog about a panel the user isn't looking at is the same failure
 * the dismissible-banner approach had.
 */
function followDestination(targetWorktreeId: string): void {
  const selection = useWorktreeSelectionStore.getState();
  if (selection.activeWorktreeId === targetWorktreeId) return;
  // The action layer takes any string; following an unverified id would make it
  // the durable restore target.
  if (!getCurrentViewStoreOrNull()?.getState().worktrees.has(targetWorktreeId)) return;
  selection.selectWorktree(targetWorktreeId);
  selection.retargetParkedFleetSelection(targetWorktreeId);
}

async function readBackendCwd(panelId: string): Promise<string | undefined> {
  try {
    const info = await window.electron.terminal.getInfo(panelId);
    return info?.cwd ?? undefined;
  } catch (error) {
    // The panel's own cwd is the documented fallback. Never a reason to skip
    // the decision.
    logWarn("[WorktreeMove] terminal.getInfo failed; falling back to panel cwd", {
      panelId,
      error,
    });
    return undefined;
  }
}

async function describeMember(
  panelId: string,
  destinationWorktreeId: string
): Promise<WorktreeMoveDecisionMember | null> {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || !isPtyPanel(panel)) return null;

  const backendCwd = await readBackendCwd(panelId);
  const launchCwd = resolveLaunchCwd(panel.cwd, backendCwd);
  const worktrees = readWorktreePaths();
  const alignment = classifyLaunchRootAlignment(launchCwd, worktrees, destinationWorktreeId);
  const launchWorktreeId = worktrees.find(
    (w) => classifyLaunchRootAlignment(launchCwd, worktrees, w.id) === "aligned"
  )?.id;

  return {
    panelId,
    title: panel.title,
    alignment,
    launchCwd,
    launchWorktreeId,
    launchWorktreeLabel: worktreeLabel(launchWorktreeId) ?? launchCwd,
  };
}

function firstAgentLabel(panelIds: readonly string[]): string | undefined {
  const state = usePanelStore.getState();
  for (const panelId of panelIds) {
    const panel = state.panelsById[panelId];
    if (!panel || !isPtyPanel(panel)) continue;
    const agentId = panel.detectedAgentId ?? panel.launchAgentId;
    if (agentId) return getAgentConfig(agentId)?.name;
  }
  return undefined;
}

/**
 * Classify the moved panels and either open the decision or let the move stand.
 *
 * Runs after the layout move has already landed, so it must never assume the
 * panels still carry their old worktree. Unlocks on every path that does not
 * hand off to the dialog — including the failure paths, so a panel can't be
 * left permanently unusable by a classification that threw.
 */
async function resolveDecisionOrRelease(
  panelIds: string[],
  destinationWorktreeId: string,
  sourceWorktreeId: string | undefined,
  groupId: string | undefined
): Promise<void> {
  try {
    const described = await Promise.all(
      panelIds.map((panelId) => describeMember(panelId, destinationWorktreeId))
    );
    const members = described.filter((m): m is WorktreeMoveDecisionMember => m !== null);

    // `unknown` asks. It is not proof of alignment, and treating it as such is
    // how the silent divergence happened in the first place.
    const needsDecision = members.filter((m) => m.alignment !== "aligned");
    if (needsDecision.length === 0) {
      setDecisionInputLock(panelIds, false);
      return;
    }

    useWorktreeMoveDecisionStore.getState().request({
      destinationWorktreeId,
      destinationWorktreeLabel: worktreeLabel(destinationWorktreeId) ?? destinationWorktreeId,
      sourceWorktreeId,
      members,
      groupId,
      agentLabel: firstAgentLabel(needsDecision.map((m) => m.panelId)),
    });
  } catch (error) {
    logWarn("[WorktreeMove] decision classification failed; releasing input lock", { error });
    setDecisionInputLock(panelIds, false);
  }
}

/**
 * Gate a cross-worktree move behind a decision when it would leave a live
 * process running somewhere other than where the panel now claims to be.
 *
 * Returns `false` when the caller should carry on with the plain move.
 * When it returns `true` it has already locked input, moved the panels, and
 * followed the destination; the decision resolves asynchronously.
 */
export function beginWorktreeMoveDecision(
  terminalId: string,
  targetWorktreeId: string,
  applyMove: () => void
): boolean {
  const { panelIds, groupId } = collectMovedPanelIds(terminalId);
  const state = usePanelStore.getState();
  const livePanelIds = panelIds.filter((pid) => isPanelProcessLive(state.panelsById[pid]));
  const sourceWorktreeId = state.panelsById[terminalId]?.worktreeId;

  if (livePanelIds.length === 0) {
    applyMove();
    // Exited panels skip the decision but still get their next launch pointed at
    // the worktree they now live under.
    for (const panelId of panelIds) alignDeadPanelCwd(panelId, targetWorktreeId);
    return false;
  }

  setDecisionInputLock(livePanelIds, true);
  applyMove();
  followDestination(targetWorktreeId);
  void resolveDecisionOrRelease(livePanelIds, targetWorktreeId, sourceWorktreeId, groupId);
  return true;
}

/**
 * Apply the user's answer. Always releases the input lock and clears the
 * pending decision, whatever the outcome or however it fails.
 */
export async function resolveWorktreeMoveDecision(
  request: WorktreeMoveDecisionRequest,
  outcome: WorktreeMoveOutcome
): Promise<void> {
  const panelIds = request.members.map((m) => m.panelId);
  try {
    if (outcome === "cancel") {
      // Layout undo restores `worktreeId` and tab-group membership, which is the
      // whole of what the move changed — nothing has been restarted yet, so
      // there is no process state to put back.
      useLayoutUndoStore.getState().undo();
      if (request.sourceWorktreeId) followDestination(request.sourceWorktreeId);
      return;
    }

    if (outcome === "transfer") {
      const store = usePanelStore.getState();
      // Per member, against that member's own launch root: sharing a tab group
      // does not mean sharing a launch directory.
      for (const panelId of panelIds) {
        await store.transferPanelToWorktree(panelId, request.destinationWorktreeId);
      }
      return;
    }

    const now = Date.now();
    for (const member of request.members) {
      const panel = usePanelStore.getState().panelsById[member.panelId];
      if (!panel || !isPtyPanel(panel)) continue;
      usePanelStore.getState().setWorktreeMoveOptOut(member.panelId, {
        acknowledgedCwd: panel.cwd,
        acknowledgedWorktreeId: request.destinationWorktreeId,
        launchWorktreeId: member.launchWorktreeId,
        sourceHeadOid: readWorktreeHeadOid(member.launchWorktreeId),
        at: now,
      });
    }
  } finally {
    setDecisionInputLock(panelIds, false);
    useWorktreeMoveDecisionStore.getState().clear();
  }
}
