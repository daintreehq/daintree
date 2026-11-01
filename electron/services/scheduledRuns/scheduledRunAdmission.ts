import type { ScheduledRunResume } from "../../../shared/types/scheduledRuns.js";
import type { ScheduledRunRef } from "../../../shared/types/scheduledRunRef.js";

/**
 * A scheduled run's launch is registered in its history at the spawn itself
 * (#15978), whichever launcher builds it: a view's `agent.launch` or main's
 * `runAgentLaunch`. Both send the terminal spawn handler the values the run's
 * resume snapshot holds (cwd, worktree, flags, model, preset, the session id
 * Claude is assigned), so the record is made from what actually spawns, and
 * made before it does.
 *
 * The launcher reserves the run's ids here before it asks for the launch. The
 * first spawn naming a reserved run takes the reservation and registers the
 * run; a later spawn naming it (a restart, held-pane recovery, a crash replay)
 * finds none and spawns as any pane does. Leaf module: the spawn handler and
 * the project store import it, so it carries no services of its own.
 */

/** What the spawn handler is about to start, in the terms a reservation checks. */
export interface ScheduledSpawn {
  readonly terminalId: string;
  readonly projectId: string | undefined;
  readonly scheduledRun: ScheduledRunRef | undefined;
  readonly launchAgentId: string | undefined;
  /** The directory the launcher asked for, before the spawn handler's fallback. */
  readonly requestedCwd: string | undefined;
  /** The directory it will start in. */
  readonly cwd: string;
  readonly worktreeId: string | undefined;
  readonly agentLaunchFlags: readonly string[] | undefined;
  readonly agentModelId: string | undefined;
  readonly agentPresetId: string | undefined;
  readonly agentSessionId: string | undefined;
  /** The handback code minted for its launch prompt, which the run reports back with (#15982). */
  readonly handbackCode: string | undefined;
}

export interface ScheduledLaunchReservation {
  readonly runId: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly agentId: string;
  /**
   * Registers the run from the spawn's resume snapshot, and the handback code
   * its launch prompt carries (null when it carries none), synchronously: the
   * spawn follows with no await between. Throwing refuses the spawn, and the
   * launcher hears it as the admission's rejection.
   */
  readonly admit: (resume: ScheduledRunResume, handbackCode: string | null) => void;
}

/** Where a reservation stands. */
export type ScheduledAdmissionState =
  | { readonly kind: "pending" }
  | { readonly kind: "registered" }
  /** A spawn took it and was refused, or the launcher gave it up. */
  | { readonly kind: "refused"; readonly message: string }
  /** Its schedule or project was removed before it spawned; there's no history to write. */
  | { readonly kind: "cancelled" };

interface Pending {
  readonly reservation: ScheduledLaunchReservation;
  readonly settle: (state: Exclude<ScheduledAdmissionState, { kind: "pending" }>) => void;
}

const pending = new Map<string, Pending>();

/**
 * Every launch from its reservation until its launcher has finished writing
 * its outcome, with whether its schedule or project was removed meanwhile. A
 * launch refused at the spawn is no longer pending but still about to record
 * its refusal, which a removal must stop as surely as a registration.
 */
const removedWhileLaunching = new Map<
  string,
  { reservation: ScheduledLaunchReservation; removed: boolean }
>();

/**
 * Runs given up on after their launch was asked for, before their terminal
 * spawned. Their first late spawn is refused: the history already says the
 * run failed (or has no run at all), and an agent running unattended behind
 * that is the one thing it can't be allowed to do. Only the first, so a pane
 * the user restarts by hand still restarts.
 *
 * Kept until that spawn comes, for the life of the process: a view frozen
 * mid-launch can spawn days later, and forgetting one would fail open. Only a
 * launch that went unanswered, never spawned or was cancelled lands here, each
 * after a minute's wait or a removal, so it stays small.
 */
const givenUp = new Set<string>();

function tombstone(runId: string): void {
  givenUp.add(runId);
}

export interface ReservedLaunch {
  /** Settles when the reservation does: resolved once registered, rejected otherwise. */
  readonly admitted: Promise<void>;
  readonly state: () => ScheduledAdmissionState;
  /**
   * Withdraws a reservation no launch was asked for yet. True when it was
   * still pending; false when it was already cancelled.
   */
  readonly withdraw: () => boolean;
  /**
   * Gives up on a launch that was asked for and hasn't spawned, as the
   * launcher does when no answer or no spawn came in time. True when it was
   * still pending, so nothing registered the run and its first late spawn
   * will be refused; false when a spawn already took it or it was cancelled.
   */
  readonly giveUp: () => boolean;
  /**
   * Whether the schedule or project was removed since the reservation, at any
   * point until {@link finish}. Read right before writing the outcome: a
   * removed schedule has no history left to write into.
   */
  readonly removed: () => boolean;
  /** The launcher has written its outcome; a removal from here on is the history's own. */
  readonly finish: () => void;
}

