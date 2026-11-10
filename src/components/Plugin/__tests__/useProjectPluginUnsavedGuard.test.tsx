// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_PLUGINS_UNSAVED_READ_FAILED,
  useProjectPluginUnsavedGuard,
} from "../useProjectPluginUnsavedGuard";
import { UNSAVED_READ_FAILED } from "../unsavedPluginPanels";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type { ProjectPluginInfo, ProjectPluginState } from "@shared/types/plugin";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";

const PROJECT = "p".repeat(64);
const key = (id: string) => `project__${PROJECT}__${id}`;

const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();
const setProjectPluginMuted = vi.fn<(pluginId: string, muted: boolean) => Promise<void>>();
const getUnsavedPanels = vi.fn<(pluginId: string) => Promise<PluginUnsavedPanel[]>>();

function plugin(id: string, state: ProjectPluginState): ProjectPluginInfo {
  return {
    projectId: PROJECT,
    id,
    instanceId: key(id),
    displayName: `${id} name`,
    version: "1.0.0",
    capabilities: [],
    dirName: id,
    state,
    muted: false,
    collidesWithGlobal: false,
  };
}

function dirty(panelId: string, title = panelId): PluginUnsavedPanel {
  return { panelId, title, projectId: PROJECT, projectName: "Proj" };
}

/** Answer each instance key's read from `byKey`; anything unlisted is clean. */
function panelsByKey(byKey: Record<string, PluginUnsavedPanel[] | Error>) {
  getUnsavedPanels.mockImplementation(async (id) => {
    const answer = byKey[id];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  });
}

function seed(plugins: ProjectPluginInfo[]) {
  act(() => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins,
      trust: { projectId: PROJECT, decision: "enabled", enabled: true, persisted: true },
    });
  });
}

beforeEach(() => {
  setProjectPluginTrust.mockReset().mockResolvedValue(undefined);
  setProjectPluginMuted.mockReset().mockResolvedValue(undefined);
  getUnsavedPanels.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { plugin: { setProjectPluginTrust, setProjectPluginMuted, getUnsavedPanels } },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __resetProjectPluginStoreForTesting();
  vi.restoreAllMocks();
});

