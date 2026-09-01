import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcUtilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
const registryMock = vi.hoisted(() => ({
  getAllAppWebContents: vi.fn((): unknown[] => []),
  getProjectForWebContents: vi.fn((): string | null => null),
  getRegisteredProjectViews: vi.fn((): unknown[] => []),
}));
const contributionsMock = vi.hoisted(() => ({
  panelKinds: [] as Array<{ id: string; extensionId?: string }>,
  toolbarButtons: [] as Array<{ id: string; pluginId: string }>,
  keybindings: [] as Array<{ pluginId: string; item: { key: string } }>,
  contextMenuItems: [] as Array<{ pluginId: string; item: { label: string } }>,
  agents: {} as Record<string, unknown>,
  recipes: [] as unknown[],
}));

vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: ipcUtilsMock.broadcastToRenderer,
  broadcastToProjectRenderers: ipcUtilsMock.broadcastToProjectRenderers,
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: registryMock.getAllAppWebContents,
  getProjectForWebContents: registryMock.getProjectForWebContents,
  getRegisteredProjectViews: registryMock.getRegisteredProjectViews,
}));
vi.mock("../../../../shared/config/panelKindRegistry.js", () => ({
  getPluginPanelKinds: () => contributionsMock.panelKinds,
}));
vi.mock("../../../../shared/config/toolbarButtonRegistry.js", () => ({
  getAllPluginToolbarButtonConfigs: () => contributionsMock.toolbarButtons,
}));
vi.mock("../../pluginKeybindingRegistry.js", () => ({
  getPluginKeybindings: () => contributionsMock.keybindings,
}));
vi.mock("../../pluginContextMenuRegistry.js", () => ({
  getPluginContextMenuItems: () => contributionsMock.contextMenuItems,
}));
vi.mock("../../../../shared/config/pluginAgentRegistry.js", () => ({
  getPluginAgentRegistry: () => contributionsMock.agents,
}));
vi.mock("../PluginRecipeRegistry.js", () => ({
  getPluginRecipes: () => contributionsMock.recipes,
}));

import {
  PluginContributionBroadcaster,
  clearAllPluginContributionScopes,
  getPluginContributionScope,
  clearPluginContributionScope,
  hasProjectScopedContributions,
  selectContributionsForProject,
  setPluginContributionScope,
} from "../PluginContributionBroadcaster.js";
import { CHANNELS } from "../../../ipc/channels.js";
import type { PluginActionDescriptor } from "../../../../shared/types/plugin.js";

const GLOBAL_PLUGIN = "acme.global";
const PROJECT_PLUGIN_A = "acme.local-a";
const PROJECT_PLUGIN_B = "acme.local-b";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";

let actions: PluginActionDescriptor[] = [];

function makeBroadcaster(): PluginContributionBroadcaster {
  return new PluginContributionBroadcaster({
    isDisposed: () => false,
    listPluginActions: () => actions,
    initPromise: Promise.resolve(),
  });
}

function action(pluginId: string, id: string): PluginActionDescriptor {
  return { pluginId, id, title: id, effectiveDanger: "safe" } as PluginActionDescriptor;
}

function fakeWebContents(id: number) {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
  };
}

/** Drain the broadcaster's queueMicrotask coalescing. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Every payload pushed on `name`, in the order it was sent to `wc`. */
function sentPayloads(wc: ReturnType<typeof fakeWebContents>, name: string): unknown[] {
  return wc.send.mock.calls
    .filter(
      (call) => call[0] === CHANNELS.EVENTS_PUSH && (call[1] as { name: string }).name === name
    )
    .map((call) => (call[1] as { payload: unknown }).payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllPluginContributionScopes();
  registryMock.getAllAppWebContents.mockReturnValue([]);
  registryMock.getProjectForWebContents.mockReturnValue(null);
  registryMock.getRegisteredProjectViews.mockReturnValue([]);
  actions = [action(GLOBAL_PLUGIN, "acme.global.hello")];
  contributionsMock.panelKinds = [{ id: "acme.global.panel", extensionId: GLOBAL_PLUGIN }];
  contributionsMock.toolbarButtons = [{ id: "acme.global.btn", pluginId: GLOBAL_PLUGIN }];
  contributionsMock.keybindings = [{ pluginId: GLOBAL_PLUGIN, item: { key: "Ctrl+G" } }];
  contributionsMock.contextMenuItems = [{ pluginId: GLOBAL_PLUGIN, item: { label: "Global" } }];
  contributionsMock.agents = { "acme.agent": { id: "acme.agent" } };
  contributionsMock.recipes = [{ id: "acme.recipe" }];
});