export function reserveScheduledLaunch(reservation: ScheduledLaunchReservation): ReservedLaunch {
  if (pending.has(reservation.runId)) {
    throw new Error(`Scheduled run ${reservation.runId} is already reserved`);
  }
  let state: ScheduledAdmissionState = { kind: "pending" };
  let resolveAdmitted!: () => void;
  let rejectAdmitted!: (error: Error) => void;
  const admitted = new Promise<void>((res, rej) => {
    resolveAdmitted = res;
    rejectAdmitted = rej;
  });
  // A launcher that gave up no longer waits on it.
  admitted.catch(() => {});
  const entry: Pending = {
    reservation,
    settle: (next) => {
      state = next;
      if (next.kind === "registered") resolveAdmitted();
      else rejectAdmitted(new Error(next.kind === "refused" ? next.message : next.kind));
    },
  };
  pending.set(reservation.runId, entry);
  const launching = { reservation, removed: false };
  removedWhileLaunching.set(reservation.runId, launching);
  const release = (): boolean => {
    if (pending.get(reservation.runId) !== entry) return false;
    pending.delete(reservation.runId);
    return true;
  };
  return {
    admitted,
    state: () => state,
    withdraw: () => {
      if (!release()) return false;
      entry.settle({ kind: "refused", message: "withdrawn" });
      return true;
    },
    giveUp: () => {
      if (!release()) return false;
      tombstone(reservation.runId);
      entry.settle({ kind: "refused", message: "given up" });
      return true;
    },
    removed: () => launching.removed,
    finish: () => {
      if (removedWhileLaunching.get(reservation.runId) === launching) {
        removedWhileLaunching.delete(reservation.runId);
      }
    },
  };
}

/**
 * Called by the spawn handler immediately before it starts the PTY, with no
 * await between. A spawn naming a reserved run registers it here, or throws
 * to refuse the spawn; any other spawn passes untouched. True when this spawn
 * registered the run: only it is the run's launch, so only its handback code
 * reports for the run.
 */
export function admitScheduledSpawn(spawn: ScheduledSpawn): boolean {
  const ref = spawn.scheduledRun;
  if (!ref) return false;
  if (givenUp.delete(ref.runId)) {
    throw new Error("This scheduled run was given up before its terminal started");
  }
  const entry = pending.get(ref.runId);
  if (!entry) return false;
  const { reservation } = entry;
  pending.delete(ref.runId);
  try {
    if (
      reservation.terminalId !== spawn.terminalId ||
      reservation.scheduleId !== ref.scheduleId ||
      reservation.projectId !== spawn.projectId ||
      reservation.agentId !== spawn.launchAgentId
    ) {
      throw new Error("The terminal that started isn't the one this scheduled run reserved");
    }
    // The spawn handler falls back to the project root or home from a folder
    // that's gone; an unattended run doesn't start somewhere it wasn't asked to.
    if (spawn.requestedCwd !== undefined && spawn.requestedCwd !== spawn.cwd) {
      throw new Error("The run's working directory is missing.");
    }
    reservation.admit(
      {
        agentId: reservation.agentId,
        agentSessionId: spawn.agentSessionId ?? null,
        cwd: spawn.cwd,
        worktreeId: spawn.worktreeId ?? null,
        agentLaunchFlags: [...(spawn.agentLaunchFlags ?? [])],
        agentModelId: spawn.agentModelId ?? null,
        agentPresetId: spawn.agentPresetId ?? null,
      },
      spawn.handbackCode ?? null
    );
  } catch (error) {
    const refusal = error instanceof Error ? error : new Error(String(error));
    entry.settle({ kind: "refused", message: refusal.message });
    throw refusal;
  }
  entry.settle({ kind: "registered" });
  return true;
}

/**
 * Cancels the launches reserved for a schedule or a project being removed,
 * synchronously with the removal, so none registers a run whose history was
 * just deleted. Their first spawn is refused.
 */
export function cancelScheduledLaunches(match: { projectId?: string; scheduleId?: string }): void {
  const matches = (reservation: ScheduledLaunchReservation): boolean =>
    (match.projectId === undefined || reservation.projectId === match.projectId) &&
    (match.scheduleId === undefined || reservation.scheduleId === match.scheduleId);
  for (const launching of removedWhileLaunching.values()) {
    if (matches(launching.reservation)) launching.removed = true;
  }
  for (const [runId, entry] of [...pending]) {
    if (!matches(entry.reservation)) continue;
    pending.delete(runId);
    tombstone(runId);
    entry.settle({ kind: "cancelled" });
  }
}

/** Whether a launch is reserved in the project and not yet spawned; automatic sleep waits for it too. */
export function hasPendingScheduledLaunch(projectId: string): boolean {
  for (const { reservation } of pending.values()) {
    if (reservation.projectId === projectId) return true;
  }
  return false;
}

/** @internal Tests only. */
export function _resetScheduledRunAdmissionForTest(): void {
  pending.clear();
  removedWhileLaunching.clear();
  givenUp.clear();
}
