import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AnalysisWorkerRuntime } from "../analysis/AnalysisWorkerRuntime.js";
import type { WorkerToHostMessage } from "../analysisWorkerProtocol.js";

// Exercises the worker-side protocol end-to-end without spawning a real
// worker thread: the runtime + AnalysisSession (headless xterm, monitor) run
// in-process, exactly as they do inside the worker.

function waitFor<T>(check: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = check();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("AnalysisWorkerRuntime", () => {
  let emitted: WorkerToHostMessage[];
  let runtime: AnalysisWorkerRuntime;

  beforeEach(() => {
    emitted = [];
    runtime = new AnalysisWorkerRuntime((msg) => emitted.push(msg));
    runtime.handleMessage({
      type: "create",
      terminalId: "t1",
      cols: 80,
      rows: 24,
      scrollback: 1000,
      restore: false,
      spawnedAt: 4242,
    });
  });

  afterEach(() => {
    runtime.handleMessage({ type: "free", terminalId: "t1" });
  });

  it("serializes buffer content written via data messages", async () => {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data: "hello from the worker\r\n",
      flags: { agentLive: false },
    });
    runtime.handleMessage({ type: "request", requestId: 1, terminalId: "t1", op: "serialize" });

    const response = await waitFor(() =>
      emitted.find((m) => m.type === "response" && m.requestId === 1)
    );
    expect(response.type).toBe("response");
    if (response.type === "response") {
      expect(typeof response.result).toBe("string");
      expect(response.result).toContain("hello from the worker");
    }
  });

  it("emits activity-state transitions from the monitor with the session spawnedAt", async () => {
    runtime.handleMessage({
      type: "monitor-start",
      terminalId: "t1",
      agentId: "claude",
      initialState: "idle",
      skipInitialStateEmit: true,
      hasProcessValidator: false,
    });
    runtime.handleMessage({ type: "submission", terminalId: "t1" });

    const busy = await waitFor(() =>
      emitted.find((m) => m.type === "activity-state" && m.state === "busy")
    );
    if (busy.type === "activity-state") {
      expect(busy.terminalId).toBe("t1");
      expect(busy.spawnedAt).toBe(4242);
      expect(busy.metadata?.trigger).toBe("input");
    }
  });

  it("pushes a throttled viewport digest after output lands", async () => {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data: "prompt-line-content\r\n",
      flags: { agentLive: false },
    });

    const digest = await waitFor(() => emitted.find((m) => m.type === "viewport"));
    if (digest.type === "viewport") {
      expect(digest.lines.some((line) => line.includes("prompt-line-content"))).toBe(true);
    }
  });

  it("serves a pending serialize before a free that arrives behind it", async () => {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data: "pre-kill content\r\n",
      flags: { agentLive: false },
    });
    // The kill path posts serialize-persistence then free back-to-back; the
    // request's async drain must act as an ordering barrier — the session may
    // only be disposed after the response has been produced.
    runtime.handleMessage({
      type: "request",
      requestId: 5,
      terminalId: "t1",
      op: "serialize-persistence",
    });
    runtime.handleMessage({ type: "free", terminalId: "t1" });

    const response = await waitFor(() =>
      emitted.find((m) => m.type === "response" && m.requestId === 5)
    );
    if (response.type === "response") {
      expect(response.error).toBeUndefined();
      expect(typeof response.result).toBe("string");
      expect(response.result).toContain("pre-kill content");
    }

    // The deferred free still runs once the barrier clears.
    await waitFor(() => (runtime.sessionCount() === 0 ? true : undefined));
  });

  it("keeps a chained request behind an earlier one on the same terminal", async () => {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data: "ordered content\r\n",
      flags: { agentLive: false },
    });
    runtime.handleMessage({ type: "request", requestId: 11, terminalId: "t1", op: "serialize" });
    runtime.handleMessage({ type: "request", requestId: 12, terminalId: "t1", op: "serialize" });
    runtime.handleMessage({ type: "free", terminalId: "t1" });

    await waitFor(() => emitted.find((m) => m.type === "response" && m.requestId === 12));
    const responseIds = emitted
      .filter((m) => m.type === "response")
      .map((m) => (m.type === "response" ? m.requestId : -1));
    expect(responseIds).toEqual([11, 12]);
    await waitFor(() => (runtime.sessionCount() === 0 ? true : undefined));
  });

  it("responds with an error result for requests against unknown terminals", async () => {
    runtime.handleMessage({ type: "request", requestId: 9, terminalId: "nope", op: "serialize" });
    const response = emitted.find((m) => m.type === "response" && m.requestId === 9);
    expect(response).toBeDefined();
    if (response?.type === "response") {
      expect(response.result).toBeNull();
      expect(response.error).toBe("no-session");
    }
  });

  it("captures a final snapshot and frees the slot", async () => {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data: "final content\r\n",
      flags: { agentLive: false },
    });
    runtime.handleMessage({
      type: "request",
      requestId: 2,
      terminalId: "t1",
      op: "final-snapshot",
    });

    const response = await waitFor(() =>
      emitted.find((m) => m.type === "response" && m.requestId === 2)
    );
    if (response.type === "response") {
      expect(response.result).not.toBeNull();
      expect(typeof response.result).toBe("object");
      const result = response.result as { snapshot: string | null; persistence: string | null };
      expect(result.snapshot).toContain("final content");
      // No restore banner → persistence equals the plain serialize.
      expect(result.persistence).toContain("final content");
    }

    expect(runtime.sessionCount()).toBe(1);
    runtime.handleMessage({ type: "free", terminalId: "t1" });
    expect(runtime.sessionCount()).toBe(0);
  });
});
