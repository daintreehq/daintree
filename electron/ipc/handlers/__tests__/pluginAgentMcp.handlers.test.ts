import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedPluginInfo, PluginManifest } from "../../../../shared/types/plugin.js";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  listPlugins: vi.fn<() => LoadedPluginInfo[]>(() => []),
  hasPlugin: vi.fn<(id: string) => boolean>(() => true),
  waitForInit: vi.fn(() => Promise.resolve()),
  isMcpEnabled: vi.fn(() => true),
  listEnabled: vi.fn<
    (projectId: string) => Array<{ pluginInstanceId: string; endpointId: string }>
  >(() => []),
  setEnabled: vi.fn(),
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: (id: number) => mocks.getProjectForWebContents(id),
  getWindowForWebContents: () => null,
}));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: () => mocks.listPlugins(),
    hasPlugin: (id: string) => mocks.hasPlugin(id),
    waitForInit: () => mocks.waitForInit(),
  },
}));

vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: { isEnabled: () => mocks.isMcpEnabled() },
}));

vi.mock("../../../services/pluginAgentMcp/projectEnablement.js", () => ({
  listEnabledAgentMcpEndpoints: (projectId: string) => mocks.listEnabled(projectId),
  setAgentMcpEndpointEnabled: (...args: unknown[]) => mocks.setEnabled(...args),
}));

import { ipcMain } from "electron";
import { registerPluginAgentMcpHandlers } from "../pluginAgentMcp.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../ipcGuard.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const match = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match[1] as Handler;
}

const LIST = "plugin-agent-mcp:list-project-endpoints";
const SET = "plugin-agent-mcp:set-project-endpoint-enabled";
const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const EVENT = { sender: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent;

function plugin(over: {
  instanceId?: string;
  origin?: "global" | "project";
  projectId?: string | null;
  disabled?: boolean;
  agentMcp?: PluginManifest["contributes"]["agentMcp"];
}): LoadedPluginInfo {
  const instanceId = over.instanceId ?? "acme.ledger";
  return {
    manifest: {
      name: "acme.ledger",
      version: "1.0.0",
      displayName: "Ledger",
      capabilities: ["mcp:expose"],
      contributes: {
        agentMcp: over.agentMcp ?? [
          { id: "data", name: "Household ledger", description: "Reads entries", mode: "tools" },
        ],
      },
    } as unknown as PluginManifest,
    instanceId,
    origin: over.origin ?? "global",
    projectId: over.projectId ?? null,
    disabled: over.disabled ?? false,
    blocklisted: false,
  } as unknown as LoadedPluginInfo;
}

let dispose: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProjectForWebContents.mockReturnValue(PROJECT);
  mocks.listPlugins.mockReturnValue([plugin({})]);
  mocks.hasPlugin.mockReturnValue(true);
  mocks.isMcpEnabled.mockReturnValue(true);
  mocks.listEnabled.mockReturnValue([]);
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
  dispose = registerPluginAgentMcpHandlers();
});

afterEach(() => {
  dispose();
});

