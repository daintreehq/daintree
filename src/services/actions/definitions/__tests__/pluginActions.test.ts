import { describe, it, expect, vi, beforeEach } from "vitest";

const clientMocks = vi.hoisted(() => ({
  validateManifest: vi.fn(),
  getDiagnosticsSnapshot: vi.fn(),
  getProjectPlugins: vi.fn(),
  reloadProjectPlugins: vi.fn(),
}));

vi.mock("@/clients/pluginClient", () => ({ pluginClient: clientMocks }));

import { registerPluginActions } from "../pluginActions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

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

/** Every `ActionContext` field is optional, so the empty context needs no cast. */
const EMPTY_CONTEXT: ActionContext = {};

// Return type is inferred from `AnyActionDefinition`, so assertions are not
// needed at the call sites and none is introduced here either.
async function run(id: string, args: unknown = {}) {
  return definition(id).run(args, EMPTY_CONTEXT);
}

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
      ok: false,
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

    const result = await run("plugin.diagnostics", { pluginId: "acme.demo" });
    expect(result.loaded).toBe(true);
    expect(result.logLines).toEqual([{ ts: 9, level: "info", message: "project line" }]);
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
    clientMocks.getProjectPlugins.mockResolvedValue([
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
    ]);

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
