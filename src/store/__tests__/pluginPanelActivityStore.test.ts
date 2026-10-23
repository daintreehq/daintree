// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPanelActivityReport } from "@shared/types/plugin";
import {
  _resetPluginPanelActivityStoreForTest,
  selectPanelActivityReport,
  usePluginPanelActivityStore,
} from "../pluginPanelActivityStore";

type Payload = { pluginId: string; activity: Record<string, PluginPanelActivityReport> };

let push: ((payload: Payload) => void) | null = null;
const unsubscribe = vi.fn();

function installBridge(): void {
  (window as unknown as { electron: unknown }).electron = {
    plugin: {
      onPanelActivityChanged: vi.fn((cb: (payload: Payload) => void) => {
        push = cb;
        return unsubscribe;
      }),
    },
  };
}

const store = () => usePluginPanelActivityStore.getState();

beforeEach(() => {
  _resetPluginPanelActivityStoreForTest();
  push = null;
  installBridge();
  store().init();
});

afterEach(() => {
  _resetPluginPanelActivityStoreForTest();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("pluginPanelActivityStore", () => {
  it("mirrors each plugin's complete map, keyed by panel", () => {
    push!({ pluginId: "acme", activity: { p1: { state: "working", revision: 1 } } });
    push!({ pluginId: "other", activity: { p1: { state: "waiting", revision: 2 } } });

    expect(store().activityByPanelId).toEqual({
      p1: {
        acme: { state: "working", revision: 1 },
        other: { state: "waiting", revision: 2 },
      },
    });
    expect(selectPanelActivityReport(store(), "p1", "acme")?.state).toBe("working");
    expect(selectPanelActivityReport(store(), "p1", null)).toBeUndefined();
  });

  it("replaces a plugin's reports wholesale and clears them on an empty map", () => {
    push!({
      pluginId: "acme",
      activity: { p1: { state: "working", revision: 1 }, p2: { state: "failed", revision: 2 } },
    });
    push!({ pluginId: "acme", activity: { p2: { state: "failed", revision: 2 } } });
    expect(Object.keys(store().activityByPanelId)).toEqual(["p2"]);

    push!({ pluginId: "acme", activity: {} });
    expect(store().activityByPanelId).toEqual({});
  });

  it("keeps an untouched panel's object, and a replayed report's, so nothing re-renders", () => {
    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 1 } } });
    push!({ pluginId: "other", activity: { p2: { state: "working", revision: 2 } } });
    const p1 = store().activityByPanelId.p1;
    const report = p1?.acme;

    push!({ pluginId: "other", activity: { p2: { state: "waiting", revision: 3 } } });
    expect(store().activityByPanelId.p1).toBe(p1);

    const before = store().activityByPanelId;
    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 1 } } });
    expect(store().activityByPanelId.p1?.acme).toBe(report);
    expect(store().activityByPanelId).toBe(before);
  });

  it("one new revision in a 100-panel map invalidates only that panel, and an equal replay notifies nothing (#14128)", () => {
    const fleet = (bumped?: number): Record<string, PluginPanelActivityReport> =>
      Object.fromEntries(
        Array.from({ length: 100 }, (_, i): [string, PluginPanelActivityReport] => [
          `p${i}`,
          i === bumped
            ? { state: "finished", revision: 1000 }
            : { state: "working", revision: i + 1 },
        ])
      );
    push!({ pluginId: "acme", activity: fleet() });
    store().markSeen("p7", 8);
    const before = { ...store().activityByPanelId };

    push!({ pluginId: "acme", activity: fleet(7) });
    const after = store().activityByPanelId;
    expect(Object.keys(before).filter((id) => after[id] !== before[id])).toEqual(["p7"]);
    expect(after.p7?.acme?.revision).toBe(1000);
    expect(store().seenRevisionByPanelId).toEqual({ p7: 8 });

    const listener = vi.fn();
    const unsubscribeStore = usePluginPanelActivityStore.subscribe(listener);
    push!({ pluginId: "acme", activity: fleet(7) });
    unsubscribeStore();
    expect(listener).not.toHaveBeenCalled();
  });

  it("holds a seen mark by revision, so a replay stays seen and a new report does not", () => {
    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 4 } } });
    store().markSeen("p1", 4);
    expect(store().seenRevisionByPanelId.p1).toBe(4);

    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 4 } } });
    expect(store().seenRevisionByPanelId.p1).toBe(4);

    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 9 } } });
    expect(store().seenRevisionByPanelId.p1).not.toBe(store().activityByPanelId.p1?.acme?.revision);
  });

  it("keeps a seen mark while another plugin's report on the panel remains", () => {
    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 1 } } });
    push!({ pluginId: "other", activity: { p1: { state: "working", revision: 2 } } });
    store().markSeen("p1", 1);
    push!({ pluginId: "other", activity: {} });
    expect(store().seenRevisionByPanelId.p1).toBe(1);
  });

  it("drops a seen mark once the panel has no reports left", () => {
    push!({ pluginId: "acme", activity: { p1: { state: "finished", revision: 1 } } });
    store().markSeen("p1", 1);
    push!({ pluginId: "acme", activity: {} });
    expect(store().seenRevisionByPanelId).toEqual({});
  });

  it("removePanel drops a closed panel's reports and seen mark, and no-ops otherwise", () => {
    push!({
      pluginId: "acme",
      activity: { p1: { state: "finished", revision: 1 }, p2: { state: "working", revision: 2 } },
    });
    store().markSeen("p1", 1);
    store().removePanel("p1");
    expect(Object.keys(store().activityByPanelId)).toEqual(["p2"]);
    expect(store().seenRevisionByPanelId).toEqual({});

    const before = usePluginPanelActivityStore.getState();
    store().removePanel("never");
    expect(usePluginPanelActivityStore.getState()).toBe(before);
  });

  it("subscribes once, and stays retryable while the bridge is missing", () => {
    store().init();
    const bridge = (
      window as unknown as { electron: { plugin: { onPanelActivityChanged: unknown } } }
    ).electron.plugin.onPanelActivityChanged as ReturnType<typeof vi.fn>;
    expect(bridge).toHaveBeenCalledTimes(1);

    _resetPluginPanelActivityStoreForTest();
    delete (window as unknown as { electron?: unknown }).electron;
    push = null;
    expect(() => store().init()).not.toThrow();
    installBridge();
    store().init();
    expect(push).not.toBeNull();
  });
});
