import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clientMocks = vi.hoisted(() => ({
  validateManifest: vi.fn(),
  getDiagnosticsSnapshot: vi.fn(),
  getProjectPlugins: vi.fn(),
  reloadProjectPlugins: vi.fn(),
  list: vi.fn(),
  backupDatabases: vi.fn(),
}));

vi.mock("@/clients/pluginClient", () => ({ pluginClient: clientMocks }));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

const revealMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/clients/systemClient", () => ({
  systemClient: { showItemInFolderUnconfined: revealMock },
}));

const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, { id: string; kind?: string; title: string }>,
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => panelState },
}));

import { registerPluginActions } from "../pluginActions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  registerUserViewReload,
  resetPluginPanelLifecycleForTests,
  setViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";
import { usePluginPanelReloadConfirmStore } from "@/store/pluginPanelReloadConfirmStore";
import { ConfirmationStagedError } from "../../confirmationStaged";
import { DENY_PLUGIN_DISPATCH_ACTION_IDS } from "@shared/config/actionIds";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectStore } from "@/store/projectStore";

/**
 * These actions ignore the callbacks entirely — they reach main through the
 * plugin client, never through renderer UI hooks — but the registrar signature
 * is shared, so the shape still has to be satisfied. Spelled out rather than
 * asserted from an empty object: the assertion would be an unsafe one, and a
 * literal turns a future change to the interface into a compile error here
 * instead of a silent hole.
 */
function stubCallbacks(): ActionCallbacks {
  return {
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenResumeSessionsPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
    onAddTerminal: async () => {},
  };
}

function definitions(): ActionRegistry {
  const registry: ActionRegistry = new Map();
  registerPluginActions(registry, stubCallbacks());
  return registry;
}

function definition(id: string): AnyActionDefinition {
  const factory = definitions().get(id);
  if (!factory) throw new Error(`${id} was not registered`);
  return factory();
}

/** Every `ActionContext` field is optional, so a bare context needs no cast. */
const EMPTY_CONTEXT: ActionContext = {};

// Return type is inferred from `AnyActionDefinition`, so assertions are not
// needed at the call sites and none is introduced here either.
async function run(id: string, args: unknown = {}, ctx: ActionContext = EMPTY_CONTEXT) {
  return definition(id).run(args, ctx);
}

/** A sender that owns `project-1`, which is what scopes an instance-key match. */
const PROJECT_1: ActionContext = { projectId: "project-1" };

function logLine(ts: number, message: string) {
  return { ts, level: "info" as const, message };
}

function snapshotEntry(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "acme.demo",
    displayName: "Demo",
    version: "1.0.0",
    source: "sideload",
    installedAt: 1,
    isBuiltin: false,
    devMode: false,
    disabled: false,
    archiveHash: null,
    loadError: null,
    logLines: [],
    auditRecords: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.getProjectPlugins.mockResolvedValue([]);
  clientMocks.reloadProjectPlugins.mockResolvedValue(undefined);
});

describe("plugin.validate", () => {
  it("forwards the path and returns the verdict unchanged", async () => {
    const verdict = {
      manifestPath: "/p/.daintree/plugins/acme.demo/plugin.json",
      origin: "project",
      originSource: "location",
      valid: false,
      pluginId: "acme.demo",
      errors: [{ path: "contributes.panels.0.color", message: "Required" }],
      warnings: [],
    };
    clientMocks.validateManifest.mockResolvedValue(verdict);

    await expect(run("plugin.validate", { path: ".daintree/plugins/acme.demo" })).resolves.toEqual(
      verdict
    );
    expect(clientMocks.validateManifest).toHaveBeenCalledWith(".daintree/plugins/acme.demo");
  });

  it("lets a rejection propagate rather than reporting a false verdict", async () => {
    clientMocks.validateManifest.mockRejectedValue(new Error("outside this project"));
    await expect(run("plugin.validate", { path: "/etc" })).rejects.toThrow(/outside this project/);
  });
});

