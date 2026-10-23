import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

// `buildIpcContext` resolves the sender's project through the registry.
const registryMock = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  getWindowForWebContents: vi.fn<() => { id: number } | null>(() => null),
}));

const broadcastMock = vi.hoisted(() => vi.fn());

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { path: string } | undefined>(() => undefined),
}));

const readSuggestionMock = vi.hoisted(() => vi.fn<(root: unknown) => Promise<unknown>>());
const detectWebProjectMock = vi.hoisted(() => vi.fn<(root: unknown) => Promise<boolean | null>>());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return { ...actual, ...registryMock };
});
vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return { ...actual, broadcastToProjectRenderers: broadcastMock };
});
vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/projectPresentation/repoSuggestion.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/projectPresentation/repoSuggestion.js")
    >();
  return { ...actual, readPresentationSuggestion: readSuggestionMock };
});
vi.mock("../../../services/projectPresentation/webProjectDetection.js", () => ({
  detectWebProject: detectWebProjectMock,
}));

import { CHANNELS } from "../../channels.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../../shared/config/toolbarButtonRegistry.js";
import type { PluginToolbarButtonId } from "../../../../shared/types/toolbar.js";
import {
  registerPluginLaunchEntry,
  unregisterPluginLaunchEntries,
} from "../../../../shared/config/pluginLaunchEntryRegistry.js";
import { registerProjectPresentationHandlers } from "../projectPresentation.js";
import { hashPresentationLevels } from "../../../services/projectPresentation/repoSuggestion.js";
import type { ProjectPresentationSnapshot } from "../../../../shared/types/ipc/projectPresentation.js";
import { events } from "../../../services/events.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";

const PROJECT_A = "a".repeat(64);

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`${channel} not registered`);
  const event = {
    sender: { id: 7 },
    senderFrame: { routingId: 1 },
  } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event, ...args);
}

const HIDDEN = { forgeStats: "hidden" } as const;

let cleanup: (() => void) | null = null;