describe("plugin agent MCP consent IPC", () => {
  it("lists what the sender's project could expose, with each endpoint's state", async () => {
    mocks.listEnabled.mockReturnValue([{ pluginInstanceId: "acme.ledger", endpointId: "data" }]);

    const result = await getHandler(LIST)(EVENT);

    expect(mocks.listEnabled).toHaveBeenCalledWith(PROJECT);
    expect(result).toEqual({
      endpoints: [
        {
          pluginInstanceId: "acme.ledger",
          pluginDisplayName: "Ledger",
          endpointId: "data",
          name: "Household ledger",
          description: "Reads entries",
          enabled: true,
          available: true,
        },
      ],
      mcpServerEnabled: true,
    });
  });

  it("reports a declared endpoint that was never turned on as off", async () => {
    const result = (await getHandler(LIST)(EVENT)) as { endpoints: Array<{ enabled: boolean }> };

    expect(result.endpoints.map((e) => e.enabled)).toEqual([false]);
  });

  it("keeps an answer left on by a plugin that is no longer running, so it can be revoked", async () => {
    mocks.hasPlugin.mockReturnValue(false);
    mocks.listEnabled.mockReturnValue([{ pluginInstanceId: "acme.ledger", endpointId: "data" }]);

    const result = (await getHandler(LIST)(EVENT)) as {
      endpoints: Array<{ name: string; enabled: boolean; available: boolean }>;
    };

    expect(result.endpoints).toEqual([
      expect.objectContaining({ name: "Household ledger", enabled: true, available: false }),
    ]);
  });

  it("names a plugin and endpoint by id when the manifest leaves the names blank", async () => {
    const blank = plugin({ agentMcp: [{ id: "data", name: " ", mode: "tools" }] });
    (blank.manifest as { displayName?: string }).displayName = "";
    mocks.listPlugins.mockReturnValue([blank]);

    const result = (await getHandler(LIST)(EVENT)) as {
      endpoints: Array<{ pluginDisplayName: string; name: string }>;
    };

    expect(result.endpoints).toEqual([
      expect.objectContaining({ pluginDisplayName: "acme.ledger", name: "data" }),
    ]);
  });

  it("never lists a project plugin loaded for another project", async () => {
    mocks.listPlugins.mockReturnValue([
      plugin({
        instanceId: `project__${OTHER_PROJECT}__acme.ledger`,
        origin: "project",
        projectId: OTHER_PROJECT,
      }),
    ]);

    const result = (await getHandler(LIST)(EVENT)) as { endpoints: unknown[] };

    expect(result.endpoints).toEqual([]);
  });

  it("answers an empty list to a sender with no project, or a scratch", async () => {
    mocks.getProjectForWebContents.mockReturnValue(null);
    expect(await getHandler(LIST)(EVENT)).toEqual({ endpoints: [], mcpServerEnabled: true });

    mocks.getProjectForWebContents.mockReturnValue("12345678-1234-4123-8123-123456789abc");
    expect(await getHandler(LIST)(EVENT)).toEqual({ endpoints: [], mcpServerEnabled: true });
    expect(mocks.listEnabled).not.toHaveBeenCalled();
  });

  it("says when the MCP listener is off", async () => {
    mocks.isMcpEnabled.mockReturnValue(false);

    const result = (await getHandler(LIST)(EVENT)) as { mcpServerEnabled: boolean };

    expect(result.mcpServerEnabled).toBe(false);
  });

  it("turns on an endpoint the project's running plugins offer", async () => {
    await getHandler(SET)(EVENT, {
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      enabled: true,
    });

    expect(mocks.setEnabled).toHaveBeenCalledWith(PROJECT, "acme.ledger", "data", true);
  });

  it("refuses to turn on an endpoint nothing running offers here", async () => {
    const set = getHandler(SET);

    await expect(
      set(EVENT, { pluginInstanceId: "acme.ledger", endpointId: "other", enabled: true })
    ).rejects.toThrow(/no running plugin offers/);

    mocks.hasPlugin.mockReturnValue(false);
    await expect(
      set(EVENT, { pluginInstanceId: "acme.ledger", endpointId: "data", enabled: true })
    ).rejects.toThrow(/no running plugin offers/);

    mocks.listPlugins.mockReturnValue([
      plugin({
        instanceId: `project__${OTHER_PROJECT}__acme.ledger`,
        origin: "project",
        projectId: OTHER_PROJECT,
      }),
    ]);
    mocks.hasPlugin.mockReturnValue(true);
    await expect(
      set(EVENT, {
        pluginInstanceId: `project__${OTHER_PROJECT}__acme.ledger`,
        endpointId: "data",
        enabled: true,
      })
    ).rejects.toThrow(/no running plugin offers/);

    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("always allows turning an endpoint off, even one nothing offers any more", async () => {
    mocks.listPlugins.mockReturnValue([]);

    await getHandler(SET)(EVENT, {
      pluginInstanceId: "gone.plugin",
      endpointId: "data",
      enabled: false,
    });

    expect(mocks.setEnabled).toHaveBeenCalledWith(PROJECT, "gone.plugin", "data", false);
  });

  it("acts on the sender's project even when the payload names another", async () => {
    await getHandler(SET)(EVENT, {
      projectId: OTHER_PROJECT,
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      enabled: false,
    });

    expect(mocks.setEnabled).toHaveBeenCalledWith(PROJECT, "acme.ledger", "data", false);
  });

  it("returns the fresh list after a change", async () => {
    mocks.setEnabled.mockImplementation(() => {
      mocks.listEnabled.mockReturnValue([{ pluginInstanceId: "acme.ledger", endpointId: "data" }]);
    });

    const result = (await getHandler(SET)(EVENT, {
      pluginInstanceId: "acme.ledger",
      endpointId: "data",
      enabled: true,
    })) as { endpoints: Array<{ enabled: boolean }> };

    expect(result.endpoints.map((e) => e.enabled)).toEqual([true]);
  });

  it("refuses a change from a sender with no project", async () => {
    const set = getHandler(SET);
    const payload = { pluginInstanceId: "acme.ledger", endpointId: "data", enabled: false };

    mocks.getProjectForWebContents.mockReturnValue(null);
    await expect(set(EVENT, payload)).rejects.toThrow(/sender has no project/);

    mocks.getProjectForWebContents.mockReturnValue("12345678-1234-4123-8123-123456789abc");
    await expect(set(EVENT, payload)).rejects.toThrow(/sender has no project/);

    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload at the boundary", async () => {
    const set = getHandler(SET);

    await expect(
      set(EVENT, { pluginInstanceId: "", endpointId: "data", enabled: true })
    ).rejects.toThrow(/IPC validation failed/);
    await expect(
      set(EVENT, { pluginInstanceId: "acme.ledger", endpointId: "data", enabled: "yes" })
    ).rejects.toThrow(/IPC validation failed/);
    await expect(
      set(EVENT, { pluginInstanceId: "acme.ledger", endpointId: 3, enabled: false })
    ).rejects.toThrow(/IPC validation failed/);

    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it("removes its handlers on dispose", () => {
    dispose();
    const removed = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removed).toEqual(expect.arrayContaining([LIST, SET]));
    dispose = () => {};
  });
});
