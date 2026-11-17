import type { WorktreeSetupState, WorktreeState } from "@shared/types";
import { worktreeClient } from "@/clients";
import {
  currentHostSwitchRequest,
  subscribeHostSwitchRequests,
} from "@/components/HostSwitch/hostSwitchRequests";
import {
  openResourceBoxOnHost,
  type ResourceHandoffOutcome,
} from "@/components/Hosts/resourceHostHandoff";
import { notify } from "@/lib/notify";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { clientErrorText } from "@/utils/clientAppError";

/**
 * How long a new worktree waits on its setup (provisioning included) before
 * the handoff is given back. Longer than an agent's wait: a cloud box can
 * take minutes, and a provision's own timeout alone is five.
 */
export const MACHINE_HANDOFF_SETUP_BUDGET_MS = 15 * 60_000;
/**
 * How long a status that hasn't said "ready" yet is asked again after setup:
 * a provision can return while its box is still booting.
 */
export const MACHINE_HANDOFF_STATUS_SETTLE_MS = 2 * 60_000;
/** `worktree.waitUntilReady` refuses longer waits, so the budget is spent in slices. */
const WAIT_SLICE_MS = 25_000;
/** A setup waiting for approval reads as settled, so it is asked about again on a timer. */
const APPROVAL_RECHECK_MS = 3_000;
const STATUS_RECHECK_MS = 10_000;

export interface CreatedWorktreeOnMachine {
  worktreeId: string;
  projectId: string;
  /** The environment the worktree was created in; a switch away ends the handoff. */
  environment: string;
  /** What the worktree is called in what's said about it: its branch. */
  label: string;
}

export type MachineHandoffOutcome =
  | ResourceHandoffOutcome
  | { status: "setup-failed" }
  | { status: "still-running" }
  | { status: "no-status-command" }
  | { status: "no-machine"; lastStatus: string | null }
  | { status: "gone" }
  | { status: "error"; message: string };

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Options {
  budgetMs?: number;
  clock?: Clock;
}

/**
 * Whether the worktree is still the one this handoff is for. A row that
 * hasn't reached the store yet counts: its snapshot can trail the create's
 * reply. Once seen, its removal or a switch to another environment ends it.
 */
function trackWorktree(worktreeId: string, environment: string): () => boolean {
  let seen = false;
  return () => {
    const row = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId);
    if (!row) return !seen;
    seen = true;
    return row.worktreeMode === undefined || row.worktreeMode === environment;
  };
}

/** The host's own row, read after a step rather than the store's, which can trail it. */
async function readHostRow(worktreeId: string): Promise<WorktreeState | null> {
  const { worktrees } = await worktreeClient.getAllWithStatus();
  return worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
}

type SetupWait =
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "still-running" }
  | { kind: "gone" }
  | { kind: "error"; message: string };

async function waitForSetup(
  worktreeId: string,
  deadline: number,
  isCurrent: () => boolean,
  onNeedsApproval: () => void,
  clock: Clock
): Promise<SetupWait> {
  for (;;) {
    if (!isCurrent()) return { kind: "gone" };
    const timeoutMs = Math.max(0, Math.min(WAIT_SLICE_MS, deadline - clock.now()));
    const result = await actionService.dispatch<{
      setupState: WorktreeSetupState | "unknown";
      timedOut: boolean;
    }>("worktree.waitUntilReady", { worktreeId, timeoutMs }, { source: "user" });
    if (!isCurrent()) return { kind: "gone" };
    if (!result.ok) return { kind: "error", message: result.error.message };
    const { setupState, timedOut } = result.result;
    if (setupState === "ready") return { kind: "ready" };
    // The provision's own failure is on the worktree's card, as for any create.
    if (setupState === "failed" || setupState === "timed-out") return { kind: "failed" };
    if (setupState === "needs-approval") {
      onNeedsApproval();
      const remaining = deadline - clock.now();
      if (remaining <= 0) return { kind: "still-running" };
      await clock.sleep(Math.min(APPROVAL_RECHECK_MS, remaining));
      continue;
    }
    if (!timedOut) {
      return { kind: "error", message: "Couldn't confirm the worktree's setup finished." };
    }
    if (clock.now() >= deadline) return { kind: "still-running" };
  }
}

function handoffCanShow(): boolean {
  return isProjectViewObservable() && currentHostSwitchRequest() === null;
}

/**
 * Resolves once this view can be seen with no other switch under way; true
 * when that meant waiting. Nobody watching means nobody to move: the switch
 * then asks before it moves the window.
 */
function whenHandoffCanShow(): Promise<boolean> {
  if (handoffCanShow()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const subscriptions: Array<() => void> = [];
    const check = () => {
      if (!handoffCanShow()) return;
      for (const unsubscribe of subscriptions) unsubscribe();
      resolve(true);
    };
    subscriptions.push(subscribeProjectViewObservability(check));
    subscriptions.push(subscribeHostSwitchRequests(check));
  });
}

async function findMachine(
  request: CreatedWorktreeOnMachine,
  isCurrent: () => boolean,
  clock: Clock
): Promise<
  | { kind: "found"; sshTarget: string; worktreePath: string }
  | Extract<MachineHandoffOutcome, { status: "no-status-command" | "no-machine" | "gone" }>
