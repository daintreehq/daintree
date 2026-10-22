// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import {
  resetPluginLaunchEntriesStoreForTests,
  usePluginLaunchEntriesStore,
} from "../pluginLaunchEntriesStore";

function entry(id: string, over: Partial<PluginLaunchEntryConfig> = {}): PluginLaunchEntryConfig {
  return {
    id: `acme.records.${id}`,
    pluginId: "acme.records",
    pluginName: "Records",
    label: id,
    iconId: "plus",
    priority: 3,
    target: { type: "panel", panelKindId: "acme.records.records" },
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Push = (payload: { entries: PluginLaunchEntryConfig[] }) => void;

let push: Push | null;
let pull: ReturnType<typeof deferred<PluginLaunchEntryConfig[]>>;
const getHiddenLaunchGroups = vi.fn();
const setLaunchGroupHidden = vi.fn();
const subscribe = vi.fn((cb: Push) => {
  push = cb;
  return () => {};
});

beforeEach(() => {
  resetPluginLaunchEntriesStoreForTests();
  push = null;
  pull = deferred<PluginLaunchEntryConfig[]>();
  getHiddenLaunchGroups.mockReset().mockResolvedValue([]);
  setLaunchGroupHidden.mockReset();
  subscribe.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: {
        launchEntries: () => pull.promise,
        onLaunchEntriesChanged: subscribe,
        getHiddenLaunchGroups,
        setLaunchGroupHidden,
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("pluginLaunchEntriesStore (#13788)", () => {
  it("takes a push over a pull that resolves after it", async () => {
    usePluginLaunchEntriesStore.getState().init();
    push!({ entries: [entry("pushed")] });
    pull.resolve([entry("stale")]);
    await pull.promise;
    await Promise.resolve();
    expect(usePluginLaunchEntriesStore.getState().entries.map((e) => e.id)).toEqual([
      "acme.records.pushed",
    ]);
  });

  it("drops a command entry outside its own plugin's namespace", () => {
    usePluginLaunchEntriesStore.getState().init();
    push!({
      entries: [
        entry("own", { target: { type: "command", actionId: "acme.records.publish" } }),
        entry("builtin", { target: { type: "command", actionId: "terminal.new" } }),
        entry("other", { target: { type: "command", actionId: "acme.recordsx.run" } }),
      ],
    });
    expect(usePluginLaunchEntriesStore.getState().entries.map((e) => e.id)).toEqual([
      "acme.records.own",
    ]);
  });

  it("subscribes once however many surfaces initialise it", () => {
    usePluginLaunchEntriesStore.getState().init();
    usePluginLaunchEntriesStore.getState().init();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("re-reads the hidden groups when main replays the view's snapshot", async () => {
    getHiddenLaunchGroups.mockResolvedValueOnce([]).mockResolvedValueOnce(["acme.records"]);
    usePluginLaunchEntriesStore.getState().init();
    await vi.waitFor(() => expect(getHiddenLaunchGroups).toHaveBeenCalledTimes(1));
    push!({ entries: [] });
    await vi.waitFor(() =>
      expect(usePluginLaunchEntriesStore.getState().hiddenPluginIds).toEqual(["acme.records"])
    );
  });

  it("keeps main's answer after a hide, and reports a write that failed", async () => {
    setLaunchGroupHidden.mockResolvedValueOnce(["acme.records"]);
    expect(await usePluginLaunchEntriesStore.getState().setGroupHidden("acme.records", true)).toBe(
      true
    );
    expect(usePluginLaunchEntriesStore.getState().hiddenPluginIds).toEqual(["acme.records"]);
    expect(setLaunchGroupHidden).toHaveBeenCalledWith("acme.records", true);

    setLaunchGroupHidden.mockRejectedValueOnce(new Error("disk full"));
    expect(await usePluginLaunchEntriesStore.getState().setGroupHidden("acme.records", false)).toBe(
      false
    );
    expect(usePluginLaunchEntriesStore.getState().hiddenPluginIds).toEqual(["acme.records"]);
    expect(usePluginLaunchEntriesStore.getState().saveError).toBe("acme.records");
  });
});
