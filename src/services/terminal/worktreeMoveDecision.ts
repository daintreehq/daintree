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
import {
  saveNormalized as savePanelsNormalized,
  saveTabGroups,
} from "@/store/slices/panelRegistry/persistence";
import { classifyLaunchRootAlignment, resolveLaunchCwd } from "@/utils/worktreeAlignment";
import { getAgentConfig } from "@/config/agents";
import { isPtyPanel, type PanelInstance, type PanelWorktreeMoveOptOut } from "@shared/types/panel";
import { logWarn } from "@/utils/logger";

export type WorktreeMoveOutcome = "transfer" | "move-only" | "cancel";

/**
 * The one move currently awaiting an answer.
 *
 * The decision store holds a single pending request, but a request only appears
 * once classification has resolved — an IPC round trip after the panels have
 * already moved. Two drops inside that window would both see an empty store and
 * the later classifier would overwrite the earlier request, stranding its panels
 * locked with nothing left to release them. Claiming this synchronously, before
 * anything moves, gives every async continuation something to check itself
 * against.
 */
let activeTransaction: { id: number; lockedPanelIds: string[] } | null = null;
let nextTransactionId = 1;

/** Test seam — module state outlives any single component by design. */
export function __resetWorktreeMoveDecisionState(): void {
  activeTransaction = null;
}

/**
 * Whether the panel's process can still act on the filesystem right now.
 *
 * Mirrors the exit vocabulary `deriveTerminalChrome` uses. A panel that has
 * exited needs no decision — it can't write anything — but it still needs its
 * next-launch cwd aligned, because a restart would relaunch it in the old
 * worktree and reproduce the bug.
 */
