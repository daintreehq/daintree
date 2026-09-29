import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const utilsMock = vi.hoisted(() => ({
  getProjectRendererTargets: vi.fn((_projectId: string | null): unknown[] => []),
}));
vi.mock("../../../ipc/utils.js", () => utilsMock);

import {
  PluginPushBatcher,
  getPluginPushBatcher,
  resetPluginPushBatcherForTests,
  routePluginPush,
  type PluginPushTarget,
} from "../pluginPushBatcher.js";
import { PLUGIN_PUSH_BATCH_CHANNEL, type PluginPushBatchEntry } from "../pluginPushProtocol.js";

interface FakeTarget extends PluginPushTarget {
  send: Mock<(channel: string, ...args: unknown[]) => void>;
  destroyed: boolean;
}

function fakeTarget(id: number): FakeTarget {
  const target: FakeTarget = {
    id,
    destroyed: false,
    isDestroyed: () => target.destroyed,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  };
  return target;
}

function batchesSentTo(target: FakeTarget): PluginPushBatchEntry[][] {
  return target.send.mock.calls.map((call) => {
    expect(call[0]).toBe(PLUGIN_PUSH_BATCH_CHANNEL);
    return call[1] as PluginPushBatchEntry[];
  });
}

function manualBatcher(maxBatchSize?: number): {
  batcher: PluginPushBatcher;
  scheduled: Array<() => void>;
} {
  const scheduled: Array<() => void> = [];
  const batcher = new PluginPushBatcher({
    schedule: (flush) => scheduled.push(flush),
    ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
  });
  return { batcher, scheduled };
}

describe("PluginPushBatcher", () => {
  it("coalesces one macrotask's pushes into a single ordered message per renderer", () => {
    const { batcher, scheduled } = manualBatcher();
    const a = fakeTarget(1);
    const b = fakeTarget(2);

    batcher.enqueue(a, "p1", "plugin:p1:x", { n: 1 }, 1);
    batcher.enqueue(b, "p1", "plugin:p1:x", { n: 1 }, 1);
    batcher.enqueue(a, "p2", "plugin:p2:y", { n: 2 }, 1);
    batcher.enqueue(a, "p1", "plugin:p1:x", { n: 3 }, 1);

    expect(scheduled).toHaveLength(1);
    expect(a.send).not.toHaveBeenCalled();
    scheduled[0]!();

    expect(batchesSentTo(a)).toEqual([
      [
        ["plugin:p1:x", { n: 1 }],
        ["plugin:p2:y", { n: 2 }],
        ["plugin:p1:x", { n: 3 }],
      ],
    ]);
    expect(batchesSentTo(b)).toEqual([[["plugin:p1:x", { n: 1 }]]]);
  });

  it("splits a flush over the batch cap into consecutive messages without dropping any", () => {
    const { batcher, scheduled } = manualBatcher(2);
    const a = fakeTarget(1);
    for (let n = 0; n < 5; n++) batcher.enqueue(a, "p", "plugin:p:c", n, 1);
    scheduled[0]!();

    const batches = batchesSentTo(a);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat().map((entry) => entry[1])).toEqual([0, 1, 2, 3, 4]);
  });

  it("splits by bytes so a batch is never larger than one maximal push", () => {
    const scheduled: Array<() => void> = [];
    const batcher = new PluginPushBatcher({
      schedule: (flush) => scheduled.push(flush),
      maxBatchBytes: 10,
    });
    const a = fakeTarget(1);
    for (const [n, bytes] of [
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 12],
      [4, 1],
    ] as const) {
      batcher.enqueue(a, "p", "plugin:p:c", n, bytes);
    }
    scheduled[0]!();

    // 4+4 fits, +4 would not; an oversize single entry still goes alone.
    expect(batchesSentTo(a).map((batch) => batch.map((entry) => entry[1]))).toEqual([
      [0, 1],
      [2],
      [3],
      [4],
    ]);
  });

  it("skips a renderer destroyed between enqueue and flush, and still serves the rest", () => {
    const { batcher, scheduled } = manualBatcher();
    const gone = fakeTarget(1);
    const live = fakeTarget(2);
    batcher.enqueue(gone, "p", "plugin:p:c", 1, 1);
    batcher.enqueue(live, "p", "plugin:p:c", 1, 1);
    gone.destroyed = true;
    scheduled[0]!();

    expect(gone.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledTimes(1);
  });

  it("contains a send that throws mid-teardown", () => {
    const { batcher, scheduled } = manualBatcher();
    const flaky = fakeTarget(1);
    const live = fakeTarget(2);
    flaky.send.mockImplementation(() => {
      throw new Error("Render frame was disposed");
    });
    batcher.enqueue(flaky, "p", "plugin:p:c", 1, 1);
    batcher.enqueue(live, "p", "plugin:p:c", 1, 1);

    expect(() => scheduled[0]!()).not.toThrow();
    expect(live.send).toHaveBeenCalledTimes(1);
  });

  it("schedules a fresh flush for pushes made after the previous one", () => {
    const { batcher, scheduled } = manualBatcher();
    const a = fakeTarget(1);
    batcher.enqueue(a, "p", "plugin:p:c", 1, 1);
    scheduled[0]!();
    batcher.enqueue(a, "p", "plugin:p:c", 2, 1);
    expect(scheduled).toHaveLength(2);
    scheduled[1]!();
    expect(batchesSentTo(a)).toEqual([[["plugin:p:c", 1]], [["plugin:p:c", 2]]]);
  });

  it("reports delivered messages and bytes per plugin to the flush observer", () => {
    const { batcher, scheduled } = manualBatcher();
    const observer = vi.fn();
    batcher.setFlushObserver(observer);
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    const gone = fakeTarget(3);
    batcher.enqueue(a, "p1", "plugin:p1:c", 1, 10);
    batcher.enqueue(b, "p1", "plugin:p1:c", 1, 10);
    batcher.enqueue(a, "p2", "plugin:p2:c", 1, 5);
    batcher.enqueue(gone, "p2", "plugin:p2:c", 1, 99);
    gone.destroyed = true;
    scheduled[0]!();

    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledWith("p1", 2, 20);
    expect(observer).toHaveBeenCalledWith("p2", 1, 5);
  });

  it("never lets a throwing observer affect delivery", () => {
    const { batcher, scheduled } = manualBatcher();
    batcher.setFlushObserver(() => {
      throw new Error("metrics broke");
    });
    const a = fakeTarget(1);
    batcher.enqueue(a, "p", "plugin:p:c", 1, 1);
    expect(() => scheduled[0]!()).not.toThrow();
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("flushes on the next macrotask by default", async () => {
    const batcher = new PluginPushBatcher();
    const a = fakeTarget(1);
    batcher.enqueue(a, "p", "plugin:p:c", 1, 1);
    await Promise.resolve();
    expect(a.send).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.send).toHaveBeenCalledTimes(1);
  });
});

