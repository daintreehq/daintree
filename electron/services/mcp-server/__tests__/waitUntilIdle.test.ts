import { describe, it, expect, afterEach, vi } from "vitest";
import {
  handleWaitUntilIdle,
  handleWaitUntilIdleBatch,
  OUTPUT_PROGRESS_LOOKUP_TIMEOUT_MS,
} from "../waitUntilIdle.js";
import { events } from "../../events.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import { setPtyClientRef } from "../../../window/serviceRefs.js";
import type { PtyClient } from "../../PtyClient.js";
import type { WaitUntilIdleResult } from "../../../../shared/types/terminalWaitUntilIdle.js";

const emitIdle = (
  terminalId: string,
  agentId: string,
  state: "completed" | "idle" = "completed"
) => {
  events.emit("agent:state-changed", {
    agentId,
    terminalId,
    state,
    previousState: "working",
    trigger: "output",
    confidence: 1,
    timestamp: Date.now(),
  });
};

let counter = 0;
const nextIds = () => {
  counter += 1;
  return { terminalId: `wt-term-${counter}`, agentId: `wt-agent-${counter}` };
};

const seedWorkingAgent = (terminalId: string, agentId: string) => {
  getAgentAvailabilityStore();
  events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });
  events.emit("agent:state-changed", {
    agentId,
    terminalId,
    state: "working",
    previousState: "idle",
    trigger: "output",
    confidence: 1,
    timestamp: Date.now(),
  });
};

describe("handleWaitUntilIdle timeout clamping", () => {
  it("clamps an explicit timeoutMs to options.maxTimeoutMs", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const started = Date.now();
    // Requested 10s wait, clamped to a 50ms interactive ceiling — must time
    // out near the ceiling, not the request.
    const result: WaitUntilIdleResult = await handleWaitUntilIdle(
      { terminalId, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 50 }
    );
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.busyState).toBe("working");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("clamps the default timeout to options.maxTimeoutMs when timeoutMs is omitted", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const started = Date.now();
    const result: WaitUntilIdleResult = await handleWaitUntilIdle(
      { terminalId },
      new AbortController().signal,
      { maxTimeoutMs: 50 }
    );
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("still settles on a state transition while clamped", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const callPromise = handleWaitUntilIdle(
      { terminalId, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "completed",
      previousState: "working",
      trigger: "output",
      confidence: 1,
      timestamp: Date.now(),
    });

    const result = await callPromise;
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("completed");
  });
});

describe("handleWaitUntilIdle exit metadata", () => {
  const settleWith = async (
    state: "completed" | "exited",
    extra: { exitCode?: number | null; exitSignal?: number }
  ): Promise<WaitUntilIdleResult> => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    const callPromise = handleWaitUntilIdle(
      { terminalId, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state,
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      ...extra,
    });
    return callPromise;
  };

  it("carries exitCode 0 from a clean completion transition", async () => {
    const result = await settleWith("completed", { exitCode: 0 });
    expect(result.idleReason).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("carries a non-zero exitCode from a failed exit transition", async () => {
    const result = await settleWith("exited", { exitCode: 1 });
    expect(result.idleReason).toBe("exited");
    expect(result.exitCode).toBe(1);
  });

  it("carries a null exitCode plus exitSignal for a signal-terminated exit", async () => {
    const result = await settleWith("exited", { exitCode: null, exitSignal: 9 });
    expect(result.exitCode).toBeNull();
    expect(result.exitSignal).toBe(9);
  });

  it("omits exit metadata while the agent is still working (timeout)", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 30,
    });
    expect(result.timedOut).toBe(true);
    expect(result).not.toHaveProperty("exitCode");
    expect(result).not.toHaveProperty("exitSignal");
  });

  it("reads exit metadata from the store cache when the agent already exited (already-idle)", async () => {
    const { terminalId, agentId } = nextIds();
    getAgentAvailabilityStore();
    events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });
    // Completion happens BEFORE the wait call — exercises the already-idle path
    // that falls back to the store's cached exit code.
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "exited",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      exitCode: 42,
    });

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal);
    expect(result.timedOut).toBe(false);
    expect(result.idleReason).toBe("exited");
    expect(result.exitCode).toBe(42);
  });
});

