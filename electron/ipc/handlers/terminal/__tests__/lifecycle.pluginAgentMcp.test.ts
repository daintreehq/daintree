import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Agent launches hand the project's plugin MCP servers — one per plugin with
// access here — to the agent beside the Daintree entry, mostly in Claude's
// managed --mcp-config file. Unlike
// lifecycle.spawn.test.ts, the pane config service and the grant registry are
// real here: what matters is the file the agent is handed and which grants are
// live afterwards, not which calls were made.

const testUserData = vi.hoisted(
  () => `${process.cwd()}/.vitest-plugin-agent-mcp-${Math.random().toString(36).slice(2)}`
);

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: {
    getPath: () => testUserData,
  },
}));

const storeData = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../../store.js", () => ({
  store: {
    get: (key: string) => storeData.get(key),
    set: (key: string, value: unknown) => {
      storeData.set(key, value);
    },
  },
}));

const { mockGetCurrentProject, mockGetProjectById, mockGetProjectSettings } = vi.hoisted(() => ({
  mockGetCurrentProject: vi.fn(),
  mockGetProjectById: vi.fn(),
  mockGetProjectSettings: vi.fn(),
}));

vi.mock("../../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: mockGetCurrentProject,
    getProjectById: mockGetProjectById,
    getProjectSettings: mockGetProjectSettings,
  },
}));

vi.mock("../../../../services/pty/terminalShell.js", () => ({
  getDefaultShell: vi.fn(() => "/bin/zsh"),
}));

vi.mock("../../../../services/pty/agentSessionHistory.js", () => ({
  persistAgentSession: vi.fn().mockResolvedValue(undefined),
  listAgentSessions: vi.fn(() => []),
  clearAgentSessions: vi.fn().mockResolvedValue(undefined),
  pruneAgentSessions: vi.fn().mockResolvedValue(undefined),
  DEFAULT_RETENTION_DAYS: 30,
}));

vi.mock("../../../../setup/windowsPath.js", () => ({
  refreshWindowsPathForSpawn: vi.fn().mockResolvedValue(undefined),
  resolveWindowsRegistryPath: vi.fn().mockResolvedValue(null),
  applyWindowsExtraPaths: vi.fn((p: string) => p),
  expandWindowsEnvVars: vi.fn((s: string) => s),
  deduplicatePath: vi.fn((p: string) => p),
  __resetWindowsPathStateForTests: vi.fn(),
}));

vi.mock("../../../../services/pty/agentSessionRetention.js", () => ({
  getAgentSessionRetentionDays: vi.fn(() => 30),
}));

type SafeParseable = {
  safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

vi.mock("../../../utils.js", () => ({
  waitForRateLimitSlot: vi.fn().mockResolvedValue(undefined),
  waitForBurstRateLimitSlot: vi.fn().mockResolvedValue(undefined),
  consumeRestoreQuota: vi.fn(() => false),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(
        { event: _e, webContentsId: 0, senderWindow: null, projectId: null },
        ...args
      )
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (channel: string, schema: SafeParseable, handler: unknown) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) throw new Error(`IPC validation failed: ${channel}`);
      return (handler as (payload: unknown) => unknown)(parsed.data);
    });
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContextValidated: (channel: string, schema: SafeParseable, handler: unknown) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) throw new Error(`IPC validation failed: ${channel}`);
      return (handler as (ctx: unknown, payload: unknown) => unknown)(
        { event: _e, webContentsId: 0, senderWindow: null, projectId: null },
        parsed.data
      );
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

const { mockValidateToken, mockMarkTerminalForToken } = vi.hoisted(() => ({
  mockValidateToken: vi.fn<(token: string) => "core" | "full" | false>(),
  mockMarkTerminalForToken: vi.fn(() => true),
}));

vi.mock("../../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    validateToken: (token: string) => mockValidateToken(token),
    getCodexLaunchArgs: () => null,
    getCopilotLaunchArgs: () => null,
    getClaudeLaunchArgs: () => [],
    getAssistantScratchEnv: () => null,
    getBypassPermissions: () => false,
    getDebugLogging: () => false,
    markTerminalForToken: mockMarkTerminalForToken,
    unbindTerminal: vi.fn(),
    isHelpTerminal: () => false,
  },
}));

