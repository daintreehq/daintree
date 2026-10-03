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
  withPushFlushBarrier,
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

interface ManualBatcher {
  batcher: PluginPushBatcher;
  scheduled: Array<() => void>;
  /** Renderers per scope, read at flush time. `null` is the unbound scope. */
  scopes: Map<string | null, PluginPushTarget[]>;
  push: (
    target: FakeTarget,
    pluginId: string,
    channel: string,
    payload: unknown,
    bytes: number
  ) => void;
}

/**
 * A batcher whose scope resolver answers from `scopes`. `push` routes a
 * broadcast through a one-renderer scope named after that renderer, which
 * keeps the per-renderer ordering tests readable.
 */
function manualBatcher(
  options: { maxBatchSize?: number; maxBatchBytes?: number } = {}
): ManualBatcher {
  const scheduled: Array<() => void> = [];
  const scopes = new Map<string | null, PluginPushTarget[]>();
  const batcher = new PluginPushBatcher({
    schedule: (flush) => scheduled.push(flush),
    resolveScope: (projectId) => scopes.get(projectId) ?? [],
    ...options,
  });
  const push: ManualBatcher["push"] = (target, pluginId, channel, payload, bytes) => {
    const scope = `r${target.id}`;
    scopes.set(scope, [target]);
    batcher.enqueue({ pluginId, projectId: scope, channel, panelId: null, payload, bytes });
  };
  return { batcher, scheduled, scopes, push };
}

const env = (payload: unknown) => ({ panelId: null, payload });

