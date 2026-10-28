// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginTerminalStatus } from "@shared/types/plugin";

type ChangedPayload = {
  pluginId: string;
  projectId: string;
  statuses: Record<string, PluginTerminalStatus>;
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
  Reflect.set(window, "electron", { plugin: { onTerminalStatusesChanged: onChangedMock } });
});

async function load() {
  const mod = await import("../pluginTerminalStatusStore");
  mod._resetPluginTerminalStatusStoreForTest();
  mod.usePluginTerminalStatusStore.getState().init();
  return mod;
}

describe("pluginTerminalStatusStore", () => {
  it("init is idempotent", async () => {
    const mod = await load();
    mod.usePluginTerminalStatusStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("stays retryable while the bridge is missing", async () => {
    Reflect.set(window, "electron", {});
    const mod = await import("../pluginTerminalStatusStore");
    mod._resetPluginTerminalStatusStoreForTest();
    mod.usePluginTerminalStatusStore.getState().init();
    Reflect.set(window, "electron", { plugin: { onTerminalStatusesChanged: onChangedMock } });
    mod.usePluginTerminalStatusStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("replaces one plugin's map in one project and leaves the rest alone", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/1": { label: "x" } } });
    changedCb!({ pluginId: "p1", projectId: "B", statuses: { "/b/1": { label: "y" } } });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: { "/a/1": { label: "z" } } });
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/2": { label: "w" } } });

    expect(mod.usePluginTerminalStatusStore.getState().statusesByProject).toEqual({
      A: { p1: { "/a/2": { label: "w" } }, p2: { "/a/1": { label: "z" } } },
      B: { p1: { "/b/1": { label: "y" } } },
    });
  });

  it("drops a plugin on an empty map, and the project once nothing is left", async () => {
    const mod = await load();
    changedCb!({ pluginId: "p1", projectId: "A", statuses: { "/a/1": { label: "x" } } });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: { "/a/1": { label: "z" } } });
    changedCb!({ pluginId: "p1", projectId: "A", statuses: {} });
    expect(mod.usePluginTerminalStatusStore.getState().statusesByProject).toEqual({
      A: { p2: { "/a/1": { label: "z" } } },
    });
    changedCb!({ pluginId: "p2", projectId: "A", statuses: {} });
    expect(mod.usePluginTerminalStatusStore.getState().statusesByProject).toEqual({});
  });

  it("keeps state identity for a clear of a plugin it never held", async () => {
    const mod = await load();
    const before = mod.usePluginTerminalStatusStore.getState();
    changedCb!({ pluginId: "ghost", projectId: "A", statuses: {} });
    expect(mod.usePluginTerminalStatusStore.getState()).toBe(before);
  });
});

describe("terminalStatusesFor", () => {
  it("lists every plugin's status on one terminal, ordered by manifest id then instance", async () => {
    const { terminalStatusesFor } = await import("../pluginTerminalStatusStore");
    const entries = terminalStatusesFor(
      {
        "zeta.docker": { term: { label: "z" } },
        "project__p1__acme.status": { term: { label: "project copy" } },
        "acme.status": { term: { label: "installed copy" } },
        "mid.other": { "term-2": { label: "not this terminal" } },
      },
      "term"
    );
    expect(entries.map((e) => [e.pluginId, e.status.label])).toEqual([
      ["acme.status", "installed copy"],
      ["project__p1__acme.status", "project copy"],
      ["zeta.docker", "z"],
    ]);
  });

  it("answers empty for a missing project bucket", async () => {
    const { terminalStatusesFor } = await import("../pluginTerminalStatusStore");
    expect(terminalStatusesFor(undefined, "term")).toEqual([]);
  });
});