describe("plugin.diagnostics", () => {
  it("returns only the named plugin's own diagnostics", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({ pluginId: "other.plugin", logLines: [logLine(1, "someone else's line")] }),
        snapshotEntry({ logLines: [logLine(2, "mine")] }),
      ],
    });

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(result.pluginId).toBe("acme.demo");
    expect(result.logLines).toEqual([{ ts: 2, level: "info", message: "mine" }]);
    expect(JSON.stringify(result)).not.toContain("someone else");
  });

  it("finds a project plugin by its manifest id, not only its instance key", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          pluginId: "project__project-1__acme.demo",
          logLines: [logLine(9, "project line")],
        }),
      ],
    });

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" }, PROJECT_1);
    expect(result.loaded).toBe(true);
    expect(result.logLines).toEqual([{ ts: 9, level: "info", message: "project line" }]);
    // Answers with the id the caller asked with; the instance key names a
    // project and is not theirs to hold.
    expect(result.pluginId).toBe("acme.demo");
  });

  it("never answers with another project's copy of the same plugin id", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          pluginId: "project__project-2__acme.demo",
          logLines: [logLine(1, "other project's secret path")],
        }),
      ],
    });

    // The snapshot is app-global, so project-2's copy is visible here. It must
    // not answer for project-1, and the failure must not quote its lines.
    await expect(run("plugin.diagnostics", { pluginId: "acme.demo" }, PROJECT_1)).rejects.toThrow(
      /No plugin "acme\.demo"/
    );
    expect(clientMocks.getDiagnosticsSnapshot).toHaveBeenCalled();
  });

  it("matches no instance key at all when the sender has no project", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [snapshotEntry({ pluginId: "project__project-1__acme.demo" })],
    });

    await expect(run("plugin.diagnostics", { pluginId: "acme.demo" })).rejects.toThrow(
      /No plugin "acme\.demo"/
    );
  });

  it("reports unknown ids as manifest ids, never as instance keys", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [snapshotEntry({ pluginId: "project__project-1__acme.other" })],
    });

    const message = await run("plugin.diagnostics", { pluginId: "acme.nope" }, PROJECT_1).then(
      () => "resolved, but should have thrown",
      (err: unknown) => formatErrorMessage(err, "threw without a message")
    );
    expect(message).toContain("acme.other");
    expect(message).not.toContain("project__");
  });

  it("carries no install provenance or audit trail into the result", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          archiveHash: "deadbeef",
          auditRecords: [{ pluginId: "acme.demo", actionId: "x" }],
        }),
      ],
    });

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(result).not.toHaveProperty("archiveHash");
    expect(result).not.toHaveProperty("auditRecords");
    expect(result).not.toHaveProperty("source");
  });

  it("returns the newest lines up to the limit, and says how many exist", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          logLines: [logLine(1, "a"), logLine(2, "b"), logLine(3, "c")],
        }),
      ],
    });

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo", logLimit: 2 });
    expect(result.logLines.map((l: { message: string }) => l.message)).toEqual(["b", "c"]);
    expect(result.logLinesAvailable).toBe(3);
  });

  it("returns the newest 50 lines by default, not the whole buffer", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          logLines: Array.from({ length: 51 }, (_, i) => logLine(i, `line-${i}`)),
        }),
      ],
    });

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(result.logLines).toHaveLength(50);
    expect(result.logLines[0].message).toBe("line-1");
    expect(result.logLinesAvailable).toBe(51);
  });

  it("propagates a snapshot read failure instead of reporting an empty buffer", async () => {
    clientMocks.getDiagnosticsSnapshot.mockRejectedValue(new Error("IPC gone"));
    await expect(run("plugin.diagnostics", { pluginId: "acme.demo" })).rejects.toThrow(/IPC gone/);
  });

  it("bounds the log tail in the schema, not only in the handler", () => {
    const schema = definition("plugin.diagnostics").argsSchema;
    const parse = (logLimit: unknown) => schema?.safeParse({ pluginId: "a.b", logLimit }).success;
    expect(parse(0)).toBe(false);
    expect(parse(501)).toBe(false);
    expect(parse(1.5)).toBe(false);
    expect(parse(1)).toBe(true);
    expect(parse(500)).toBe(true);
  });

  it("reports a refused project plugin with its rejection rather than as missing", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({ plugins: [] });
    clientMocks.getProjectPlugins.mockResolvedValue([
      {
        projectId: "p1",
        id: "acme.demo",
        displayName: "Demo",
        version: "0.0.0",
        capabilities: [],
        dirName: "acme.demo",
        state: "invalid",
        error: "contributes.panels.0.color: Required",
        collidesWithGlobal: false,
      },
    ]);

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(result.loaded).toBe(false);
    expect(result.projectState).toBe("invalid");
    expect(result.loadError.message).toContain("color");
  });

  it("throws and enumerates the ids it does know for an unknown plugin", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [snapshotEntry({ pluginId: "acme.other" })],
    });

    await expect(run("plugin.diagnostics", { pluginId: "acme.nope" })).rejects.toThrow(
      /acme\.other/
    );
  });

  it("says so plainly when nothing is loaded at all", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({ plugins: [] });
    await expect(run("plugin.diagnostics", { pluginId: "acme.nope" })).rejects.toThrow(
      /no plugins are loaded/
    );
  });
});