describe("useProjectPluginUnsavedGuard — turning the project's plugins off", () => {
  it("goes straight through when nothing is loaded, without reading", async () => {
    seed([plugin("a.one", "blocked"), plugin("a.two", "staged")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
    expect(result.current.pending).toBeNull();
  });

  it("reads every loaded plugin by instance key and goes ahead when all are clean", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active"), plugin("a.three", "staged")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(getUnsavedPanels.mock.calls.map(([id]) => id).sort()).toEqual(
      [key("a.one"), key("a.two")].sort()
    );
    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
  });

  it("holds the revoke for a prompt naming dirty panels from any loaded plugin", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active")]);
    panelsByKey({ [key("a.two")]: [dirty("panel-1", "Draft")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending?.unload).toEqual({ kind: "trustOff" });
    expect(result.current.pending?.panels.map((p) => p.title)).toEqual(["Draft"]);
  });

  it("lists a panel two reads both name only once", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("same")], [key("a.two")]: [dirty("same")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(result.current.pending?.panels).toHaveLength(1);
  });

  it("changes nothing on Cancel", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));
    act(() => result.current.cancel());

    expect(result.current.pending).toBeNull();
    expect(setProjectPluginTrust).not.toHaveBeenCalled();
  });

  it("reads again on Discard and then revokes", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));
    getUnsavedPanels.mockClear();
    await act(() => result.current.confirm());

    expect(getUnsavedPanels).toHaveBeenCalledWith(key("a.one"));
    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
    expect(result.current.pending).toBeNull();
  });

  it("shows a panel that turned dirty under the open prompt instead of going ahead", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));
    panelsByKey({ [key("a.one")]: [dirty("panel-1")], [key("a.two")]: [dirty("panel-2")] });
    await act(() => result.current.confirm());

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending?.panels.map((p) => p.panelId).sort()).toEqual([
      "panel-1",
      "panel-2",
    ]);

    await act(() => result.current.confirm());
    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
  });

  it("goes ahead when a shown panel was saved before Discard", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1"), dirty("panel-2")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));
    panelsByKey({ [key("a.one")]: [dirty("panel-2")] });
    await act(() => result.current.confirm());

    expect(setProjectPluginTrust).toHaveBeenCalledWith("disabled");
  });

  it("stops with the store's decide error when any read fails", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active")]);
    panelsByKey({ [key("a.two")]: new Error("boom") });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    const { error, errorSource } = useProjectPluginStore.getState();
    expect(error).toBe(PROJECT_PLUGINS_UNSAVED_READ_FAILED);
    expect(errorSource).toMatchObject({ action: "decide", decision: "disabled" });
  });

  it("closes the prompt and reports it when the Discard read fails", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));
    panelsByKey({ [key("a.one")]: new Error("gone") });
    await act(() => result.current.confirm());

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    expect(useProjectPluginStore.getState().errorSource).toMatchObject({ action: "decide" });
  });

  it("does nothing when the prompt is cancelled while Discard reads", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());
    await act(() => result.current.decide("disabled"));

    let answer!: (panels: PluginUnsavedPanel[]) => void;
    getUnsavedPanels.mockImplementation(
      () => new Promise<PluginUnsavedPanel[]>((resolve) => (answer = resolve))
    );
    let confirming!: Promise<void>;
    act(() => {
      confirming = result.current.confirm();
    });
    act(() => result.current.cancel());
    await act(async () => {
      answer([dirty("panel-1")]);
      await confirming;
    });

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("starts one read for a double click", async () => {
    seed([plugin("a.one", "active")]);
    let answer!: (panels: PluginUnsavedPanel[]) => void;
    getUnsavedPanels.mockImplementation(
      () => new Promise<PluginUnsavedPanel[]>((resolve) => (answer = resolve))
    );
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    let first!: Promise<void>;
    act(() => {
      first = result.current.decide("disabled");
      void result.current.decide("disabled");
    });
    await act(async () => {
      answer([]);
      await first;
    });

    expect(getUnsavedPanels).toHaveBeenCalledTimes(1);
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(1);
  });

  it("passes every other decision straight to the store", async () => {
    seed([plugin("a.one", "active")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("enabled"));
    await act(() => result.current.decide("session"));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectPluginTrust.mock.calls).toEqual([["enabled"], ["session"]]);
  });
});

describe("useProjectPluginUnsavedGuard — switching one plugin off", () => {
  it("reads only that plugin and prompts with its name", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "active")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")], [key("a.two")]: [dirty("panel-2")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setMuted("a.one", true));

    expect(getUnsavedPanels.mock.calls).toEqual([[key("a.one")]]);
    expect(setProjectPluginMuted).not.toHaveBeenCalled();
    expect(result.current.pending?.unload).toEqual({
      kind: "mute",
      pluginId: "a.one",
      displayName: "a.one name",
    });
    expect(result.current.pending?.panels.map((p) => p.panelId)).toEqual(["panel-1"]);

    await act(() => result.current.confirm());
    expect(setProjectPluginMuted).toHaveBeenCalledWith("a.one", true);
  });

  it("mutes straight away when its panels are clean", async () => {
    seed([plugin("a.one", "active")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setMuted("a.one", true));

    expect(setProjectPluginMuted).toHaveBeenCalledWith("a.one", true);
    expect(result.current.pending).toBeNull();
  });

  it("skips the read for a plugin that isn't loaded", async () => {
    seed([plugin("a.one", "staged")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setMuted("a.one", true));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectPluginMuted).toHaveBeenCalledWith("a.one", true);
  });

  it("switches a plugin back on without reading", async () => {
    seed([plugin("a.one", "blocked")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setMuted("a.one", false));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectPluginMuted).toHaveBeenCalledWith("a.one", false);
  });

  it("stops with that plugin's mute error when the read fails", async () => {
    seed([plugin("a.one", "active")]);
    panelsByKey({ [key("a.one")]: new Error("boom") });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setMuted("a.one", true));

    expect(setProjectPluginMuted).not.toHaveBeenCalled();
    const { error, errorSource } = useProjectPluginStore.getState();
    expect(error).toBe(UNSAVED_READ_FAILED);
    expect(errorSource).toMatchObject({ action: "mute", pluginId: "a.one", muted: true });
  });
});