vi.mock("../../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

vi.mock("../../../../services/McpServerService.js", () => ({
  mcpServerService: {
    isRunning: true,
    currentPort: 45454,
    ensureReady: async () => true,
    setAssistantPaneWebContentsResolver: vi.fn(),
    setAssistantPaneActionContextResolver: vi.fn(),
    setPaneWorkspaceBindingResolver: vi.fn(),
    setPaneOwnershipPrincipalResolver: vi.fn(),
    setPaneTerminalResolver: vi.fn(),
    revokeOwnershipPrincipal: vi.fn(),
  },
}));

const { mockListPlugins, mockHasPlugin, mockWaitForInit } = vi.hoisted(() => ({
  mockListPlugins: vi.fn<() => unknown[]>(() => []),
  mockHasPlugin: vi.fn<(instanceId: string) => boolean>(() => true),
  mockWaitForInit: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: () => mockListPlugins(),
    hasPlugin: (instanceId: string) => mockHasPlugin(instanceId),
    waitForInit: () => mockWaitForInit(),
    resolveSettingTemplate: vi.fn(),
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalLifecycleHandlers } from "../lifecycle.js";
import type { HandlerDependencies } from "../../../types.js";
import { mcpPaneConfigService } from "../../../../services/McpPaneConfigService.js";
import { pluginMcpGrantRegistry } from "../../../../services/pluginAgentMcp/grantRegistry.js";
import {
  setAllProjectsAgentMcpAccess,
  setProjectAgentMcpAccess,
} from "../../../../services/pluginAgentMcp/projectEnablement.js";
import { pluginServerKeysFor } from "../../../../services/pluginAgentMcp/serverKeys.js";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../../shared/types/plugin.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

const READ_WRITE_SCOPE = { databases: true, pluginEndpointId: "data" };

function plugin(
  overrides: {
    instanceId?: string;
    name?: string;
    mcpName?: string | null;
    origin?: "global" | "project";
    projectId?: string | null;
  } = {}
): LoadedPluginInfo {
  const mcpName = overrides.mcpName === undefined ? "ledger" : overrides.mcpName;
  return {
    manifest: {
      name: overrides.name ?? "acme.ledger",
      version: "1.0.0",
      displayName: "Ledger",
      ...(mcpName !== null ? { mcpName } : {}),
      capabilities: ["mcp:expose"],
      contributes: {
        databases: [{ id: "ledger", description: "Household transactions" }],
        agentMcp: [{ id: "data", name: "Household ledger", mode: "tools" }],
      },
    } as unknown as PluginManifest,
    instanceId: overrides.instanceId ?? overrides.name ?? "acme.ledger",
    origin: overrides.origin ?? "global",
    projectId: overrides.projectId ?? null,
    disabled: false,
  } as unknown as LoadedPluginInfo;
}

function getSpawnHandler() {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const spawnCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_SPAWN);
  return spawnCall?.[1] as unknown as (
    event: Electron.IpcMainInvokeEvent,
    options: Record<string, unknown>
  ) => Promise<string>;
}

async function readServers(configPath: string) {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
  return parsed.mcpServers as Record<
    string,
    { type: string; url: string; headers: { Authorization: string } }
  >;
}

function configPathFromCommand(command: string): string {
  // Every appended arg is shell-quoted, the flag included.
  const match =
    /'?--mcp-config'? '([^']+)'/.exec(command) ?? /'?--mcp-config'? (\S+)/.exec(command);
  if (!match) throw new Error(`No --mcp-config in: ${command}`);
  return match[1];
}

