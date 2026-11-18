import type { WorktreeSetupState, WorktreeState } from "@shared/types";
import { worktreeClient } from "@/clients";
import { currentHostSwitchRequest } from "@/components/HostSwitch/hostSwitchRequests";
import {
  openResourceBoxOnHost,
  type ResourceHandoffOutcome,
} from "@/components/Hosts/resourceHostHandoff";
import { notify } from "@/lib/notify";
import {
  isProjectViewCached,
  isProjectViewObservable,
  subscribeProjectViewLifecycle,
} from "@/lib/viewCacheState";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { isClientBrokerError } from "@/utils/clientBrokerError";

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
/**
 * Main hands concurrent list reads the same answer for a moment after it
 * resolves, so the status run's own answer can take a read or two to show.
 */
const FRESH_READ_ATTEMPTS = 10;
const FRESH_READ_INTERVAL_MS = 200;
/**
 * A status run cut off by this view's port going away is asked again, this
 * many times, a second apart: a view shown again gets its port back a moment
 * after it's shown.
 */
const PORT_RETRIES = 5;
const PORT_RETRY_MS = 1_000;
/**
 * How long a shown view waits for its port before asking anyway: a host that
 * gave up restarting never attaches one, and the run then ends in an error
 * with Try again rather than waiting for good.
 */
const PORT_WAIT_MS = 30_000;

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
  | { status: "still-running"; awaitingApproval: boolean }
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

/** The worktree went away, or out of its environment: nothing is left to hand off. */
class Gone extends Error {}

interface Tracker {
  /** The view's row still stands for this worktree, in this environment. */
  isCurrent: () => boolean;
  /** A row read from the host is this worktree, in this environment. */
  matches: (row: WorktreeState) => boolean;
}

/**
 * Pinned to the worktree as it was created. A row that hasn't reached the
 * store yet counts: its snapshot can trail the create's reply. Once seen,
 * its removal, a new monitor at the same path, or a switch to another
 * environment ends it.
 */
function trackWorktree(worktreeId: string, environment: string): Tracker {
  let seen = false;
  let hadEnvironment = false;
  let generation: number | undefined;
  const inEnvironment = (mode: string | undefined): boolean => {
    if (mode === environment) {
      hadEnvironment = true;
      return true;
    }
    // A first snapshot can come before the create gives the worktree its
    // mode; after it has had it, none is Local.
    return mode === undefined && !hadEnvironment;
  };
  // The host stamps each monitor it builds for a path; a new one is a new worktree there.
  const sameMonitor = (row: object): boolean => {
    const stamp =
      "generation" in row && typeof row.generation === "number" ? row.generation : undefined;
    if (stamp === undefined) return true;
    generation ??= stamp;
    return stamp === generation;
  };
  return {
    isCurrent: () => {
      const row = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId);
      if (!row) return !seen;
      seen = true;
      return sameMonitor(row) && inEnvironment(row.worktreeMode);
    },
    matches: (row) =>
      sameMonitor(row) && row.worktreeMode === environment && inEnvironment(row.worktreeMode),
  };
}

/**
 * The host's own row. Absent from a list the host answered is gone; absent
 * from one it couldn't answer (`gitBacked: null`, its process restarting)
 * is unknown, and said as a failure rather than taken for a deletion.
 */
async function readHostRow(worktreeId: string): Promise<WorktreeState | null> {
  const { worktrees, gitBacked } = await worktreeClient.getAllWithStatus();
  const row = worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
  if (row === null && gitBacked === null) {
    throw new Error("Couldn't read the worktree from the workspace host.");
  }
  return row;
}