describe("handleWaitUntilIdle stale-state crash race (#10816)", () => {
  it("does not settle as already-idle on a prior session's stale 'waiting' after respawn", async () => {
    const store = getAgentAvailabilityStore();
    const agentId = `wt-agent-stale-${(counter += 1)}`;
    const oldTerminal = `wt-term-stale-old-${counter}`;
    const newTerminal = `wt-term-stale-new-${counter}`;

    // Prior session under the same agentId ended in "waiting".
    events.emit("agent:spawned", { agentId, terminalId: oldTerminal, timestamp: Date.now() });
    events.emit("agent:state-changed", {
      agentId,
      terminalId: oldTerminal,
      state: "waiting",
      previousState: "working",
      trigger: "output",
      confidence: 1,
      timestamp: Date.now(),
      waitingReason: "prompt",
    });
    expect(store.getTerminalSnapshot(oldTerminal)?.state).toBe("waiting");

    // New session spawns under the same agentId (e.g. another "claude" launch).
    events.emit("agent:spawned", { agentId, terminalId: newTerminal, timestamp: Date.now() });

    const p = handleWaitUntilIdle(
      { terminalId: newTerminal, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );

    // Must block on the live subscription rather than short-circuit on the stale
    // "waiting". Then the crash arrives and is reported as the exit, not idle.
    await new Promise((r) => setTimeout(r, 10));
    events.emit("agent:state-changed", {
      agentId,
      terminalId: newTerminal,
      state: "exited",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      exitCode: 1,
    });

    const result = await p;
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("exited");
    expect(result.exitCode).toBe(1);
  });

  it("reports a failed-to-start agent as exited (no exitCode) on the already-idle path (#10816 mode 3)", async () => {
    // Mode 3: the pty-host synthesizes agent-spawned + agent-state(exited) with
    // NO exitCode before the consumer calls waitUntilIdle. The store is already
    // "exited", so this exercises the already-idle snapshot path — it must
    // report idleReason "exited" (not "unknown"/working) and omit exitCode,
    // since no process ever ran.
    const store = getAgentAvailabilityStore();
    const agentId = `wt-agent-mode3-${(counter += 1)}`;
    const terminalId = `wt-term-mode3-${counter}`;

    events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "exited",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      // No exitCode — failed-to-start, process never ran.
    });
    expect(store.getTerminalSnapshot(terminalId)?.state).toBe("exited");
    expect(store.getTerminalSnapshot(terminalId)).not.toHaveProperty("exitCode");

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal);
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("exited");
    expect(result).not.toHaveProperty("exitCode");
  });
});

