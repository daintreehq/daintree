import { describe, it, expect } from "vitest";
import { handleWaitUntilIdle, handleWaitUntilIdleBatch } from "../waitUntilIdle.js";
import { events } from "../../events.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
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
    expect(store.getState(agentId)).toBe("waiting");

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
    expect(store.getState(agentId)).toBe("exited");
    expect(store.getExitCode(agentId)).toBeUndefined();

    const result = await handleWaitUntilIdle({ terminalId }, new AbortController().signal);
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("exited");
    expect(result).not.toHaveProperty("exitCode");
  });
});

describe("handleWaitUntilIdle terminal closed by the user", () => {
  it("settles as closed the moment a watched terminal is trashed, not after its TTL", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);

    const p = handleWaitUntilIdle({ terminalId, timeoutMs: 10_000 }, new AbortController().signal, {
      maxTimeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    events.emit("terminal:trashed", { id: terminalId, expiresAt: Date.now() + 20_000 });

    const result = await p;
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("closed");
    expect(result).not.toHaveProperty("exitCode");
  });

  it("settles as closed immediately when the terminal was already trashed before the call", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    events.emit("terminal:trashed", { id: terminalId, expiresAt: Date.now() + 20_000 });

    const started = Date.now();
    const result = await handleWaitUntilIdle(
      { terminalId, timeoutMs: 10_000 },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.timedOut).toBe(false);
    expect(result.busyState).toBe("idle");
    expect(result.idleReason).toBe("closed");
  });

  it("reports the same lastTransitionAt across repeated calls during one trash TTL", async () => {
    const { terminalId, agentId } = nextIds();
    seedWorkingAgent(terminalId, agentId);
    events.emit("terminal:trashed", { id: terminalId, expiresAt: Date.now() + 20_000 });

    const first = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 15));
    const second = await handleWaitUntilIdle({ terminalId }, new AbortController().signal, {
      maxTimeoutMs: 5_000,
    });

    expect(first.lastTransitionAt).toBeDefined();
    expect(second.lastTransitionAt).toBe(first.lastTransitionAt);
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

  it("settles a terminal the user closes mid-wait as closed, without blocking the rest of the batch", async () => {
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
    // The user closes terminal A — must NOT wait out its trash TTL to notice.
    events.emit("terminal:trashed", { id: a.terminalId, expiresAt: Date.now() + 20_000 });

    const stillPending = await Promise.race([
      p.then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 60)),
    ]);
    expect(stillPending).toBe("pending");

    emitIdle(b.terminalId, b.agentId);
    const res = await p;
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toHaveLength(2);
    const aEntry = res.results.find((e) => e.terminalId === a.terminalId)!;
    expect(aEntry.settled).toBe(true);
    expect(aEntry.busyState).toBe("idle");
    expect(aEntry.idleReason).toBe("closed");
    expect(aEntry.previousBusyState).toBe("working");
  });

  it("seeds an already-trashed terminal as closed at call start", async () => {
    const a = nextIds();
    seedWorkingAgent(a.terminalId, a.agentId);
    events.emit("terminal:trashed", { id: a.terminalId, expiresAt: Date.now() + 20_000 });

    const started = Date.now();
    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [a.terminalId], mode: "all" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.timedOut).toBe(false);
    expect(res.results[0]!.idleReason).toBe("closed");
    expect(res.results[0]!.settled).toBe(true);
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
