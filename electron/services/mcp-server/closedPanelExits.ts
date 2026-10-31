import type { EndTrashGraceStatus } from "../../../shared/types/pty-host.js";
import type {
  TerminalExitObservation,
  TerminalWaitForExitResult,
} from "../../../shared/types/terminalExitWait.js";
import { exitMatches, type RecentTerminalExit } from "../pty/RecentTerminalExits.js";

/** A panel the caller closed, and the incarnation it closed when main knew it. */
export interface ClosedPanelExitTarget {
  terminalId: string;
  launchGeneration: number | undefined;
}

/** The fields of the pty-host's terminal record a wait reads. */
export interface ClosedPanelExitRecord {
  isExited?: boolean;
  launchGeneration?: number;
}

export interface ClosedPanelExitDeps {
  /** An exit main received for this incarnation (#15728), kept past the host's record. */
  findExit(
    terminalId: string,
    launchGeneration: number | undefined
  ): RecentTerminalExit | undefined;
  onExit(listener: (exit: RecentTerminalExit) => void): () => void;
  /** The host's record, null when it holds none. Rejects when the read failed. */
  readRecord(terminalId: string): Promise<ClosedPanelExitRecord | null>;
  /** Null when the host did not answer. */
  endTrashGrace(terminalId: string, launchGeneration: number): Promise<EndTrashGraceStatus | null>;
}

export interface ClosedPanelExitWaitOptions {
  timeoutMs: number;
  endGrace: boolean;
  signal?: AbortSignal;
  /**
   * Asked right before each grace is ended, since the reads before it take a
   * while: throws to refuse, and the wait rejects with that error.
   */
  authorizeEndGrace?: () => void;
}

/** How long the answers still out at the deadline may take before they count as unanswered. */
export const FINAL_READ_BUDGET_MS = 2000;

type Observation = TerminalExitObservation | "alive" | "unreadable";

function exited(exit: RecentTerminalExit): TerminalExitObservation {
  return {
    terminalId: exit.terminalId,
    outcome: "exited",
    exitCode: exit.exitCode,
    ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
  };
}