// #12494 — agent ids name the agent type, so a fleet of identical agents shares
// one. Each wait must answer from its own terminal, never from a sibling's.
describe("same-type sibling terminals", () => {
  const siblings = () => {
    counter += 1;
    return {
      agentId: `wt-agent-shared-${counter}`,
      a: `wt-term-sib-a-${counter}`,
      b: `wt-term-sib-b-${counter}`,
      c: `wt-term-sib-c-${counter}`,
    };
  };

  const spawnAt = (agentId: string, terminalId: string, timestamp: number) => {
    getAgentAvailabilityStore();
    events.emit("agent:spawned", { agentId, terminalId, timestamp });
  };

  const transitionAt = (
    agentId: string,
    terminalId: string,
    state: "waiting" | "completed" | "exited" | "idle",
    timestamp: number,
    extra: { waitingReason?: "prompt" | "question"; exitCode?: number | null } = {}
  ) => {
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state,
      previousState: "working",
      trigger: state === "completed" || state === "exited" ? "exit" : "output",
      confidence: 1,
      timestamp,
      ...extra,
    });
  };

  const pendingAfter = <T>(p: Promise<T>, ms = 60) =>
    Promise.race([
      p.then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
    ]);

  it("does not settle a wait on one terminal because its sibling is already waiting", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);
    transitionAt(agentId, a, "waiting", 3_000, { waitingReason: "question" });

    const p = handleWaitUntilIdle(
      { terminalId: b, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(await pendingAfter(p)).toBe("pending");

    transitionAt(agentId, b, "completed", 4_000, { exitCode: 0 });
    const result = await p;
    expect(result.timedOut).toBe(false);
    expect(result.idleReason).toBe("completed");
    expect(result.lastTransitionAt).toBe(4_000);
    expect(result.exitCode).toBe(0);
    expect(result).not.toHaveProperty("waitingReason");
  });

  it("settles a wait on an older terminal that was waiting before a sibling spawned", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    transitionAt(agentId, a, "waiting", 2_000, { waitingReason: "question" });
    spawnAt(agentId, b, 3_000);

    const result = await handleWaitUntilIdle(
      { terminalId: a, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(result.timedOut).toBe(false);
    expect(result.idleReason).toBe("waiting_for_user");
    expect(result.waitingReason).toBe("question");
    expect(result.lastTransitionAt).toBe(2_000);
  });

  it("reports the waited terminal's own last transition on timeout", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, b, 1_000);
    spawnAt(agentId, a, 2_000);
    transitionAt(agentId, a, "waiting", 3_000);

    const result = await handleWaitUntilIdle(
      { terminalId: b, timeoutMs: 30 },
      new AbortController().signal
    );
    expect(result.timedOut).toBe(true);
    expect(result.busyState).toBe("working");
    expect(result.lastTransitionAt).toBe(1_000);
  });

  it("reads each terminal's own cached exit code on the already-idle path", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);
    transitionAt(agentId, a, "exited", 3_000, { exitCode: 1 });
    transitionAt(agentId, b, "completed", 4_000, { exitCode: 0 });

    const signal = new AbortController().signal;
    const resultA = await handleWaitUntilIdle({ terminalId: a, timeoutMs: 0 }, signal);
    const resultB = await handleWaitUntilIdle({ terminalId: b, timeoutMs: 0 }, signal);

    expect(resultA).toMatchObject({ idleReason: "exited", exitCode: 1, lastTransitionAt: 3_000 });
    expect(resultB).toMatchObject({
      idleReason: "completed",
      exitCode: 0,
      lastTransitionAt: 4_000,
    });
  });

  it("batch 'first' settles only the terminal that is itself already waiting", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);
    transitionAt(agentId, a, "waiting", 3_000, { waitingReason: "prompt" });

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [a, b], mode: "first", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );

    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual([a]);
    const aEntry = res.results.find((e) => e.terminalId === a)!;
    expect(aEntry).toMatchObject({
      settled: true,
      idleReason: "waiting_for_user",
      waitingReason: "prompt",
      lastTransitionAt: 3_000,
    });
    const bEntry = res.results.find((e) => e.terminalId === b)!;
    expect(bEntry).toMatchObject({ settled: false, busyState: "working", lastTransitionAt: 2_000 });
    expect(bEntry).not.toHaveProperty("waitingReason");
  });

  it("batch 'all' holds for the sibling that is still working", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);
    transitionAt(agentId, a, "waiting", 3_000);

    const p = handleWaitUntilIdleBatch(
      { terminalIds: [a, b], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(await pendingAfter(p)).toBe("pending");

    transitionAt(agentId, b, "exited", 4_000, { exitCode: 7 });
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual([a, b]);
    expect(res.results.find((e) => e.terminalId === a)).not.toHaveProperty("exitCode");
    expect(res.results.find((e) => e.terminalId === b)).toMatchObject({
      idleReason: "exited",
      exitCode: 7,
    });
  });

  it("batch rows are not settled by a same-type terminal outside the request", async () => {
    const { agentId, a, b, c } = siblings();
    // c spawns last, so the most-recently-spawned guard this replaced pointed
    // at c and read a's "waiting" as c's.
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);
    spawnAt(agentId, c, 3_000);
    transitionAt(agentId, a, "waiting", 4_000);

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [b, c], mode: "first" },
      new AbortController().signal,
      { maxTimeoutMs: 40 }
    );
    expect(res.timedOut).toBe(true);
    expect(res.settledTerminalIds).toEqual([]);
  });

  it("batch settles a killed row as closed without waiting on its live sibling", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    spawnAt(agentId, b, 2_000);

    const p = handleWaitUntilIdleBatch(
      { terminalIds: [a, b], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(await pendingAfter(p)).toBe("pending");

    // Killing an already-idle agent emits no transition, only the kill notice.
    events.emit("agent:killed", { agentId, terminalId: a, timestamp: Date.now() });
    expect(await pendingAfter(p)).toBe("pending");

    transitionAt(agentId, b, "completed", 3_000, { exitCode: 0 });
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.results.find((e) => e.terminalId === a)).toMatchObject({
      settled: true,
      busyState: "idle",
      idleReason: "unknown",
      trackingState: "closed",
    });
    expect(res.results.find((e) => e.terminalId === b)).toMatchObject({
      settled: true,
      idleReason: "completed",
      exitCode: 0,
      trackingState: "tracked",
    });
  });

  it("batch settles an older terminal that was waiting before a sibling spawned", async () => {
    const { agentId, a, b } = siblings();
    spawnAt(agentId, a, 1_000);
    transitionAt(agentId, a, "waiting", 2_000, { waitingReason: "question" });
    spawnAt(agentId, b, 3_000);

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [a], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(res.timedOut).toBe(false);
    expect(res.results[0]).toMatchObject({
      settled: true,
      waitingReason: "question",
      lastTransitionAt: 2_000,
    });
  });
});