describe("terminal spawn handler - plugin MCP servers for agent launches", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  let tmpDir: string;

  async function spawn(options: Record<string, unknown>) {
    registerTerminalLifecycleHandlers({ ptyClient } as unknown as HandlerDependencies);
    return getSpawnHandler()({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      cwd: tmpDir,
      projectId: PROJECT_A,
      command: "claude",
      launchAgentId: "claude",
      ...options,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const os = await import("os");
    tmpDir = os.tmpdir();
    ptyClient = { spawn: vi.fn(), hasTerminal: vi.fn(() => false), write: vi.fn() };
    storeData.clear();
    mockGetProjectById.mockImplementation((id: string) =>
      id === PROJECT_A ? { id: PROJECT_A, path: tmpDir, name: "a" } : null
    );
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "off" });
    mockValidateToken.mockReturnValue(false);
    mockListPlugins.mockReturnValue([plugin()]);
    mockHasPlugin.mockReturnValue(true);
    mockWaitForInit.mockImplementation(() => Promise.resolve());
  });

  afterEach(async () => {
    await mcpPaneConfigService.revokeAll();
    pluginMcpGrantRegistry.revokeAll();
  });

  afterAll(async () => {
    await fs.rm(testUserData, { recursive: true, force: true });
  });

  it('hands a running plugin with access to Claude as one named server, even with the Daintree tier "off"', async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    const id = await spawn({ id: "term-off" });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
    const servers = await readServers(configPathFromCommand(spawnArgs.command));
    expect(servers.daintree).toBeUndefined();
    expect(Object.keys(servers)).toEqual(["daintree-ledger"]);
    const entry = servers["daintree-ledger"];
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("http://127.0.0.1:45454/mcp/plugin/acme.ledger");

    const bearer = entry.headers.Authorization.replace(/^Bearer /, "");
    expect(pluginMcpGrantRegistry.authenticate(bearer)).toMatchObject({
      pluginInstanceId: "acme.ledger",
      scope: READ_WRITE_SCOPE,
      serverName: "daintree-ledger",
      projectId: PROJECT_A,
      terminalId: id,
      launchAgentIdHint: "claude",
    });
    // The orchestration surface stays shut for this pane.
    expect(mcpPaneConfigService.isValidPaneToken(bearer)).toBe(false);
  });

  it("adds the plugin entry alongside the Daintree entry when the tier is on", async () => {
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "core" });
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-core" });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    const token = spawnArgs.env?.DAINTREE_MCP_TOKEN as string;
    expect(mcpPaneConfigService.getTierForToken(token)).toBe("core");
    const servers = await readServers(configPathFromCommand(spawnArgs.command));
    expect(servers.daintree.headers.Authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(servers).sort()).toEqual(["daintree", "daintree-ledger"]);
    expect(spawnArgs.command.match(/--mcp-config/g)).toHaveLength(1);
    expect(pluginMcpGrantRegistry.listForTerminal("term-core")).toHaveLength(1);
  });

  it("mints nothing for a plugin with no access, and never loads PluginService", async () => {
    await spawn({ id: "term-disabled" });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("claude");
    expect(pluginMcpGrantRegistry.listForTerminal("term-disabled")).toEqual([]);
    expect(mockListPlugins).not.toHaveBeenCalled();
    expect(mockWaitForInit).not.toHaveBeenCalled();
  });

  it("waits for plugin init before resolving servers for a launch at cold start", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    let initialized = false;
    let settleInit!: () => void;
    mockWaitForInit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleInit = () => {
            initialized = true;
            resolve();
          };
        })
    );
    mockListPlugins.mockImplementation(() => (initialized ? [plugin()] : []));
    mockHasPlugin.mockImplementation(() => initialized);

    const pending = spawn({ id: "term-cold" });
    await vi.waitFor(() => expect(mockWaitForInit).toHaveBeenCalled());
    expect(ptyClient.spawn).not.toHaveBeenCalled();
    settleInit();
    await pending;

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    const servers = await readServers(configPathFromCommand(spawnArgs.command));
    expect(Object.values(servers)).toHaveLength(1);
    expect(pluginMcpGrantRegistry.listForTerminal("term-cold")).toHaveLength(1);
  });

  it("launches without plugin servers when plugin init does not settle in time", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    mockWaitForInit.mockImplementation(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = spawn({ id: "term-init-timeout" });
      await vi.waitFor(() => expect(mockWaitForInit).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
    expect(mockListPlugins).not.toHaveBeenCalled();
    expect(pluginMcpGrantRegistry.listForTerminal("term-init-timeout")).toEqual([]);
  });

  it("mints nothing for a plugin with access that is not running", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    mockHasPlugin.mockReturnValue(false);

    await spawn({ id: "term-not-running" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
    expect(pluginMcpGrantRegistry.listForTerminal("term-not-running")).toEqual([]);
  });

  it("mints nothing for a project plugin loaded for another project", async () => {
    const foreignInstance = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");
    mockListPlugins.mockReturnValue([
      plugin({ instanceId: foreignInstance, origin: "project", projectId: PROJECT_B }),
    ]);
    storeData.set("projectAgentMcpAccess", {
      [PROJECT_A]: { [foreignInstance]: { decidedAt: 1, access: "read-write" } },
    });

    await spawn({ id: "term-foreign" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
    expect(pluginMcpGrantRegistry.listForTerminal("term-foreign")).toEqual([]);
  });

  it("names each plugin over every plugin that could serve here, not only those with access", async () => {
    const projectLedger = makeProjectPluginInstanceKey(PROJECT_A, "other.ledger");
    const declared = [
      plugin(),
      plugin({
        instanceId: projectLedger,
        name: "other.ledger",
        mcpName: null,
        origin: "project",
        projectId: PROJECT_A,
      }),
    ];
    mockListPlugins.mockReturnValue(declared);
    setProjectAgentMcpAccess(PROJECT_A, projectLedger, "read-write");

    await spawn({ id: "term-keys" });

    const expected = pluginServerKeysFor([
      {
        pluginInstanceId: "acme.ledger",
        pluginManifestId: "acme.ledger",
        origin: "global",
        mcpName: "ledger",
      },
      { pluginInstanceId: projectLedger, pluginManifestId: "other.ledger", origin: "project" },
    ]).get(projectLedger)!;
    expect(expected).not.toBe("daintree-ledger");
    const servers = await readServers(
      configPathFromCommand(ptyClient.spawn.mock.calls[0][1].command)
    );
    expect(Object.keys(servers)).toEqual([expected]);
    expect(servers[expected].url).toBe(
      `http://127.0.0.1:45454/mcp/plugin/${encodeURIComponent(projectLedger)}`
    );
    expect(pluginMcpGrantRegistry.listForTerminal("term-keys")).toEqual([
      expect.objectContaining({ pluginInstanceId: projectLedger, serverName: expected }),
    ]);
  });

  it("gives read-only access a grant that reaches the database tools only", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");

    await spawn({ id: "term-read-only" });

    expect(pluginMcpGrantRegistry.listForTerminal("term-read-only")).toEqual([
      expect.objectContaining({
        pluginInstanceId: "acme.ledger",
        scope: { databases: true },
        serverName: "daintree-ledger",
      }),
    ]);
  });

  it("reaches a project with no answer of its own through an installed plugin's all-projects answer", async () => {
    setAllProjectsAgentMcpAccess("acme.ledger", "read-only");

    await spawn({ id: "term-all-projects" });

    const servers = await readServers(
      configPathFromCommand(ptyClient.spawn.mock.calls[0][1].command)
    );
    expect(Object.keys(servers)).toEqual(["daintree-ledger"]);
    expect(pluginMcpGrantRegistry.listForTerminal("term-all-projects")).toEqual([
      expect.objectContaining({ pluginInstanceId: "acme.ledger", scope: { databases: true } }),
    ]);
  });

  it("lets the project's own answer override the all-projects answer", async () => {
    setAllProjectsAgentMcpAccess("acme.ledger", "read-write");
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "off");

    await spawn({ id: "term-project-off" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
    expect(pluginMcpGrantRegistry.listForTerminal("term-project-off")).toEqual([]);
  });

  it("still honours an answer given one endpoint at a time before access levels", async () => {
    storeData.set("projectAgentMcpEnablement", {
      [PROJECT_A]: { "acme.ledger": { data: { decidedAt: 1 } } },
    });

    await spawn({ id: "term-legacy" });

    expect(pluginMcpGrantRegistry.listForTerminal("term-legacy")).toEqual([
      expect.objectContaining({
        pluginInstanceId: "acme.ledger",
        scope: { databases: false, pluginEndpointId: "data" },
        serverName: "daintree-ledger",
      }),
    ]);
  });

  it("revokes the grants when the PTY spawn throws", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    ptyClient.spawn.mockImplementation(() => {
      throw new Error("pty-host gone");
    });

    await expect(spawn({ id: "term-spawn-fail" })).rejects.toThrow(/pty-host gone/);

    await vi.waitFor(() => {
      expect(pluginMcpGrantRegistry.listForTerminal("term-spawn-fail")).toEqual([]);
    });
  });

  it("a failure before preparation leaves a previous launch's grants for that id alone", async () => {
    const { grant } = pluginMcpGrantRegistry.issue({
      pluginInstanceId: "acme.ledger",
      scope: READ_WRITE_SCOPE,
      serverName: "daintree-ledger",
      projectId: PROJECT_A,
      terminalId: "term-prior",
    });
    mockGetProjectSettings.mockRejectedValue(new Error("settings unreadable"));

    await spawn({ id: "term-prior" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
    expect(pluginMcpGrantRegistry.isLive(grant.credentialId)).toBe(true);
  });

  it("hands a Codex launch the plugin's server as a -c override, its bearer in the env", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-codex", command: "codex", launchAgentId: "codex" });

    const { command, env } = ptyClient.spawn.mock.calls[0][1];
    expect(command).not.toContain("--mcp-config");
    expect(command).toContain(
      'mcp_servers.daintree-ledger.url="http://127.0.0.1:45454/mcp/plugin/acme.ledger"'
    );
    expect(command).toContain('bearer_token_env_var="DAINTREE_PLUGIN_MCP_TOKEN_1"');
    const bearer = env?.DAINTREE_PLUGIN_MCP_TOKEN_1 as string;
    expect(command).not.toContain(bearer);
    const [grant] = pluginMcpGrantRegistry.listForTerminal("term-codex");
    expect(grant).toMatchObject({ scope: READ_WRITE_SCOPE, launchAgentIdHint: "codex" });
    expect(pluginMcpGrantRegistry.authenticate(bearer)).toBe(grant);
  });

  it("mints nothing for an agent with no launch mechanism", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-cursor", command: "cursor-agent", launchAgentId: "cursor" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("cursor-agent");
    expect(pluginMcpGrantRegistry.listForTerminal("term-cursor")).toEqual([]);
  });

  it("mints nothing for a Claude help-session launch", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "core" : false));

    await spawn({ id: "term-help", env: { DAINTREE_MCP_TOKEN: "help-token" } });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);
  });
});
