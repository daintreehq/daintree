import { describe, it, expect } from "vitest";
import { handleWaitUntilIdle } from "../waitUntilIdle.js";
import { events } from "../../events.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import type { WaitUntilIdleResult } from "../../../../shared/types/terminalWaitUntilIdle.js";

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