describe("handleWaitUntilIdleBatch", () => {
  it("mode 'first' resolves as soon as any terminal leaves working", async () => {
    const a = nextIds();
    const b = nextIds();
    const c = nextIds();
    seedWorkingAgent(a.terminalId, a.agentId);
    seedWorkingAgent(b.terminalId, b.agentId);
    seedWorkingAgent(c.terminalId, c.agentId);

    const p = handleWaitUntilIdleBatch(
      {
        terminalIds: [a.terminalId, b.terminalId, c.terminalId],
        mode: "first",
        timeoutMs: 10_000,
      },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(b.terminalId, b.agentId);

    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual([b.terminalId]);
    expect(res.results).toHaveLength(3);
    const bEntry = res.results.find((e) => e.terminalId === b.terminalId)!;
    expect(bEntry.settled).toBe(true);
    expect(bEntry.busyState).toBe("idle");
    const aEntry = res.results.find((e) => e.terminalId === a.terminalId)!;
    expect(aEntry.settled).toBe(false);
    expect(aEntry.busyState).toBe("working");
  });

  it("mode 'all' resolves only once every terminal is non-working", async () => {
    const a = nextIds();
    const b = nextIds();
    seedWorkingAgent(a.terminalId, a.agentId);
    seedWorkingAgent(b.terminalId, b.agentId);

    const p = handleWaitUntilIdleBatch(
      { terminalIds: [a.terminalId, b.terminalId], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(a.terminalId, a.agentId);

    // One down, one to go — the predicate must NOT be satisfied yet.
    const stillPending = await Promise.race([
      p.then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 60)),
    ]);
    expect(stillPending).toBe("pending");

    emitIdle(b.terminalId, b.agentId);
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toHaveLength(2);
    expect(res.results.every((e) => e.settled)).toBe(true);
  });

  it("mode 'all' times out with the partial settled set when not all finish", async () => {
    const a = nextIds();
    const b = nextIds();
    seedWorkingAgent(a.terminalId, a.agentId);
    seedWorkingAgent(b.terminalId, b.agentId);

    const p = handleWaitUntilIdleBatch(
      { terminalIds: [a.terminalId, b.terminalId], mode: "all" },
      new AbortController().signal,
      { maxTimeoutMs: 60 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(a.terminalId, a.agentId);

    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(res.settledTerminalIds).toEqual([a.terminalId]);
  });

  it("mode 'first' times out with an empty settled set when all stay working", async () => {
    const a = nextIds();
    const b = nextIds();
    seedWorkingAgent(a.terminalId, a.agentId);
    seedWorkingAgent(b.terminalId, b.agentId);

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [a.terminalId, b.terminalId], mode: "first" },
      new AbortController().signal,
      { maxTimeoutMs: 40 }
    );
    expect(res.timedOut).toBe(true);
    expect(res.settledTerminalIds).toEqual([]);
    expect(res.results.every((e) => e.busyState === "working")).toBe(true);
  });

  it("treats untracked terminalIds as already idle and returns immediately", async () => {
    const started = Date.now();
    const res = await handleWaitUntilIdleBatch(
      { terminalIds: ["batch-no-agent"], mode: "first" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual(["batch-no-agent"]);
    expect(res.results[0]!.busyState).toBe("idle");
    expect(res.results[0]!.idleReason).toBe("unknown");
    expect(res.results[0]!.settled).toBe(true);
  });

  it("de-dupes repeated terminalIds in the results", async () => {
    const res = await handleWaitUntilIdleBatch(
      { terminalIds: ["batch-dup", "batch-dup"] },
      new AbortController().signal,
      { maxTimeoutMs: 30 }
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.terminalId).toBe("batch-dup");
  });

  it("treats a freshly spawned terminal as working, not already-idle (mode 'all', #10816)", async () => {
    // agent:spawned now resets the tracked state to "working", so a brand-new
    // session must NOT settle immediately — that stale "already-idle" short
    // circuit is exactly what let a crash be missed. The batch blocks until the
    // session actually transitions.
    const { terminalId, agentId } = nextIds();
    getAgentAvailabilityStore();
    events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });

    const p = handleWaitUntilIdleBatch(
      { terminalIds: [terminalId], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    // It must still be pending after a beat — proves it didn't short-circuit.
    const stillPending = await Promise.race([
      p.then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 60)),
    ]);
    expect(stillPending).toBe("pending");

    // The crash exit then settles it with the exit metadata intact.
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "exited",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      exitCode: 1,
    });
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual([terminalId]);
    expect(res.results[0]!.busyState).toBe("idle");
    expect(res.results[0]!.idleReason).toBe("exited");
    expect(res.results[0]!.exitCode).toBe(1);
  });

  it("rejects an empty terminalIds array", async () => {
    await expect(
      handleWaitUntilIdleBatch({ terminalIds: [] }, new AbortController().signal)
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects a raw terminalIds array over the cap before de-duping", async () => {
    // 300 duplicates de-dupe to 1, but the raw-length cap must reject first so a
    // huge payload can't slip past the advertised 256 limit.
    const huge = Array.from({ length: 300 }, () => "same-id");
    await expect(
      handleWaitUntilIdleBatch({ terminalIds: huge }, new AbortController().signal)
    ).rejects.toThrow(/at most 256/);
  });

  it("rejects an invalid mode", async () => {
    await expect(
      handleWaitUntilIdleBatch({ terminalIds: ["x"], mode: "either" }, new AbortController().signal)
    ).rejects.toThrow(/mode/);
  });
});

