import { describe, expect, it, vi } from "vitest";
import { ConsoleObservationHub } from "../ConsoleObservationHub.js";

describe("ConsoleObservationHub", () => {
  it("creates an atomic watermark and sequences every later chunk exactly once", () => {
    const emit = vi.fn();
    const hub = new ConsoleObservationHub(emit);
    hub.onData("panel-1", 4, "before");
    const barrier = hub.begin("panel-1", 4, "observer-1");
    hub.onData("panel-1", 4, "during");
    hub.onData("panel-1", 4, "after");

    expect(barrier).toMatchObject({ mode: "snapshot", throughSeq: 0 });
    expect(emit.mock.calls.map(([, , , event]) => ({ seq: event.seq, data: event.data }))).toEqual([
      { seq: 1, data: Buffer.from("during").toString("base64") },
      { seq: 2, data: Buffer.from("after").toString("base64") },
    ]);
  });

  it("resumes from contiguous retained history or requires resync after a gap", () => {
    const hub = new ConsoleObservationHub(vi.fn(), { maxHistoryBytes: 10 });
    hub.begin("panel-1", 1, "first");
    hub.onData("panel-1", 1, "12345");
    hub.onData("panel-1", 1, "67890");
    hub.onData("panel-1", 1, "abcde");
    hub.end("panel-1", "first");

    expect(hub.begin("panel-1", 1, "resume", 1)).toMatchObject({
      mode: "resume",
      throughSeq: 3,
      chunks: [expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 3 })],
    });
    expect(hub.begin("panel-1", 1, "gap", 0)).toEqual({
      mode: "resync",
      reason: "gap",
      throughSeq: 3,
      chunks: [],
    });
  });

  it("invalidates old observers and resets sequence on generation replacement", () => {
    const emit = vi.fn();
    const hub = new ConsoleObservationHub(emit);
    hub.begin("panel-1", 1, "old");
    hub.onData("panel-1", 1, "old data");

    const replacement = hub.begin("panel-1", 2, "new");

    expect(emit).toHaveBeenCalledWith("panel-1", 1, "old", {
      type: "invalidated",
      reason: "generation-changed",
    });
    expect(replacement).toMatchObject({ mode: "snapshot", throughSeq: 0 });
  });

  it("splits high-throughput output and bounds retained bytes", () => {
    const emit = vi.fn();
    const hub = new ConsoleObservationHub(emit, { maxChunkBytes: 4, maxHistoryBytes: 8 });
    hub.begin("panel-1", 1, "observer");
    hub.onData("panel-1", 1, "abcdefghijkl");

    expect(emit).toHaveBeenCalledTimes(3);
    expect(hub.diagnostics("panel-1")).toMatchObject({ historyBytes: 8, historyFrames: 2 });
  });

  it("tears down observers and terminal history explicitly", () => {
    const emit = vi.fn();
    const hub = new ConsoleObservationHub(emit);
    hub.begin("panel-1", 1, "observer");
    hub.end("panel-1", "observer");
    hub.onData("panel-1", 1, "retained but not emitted");
    expect(emit).not.toHaveBeenCalled();
    hub.removeTerminal("panel-1", "host-restarted");
    expect(hub.diagnostics("panel-1")).toBeNull();
  });
});