describe("plugin.reloadProject", () => {
  it("reloads, then reports the state of every directory found", async () => {
    const projectRows = [
      {
        projectId: "p1",
        id: "acme.demo",
        displayName: "Demo",
        version: "1.0.0",
        capabilities: [],
        dirName: "acme.demo",
        state: "staged",
        collidesWithGlobal: false,
      },
    ];

    // The list must be read AFTER the reload, or it reports pre-reload state
    // and the action's whole promise is void. Asserted by ordering, not by the
    // eventual value, which a list-then-reload implementation would also match.
    let reloadFinished = false;
    clientMocks.reloadProjectPlugins.mockImplementation(async () => {
      reloadFinished = true;
    });
    clientMocks.getProjectPlugins.mockImplementation(async () => {
      expect(reloadFinished).toBe(true);
      return projectRows;
    });

    const result = await run("plugin.reloadProject");
    expect(clientMocks.reloadProjectPlugins).toHaveBeenCalledOnce();
    expect(result.plugins).toEqual([
      {
        id: "acme.demo",
        dirName: "acme.demo",
        displayName: "Demo",
        version: "1.0.0",
        state: "staged",
        error: null,
        collidesWithGlobal: false,
      },
    ]);
  });

  it("lets a reload failure propagate instead of reporting an empty success", async () => {
    clientMocks.reloadProjectPlugins.mockRejectedValue(new Error("sender has no project"));
    await expect(run("plugin.reloadProject")).rejects.toThrow(/sender has no project/);
    expect(clientMocks.getProjectPlugins).not.toHaveBeenCalled();
  });

  it("still reloads for a project that has no plugins yet", async () => {
    clientMocks.getProjectPlugins.mockResolvedValue([]);

    const result = await run("plugin.reloadProject");
    expect(clientMocks.reloadProjectPlugins).toHaveBeenCalledOnce();
    expect(result.plugins).toEqual([]);
  });

  it("propagates a failure to list, even once the reload itself succeeded", async () => {
    clientMocks.getProjectPlugins.mockRejectedValue(new Error("project closed mid-reload"));
    await expect(run("plugin.reloadProject")).rejects.toThrow(/project closed mid-reload/);
  });

  it("refuses plugin-sourced dispatch, since it would unload the caller", () => {
    expect(definition("plugin.reloadProject").denyPluginDispatch).toBe(true);
  });
});

describe("result schemas", () => {
  it("describe what run() actually returns, since dispatch parses through them", async () => {
    clientMocks.getDiagnosticsSnapshot.mockResolvedValue({
      plugins: [
        snapshotEntry({
          loadError: { message: "boom", stack: "at x", at: 42 },
          logLines: [logLine(1, "a")],
        }),
      ],
    });

    const def = definition("plugin.diagnostics");
    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(def.resultSchema?.safeParse(result).success).toBe(true);
  });

  it("holds for the reload result too", async () => {
    clientMocks.getProjectPlugins.mockResolvedValue([]);
    const def = definition("plugin.reloadProject");
    const result = await run("plugin.reloadProject");
    expect(def.resultSchema?.safeParse(result).success).toBe(true);
  });
});

