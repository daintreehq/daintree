// Unit IPC fixtures don't install CLIs; real Windows argv coverage lives in utils.
vi.mock("../../../../utils/windowsCliSpawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/windowsCliSpawn.js")>()),
  resolveWindowsCliTarget: async () => ({
    kind: "direct",
    command: "C:\\test\\agent.exe",
    args: [],
  }),
}));
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

vi.mock("../../../../services/pty/terminalShell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/pty/terminalShell.js")>()),
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

// The context the validated spawn handler sees. A launch from a local view has
// a positive handle; one forwarded from an attached remote frontend arrives on
// the host with a negative handle, no Electron event and the endpoint's project.
const spawnCtx = vi.hoisted(() => ({
  current: { webContentsId: 0, projectId: null as string | null },
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
        { event: _e, senderWindow: null, ...spawnCtx.current },
        parsed.data
      );
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

type PluginLaunchContext = {
  projectId: string;
  projectPath: string;
  serverNamesInUse: ReadonlySet<string>;
};

const {
  mockValidateToken,
  mockMarkTerminalForToken,
  mockClaudeLaunchArgs,
  mockCodexLaunchArgs,
  mockCopilotLaunchArgs,
  mockPluginLaunchContext,
  mockIsHelpTerminal,
} = vi.hoisted(() => ({
  mockValidateToken: vi.fn<(token: string) => "core" | "full" | false>(),
  mockMarkTerminalForToken: vi.fn(() => true),
  mockClaudeLaunchArgs: vi.fn<() => string[] | null>(() => []),
  mockCodexLaunchArgs: vi.fn<() => string[] | null>(() => null),
  mockCopilotLaunchArgs: vi.fn<() => string[] | null>(() => null),
  mockPluginLaunchContext: vi.fn<(token: string) => PluginLaunchContext | null>(() => null),
  mockIsHelpTerminal: vi.fn<(terminalId: string) => boolean>(() => false),
}));

vi.mock("../../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    validateToken: (token: string) => mockValidateToken(token),
    getCodexLaunchArgs: () => mockCodexLaunchArgs(),
    getCopilotLaunchArgs: () => mockCopilotLaunchArgs(),
    getClaudeLaunchArgs: () => mockClaudeLaunchArgs(),
    getAssistantScratchEnv: () => null,
    getBypassPermissions: () => false,
    getPluginLaunchContext: (token: string) => mockPluginLaunchContext(token),
    getAssistantPluginLane: () => null,
    markTerminalForToken: mockMarkTerminalForToken,
    unbindTerminal: vi.fn(),
    isHelpTerminal: (terminalId: string) => mockIsHelpTerminal(terminalId),
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
    setPaneWorkspaceBindingResolver: vi.fn(),
    setPaneOwnershipPrincipalResolver: vi.fn(),
    setPaneTerminalResolver: vi.fn(),
    setAssistantPluginLaneResolver: vi.fn(),
    revokePaneBearer: vi.fn(),
  },
}));

const { mockListPlugins, mockHasPlugin, mockWaitForCatalog, mockWaitForProjectPlugins } =
  vi.hoisted(() => ({
    mockListPlugins: vi.fn<() => unknown[]>(() => []),
    mockHasPlugin: vi.fn<(instanceId: string) => boolean>(() => true),
    mockWaitForCatalog: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    mockWaitForProjectPlugins: vi.fn<(projectId: string, timeoutMs: number) => Promise<boolean>>(
      () => Promise.resolve(true)
    ),
  }));

vi.mock("../../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: () => mockListPlugins(),
    hasPlugin: (instanceId: string) => mockHasPlugin(instanceId),
    waitForCatalog: () => mockWaitForCatalog(),
    waitForProjectPlugins: (projectId: string, timeoutMs: number) =>
      mockWaitForProjectPlugins(projectId, timeoutMs),
    resolveSettingTemplate: vi.fn(),
  },
}));

