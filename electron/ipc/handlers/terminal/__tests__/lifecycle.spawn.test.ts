import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

const { mockValidateToken, mockIsRunning, mockCurrentPort, mockPreparePaneConfig } = vi.hoisted(
  () => ({
    mockValidateToken: vi.fn<(token: string) => "action" | "system" | false>(),
    mockIsRunning: vi.fn<() => boolean>(),
    mockCurrentPort: vi.fn<() => number | null>(),
    mockPreparePaneConfig: vi.fn(),
  })
);

vi.mock("../../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    validateToken: (token: string) => mockValidateToken(token),
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
  },
}));

vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    preparePaneConfig: (...args: unknown[]) => mockPreparePaneConfig(...args),
    revokePaneConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ipcMain } from "electron";
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

  it("accepts intentional shell metacharacters (pipes, redirects, env, $())", async () => {
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

    // Lock the security-critical script template against structural regressions.
    // The shell path must be single-quoted and the user command must appear
    // verbatim between the trap markers — no further wrapping or rewriting.
    expect(spawnArgs.args).toEqual([
      "-lic",
      `trap : INT\n${command}\ntrap - INT\nexec '/bin/zsh' -l`,
    ]);
  });

  it("single-quotes shell paths containing single quotes when building the launch script", async () => {
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
    expect(spawnArgs.args[1]).toContain("exec '/tmp/o'\\''hare/zsh' -l");
  });
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
  });

  it("appends --strict-mcp-config and skips per-pane MCP injection when DAINTREE_MCP_TOKEN is a valid help token", async () => {
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
    expect(spawnArgs.command).toContain("--strict-mcp-config");
    expect(spawnArgs.command).not.toContain("--mcp-config ");
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions");
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
  });

  it("appends --dangerously-skip-permissions when help session tier is 'system'", async () => {
    mockValidateToken.mockImplementation((token) => (token === "system-token" ? "system" : false));

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
        env: { DAINTREE_MCP_TOKEN: "system-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("--strict-mcp-config");
    expect(spawnArgs.command).toContain("--dangerously-skip-permissions");
  });

  it("does not append --strict-mcp-config twice on a re-spawn whose command already carries it", async () => {
    mockValidateToken.mockReturnValue("action");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude --strict-mcp-config",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "help-token" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    const matches = spawnArgs.command.match(/--strict-mcp-config/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("falls back to per-pane MCP injection when DAINTREE_MCP_TOKEN is not a valid help token", async () => {
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(true);
    mockCurrentPort.mockReturnValue(45454);
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
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "claude",
        launchAgentId: "claude",
        env: { DAINTREE_MCP_TOKEN: "stale-or-spoofed" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toContain("--mcp-config");
    expect(spawnArgs.command).not.toContain("--strict-mcp-config");
    expect(mockPreparePaneConfig).toHaveBeenCalledTimes(1);
  });
});
