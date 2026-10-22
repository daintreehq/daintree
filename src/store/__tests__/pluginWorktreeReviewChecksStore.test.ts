// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginWorktreeReviewCheck } from "@shared/types/plugin";

type ChangedPayload = {
  pluginId: string;
  projectId: string;
  checks: Record<string, PluginWorktreeReviewCheck[]>;
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
  Reflect.set(window, "electron", { plugin: { onWorktreeReviewChecksChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginWorktreeReviewChecksStore");
  mod._resetPluginWorktreeReviewChecksStoreForTest();
  mod.usePluginWorktreeReviewChecksStore.getState().init();
  return mod;
}

const warn = (label: string): PluginWorktreeReviewCheck => ({ label, severity: "warning" });

describe("pluginWorktreeReviewChecksStore", () => {
  it("init is idempotent and stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginWorktreeReviewChecksStore");
    mod._resetPluginWorktreeReviewChecksStoreForTest();
    mod.usePluginWorktreeReviewChecksStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onWorktreeReviewChecksChanged: onChangedMock } });
    mod.usePluginWorktreeReviewChecksStore.getState().init();
    mod.usePluginWorktreeReviewChecksStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's map in one project and leaves the rest alone", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", checks: { "/a": [warn("one")] } });
    changedCb!({ pluginId: "p2", projectId: "A", checks: { "/a": [warn("two")] } });
    changedCb!({ pluginId: "p1", projectId: "B", checks: { "/b": [warn("three")] } });
    changedCb!({ pluginId: "p1", projectId: "A", checks: { "/a": [warn("four")] } });
    const { checksByProject } = mod.usePluginWorktreeReviewChecksStore.getState();
    expect(checksByProject.A?.p1?.["/a"]).toEqual([warn("four")]);
    expect(checksByProject.A?.p2?.["/a"]).toEqual([warn("two")]);
    expect(checksByProject.B?.p1?.["/b"]).toEqual([warn("three")]);
  });

  it("drops an entry, then its project, when an empty map arrives", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", checks: { "/a": [warn("one")] } });
    changedCb!({ pluginId: "p1", projectId: "A", checks: {} });
    expect(mod.usePluginWorktreeReviewChecksStore.getState().checksByProject).toEqual({});
  });

  it("ignores a clear for something it never held", async () => {
    const mod = await load();
    const before = mod.usePluginWorktreeReviewChecksStore.getState();
    changedCb!({ pluginId: "p1", projectId: "A", checks: {} });
    expect(mod.usePluginWorktreeReviewChecksStore.getState()).toBe(before);
  });

  it("selects one worktree's checks across plugins, ordered by manifest id", async () => {
    const mod = await load();
    changedCb!({ pluginId: "zeta.plugin", projectId: "A", checks: { "/a": [warn("z")] } });
    changedCb!({ pluginId: "alpha.plugin", projectId: "A", checks: { "/a": [warn("a")] } });
    changedCb!({
      pluginId: "alpha.plugin",
      projectId: "A",
      checks: { "/a": [warn("a")], "/b": [] },
    });
    const byPlugin = mod.usePluginWorktreeReviewChecksStore.getState().checksByProject.A;
    expect(mod.worktreeReviewChecksFor(byPlugin, "/a").map((e) => e.pluginId)).toEqual([
      "alpha.plugin",
      "zeta.plugin",
    ]);
    expect(mod.worktreeReviewChecksFor(byPlugin, "/b")).toEqual([]);
    expect(mod.worktreeReviewChecksFor(undefined, "/a")).toEqual([]);
  });
});
