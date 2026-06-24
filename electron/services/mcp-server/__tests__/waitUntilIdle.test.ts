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

  it("settles a mapped-but-stateless terminal immediately instead of waiting (mode 'all')", async () => {
    // agent:spawned with no following state-changed leaves getState() undefined.
    // The batch must treat that as already-idle (mirrors the single handler), or
    // 'all' mode would hang on it until timeout.
    const { terminalId, agentId } = nextIds();
    getAgentAvailabilityStore();
    events.emit("agent:spawned", { agentId, terminalId, timestamp: Date.now() });

    const started = Date.now();
    const res = await handleWaitUntilIdleBatch(
      { terminalIds: [terminalId], mode: "all" },
      new AbortController().signal,
      { maxTimeoutMs: 5_000 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.timedOut).toBe(false);
    expect(res.settledTerminalIds).toEqual([terminalId]);
    expect(res.results[0]!.busyState).toBe("idle");
    expect(res.results[0]!.settled).toBe(true);
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