// #12339 — "the agent finished" and "the terminal is gone" both surface as
// busyState: "idle". `trackingState` is the discriminator; these cover the
// issue's exact repro (launch, close, wait with timeoutMs: 0).
describe("trackingState discriminates a closed terminal from an idle agent", () => {
  const snapshot = (terminalId: string) =>
    handleWaitUntilIdle({ terminalId, timeoutMs: 0 }, new AbortController().signal);

  it("reports a live agent sitting at rest as 'tracked'", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    emitIdle(terminalId, agentId, "idle");

    const result = await snapshot(terminalId);

    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("idle");
    expect(result.trackingState).toBe("tracked");
  });

  it("reports a closed terminal as 'closed' with an unknown idleReason", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    // A kill maps straight to `idle` in the FSM, then agent:killed lands.
    emitIdle(terminalId, agentId, "idle");
    events.emit("agent:killed", { agentId, terminalId, timestamp: Date.now() });

    const result = await snapshot(terminalId);

    // Still idle and still non-failing — the fail-open contract is unchanged.
    expect(result.busyState).toBe("idle");
    expect(result.timedOut).toBe(false);
    // ...but no longer indistinguishable from the case above.
    expect(result.idleReason).toBe("unknown");
    expect(result.trackingState).toBe("closed");
  });

  it("reports an id it has never seen as 'unknown', not 'closed'", async () => {
    const result = await snapshot("never-existed-terminal");

    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("unknown");
    // A reconciler reaps on "closed" but may retry on "unknown" (a poll can
    // race the spawn), so these must not collapse.
    expect(result.trackingState).toBe("unknown");
  });

  it("reports 'tracked' while the agent is still working (timeout path)", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 30,
    });

    expect(result.timedOut).toBe(true);
    expect(result.trackingState).toBe("tracked");
  });

  it("reports 'tracked' for an agent that exited normally, panel still tracked", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "completed",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
      exitCode: 0,
    });

    const result = await snapshot(terminalId);

    // The process ended but the terminal was never killed — a completed run is
    // already unambiguous via idleReason + exitCode.
    expect(result.idleReason).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.trackingState).toBe("tracked");
  });

  it("a respawn under the same terminal id reports 'tracked' again", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    events.emit("agent:killed", { agentId, terminalId, timestamp: Date.now() });
    expect((await snapshot(terminalId)).trackingState).toBe("closed");

    seedWorkingAgent(terminalId, agentId);

    expect((await snapshot(terminalId)).trackingState).toBe("tracked");
  });

  it("batch rows carry trackingState and closed rows stay settled", async () => {
    const live = nextIds();
    const closed = nextIds();
    seedWorkingAgent(live.terminalId, live.agentId);
    emitIdle(live.terminalId, live.agentId, "idle");
    seedWorkingAgent(closed.terminalId, closed.agentId);
    emitIdle(closed.terminalId, closed.agentId, "idle");
    events.emit("agent:killed", {
      agentId: closed.agentId,
      terminalId: closed.terminalId,
      timestamp: Date.now(),
    });

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [live.terminalId, closed.terminalId, "batch-never-existed"], mode: "all" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );

    const byId = new Map(res.results.map((e) => [e.terminalId, e]));
    expect(byId.get(live.terminalId)!.trackingState).toBe("tracked");
    expect(byId.get(closed.terminalId)!.trackingState).toBe("closed");
    expect(byId.get("batch-never-existed")!.trackingState).toBe("unknown");

    // `settled` deliberately stays true for gone terminals so mode "all" cannot
    // hang on them — trackingState is what says the work did not finish.
    expect(byId.get(closed.terminalId)!.settled).toBe(true);
    expect(byId.get("batch-never-existed")!.settled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toHaveLength(3);
  });
});

