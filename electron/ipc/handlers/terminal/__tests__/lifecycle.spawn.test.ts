import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: {
    getPath: vi.fn(() => "/tmp/test"),
  },
}));

const { mockGetCurrentProject, mockGetProjectById, mockGetProjectSettings } = vi.hoisted(() => ({
  mockGetCurrentProject: vi.fn(),
  mockGetProjectById: vi.fn(),
  mockGetProjectSettings: vi.fn(),
}));

const waitForRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const consumeRestoreQuotaMock = vi.hoisted(() => vi.fn(() => false));

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

type SafeParseable = {
  safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

vi.mock("../../../utils.js", () => ({
  waitForRateLimitSlot: waitForRateLimitSlotMock,
  consumeRestoreQuota: consumeRestoreQuotaMock,
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleValidated: (channel: string, schema: SafeParseable, handler: unknown) => {
    ipcMainMock.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      const parsed = schema.safeParse(args[0]);
      if (!parsed.success) {
        throw new Error(`IPC validation failed: ${channel}`);
      }
      return (handler as (payload: unknown) => unknown)(parsed.data);
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../../shared/config/agentRegistry.js", () => ({
  isRegisteredAgent: vi.fn(() => false),
  getAssistantWiredAgentIds: vi.fn(() => ["claude", "codex", "gemini", "copilot"]),
  getEffectiveAgentConfig: vi.fn((id: string) => {
    if (id === "claude") {
      return {
        supports: {
          mcpInjection: "project-config",
          settingsOverlay: true,
          permissionBypass: true,
          trustDialog: true,
          versionProbe: true,
          tier: "stable",
        },
      };
    }
    if (id === "codex") {
      return {
        supports: {
          mcpInjection: "cli-flags",
          settingsOverlay: false,
          permissionBypass: true,
          trustDialog: false,
          versionProbe: true,
          tier: "stable",
        },
      };
    }
    if (id === "gemini") {
      return {
        supports: {
          mcpInjection: "project-config",
          settingsOverlay: true,
          permissionBypass: false,
          trustDialog: true,
          versionProbe: true,
          tier: "experimental",
        },
      };
    }
    if (id === "copilot") {
      return {
        supports: {
          mcpInjection: "project-config",
          settingsOverlay: false,
          permissionBypass: false,
          trustDialog: false,
          versionProbe: true,
          tier: "experimental",
        },
      };
    }
    return undefined;
  }),
}));

const {
  mockValidateToken,
  mockIsRunning,
  mockCurrentPort,
  mockPreparePaneConfig,
  mockEnsureReady,
} = vi.hoisted(() => ({
  mockValidateToken: vi.fn<(token: string) => "action" | "system" | false>(),
  mockIsRunning: vi.fn<() => boolean>(),
  mockCurrentPort: vi.fn<() => number | null>(),
  mockPreparePaneConfig: vi.fn(),
  mockEnsureReady: vi.fn<() => Promise<boolean>>(),
}));

const mockGetCodexLaunchArgs = vi.hoisted(() =>
  vi.fn<(token: string) => string[] | null>(() => null)
);

const mockGetGeminiLaunchArgs = vi.hoisted(() =>
  vi.fn<(token: string) => string[] | null>(() => null)
);

const mockGetCopilotLaunchArgs = vi.hoisted(() =>
  vi.fn<(token: string) => string[] | null>(() => null)
);

const mockGetGeminiSpawnEnv = vi.hoisted(() =>
  vi.fn<(token: string) => Record<string, string> | null>(() => null)
);

const mockMarkTerminalForToken = vi.hoisted(() =>
  vi.fn<(token: string, terminalId: string) => boolean>(() => true)
);

const mockUnbindTerminal = vi.hoisted(() => vi.fn<(terminalId: string) => void>());

const mockGetBypassPermissions = vi.hoisted(() => vi.fn<(token: string) => boolean>(() => false));

const mockGetAssistantScratchEnv = vi.hoisted(() =>
  vi.fn<(token: string) => Record<string, string> | null>(() => null)
);

vi.mock("../../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    validateToken: (token: string) => mockValidateToken(token),
    getCodexLaunchArgs: (token: string) => mockGetCodexLaunchArgs(token),
    getGeminiLaunchArgs: (token: string) => mockGetGeminiLaunchArgs(token),
    getCopilotLaunchArgs: (token: string) => mockGetCopilotLaunchArgs(token),
    getGeminiSpawnEnv: (token: string) => mockGetGeminiSpawnEnv(token),
    getAssistantScratchEnv: (token: string) => mockGetAssistantScratchEnv(token),
    getBypassPermissions: (token: string) => mockGetBypassPermissions(token),
    markTerminalForToken: (token: string, terminalId: string) =>
      mockMarkTerminalForToken(token, terminalId),
    unbindTerminal: (terminalId: string) => mockUnbindTerminal(terminalId),
  },
}));

