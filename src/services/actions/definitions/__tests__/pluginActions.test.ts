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
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
