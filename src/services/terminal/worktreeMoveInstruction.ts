import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { logWarn } from "@/utils/logger";
import type { AgentState } from "@/types";

/**
 * The one sentence a cross-worktree move is allowed to put into a live agent
 * session (#11853), and only when the user asks for it.
 */
export function buildWorktreeMoveInstruction(worktreePath: string): string {
  return `Please continue in the directory ${worktreePath}`;
}

interface PendingInstruction {
  /**
   * Identity for this job. Cleanup is token-checked so a callback from a job
   * that has already been replaced cannot delete its replacement.
   */
  token: number;
  destinationWorktreeId: string;
  dispose: () => void;
}

/**
 * Instructions waiting for their agent to finish what it is doing.
 *
 * Module-owned rather than component state, for the same reason the notice
 * itself lives in the panel store: switching worktrees unmounts the pane, and a
 * job parked in a component would be torn down by a gesture that has nothing to
 * do with the agent's turn.
 */
const pending = new Map<string, PendingInstruction>();
let nextToken = 1;
let teardownWatch: (() => void) | null = null;

/**
 * Drop a panel's job when its renderer instance is torn down.
 *
 * `destroy()` clears the exit subscribers instead of firing them, so a restart,
 * a close, or a store reset would otherwise leave the entry in `pending`
 * forever — holding disposer closures over the dead instance. Subscribed lazily
 * so importing this module costs nothing until something is actually queued.
 */
function ensureTeardownWatch(): void {
  teardownWatch ??= terminalInstanceService.addInstanceDestroyedListener((id) => {
    cancelWorktreeMoveInstruction(id);
  });
}

/** The destination's path as it is *now* — never as it was when clicked. */
function readWorktreePath(worktreeId: string): string | undefined {
  const path = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId)?.path;
  return path?.trim() ? path : undefined;
}

/**
 * Drop a panel's pending instruction.
 *
 * `token` scopes the cancellation to one job: an exit or state callback that
 * fires late must not remove the instruction a newer gesture has since queued.
 * Passing no token cancels whatever is currently pending, which is what the
 * external lifecycle hooks (move, restart, close) want.
 */
export function cancelWorktreeMoveInstruction(panelId: string, token?: number): void {
  const job = pending.get(panelId);
  if (!job) return;
  if (token !== undefined && job.token !== token) return;
  pending.delete(panelId);
  job.dispose();
}

/** Test seam — module state outlives any single component by design. */
export function __resetWorktreeMoveInstructions(): void {
  for (const job of pending.values()) job.dispose();
  pending.clear();
  teardownWatch?.();
  teardownWatch = null;
}

function submit(panelId: string, destinationWorktreeId: string): void {
  // Resolved at delivery, not at click time: a worktree can be physically moved
  // while the agent finishes its turn, and sending a path that no longer exists
  // is worse than sending nothing.
  const path = readWorktreePath(destinationWorktreeId);
  if (!path) {
    logWarn("[WorktreeMove] destination vanished before the instruction could be sent", {
      panelId,
      destinationWorktreeId,
    });
    return;
  }
  terminalClient.submit(panelId, buildWorktreeMoveInstruction(path)).catch((error: unknown) => {
    // Logged, not surfaced: the banner is already gone, and re-raising it would
    // be the persistent marker #11853 exists to remove. The transcript is where
    // the user sees whether the agent got the message.
    logWarn("[WorktreeMove] failed to send the continue-in-directory instruction", {
      panelId,
      error,
    });
  });
}

/**
 * Send "continue in {path}" now, or the moment the agent is next free.
 *
 * There is no timeout. #11840's injection helper had a 30s blind fallback that
 * fired mid-turn if the agent never reported idle, which is exactly the
 * annoyance this feature is not allowed to have: an agent that never goes idle
 * simply never gets told. A job that waits out a long turn is pending work, not
 * a leak — it is disposed on exit, on close, on restart, and on any later move
 * (see `cancelWorktreeMoveInstruction`).
 *
 * Returns `false` when there is nothing to queue against — an unresolvable
 * destination or a panel with no live instance — so the caller can leave the
 * banner up instead of pretending the message is on its way.
 */
export function queueWorktreeMoveInstruction(
  panelId: string,
  destinationWorktreeId: string
): boolean {
  if (!readWorktreePath(destinationWorktreeId)) return false;
  // Without an instance there is nothing to listen to: `addAgentStateListener`
  // hands back a no-op disposer for an unknown id, so the job would sit in
  // `pending` forever while the banner disappeared — swallowing the user's one
  // click. Say so instead, and let the bar stay up.
  if (!terminalInstanceService.get(panelId)) return false;

  ensureTeardownWatch();

  // Before anything new registers. Overwriting the map entry alone would orphan
  // the previous job with its listeners still live on the service, and both
  // would fire on the next idle — delivering a second sentence naming the
  // destination the user has already moved on from.
  cancelWorktreeMoveInstruction(panelId);

  const state = terminalInstanceService.getAgentState(panelId);
  if (state === "idle" || state === "waiting") {
    submit(panelId, destinationWorktreeId);
    return true;
  }

  const token = nextToken++;
  // `addAgentStateListener` invokes its callback synchronously when the state is
  // already known, i.e. before it has returned the disposer this closure wants
  // to call. `settled` is what keeps that path from leaking the listener: the
  // callback records that it fired, and the registration below disposes
  // immediately rather than storing a job that has already delivered.
  let settled = false;
  let unsubState: () => void = () => {};
  let unsubExit: () => void = () => {};
  const dispose = () => {
    unsubState();
    unsubExit();
  };

  const deliver = () => {
    if (settled) return;
    settled = true;
    cancelWorktreeMoveInstruction(panelId, token);
    dispose();
    submit(panelId, destinationWorktreeId);
  };

  unsubState = terminalInstanceService.addAgentStateListener(panelId, (next: AgentState) => {
    if (next === "idle" || next === "waiting") deliver();
  });

  // Delivered synchronously, before `unsubState` held anything but the no-op
  // placeholder — so `deliver`'s own `dispose()` could not have unsubscribed.
  // Undo the registration here, where the real disposer finally exists.
  if (settled) {
    unsubState();
    return true;
  }

  // A process that dies mid-turn can never be told anything. Dropping the job
  // here also stops it outliving a restart, whose fresh session was never the
  // one the user was looking at when they clicked.
  unsubExit = terminalInstanceService.addExitListener(panelId, () => {
    if (settled) return;
    settled = true;
    cancelWorktreeMoveInstruction(panelId, token);
    dispose();
  });

  pending.set(panelId, { token, destinationWorktreeId, dispose });
  return true;
}

/** Whether this panel has an instruction waiting on its agent. Test/diagnostic. */
export function hasPendingWorktreeMoveInstruction(panelId: string): boolean {
  return pending.has(panelId);
}