beforeEach(() => {
  ipcHandlers.clear();
  vi.clearAllMocks();
  storeMock.data.clear();
  registryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
  projectStoreMock.getProjectById.mockReturnValue({ path: "/repo" });
  readSuggestionMock.mockResolvedValue({ levels: HIDDEN, hash: hashPresentationLevels(HIDDEN) });
  detectWebProjectMock.mockResolvedValue(true);
  cleanup = registerProjectPresentationHandlers();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("project-presentation:get", () => {
  it("answers for the sender's own project, with the repository's suggestion", async () => {
    const snapshot = (await invoke("project-presentation:get")) as ProjectPresentationSnapshot;

    expect(readSuggestionMock).toHaveBeenCalledWith("/repo");
    expect(detectWebProjectMock).toHaveBeenCalledWith("/repo");
    expect(snapshot).toEqual({
      projectId: PROJECT_A,
      levels: {},
      suggestion: { levels: HIDDEN, hash: hashPresentationLevels(HIDDEN) },
      suggestionAnswer: null,
      useProjectToolbar: null,
      promotedPluginButtons: [],
      launcherGroupOrder: [],
      featuredLaunchEntry: null,
      webProject: true,
      revision: 0,
    });
  });

  it("answers null for a sender not bound to a project yet, rather than an empty profile", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(invoke("project-presentation:get")).resolves.toBeNull();
    expect(readSuggestionMock).not.toHaveBeenCalled();
  });
});

describe("project-presentation:set-level", () => {
  it("records the level and tells every view of the project", async () => {
    const snapshot = (await invoke(
      "project-presentation:set-level",
      "forgeStats",
      "demoted"
    )) as ProjectPresentationSnapshot;

    expect(snapshot.levels).toEqual({ forgeStats: "demoted" });
    expect(snapshot.revision).toBe(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.PROJECT_PRESENTATION_CHANGED,
      snapshot
    );
  });

  it("never publishes an older profile after a newer one when two writes interleave", async () => {
    const reads: Array<(value: unknown) => void> = [];
    readSuggestionMock.mockImplementation(() => new Promise((resolve) => reads.push(resolve)));

    const first = invoke("project-presentation:set-level", "forgeStats", "demoted");
    const second = invoke("project-presentation:set-level", "forgeStats", "hidden");
    // The second write's file read finishes first.
    reads[1]!(null);
    await second;
    reads[0]!(null);
    await first;

    const published = broadcastMock.mock.calls.map(
      ([, , snapshot]) => snapshot as ProjectPresentationSnapshot
    );
    expect(published.map((s) => [s.revision, s.levels.forgeStats])).toEqual([
      [2, "hidden"],
      [2, "hidden"],
    ]);
  });

  it("refuses a feature outside the vocabulary and a level the feature does not offer", async () => {
    await expect(
      invoke("project-presentation:set-level", "agentState", "hidden")
    ).rejects.toThrow();
    await expect(invoke("project-presentation:set-level", "forgeStats", "gone")).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a sender with no project", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(
      invoke("project-presentation:set-level", "forgeStats", "hidden")
    ).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("project-presentation:answer-suggestion", () => {
  it("accepts what the file suggests now and copies it into the profile", async () => {
    const snapshot = (await invoke(
      "project-presentation:answer-suggestion",
      hashPresentationLevels(HIDDEN),
      "accepted"
    )) as ProjectPresentationSnapshot;

    expect(snapshot.levels).toEqual(HIDDEN);
    expect(snapshot.suggestionAnswer).toMatchObject({
      hash: hashPresentationLevels(HIDDEN),
      answer: "accepted",
    });
    expect(broadcastMock).toHaveBeenCalledOnce();
  });

  it("refuses an answer about a suggestion the file has since changed", async () => {
    const demoted = { forgeStats: "demoted" } as const;
    await expect(
      invoke("project-presentation:answer-suggestion", hashPresentationLevels(demoted), "accepted")
    ).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("project toolbar ops (#13783)", () => {
  const OWN_PLUGIN = `project__${PROJECT_A}__acme.tools`;
  const OTHER_PLUGIN = `project__${"b".repeat(64)}__acme.tools`;
  const ownButton = `${OWN_PLUGIN}.run`;

  function register(pluginId: string, id: string) {
    registerToolbarButton({
      id: id as PluginToolbarButtonId,
      label: "Run",
      iconId: "play",
      actionId: `${pluginId}.run`,
      priority: 3,
      pluginId,
    });
  }

  afterEach(() => {
    for (const pluginId of [OWN_PLUGIN, OTHER_PLUGIN, "acme.tools"]) {
      unregisterPluginToolbarButtons(pluginId);
    }
  });

  it("promotes a registered button of the sender's own project plugin", async () => {
    register(OWN_PLUGIN, ownButton);
    const snapshot = (await invoke(
      "project-presentation:set-plugin-button-promoted",
      ownButton,
      true
    )) as ProjectPresentationSnapshot;
    expect(snapshot.promotedPluginButtons).toEqual([ownButton]);
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.PROJECT_PRESENTATION_CHANGED,
      snapshot
    );
  });

  it("refuses an installed plugin's button, another project's, or one not registered", async () => {
    register("acme.tools", "acme.tools.run");
    register(OTHER_PLUGIN, `${OTHER_PLUGIN}.run`);
    await expect(
      invoke("project-presentation:set-plugin-button-promoted", "acme.tools.run", true)
    ).rejects.toThrow(/own plugin buttons/);
    await expect(
      invoke("project-presentation:set-plugin-button-promoted", `${OTHER_PLUGIN}.run`, true)
    ).rejects.toThrow(/own plugin buttons/);
    await expect(
      invoke("project-presentation:set-plugin-button-promoted", ownButton, true)
    ).rejects.toThrow(/own plugin buttons/);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("lets a promotion go after its plugin has unloaded", async () => {
    register(OWN_PLUGIN, ownButton);
    await invoke("project-presentation:set-plugin-button-promoted", ownButton, true);
    unregisterPluginToolbarButtons(OWN_PLUGIN);
    const snapshot = (await invoke(
      "project-presentation:set-plugin-button-promoted",
      ownButton,
      false
    )) as ProjectPresentationSnapshot;
    expect(snapshot.promotedPluginButtons).toEqual([]);
  });

  it("sets the toggle and resets the toolbar for the sender's project", async () => {
    await invoke("project-presentation:set-level", "copyTree", "demoted");
    const off = (await invoke(
      "project-presentation:set-toolbar-enabled",
      false
    )) as ProjectPresentationSnapshot;
    expect(off.useProjectToolbar).toBe(false);
    expect(off.levels).toEqual({ copyTree: "demoted" });
    await expect(invoke("project-presentation:set-toolbar-enabled", "no")).rejects.toThrow();

    const reset = (await invoke(
      "project-presentation:reset-toolbar"
    )) as ProjectPresentationSnapshot;
    expect(reset.levels).toEqual({});
    expect(reset.useProjectToolbar).toBeNull();
  });
});

describe("launcher ops (#13791)", () => {
  const OWN_PLUGIN = `project__${PROJECT_A}__acme.records`;
  const OTHER_PLUGIN = `project__${"b".repeat(64)}__acme.records`;

  function register(pluginId: string, entryId: string) {
    registerPluginLaunchEntry({
      id: `${pluginId}.${entryId}`,
      pluginId,
      pluginName: "Records",
      label: "New record",
      iconId: "plus",
      priority: 3,
      target: { type: "command", actionId: `${pluginId}.new` },
    });
  }

  afterEach(() => {
    for (const pluginId of [OWN_PLUGIN, OTHER_PLUGIN, "acme.records"]) {
      unregisterPluginLaunchEntries(pluginId);
    }
  });

  it("features a registered entry of the sender's own project plugin", async () => {
    register(OWN_PLUGIN, "new-record");
    const snapshot = (await invoke(
      "project-presentation:set-featured-launch-entry",
      "acme.records.new-record"
    )) as ProjectPresentationSnapshot;
    expect(snapshot.featuredLaunchEntry).toBe("acme.records.new-record");
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.PROJECT_PRESENTATION_CHANGED,
      snapshot
    );
  });

  it("refuses an installed plugin's entry, another project's, or one not registered", async () => {
    register("acme.records", "new-record");
    register(OTHER_PLUGIN, "new-record");
    await expect(
      invoke("project-presentation:set-featured-launch-entry", "acme.records.new-record")
    ).rejects.toThrow(/own plugin entries/);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("lets a featured entry go after its plugin has unloaded", async () => {
    register(OWN_PLUGIN, "new-record");
    await invoke("project-presentation:set-featured-launch-entry", "acme.records.new-record");
    unregisterPluginLaunchEntries(OWN_PLUGIN);
    const snapshot = (await invoke(
      "project-presentation:set-featured-launch-entry",
      null
    )) as ProjectPresentationSnapshot;
    expect(snapshot.featuredLaunchEntry).toBeNull();
  });

  it("stores the sender's group order and refuses a malformed one", async () => {
    const snapshot = (await invoke("project-presentation:set-launcher-group-order", [
      "recipes",
      "agents",
    ])) as ProjectPresentationSnapshot;
    expect(snapshot.launcherGroupOrder).toEqual(["recipes", "agents"]);
    await expect(
      invoke("project-presentation:set-launcher-group-order", "recipes")
    ).rejects.toThrow();
  });
});

describe("web project detection (#14069)", () => {
  function changeUnder(path: string): void {
    events.emit("sys:worktree:update", { id: path, path } as unknown as WorktreeSnapshot);
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("carries what it read without storing it", async () => {
    detectWebProjectMock.mockResolvedValue(false);
    const snapshot = (await invoke("project-presentation:get")) as ProjectPresentationSnapshot;
    expect(snapshot.webProject).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("tells the project's views when a change under its root flips the answer", async () => {
    detectWebProjectMock.mockResolvedValue(false);
    await invoke("project-presentation:get");
    detectWebProjectMock.mockResolvedValue(true);

    changeUnder("/repo");

    await vi.waitFor(() => expect(broadcastMock).toHaveBeenCalledTimes(1));
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.PROJECT_PRESENTATION_CHANGED,
      expect.objectContaining({ projectId: PROJECT_A, webProject: true })
    );
  });

  it("stays quiet when the answer holds or the change is outside the root", async () => {
    await invoke("project-presentation:get");

    changeUnder("/repo");
    changeUnder("/repo-worktrees/feature");

    await vi.waitFor(() => expect(detectWebProjectMock).toHaveBeenCalledTimes(2));
    await settle();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("reads nothing for a project no view has asked about", async () => {
    changeUnder("/repo");
    await settle();
    expect(detectWebProjectMock).not.toHaveBeenCalled();
  });

  it("stops listening once the handlers are gone", async () => {
    await invoke("project-presentation:get");
    cleanup?.();
    cleanup = null;

    changeUnder("/repo");
    await settle();

    expect(detectWebProjectMock).toHaveBeenCalledTimes(1);
  });

  it("lets a project hide its dev preview without touching its toolbar toggle", async () => {
    await invoke("project-presentation:set-toolbar-enabled", false);
    const snapshot = (await invoke(
      "project-presentation:set-level",
      "devServer",
      "hidden"
    )) as ProjectPresentationSnapshot;
    expect(snapshot.levels).toEqual({ devServer: "hidden" });
    expect(snapshot.useProjectToolbar).toBe(false);
  });
});
