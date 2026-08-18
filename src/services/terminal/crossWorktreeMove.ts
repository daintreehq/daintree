import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { classifyLaunchRootAlignment } from "@/utils/worktreeAlignment";
import { cancelWorktreeMoveInstruction } from "@/services/terminal/worktreeMoveInstruction";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";

/**
 * Whether the panel's process can still act on the filesystem right now.
 *
 * Mirrors the exit vocabulary `deriveTerminalChrome` uses. A panel that has
 * exited needs no banner — it can't write anything — but it still needs its
 * next-launch cwd aligned, because a restart would relaunch it in the old
 * worktree and reproduce the bug.
 */
export function isPanelProcessLive(panel: PanelInstance | undefined): boolean {
  // `isPtyPanel` narrows to the built-in terminal kind, which is the whole scope
  // of this feature — a PTY-backed plugin panel has no `cwd` field to reason
  // about and nothing to tell.
  if (!panel || !isPtyPanel(panel)) return false;
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

/**
 * Panels a single move gesture relocates. A grouped drag moves the whole tab
 * group, so every member is in scope even though only one was dragged.
 */
export function collectMovedPanelIds(terminalId: string): string[] {
  const group = usePanelStore.getState().getPanelGroup(terminalId);
  if (!group) return [terminalId];
  const state = usePanelStore.getState();
  const panelIds = group.panelIds.filter((pid) => {
    const panel = state.panelsById[pid];
    return panel && panel.location !== "trash" && !state.trashedTerminals.has(pid);
  });
  return panelIds.length > 0 ? panelIds : [terminalId];
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

/**
 * Bring one moved panel's after-effects in line with where it now lives.
 *
 * Three outcomes, and the split is the whole point of #11853:
 *  - exited: no banner, just re-point the next launch (`alignDeadPanelCwd`).
 *  - live, but not an agent, or provably still on its launch root: nothing.
 *    Telling a plain shell to `cd` types junk at the prompt, and a panel that
 *    never left its launch root has nothing to be told.
 *  - live agent off its launch root: raise the pane's banner and let the user
 *    decide whether to say anything.
 *
 * `unknown` alignment raises the banner too. It is not proof of alignment, and
 * treating "can't prove it" as "it's fine" is the silence #11840 existed to end
 * — but a dismissible bar is the honest cost of asking, where a modal was not.
 */
function reconcileMovedPanel(panelId: string, destinationWorktreeId: string): void {
  const store = usePanelStore.getState();
  const panel = store.panelsById[panelId];
  if (!panel || !isPtyPanel(panel)) return;

  // Any move invalidates a queued instruction: it names the *previous*
  // destination's path, and delivering that after a second move would send the
  // agent somewhere the user has already moved on from.
  cancelWorktreeMoveInstruction(panelId);

  if (!isPanelProcessLive(panel)) {
    alignDeadPanelCwd(panelId, destinationWorktreeId);
    store.setWorktreeMoveNotice(panelId, undefined);
    return;
  }

  const alignment = classifyLaunchRootAlignment(
    panel.cwd,
    readWorktreePaths(),
    destinationWorktreeId
  );
  const needsNotice = !!panel.launchAgentId && alignment !== "aligned";
  // Clearing on the aligned branch is what makes dragging a panel back to the
  // worktree it launched in put the bar away, rather than leaving a stale one
  // pointing at a destination the panel has left.
  store.setWorktreeMoveNotice(panelId, needsNotice ? { destinationWorktreeId } : undefined);
}

/**
 * Cross-worktree move that follows the terminal when the gesture rescues the
 * last survivor off a deleted-worktree row (#11273).
 *
 * A deleted-worktree row is derived state: it lives only while a panel still
 * points at the dead worktree, and `WorktreeStoreContext`'s panel-store
 * subscriber prunes it synchronously during the move below. Without a follow,
 * the row vanishes under the user's own selection and `useActiveWorktreeSync`
 * snaps to main, stranding the rescued session off-screen.
 *
 * The follow decision is a before/after membership diff rather than a
 * "was this the last terminal" prediction, so it cannot drift from the prune's
 * own rule and it covers grouped moves (which relocate the whole tab group)
 * for free. Every other row-death route — closed, trashed, dismissed,
 * auto-cleanup — never reaches here and keeps falling back to main.
 *
 * Rescue is the *only* reason this follows. #11840 briefly made every move
 * follow, because its blocking dialog was useless on a row the user wasn't
 * looking at; #11853 replaced that dialog with a per-panel banner that waits in
 * the pane instead, so an ordinary move has no reason to move the user.
 *
 * This is also the one choke point every gesture funnels through — both drags
 * and `terminal.moveToWorktree`, and `moveToNewWorktree` once its worktree
 * exists — which is what keeps the context-menu and create paths from drifting
 * away from the drag paths.
 */
export function moveTerminalToWorktreeAndFollowRescue(
  terminalId: string,
  targetWorktreeId: string
): void {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel || panel.worktreeId === targetWorktreeId) return;

  const sourceWorktreeId = panel.worktreeId;
  const before = useWorktreeSelectionStore.getState();
  const isRescue = sourceWorktreeId != null && before.deletedWorktrees.has(sourceWorktreeId);
  const wasRescuingActiveDeletedRow = isRescue && before.activeWorktreeId === sourceWorktreeId;

  // Collected before the move: a grouped drag relocates the whole tab group,
  // and reading membership afterwards would classify against the destination
  // the panels have already been filed under.
  const movedPanelIds = collectMovedPanelIds(terminalId);

  usePanelStore.getState().moveTerminalToWorktree(terminalId, targetWorktreeId);
  usePanelStore.getState().setFocused(null);

  // Per panel, not per group. A dragged tab group gives each member its own bar
  // when the user switches to it — no one click that messages four agents.
  for (const panelId of movedPanelIds) {
    reconcileMovedPanel(panelId, targetWorktreeId);
  }

  if (!wasRescuingActiveDeletedRow) return;

  // Re-read: the prune replaced the selection state and its `deletedWorktrees`
  // map, so the pre-move snapshot is stale.
  const after = useWorktreeSelectionStore.getState();
  if (after.deletedWorktrees.has(sourceWorktreeId)) return;

  // The drag paths already reject a dead destination, but `terminal.moveToWorktree`
  // takes any string from the action layer. Following an unverified id would make
  // it the durable restore target, so confirm liveness rather than trusting the
  // caller — and skip the follow entirely if no view store can answer.
  if (!getCurrentViewStoreOrNull()?.getState().worktrees.has(targetWorktreeId)) return;

  // `"user"`, not `"focus"`: the rescue is a deliberate gesture, so the
  // destination should become the durable restore target and land in the MRU
  // (#9512). This also restores the destination's last-focused terminal, which
  // is what the fallback-to-main path already did — only the target changes.
  after.selectWorktree(targetWorktreeId);
  after.retargetParkedFleetSelection(targetWorktreeId);
}