// A production kill arrives as TWO separate port messages — `agent:state-changed`
// with state `idle`, then `agent:killed` — so a wait already in flight settles on
// the first. These pin the resulting behaviour, including the one case that is
// deliberately allowed to lag.
describe("a kill landing mid-wait (#12339)", () => {
  const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const emitKillTransition = (terminalId: string, agentId: string) => {
    // The FSM maps a kill to `idle`, so this is what a kill emits first.
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "idle",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: Date.now(),
    });
  };

  // The documented lag, asserted rather than left to chance: the in-flight wait
  // answers before the kill notice lands, and the NEXT read is authoritative.
  // Pinned so that closing this window (by carrying the kill on the transition)
  // is a visible, deliberate change to this expectation rather than a silent one.
  it("answers tracked while the kill notice is still in transit, then closed", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const pending = handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 5_000,
    });
    await nextTurn();
    emitKillTransition(terminalId, agentId);
    const during = await pending;

    // Lags — but never the other way: it does not claim "closed" without a kill.
    expect(during.busyState).toBe("idle");
    expect(during.trackingState).toBe("tracked");

    events.emit("agent:killed", { agentId, terminalId, timestamp: Date.now() });
    const after = await handleWaitUntilIdle(
      { terminalId, timeoutMs: 0 },
      new AbortController().signal
    );

    expect(after.trackingState).toBe("closed");
    expect(after.idleReason).toBe("unknown");
  });

  it("batch 'all' reports a row killed while another was still working", async () => {
    const done = nextIds();
    const killed = nextIds();
    seedWorkingAgent(done.terminalId, done.agentId);
    seedWorkingAgent(killed.terminalId, killed.agentId);

    const pending = handleWaitUntilIdleBatch(
      { terminalIds: [done.terminalId, killed.terminalId], mode: "all" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await nextTurn();
    // The kill fully lands (both messages) while the batch still waits on `done`,
    // so by the time the batch builds its answer the closure is observable.
    emitKillTransition(killed.terminalId, killed.agentId);
    events.emit("agent:killed", {
      agentId: killed.agentId,
      terminalId: killed.terminalId,
      timestamp: Date.now(),
    });
    await nextTurn();
    emitIdle(done.terminalId, done.agentId, "completed");

    const res = await pending;
    const byId = new Map(res.results.map((e) => [e.terminalId, e]));

    expect(res.timedOut).toBe(false);
    expect(byId.get(done.terminalId)!.trackingState).toBe("tracked");
    expect(byId.get(killed.terminalId)!.trackingState).toBe("closed");
    // Latched: the row stays settled even though it settled as a kill.
    expect(byId.get(killed.terminalId)!.settled).toBe(true);
  });

  // Killing an agent that is already idle is an idle->idle no-op in the FSM, so
  // it emits no state change at all. Before `agent:killed` was watched, this
  // held the wait open to its full ceiling on a terminal that was already gone.
  it("settles a wait on a kill that produces no state change", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    // Park it in `waiting` so the wait does not settle on entry, then kill it
    // without any accompanying transition.
    events.emit("agent:state-changed", {
      agentId,
      terminalId,
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 1,
      timestamp: Date.now(),
    });

    const started = Date.now();
    const pending = handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 30_000,
    });
    await nextTurn();
    events.emit("agent:killed", { agentId, terminalId, timestamp: Date.now() });

    const result = await pending;

    // Returns promptly rather than riding the 30s ceiling out.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.trackingState).toBe("closed");
  });
});

