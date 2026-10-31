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
  findExit(terminalId: string, launchGeneration: number | undefined): RecentTerminalExit | undefined;
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
}

/** How long the reads after the deadline may take before they count as unanswered. */
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

/**
 * Wait, under one deadline, for the processes of panels the caller closed to
 * exit (#15728). Reports only what the host saw: an exit it reported, or a
 * record it holds marked exited, is `exited`; a record still alive when the
 * deadline passes is `running`; anything else — a record gone with no exit
 * seen, an id that now names another incarnation, a read nobody answered — is
 * `unknown`. With `endGrace`, panels still in the trash start their expiry now
 * instead of when the grace ends; that starts the shutdown and proves nothing.
 *
 * Authorization is the caller's: every target is one it already showed it
 * closed. A future composite (retire a worktree) calls this directly.
 */
export async function waitForClosedPanelExits(
  targets: readonly ClosedPanelExitTarget[],
  options: ClosedPanelExitWaitOptions,
  deps: ClosedPanelExitDeps
): Promise<TerminalWaitForExitResult> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const settled = new Map<string, TerminalExitObservation>();
  const pending = new Map<string, ClosedPanelExitTarget>();
  for (const target of targets) pending.set(target.terminalId, target);
  const graceEnded = new Map<string, boolean>();

  const settle = (terminalId: string, observation: TerminalExitObservation) => {
    if (!pending.delete(terminalId)) return;
    settled.set(terminalId, observation);
  };

  let wake: (() => void) | undefined;
  // Subscribed before any read, so an exit landing while one is out is kept.
  const unsubscribe = deps.onExit((exit) => {
    const target = pending.get(exit.terminalId);
    if (target === undefined) return;
    if (!exitMatches(exit, target.terminalId, target.launchGeneration)) return;
    settle(target.terminalId, exited(exit));
    if (pending.size === 0) wake?.();
  });

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

  try {
    await Promise.all(
      targets.map(async (target) => {
        const observation = await observe(target);
        if (typeof observation === "object") settle(target.terminalId, observation);
      })
    );

    if (options.endGrace) {
      await Promise.all(
        [...pending.values()].map(async (target) => {
          if (target.launchGeneration === undefined) {
            graceEnded.set(target.terminalId, false);
            return;
          }
          const status = await deps
            .endTrashGrace(target.terminalId, target.launchGeneration)
            .catch(() => null);
          graceEnded.set(target.terminalId, status === "started");
        })
      );
    }

    const remaining = deadline - Date.now();
    if (pending.size > 0 && remaining > 0 && options.signal?.aborted !== true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, remaining);
        onAbort = resolve;
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      wake = undefined;
      clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }

    await Promise.all(
      [...pending.values()].map(async (target) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observation = await Promise.race<Observation>([
          observe(target),
          new Promise<Observation>((resolve) => {
            timer = setTimeout(() => resolve("unreadable"), FINAL_READ_BUDGET_MS);
          }),
        ]);
        clearTimeout(timer);
        settle(
          target.terminalId,
          typeof observation === "object"
            ? observation
            : {
                terminalId: target.terminalId,
                outcome: observation === "alive" ? "running" : "unknown",
              }
        );
      })
    );
  } finally {
    unsubscribe();
  }

  return {
    processes: targets.map((target) => {
      const observation = settled.get(target.terminalId) ?? {
        terminalId: target.terminalId,
        outcome: "unknown" as const,
      };
      return options.endGrace
        ? { ...observation, graceEnded: graceEnded.get(target.terminalId) ?? false }
        : observation;
    }),
  };
}