function settleBy<T>(promise: Promise<T>, fallback: T, until: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, until - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Wait, under one deadline, for the processes of panels the caller closed to
 * exit (#15728). Reports only what the host saw: an exit it reported for the
 * closed incarnation, or a record it holds marked exited, is `exited`; a record
 * still alive when the deadline passes is `running`; anything else — a record
 * gone with no exit seen, an id that now names another incarnation, a read
 * nobody answered — is `unknown`. With `endGrace`, panels still in the trash
 * start their expiry now instead of when the grace ends; that starts the
 * shutdown and proves nothing, and `graceEnded` is left out for a panel whose
 * host never answered the request.
 *
 * Bounded by `timeoutMs` plus {@link FINAL_READ_BUDGET_MS} for whatever is
 * still out when it passes. A `timeoutMs` of 0 reads each panel once.
 *
 * Authorization is the caller's: every target is one it already showed it
 * closed. A future composite (retire a worktree) calls this directly.
 */
export async function waitForClosedPanelExits(
  targets: readonly ClosedPanelExitTarget[],
  options: ClosedPanelExitWaitOptions,
  deps: ClosedPanelExitDeps
): Promise<TerminalWaitForExitResult> {
  const timeoutMs = Math.max(0, options.timeoutMs);
  const settled = new Map<string, TerminalExitObservation>();
  const pending = new Map<string, ClosedPanelExitTarget>();
  for (const target of targets) pending.set(target.terminalId, target);
  const firstLook = new Map<string, Promise<Observation>>();
  const graceRequests = new Map<string, Promise<EndTrashGraceStatus | null>>();
  const graceEnded = new Map<string, boolean>();

  let wake = () => {};
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const settle = (terminalId: string, observation: TerminalExitObservation) => {
    if (!pending.delete(terminalId)) return;
    settled.set(terminalId, observation);
    if (pending.size === 0) wake();
  };

  // Subscribed before any read, so an exit landing while one is out is kept.
  const unsubscribe = deps.onExit((exit) => {
    const target = pending.get(exit.terminalId);
    if (target === undefined) return;
    if (!exitMatches(exit, target.terminalId, target.launchGeneration)) return;
    settle(target.terminalId, exited(exit));
  });
  const deadline = setTimeout(wake, timeoutMs);
  const onAbort = () => wake();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true || pending.size === 0) wake();

  const observe = async (target: ClosedPanelExitTarget): Promise<Observation> => {
    const known = deps.findExit(target.terminalId, target.launchGeneration);
    if (known !== undefined) return exited(known);
    let record: ClosedPanelExitRecord | null;
    try {
      record = await deps.readRecord(target.terminalId);
    } catch {
      return "unreadable";
    }
    const late = deps.findExit(target.terminalId, target.launchGeneration);
    if (late !== undefined) return exited(late);
    const unknown: TerminalExitObservation = { terminalId: target.terminalId, outcome: "unknown" };
    if (record === null) return unknown;
    if (
      target.launchGeneration !== undefined &&
      record.launchGeneration !== undefined &&
      record.launchGeneration !== target.launchGeneration
    ) {
      return unknown;
    }
    if (record.isExited === true) return { terminalId: target.terminalId, outcome: "exited" };
    return "alive";
  };

  let refusal: { error: unknown } | undefined;
  // Set once the first reads' budget lapses: a read answering after that
  // starts nothing this call could still report or refuse.
  let tooLateForGrace = false;
  const requestEndGrace = (target: ClosedPanelExitTarget) => {
    if (!options.endGrace || !pending.has(target.terminalId)) return;
    if (options.signal?.aborted === true || refusal !== undefined || tooLateForGrace) return;
    const generation = target.launchGeneration;
    if (generation === undefined) {
      graceEnded.set(target.terminalId, false);
      return;
    }
    try {
      options.authorizeEndGrace?.();
    } catch (error) {
      refusal = { error };
      wake();
      return;
    }
    const request = deps.endTrashGrace(target.terminalId, generation).catch(() => null);
    graceRequests.set(target.terminalId, request);
    void request.then((status) => {
      if (status !== null) graceEnded.set(target.terminalId, status === "started");
    });
  };

  const initial = Promise.all(
    targets.map(async (target) => {
      const look = observe(target);
      firstLook.set(target.terminalId, look);
      const observation = await look;
      if (typeof observation === "object") settle(target.terminalId, observation);
      else requestEndGrace(target);
    })
  );

  try {
    // Until every panel has an answer, the deadline passes, or the call is
    // cancelled; the first reads count against the same deadline.
    await Promise.race([initial.then(() => woken), woken]);
    const budgetEnds = Date.now() + FINAL_READ_BUDGET_MS;
    // First reads still out get the budget too, so their grace requests count.
    await settleBy(
      initial.then(() => undefined),
      undefined,
      budgetEnds
    );
    tooLateForGrace = true;
    if (refusal !== undefined) throw refusal.error;

    await Promise.all([
      ...[...pending.values()].map(async (target) => {
        const look =
          timeoutMs === 0 ? (firstLook.get(target.terminalId) ?? observe(target)) : observe(target);
        const observation = await settleBy<Observation>(look, "unreadable", budgetEnds);
        settle(
          target.terminalId,
          typeof observation === "object"
            ? observation
            : {
                terminalId: target.terminalId,
                outcome: observation === "alive" ? "running" : "unknown",
              }
        );
      }),
      ...[...graceRequests.values()].map((request) => settleBy(request, null, budgetEnds)),
    ]);
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  return {
    processes: targets.map((target) => {
      const observation = settled.get(target.terminalId) ?? {
        terminalId: target.terminalId,
        outcome: "unknown" as const,
      };
      if (!options.endGrace) return observation;
      const ended = graceEnded.get(target.terminalId);
      if (ended !== undefined) return { ...observation, graceEnded: ended };
      // Asked, and the host never answered: whether it started is unknown.
      if (graceRequests.has(target.terminalId)) return observation;
      // Settled, or never readable, before a grace was asked for.
      return { ...observation, graceEnded: false };
    }),
  };
}