// Decisions' entry module, reached only while the saved setting is on (#16012).
const mockDecisionsLaunchPort = vi.hoisted(() =>
  vi.fn<() => Promise<number | null>>(async () => null)
);
vi.mock("../../../../services/decisions/index.js", () => ({
  decisionsLaunchPort: () => mockDecisionsLaunchPort(),
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
  setProjectAssistantAgentMcpAccess,
} from "../../../../services/pluginAgentMcp/projectEnablement.js";
import { pluginServerKeysFor } from "../../../../services/pluginAgentMcp/serverKeys.js";
import {
  clearPluginToolsLaunches,
  listRelaunchNeeded,
} from "../../../../services/pluginAgentMcp/agentLaunchRecords.js";
import { mcpServerService } from "../../../../services/McpServerService.js";
import type { AppError } from "../../../../utils/errorTypes.js";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../../shared/types/plugin.js";

import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "../../../../../shared/config/pluginAgentRegistry.js";

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
    mockWaitForCatalog.mockImplementation(() => Promise.resolve());
    mockWaitForProjectPlugins.mockImplementation(() => Promise.resolve(true));
    mockMarkTerminalForToken.mockReturnValue(true);
    mockIsHelpTerminal.mockReturnValue(false);
    mockDecisionsLaunchPort.mockResolvedValue(null);
    mockClaudeLaunchArgs.mockReturnValue([]);
    mockCodexLaunchArgs.mockReturnValue(null);
    mockCopilotLaunchArgs.mockReturnValue(null);
    mockPluginLaunchContext.mockImplementation((token) =>
      token === "help-token"
        ? {
            projectId: PROJECT_A,
            projectPath: tmpDir,
            serverNamesInUse: new Set(["daintree", "daintree-docs", "daintree-runbooks"]),
          }
        : null
    );
  });

  afterEach(async () => {
    clearPluginAgentRegistryForTests();
    await mcpPaneConfigService.revokeAll();
    pluginMcpGrantRegistry.revokeAll();
  });

  afterAll(async () => {
    await fs.rm(testUserData, { recursive: true, force: true });
  });

  describe("the Decisions server (#16012)", () => {
    const DECISIONS_PORT = 4100;

    function decisionsOn() {
      storeData.set("decisions", { enabled: true });
      mockDecisionsLaunchPort.mockResolvedValue(DECISIONS_PORT);
    }

    function decisionsBearerOf(entry: { headers: { Authorization: string } }): string {
      return entry.headers.Authorization.replace(/^Bearer /, "");
    }

    it("loads nothing of Decisions while it is off, and launches as before", async () => {
      storeData.set("decisions", { enabled: false });
      await spawn({ id: "term-dec-disabled-off" });
      expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");

      mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "core" });
      await spawn({ id: "term-dec-disabled-core" });
      await spawn({ id: "term-dec-disabled-codex", command: "codex", launchAgentId: "codex" });
      const claude = ptyClient.spawn.mock.calls[1][1];
      const token = claude.env?.DAINTREE_MCP_TOKEN as string;
      expect(await readServers(configPathFromCommand(claude.command))).toEqual({
        daintree: {
          type: "sse",
          url: "http://127.0.0.1:45454/sse",
          headers: { Authorization: `Bearer ${token}` },
        },
      });
      const codex = ptyClient.spawn.mock.calls[2][1];
      expect(codex.command.match(/mcp_servers\.[\w-]+\.url=/g)).toEqual([
        "mcp_servers.daintree.url=",
      ]);
      for (const { env } of [claude, codex]) {
        expect(Object.keys(env ?? {}).filter((key) => key.includes("DECISIONS"))).toEqual([]);
      }
      expect(mockDecisionsLaunchPort).not.toHaveBeenCalled();
    });

    it('hands a tier "off" Claude launch only the Decisions server, on the route\'s port', async () => {
      decisionsOn();

      const id = await spawn({ id: "term-dec-off" });

      const { command, env } = ptyClient.spawn.mock.calls[0][1];
      expect(env?.DAINTREE_MCP_TOKEN).toBeUndefined();
      const servers = await readServers(configPathFromCommand(command));
      expect(Object.keys(servers)).toEqual(["daintree-decisions"]);
      expect(servers["daintree-decisions"].url).toBe(
        `http://127.0.0.1:${DECISIONS_PORT}/mcp/decisions`
      );
      const bearer = decisionsBearerOf(servers["daintree-decisions"]);
      expect(mcpPaneConfigService.getDecisionsBearerForToken(bearer)).toMatchObject({
        paneId: id,
        workspaceId: PROJECT_A,
      });
      expect(mcpPaneConfigService.isValidPaneToken(bearer)).toBe(false);
      expect(pluginMcpGrantRegistry.authenticate(bearer)).toBeNull();
    });

    it('hands a tier "off" Codex launch the Decisions override, its bearer in the env', async () => {
      decisionsOn();

      await spawn({ id: "term-dec-codex", command: "codex", launchAgentId: "codex" });

      const { command, env } = ptyClient.spawn.mock.calls[0][1];
      expect(command).toContain(
        `mcp_servers.daintree-decisions.url="http://127.0.0.1:${DECISIONS_PORT}/mcp/decisions"`
      );
      expect(command).toContain('bearer_token_env_var="DAINTREE_DECISIONS_MCP_TOKEN"');
      expect(command).not.toContain("mcp_servers.daintree.url");
      const bearer = env?.DAINTREE_DECISIONS_MCP_TOKEN as string;
      expect(command).not.toContain(bearer);
      expect(mcpPaneConfigService.getDecisionsBearerForToken(bearer)?.paneId).toBe(
        "term-dec-codex"
      );
    });

    it("hands a tier-on launch both servers on the control surface's listener", async () => {
      decisionsOn();
      mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "core" });

      await spawn({ id: "term-dec-core" });
      await spawn({ id: "term-dec-core-codex", command: "codex", launchAgentId: "codex" });

      const claude = ptyClient.spawn.mock.calls[0][1];
      const servers = await readServers(configPathFromCommand(claude.command));
      expect(Object.keys(servers)).toEqual(["daintree", "daintree-decisions"]);
      expect(servers["daintree-decisions"].url).toBe("http://127.0.0.1:45454/mcp/decisions");
      const control = claude.env?.DAINTREE_MCP_TOKEN as string;
      expect(servers.daintree.headers.Authorization).toBe(`Bearer ${control}`);
      expect(mcpPaneConfigService.getDecisionsPrincipal("term-dec-core")).toBe(
        mcpPaneConfigService.getOwnershipPrincipalForToken(control)
      );

      const codex = ptyClient.spawn.mock.calls[1][1];
      expect(codex.command).toContain('mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"');
      expect(codex.command).toContain(
        'mcp_servers.daintree-decisions.url="http://127.0.0.1:45454/mcp/decisions"'
      );
      const codexControl = codex.env?.DAINTREE_MCP_TOKEN as string;
      const codexDecisions = codex.env?.DAINTREE_DECISIONS_MCP_TOKEN as string;
      expect(mcpPaneConfigService.getTierForToken(codexControl)).toBe("core");
      expect(mcpPaneConfigService.getDecisionsBearerForToken(codexDecisions)).toEqual({
        paneId: "term-dec-core-codex",
        principal: mcpPaneConfigService.getOwnershipPrincipalForToken(codexControl),
        workspaceId: PROJECT_A,
      });
    });

    it("hands a plugin-granted pane its plugin server and the Decisions server", async () => {
      decisionsOn();
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

      await spawn({ id: "term-dec-plugin" });

      const { command, env } = ptyClient.spawn.mock.calls[0][1];
      expect(env?.DAINTREE_MCP_TOKEN).toBeUndefined();
      const servers = await readServers(configPathFromCommand(command));
      expect(Object.keys(servers)).toEqual(["daintree-ledger", "daintree-decisions"]);
      expect(servers["daintree-decisions"].url).toBe("http://127.0.0.1:45454/mcp/decisions");
      expect(pluginMcpGrantRegistry.listForTerminal("term-dec-plugin")).toHaveLength(1);
    });

    it("tells the MCP server when a Decisions-only pane's bearer goes, so what its run owns goes too", async () => {
      decisionsOn();
      mcpPaneConfigService.setOwnershipPrincipalRevokedListener(null);

      await spawn({ id: "term-dec-revoke" });
      const principal = mcpPaneConfigService.getDecisionsPrincipal("term-dec-revoke");
      expect(principal).not.toBeNull();
      await mcpPaneConfigService.revokePaneConfig("term-dec-revoke");

      expect(mcpServerService.revokePaneBearer).toHaveBeenCalledWith(principal);
    });

    it("revokes the Decisions bearer and file when a plugin agent's settings template can't be filled", async () => {
      decisionsOn();
      registerPluginAgents("acme.agents", [
        {
          id: "acme-agent",
          name: "Acme Agent",
          command: "acme",
          color: "#3366ff",
          iconId: "terminal",
          launchMcp: { format: "claude-mcp-config" },
        },
      ]);
      const prepare = vi.spyOn(mcpPaneConfigService, "preparePaneConfig");

      await expect(
        spawn({
          id: "term-dec-template",
          command: "acme --token=${settings:apiToken}",
          launchAgentId: "acme-agent",
        })
      ).rejects.toThrow(/apiToken/);

      const prepared = await prepare.mock.results[0]!.value;
      prepare.mockRestore();
      expect(prepared.decisionsToken).not.toBeNull();
      expect(mcpPaneConfigService.getDecisionsBearerForToken(prepared.decisionsToken)).toBeNull();
      expect(mcpPaneConfigService.getDecisionsPrincipal("term-dec-template")).toBeNull();
      await expect(fs.stat(prepared.configPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(ptyClient.spawn).not.toHaveBeenCalled();
    });

    it("launches as before when the route isn't there in time, and never for the Assistant's pane", async () => {
      storeData.set("decisions", { enabled: true });
      mockDecisionsLaunchPort.mockResolvedValue(null);
      await spawn({ id: "term-dec-unready" });
      expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");

      decisionsOn();
      mockDecisionsLaunchPort.mockClear();
      mockIsHelpTerminal.mockReturnValue(true);
      await spawn({ id: "term-dec-assistant" });
      expect(ptyClient.spawn.mock.calls[1][1].command).toBe("claude");
      expect(mockDecisionsLaunchPort).not.toHaveBeenCalled();
    });
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

  it("still hands over the plugin's server when the project's settings can't be read", async () => {
    mockGetProjectSettings.mockRejectedValue(
      Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-unreadable" });
    warnSpy.mockRestore();

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
    const servers = await readServers(configPathFromCommand(spawnArgs.command));
    expect(Object.keys(servers)).toEqual(["daintree-ledger"]);
  });

  it("mints nothing for a plugin with no access, and never loads PluginService", async () => {
    await spawn({ id: "term-disabled" });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("claude");
    expect(pluginMcpGrantRegistry.listForTerminal("term-disabled")).toEqual([]);
    expect(mockListPlugins).not.toHaveBeenCalled();
    expect(mockWaitForCatalog).not.toHaveBeenCalled();
  });

  it("waits for plugin init before resolving servers for a launch at cold start", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    let initialized = false;
    let settleInit!: () => void;
    mockWaitForCatalog.mockImplementation(
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
    await vi.waitFor(() => expect(mockWaitForCatalog).toHaveBeenCalled());
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
    mockWaitForCatalog.mockImplementation(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = spawn({ id: "term-init-timeout" });
      await vi.waitFor(() => expect(mockWaitForCatalog).toHaveBeenCalled());
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

  it("waits for the project's plugins to finish loading before resolving its servers", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    let loaded = false;
    let settleProject!: () => void;
    mockWaitForProjectPlugins.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settleProject = () => {
            loaded = true;
            resolve(true);
          };
        })
    );
    mockListPlugins.mockImplementation(() => (loaded ? [plugin()] : []));
    mockHasPlugin.mockImplementation(() => loaded);

    const pending = spawn({ id: "term-restored" });
    await vi.waitFor(() => expect(mockWaitForProjectPlugins).toHaveBeenCalledWith(PROJECT_A, 5000));
    expect(ptyClient.spawn).not.toHaveBeenCalled();
    settleProject();
    await pending;

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    const servers = await readServers(configPathFromCommand(spawnArgs.command));
    expect(Object.values(servers)).toHaveLength(1);
    expect(pluginMcpGrantRegistry.listForTerminal("term-restored")).toHaveLength(1);
  });

  it("launches with whatever has loaded when the project's plugins do not settle in time", async () => {
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    mockWaitForProjectPlugins.mockImplementation(() => Promise.resolve(false));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await spawn({ id: "term-project-timeout" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Project plugins not settled"));
    } finally {
      warn.mockRestore();
    }

    expect(pluginMcpGrantRegistry.listForTerminal("term-project-timeout")).toHaveLength(1);
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
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
    mockListPlugins.mockImplementation(() => {
      throw new Error("plugin registry unavailable");
    });

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

  it("hands a plugin-contributed agent the endpoints of the mechanism it declared", async () => {
    registerPluginAgents("acme.agents", [
      {
        id: "acme-agent",
        name: "Acme Agent",
        command: "acme",
        color: "#3366ff",
        iconId: "terminal",
        launchMcp: { format: "claude-mcp-config" },
      },
    ]);
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-contributed", command: "acme", launchAgentId: "acme-agent" });

    const { command } = ptyClient.spawn.mock.calls[0][1];
    const servers = await readServers(configPathFromCommand(command));
    expect(Object.keys(servers)).toEqual(["daintree-ledger"]);
    const [grant] = pluginMcpGrantRegistry.listForTerminal("term-contributed");
    expect(grant).toMatchObject({ scope: READ_WRITE_SCOPE, launchAgentIdHint: "acme-agent" });
  });

  it("mints nothing for a plugin-contributed agent that declared no mechanism", async () => {
    registerPluginAgents("acme.agents", [
      {
        id: "acme-agent",
        name: "Acme Agent",
        command: "acme",
        color: "#3366ff",
        iconId: "terminal",
      },
    ]);
    setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

    await spawn({ id: "term-plain", command: "acme", launchAgentId: "acme-agent" });

    expect(ptyClient.spawn.mock.calls[0][1].command).toBe("acme");
    expect(pluginMcpGrantRegistry.listForTerminal("term-plain")).toEqual([]);
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

  describe("the Daintree Assistant (#13827)", () => {
    const LANE_FILE = "/sessions/p.claude/.lanes/slot-0-s.mcp.json";

    beforeEach(() => {
      mockValidateToken.mockImplementation((token) => (token === "help-token" ? "core" : false));
    });

    function helpSpawn(options: Record<string, unknown> = {}) {
      return spawn({ id: "term-help", env: { DAINTREE_MCP_TOKEN: "help-token" }, ...options });
    }

    it("hands Claude the plugin's read-only server beside the session's own, in one --mcp-config", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      mockClaudeLaunchArgs.mockReturnValue(["--mcp-config", LANE_FILE]);

      await helpSpawn();

      const { command } = ptyClient.spawn.mock.calls[0][1];
      expect(command.match(/--mcp-config/g)).toHaveLength(1);
      const match = /'?--mcp-config'? '?([^' ]+)'? '?([^' ]+)'?/.exec(command);
      expect(match?.[1]).toBe(LANE_FILE);
      const servers = await readServers(match![2]!);
      expect(Object.keys(servers)).toEqual(["daintree-ledger"]);
      expect(servers["daintree-ledger"]!.url).toBe("http://127.0.0.1:45454/mcp/plugin/acme.ledger");
      const [grant] = pluginMcpGrantRegistry.listForTerminal("term-help");
      expect(grant).toMatchObject({
        scope: { databases: true },
        consumer: "assistant",
        launchAgentIdHint: "claude",
      });
      expect(servers["daintree-ledger"]!.headers.Authorization).toMatch(/^Bearer /);
      expect(mockMarkTerminalForToken).toHaveBeenCalledWith("help-token", "term-help", "claude");
    });

    it("never gives the Assistant more than the project's agents have", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

      await helpSpawn();

      const [grant] = pluginMcpGrantRegistry.listForTerminal("term-help");
      expect(grant?.scope).toEqual({ databases: true });
    });

    it("hands a Codex session the plugin's server as -c overrides, its bearer in the env", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      mockCodexLaunchArgs.mockReturnValue(["-c", 'mcp_servers.daintree-docs.transport="http"']);

      await helpSpawn({ command: "codex", launchAgentId: "codex" });

      const { command, env } = ptyClient.spawn.mock.calls[0][1];
      expect(command).toContain("mcp_servers.daintree-docs.transport");
      expect(command).toContain(
        'mcp_servers.daintree-ledger.url="http://127.0.0.1:45454/mcp/plugin/acme.ledger"'
      );
      const bearer = env?.DAINTREE_PLUGIN_MCP_TOKEN_1 as string;
      expect(env?.DAINTREE_MCP_TOKEN).toBe("help-token");
      expect(command).not.toContain(bearer);
      const [grant] = pluginMcpGrantRegistry.listForTerminal("term-help");
      expect(grant).toMatchObject({ scope: READ_WRITE_SCOPE, consumer: "assistant" });
      expect(pluginMcpGrantRegistry.authenticate(bearer)).toBe(grant);
    });

    it("hands a Copilot session the plugin's server through --additional-mcp-config", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      mockCopilotLaunchArgs.mockReturnValue([]);

      await helpSpawn({ command: "copilot", launchAgentId: "copilot" });

      const { command } = ptyClient.spawn.mock.calls[0][1];
      expect(command).toContain("--additional-mcp-config");
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toHaveLength(1);
    });

    it("skips a plugin whose server name the session already uses", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      mockPluginLaunchContext.mockReturnValue({
        projectId: PROJECT_A,
        projectPath: tmpDir,
        serverNamesInUse: new Set(["daintree-ledger"]),
      });

      await helpSpawn();

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      expect(ptyClient.spawn.mock.calls[0][1].command).not.toContain("--mcp-config");
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);
    });

    it("revokes what it minted when the session was displaced before the launch bound", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      mockMarkTerminalForToken.mockReturnValue(false);

      await expect(helpSpawn()).rejects.toThrow(/invalid or already displaced/);

      expect(ptyClient.spawn).not.toHaveBeenCalled();
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);
    });

    it("hands over nothing live when the session's teardown began while its servers were prepared", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      const context = mockPluginLaunchContext.getMockImplementation()!;
      // Live when the launch asks, ending once it has bound.
      mockPluginLaunchContext.mockImplementationOnce(context).mockImplementation(() => null);

      await helpSpawn();

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);
    });

    it("gives a restarted Assistant, which arrives with no help token, no plugin servers", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      mockIsHelpTerminal.mockImplementation((terminalId) => terminalId === "term-help");

      await spawn({ id: "term-help" });

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);

      // An ordinary pane in the same project still gets them.
      await spawn({ id: "term-agent" });
      expect(pluginMcpGrantRegistry.listForTerminal("term-agent")).toHaveLength(1);
    });

    it("launches the Assistant without plugin tools when preparing them fails", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      setProjectAssistantAgentMcpAccess(PROJECT_A, "acme.ledger", "read-only");
      mockClaudeLaunchArgs.mockReturnValue(["--mcp-config", LANE_FILE]);
      mockListPlugins.mockImplementation(() => {
        throw new Error("plugin registry unavailable");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      await helpSpawn();

      expect(ptyClient.spawn.mock.calls[0][1].command).toContain(LANE_FILE);
      expect(pluginMcpGrantRegistry.listForTerminal("term-help")).toEqual([]);
      errors.mockRestore();
    });
  });

  // A launch that requires a plugin's tools (a plugin recipe's
  // `requiresAgentTools`) is refused rather than started without them (#14096).
  describe("required plugin tools", () => {
    async function refusal(options: Record<string, unknown>) {
      const error = await spawn(options).then(
        () => {
          throw new Error("expected the launch to be refused");
        },
        (err: unknown) => err as AppError
      );
      expect(error.code).toBe("REQUIRED_PLUGIN_TOOLS_UNAVAILABLE");
      expect(ptyClient.spawn).not.toHaveBeenCalled();
      expect(pluginMcpGrantRegistry.listForTerminal(options.id as string)).toEqual([]);
      return error.details?.code === "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE"
        ? error.details.tools
        : null;
    }

    afterEach(() => {
      spawnCtx.current = { webContentsId: 0, projectId: null };
      clearPluginToolsLaunches();
      Object.assign(mcpServerService, { isRunning: true, ensureReady: async () => true });
    });

    it("launches on first try when the required plugin's tools are handed over", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

      await spawn({ id: "term-req", requiredPluginTools: ["acme.ledger"] });

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      expect(pluginMcpGrantRegistry.listForTerminal("term-req")).toHaveLength(1);
    });

    it("refuses as pending-load when plugin init doesn't settle, where an ordinary launch goes ahead", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      mockWaitForCatalog.mockImplementation(() => new Promise<void>(() => {}));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = refusal({ id: "term-req-timeout", requiredPluginTools: ["acme.ledger"] });
        await vi.waitFor(() => expect(mockWaitForCatalog).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toEqual([
          {
            pluginInstanceId: "acme.ledger",
            pluginDisplayName: "acme.ledger",
            state: "pending-load",
          },
        ]);
      } finally {
        vi.useRealTimers();
        warn.mockRestore();
      }
    });

    it("refuses as pending-load while the project's plugins are still loading, and launches on retry once they have", async () => {
      const instance = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
      setProjectAgentMcpAccess(PROJECT_A, instance, "read-write");
      let trusted = false;
      mockWaitForProjectPlugins.mockImplementation(() => Promise.resolve(trusted));
      mockListPlugins.mockImplementation(() =>
        trusted ? [plugin({ instanceId: instance, origin: "project", projectId: PROJECT_A })] : []
      );
      mockHasPlugin.mockImplementation(() => trusted);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const tools = await refusal({ id: "term-trust", requiredPluginTools: [instance] });
        expect(tools?.map((tool) => tool.state)).toEqual(["pending-load"]);

        // The folder is trusted and its plugin loads: a retry is a fresh attempt.
        trusted = true;
        await spawn({ id: "term-trust", requiredPluginTools: [instance] });
      } finally {
        warn.mockRestore();
      }

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      expect(pluginMcpGrantRegistry.listForTerminal("term-trust")).toHaveLength(1);
    });

    it("refuses as disabled-access when the plugin runs but its tools are off here", async () => {
      expect(await refusal({ id: "term-off-req", requiredPluginTools: ["acme.ledger"] })).toEqual([
        {
          pluginInstanceId: "acme.ledger",
          pluginDisplayName: "acme.ledger",
          state: "disabled-access",
        },
      ]);

      // Another plugin on in the project doesn't change the answer for this one.
      mockListPlugins.mockReturnValue([plugin(), plugin({ name: "acme.other", mcpName: "other" })]);
      setProjectAgentMcpAccess(PROJECT_A, "acme.other", "read-write");
      const tools = await refusal({ id: "term-off-req-2", requiredPluginTools: ["acme.ledger"] });
      expect(tools).toEqual([
        { pluginInstanceId: "acme.ledger", pluginDisplayName: "Ledger", state: "disabled-access" },
      ]);
    });

    it("refuses as unavailable for a plugin that isn't serving this project after a project switch", async () => {
      const foreign = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");
      mockListPlugins.mockReturnValue([
        plugin({ instanceId: foreign, origin: "project", projectId: PROJECT_B }),
      ]);
      setProjectAgentMcpAccess(PROJECT_A, "acme.other", "read-write");

      const tools = await refusal({ id: "term-switched", requiredPluginTools: [foreign] });
      expect(tools?.map((tool) => tool.state)).toEqual(["unavailable"]);
    });

    it("refuses as unsupported-format for an agent that can't be handed MCP servers", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");

      const tools = await refusal({
        id: "term-cursor",
        launchAgentId: "cursor",
        command: "cursor-agent",
        requiredPluginTools: ["acme.ledger"],
      });
      expect(tools?.map((tool) => tool.state)).toEqual(["unsupported-format"]);
    });

    it("refuses as listener-failed when Daintree's MCP listener can't start", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      Object.assign(mcpServerService, { isRunning: false, ensureReady: async () => false });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const tools = await refusal({ id: "term-listener", requiredPluginTools: ["acme.ledger"] });
        expect(tools?.map((tool) => tool.state)).toEqual(["listener-failed"]);
      } finally {
        warn.mockRestore();
      }
    });

    it("refuses as config-failed and leaves no grant when preparing the agent's config throws", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      const prepare = vi
        .spyOn(mcpPaneConfigService, "preparePaneConfig")
        .mockRejectedValueOnce(new Error("disk full"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const tools = await refusal({ id: "term-config", requiredPluginTools: ["acme.ledger"] });
        expect(tools?.map((tool) => tool.state)).toEqual(["config-failed"]);
      } finally {
        prepare.mockRestore();
        errors.mockRestore();
      }
    });

    it("refuses as revoked when access is taken away while the launch is prepared", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      const realPrepare = mcpPaneConfigService.preparePaneConfig.bind(mcpPaneConfigService);
      const prepare = vi
        .spyOn(mcpPaneConfigService, "preparePaneConfig")
        .mockImplementationOnce(async (params) => {
          setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "off");
          return realPrepare(params);
        });

      try {
        const tools = await refusal({ id: "term-revoked", requiredPluginTools: ["acme.ledger"] });
        expect(tools?.map((tool) => tool.state)).toEqual(["revoked"]);
      } finally {
        prepare.mockRestore();
      }
    });

    it("refuses rather than launching when resolving the plugins throws", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      mockListPlugins.mockImplementation(() => {
        throw new Error("plugin registry unavailable");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const tools = await refusal({ id: "term-throws", requiredPluginTools: ["acme.ledger"] });
        expect(tools?.map((tool) => tool.state)).toEqual(["config-failed"]);
      } finally {
        errors.mockRestore();
      }
    });

    it("refuses a restarted Assistant pane that requires tools it is never handed", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      mockIsHelpTerminal.mockImplementation((terminalId) => terminalId === "term-help-req");

      const tools = await refusal({ id: "term-help-req", requiredPluginTools: ["acme.ledger"] });
      expect(tools?.map((tool) => tool.state)).toEqual(["unavailable"]);
    });

    it("refuses as listener-failed when the listener's start throws", async () => {
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      Object.assign(mcpServerService, {
        isRunning: false,
        ensureReady: async () => {
          throw new Error("no free port");
        },
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const tools = await refusal({ id: "term-port", requiredPluginTools: ["acme.ledger"] });
        expect(tools?.map((tool) => tool.state)).toEqual(["listener-failed"]);
      } finally {
        errors.mockRestore();
      }
    });

    it("records no launch for a spawn that fails before the PTY is dispatched", async () => {
      ptyClient.spawn.mockImplementationOnce(() => {
        throw new Error("pty host gone");
      });
      await expect(spawn({ id: "term-failed" })).rejects.toThrow();
      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      expect(
        listRelaunchNeeded(PROJECT_A, [
          { pluginInstanceId: "acme.ledger", pluginDisplayName: "Ledger", scope: READ_WRITE_SCOPE },
        ])
      ).toEqual([]);
    });

    it("starts without the tools only when the user chose to", async () => {
      await spawn({
        id: "term-anyway",
        requiredPluginTools: ["acme.ledger"],
        allowMissingPluginTools: true,
      });

      expect(ptyClient.spawn.mock.calls[0][1].command).toBe("claude");
      expect(pluginMcpGrantRegistry.listForTerminal("term-anyway")).toEqual([]);
    });

    it("holds a launch forwarded from an attached remote frontend to the same requirement", async () => {
      spawnCtx.current = { webContentsId: -7, projectId: PROJECT_A };

      const tools = await refusal({ id: "term-remote", requiredPluginTools: ["acme.ledger"] });
      expect(tools?.map((tool) => tool.state)).toEqual(["disabled-access"]);

      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      await spawn({ id: "term-remote", requiredPluginTools: ["acme.ledger"] });
      expect(pluginMcpGrantRegistry.listForTerminal("term-remote")).toHaveLength(1);
    });

    it("lists a running agent for relaunch once access it started without is turned on", async () => {
      await spawn({ id: "term-before" });
      const eligible = () => [
        {
          pluginInstanceId: "acme.ledger",
          pluginDisplayName: "Ledger",
          scope: READ_WRITE_SCOPE,
        },
      ];
      expect(listRelaunchNeeded(PROJECT_A, [])).toEqual([]);

      setProjectAgentMcpAccess(PROJECT_A, "acme.ledger", "read-write");
      expect(listRelaunchNeeded(PROJECT_A, eligible())).toEqual([
        { terminalId: "term-before", pluginDisplayNames: ["Ledger"] },
      ]);

      // An agent launched after the change has the tools and isn't listed.
      await spawn({ id: "term-after" });
      expect(listRelaunchNeeded(PROJECT_A, eligible()).map((s) => s.terminalId)).toEqual([
        "term-before",
      ]);
    });
  });
});
