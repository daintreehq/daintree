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
}

export interface ScheduledLaunchReservation {
  readonly runId: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly agentId: string;
  /**
   * Registers the run from the spawn's resume snapshot, synchronously: the
   * spawn follows with no await between. Throwing refuses the spawn, and the
   * launcher hears it as the admission's rejection.
   */
  readonly admit: (resume: ScheduledRunResume) => void;
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
 * Runs given up on after their launch was asked for, before their terminal
 * spawned. Their first late spawn is refused: the history already says the
 * run failed (or has no run at all), and an agent running unattended behind
 * that is the one thing it can't be allowed to do. Only the first, so a pane
 * the user restarts by hand still restarts.
 *
 * Kept for the life of the process: a view frozen mid-launch can spawn days
 * later. Only a launch that went unanswered or never spawned lands here, so
 * the bound is a backstop against a runaway, not a working limit.
 */
const givenUp = new Set<string>();
const MAX_GIVEN_UP = 4096;

function tombstone(runId: string): void {
  givenUp.add(runId);
  while (givenUp.size > MAX_GIVEN_UP) givenUp.delete(givenUp.values().next().value!);
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
  };
}

/**
 * Called by the spawn handler immediately before it starts the PTY, with no
 * await between. A spawn naming a reserved run registers it here, or throws
 * to refuse the spawn; any other spawn passes untouched.
 */
export function admitScheduledSpawn(spawn: ScheduledSpawn): void {
  const ref = spawn.scheduledRun;
  if (!ref) return;
  if (givenUp.delete(ref.runId)) {
    throw new Error("This scheduled run was given up before its terminal started");
  }
  const entry = pending.get(ref.runId);
  if (!entry) return;
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
    reservation.admit({
      agentId: reservation.agentId,
      agentSessionId: spawn.agentSessionId ?? null,
      cwd: spawn.cwd,
      worktreeId: spawn.worktreeId ?? null,
      agentLaunchFlags: [...(spawn.agentLaunchFlags ?? [])],
      agentModelId: spawn.agentModelId ?? null,
      agentPresetId: spawn.agentPresetId ?? null,
    });
  } catch (error) {
    const refusal = error instanceof Error ? error : new Error(String(error));
    entry.settle({ kind: "refused", message: refusal.message });
    throw refusal;
  }
  entry.settle({ kind: "registered" });
}

/**
 * Cancels the launches reserved for a schedule or a project being removed,
 * synchronously with the removal, so none registers a run whose history was
 * just deleted. Their first spawn is refused.
 */
export function cancelScheduledLaunches(match: { projectId?: string; scheduleId?: string }): void {
  for (const [runId, entry] of [...pending]) {
    const { reservation } = entry;
    if (match.projectId !== undefined && reservation.projectId !== match.projectId) continue;
    if (match.scheduleId !== undefined && reservation.scheduleId !== match.scheduleId) continue;
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
  givenUp.clear();
}
