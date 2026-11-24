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
const setProjectInstanceEnabled = vi.fn<(pluginId: string, enabled: boolean) => Promise<void>>();
const list = vi.fn<() => Promise<unknown[]>>();

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
  setProjectInstanceEnabled.mockReset().mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      plugin: {
        setProjectPluginTrust,
        setProjectPluginMuted,
        getUnsavedPanels,
        setProjectInstanceEnabled,
        list,
      },
    },
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

  it("reads a plugin that loads while the first read is out before revoking", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "staged")]);
    getUnsavedPanels.mockImplementation(async (id) => {
      if (id === key("a.one")) {
        // a.two finishes loading while main answers for a.one.
        seed([plugin("a.one", "active"), plugin("a.two", "active")]);
        return [];
      }
      return [dirty("late")];
    });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.decide("disabled"));

    expect(getUnsavedPanels.mock.calls.map(([id]) => id)).toEqual([key("a.one"), key("a.two")]);
    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending?.panels.map((p) => p.panelId)).toEqual(["late"]);
  });

  it("reads a plugin that loads while Discard reads before revoking", async () => {
    seed([plugin("a.one", "active"), plugin("a.two", "staged")]);
    panelsByKey({ [key("a.one")]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());
    await act(() => result.current.decide("disabled"));

    getUnsavedPanels.mockImplementation(async (id) => {
      if (id === key("a.one")) {
        seed([plugin("a.one", "active"), plugin("a.two", "active")]);
        return [dirty("panel-1")];
      }
      return [dirty("panel-2")];
    });
    await act(() => result.current.confirm());

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
    expect(result.current.pending?.panels.map((p) => p.panelId).sort()).toEqual([
      "panel-1",
      "panel-2",
    ]);
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

describe("useProjectPluginUnsavedGuard — turning a per-project package off (#17215)", () => {
  const INSTALLED_KEY = `project__${PROJECT}__installed__acme.tools`;

  /** The view is named, but no repository snapshot has arrived: the package runs anyway. */
  function nameView(projectId: string = PROJECT) {
    act(() => useProjectPluginStore.getState().setViewProjectId(projectId));
  }

  it("reads this project's instance key, prompts with the package's name, and Discard reads again", async () => {
    nameView();
    panelsByKey({ [INSTALLED_KEY]: [dirty("panel-1")], "acme.tools": [dirty("elsewhere")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels.mock.calls).toEqual([[INSTALLED_KEY]]);
    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
    expect(result.current.pending).toMatchObject({
      unload: {
        kind: "instanceOff",
        pluginId: "acme.tools",
        displayName: "Acme Tools",
        projectId: PROJECT,
      },
      projectId: PROJECT,
    });
    expect(result.current.pending?.panels.map((p) => p.panelId)).toEqual(["panel-1"]);

    getUnsavedPanels.mockClear();
    await act(() => result.current.confirm());
    expect(getUnsavedPanels.mock.calls).toEqual([[INSTALLED_KEY]]);
    expect(setProjectInstanceEnabled.mock.calls).toEqual([["acme.tools", false]]);
    expect(result.current.pending).toBeNull();
  });

  it("turns it off straight away when its panels are clean", async () => {
    nameView();
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels).toHaveBeenCalledWith(INSTALLED_KEY);
    expect(setProjectInstanceEnabled).toHaveBeenCalledWith("acme.tools", false);
    expect(result.current.pending).toBeNull();
  });

  it("turns it on without reading", async () => {
    nameView();
    getUnsavedPanels.mockResolvedValue([dirty("panel-1")]);
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", true, "Acme Tools"));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectInstanceEnabled).toHaveBeenCalledWith("acme.tools", true);
  });

  it("stops with the package's turn-off error when the read fails", async () => {
    nameView();
    panelsByKey({ [INSTALLED_KEY]: new Error("boom") });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels.mock.calls).toEqual([[INSTALLED_KEY]]);
    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    const { error, errorSource } = useProjectPluginStore.getState();
    expect(error).toBe(UNSAVED_READ_FAILED);
    expect(errorSource).toMatchObject({
      action: "instanceEnabled",
      pluginId: "acme.tools",
      enabled: false,
    });
  });

  it("refuses rather than turning it off unread when no project is known", async () => {
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    expect(useProjectPluginStore.getState().error).toBe(UNSAVED_READ_FAILED);
    expect(useProjectPluginStore.getState().errorSource).toMatchObject({
      action: "instanceEnabled",
      pluginId: "acme.tools",
      enabled: false,
    });
  });

  it("drops the click when the view moves to another project while main answers", async () => {
    nameView();
    getUnsavedPanels.mockImplementation(async () => {
      useProjectPluginStore.getState().setViewProjectId("q".repeat(64));
      return [];
    });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels.mock.calls).toEqual([[INSTALLED_KEY]]);
    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("goes ahead when the repository snapshot names the same project while main answers", async () => {
    nameView();
    getUnsavedPanels.mockImplementation(async () => {
      useProjectPluginStore.getState().applySnapshot({
        projectId: PROJECT,
        plugins: [],
        trust: { projectId: PROJECT, decision: "enabled", enabled: true, persisted: true },
      });
      return [];
    });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels.mock.calls).toEqual([[INSTALLED_KEY]]);
    expect(setProjectInstanceEnabled).toHaveBeenCalledWith("acme.tools", false);
  });

  it("drops the prompt when the view moves to another project before Discard", async () => {
    nameView();
    panelsByKey({ [INSTALLED_KEY]: [dirty("panel-1")] });
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());
    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));
    expect(result.current.pending?.projectId).toBe(PROJECT);
    expect(result.current.pending?.panels.map((p) => p.panelId)).toEqual(["panel-1"]);

    nameView("q".repeat(64));
    await act(() => result.current.confirm());

    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("ignores a turn-off while the same package's last toggle is still out", async () => {
    nameView();
    act(() => useProjectPluginStore.setState({ instanceToggling: new Set(["acme.tools"]) }));
    const { result } = renderHook(() => useProjectPluginUnsavedGuard());

    await act(() => result.current.setInstanceEnabled("acme.tools", false, "Acme Tools"));

    expect(getUnsavedPanels).not.toHaveBeenCalled();
    expect(setProjectInstanceEnabled).not.toHaveBeenCalled();
  });
});