describe("plugin.reloadPanel (#12611)", () => {
  beforeEach(() => {
    resetPluginPanelLifecycleForTests();
    usePluginPanelReloadConfirmStore.setState({ pending: null, approvedPanelId: null });
    panelState.panelsById = {
      "plugin-1": { id: "plugin-1", kind: "acme.dashboard", title: "Dashboard" },
      "file-1": { id: "file-1", kind: "file", title: "README.md" },
      "term-1": { id: "term-1", kind: "terminal", title: "Shell" },
    };
  });

  it("is an MCP-safe manifest entry: explicit panelId, unrepeatable, closed to plugins", () => {
    const def = definition("plugin.reloadPanel");
    expect(def.danger).toBe("safe");
    expect(def.nonRepeatable).toBe(true);
    expect(def.denyPluginDispatch).toBe(true);
    expect((DENY_PLUGIN_DISPATCH_ACTION_IDS as readonly string[]).includes(def.id)).toBe(true);
    expect(def.mcpOutputSchema).toBe(true);
    expect(def.mcpAnnotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(def.argsSchema?.safeParse({}).success).toBe(false);
    expect(def.argsSchema?.safeParse({ panelId: "" }).success).toBe(false);
    expect(def.argsSchema?.safeParse({ panelId: "plugin-1" }).success).toBe(true);
  });

  it("hands the reload to the mounted view and reports it scheduled", async () => {
    const handler = vi.fn();
    registerUserViewReload("plugin-1", handler);
    const def = definition("plugin.reloadPanel");

    const result = await run("plugin.reloadPanel", { panelId: "plugin-1" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ panelId: "plugin-1", outcome: "scheduled" });
    expect(def.resultSchema?.safeParse(result).success).toBe(true);
  });

  it("reports a panel with no mounted view as not mounted", async () => {
    const result = await run("plugin.reloadPanel", { panelId: "plugin-1" });
    expect(result).toEqual({ panelId: "plugin-1", outcome: "not-mounted" });
  });

  it("refuses an unknown panel and one that is not a plugin's", async () => {
    await expect(run("plugin.reloadPanel", { panelId: "nope" })).rejects.toThrow(/No panel/);
    await expect(run("plugin.reloadPanel", { panelId: "file-1" })).rejects.toThrow(
      /not a plugin panel/
    );
    await expect(run("plugin.reloadPanel", { panelId: "term-1" })).rejects.toThrow(
      /not a plugin panel/
    );
  });

  it("stages the confirmation instead of reloading a view with unsaved work", async () => {
    const handler = vi.fn();
    registerUserViewReload("plugin-1", handler);
    setViewUnsavedChanges("plugin-1", {}, true);

    await expect(run("plugin.reloadPanel", { panelId: "plugin-1" })).rejects.toBeInstanceOf(
      ConfirmationStagedError
    );
    expect(handler).not.toHaveBeenCalled();
    expect(usePluginPanelReloadConfirmStore.getState().pending).toEqual({
      panelId: "plugin-1",
      panelTitle: "Dashboard",
    });
  });

  it("stages it for an agent too: no argument skips the dialog", async () => {
    const handler = vi.fn();
    registerUserViewReload("plugin-1", handler);
    setViewUnsavedChanges("plugin-1", {}, true);

    await expect(
      run(
        "plugin.reloadPanel",
        { panelId: "plugin-1", confirmed: true },
        { dispatchSource: "agent", hostConfirmed: true }
      )
    ).rejects.toBeInstanceOf(ConfirmationStagedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reloads once after the user approves, then asks again", async () => {
    const handler = vi.fn();
    registerUserViewReload("plugin-1", handler);
    setViewUnsavedChanges("plugin-1", {}, true);
    usePluginPanelReloadConfirmStore.getState().approve("plugin-1");

    await expect(run("plugin.reloadPanel", { panelId: "plugin-1" })).resolves.toEqual({
      panelId: "plugin-1",
      outcome: "scheduled",
    });
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(run("plugin.reloadPanel", { panelId: "plugin-1" })).rejects.toBeInstanceOf(
      ConfirmationStagedError
    );
  });

  it("leaves an approval for its own panel when another panel reloads", async () => {
    panelState.panelsById["plugin-2"] = { id: "plugin-2", kind: "acme.dashboard", title: "Two" };
    usePluginPanelReloadConfirmStore.getState().approve("plugin-1");

    await run("plugin.reloadPanel", { panelId: "plugin-2" });

    expect(usePluginPanelReloadConfirmStore.getState().consumeApproval("plugin-1")).toBe(true);
  });

  it("spends the approval even when the approved panel has gone", async () => {
    usePluginPanelReloadConfirmStore.getState().approve("gone-1");

    await expect(run("plugin.reloadPanel", { panelId: "gone-1" })).rejects.toThrow(/No panel/);
    expect(usePluginPanelReloadConfirmStore.getState().approvedPanelId).toBeNull();
  });

  it("stages through ActionService for an agent, as a recognisable staged confirmation", async () => {
    const { ActionService } = await import("../../../ActionService");
    const { isStagedConfirmation } = await import("../../confirmationStaged");
    const service = new ActionService();
    service.register(definition("plugin.reloadPanel"));
    const handler = vi.fn();
    registerUserViewReload("plugin-1", handler);
    setViewUnsavedChanges("plugin-1", {}, true);

    for (const args of [{ panelId: "plugin-1" }, { panelId: "plugin-1", confirmed: true }]) {
      const result = await service.dispatch("plugin.reloadPanel", args, { source: "agent" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(isStagedConfirmation(result.error)).toBe(true);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(usePluginPanelReloadConfirmStore.getState().pending?.panelId).toBe("plugin-1");
  });

  it("does not let one panel's approval cover another", async () => {
    panelState.panelsById["plugin-2"] = { id: "plugin-2", kind: "acme.dashboard", title: "Two" };
    setViewUnsavedChanges("plugin-2", {}, true);
    usePluginPanelReloadConfirmStore.getState().approve("plugin-1");

    await expect(run("plugin.reloadPanel", { panelId: "plugin-2" })).rejects.toBeInstanceOf(
      ConfirmationStagedError
    );
  });
});

describe("plugin.openSettings", () => {
  const PROJECT_KEY = "project__project-1__acme.linear";

  function loaded(
    instanceId: string,
    overrides: {
      settings?: Array<{ id: string; scope?: "user" | "project" | "local" }>;
      declaresView?: boolean;
    } = {}
  ) {
    const parts = instanceId.split("__");
    const isProject = parts.length === 3;
    return {
      instanceId,
      origin: isProject ? "project" : "global",
      projectId: isProject ? parts[1] : null,
      manifest: {
        name: isProject ? parts[2] : instanceId,
        contributes: {
          settings: overrides.settings ?? [{ id: "apiKey" }],
          views: overrides.declaresView
            ? [{ id: "prefs", componentPath: "dist/prefs.js", location: "settings" }]
            : [],
        },
      },
    };
  }

  async function openSettings(args: unknown, ctx: ActionContext = PROJECT_1) {
    const onOpenSettingsTab = vi.fn();
    const registry: ActionRegistry = new Map();
    registerPluginActions(registry, { ...stubCallbacks(), onOpenSettingsTab });
    const result = await registry.get("plugin.openSettings")!().run(args, ctx);
    return { result, onOpenSettingsTab };
  }

  beforeEach(() => {
    usePluginManagerStore.setState({ isOpen: false, settingsRequest: null });
    vi.spyOn(useProjectStore, "getState").mockReturnValue(
      // Only `currentProject` is read, as the fallback when the context has none.
      Object.assign(Object.create(null), { currentProject: null })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an installed plugin's own settings to the plugin manager", async () => {
    clientMocks.list.mockResolvedValue([loaded("acme.linear")]);

    const { result, onOpenSettingsTab } = await openSettings({
      pluginId: "acme.linear",
      key: "apiKey",
    });

    // What was requested, not a claim that anything was landed on yet.
    expect(result).toEqual({
      pluginId: "acme.linear",
      home: "plugin-manager",
      requestedKey: "apiKey",
    });
    expect(onOpenSettingsTab).not.toHaveBeenCalled();
    const state = usePluginManagerStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.settingsRequest).toMatchObject({
      pluginId: "acme.linear",
      key: "apiKey",
      home: "manager",
    });
  });

  it("sends an installed plugin's project-scoped key to Project settings → Plugins", async () => {
    clientMocks.list.mockResolvedValue([
      loaded("acme.linear", { settings: [{ id: "apiKey" }, { id: "team", scope: "project" }] }),
    ]);

    const { result, onOpenSettingsTab } = await openSettings({
      pluginId: "acme.linear",
      key: "team",
    });

    expect(result).toMatchObject({ home: "project-settings", requestedKey: "team" });
    expect(onOpenSettingsTab).toHaveBeenCalledWith({ tab: "project:plugins" });
    expect(usePluginManagerStore.getState().isOpen).toBe(false);
    expect(usePluginManagerStore.getState().settingsRequest?.home).toBe("project");
  });

  it("refuses a project-scoped destination with no project open, instead of rerouting it", async () => {
    clientMocks.list.mockResolvedValue([
      loaded("acme.linear", { settings: [{ id: "apiKey" }, { id: "team", scope: "local" }] }),
      loaded("acme.projectonly", { settings: [{ id: "team", scope: "project" }] }),
    ]);

    await expect(openSettings({ pluginId: "acme.linear", key: "team" }, {})).rejects.toThrow(
      /keeps "team" in Project settings, and no project is open/
    );
    // Nothing the manager would show: keyless is refused the same way.
    await expect(openSettings({ pluginId: "acme.projectonly" }, {})).rejects.toThrow(
      /no project is open/
    );
    expect(usePluginManagerStore.getState().settingsRequest).toBeNull();
    // Its own settings still open in the manager without a project.
    const { result } = await openSettings({ pluginId: "acme.linear" }, {});
    expect(result).toMatchObject({ home: "plugin-manager", requestedKey: null });
  });

  it("keeps an installed plugin's exact identity when a project plugin shares its id", async () => {
    clientMocks.list.mockResolvedValue([loaded("acme.linear"), loaded(PROJECT_KEY)]);

    // The id an installed plugin's own host and panels pass is its manifest id.
    const installed = await openSettings({ pluginId: "acme.linear" });
    expect(installed.result).toMatchObject({ home: "plugin-manager" });
    expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe("acme.linear");

    const project = await openSettings({ pluginId: PROJECT_KEY });
    expect(project.result).toMatchObject({ home: "project-settings" });
    expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe(PROJECT_KEY);
  });

  it("resolves a manifest id to this project's own plugin when nothing installed has it", async () => {
    clientMocks.list.mockResolvedValue([loaded(PROJECT_KEY)]);

    const { result, onOpenSettingsTab } = await openSettings({ pluginId: "acme.linear" });
    expect(result).toEqual({
      pluginId: "acme.linear",
      home: "project-settings",
      requestedKey: null,
    });
    expect(onOpenSettingsTab).toHaveBeenCalledWith({ tab: "project:plugins" });
    expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe(PROJECT_KEY);
  });

  it("never reaches another project's plugin", async () => {
    const otherKey = "project__project-2__acme.linear";
    clientMocks.list.mockResolvedValue([loaded(otherKey)]);

    await expect(openSettings({ pluginId: otherKey })).rejects.toThrow(/No plugin/);
    await expect(openSettings({ pluginId: "acme.linear" })).rejects.toThrow(/No plugin/);
  });

  it("ignores an undeclared key, refuses a plugin with no settings, and reads a view off the manifest", async () => {
    clientMocks.list.mockResolvedValue([
      loaded("acme.linear"),
      loaded("acme.bare", { settings: [] }),
      // Declared but stopped: no module URL, and its settings are still reachable.
      loaded("acme.custom", { settings: [], declaresView: true }),
    ]);

    const { result } = await openSettings({ pluginId: "acme.linear", key: "nope" });
    expect(result).toMatchObject({ home: "plugin-manager", requestedKey: null });
    await expect(openSettings({ pluginId: "acme.bare" })).rejects.toThrow(/has no settings/);
    const custom = await openSettings({ pluginId: "acme.custom" });
    expect(custom.result).toMatchObject({ home: "plugin-manager" });
  });

  it("is reachable from menus and a plugin's own host, and from no agent", () => {
    const def = definition("plugin.openSettings");
    expect(def.denyPluginDispatch).not.toBe(true);
    expect(DENY_PLUGIN_DISPATCH_ACTION_IDS).not.toContain("plugin.openSettings");
    expect(def.mcpVisibility).toBe("hidden");
  });
});

describe("plugin.backupDatabases", () => {
  beforeEach(() => {
    clientMocks.backupDatabases.mockReset();
    notifyMock.mockReset();
    revealMock.mockClear();
  });

  it("names only the plugin, and main does the rest", async () => {
    clientMocks.backupDatabases.mockResolvedValue({ status: "cancelled" });
    await run("plugin.backupDatabases", { pluginId: "acme.ledger" });

    expect(clientMocks.backupDatabases).toHaveBeenCalledWith("acme.ledger");
  });

  it("says nothing when the dialog was dismissed", async () => {
    clientMocks.backupDatabases.mockResolvedValue({ status: "cancelled" });
    await run("plugin.backupDatabases", { pluginId: "acme.ledger" });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("says so when the plugin has nothing on disk yet", async () => {
    clientMocks.backupDatabases.mockResolvedValue({ status: "no-data", pluginName: "Ledger" });
    await run("plugin.backupDatabases", { pluginId: "acme.ledger" });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("info");
    expect(payload.message).toBe("Ledger has no data to back up yet");
    expect(payload.action).toBeUndefined();
  });

  it("reports where one file went, with a way to reveal it", async () => {
    clientMocks.backupDatabases.mockResolvedValue({
      status: "saved",
      pluginName: "Ledger",
      paths: ["/Users/me/Downloads/ledger.db"],
    });
    await run("plugin.backupDatabases", { pluginId: "acme.ledger" });

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("success");
    expect(payload.title).toBe("Ledger data backed up");
    expect(payload.message).toContain("/Users/me/Downloads/ledger.db");
    payload.action.onClick();
    expect(revealMock).toHaveBeenCalledWith("/Users/me/Downloads/ledger.db");
  });

  it("reports a folder of files by their count and folder", async () => {
    clientMocks.backupDatabases.mockResolvedValue({
      status: "saved",
      pluginName: "Ledger",
      paths: ["C:\\Backups\\a.db", "C:\\Backups\\b.db"],
    });
    await run("plugin.backupDatabases", { pluginId: "acme.ledger" });

    expect(notifyMock.mock.calls[0]![0].message).toBe("2 databases saved to C:\\Backups");
  });

  it("reports a failure in main's words with one way to try again, and still fails", async () => {
    clientMocks.backupDatabases.mockRejectedValue(new Error("backup.db already exists in /tmp."));

    await expect(run("plugin.backupDatabases", { pluginId: "acme.ledger" })).rejects.toThrow(
      "already exists"
    );
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("error");
    expect(payload.message).toBe("backup.db already exists in /tmp.");
    expect(payload.action.label).toBe("Try again");
  });

  it("is UI only: closed to plugins and hidden from agents", () => {
    const def = definition("plugin.backupDatabases");
    expect(def.denyPluginDispatch).toBe(true);
    expect(DENY_PLUGIN_DISPATCH_ACTION_IDS).toContain("plugin.backupDatabases");
    expect(def.mcpVisibility).toBe("hidden");
  });
});