export function isPanelProcessLive(panel: PanelInstance | undefined): boolean {
  // `isPtyPanel` narrows to the built-in terminal kind, which is the whole scope
  // of this feature — a PTY-backed plugin panel has no `cwd` field to reason
  // about and no place to record consent.
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

function worktreeLabel(worktreeId: string | undefined): string | undefined {
  if (!worktreeId) return undefined;
  const match = readWorktreePaths().find((w) => w.id === worktreeId);
  return match?.name ?? match?.path ?? worktreeId;
}

/**
 * HEAD of a worktree as last polled, for the drift backstop's baseline.
 *
 * `null` distinguishes a worktree we have polled and found on an unborn HEAD
 * from one we know nothing about (`undefined`) — without that split, the first
 * commit in a fresh worktree could never register as drift.
 */
export function readWorktreeHeadOid(worktreeId: string | undefined): string | null | undefined {
  if (!worktreeId) return undefined;
  const changes = getCurrentViewStoreOrNull()
    ?.getState()
    .worktrees.get(worktreeId)?.worktreeChanges;
  if (!changes) return undefined;
  return changes.headOid ?? null;
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

/**
 * Flush the panel registry to disk. Layout undo rebuilds the store with a raw
 * `setState` and never saves, so a cancelled move needs this to stop the
 * declined placement surviving on disk.
 */
function persistPanels(): void {
  const { panelsById, panelIds, tabGroups } = usePanelStore.getState();
  savePanelsNormalized(panelsById, panelIds);
  // Tab groups carry their own `worktreeId`, so a grouped move rewrites them
  // too and a panels-only save would leave the declined placement on disk.
  saveTabGroups(tabGroups);
}

function setDecisionInputLock(panelIds: readonly string[], locked: boolean): void {
  const decisions = useWorktreeMoveDecisionStore.getState();
  // Two writes, deliberately. The ephemeral store entry is the durable-enough
  // record `XtermAdapter` reads on mount, so the lock survives the remount that
  // following the destination causes and applies to panels with no live
  // instance at all. The instance write takes effect immediately for a pane
  // that is already mounted.
  //
  // Never the panel-store action: that one persists `isInputLocked: true` to
  // disk, and a lock held only until the user answers must not survive a quit
  // mid-decision (restart.ts documents the same distinction).
  if (locked) decisions.lock(panelIds);
  else decisions.unlock(panelIds);
  for (const panelId of panelIds) {
    terminalInstanceService.setInputLocked(panelId, locked);
  }
}

/**
 * Release a transaction's locks, minus the panels the live transaction holds.
 *
 * A superseded gesture still owns the panels only the *newer* one didn't claim:
 * `releaseSupersededDecision` re-locks any shared panel for the newer
 * transaction, and dragging the same panel twice inside the `terminal.getInfo`
 * window is enough to overlap them. A blind unlock here would drop the input
 * hold while the newer decision's dialog is still up.
 */
function releaseLocksTheLiveTransactionDoesNotHold(panelIds: readonly string[]): void {
  const stillHeld = new Set(activeTransaction?.lockedPanelIds ?? []);
  setDecisionInputLock(
    panelIds.filter((panelId) => !stillHeld.has(panelId)),
    false
  );
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
  const launchWorktreeId = inferLaunchWorktreeId(launchCwd, worktrees);

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
  transactionId: number,
  panelIds: string[],
  alignOnlyPanelIds: string[],
  destinationWorktreeId: string,
  sourceWorktreeId: string | undefined,
  groupId: string | undefined
): Promise<void> {
  try {
    const described = await Promise.all(
      panelIds.map((panelId) => describeMember(panelId, destinationWorktreeId))
    );
    // A newer gesture claimed the slot while we were in IPC. Publishing now
    // would overwrite its request and strand its panels; release ours instead.
    if (activeTransaction?.id !== transactionId) {
      releaseLocksTheLiveTransactionDoesNotHold(panelIds);
      return;
    }
    const members = described.filter((m): m is WorktreeMoveDecisionMember => m !== null);

    // `unknown` asks. It is not proof of alignment, and treating it as such is
    // how the silent divergence happened in the first place.
    const needsDecision = members.filter((m) => m.alignment !== "aligned");
    if (needsDecision.length === 0) {
      for (const panelId of alignOnlyPanelIds) {
        alignDeadPanelCwd(panelId, destinationWorktreeId);
      }
      // Alignment is proven, so the provisional marker was a false alarm.
      for (const panelId of panelIds) clearProvisionalConsent(panelId);
      activeTransaction = null;
      setDecisionInputLock(panelIds, false);
      return;
    }

    useWorktreeMoveDecisionStore.getState().request({
      transactionId,
      destinationWorktreeId,
      destinationWorktreeLabel: worktreeLabel(destinationWorktreeId) ?? destinationWorktreeId,
      sourceWorktreeId,
      members: needsDecision,
      lockedPanelIds: [...panelIds],
      alignOnlyPanelIds: [...alignOnlyPanelIds],
      groupId,
      agentLabel: firstAgentLabel(needsDecision.map((m) => m.panelId)),
    });
  } catch (error) {
    // Fail safe, not open: the panels have already moved, so releasing the lock
    // without a marker would leave exactly the silent divergence this exists to
    // prevent. The provisional consent written before the move stays put, so the
    // panel keeps its indicator and its drift backstop.
    logWarn("[WorktreeMove] decision classification failed; keeping the divergence marked", {
      error,
    });
    if (activeTransaction?.id === transactionId) activeTransaction = null;
    // Same panel-blindness applies here: a throw on an already-superseded
    // transaction must not unlock the panels the newer one is holding.
    releaseLocksTheLiveTransactionDoesNotHold(panelIds);
  }
}

/**
 * Consent captured before a decision started, so cancelling one move cannot
 * erase the marker an earlier, already-answered move left behind.
 */
const priorConsent = new Map<string, PanelWorktreeMoveOptOut | undefined>();

/**
 * Mark the divergence provisionally, before the panels move.
 *
 * The move is durable the moment it lands — `moveTerminalToWorktree` saves —
 * while the decision lives only in renderer memory. If the app dies, or the
 * project view is evicted, between the drop and the answer, the panel would come
 * back filed at the destination with its old cwd, no decision and no marker:
 * the original bug. Writing the marker first makes the crash land in the visible
 * state instead of the silent one. Every outcome then either confirms, refines,
 * or clears it.
 *
 * Classified from `panel.cwd` alone because this has to be synchronous; the
 * backend cross-check refines it when classification resolves.
 */
function recordProvisionalConsent(
  panelIds: readonly string[],
  destinationWorktreeId: string
): void {
  const worktrees = readWorktreePaths();
  const at = Date.now();
  for (const panelId of panelIds) {
    const panel = usePanelStore.getState().panelsById[panelId];
    if (!panel || !isPtyPanel(panel)) continue;
    priorConsent.set(panelId, panel.worktreeMoveOptOut);

    const alignment = classifyLaunchRootAlignment(panel.cwd, worktrees, destinationWorktreeId);
    if (alignment === "aligned") continue;
    const launchWorktreeId = inferLaunchWorktreeId(panel.cwd, worktrees);
    usePanelStore.getState().setWorktreeMoveOptOut(panelId, {
      acknowledgedCwd: panel.cwd,
      acknowledgedWorktreeId: destinationWorktreeId,
      acknowledgedAlignment: alignment,
      launchCwd: panel.cwd,
      launchWorktreeId,
      sourceHeadOid: readWorktreeHeadOid(launchWorktreeId),
      at,
    });
  }
}

/** Put back whatever consent the panel carried before this gesture. */
function clearProvisionalConsent(panelId: string): void {
  if (!priorConsent.has(panelId)) return;
  usePanelStore.getState().setWorktreeMoveOptOut(panelId, priorConsent.get(panelId));
  priorConsent.delete(panelId);
}

/** The worktree a launch root belongs to, when it belongs to one. */
function inferLaunchWorktreeId(
  cwd: string | undefined,
  worktrees: ReadonlyArray<{ id: string; path: string }>
): string | undefined {
  return worktrees.find((w) => classifyLaunchRootAlignment(cwd, worktrees, w.id) === "aligned")?.id;
}

/**
 * Record that a panel is knowingly filed away from where its process runs.
 *
 * The marker is what keeps the divergence visible, so it is written for the
 * unresolvable case too: consent given for a launch root we could not pin down
 * still describes a real divergence, and dropping it would restore the silence.
 */
function recordMoveOnlyConsent(request: WorktreeMoveDecisionRequest, at: number): void {
  for (const member of request.members) {
    const panel = usePanelStore.getState().panelsById[member.panelId];
    if (!panel || !isPtyPanel(panel)) continue;
    usePanelStore.getState().setWorktreeMoveOptOut(member.panelId, {
      acknowledgedCwd: panel.cwd,
      acknowledgedWorktreeId: request.destinationWorktreeId,
      acknowledgedAlignment: member.alignment === "aligned" ? "unknown" : member.alignment,
      launchCwd: member.launchCwd,
      launchWorktreeId: member.launchWorktreeId,
      sourceHeadOid: readWorktreeHeadOid(member.launchWorktreeId),
      at,
    });
  }
}

/**
 * Drop a pending decision that a newer gesture has overtaken.
 *
 * The store holds one pending request, so a second gesture would otherwise
 * discard the first silently — leaving its panels locked, relabelled, and
 * diverged with nothing left to surface it. Superseding therefore resolves the
 * old request the honest way: the move happened and nothing was transferred, so
 * it becomes a recorded move-only divergence with its marker.
 */
function releaseSupersededDecision(): void {
  const previous = activeTransaction;
  activeTransaction = null;
  if (!previous) return;

  const store = useWorktreeMoveDecisionStore.getState();
  const superseded = store.pending;
  if (superseded) {
    store.clear();
    try {
      recordMoveOnlyConsent(superseded, Date.now());
      alignDeadMembers(superseded);
    } catch (error) {
      logWarn("[WorktreeMove] failed to resolve a superseded decision", { error });
    }
  }
  // Whether or not it got as far as publishing, its locks are ours to release —
  // the provisional consent written at its start keeps the divergence visible.
  setDecisionInputLock(previous.lockedPanelIds, false);
}

/**
 * Point the moved panels whose process had already exited at the worktree they
 * now live under. A mixed group — one live agent, one exited pane — still moves
 * as a unit, and the exited pane's next restart would otherwise reuse the old
 * cwd and reproduce the bug the decision just prevented.
 */
function alignDeadMembers(request: WorktreeMoveDecisionRequest): void {
  for (const panelId of request.alignOnlyPanelIds) {
    alignDeadPanelCwd(panelId, request.destinationWorktreeId);
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
  const alignOnlyPanelIds = panelIds.filter((pid) => !livePanelIds.includes(pid));
  const sourceWorktreeId = state.panelsById[terminalId]?.worktreeId;

  if (livePanelIds.length === 0) {
    applyMove();
    // Exited panels skip the decision but still get their next launch pointed at
    // the worktree they now live under.
    for (const panelId of panelIds) alignDeadPanelCwd(panelId, targetWorktreeId);
    return false;
  }

  // The modal blocks a second gesture once it is up, but classification is an
  // IPC round trip and the grid is still live during it. A second drop landing
  // in that window would overwrite the single pending request and strand the
  // first one's panels locked with no dialog left to release them.
  releaseSupersededDecision();

  const transactionId = nextTransactionId++;
  activeTransaction = { id: transactionId, lockedPanelIds: [...livePanelIds] };

  try {
    setDecisionInputLock(livePanelIds, true);
    // Before the move, so a crash between here and the answer leaves the panel
    // marked rather than silently diverged.
    recordProvisionalConsent(livePanelIds, targetWorktreeId);
    applyMove();
    followDestination(targetWorktreeId);
  } catch (error) {
    // A throw anywhere in the synchronous phase would otherwise leave every
    // lock held with no continuation scheduled to release them.
    logWarn("[WorktreeMove] move gesture failed; releasing input lock", { error });
    activeTransaction = null;
    setDecisionInputLock(livePanelIds, false);
    throw error;
  }

  void resolveDecisionOrRelease(
    transactionId,
    livePanelIds,
    alignOnlyPanelIds,
    targetWorktreeId,
    sourceWorktreeId,
    groupId
  );
  return true;
}

/**
 * Undo a move the user declined.
 *
 * Layout undo is the right first move — it restores geometry, tab-group
 * placement and `worktreeId` together — but its stack is global and can be
 * cleared or claimed by another layout change while the dialog is open. So the
 * worktree is then verified and, if undo didn't take, put back explicitly:
 * getting the panel back to where the user left it matters more than restoring
 * its exact geometry.
 */
function rollbackMove(request: WorktreeMoveDecisionRequest): void {
  useLayoutUndoStore.getState().undo();

  const { sourceWorktreeId } = request;
  if (sourceWorktreeId) {
    for (const panelId of request.lockedPanelIds) {
      const panel = usePanelStore.getState().panelsById[panelId];
      if (!panel || panel.worktreeId === sourceWorktreeId) continue;
      usePanelStore.getState().moveTerminalToWorktree(panelId, sourceWorktreeId);
    }
  }

  // Restore whatever consent each panel carried before this gesture — never a
  // blanket clear, which would erase the marker an earlier, already-answered
  // move had legitimately left behind.
  for (const panelId of request.lockedPanelIds) clearProvisionalConsent(panelId);

  // The move was durable the moment it landed; layout undo is a pure in-memory
  // rebuild. Without an explicit save the panel comes back after a restart still
  // filed where the user just declined to put it. Tab groups too — a grouped
  // move rewrites their worktree as well.
  persistPanels();

  if (sourceWorktreeId) followDestination(sourceWorktreeId);
}

/**
 * Apply the user's answer. Always releases the input lock and clears the
 * pending decision, whatever the outcome or however it fails.
 */
export async function resolveWorktreeMoveDecision(
  request: WorktreeMoveDecisionRequest,
  outcome: WorktreeMoveOutcome
): Promise<void> {
  try {
    // Clearing first makes the decision single-shot: the dialog unmounts on the
    // same tick, so a second click on a slow transfer can't re-enter with a
    // request whose panels are already being restarted.
    useWorktreeMoveDecisionStore.getState().clear();
    if (activeTransaction?.id === request.transactionId) activeTransaction = null;

    if (outcome === "cancel") {
      rollbackMove(request);
      return;
    }

    const now = Date.now();

    if (outcome === "transfer") {
      // Per member, against that member's own launch root: sharing a tab group
      // does not mean sharing a launch directory. Isolated per member so one
      // failure doesn't abandon the rest mid-group.
      const failed: WorktreeMoveDecisionMember[] = [];
      for (const member of request.members) {
        let ok = false;
        try {
          ok = await usePanelStore
            .getState()
            .transferPanelToWorktree(member.panelId, request.destinationWorktreeId);
        } catch (error) {
          logWarn("[WorktreeMove] transfer failed", { panelId: member.panelId, error });
        }
        if (ok) priorConsent.delete(member.panelId);
        else failed.push(member);
      }
      // A failed transfer leaves the panel relabelled with its process still in
      // the source directory — the original bug. `transferPanelToWorktree` has
      // already surfaced the error on the panel; keep the divergence marked too,
      // so it carries the indicator and the drift backstop rather than going
      // quiet on a failure the user did not choose.
      if (failed.length > 0) {
        recordMoveOnlyConsent({ ...request, members: failed }, now);
      }
      alignDeadMembers(request);
      return;
    }

    recordMoveOnlyConsent(request, now);
    alignDeadMembers(request);
    for (const panelId of request.lockedPanelIds) priorConsent.delete(panelId);
  } finally {
    // Over `lockedPanelIds`, not `members`: aligned members and any panel that
    // vanished mid-classification were locked too, and leaving one locked makes
    // the pane permanently unusable.
    setDecisionInputLock(request.lockedPanelIds, false);
  }
}
