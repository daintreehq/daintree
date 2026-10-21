// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginWorktreeCardStatus } from "@shared/types/plugin";

type ChangedPayload = {
  pluginId: string;
  projectId: string;
  statuses: Record<string, PluginWorktreeCardStatus>;
};

const { onChangedMock } = vi.hoisted(() => ({ onChangedMock: vi.fn() }));

let changedCb: ((p: ChangedPayload) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  Reflect.set(window, "electron", { plugin: { onWorktreeCardStatusesChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginWorktreeCardStatusStore");
  mod._resetPluginWorktreeCardStatusStoreForTest();
  mod.usePluginWorktreeCardStatusStore.getState().init();
  return mod;
}

describe("pluginWorktreeCardStatusStore", () => {
  it("init is idempotent", async () => {
    const mod = await load();
    mod.usePluginWorktreeCardStatusStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginWorktreeCardStatusStore");
    mod._resetPluginWorktreeCardStatusStoreForTest();
    mod.usePluginWorktreeCardStatusStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onWorktreeCardStatusesChanged: onChangedMock } });
    mod.usePluginWorktreeCardStatusStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's map in one project and leaves the rest alone", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/1": { label: "x" } } });
    changedCb!({ pluginId: "p1", projectId: "B", statuses: { "/b/1": { label: "y" } } });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: { "/a/1": { label: "z" } } });
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/2": { label: "w" } } });

    expect(mod.usePluginWorktreeCardStatusStore.getState().statusesByProject).toEqual({
      A: { p1: { "/a/2": { label: "w" } }, p2: { "/a/1": { label: "z" } } },
      B: { p1: { "/b/1": { label: "y" } } },
    });
  });

  it("drops a plugin on an empty map, and the project once nothing is left", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/1": { label: "x" } } });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: { "/a/1": { label: "z" } } });
    changedCb!({ pluginId: "p1", projectId: "A", statuses: {} });
    expect(mod.usePluginWorktreeCardStatusStore.getState().statusesByProject).toEqual({
      A: { p2: { "/a/1": { label: "z" } } },
    });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: {} });
    expect(mod.usePluginWorktreeCardStatusStore.getState().statusesByProject).toEqual({});
  });

  it("keeps state identity for a clear of a plugin it never held", async () => {
    const mod = await load();
    const before = mod.usePluginWorktreeCardStatusStore.getState();
    changedCb!({ pluginId: "ghost", projectId: "A", statuses: {} });
    expect(mod.usePluginWorktreeCardStatusStore.getState()).toBe(before);
  });
});

describe("worktreeCardStatusesFor", () => {
  it("lists every plugin's status on one card, ordered by manifest id then instance", async () => {
    const { worktreeCardStatusesFor } = await import("../pluginWorktreeCardStatusStore");
    const entries = worktreeCardStatusesFor(
      {
        "zeta.docker": { "/wt": { label: "z" } },
        "project__p1__acme.status": { "/wt": { label: "project copy" } },
        "acme.status": { "/wt": { label: "installed copy" } },
        "mid.other": { "/elsewhere": { label: "not this card" } },
      },
      "/wt"
    );
    expect(entries.map((e) => [e.pluginId, e.status.label])).toEqual([
      ["acme.status", "installed copy"],
      ["project__p1__acme.status", "project copy"],
      ["zeta.docker", "z"],
    ]);
  });

  it("answers empty for a missing project bucket", async () => {
    const { worktreeCardStatusesFor } = await import("../pluginWorktreeCardStatusStore");
    expect(worktreeCardStatusesFor(undefined, "/wt")).toEqual([]);
  });
});
