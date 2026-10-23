// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTaskSnapshot } from "@shared/types/plugin";
import {
  _resetPluginTaskStoreForTest,
  isLivePluginTask,
  usePluginTaskStore,
} from "../pluginTaskStore";

type Payload = { pluginId: string; tasks: PluginTaskSnapshot[] };

let push: ((payload: Payload) => void) | null = null;
const unsubscribe = vi.fn();
const onTasksChanged = vi.fn((cb: (payload: Payload) => void) => {
  push = cb;
  return unsubscribe;
});

function installBridge(): void {
  Reflect.set(window, "electron", { plugin: { onTasksChanged } });
}

function task(id: string, pluginId: string, startedAt: number): PluginTaskSnapshot {
  return {
    id,
    pluginId,
    pluginName: pluginId,
    title: id,
    fraction: null,
    cancellable: false,
    state: "working",
    startedAt,
  };
}

const store = () => usePluginTaskStore.getState();

beforeEach(() => {
  _resetPluginTaskStoreForTest();
  push = null;
  unsubscribe.mockClear();
  onTasksChanged.mockClear();
  installBridge();
  store().init();
});

afterEach(() => {
  _resetPluginTaskStoreForTest();
  Reflect.deleteProperty(window, "electron");
});

describe("pluginTaskStore", () => {
  it("merges every plugin's complete list, oldest first", () => {
    push!({ pluginId: "acme", tasks: [task("a1", "acme", 30)] });
    push!({ pluginId: "other", tasks: [task("o1", "other", 10), task("o2", "other", 40)] });

    expect(store().tasks.map((t) => t.id)).toEqual(["o1", "a1", "o2"]);
  });

  it("replaces a plugin's list and clears it on an empty one", () => {
    push!({ pluginId: "acme", tasks: [task("a1", "acme", 1), task("a2", "acme", 2)] });
    push!({ pluginId: "other", tasks: [task("o1", "other", 3)] });
    push!({ pluginId: "acme", tasks: [task("a2", "acme", 2)] });
    expect(store().tasks.map((t) => t.id)).toEqual(["a2", "o1"]);

    push!({ pluginId: "acme", tasks: [] });
    expect(store().tasksByPluginId).toEqual({ other: [task("o1", "other", 3)] });
  });

  it("keeps the same list for a clear of a plugin it never held", () => {
    push!({ pluginId: "acme", tasks: [task("a1", "acme", 1)] });
    const before = store().tasks;
    push!({ pluginId: "ghost", tasks: [] });
    expect(store().tasks).toBe(before);
  });

  it("subscribes once however often init runs", () => {
    store().init();
    store().init();
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
  });

  it("waits for the bridge rather than failing without it", () => {
    _resetPluginTaskStoreForTest();
    Reflect.deleteProperty(window, "electron");
    expect(() => store().init()).not.toThrow();
    installBridge();
    store().init();
    push!({ pluginId: "acme", tasks: [task("a1", "acme", 1)] });
    expect(store().tasks).toHaveLength(1);
  });

  it("counts only running tasks as live", () => {
    expect(isLivePluginTask(task("a", "acme", 1))).toBe(true);
    expect(isLivePluginTask({ ...task("a", "acme", 1), state: "cancelling" })).toBe(true);
    expect(isLivePluginTask({ ...task("a", "acme", 1), state: "interrupted" })).toBe(false);
  });
});