/** Resolves once main has this view showing again; at once when it is. */
function whenViewActive(): Promise<void> {
  if (!isProjectViewCached()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeProjectViewLifecycle(() => {
      if (isProjectViewCached()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Resolves once this view's worktree port is attached, or `waitMs` has passed. */
function whenPortReady(waitMs: number): Promise<void> {
  if (worktreeClient.isPortReady() || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Deferred: the port calls back at once from inside its own subscribe.
      queueMicrotask(() => unsubscribe());
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    const unsubscribe = worktreeClient.onPortReady(finish);
  });
}

/**
 * A resource action goes over this view's worktree port, which main retires
 * while the view is cached (another project in front) and attaches again a
 * moment after it's shown: the run waits for both rather than failing, and
 * one the port's going cut off is asked again. Resolves with when the run
 * that answered started, which its answer is stamped after.
 */
async function runStatus(worktreeId: string, tracker: Tracker, clock: Clock): Promise<number> {
  let portDeadline: number | null = null;
  for (let attempt = 0; ; attempt++) {
    await whenViewActive();
    // One wait per run once the view is shown, not one per retry.
    portDeadline ??= Date.now() + PORT_WAIT_MS;
    await whenPortReady(portDeadline - Date.now());
    if (!tracker.isCurrent()) throw new Gone();
    const startedAt = Date.now();
    try {
      await worktreeClient.resourceAction(worktreeId, "status");
      return startedAt;
    } catch (err) {
      if (attempt >= PORT_RETRIES || !isClientBrokerError(err) || err.code !== "HOST_EXITED") {
        throw err;
      }
      await clock.sleep(PORT_RETRY_MS);
    }
  }
}

type SetupWait =
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "still-running"; awaitingApproval: boolean }
  | { kind: "error"; message: string };

async function waitForSetup(
  worktreeId: string,
  deadline: number,
  tracker: Tracker,
  onNeedsApproval: () => void,
  clock: Clock
): Promise<SetupWait> {
  for (;;) {
    if (!tracker.isCurrent()) throw new Gone();
    const timeoutMs = Math.max(0, Math.min(WAIT_SLICE_MS, deadline - clock.now()));
    const result = await actionService.dispatch<{
      setupState: WorktreeSetupState | "unknown";
      timedOut: boolean;
    }>("worktree.waitUntilReady", { worktreeId, timeoutMs }, { source: "user" });
    if (!tracker.isCurrent()) throw new Gone();
    if (!result.ok) return { kind: "error", message: result.error.message };
    const { setupState, timedOut } = result.result;
    if (setupState === "ready") return { kind: "ready" };
    // The provision's own failure is on the worktree's card, as for any create.
    if (setupState === "failed" || setupState === "timed-out") return { kind: "failed" };
    if (setupState === "needs-approval") {
      onNeedsApproval();
      const remaining = deadline - clock.now();
      if (remaining <= 0) return { kind: "still-running", awaitingApproval: true };
      await clock.sleep(Math.min(APPROVAL_RECHECK_MS, remaining));
      continue;
    }
    if (!timedOut) {
      return { kind: "error", message: "Couldn't confirm the worktree's setup finished." };
    }
    if (clock.now() >= deadline) return { kind: "still-running", awaitingApproval: false };
  }
}

/** The host's row once it carries a status answer from `since` on. */
async function readStatusAnswer(
  worktreeId: string,
  since: number,
  tracker: Tracker,
  clock: Clock
): Promise<WorktreeState> {
  for (let attempt = 1; ; attempt++) {
    const row = await readHostRow(worktreeId);
    if (!row || !tracker.matches(row)) throw new Gone();
    if ((row.resourceStatus?.lastCheckedAt ?? 0) >= since) return row;
    if (attempt >= FRESH_READ_ATTEMPTS) {
      throw new Error("The status command finished, but its answer didn't reach Daintree.");
    }
    await clock.sleep(FRESH_READ_INTERVAL_MS);
  }
}

type Machine = { sshTarget: string; worktreePath: string; checkedAt: number };

async function findMachine(
  worktreeId: string,
  tracker: Tracker,
  clock: Clock
): Promise<
  Machine | Extract<MachineHandoffOutcome, { status: "no-status-command" | "no-machine" }>
> {
  const settleBy = clock.now() + MACHINE_HANDOFF_STATUS_SETTLE_MS;
  for (;;) {
    const before = await readHostRow(worktreeId);
    if (!before || !tracker.matches(before)) throw new Gone();
    if (!before.hasStatusCommand) return { status: "no-status-command" };
    // Asked now even when a poll has answered: only a status run after
    // provisioning says what this box is.
    const since = await runStatus(worktreeId, tracker, clock);
    const after = await readStatusAnswer(worktreeId, since, tracker, clock);
    const status = after.resourceStatus;
    if (status?.ssh) {
      return {
        sshTarget: status.ssh,
        worktreePath: after.path,
        checkedAt: status.lastCheckedAt ?? since,
      };
    }
    const lastStatus = status?.lastStatus ?? null;
    // An ssh target is only believed of a ready box, so a ready one without
    // it won't name one by being asked again, and an ask that couldn't
    // finish inside the window isn't started.
    if (
      lastStatus?.trim().toLowerCase() === "ready" ||
      settleBy - clock.now() <= STATUS_RECHECK_MS
    ) {
      return { status: "no-machine", lastStatus };
    }
    await clock.sleep(STATUS_RECHECK_MS);
    if (!tracker.isCurrent()) throw new Gone();
  }
}

/**
 * Still the same machine, as the view's store sees it. A store that hasn't
 * caught up with the status run yet has no target to go by; one that has,
 * and holds none or another, saw it withdrawn (a pause, a teardown).
 */
function stillReports(worktreeId: string, machine: Machine): boolean {
  const status = getCurrentViewStoreOrNull()?.getState().worktrees.get(worktreeId)?.resourceStatus;
  if (status?.ssh !== undefined) return status.ssh === machine.sshTarget;
  return (status?.lastCheckedAt ?? 0) < machine.checkedAt;
}

async function runHandoff(
  request: CreatedWorktreeOnMachine,
  options: Options
): Promise<MachineHandoffOutcome> {
  const clock = options.clock ?? realClock;
  const deadline = clock.now() + (options.budgetMs ?? MACHINE_HANDOFF_SETUP_BUDGET_MS);
  const tracker = trackWorktree(request.worktreeId, request.environment);
  let toldApproval = false;
  const setup = await waitForSetup(
    request.worktreeId,
    deadline,
    tracker,
    () => {
      if (toldApproval) return;
      toldApproval = true;
      notify({
        type: "info",
        title: "Waiting to open on its machine",
        message: `Setup is waiting for you to approve its commands. ${request.label} opens on its machine once setup finishes.`,
        correlationId: request.worktreeId,
        context: { worktreeId: request.worktreeId, eventKind: "connectivity" },
      });
    },
    clock
  );
  if (setup.kind === "failed") return { status: "setup-failed" };
  if (setup.kind === "error") return { status: "error", message: setup.message };
  if (setup.kind === "still-running") {
    return { status: "still-running", awaitingApproval: setup.awaitingApproval };
  }

  const machine = await findMachine(request.worktreeId, tracker, clock);
  if ("status" in machine) return machine;

  const stillCurrent = () => tracker.isCurrent() && stillReports(request.worktreeId, machine);
  if (!stillCurrent()) throw new Gone();
  return openResourceBoxOnHost({
    worktreeId: request.worktreeId,
    worktreePath: machine.worktreePath,
    projectId: request.projectId,
    sshTarget: machine.sshTarget,
    label: request.label,
    askFirst: false,
    isCurrent: stillCurrent,
    // Nobody watching, or another switch under way: the worktree waits on
    // the host, and the switch dialog asks before it moves the window.
    placeNow: () => isProjectViewObservable() && currentHostSwitchRequest() === null,
  });
}

/** Run once from a notice's action, so a double click can't start two handoffs. */
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
  // As the other notices about getting a project onto a host are.
  const base = {
    correlationId: worktreeId,
    context: { worktreeId, eventKind: "connectivity" },
  } as const;
  // On the grid bar, like an agent handed back after setup: the dialog that
  // asked is long closed, and an inbox row can't carry the action.
  const handBack = { placement: "grid-bar", urgent: true, duration: 0 } as const;
  const again = once(() => void openCreatedWorktreeOnMachine(request));
  switch (outcome.status) {
    case "placing":
    case "setup":
    case "waiting":
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
        ...handBack,
        type: "warning",
        title: "Not opened on its machine yet",
        message: outcome.awaitingApproval
          ? `Setup is still waiting for you to approve its commands, so ${label} stays on this machine for now.`
          : `Setup is still running, so ${label} stays on this machine for now.`,
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
        ...handBack,
        type: "warning",
        title: "Not opened on its machine",
        message:
          outcome.lastStatus === null
            ? `${environment}'s status didn't name an ssh machine, so ${label} stays on this machine.`
            : `${environment}'s status said "${outcome.lastStatus}" without an ssh machine, so ${label} stays on this machine.`,
        action: { label: "Check again", onClick: again },
      });
      return;
    case "error":
      notify({
        ...base,
        ...handBack,
        type: "error",
        priority: "high",
        title: "Couldn't open on its machine",
        message: `${outcome.message} ${label} stays on this machine.`,
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
 * machine, Host setup included. Anything else short of that leaves the
 * worktree on this machine and says why; a worktree deleted or moved to
 * another environment meanwhile ends it quietly. Never rejects.
 */
export async function openCreatedWorktreeOnMachine(
  request: CreatedWorktreeOnMachine,
  options: Options = {}
): Promise<MachineHandoffOutcome> {
  let outcome: MachineHandoffOutcome;
  try {
    outcome = await runHandoff(request, options);
  } catch (err) {
    // The handoff's own stop for a worktree that went while it worked.
    outcome =
      err instanceof Gone || clientErrorCode(err) === "CANCELLED"
        ? { status: "gone" }
        : {
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
