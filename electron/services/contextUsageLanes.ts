/**
 * One context reading per terminal at a time, under a deadline that holds
 * whether or not the filesystem honours the abort (#16371, #16408). Each agent's
 * host service keeps its own set of lanes.
 */

import type {
  AgentContextUsageResult,
  AgentContextUsageUnavailableReason,
} from "../../shared/types/ipc/agentContextUsage.js";

function unavailable(reason: AgentContextUsageUnavailableReason): AgentContextUsageResult {
  return { status: "unavailable", reason };
}

export interface ContextUsageLanes {
  /**
   * `read` in the terminal's lane. A caller the deadline answers stops waiting
   * for its turn, so nothing of it is left behind a stalled read.
   */
  run(
    terminalId: string,
    deadlineMs: number,
    read: (signal: AbortSignal) => Promise<AgentContextUsageResult>
  ): Promise<AgentContextUsageResult>;
  /** Test-only: how many callers are waiting behind a terminal's running read. */
  waiters(terminalId: string): number;
}

export function createContextUsageLanes(): ContextUsageLanes {
  /**
   * One read per terminal at a time. A terminal is in the map while a read of it
   * runs, with the callers waiting for their turn; a read past its deadline keeps
   * the slot until it settles, so a stalled store holds one read per pane, and a
   * caller never takes an answer read before it asked.
   */
  const lanes = new Map<string, Set<() => void>>();

  /** Hands the terminal's slot to the next caller still waiting, or frees it. */
  function release(terminalId: string): void {
    const waiting = lanes.get(terminalId);
    const next = waiting?.values().next().value;
    if (!waiting || next === undefined) {
      lanes.delete(terminalId);
      return;
    }
    waiting.delete(next);
    next();
  }

  async function run(
    terminalId: string,
    deadlineMs: number,
    read: (signal: AbortSignal) => Promise<AgentContextUsageResult>
  ): Promise<AgentContextUsageResult> {
    let answered = false;
    let waiter: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      const waiting = lanes.get(terminalId);
      if (!waiting) {
        lanes.set(terminalId, new Set());
        resolve();
        return;
      }
      waiter = resolve;
      waiting.add(resolve);
    });
    const work = turn.then(async (): Promise<AgentContextUsageResult> => {
      try {
        if (answered) return unavailable("store-unreadable");
        return await read(AbortSignal.timeout(deadlineMs));
      } catch {
        // Nothing is logged: a filesystem error names a path under the user's home.
        return unavailable("store-unreadable");
      } finally {
        release(terminalId);
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AgentContextUsageResult>((resolve) => {
      timer = setTimeout(() => resolve(unavailable("store-unreadable")), deadlineMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      answered = true;
      clearTimeout(timer);
      if (waiter) lanes.get(terminalId)?.delete(waiter);
    }
  }

  return { run, waiters: (terminalId) => lanes.get(terminalId)?.size ?? 0 };
}