describe("lastOutputChangeAt on wait results (#12428)", () => {
  afterEach(() => {
    setPtyClientRef(null);
  });

  // Only these two are read; the cast keeps the fake to that surface.
  const installPtyClient = (
    getTerminalAsync: (id: string) => Promise<{ lastOutputChangeAt?: number } | null>,
    owners: Record<string, string> = {}
  ) => {
    const fake = {
      getTerminalAsync: vi.fn(getTerminalAsync),
      getTerminalProjectId: vi.fn((id: string) => owners[id] ?? null),
    };
    setPtyClientRef(fake as unknown as PtyClient);
    return fake;
  };

  it("reports each terminal's own reading on a batch, settled rows and working ones alike", async () => {
    const moving = nextIds();
    const still = nextIds();
    seedWorkingAgent(moving.terminalId, moving.agentId);
    seedWorkingAgent(still.terminalId, still.agentId);
    const readings: Record<string, number> = {
      [moving.terminalId]: 9_000,
      [still.terminalId]: 3_000,
    };
    const fake = installPtyClient(async (id) => ({ lastOutputChangeAt: readings[id] }));

    const pending = handleWaitUntilIdleBatch(
      { terminalIds: [moving.terminalId, still.terminalId], mode: "first", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(moving.terminalId, moving.agentId);
    const res = await pending;

    const byId = new Map(res.results.map((entry) => [entry.terminalId, entry]));
    expect(byId.get(moving.terminalId)).toMatchObject({ settled: true, lastOutputChangeAt: 9_000 });
    // The row still `working` is the one a caller needs this for most.
    expect(byId.get(still.terminalId)).toMatchObject({
      settled: false,
      busyState: "working",
      lastOutputChangeAt: 3_000,
    });
    // Read once the wait resolved, not per state event.
    expect(fake.getTerminalAsync).toHaveBeenCalledTimes(2);
  });

  it("never reads the pty-host for a terminal the store does not track", async () => {
    const fake = installPtyClient(async () => ({ lastOutputChangeAt: 1 }));

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: ["progress-untracked"], mode: "first" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );

    expect(res.results[0]!.trackingState).toBe("unknown");
    expect(res.results[0]).not.toHaveProperty("lastOutputChangeAt");
    expect(fake.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("attaches the reading to a single wait that timed out still working", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    installPtyClient(async () => ({ lastOutputChangeAt: 4_242 }));

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 20,
    });

    expect(result.timedOut).toBe(true);
    expect(result.busyState).toBe("working");
    expect(result.lastOutputChangeAt).toBe(4_242);
  });

  it("leaves the field absent when no change was observed or the record is gone", async () => {
    const unobserved = nextIds();
    const missing = nextIds();
    seedWorkingAgent(unobserved.terminalId, unobserved.agentId);
    seedWorkingAgent(missing.terminalId, missing.agentId);
    installPtyClient(async (id) => (id === missing.terminalId ? null : {}));

    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [unobserved.terminalId, missing.terminalId], mode: "first", timeoutMs: 20 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );

    expect(res.timedOut).toBe(true);
    for (const entry of res.results) expect(entry).not.toHaveProperty("lastOutputChangeAt");
  });

  it("returns the wait's answer without the field when the pty-host read stalls", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    installPtyClient(() => new Promise(() => {}));

    const started = Date.now();
    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 20,
    });

    expect(result.timedOut).toBe(true);
    expect(result).not.toHaveProperty("lastOutputChangeAt");
    // Bounded by the lookup ceiling, not by the host.
    expect(Date.now() - started).toBeLessThan(OUTPUT_PROGRESS_LOOKUP_TIMEOUT_MS + 2_000);
  });

  it("reads only the bound workspace's terminals, and routes nothing for the rest", async () => {
    const own = nextIds();
    const foreign = nextIds();
    const unplaced = nextIds();
    for (const ids of [own, foreign, unplaced]) seedWorkingAgent(ids.terminalId, ids.agentId);
    const fake = installPtyClient(async () => ({ lastOutputChangeAt: 7_000 }), {
      [own.terminalId]: "ws-a",
      [foreign.terminalId]: "ws-b",
    });

    const res = await handleWaitUntilIdleBatch(
      {
        terminalIds: [own.terminalId, foreign.terminalId, unplaced.terminalId],
        mode: "first",
        timeoutMs: 0,
      },
      new AbortController().signal,
      { maxTimeoutMs: 5_000, workspaceId: "ws-a" }
    );

    const byId = new Map(res.results.map((entry) => [entry.terminalId, entry]));
    expect(byId.get(own.terminalId)?.lastOutputChangeAt).toBe(7_000);
    // The wait still answers for the others exactly as before.
    expect(byId.get(foreign.terminalId)).toMatchObject({ trackingState: "tracked" });
    expect(byId.get(foreign.terminalId)).not.toHaveProperty("lastOutputChangeAt");
    expect(byId.get(unplaced.terminalId)).not.toHaveProperty("lastOutputChangeAt");
    expect(fake.getTerminalAsync.mock.calls.map(([id]) => id)).toEqual([own.terminalId]);
  });

  it("rejects as cancelled when the request is aborted during the read", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => (readStarted = resolve));
    installPtyClient(() => {
      readStarted();
      return new Promise(() => {});
    });
    const controller = new AbortController();

    const pending = handleWaitUntilIdle({ terminalId }, controller.signal, { maxTimeoutMs: 20 });
    await reading;
    controller.abort();

    // Without the abort this would resolve successfully at the lookup ceiling.
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/cancelled/) });
  });

  it("rejects as cancelled when the abort lands while the wait is settling", async () => {
    // The wait has already picked its answer when the abort arrives, so the
    // read's own listener would never fire; it must not report success.
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    const fake = installPtyClient(async () => ({ lastOutputChangeAt: 1 }));
    const controller = new AbortController();

    const pending = handleWaitUntilIdle({ terminalId }, controller.signal, {
      maxTimeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(terminalId, agentId);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/cancelled/) });
    expect(fake.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("keeps the wait's answer when the pty-host read fails", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    installPtyClient(async () => {
      throw new Error("host gone");
    });

    const pending = handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(terminalId, agentId);
    const result = await pending;

    expect(result).toMatchObject({ busyState: "idle", idleReason: "completed", timedOut: false });
    expect(result).not.toHaveProperty("lastOutputChangeAt");
  });
});