vi.mock("../../../../services/McpServerService.js", () => ({
  mcpServerService: {
    get isRunning() {
      return mockIsRunning();
    },
    get currentPort() {
      return mockCurrentPort();
    },
    ensureReady: () => mockEnsureReady(),
  },
}));

vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    preparePaneConfig: (...args: unknown[]) => mockPreparePaneConfig(...args),
    revokePaneConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

// Plugin-agent `${settings:*}` resolution (#10619). The real pluginAgentRegistry
// is used (a plugin agent is registered per-test); only the heavy PluginService
// dynamic import is stubbed to a controllable resolveSettingTemplate.
const { mockResolveSettingTemplate } = vi.hoisted(() => ({
  mockResolveSettingTemplate: vi.fn<(pluginId: string, settingId: string) => Promise<string>>(),
}));
vi.mock("../../../../services/PluginService.js", () => ({
  pluginService: {
    resolveSettingTemplate: (pluginId: string, settingId: string) =>
      mockResolveSettingTemplate(pluginId, settingId),
  },
}));

import { ipcMain } from "electron";
import {
  registerPluginAgents,
  clearPluginAgentRegistryForTests,
} from "../../../../../shared/config/pluginAgentRegistry.js";
import { CHANNELS } from "../../../channels.js";
import { registerTerminalLifecycleHandlers } from "../lifecycle.js";
import type { HandlerDependencies } from "../../../types.js";

function getSpawnHandler() {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  const spawnCall = calls.find((c) => c[0] === CHANNELS.TERMINAL_SPAWN);
  return spawnCall?.[1] as unknown as (
    event: Electron.IpcMainInvokeEvent,
    options: Record<string, unknown>
  ) => Promise<string>;
}

beforeEach(() => {
  mockEnsureReady.mockReset();
  mockEnsureReady.mockResolvedValue(false);
});

describe("terminal spawn handler - projectId resolution", () => {
  const projectA = { id: "project-a-id", name: "Project A", path: "/projects/a" };
  const projectB = { id: "project-b-id", name: "Project B", path: "/projects/b" };

  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue(projectB);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("uses explicit projectId when provided and valid", async () => {
    mockGetProjectById.mockReturnValue(projectA);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-a-id");
  });

  it("falls back to current project when projectId is not provided", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-b-id");
  });

  it("falls back to current project when explicit projectId references deleted project", async () => {
    mockGetProjectById.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "deleted-project-id",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-b-id");
  });

  it("handles deleted projectId with no current project gracefully", async () => {
    mockGetProjectById.mockReturnValue(null);
    mockGetCurrentProject.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "deleted-project-id",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBeUndefined();
  });

  it("uses explicit projectId even when current project differs", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    mockGetCurrentProject.mockReturnValue(projectB);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("project-a-id");
    expect(mockGetProjectById).toHaveBeenCalledWith("project-a-id");
  });

  it("fetches project settings using resolved projectId, not current project", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    mockGetCurrentProject.mockReturnValue(projectB);
    mockGetProjectSettings.mockResolvedValue({
      terminalSettings: { shell: "/bin/bash" },
    });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "project-a-id",
      cols: 80,
      rows: 24,
    });

    expect(mockGetProjectSettings).toHaveBeenCalledWith("project-a-id");
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.shell).toBe("/bin/bash");
  });
});