describe("contribution scope registry", () => {
  it("treats an unregistered plugin as global and records nothing", () => {
    expect(getPluginContributionScope(GLOBAL_PLUGIN)).toBe("global");
    expect(hasProjectScopedContributions()).toBe(false);
  });

  it("registering a plugin as global stays absent from the project index", () => {
    setPluginContributionScope(GLOBAL_PLUGIN, "global");
    expect(hasProjectScopedContributions()).toBe(false);
    expect(getPluginContributionScope(GLOBAL_PLUGIN)).toBe("global");
  });

  it("records and clears a project scope", () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    expect(getPluginContributionScope(PROJECT_PLUGIN_A)).toBe(PROJECT_A);
    expect(hasProjectScopedContributions()).toBe(true);
    clearPluginContributionScope(PROJECT_PLUGIN_A);
    expect(getPluginContributionScope(PROJECT_PLUGIN_A)).toBe("global");
    expect(hasProjectScopedContributions()).toBe(false);
  });

  it("rejects an empty project id rather than silently making it global", () => {
    expect(() => setPluginContributionScope(PROJECT_PLUGIN_A, "")).toThrow(TypeError);
    expect(hasProjectScopedContributions()).toBe(false);
  });

  it("rejects an empty plugin id", () => {
    expect(() => setPluginContributionScope("", PROJECT_A)).toThrow(TypeError);
  });
});

describe("selectContributionsForProject", () => {
  const items = [
    { pluginId: GLOBAL_PLUGIN, id: "g" },
    { pluginId: PROJECT_PLUGIN_A, id: "a" },
    { pluginId: PROJECT_PLUGIN_B, id: "b" },
  ];
  const pluginIdOf = (item: { pluginId: string }) => item.pluginId;

  it("throws when no project context is supplied at all", () => {
    expect(() => selectContributionsForProject(items, pluginIdOf, undefined)).toThrow(
      /explicit project context/
    );
  });

  it("returns the input array by reference when nothing is project-scoped", () => {
    expect(selectContributionsForProject(items, pluginIdOf, PROJECT_A)).toBe(items);
    expect(selectContributionsForProject(items, pluginIdOf, null)).toBe(items);
  });

  it("narrows to global plus the named project", () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    expect(selectContributionsForProject(items, pluginIdOf, PROJECT_A).map((i) => i.id)).toEqual([
      "g",
      "a",
    ]);
    expect(selectContributionsForProject(items, pluginIdOf, PROJECT_B).map((i) => i.id)).toEqual([
      "g",
      "b",
    ]);
  });

  it("yields global only for a sender with no project binding", () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    expect(selectContributionsForProject(items, pluginIdOf, null).map((i) => i.id)).toEqual(["g"]);
  });

  it("fails closed on an empty-string project id — it matches no project, not every one", () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    expect(selectContributionsForProject(items, pluginIdOf, "").map((i) => i.id)).toEqual(["g"]);
  });
});