> {
  const settleBy = clock.now() + MACHINE_HANDOFF_STATUS_SETTLE_MS;
  for (;;) {
    const before = await readHostRow(request.worktreeId);
    if (!before || !isCurrent()) return { status: "gone" };
    if (!before.hasStatusCommand) return { status: "no-status-command" };
    // Asked now even when a poll has answered: only a status run after
    // provisioning says what this box is.
    await worktreeClient.resourceAction(request.worktreeId, "status");
    const after = await readHostRow(request.worktreeId);
    if (!after || !isCurrent()) return { status: "gone" };
    const sshTarget = after.resourceStatus?.ssh;
    if (sshTarget) return { kind: "found", sshTarget, worktreePath: after.path };
    const lastStatus = after.resourceStatus?.lastStatus ?? null;
    const remaining = settleBy - clock.now();
    // An ssh target is only believed of a ready box, so a ready one without
    // it won't name one by being asked again.
    if (lastStatus?.trim().toLowerCase() === "ready" || remaining <= 0) {
      return { status: "no-machine", lastStatus };
    }
    await clock.sleep(Math.min(STATUS_RECHECK_MS, remaining));
    if (!isCurrent()) return { status: "gone" };
  }
}

async function runHandoff(
  request: CreatedWorktreeOnMachine,
  options: Options
): Promise<MachineHandoffOutcome> {
  const clock = options.clock ?? realClock;
  const deadline = clock.now() + (options.budgetMs ?? MACHINE_HANDOFF_SETUP_BUDGET_MS);
  const isCurrent = trackWorktree(request.worktreeId, request.environment);
  let toldApproval = false;
  const setup = await waitForSetup(
    request.worktreeId,
    deadline,
    isCurrent,
    () => {
      if (toldApproval) return;
      toldApproval = true;
      notify({
        type: "info",
        title: "Waiting to open on its machine",
        message: `Setup is waiting for you to approve its commands. ${request.label} opens on its machine once setup finishes.`,
        correlationId: request.worktreeId,
        context: { worktreeId: request.worktreeId },
      });
    },
    clock
  );
  if (setup.kind === "ready") {
    // Falls through to finding the machine.
  } else if (setup.kind === "failed") {
    return { status: "setup-failed" };
  } else if (setup.kind === "error") {
    return { status: "error", message: setup.message };
  } else {
    return { status: setup.kind };
  }

  const machine = await findMachine(request, isCurrent, clock);
  if (!("kind" in machine)) return machine;

  const waited = await whenHandoffCanShow();
  if (!isCurrent()) return { status: "gone" };
  return openResourceBoxOnHost({
    worktreeId: request.worktreeId,
    worktreePath: machine.worktreePath,
    projectId: request.projectId,
    sshTarget: machine.sshTarget,
    label: request.label,
    askFirst: waited,
    isCurrent: () => {
      if (!isCurrent()) return false;
      const row = getCurrentViewStoreOrNull()?.getState().worktrees.get(request.worktreeId);
      // A store that hasn't caught up yet has no ssh; another target, or none
      // after a pause it has seen, is a different machine.
      const reported = row?.resourceStatus?.ssh;
      return reported === undefined || reported === machine.sshTarget;
    },
  });
}

/** Run once from a toast's action, so a double click can't start two handoffs. */
function once(run: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    run();
  };
}

function report(request: CreatedWorktreeOnMachine, outcome: MachineHandoffOutcome): void {
  const { worktreeId, label, environment } = request;
  const base = { correlationId: worktreeId, context: { worktreeId } } as const;
  // On the grid bar, like an agent handed back after setup: the dialog that
  // asked is long closed, and quiet hours would leave an inbox row that can't
  // carry the action.
  const handBack = { placement: "grid-bar", urgent: true, duration: 0 } as const;
  const again = once(() => void openCreatedWorktreeOnMachine(request));
  switch (outcome.status) {
    case "placing":
    case "setup":
    case "gone":
      return;
    case "setup-failed":
      notify({
        ...base,
        type: "warning",
        title: "Not opened on its machine",
        message: `Setup didn't finish, so ${label} stays on this machine. Its card shows what failed.`,
      });
      return;
    case "still-running":
      notify({
        ...base,
        type: "warning",
        title: "Not opened on its machine yet",
        message: `Setup is still running, so ${label} stays on this machine for now.`,
        ...handBack,
        action: { label: "Keep waiting", onClick: again },
      });
      return;
    case "no-status-command":
      notify({
        ...base,
        type: "warning",
        title: "Not opened on its machine",
        message: `${environment} has no status command to name its machine, so ${label} stays on this machine.`,
      });
      return;
    case "no-machine":
      notify({
        ...base,
        type: "warning",
        title: "Not opened on its machine",
        message:
          outcome.lastStatus === null
            ? `${environment}'s status didn't name an ssh machine, so ${label} stays on this machine.`
            : `${environment}'s status said "${outcome.lastStatus}" without an ssh machine, so ${label} stays on this machine.`,
        ...handBack,
        action: { label: "Check again", onClick: again },
      });
      return;
    case "error":
      notify({
        ...base,
        type: "error",
        priority: "high",
        title: "Couldn't open on its machine",
        message: `${outcome.message} ${label} stays on this machine.`,
        duration: 0,
        action: { label: "Try again", onClick: again },
      });
      return;
  }
}

/**
 * Carry a worktree created in a resource environment onto the machine that
 * environment provisions, as a Remote Host: once setup (and so the provision)
 * has finished, its status is asked for the box's ssh target and the box is
 * opened through the same handoff as the environment popover's Open on its
 * machine, Host setup included. Anything short of that leaves the worktree
 * on this machine and says why. Never rejects.
 */
export async function openCreatedWorktreeOnMachine(
  request: CreatedWorktreeOnMachine,
  options: Options = {}
): Promise<MachineHandoffOutcome> {
  let outcome: MachineHandoffOutcome;
  try {
    outcome = await runHandoff(request, options);
  } catch (err) {
    outcome = {
      status: "error",
      message: clientErrorText(err, "Opening the worktree on its machine failed."),
    };
  }
  try {
    report(request, outcome);
  } catch {
    // The worktree is created either way; a broken notification layer has nothing to tell.
  }
  return outcome;
}