describe("terminal spawn handler - PTY pool eligibility (#7945 regression guard)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: "/tmp", name: "p" });
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("leaves shell undefined in the spawn options for plain terminals so the PTY pool can match", async () => {
    // The PTY pool gate in `acquirePtyProcess` (terminalSpawn.ts) requires
    // `!options.shell`. Promoting the renderer-side default into the spawn
    // options would silently disable the pool for every plain terminal —
    // including the cost of `where pwsh.exe` PATH probes on Windows.
    // The renderer-side `getDefaultShell()` fallback that #7945 introduced
    // is for quoting decisions only; it must not leak into spawnShell.
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.shell).toBeUndefined();
    expect(spawnArgs.command).toBeUndefined();
  });

  it("passes the explicit shell through to spawn options when one is set", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        shell: "/bin/bash",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.shell).toBe("/bin/bash");
  });
});

describe("terminal spawn handler - cwd fallback (#5139: worktree is now renderer-owned)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("falls back to the current project path when cwd is inaccessible", async () => {
    const os = await import("os");
    const tmpDir = os.tmpdir();
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: tmpDir, name: "p" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      cwd: "/nonexistent/path",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.cwd).toBe(tmpDir);
  });

  it("falls back to homedir when no project path is available", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const os = await import("os");
    await handler({} as Electron.IpcMainInvokeEvent, {
      cwd: "/nonexistent/path",
      cols: 80,
      rows: 24,
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.cwd).toBe(os.homedir());
  });

  it("forwards worktreeId to the pty client for session-history persistence (#5182)", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const os = await import("os");
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cwd: os.homedir(),
        cols: 80,
        rows: 24,
        worktreeId: "wt-123",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.worktreeId).toBe("wt-123");
  });
});

describe("terminal spawn shell-injection hardening (#6065)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: "/tmp", name: "p" });
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("rejects commands containing control characters before spawning", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();

    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          command: "echo \x1B[31mred",
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/IPC validation failed: terminal:spawn/);

    expect(ptyClient.spawn).not.toHaveBeenCalled();
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it("rejects multi-line commands at the schema boundary", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();

    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          command: "evil\nrm -rf ~",
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/IPC validation failed: terminal:spawn/);

    expect(ptyClient.spawn).not.toHaveBeenCalled();
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "accepts intentional shell metacharacters (pipes, redirects, env, $())",
    async () => {
      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalLifecycleHandlers(deps);

      const handler = getSpawnHandler();

      const command = "FOO=bar npm run dev | tee out.log; echo $(pwd)";
      await handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          command,
        } as unknown as Parameters<typeof handler>[1]
      );

      expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
      const spawnArgs = ptyClient.spawn.mock.calls[0][1];
      expect(spawnArgs.command).toBe(command);

      // Lock the security-critical inner script template against structural
      // regressions. The shell path must be single-quoted and the user command
      // must appear verbatim between the trap markers.
      if (process.platform === "darwin") {
        expect(spawnArgs.args[0]).toBe("-c");
        expect(spawnArgs.args[1]).toContain("sleep 0.05");
        expect(spawnArgs.args[1]).toContain("exec '/bin/zsh' -lic");
        expect(spawnArgs.args[1]).toContain("trap : INT");
        expect(spawnArgs.args[1]).toContain(command);
        expect(spawnArgs.args[1]).toContain("trap - INT");
      } else {
        expect(spawnArgs.args).toEqual([
          "-lic",
          `trap : INT\n${command}\ntrap - INT\nexec '/bin/zsh' -l`,
        ]);
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "single-quotes shell paths containing single quotes when building the launch script",
    async () => {
      const deps = { ptyClient } as unknown as HandlerDependencies;
      registerTerminalLifecycleHandlers(deps);

      const handler = getSpawnHandler();

      await handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          shell: "/tmp/o'hare/zsh",
          command: "echo hi",
        } as unknown as Parameters<typeof handler>[1]
      );

      const spawnArgs = ptyClient.spawn.mock.calls[0][1];
      if (process.platform === "darwin") {
        expect(spawnArgs.args[1]).toContain("exec '/tmp/o'\\''hare/zsh' -lic");
      } else {
        expect(spawnArgs.args[1]).toContain("exec '/tmp/o'\\''hare/zsh' -l");
      }
    }
  );
});