describe("mutation broadcasts with nothing project-scoped", () => {
  it("emits exactly one app-wide broadcast per channel and never a project one", async () => {
    const b = makeBroadcaster();
    b.broadcastPluginActions();
    b.schedulePanelKindsBroadcast();
    b.scheduleToolbarButtonsBroadcast(true);
    b.scheduleKeybindingsBroadcast(true);
    b.scheduleContextMenuItemsBroadcast(true);
    b.scheduleAgentsBroadcast(true);
    b.scheduleRecipesBroadcast(true);
    await flush();

    expect(ipcUtilsMock.broadcastToProjectRenderers).not.toHaveBeenCalled();
    const byName = new Map(
      ipcUtilsMock.broadcastToRenderer.mock.calls.map((call) => [
        (call[1] as { name: string }).name,
        call[1] as { payload: unknown },
      ])
    );
    expect(ipcUtilsMock.broadcastToRenderer).toHaveBeenCalledTimes(7);
    expect(byName.get("plugin:actions-changed")?.payload).toEqual({ actions });
    expect(byName.get("plugin:panel-kinds-changed")?.payload).toEqual({
      kinds: contributionsMock.panelKinds,
    });
    expect(byName.get("plugin:toolbar-buttons-changed")?.payload).toEqual({
      buttons: contributionsMock.toolbarButtons,
      complete: true,
    });
    expect(byName.get("plugin:keybindings-changed")?.payload).toEqual({
      keybindings: contributionsMock.keybindings,
      complete: true,
    });
    expect(byName.get("plugin:context-menu-items-changed")?.payload).toEqual({
      items: contributionsMock.contextMenuItems,
      complete: true,
    });
    expect(byName.get("plugin:agents-changed")?.payload).toEqual({
      agents: contributionsMock.agents,
      complete: true,
    });
    expect(byName.get("plugin:recipes-changed")?.payload).toEqual({
      recipes: contributionsMock.recipes,
      complete: true,
    });
    // Registered project views are irrelevant while every plugin is global —
    // the all-global path must not start consulting the view registry.
    expect(registryMock.getRegisteredProjectViews).not.toHaveBeenCalled();
    // Reference identity, not just deep equality: the all-global path must hand
    // the renderer the registry's own array, never a filtered copy.
    expect((byName.get("plugin:actions-changed")?.payload as { actions: unknown }).actions).toBe(
      actions
    );
    expect((byName.get("plugin:panel-kinds-changed")?.payload as { kinds: unknown }).kinds).toBe(
      contributionsMock.panelKinds
    );
    expect(
      (byName.get("plugin:toolbar-buttons-changed")?.payload as { buttons: unknown }).buttons
    ).toBe(contributionsMock.toolbarButtons);
    expect(
      (byName.get("plugin:keybindings-changed")?.payload as { keybindings: unknown }).keybindings
    ).toBe(contributionsMock.keybindings);
    expect(
      (byName.get("plugin:context-menu-items-changed")?.payload as { items: unknown }).items
    ).toBe(contributionsMock.contextMenuItems);
  });

  it("emits the seven channels in their historical order", async () => {
    const b = makeBroadcaster();
    b.broadcastPluginActions();
    b.schedulePanelKindsBroadcast();
    b.scheduleToolbarButtonsBroadcast(true);
    b.scheduleKeybindingsBroadcast(true);
    b.scheduleContextMenuItemsBroadcast(true);
    b.scheduleAgentsBroadcast(true);
    b.scheduleRecipesBroadcast(true);
    await flush();

    expect(
      ipcUtilsMock.broadcastToRenderer.mock.calls.map((call) => (call[1] as { name: string }).name)
    ).toEqual([
      "plugin:actions-changed",
      "plugin:panel-kinds-changed",
      "plugin:toolbar-buttons-changed",
      "plugin:keybindings-changed",
      "plugin:context-menu-items-changed",
      "plugin:agents-changed",
      "plugin:recipes-changed",
    ]);
    expect(
      ipcUtilsMock.broadcastToRenderer.mock.calls.every((call) => call[0] === CHANNELS.EVENTS_PUSH)
    ).toBe(true);
  });

  it("does not consult the view registry for the always-global agents and recipes channels", async () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    const b = makeBroadcaster();
    b.scheduleAgentsBroadcast(false);
    b.scheduleRecipesBroadcast(false);
    await flush();
    expect(ipcUtilsMock.broadcastToRenderer).toHaveBeenCalledTimes(2);
    expect(ipcUtilsMock.broadcastToProjectRenderers).not.toHaveBeenCalled();
  });
});

