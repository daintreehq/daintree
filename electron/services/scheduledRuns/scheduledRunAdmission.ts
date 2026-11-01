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
 * finds none and spawns as any pane does. Leaf module: the spawn handler
 * imports it, so it carries no services of its own.
 */

/** What the spawn handler is about to start, in the terms a reservation checks. */
export interface ScheduledSpawn {
  readonly terminalId: string;
  readonly projectId: string | undefined;
  readonly scheduledRun: ScheduledRunRef | undefined;
  readonly launchAgentId: string | undefined;
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

interface Pending {
  readonly reservation: ScheduledLaunchReservation;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const GIVEN_UP_MESSAGE = "given up";

const pending = new Map<string, Pending>();

/**
 * Runs given up on before their terminal spawned. Their first late spawn is
 * refused: the history already says the run failed, and an agent running
 * unattended behind that record is the one thing it can't be allowed to do.
 * Only the first, so a pane the user restarts by hand still restarts.
 */
const givenUp = new Set<string>();
const MAX_GIVEN_UP = 64;

/** Where a reservation stands. */
export type ScheduledAdmissionState =
  | { readonly kind: "pending" }
  | { readonly kind: "registered" }
  /** A spawn took it and was refused, or the launcher gave it up. */
  | { readonly kind: "refused"; readonly message: string };

export interface ReservedLaunch {
  /** Settles when a spawn takes the reservation: resolved once registered, rejected when refused. */
  readonly admitted: Promise<void>;
  readonly state: () => ScheduledAdmissionState;
  /**
   * Gives the reservation up, as the launcher does when no spawn came in
   * time. True when it was still pending, so nothing registered the run and
   * its first late spawn will be refused; false when a spawn already took it.
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
  pending.set(reservation.runId, {
    reservation,
    resolve: () => {
      state = { kind: "registered" };
      resolveAdmitted();
    },
    reject: (error) => {
      state = { kind: "refused", message: error.message };
      rejectAdmitted(error);
    },
  });
  return {
    admitted,
    state: () => state,
    giveUp: () => {
      const entry = pending.get(reservation.runId);
      if (entry?.reservation !== reservation) return false;
      pending.delete(reservation.runId);
      givenUp.add(reservation.runId);
      while (givenUp.size > MAX_GIVEN_UP) givenUp.delete(givenUp.values().next().value!);
      entry.reject(new Error(GIVEN_UP_MESSAGE));
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
    entry.reject(refusal);
    throw refusal;
  }
  entry.resolve();
}

/** Projects with a launch reserved and not yet spawned; automatic sleep waits for them too. */
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