describe("routePluginPush", () => {
  beforeEach(() => {
    resetPluginPushBatcherForTests();
    utilsMock.getProjectRendererTargets.mockReset();
  });

  function route(overrides: Partial<Parameters<typeof routePluginPush>[0]> = {}): void {
    routePluginPush({
      pluginId: "acme.demo",
      projectId: "proj-a",
      channel: "plugin:acme.demo:tick",
      panelId: null,
      payload: { n: 1 },
      bytes: 1,
      ...overrides,
    });
    getPluginPushBatcher().flush();
  }

  it("scopes to the binding's renderers and wraps the panel envelope", () => {
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    utilsMock.getProjectRendererTargets.mockReturnValue([a, b]);

    route();

    expect(utilsMock.getProjectRendererTargets).toHaveBeenCalledWith("proj-a");
    for (const target of [a, b]) {
      expect(batchesSentTo(target)).toEqual([
        [["plugin:acme.demo:tick", { panelId: null, payload: { n: 1 } }]],
      ]);
    }
  });

  it("delivers a targeted push only to the renderer holding the panel", () => {
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    utilsMock.getProjectRendererTargets.mockReturnValue([a, b]);
    const locatePanel = vi.fn(() => [2]);

    route({ panelId: "panel-1", locatePanel });

    expect(locatePanel).toHaveBeenCalledWith("panel-1", "acme.demo");
    expect(a.send).not.toHaveBeenCalled();
    expect(batchesSentTo(b)).toEqual([
      [["plugin:acme.demo:tick", { panelId: "panel-1", payload: { n: 1 } }]],
    ]);
  });

  it("falls back to the full scope while the panel is not located yet", () => {
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    utilsMock.getProjectRendererTargets.mockReturnValue([a, b]);

    route({ panelId: "panel-1", locatePanel: () => [] });

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("never narrows outside the binding's scope", () => {
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    utilsMock.getProjectRendererTargets.mockReturnValue([a, b]);

    // The only holder is a renderer of another project: keep today's scope
    // rather than reaching it.
    route({ panelId: "panel-1", locatePanel: () => [99] });

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no renderer is in scope", () => {
    utilsMock.getProjectRendererTargets.mockReturnValue([]);
    const locatePanel = vi.fn(() => [1]);
    route({ panelId: "panel-1", locatePanel });
    expect(getPluginPushBatcher().pendingDestinationCount()).toBe(0);
  });
});
