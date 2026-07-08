import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnalysisWorkerRuntime } from "../analysis/AnalysisWorkerRuntime.js";
import { ANALYSIS_ACK_FLUSH_BYTES } from "../analysis/AnalysisSession.js";
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

  function sendData(data: string, agentLive = false, epoch = 0): void {
    runtime.handleMessage({
      type: "data",
      terminalId: "t1",
      data,
      flags: { agentLive },
      epoch,
    });
  }

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
      epoch: 0,
    });
  });

  afterEach(() => {
    runtime.handleMessage({ type: "free", terminalId: "t1" });
  });

  it("serializes buffer content written via data messages", async () => {
    sendData("hello from the worker\r\n");
    runtime.handleMessage({
      type: "request",
      requestId: 1,
      terminalId: "t1",
      op: "serialize",
      generation: 1,
    });

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
    sendData("prompt-line-content\r\n");

    const digest = await waitFor(() => emitted.find((m) => m.type === "viewport"));
    if (digest.type === "viewport") {
      expect(digest.lines.some((line) => line.includes("prompt-line-content"))).toBe(true);
    }
  });

  it("acks parsed data bytes on the trailing batch timer, echoing the create epoch", async () => {
    const payload = "hello flow control\r\n";
    sendData(payload, false, 0);

    const ack = await waitFor(() => emitted.find((m) => m.type === "data-ack"));
    if (ack.type === "data-ack") {
      expect(ack.terminalId).toBe("t1");
      expect(ack.bytes).toBe(payload.length);
      expect(ack.epoch).toBe(0);
    }
  });

  it("stamps acks with the latest data epoch after a slot recreate", async () => {
    // A fresh-slot rebuild recreates the session with a bumped epoch; acks for
    // its data must carry the new epoch so the host doesn't discard them.
    runtime.handleMessage({
      type: "create",
      terminalId: "t1",
      cols: 80,
      rows: 24,
      scrollback: 1000,
      restore: false,
      spawnedAt: 4242,
      epoch: 7,
    });
    sendData("post-rebuild output\r\n", false, 7);

    const ack = await waitFor(() => emitted.find((m) => m.type === "data-ack"));
    if (ack.type === "data-ack") {
      expect(ack.epoch).toBe(7);
    }
  });

  it("flushes the ack batch once the byte threshold is crossed", async () => {
    const payload = "x".repeat(ANALYSIS_ACK_FLUSH_BYTES + 1024);
    sendData(payload);

    const ack = await waitFor(() => emitted.find((m) => m.type === "data-ack"));
    if (ack.type === "data-ack") {
      expect(ack.bytes).toBe(payload.length);
    }
  });

  it("serves a pending serialize before a free that arrives behind it", async () => {
    sendData("pre-kill content\r\n");
    // The kill path posts serialize-persistence then free back-to-back; the
    // request's async drain must act as an ordering barrier — the session may
    // only be disposed after the response has been produced.
    runtime.handleMessage({
      type: "request",
      requestId: 5,
      terminalId: "t1",
      op: "serialize-persistence",
      generation: 1,
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
    sendData("ordered content\r\n");
    runtime.handleMessage({
      type: "request",
      requestId: 11,
      terminalId: "t1",
      op: "serialize",
      generation: 1,
    });
    runtime.handleMessage({
      type: "request",
      requestId: 12,
      terminalId: "t1",
      op: "serialize",
      generation: 1,
    });
    runtime.handleMessage({ type: "free", terminalId: "t1" });

    await waitFor(() => emitted.find((m) => m.type === "response" && m.requestId === 12));
    const responseIds = emitted
      .filter((m) => m.type === "response")
      .map((m) => (m.type === "response" ? m.requestId : -1));
    expect(responseIds).toEqual([11, 12]);
    await waitFor(() => (runtime.sessionCount() === 0 ? true : undefined));
  });

  it("responds with an error result for requests against unknown terminals", async () => {
    runtime.handleMessage({
      type: "request",
      requestId: 9,
      terminalId: "nope",
      op: "serialize",
      generation: 1,
    });
    const response = emitted.find((m) => m.type === "response" && m.requestId === 9);
    expect(response).toBeDefined();
    if (response?.type === "response") {
      expect(response.result).toBeNull();
      expect(response.error).toBe("no-session");
    }
  });

  it("captures a final snapshot and frees the slot", async () => {
    sendData("final content\r\n");
    runtime.handleMessage({
      type: "request",
      requestId: 2,
      terminalId: "t1",
      op: "final-snapshot",
      generation: 1,
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

  describe("memory sampling", () => {
    it("reports isolate memory and real buffer occupancy that grows with output", async () => {
      // Freshly created 24-row terminal: the buffer holds only the viewport.
      const initial = runtime.collectMemorySample();
      expect(initial.sessionCount).toBe(1);
      expect(initial.sessions).toEqual([{ terminalId: "t1", bufferLines: 24, cols: 80 }]);
      expect(initial.heapUsedBytes).toBeGreaterThan(0);
      expect(initial.externalBytes).toBeGreaterThan(0);

      // 60 lines scroll ~36 rows past the viewport into scrollback — the
      // sample must report ACTUAL occupancy, not the 1000-line cap.
      for (let i = 0; i < 60; i++) sendData(`line ${i}\r\n`);
      const grown = await waitFor(() => {
        const s = runtime.collectMemorySample().sessions[0];
        return s.bufferLines >= 60 && s.bufferLines < 1000 ? s : undefined;
      });
      expect(grown.cols).toBe(80);
    });

    it("excludes freed sessions from the sample", () => {
      runtime.handleMessage({ type: "free", terminalId: "t1" });
      const sample = runtime.collectMemorySample();
      expect(sample.sessionCount).toBe(0);
      expect(sample.sessions).toEqual([]);
    });

    it("emits samples on the interval until stopped, using the injected reader", () => {
      vi.useFakeTimers();
      const timed: WorkerToHostMessage[] = [];
      const timedRuntime = new AnalysisWorkerRuntime(
        (msg) => timed.push(msg),
        () => ({ heapUsed: 7, external: 3 })
      );

      timedRuntime.startMemorySampling(2000);
      // Re-arming while running must not double the cadence.
      timedRuntime.startMemorySampling(2000);
      vi.advanceTimersByTime(6100);

      const samples = timed.filter((m) => m.type === "memory-sample");
      expect(samples).toHaveLength(3);
      if (samples[0].type === "memory-sample") {
        expect(samples[0].heapUsedBytes).toBe(7);
        expect(samples[0].externalBytes).toBe(3);
      }

      timedRuntime.stopMemorySampling();
      vi.advanceTimersByTime(6000);
      expect(timed.filter((m) => m.type === "memory-sample")).toHaveLength(3);
      vi.useRealTimers();
    });
  });
});