describe("lastHandback on wait results (#12488)", () => {
  afterEach(() => {
    setPtyClientRef(null);
  });

  type Handback = { message: string | null; observedAt: number; truncated: boolean };
  const installPtyClient = (
    getTerminalAsync: (
      id: string
    ) => Promise<{ lastOutputChangeAt?: number; lastHandback?: Handback } | null>
  ) => {
    const fake = {
      getTerminalAsync: vi.fn(getTerminalAsync),
      getTerminalProjectId: vi.fn(() => null),
    };
    setPtyClientRef(fake as unknown as PtyClient);
    return fake;
  };

  it("attaches the terminal's own handback to a single wait that settled", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    const handback = { message: "done", observedAt: 1_000, truncated: false };
    installPtyClient(async () => ({ lastOutputChangeAt: 900, lastHandback: handback }));

    const pending = handleWaitUntilIdle(
      { terminalId, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(terminalId, agentId);
    const result = await pending;

    expect(result).toMatchObject({
      busyState: "idle",
      lastOutputChangeAt: 900,
      lastHandback: handback,
    });
  });

  it("keeps each batched row's handback to its own terminal", async () => {
    const asked = nextIds();
    const other = nextIds();
    seedWorkingAgent(asked.terminalId, asked.agentId);
    seedWorkingAgent(other.terminalId, other.agentId);
    const handback = { message: null, observedAt: 2_000, truncated: false };
    installPtyClient(async (id) => (id === asked.terminalId ? { lastHandback: handback } : {}));

    const pending = handleWaitUntilIdleBatch(
      { terminalIds: [asked.terminalId, other.terminalId], mode: "all", timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    await new Promise((r) => setTimeout(r, 10));
    emitIdle(asked.terminalId, asked.agentId);
    emitIdle(other.terminalId, other.agentId);
    const res = await pending;

    const byId = new Map(res.results.map((entry) => [entry.terminalId, entry]));
    expect(byId.get(asked.terminalId)?.lastHandback).toEqual(handback);
    expect(byId.get(other.terminalId)).not.toHaveProperty("lastHandback");
  });

  it("leaves the field absent when the record holds no handback", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    installPtyClient(async () => ({ lastOutputChangeAt: 5 }));

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 20,
    });

    expect(result.lastOutputChangeAt).toBe(5);
    expect(result).not.toHaveProperty("lastHandback");
  });
});
