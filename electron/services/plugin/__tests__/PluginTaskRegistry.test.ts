import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  PLUGIN_TASK_MAX_INTERRUPTED,
  PLUGIN_TASK_MAX_LIVE,
} from "../../../../shared/types/plugin.js";
import { PluginTaskRegistry, type PluginTaskStartInput } from "../PluginTaskRegistry.js";

const WINDOW = 150;

function input(overrides: Partial<PluginTaskStartInput> = {}): PluginTaskStartInput {
  return {
    pluginName: "Acme",
    title: "Importing records",
    cancellable: true,
    fraction: null,
    retry: { actionId: "acme.import" },
    ...overrides,
  };
}

describe("PluginTaskRegistry", () => {
  let publish: Mock<(pluginId: string) => void>;
  let registry: PluginTaskRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    publish = vi.fn<(pluginId: string) => void>();
    registry = new PluginTaskRegistry(publish, WINDOW, () => 1000);
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("publishes a start at once with the task the views draw", () => {
    const record = registry.start("acme", input({ detail: "0 of 10" }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("acme")).toEqual([
      {
        id: record.snapshot.id,
        pluginId: "acme",
        pluginName: "Acme",
        title: "Importing records",
        detail: "0 of 10",
        fraction: null,
        cancellable: true,
        state: "working",
        startedAt: 1000,
      },
    ]);
  });

  it("caps unfinished tasks per plugin, not interrupted ones or other plugins'", () => {
    for (let i = 0; i < PLUGIN_TASK_MAX_LIVE; i++) registry.start("acme", input());
    expect(() => registry.start("acme", input())).toThrow(/unfinished tasks/);
    expect(() => registry.start("other", input())).not.toThrow();
    registry.interrupt("acme");
    expect(registry.liveCount("acme")).toBe(0);
    expect(() => registry.start("acme", input())).not.toThrow();
  });

  it("publishes progress once per fixed window, however often it is reported", () => {
    const record = registry.start("acme", input());
    publish.mockClear();
    for (let tick = 0; tick < 10; tick++) {
      registry.report(record, { fraction: tick / 100 });
      vi.advanceTimersByTime(WINDOW / 3);
    }
    // ~3.3 windows of continuous reports: a re-arming timer would publish none.
    expect(publish.mock.calls.length).toBe(3);
    vi.advanceTimersByTime(WINDOW);
    expect(publish.mock.calls.length).toBe(4);
    expect(registry.snapshot("acme")[0]?.fraction).toBe(0.09);
  });

  it("publishes nothing for a report that changes nothing", () => {
    const record = registry.start("acme", input({ detail: "a", fraction: 0.5 }));
    publish.mockClear();
    registry.report(record, { fraction: 0.5, detail: "a" });
    vi.advanceTimersByTime(WINDOW);
    expect(publish).not.toHaveBeenCalled();
    registry.report(record, { detail: "" });
    vi.advanceTimersByTime(WINDOW);
    expect(registry.snapshot("acme")[0]).not.toHaveProperty("detail");
  });

  it("sends a finish at once and drops the progress still waiting, so it can't land after", () => {
    const record = registry.start("acme", input());
    registry.report(record, { fraction: 0.4 });
    publish.mockClear();
    expect(registry.finish(record)).toEqual({
      title: "Importing records",
      retry: { actionId: "acme.import" },
      cancelRequested: false,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("acme")).toEqual([]);
    vi.advanceTimersByTime(WINDOW * 2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("counts only the first finish", () => {
    const record = registry.start("acme", input());
    expect(registry.finish(record)).not.toBeNull();
    expect(registry.finish(record)).toBeNull();
    registry.report(record, { fraction: 1 });
    expect(registry.snapshot("acme")).toEqual([]);
  });

  it("marks a cancel before aborting, so a finish from the abort listener knows it was asked", () => {
    const record = registry.start("acme", input());
    let claim: ReturnType<PluginTaskRegistry["finish"]> = null;
    let stateSeenByListener: string | undefined;
    record.controller.signal.addEventListener("abort", () => {
      stateSeenByListener = registry.snapshot("acme")[0]?.state;
      claim = registry.finish(record);
    });
    expect(registry.requestCancel("acme", record.snapshot.id)).toBe(true);
    expect(stateSeenByListener).toBe("cancelling");
    expect(claim).toMatchObject({ cancelRequested: true });
    expect(registry.requestCancel("acme", record.snapshot.id)).toBe(false);
  });

  it("refuses a cancel the task never offered, or for a task that isn't there", () => {
    const record = registry.start("acme", input({ cancellable: false }));
    expect(registry.requestCancel("acme", record.snapshot.id)).toBe(false);
    expect(record.controller.signal.aborted).toBe(false);
    expect(registry.requestCancel("acme", "nope")).toBe(false);
    expect(registry.requestCancel("other", record.snapshot.id)).toBe(false);
  });

  it("interrupts unfinished tasks, keeps them for the user, and ignores their old handles", () => {
    const record = registry.start("acme", input());
    let finishedFromListener: ReturnType<PluginTaskRegistry["finish"]> | undefined;
    record.controller.signal.addEventListener("abort", () => {
      finishedFromListener = registry.finish(record);
    });
    registry.interrupt("acme");
    expect(record.controller.signal.aborted).toBe(true);
    expect(finishedFromListener).toBeNull();
    expect(registry.snapshot("acme")).toMatchObject([
      { id: record.snapshot.id, state: "interrupted" },
    ]);
    registry.report(record, { fraction: 0.9 });
    vi.advanceTimersByTime(WINDOW);
    expect(registry.snapshot("acme")[0]?.fraction).toBeNull();
    expect(registry.pluginIds()).toEqual(["acme"]);
    expect(registry.requestCancel("acme", record.snapshot.id)).toBe(false);
  });

  it("keeps at most the newest interrupted tasks per plugin", () => {
    const ids: string[] = [];
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < PLUGIN_TASK_MAX_LIVE; i++) {
        ids.push(registry.start("acme", input({ title: `T${ids.length}` })).snapshot.id);
      }
      registry.interrupt("acme");
    }
    const kept = registry.snapshot("acme").map((task) => task.id);
    expect(kept).toEqual(ids.slice(-PLUGIN_TASK_MAX_INTERRUPTED));
  });

  it("dismisses only an interrupted task", () => {
    const live = registry.start("acme", input());
    expect(registry.dismiss("acme", live.snapshot.id)).toBe(false);
    registry.interrupt("acme");
    expect(registry.dismiss("acme", live.snapshot.id)).toBe(true);
    expect(registry.snapshot("acme")).toEqual([]);
    expect(registry.pluginIds()).toEqual([]);
  });

  it("does nothing for a plugin with nothing to interrupt", () => {
    registry.interrupt("acme");
    const record = registry.start("acme", input());
    registry.finish(record);
    publish.mockClear();
    registry.interrupt("acme");
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes nothing once disposed, and aborts what was still running", () => {
    const record = registry.start("acme", input());
    registry.report(record, { fraction: 0.2 });
    publish.mockClear();
    registry.dispose();
    vi.advanceTimersByTime(WINDOW);
    expect(publish).not.toHaveBeenCalled();
    expect(record.controller.signal.aborted).toBe(true);
    expect(() => registry.start("acme", input())).toThrow(/disposed/);
  });
});