describe("project-scoped mutation broadcasts", () => {
  beforeEach(() => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    actions = [
      action(GLOBAL_PLUGIN, "acme.global.hello"),
      action(PROJECT_PLUGIN_A, "acme.local-a.hello"),
      action(PROJECT_PLUGIN_B, "acme.local-b.hello"),
    ];
    contributionsMock.panelKinds = [
      { id: "acme.global.panel", extensionId: GLOBAL_PLUGIN },
      { id: "acme.local-a.panel", extensionId: PROJECT_PLUGIN_A },
      { id: "acme.local-b.panel", extensionId: PROJECT_PLUGIN_B },
    ];
  });

  it("sends each project one merged snapshot and never a second message", async () => {
    const viewA = fakeWebContents(11);
    const viewB = fakeWebContents(22);
    registryMock.getRegisteredProjectViews.mockReturnValue([
      { webContents: viewA, projectId: PROJECT_A },
      { webContents: viewB, projectId: PROJECT_B },
    ]);
    registryMock.getAllAppWebContents.mockReturnValue([viewA, viewB]);

    const b = makeBroadcaster();
    b.schedulePanelKindsBroadcast();
    await flush();

    expect(ipcUtilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    expect(ipcUtilsMock.broadcastToProjectRenderers).toHaveBeenCalledTimes(2);
    const calls = ipcUtilsMock.broadcastToProjectRenderers.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([PROJECT_A, PROJECT_B]);
    expect(calls[0][1]).toBe(CHANNELS.EVENTS_PUSH);
    expect(
      (calls[0][2] as { payload: { kinds: Array<{ id: string }> } }).payload.kinds.map((k) => k.id)
    ).toEqual(["acme.global.panel", "acme.local-a.panel"]);
    expect(
      (calls[1][2] as { payload: { kinds: Array<{ id: string }> } }).payload.kinds.map((k) => k.id)
    ).toEqual(["acme.global.panel", "acme.local-b.panel"]);
    // Both webContents are project views — no unscoped direct send may follow.
    expect(viewA.send).not.toHaveBeenCalled();
    expect(viewB.send).not.toHaveBeenCalled();
  });

  it("gives a webContents that is not a project view the global slice only", async () => {
    const viewA = fakeWebContents(11);
    const picker = fakeWebContents(99);
    registryMock.getRegisteredProjectViews.mockReturnValue([
      { webContents: viewA, projectId: PROJECT_A },
    ]);
    registryMock.getAllAppWebContents.mockReturnValue([viewA, picker]);

    const b = makeBroadcaster();
    b.broadcastPluginActions();
    await flush();

    expect(sentPayloads(picker, "plugin:actions-changed")).toEqual([{ actions: [actions[0]] }]);
    expect(viewA.send).not.toHaveBeenCalled();
  });

  it("falls back to an app-wide broadcast of the global slice when no project view is registered", async () => {
    registryMock.getRegisteredProjectViews.mockReturnValue([]);
    const b = makeBroadcaster();
    b.broadcastPluginActions();
    await flush();

    expect(ipcUtilsMock.broadcastToProjectRenderers).not.toHaveBeenCalled();
    expect(ipcUtilsMock.broadcastToRenderer).toHaveBeenCalledTimes(1);
    expect(ipcUtilsMock.broadcastToRenderer.mock.calls[0][1]).toEqual({
      name: "plugin:actions-changed",
      payload: { actions: [actions[0]] },
    });
  });
});