describe("terminal spawn rate limiting (#5352)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    waitForRateLimitSlotMock.mockResolvedValue(undefined);
    consumeRestoreQuotaMock.mockReturnValue(false);
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: "/tmp", name: "p" });
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  it("uses the leaky-bucket form so batch spawns drain at a smooth 1/sec cadence", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, { cols: 80, rows: 24 });

    // Exactly ("terminalSpawn", 1_000) — 2 args, not 3. The 3-arg overload
    // silently picks the sliding-window implementation and reintroduces the
    // every-10-terminals stall described in #5352.
    expect(waitForRateLimitSlotMock).toHaveBeenCalledWith("terminalSpawn", 1_000);
    expect(waitForRateLimitSlotMock.mock.calls[0]).toHaveLength(2);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects without calling ptyClient.spawn when the rate-limit slot rejects", async () => {
    waitForRateLimitSlotMock.mockRejectedValueOnce(new Error("Spawn queue full"));

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler({} as Electron.IpcMainInvokeEvent, { cols: 80, rows: 24 })
    ).rejects.toThrow("Spawn queue full");

    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("bypasses the rate limiter entirely for restore spawns", async () => {
    consumeRestoreQuotaMock.mockReturnValueOnce(true);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        restore: true,
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(waitForRateLimitSlotMock).not.toHaveBeenCalled();
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("terminal spawn handler - help session detection (#6524)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const os = await import("os");
    tmpDir = os.tmpdir();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: tmpDir, name: "p" });
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(false);
    mockCurrentPort.mockReturnValue(null);
    mockGetCodexLaunchArgs.mockReset();
    mockGetCodexLaunchArgs.mockReturnValue(null);
    mockGetGeminiLaunchArgs.mockReset();
    mockGetGeminiLaunchArgs.mockReturnValue(null);
    mockGetBypassPermissions.mockReset();
    mockGetBypassPermissions.mockReturnValue(false);
    mockMarkTerminalForToken.mockReset();
    mockMarkTerminalForToken.mockReturnValue(true);
    mockUnbindTerminal.mockReset();
    mockGetAssistantScratchEnv.mockReset();
    mockGetAssistantScratchEnv.mockReturnValue(null);
  });

  it("skips per-pane MCP injection when DAINTREE_MCP_TOKEN is a valid help token (session-dir owns the .mcp.json)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    // No flag rewriting on action-tier help launches — Claude Code's normal
    // cwd discovery loads the session-dir .mcp.json that HelpSessionService
    // already wrote.
    expect(spawnArgs.command).toBe("claude");
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("appends --dangerously-skip-permissions when help session bypassPermissions is true", async () => {
    mockValidateToken.mockImplementation((token) => (token === "bypass-token" ? "system" : false));
    mockGetBypassPermissions.mockImplementation((token) => token === "bypass-token");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "bypass-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("--dangerously-skip-permissions");
    expect(spawnArgs.command).not.toContain("--strict-mcp-config");
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("appends --dangerously-skip-permissions even at action tier when bypassPermissions is on", async () => {
    // Tier and bypassPermissions are decoupled (#7532): an action-tier
    // session with bypass on should still skip the CLI confirmation gate.
    mockValidateToken.mockImplementation((token) =>
      token === "bypass-action-token" ? "action" : false
    );
    mockGetBypassPermissions.mockImplementation((token) => token === "bypass-action-token");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "bypass-action-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("--dangerously-skip-permissions");
  });

  it("does NOT append --dangerously-skip-permissions when tier=system but bypassPermissions=false", async () => {
    // Tier and bypassPermissions are decoupled (#7532): a system-tier
    // session can still respect Claude's permission gate.
    mockValidateToken.mockImplementation((token) =>
      token === "system-no-bypass" ? "system" : false
    );
    mockGetBypassPermissions.mockImplementation(() => false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "system-no-bypass" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("claude");
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions");
  });

  it("strips --dangerously-skip-permissions from help launches with bypass off, even if it leaked in via agent settings", async () => {
    // The session-snapshotted bypassPermissions flag is the source of
    // truth. If a user has Claude's global `dangerousEnabled` on, the
    // renderer's command generator may include `--dangerously-skip-permissions`,
    // and a help session with bypass off must strip it so the assistant
    // doesn't silently bypass permission prompts.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetBypassPermissions.mockImplementation(() => false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude --dangerously-skip-permissions",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("claude");
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions");
  });

  it("strips a lookalike --dangerously-skip-permissions=false from help launches with bypass off", async () => {
    // Defense-in-depth: a customArgs lookalike like
    // `--dangerously-skip-permissions=false` could survive a substring-only
    // check. The strip must use a token-boundary regex that also matches
    // `--flag=value` forms.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetBypassPermissions.mockImplementation(() => false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude --dangerously-skip-permissions=false --resume abc",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions");
    expect(spawnArgs.command).toContain("--resume abc");
  });

  it("strips lookalike =false and appends canonical --dangerously-skip-permissions when bypass is on", async () => {
    // Strip-first then conditionally append guarantees the session's
    // bypass preference wins over a smuggled `=false` form in customArgs.
    mockValidateToken.mockImplementation((token) => (token === "bypass-token" ? "action" : false));
    mockGetBypassPermissions.mockImplementation((token) => token === "bypass-token");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude --dangerously-skip-permissions=false --resume abc",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "bypass-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    // No `=false` lookalike survives.
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions=false");
    // Canonical flag is present as a standalone token.
    expect(spawnArgs.command).toMatch(/(^|\s)--dangerously-skip-permissions(\s|$)/);
    expect(spawnArgs.command).toContain("--resume abc");
  });

  it("refuses to spawn when DAINTREE_MCP_TOKEN is present but invalid for an assistant-supported launch (#7509)", async () => {
    // Models the orphan-backend scenario: the renderer provisioned a session,
    // a sibling provision displaced it, then the renderer's spawn IPC arrived
    // carrying the now-revoked token. Falling back to per-pane MCP injection
    // here would resurrect the bug — silently spawning an unmanaged Claude
    // instance in the assistant's slot without single-backend enforcement.
    // The handler must refuse so the renderer is forced to provision fresh.
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(true);
    mockCurrentPort.mockReturnValue(45454);
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "action" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "claude",
          launchAgentId: "claude",
          env: { DAINTREE_MCP_TOKEN: "stale-or-spoofed" },
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/Daintree Assistant session token is invalid/);

    expect(ptyClient.spawn).not.toHaveBeenCalled();
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("starts MCP on demand before injecting config for restored Claude agent spawns", async () => {
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(false);
    mockCurrentPort.mockReturnValue(45454);
    mockEnsureReady.mockImplementation(async () => {
      mockIsRunning.mockReturnValue(true);
      return true;
    });
    mockPreparePaneConfig.mockResolvedValue({
      configPath: "/tmp/pane-config.json",
      token: "pane-token",
    });
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "action" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        id: "restored-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        restore: true,
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(mockEnsureReady).toHaveBeenCalledTimes(1);
    expect(mockPreparePaneConfig).toHaveBeenCalledWith({
      paneId: "restored-pane",
      port: 45454,
      tier: "action",
    });
    expect(spawnArgs.command).toContain("--mcp-config");
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("pane-token");
  });

  it("continues without per-pane MCP injection when MCP cannot be made ready", async () => {
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(false);
    mockCurrentPort.mockReturnValue(null);
    mockEnsureReady.mockResolvedValue(false);
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "action" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(mockEnsureReady).toHaveBeenCalledTimes(1);
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
    expect(spawnArgs.command).toBe("claude");
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
  });

  it("appends Codex MCP -c flags to a Codex help-session spawn", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetCodexLaunchArgs.mockImplementation((token) =>
      token === "help-token"
        ? [
            "-c",
            'mcp_servers.daintree.transport="http"',
            "-c",
            'mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"',
            "-c",
            'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"',
          ]
        : null
    );

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "codex",
        launchAgentId: "codex",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    // Args are shell-quoted with single quotes; the inner double quotes
    // (from TOML literals) are preserved as-is inside the single-quote
    // wrapping.
    expect(spawnArgs.command).toContain(`'mcp_servers.daintree.transport="http"'`);
    expect(spawnArgs.command).toContain(`'mcp_servers.daintree.url="http://127.0.0.1:45454/mcp"'`);
    expect(spawnArgs.command).toContain(
      `'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"'`
    );
    // Token must NEVER appear in argv — it's read from PTY env via bearer_token_env_var.
    expect(spawnArgs.command).not.toContain("help-token");
    // No per-pane MCP injection: the help session owns the MCP wiring.
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("appends --dangerously-bypass-approvals-and-sandbox when bypassPermissions is on for a Codex help launch", async () => {
    mockValidateToken.mockImplementation((token) => (token === "system-token" ? "system" : false));
    mockGetBypassPermissions.mockImplementation((token) => token === "system-token");
    mockGetCodexLaunchArgs.mockReturnValue([]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "codex",
        launchAgentId: "codex",
        env: { DAINTREE_MCP_TOKEN: "system-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("does not query Codex launch args for a non-help Codex launch", async () => {
    mockValidateToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "codex",
        launchAgentId: "codex",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockGetCodexLaunchArgs).not.toHaveBeenCalled();
  });

  it("refuses to spawn when getCodexLaunchArgs returns null — cross-agent token reuse signal (#7533)", async () => {
    // `null` from the agent-specific arg accessor with a valid help token
    // means the token belongs to a different agent. Spawning Codex without
    // its MCP wiring would silently degrade the help session — fail hard.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetCodexLaunchArgs.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "codex",
          launchAgentId: "codex",
          env: { DAINTREE_MCP_TOKEN: "help-token" },
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/does not belong to a Codex session/);
    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("refuses to spawn when getGeminiLaunchArgs returns null — cross-agent token reuse signal (#7533)", async () => {
    // Symmetric to the Codex case — silently spawning Gemini without
    // `--approval-mode=plan` would lose the read-only guardrail, so a
    // mismatched token must hard-fail.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "gemini",
          launchAgentId: "gemini",
          env: { DAINTREE_MCP_TOKEN: "help-token" },
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/does not belong to a Gemini session/);
    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("appends --approval-mode=plan to a Gemini help-session spawn (#7533)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockImplementation((token) =>
      token === "help-token" ? ["--approval-mode=plan"] : null
    );

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("'--approval-mode=plan'");
    // Gemini Phase 1 does not flow through per-pane MCP injection — that
    // path is Claude-only.
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("does NOT append --yolo to a Gemini help-session spawn even when bypassPermissions is on (#7533)", async () => {
    // Gemini's `supports.permissionBypass` is `false` — Phase 1 stays in
    // plan mode regardless of the user's help-assistant bypass setting.
    mockValidateToken.mockImplementation((token) => (token === "bypass-token" ? "system" : false));
    mockGetBypassPermissions.mockImplementation((token) => token === "bypass-token");
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "bypass-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).not.toContain("--yolo");
    expect(spawnArgs.command).toContain("'--approval-mode=plan'");
  });

  it("strips a smuggled --approval-mode=yolo from a Gemini help-session spawn so plan mode is unambiguously authoritative (#7533)", async () => {
    // Defense-in-depth: Gemini CLI's flag parser treats repeated flags as
    // last-wins in practice, but the read-only guardrail must not depend
    // on parser quirks. Strip any user-supplied `--approval-mode=...`
    // before appending the canonical `--approval-mode=plan`.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini --approval-mode=yolo",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).not.toContain("--approval-mode=yolo");
    // Exactly one occurrence of approval-mode (the appended plan flag),
    // never the smuggled yolo.
    const matches = spawnArgs.command.match(/--approval-mode/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(spawnArgs.command).toContain("'--approval-mode=plan'");
  });

  it("strips a smuggled --approval-mode auto_edit form (space-separated value) (#7533)", async () => {
    // Some users may use the long form with a space; the strip must catch
    // both `--approval-mode=value` and `--approval-mode value`.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini --approval-mode auto_edit",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).not.toContain("auto_edit");
    const matches = spawnArgs.command.match(/--approval-mode/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(spawnArgs.command).toContain("'--approval-mode=plan'");
  });

  it("strips a smuggled --yolo from a Gemini help-session spawn (#7533)", async () => {
    // Defense-in-depth: even if a user customFlags entry leaked --yolo
    // into the command string, the dangerous-strip pass removes it before
    // the agent runs in plan mode.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini --yolo",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).not.toContain("--yolo");
    expect(spawnArgs.command).toContain("'--approval-mode=plan'");
  });

  it("does not query Gemini launch args for a non-help Gemini launch (#7533)", async () => {
    mockValidateToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini",
        launchAgentId: "gemini",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockGetGeminiLaunchArgs).not.toHaveBeenCalled();
  });

  it("merges per-agent env from getGeminiSpawnEnv into the PTY env when non-empty (#7542)", async () => {
    // Today `getGeminiSpawnEnv` returns `{}` for Gemini sessions — we don't
    // redirect `GEMINI_CLI_HOME` because it would break OAuth credential
    // lookup. This test guards the merge plumbing so future per-agent env
    // additions land in the PTY env without regression. Uses a sentinel
    // key that isn't actually injected today.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);
    mockGetGeminiSpawnEnv.mockImplementation((token) =>
      token === "help-token" ? { GEMINI_TEST_SENTINEL: "1" } : null
    );

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env).toMatchObject({
      DAINTREE_MCP_TOKEN: "help-token",
      GEMINI_TEST_SENTINEL: "1",
    });
  });

  it("does not inject GEMINI_CLI_HOME when getGeminiSpawnEnv returns {} (#7542)", async () => {
    // OAuth-only Gemini users would lose auth if we redirected `os.homedir()`
    // via `GEMINI_CLI_HOME`. Guard that the renderer + main both honor the
    // empty-env return value.
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetGeminiLaunchArgs.mockReturnValue(["--approval-mode=plan"]);
    mockGetGeminiSpawnEnv.mockReturnValue({});

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "gemini",
        launchAgentId: "gemini",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(spawnArgs.env.DAINTREE_MCP_TOKEN).toBe("help-token");
  });

  it("appends --plan to a Copilot help-session spawn (#7542)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetCopilotLaunchArgs.mockImplementation((token) =>
      token === "help-token" ? ["--plan"] : null
    );

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "copilot",
        launchAgentId: "copilot",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("'--plan'");
    // Copilot help launches don't flow through the Claude per-pane MCP path.
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("refuses to spawn a Copilot help session when getCopilotLaunchArgs returns null — cross-agent token reuse signal (#7542)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetCopilotLaunchArgs.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "copilot",
          launchAgentId: "copilot",
          env: { DAINTREE_MCP_TOKEN: "help-token" },
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/does not belong to a Copilot session/);
    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("strips a smuggled --plan from a Copilot command so the appended flag is unambiguously authoritative (#7542)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetCopilotLaunchArgs.mockReturnValue(["--plan"]);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "copilot --plan",
        launchAgentId: "copilot",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    const matches = spawnArgs.command.match(/--plan/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(spawnArgs.command).toContain("'--plan'");
  });

  it("does not query Copilot launch args for a non-help Copilot launch (#7542)", async () => {
    mockValidateToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "copilot",
        launchAgentId: "copilot",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockGetCopilotLaunchArgs).not.toHaveBeenCalled();
  });

  it("binds terminalId to the help session before spawn so HelpSessionService can kill it on displacement (#7509)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const id = await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockMarkTerminalForToken).toHaveBeenCalledWith("help-token", id);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses to spawn an assistant PTY when markTerminalForToken returns false (#7509)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockMarkTerminalForToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "claude",
          launchAgentId: "claude",
          env: { DAINTREE_MCP_TOKEN: "help-token" },
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/Daintree Assistant session token is invalid/);

    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("does not call markTerminalForToken for a non-help launch", async () => {
    mockValidateToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockMarkTerminalForToken).not.toHaveBeenCalled();
  });

  it("merges DAINTREE_ASSISTANT_SCRATCH_DIR into spawn env for a help launch (#7947)", async () => {
    mockValidateToken.mockImplementation((token) => (token === "help-token" ? "action" : false));
    mockGetAssistantScratchEnv.mockImplementation((token) =>
      token === "help-token"
        ? { DAINTREE_ASSISTANT_SCRATCH_DIR: "/var/user-data/assistant-scratch/abc/sess-1" }
        : null
    );

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_SCRATCH_DIR).toBe(
      "/var/user-data/assistant-scratch/abc/sess-1"
    );
    // Original env keys (the help token) must be preserved.
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("help-token");
  });

  it("does not set DAINTREE_ASSISTANT_SCRATCH_DIR for a non-help launch", async () => {
    mockValidateToken.mockReturnValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_SCRATCH_DIR).toBeUndefined();
    expect(mockGetAssistantScratchEnv).not.toHaveBeenCalled();
  });
});

describe("terminal spawn handler - plugin agent ${settings:*} resolution (#10619)", () => {
  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const os = await import("os");
    tmpDir = os.tmpdir();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    mockGetCurrentProject.mockReturnValue({ id: "p1", path: tmpDir, name: "p" });
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
    mockValidateToken.mockReturnValue(false);
    mockResolveSettingTemplate.mockReset();
    clearPluginAgentRegistryForTests();
    // "acme.myagent" is contributed by plugin "acme.plugin"; "vanilla-agent" is
    // intentionally never registered (stands in for a built-in/unknown agent).
    registerPluginAgents("acme.plugin", [
      {
        id: "acme.myagent",
        name: "My Agent",
        command: "acme-cli",
        color: "#3366ff",
        iconId: "terminal",
      },
    ]);
  });

  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("resolves a ${settings:*} template in a plugin agent's command before spawning", async () => {
    mockResolveSettingTemplate.mockResolvedValue("sk-live-123");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "acme-cli --token=${settings:apiToken}",
        launchAgentId: "acme.myagent",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockResolveSettingTemplate).toHaveBeenCalledWith("acme.plugin", "apiToken");
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("acme-cli --token=sk-live-123");
    expect(spawnArgs.command).not.toContain("${settings:");
  });

  it("refuses to spawn (and never reaches the PTY) when a referenced setting is unset", async () => {
    // resolveSettingTemplate returns "" for an unset/missing setting.
    mockResolveSettingTemplate.mockResolvedValue("");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        {} as Electron.IpcMainInvokeEvent,
        {
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "acme-cli --token=${settings:apiToken}",
          launchAgentId: "acme.myagent",
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/Unmatched setting template "apiToken"/);

    expect(ptyClient.spawn).not.toHaveBeenCalled();
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it("does not touch PluginService for a non-plugin agent, leaving the literal untouched", async () => {
    // "vanilla-agent" is never registered, so getPluginIdForAgent returns
    // undefined and the resolution block is skipped — no lazy PluginService load.
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "vanilla-cli --token=${settings:apiToken}",
        launchAgentId: "vanilla-agent",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(mockResolveSettingTemplate).not.toHaveBeenCalled();
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("vanilla-cli --token=${settings:apiToken}");
  });

  it("skips resolution entirely when the command embeds no template", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "acme-cli --interactive",
        launchAgentId: "acme.myagent",
      } as unknown as Parameters<typeof handler>[1]
    );

    // The cheap `includes("${settings:")` pre-check short-circuits before any
    // plugin work, so no PluginService resolution happens for the common case —
    // even though "acme.myagent" *is* a registered plugin agent.
    expect(mockResolveSettingTemplate).not.toHaveBeenCalled();
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("acme-cli --interactive");
  });
});