describe("PluginPushBatcher", () => {
  it("coalesces one macrotask's pushes into a single ordered message per renderer", () => {
    const { scheduled, push } = manualBatcher();
    const a = fakeTarget(1);
    const b = fakeTarget(2);

    push(a, "p1", "plugin:p1:x", { n: 1 }, 1);
    push(b, "p1", "plugin:p1:x", { n: 1 }, 1);
    push(a, "p2", "plugin:p2:y", { n: 2 }, 1);
    push(a, "p1", "plugin:p1:x", { n: 3 }, 1);

    expect(scheduled).toHaveLength(1);
    expect(a.send).not.toHaveBeenCalled();
    scheduled[0]!();

    expect(batchesSentTo(a)).toEqual([
      [
        ["plugin:p1:x", env({ n: 1 })],
        ["plugin:p2:y", env({ n: 2 })],
        ["plugin:p1:x", env({ n: 3 })],
      ],
    ]);
    expect(batchesSentTo(b)).toEqual([[["plugin:p1:x", env({ n: 1 })]]]);
  });

  it("splits a flush over the batch cap into consecutive messages without dropping any", () => {
    const { scheduled, push } = manualBatcher({ maxBatchSize: 2 });
    const a = fakeTarget(1);
    for (let n = 0; n < 5; n++) push(a, "p", "plugin:p:c", n, 1);
    scheduled[0]!();

    const batches = batchesSentTo(a);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat().map((entry) => (entry[1] as { payload: number }).payload)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it("splits by bytes so a batch is never larger than one maximal push", () => {
    const { scheduled, push } = manualBatcher({ maxBatchBytes: 10 });
    const a = fakeTarget(1);
    for (const [n, bytes] of [
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 12],
      [4, 1],
    ] as const) {
      push(a, "p", "plugin:p:c", n, bytes);
    }
    scheduled[0]!();

    // 4+4 fits, +4 would not; an oversize single entry still goes alone.
    expect(
      batchesSentTo(a).map((batch) =>
        batch.map((entry) => (entry[1] as { payload: number }).payload)
      )
    ).toEqual([[0, 1], [2], [3], [4]]);
  });

  it("skips a renderer destroyed between enqueue and flush, and still serves the rest", () => {
    const { scheduled, push } = manualBatcher();
    const gone = fakeTarget(1);
    const live = fakeTarget(2);
    push(gone, "p", "plugin:p:c", 1, 1);
    push(live, "p", "plugin:p:c", 1, 1);
    gone.destroyed = true;
    scheduled[0]!();

    expect(gone.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledTimes(1);
  });

  it("contains a send that throws mid-teardown", () => {
    const { scheduled, push } = manualBatcher();
    const flaky = fakeTarget(1);
    const live = fakeTarget(2);
    flaky.send.mockImplementation(() => {
      flaky.destroyed = true;
      throw new Error("Render frame was disposed");
    });
    push(flaky, "p", "plugin:p:c", 1, 1);
    push(flaky, "p", "plugin:p:c", 2, 1);
    push(live, "p", "plugin:p:c", 1, 1);

    expect(() => scheduled[0]!()).not.toThrow();
    // Torn down: no per-entry retry against a dead renderer.
    expect(flaky.send).toHaveBeenCalledTimes(1);
    expect(live.send).toHaveBeenCalledTimes(1);
  });

  it("drops only the entry IPC cannot serialize, keeping the rest of the batch in order", () => {
    const { scheduled, push, batcher } = manualBatcher();
    const observer = vi.fn();
    batcher.setFlushObserver(observer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = fakeTarget(1);
    const delivered: unknown[] = [];
    a.send.mockImplementation((_channel, ...args) => {
      const batch = args[0] as PluginPushBatchEntry[];
      if (batch.some((entry) => (entry[1] as { payload: unknown }).payload === "poison")) {
        throw new Error("An object could not be cloned.");
      }
      for (const entry of batch) delivered.push((entry[1] as { payload: unknown }).payload);
    });
    try {
      push(a, "p1", "plugin:p1:c", 1, 1);
      push(a, "p2", "plugin:p2:c", "poison", 1);
      push(a, "p1", "plugin:p1:c", 3, 1);
      scheduled[0]!();
    } finally {
      warn.mockRestore();
    }
    expect(delivered).toEqual([1, 3]);
    expect(observer).toHaveBeenCalledWith("p1", 2, 2);
    expect(observer).not.toHaveBeenCalledWith("p2", expect.anything(), expect.anything());
  });

  it("schedules a fresh flush for pushes made after the previous one", () => {
    const { scheduled, push } = manualBatcher();
    const a = fakeTarget(1);
    push(a, "p", "plugin:p:c", 1, 1);
    scheduled[0]!();
    push(a, "p", "plugin:p:c", 2, 1);
    expect(scheduled).toHaveLength(2);
    scheduled[1]!();
    expect(batchesSentTo(a)).toEqual([[["plugin:p:c", env(1)]], [["plugin:p:c", env(2)]]]);
  });

  it("reports delivered messages and bytes per plugin to the flush observer", () => {
    const { batcher, scheduled, push } = manualBatcher();
    const observer = vi.fn();
    batcher.setFlushObserver(observer);
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    const gone = fakeTarget(3);
    push(a, "p1", "plugin:p1:c", 1, 10);
    push(b, "p1", "plugin:p1:c", 1, 10);
    push(a, "p2", "plugin:p2:c", 1, 5);
    push(gone, "p2", "plugin:p2:c", 1, 99);
    gone.destroyed = true;
    scheduled[0]!();

    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledWith("p1", 2, 20);
    expect(observer).toHaveBeenCalledWith("p2", 1, 5);
  });

  it("never lets a throwing observer affect delivery", () => {
    const { batcher, scheduled, push } = manualBatcher();
    batcher.setFlushObserver(() => {
      throw new Error("metrics broke");
    });
    const a = fakeTarget(1);
    push(a, "p", "plugin:p:c", 1, 1);
    expect(() => scheduled[0]!()).not.toThrow();
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("flushes on the next macrotask by default", async () => {
    const a = fakeTarget(1);
    const batcher = new PluginPushBatcher({ resolveScope: () => [a] });
    batcher.enqueue({
      pluginId: "p",
      projectId: null,
      channel: "plugin:p:c",
      panelId: null,
      payload: 1,
      bytes: 1,
    });
    await Promise.resolve();
    expect(a.send).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("resolves recipients at flush time, following a renderer swapped in before the flush", () => {
    const { batcher, scheduled, scopes } = manualBatcher();
    const before = fakeTarget(1);
    const after = fakeTarget(2);
    scopes.set("proj-a", [before]);
    batcher.enqueue({
      pluginId: "p",
      projectId: "proj-a",
      channel: "plugin:p:c",
      panelId: null,
      payload: 1,
      bytes: 1,
    });
    // The project's view was replaced (reload / re-creation) before the flush.
    scopes.set("proj-a", [after]);
    scheduled[0]!();
    expect(before.send).not.toHaveBeenCalled();
    expect(after.send).toHaveBeenCalledTimes(1);
  });

  it("locates a targeted panel at flush time, following a panel that moved renderer", () => {
    const { batcher, scheduled, scopes } = manualBatcher();
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    scopes.set("proj-a", [a, b]);
    let holder = 1;
    batcher.enqueue({
      pluginId: "p",
      projectId: "proj-a",
      channel: "plugin:p:c",
      panelId: "panel-1",
      payload: 1,
      bytes: 1,
      locatePanel: () => [holder],
    });
    holder = 2;
    scheduled[0]!();
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).toHaveBeenCalledTimes(1);
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

    expect(utilsMock.getProjectRendererTargets).toHaveBeenCalledWith("proj-a");
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("drops a push to a panel the broker knows is closed", () => {
    const a = fakeTarget(1);
    const b = fakeTarget(2);
    utilsMock.getProjectRendererTargets.mockReturnValue([a, b]);

    route({ panelId: "panel-1", locatePanel: () => "closed" });

    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
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
    expect(getPluginPushBatcher().pendingCount()).toBe(0);
    expect(locatePanel).not.toHaveBeenCalled();
  });
});

describe("withPushFlushBarrier", () => {
  beforeEach(() => {
    resetPluginPushBatcherForTests();
    utilsMock.getProjectRendererTargets.mockReset();
  });

  it("delivers queued pushes before any direct delivery through the wrapped collaborator", () => {
    const order: string[] = [];
    const a = fakeTarget(1);
    a.send.mockImplementation(() => order.push("push"));
    utilsMock.getProjectRendererTargets.mockReturnValue([a]);
    class Dispatcher {
      #sent = 0;
      reload(panelId: string): number {
        order.push(`reload:${panelId}`);
        return ++this.#sent;
      }
    }
    const dispatcher = withPushFlushBarrier(new Dispatcher());

    routePluginPush({
      pluginId: "acme.demo",
      projectId: null,
      channel: "plugin:acme.demo:tick",
      panelId: null,
      payload: 1,
      bytes: 1,
    });
    // Private fields still work through the wrapper: methods run on the target.
    expect(dispatcher.reload("panel-1")).toBe(1);
    expect(order).toEqual(["push", "reload:panel-1"]);
  });
});