describe("pushSnapshotTo", () => {
  it("replays the seven channels in order with unfiltered payloads when nothing is scoped", async () => {
    const wc = fakeWebContents(11);
    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents);

    expect(wc.send).toHaveBeenCalledTimes(7);
    expect(wc.send.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual([
      "plugin:actions-changed",
      "plugin:panel-kinds-changed",
      "plugin:toolbar-buttons-changed",
      "plugin:keybindings-changed",
      "plugin:context-menu-items-changed",
      "plugin:agents-changed",
      "plugin:recipes-changed",
    ]);
    expect(wc.send.mock.calls.map((c) => (c[1] as { payload: unknown }).payload)).toEqual([
      { actions },
      { kinds: contributionsMock.panelKinds },
      { buttons: contributionsMock.toolbarButtons, complete: false },
      { keybindings: contributionsMock.keybindings, complete: true },
      { items: contributionsMock.contextMenuItems, complete: false },
      { agents: contributionsMock.agents, complete: false },
      { recipes: contributionsMock.recipes, complete: false },
    ]);
  });

  it("resolves the target's own project rather than the active one", async () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    contributionsMock.panelKinds = [
      { id: "acme.global.panel", extensionId: GLOBAL_PLUGIN },
      { id: "acme.local-a.panel", extensionId: PROJECT_PLUGIN_A },
      { id: "acme.local-b.panel", extensionId: PROJECT_PLUGIN_B },
    ];
    const wc = fakeWebContents(11);
    registryMock.getProjectForWebContents.mockReturnValue(PROJECT_B);

    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents);

    expect(registryMock.getProjectForWebContents).toHaveBeenCalledWith(11);
    const [payload] = sentPayloads(wc, "plugin:panel-kinds-changed") as Array<{
      kinds: Array<{ id: string }>;
    }>;
    expect(payload.kinds.map((k) => k.id)).toEqual(["acme.global.panel", "acme.local-b.panel"]);
  });

  it("honours an explicitly supplied project id over the registry lookup", async () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    contributionsMock.panelKinds = [
      { id: "acme.global.panel", extensionId: GLOBAL_PLUGIN },
      { id: "acme.local-a.panel", extensionId: PROJECT_PLUGIN_A },
    ];
    const wc = fakeWebContents(11);
    registryMock.getProjectForWebContents.mockReturnValue(PROJECT_B);

    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents, PROJECT_A);

    const [payload] = sentPayloads(wc, "plugin:panel-kinds-changed") as Array<{
      kinds: Array<{ id: string }>;
    }>;
    expect(payload.kinds.map((k) => k.id)).toEqual(["acme.global.panel", "acme.local-a.panel"]);
  });

  it("fails closed when the target's project cannot be resolved — global only, never another project's", async () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    setPluginContributionScope(PROJECT_PLUGIN_B, PROJECT_B);
    contributionsMock.panelKinds = [
      { id: "acme.global.panel", extensionId: GLOBAL_PLUGIN },
      { id: "acme.local-a.panel", extensionId: PROJECT_PLUGIN_A },
      { id: "acme.local-b.panel", extensionId: PROJECT_PLUGIN_B },
    ];
    const wc = fakeWebContents(11);
    registryMock.getProjectForWebContents.mockReturnValue(null);

    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents);

    const [payload] = sentPayloads(wc, "plugin:panel-kinds-changed") as Array<{
      kinds: Array<{ id: string }>;
    }>;
    expect(payload.kinds.map((k) => k.id)).toEqual(["acme.global.panel"]);
  });

  it("fails closed on an empty-string project id", async () => {
    setPluginContributionScope(PROJECT_PLUGIN_A, PROJECT_A);
    contributionsMock.panelKinds = [
      { id: "acme.global.panel", extensionId: GLOBAL_PLUGIN },
      { id: "acme.local-a.panel", extensionId: PROJECT_PLUGIN_A },
    ];
    const wc = fakeWebContents(11);

    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents, "");

    const [payload] = sentPayloads(wc, "plugin:panel-kinds-changed") as Array<{
      kinds: Array<{ id: string }>;
    }>;
    expect(payload.kinds.map((k) => k.id)).toEqual(["acme.global.panel"]);
  });

  it("keeps sending the remaining channels when one send throws (TOCTOU)", async () => {
    const wc = fakeWebContents(11);
    wc.send.mockImplementationOnce(() => {
      throw new Error("destroyed");
    });
    const b = makeBroadcaster();
    await b.pushSnapshotTo(wc as unknown as Electron.WebContents);
    expect(wc.send).toHaveBeenCalledTimes(7);
  });

  it("skips a destroyed webContents and a disposed service", async () => {
    const destroyed = { ...fakeWebContents(11), isDestroyed: () => true };
    const b = makeBroadcaster();
    await b.pushSnapshotTo(destroyed as unknown as Electron.WebContents);
    expect(destroyed.send).not.toHaveBeenCalled();

    const wc = fakeWebContents(12);
    const disposed = new PluginContributionBroadcaster({
      isDisposed: () => true,
      listPluginActions: () => actions,
      initPromise: Promise.resolve(),
    });
    await disposed.pushSnapshotTo(wc as unknown as Electron.WebContents);
    expect(wc.send).not.toHaveBeenCalled();
  });
});
