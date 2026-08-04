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
const waitForBurstRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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

const { persistAgentSessionMock } = vi.hoisted(() => ({
  persistAgentSessionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../services/pty/agentSessionHistory.js", () => ({
  persistAgentSession: persistAgentSessionMock,
  listAgentSessions: vi.fn(() => []),
  clearAgentSessions: vi.fn().mockResolvedValue(undefined),
  pruneAgentSessions: vi.fn().mockResolvedValue(undefined),
  DEFAULT_RETENTION_DAYS: 30,
}));

// Retention is read from the electron-store singleton, which isn't wired in
// this unit test; stub the accessor so the journaling paths get a plain value.
vi.mock("../../../../services/pty/agentSessionRetention.js", () => ({
  getAgentSessionRetentionDays: vi.fn(() => 30),
}));

type SafeParseable = {
  safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

vi.mock("../../../utils.js", () => ({
  waitForRateLimitSlot: waitForRateLimitSlotMock,
  waitForBurstRateLimitSlot: waitForBurstRateLimitSlotMock,
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
  typedHandleWithContextValidated: (channel: string, schema: SafeParseable, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      async (
        event:
          | { sender?: { id?: number }; senderWindow?: { id: number }; projectId?: string }
          | null
          | undefined,
        ...args: unknown[]
      ) => {
        const parsed = schema.safeParse(args[0]);
        if (!parsed.success) {
          throw new Error(`IPC validation failed: ${channel}`);
        }
        // Mirror the real `typedHandleWithContextValidated` ctx shape. Tests
        // drive `senderWindow` / `projectId` by setting them on the event
        // object they pass to the handler (the real wrapper derives
        // `senderWindow` from `BrowserWindow.fromWebContents`).
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: event?.senderWindow ?? null,
          projectId: event?.projectId ?? null,
        };
        return (handler as (ctx: unknown, payload: unknown) => unknown)(ctx, parsed.data);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../../shared/config/agentRegistry.js", () => ({
  isRegisteredAgent: vi.fn(() => false),
  getAssistantWiredAgentIds: vi.fn(() => ["claude", "codex", "copilot"]),
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
  mockRevokePaneConfig,
  mockRegisterAssistantPaneBearer,
  mockSetAssistantPaneWebContentsResolver,
  mockSetAssistantPaneActionContextResolver,
  mockEnsureReady,
} = vi.hoisted(() => ({
  mockValidateToken: vi.fn<(token: string) => "action" | "system" | false>(),
  mockIsRunning: vi.fn<() => boolean>(),
  mockCurrentPort: vi.fn<() => number | null>(),
  mockPreparePaneConfig: vi.fn(),
  mockRevokePaneConfig: vi.fn<(paneId: string) => Promise<void>>(),
  mockRegisterAssistantPaneBearer:
    vi.fn<(token: string, webContentsId: number, actionContext?: unknown) => void>(),
  mockSetAssistantPaneWebContentsResolver: vi.fn(),
  mockSetAssistantPaneActionContextResolver: vi.fn(),
  mockEnsureReady: vi.fn<() => Promise<boolean>>(),
}));

const mockGetCodexLaunchArgs = vi.hoisted(() =>
  vi.fn<(token: string) => string[] | null>(() => null)
);

const mockGetCopilotLaunchArgs = vi.hoisted(() =>
  vi.fn<(token: string) => string[] | null>(() => null)
);

const mockMarkTerminalForToken = vi.hoisted(() =>
  vi.fn<(token: string, terminalId: string) => boolean>(() => true)
);

const mockUnbindTerminal = vi.hoisted(() => vi.fn<(terminalId: string) => void>());

const mockGetBypassPermissions = vi.hoisted(() => vi.fn<(token: string) => boolean>(() => false));

const mockGetDebugLogging = vi.hoisted(() => vi.fn<(token: string) => boolean>(() => false));

const mockGetAssistantScratchEnv = vi.hoisted(() =>
  vi.fn<(token: string) => Record<string, string> | null>(() => null)
);

vi.mock("../../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    validateToken: (token: string) => mockValidateToken(token),
    getCodexLaunchArgs: (token: string) => mockGetCodexLaunchArgs(token),
    getCopilotLaunchArgs: (token: string) => mockGetCopilotLaunchArgs(token),
    getAssistantScratchEnv: (token: string) => mockGetAssistantScratchEnv(token),
    getBypassPermissions: (token: string) => mockGetBypassPermissions(token),
    getDebugLogging: (token: string) => mockGetDebugLogging(token),
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
    setAssistantPaneWebContentsResolver: (...args: unknown[]) =>
      mockSetAssistantPaneWebContentsResolver(...args),
    setAssistantPaneActionContextResolver: (...args: unknown[]) =>
      mockSetAssistantPaneActionContextResolver(...args),
  },
}));

vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    preparePaneConfig: (...args: unknown[]) => mockPreparePaneConfig(...args),
    revokePaneConfig: (paneId: string) => mockRevokePaneConfig(paneId),
    registerAssistantPaneBearer: (token: string, webContentsId: number, actionContext?: unknown) =>
      mockRegisterAssistantPaneBearer(token, webContentsId, actionContext),
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

  // A scratch id is a legitimate owner that resolves to no Project. Retargeting it to
  // whatever is globally current would hand the terminal to the wrong workspace — and
  // let that workspace's delete kill it — so an explicit id is preserved as-is (#11079).
  it("preserves an explicit workspace id that resolves to no project, without retargeting", async () => {
    mockGetProjectById.mockReturnValue(null);
    mockGetCurrentProject.mockReturnValue(projectB);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "scratch-uuid",
      cwd: "/tmp/scratches/scratch-uuid",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("scratch-uuid");
    // and must not inherit the current project's identity or working directory
    expect(spawnArgs.projectId).not.toBe(projectB.id);
    expect(spawnArgs.cwd).not.toBe(projectB.path);
  });

  it("does not fetch project settings for an explicit id that is not a registered project", async () => {
    mockGetProjectById.mockReturnValue(null);
    mockGetCurrentProject.mockReturnValue(projectB);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "scratch-uuid",
      cwd: "/tmp/scratches/scratch-uuid",
      cols: 80,
      rows: 24,
    });

    expect(mockGetProjectSettings).not.toHaveBeenCalled();
  });

  it("keeps the explicit workspace id when there is no current project either", async () => {
    mockGetProjectById.mockReturnValue(null);
    mockGetCurrentProject.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, {
      projectId: "scratch-uuid",
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.projectId).toBe("scratch-uuid");
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

// A request naming both a projectId and a worktreeId asserts a relationship
// between them, and main used to forward it unchecked — so a terminal could be
// stamped with another project's worktree and journal a cross-project resume
// record on close. Main verifies the claim; the renderer still chooses.
describe("terminal spawn handler - worktree/project ownership (#11653)", () => {
  const projectA = { id: "project-a-id", name: "Project A", path: "/projects/a" };
  const projectB = { id: "project-b-id", name: "Project B", path: "/projects/b" };
  const lightweightProject = {
    id: "lightweight-id",
    name: "Notes",
    path: "/folders/notes",
    gitBacked: false as const,
  };

  let ptyClient: {
    spawn: ReturnType<typeof vi.fn>;
    hasTerminal: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  let worktreeService: { isWorktreeOwnedByProject: ReturnType<typeof vi.fn> };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const spawnArgsOf = () => ptyClient.spawn.mock.calls[0][1];

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = {
      spawn: vi.fn(),
      hasTerminal: vi.fn(() => false),
      write: vi.fn(),
    };
    worktreeService = { isWorktreeOwnedByProject: vi.fn() };
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Pass `null` to model "no workspace client wired up" — an explicit
  // `undefined` would trigger the default parameter and silently hand the test
  // the mock service instead.
  const spawnWith = async (
    options: Record<string, unknown>,
    svc: unknown = worktreeService
  ): Promise<void> => {
    const deps = { ptyClient, worktreeService: svc } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, { cols: 80, rows: 24, ...options });
  };

  it("checks the claim against the resolved project's own path and id", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(true);

    await spawnWith({ projectId: "project-a-id", worktreeId: "wt-a1" });

    expect(worktreeService.isWorktreeOwnedByProject).toHaveBeenCalledWith(
      "wt-a1",
      projectA.path,
      "project-a-id"
    );
  });

  it("forwards the worktreeId when the owning project confirms it", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(true);

    await spawnWith({ projectId: "project-a-id", worktreeId: "wt-a1" });

    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  // The core of the issue: project A claiming one of project B's worktrees.
  // Uses a real directory so the handler's cwd-existence check passes — a
  // synthetic path would fall back to home and both hide whether the drop
  // relocated the terminal and emit its own warning, masking this one.
  it("drops a worktreeId the claimed project provably does not own, without relocating the terminal", async () => {
    const existingDir = process.cwd();
    mockGetProjectById.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(false);

    await spawnWith({
      projectId: "project-a-id",
      worktreeId: "wt-belonging-to-b",
      cwd: existingDir,
    });

    expect(spawnArgsOf().worktreeId).toBeUndefined();
    // Dropping the stamp must not become a way to fail or move the terminal.
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(spawnArgsOf().cwd).toBe(existingDir);
    expect(spawnArgsOf().projectId).toBe("project-a-id");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("wt-belonging-to-b"));
  });

  // The verdict has to be settled BEFORE the spawn, not raced against it: a
  // floating .then() that assigns a mutable variable would still pass every
  // test whose mock resolves immediately.
  it("waits for the verdict before spawning", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    let settle: (owned: boolean | null) => void = () => {};
    worktreeService.isWorktreeOwnedByProject.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    const deps = { ptyClient, worktreeService } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);
    const pending = getSpawnHandler()({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      projectId: "project-a-id",
      worktreeId: "wt-belonging-to-b",
    });

    // Let every other await in the handler drain; the spawn must still be held.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ptyClient.spawn).not.toHaveBeenCalled();

    settle(false);
    await pending;

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(spawnArgsOf().worktreeId).toBeUndefined();
  });

  // `null` is "unknown", not "mismatch" — a cold or mid-sync host must not
  // strip metadata on a guess (#11131, #11235).
  it("forwards the worktreeId when ownership is unknown", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(null);

    await spawnWith({ projectId: "project-a-id", worktreeId: "wt-a1" });

    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  it("fails open when the ownership lookup rejects", async () => {
    mockGetProjectById.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockRejectedValue(new Error("host exited"));

    await spawnWith({ projectId: "project-a-id", worktreeId: "wt-a1" });

    // Asserted so this can't pass merely because the lookup was skipped.
    expect(worktreeService.isWorktreeOwnedByProject).toHaveBeenCalledTimes(1);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  it("forwards the worktreeId when no workspace client is wired up", async () => {
    mockGetProjectById.mockReturnValue(projectA);

    await spawnWith({ projectId: "project-a-id", worktreeId: "wt-a1" }, null);

    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  // The pair that gets journaled is the one that matters. A caller sending only
  // a worktreeId still gets the current project stamped beside it, so that
  // derived pair is checked too — otherwise the identical corruption arrives by
  // omitting a field.
  it("checks the pair it is about to stamp, even when the project was only derived", async () => {
    mockGetCurrentProject.mockReturnValue(projectB);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(true);

    await spawnWith({ worktreeId: "wt-b1" });

    expect(worktreeService.isWorktreeOwnedByProject).toHaveBeenCalledWith(
      "wt-b1",
      projectB.path,
      projectB.id
    );
  });

  // #5182: a worktreeId with no project resolved anywhere stamps no pair, so
  // there is nothing to check and nothing to drop.
  it("checks nothing when no project resolves at all", async () => {
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectById.mockReturnValue(null);

    await spawnWith({ worktreeId: "wt-a1" });

    expect(worktreeService.isWorktreeOwnedByProject).not.toHaveBeenCalled();
    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  // A blank id is treated as absent everywhere else in the spawn path, so it
  // must resolve — and be audited — exactly like an omitted one rather than
  // being audited against the empty string.
  it("treats a blank projectId as absent rather than as a claim on nothing", async () => {
    mockGetCurrentProject.mockReturnValue(projectA);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(true);

    await spawnWith({ projectId: "   ", worktreeId: "wt-a1" });

    expect(worktreeService.isWorktreeOwnedByProject).toHaveBeenCalledWith(
      "wt-a1",
      projectA.path,
      projectA.id
    );
  });

  // A scratch id is opaque and owns no worktrees; there is no project to ask.
  it("skips the check for an explicit workspace id that resolves to no project", async () => {
    mockGetProjectById.mockReturnValue(null);

    await spawnWith({
      projectId: "scratch-uuid",
      worktreeId: "wt-a1",
      cwd: "/tmp/scratches/scratch-uuid",
    });

    expect(worktreeService.isWorktreeOwnedByProject).not.toHaveBeenCalled();
    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  // A folder opened without git owns no worktrees, but the project row is not
  // the authority on whether it is git-backed — the host probes the folder, so
  // an external `git init` leaves a stale `gitBacked: false` beside a host
  // serving real ids. The row must not short-circuit the lookup.
  it("still asks the host about a project whose row says it is not git-backed", async () => {
    mockGetProjectById.mockReturnValue(lightweightProject);
    worktreeService.isWorktreeOwnedByProject.mockResolvedValue(true);

    await spawnWith({ projectId: "lightweight-id", worktreeId: "wt-a1" });

    expect(worktreeService.isWorktreeOwnedByProject).toHaveBeenCalledWith(
      "wt-a1",
      lightweightProject.path,
      lightweightProject.id
    );
    expect(spawnArgsOf().worktreeId).toBe("wt-a1");
  });

  it("does not check ownership when no worktreeId is claimed", async () => {
    mockGetProjectById.mockReturnValue(projectA);

    await spawnWith({ projectId: "project-a-id" });

    expect(worktreeService.isWorktreeOwnedByProject).not.toHaveBeenCalled();
    // Proves the spawn actually ran, so this can't pass via an early return.
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
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

  it("caches the launch command as postSpawnInput for a wrapper-less shell (#11339)", async () => {
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
        // nushell can't host a startup wrapper on any platform.
        shell: "/usr/bin/nu",
        command: "claude --resume s-1",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    // The command rides postSpawnInput (PtyClient owns the write + crash replay),
    // not an inline lifecycle-handler write.
    expect(spawnArgs.postSpawnInput).toBe("claude --resume s-1\r");
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "omits postSpawnInput for a wrapper-capable shell — the command rides args (#11339)",
    async () => {
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
          shell: "/bin/bash",
          command: "claude --resume s-1",
        } as unknown as Parameters<typeof handler>[1]
      );

      const spawnArgs = ptyClient.spawn.mock.calls[0][1];
      expect(spawnArgs.postSpawnInput).toBeUndefined();
      // The command is embedded in the shell startup args instead.
      expect(spawnArgs.args?.join(" ")).toContain("claude --resume s-1");
    }
  );
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
      // must appear verbatim between the trap markers. macOS and Linux share
      // the direct -lic form (the macOS sleep-deferral wrapper is gone).
      expect(spawnArgs.args).toEqual([
        "-lic",
        `trap : INT\n${command}\ntrap - INT\nexec '/bin/zsh' -l`,
      ]);
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
      expect(spawnArgs.args[1]).toContain("exec '/tmp/o'\\''hare/zsh' -l");
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
    waitForBurstRateLimitSlotMock.mockResolvedValue(undefined);
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

  it("uses the burst token bucket so interactive bursts pass instantly and batches drain at 1/sec", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler({} as Electron.IpcMainInvokeEvent, { cols: 80, rows: 24 });

    // The burst variant keeps the leaky-bucket cadence after the burst —
    // NOT the sliding-window overload, whose every-10-terminals stall #5352
    // ruled out for batch spawns.
    expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledWith("terminalSpawn", 1_000, 6);
    expect(waitForRateLimitSlotMock).not.toHaveBeenCalled();
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
  });

  it("admits one bounded recipe batch through a single rate-limit slot", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const batch = {
      spawnBatchId: "00000000-0000-4000-8000-000000000001",
      spawnBatchSize: 2,
    };
    await handler({} as Electron.IpcMainInvokeEvent, {
      id: "batch-terminal-1",
      cols: 80,
      rows: 24,
      ...batch,
    });
    await handler({} as Electron.IpcMainInvokeEvent, {
      id: "batch-terminal-2",
      cols: 80,
      rows: 24,
      ...batch,
    });

    expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledTimes(1);
    expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledWith(
      "terminalRecipeSpawnBatch",
      1_000,
      1
    );
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);

    await handler({} as Electron.IpcMainInvokeEvent, {
      id: "batch-terminal-overflow",
      cols: 80,
      rows: 24,
      ...batch,
    });
    expect(waitForBurstRateLimitSlotMock).toHaveBeenLastCalledWith("terminalSpawn", 1_000, 6);
  });

  it("shares one admission across a multi-worktree recipe batch", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    const batch = {
      spawnBatchId: "00000000-0000-4000-8000-000000000012",
      spawnBatchSize: 12,
    };
    await handler({} as Electron.IpcMainInvokeEvent, {
      id: "bulk-terminal-1",
      cols: 80,
      rows: 24,
      ...batch,
    });
    await handler({} as Electron.IpcMainInvokeEvent, {
      id: "bulk-terminal-2",
      cols: 80,
      rows: 24,
      ...batch,
    });

    expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledTimes(1);
    expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledWith(
      "terminalRecipeSpawnBatch",
      1_000,
      1
    );
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects without calling ptyClient.spawn when the rate-limit slot rejects", async () => {
    waitForBurstRateLimitSlotMock.mockRejectedValueOnce(new Error("Spawn queue full"));

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

    expect(waitForBurstRateLimitSlotMock).not.toHaveBeenCalled();
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

  it("injects DAINTREE_ASSISTANT_AUTO_APPROVE=1 when the Daintree Assistant launches with bypassPermissions on", async () => {
    mockValidateToken.mockImplementation((token) =>
      token === "assistant-bypass" ? "system" : false
    );
    mockGetBypassPermissions.mockImplementation((token) => token === "assistant-bypass");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
        env: { DAINTREE_MCP_TOKEN: "assistant-bypass" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_AUTO_APPROVE).toBe("1");
    // The assistant is not Claude Code — no CLI permission flag is appended.
    expect(spawnArgs.command).not.toContain("--dangerously-skip-permissions");
  });

  it("does NOT inject DAINTREE_ASSISTANT_AUTO_APPROVE when the assistant launches with bypassPermissions off", async () => {
    mockValidateToken.mockImplementation((token) =>
      token === "assistant-nobypass" ? "system" : false
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
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
        env: { DAINTREE_MCP_TOKEN: "assistant-nobypass" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_AUTO_APPROVE).toBeUndefined();
  });

  it("injects DAINTREE_ASSISTANT_DEBUG_LOG=1 when the Daintree Assistant launches with debugLogging on", async () => {
    mockValidateToken.mockImplementation((token) =>
      token === "assistant-debug" ? "action" : false
    );
    mockGetDebugLogging.mockImplementation((token) => token === "assistant-debug");

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
        env: { DAINTREE_MCP_TOKEN: "assistant-debug" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_DEBUG_LOG).toBe("1");
  });

  it("does NOT inject DAINTREE_ASSISTANT_DEBUG_LOG when debugLogging is off", async () => {
    mockValidateToken.mockImplementation((token) =>
      token === "assistant-nodebug" ? "action" : false
    );
    mockGetDebugLogging.mockImplementation(() => false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
        env: { DAINTREE_MCP_TOKEN: "assistant-nodebug" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_DEBUG_LOG).toBeUndefined();
  });

  it("does NOT inject DAINTREE_ASSISTANT_DEBUG_LOG for a non-assistant help agent even when debugLogging is on", async () => {
    // The var is scoped to the daintree-assistant CLI; a claude help launch
    // with debugLogging on must never receive it.
    mockValidateToken.mockImplementation((token) => (token === "claude-debug" ? "action" : false));
    mockGetDebugLogging.mockImplementation(() => true);

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
        env: { DAINTREE_MCP_TOKEN: "claude-debug" },
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_ASSISTANT_DEBUG_LOG).toBeUndefined();
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

  it("spawns Gemini as a normal agent — no help-session flag injection after deprecation (#8811)", async () => {
    // Gemini is deprecated from the assistant overlay (#8811) but still
    // launches from the main toolbar. A plain launch (no DAINTREE_MCP_TOKEN)
    // must reach `ptyClient.spawn` with the command untouched and never flow
    // through the Claude per-pane MCP path.
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

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("gemini");
    expect(spawnArgs.command).not.toContain("--approval-mode");
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
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

describe("terminal spawn handler - daintree-assistant MCP env injection (#10639)", () => {
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
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "action" });
    mockValidateToken.mockReturnValue(false);
    mockIsRunning.mockReturnValue(true);
    mockCurrentPort.mockReturnValue(45454);
    mockPreparePaneConfig.mockReset();
    mockPreparePaneConfig.mockResolvedValue({
      configPath: "/tmp/pane-config.json",
      token: "assistant-token",
    });
    mockRevokePaneConfig.mockReset();
    mockRevokePaneConfig.mockResolvedValue(undefined);
  });

  it("injects MCP url, token, and window id into the env, without --mcp-config", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        id: "assistant-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    // Token is minted through the same registered-bearer path as Claude.
    expect(mockPreparePaneConfig).toHaveBeenCalledWith({
      paneId: "assistant-pane",
      port: 45454,
      tier: "action",
    });
    expect(spawnArgs.env?.DAINTREE_MCP_URL).toBe("http://127.0.0.1:45454/mcp");
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("assistant-token");
    expect(spawnArgs.env?.DAINTREE_WINDOW_ID).toBe("7");
    // env-only: no config flag is appended, and the handler does not set
    // DAINTREE_PROJECT_ID (injectDaintreeMetadata owns that downstream).
    expect(spawnArgs.command).toBe("daintree-assistant");
    expect(spawnArgs.env?.DAINTREE_PROJECT_ID).toBeUndefined();
  });

  it("omits DAINTREE_WINDOW_ID when no sender window is in scope", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      {} as Electron.IpcMainInvokeEvent,
      {
        id: "assistant-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("assistant-token");
    expect(spawnArgs.env?.DAINTREE_MCP_URL).toBe("http://127.0.0.1:45454/mcp");
    expect("DAINTREE_WINDOW_ID" in (spawnArgs.env ?? {})).toBe(false);
  });

  it("pins the assistant bearer to the sender WebContents and replays the launch ActionContext (#10647)", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const launchContext = {
      projectId: "p1",
      activeWorktreeId: "wt-7",
      focusedTerminalId: "term-3",
    };

    const handler = getSpawnHandler();
    await handler(
      { sender: { id: 42 }, senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        id: "assistant-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
        actionContext: launchContext,
      } as unknown as Parameters<typeof handler>[1]
    );

    // The minted pane token is promoted to a pinned bearer bound to the sender
    // WebContents id (42), carrying the launch-time ActionContext snapshot.
    expect(mockRegisterAssistantPaneBearer).toHaveBeenCalledWith(
      "assistant-token",
      42,
      launchContext
    );
    // Resolvers are wired so the handshake can consult the pane config service.
    expect(mockSetAssistantPaneWebContentsResolver).toHaveBeenCalled();
    expect(mockSetAssistantPaneActionContextResolver).toHaveBeenCalled();
    // Env contract is unchanged.
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("assistant-token");
  });

  it("skips assistant pinning when the sender WebContents is unknown (#10647)", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    // No `sender` on the event → webContentsId resolves to the 0 sentinel.
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        id: "assistant-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    // Degrade to generic pane-token behaviour rather than pinning to nothing.
    expect(mockRegisterAssistantPaneBearer).not.toHaveBeenCalled();
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("assistant-token");
    expect(spawnArgs.env?.DAINTREE_MCP_URL).toBe("http://127.0.0.1:45454/mcp");
  });

  it("starts the MCP server on demand when it is not already running", async () => {
    mockIsRunning.mockReturnValue(false);
    mockEnsureReady.mockImplementation(async () => {
      mockIsRunning.mockReturnValue(true);
      return true;
    });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 3 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        id: "assistant-pane",
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(mockEnsureReady).toHaveBeenCalledTimes(1);
    expect(mockPreparePaneConfig).toHaveBeenCalled();
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBe("assistant-token");
  });

  it("continues without MCP injection when the server cannot be made ready", async () => {
    mockIsRunning.mockReturnValue(false);
    mockCurrentPort.mockReturnValue(null);
    mockEnsureReady.mockResolvedValue(false);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
    expect(spawnArgs.command).toBe("daintree-assistant");
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
    expect(spawnArgs.env?.DAINTREE_MCP_URL).toBeUndefined();
  });

  it("skips MCP injection when the resolved tier is off", async () => {
    mockGetProjectSettings.mockResolvedValue({ daintreeMcpTier: "off" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
  });

  it("continues spawning when token minting throws", async () => {
    mockPreparePaneConfig.mockRejectedValue(new Error("mint failed"));

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.command).toBe("daintree-assistant");
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
  });

  it('sets DAINTREE_WINDOW_ID to "0" when the window id is 0 (not omitted)', async () => {
    // The injection guard is `windowId !== null`, so a legitimate window id of
    // 0 must still be forwarded. A regression to a falsy check (`!windowId`)
    // would silently drop it.
    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 0 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        cwd: tmpDir,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_WINDOW_ID).toBe("0");
  });

  it("revokes the minted pane config when the PTY spawn throws", async () => {
    ptyClient.spawn.mockImplementation(() => {
      throw new Error("spawn boom");
    });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await expect(
      handler(
        { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
        {
          id: "assistant-pane",
          cols: 80,
          rows: 24,
          cwd: tmpDir,
          command: "daintree-assistant",
          launchAgentId: "daintree-assistant",
        } as unknown as Parameters<typeof handler>[1]
      )
    ).rejects.toThrow(/Failed to spawn terminal/);

    expect(mockPreparePaneConfig).toHaveBeenCalled();
    expect(mockRevokePaneConfig).toHaveBeenCalledWith("assistant-pane");
  });

  it("skips MCP injection when no project can be resolved", async () => {
    mockGetCurrentProject.mockReturnValue(null);
    mockGetProjectById.mockReturnValue(null);

    const deps = { ptyClient } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);

    const handler = getSpawnHandler();
    await handler(
      { senderWindow: { id: 7 } } as unknown as Electron.IpcMainInvokeEvent,
      {
        cols: 80,
        rows: 24,
        command: "daintree-assistant",
        launchAgentId: "daintree-assistant",
      } as unknown as Parameters<typeof handler>[1]
    );

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(mockPreparePaneConfig).not.toHaveBeenCalled();
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.env?.DAINTREE_MCP_TOKEN).toBeUndefined();
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

describe("terminal close handlers - resume journaling", () => {
  function getKillHandler() {
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const call = calls.find((c) => c[0] === CHANNELS.TERMINAL_KILL);
    return call?.[1] as (event: unknown, id: string) => Promise<void>;
  }

  function getGracefulKillHandler() {
    const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
      .calls;
    const call = calls.find((c) => c[0] === CHANNELS.TERMINAL_GRACEFUL_KILL);
    return call?.[1] as (event: unknown, id: string) => Promise<string | null>;
  }

  let ptyClient: {
    getTerminalAsync: ReturnType<typeof vi.fn>;
    gracefulKill: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  let worktreeService: { getMonitorAsync: ReturnType<typeof vi.fn> };

  const agentInfo = {
    id: "term-1",
    launchAgentId: "claude",
    worktreeId: "wt-1",
    title: "Claude",
    projectId: "proj-1",
    cwd: "/repo/feature",
    agentLaunchFlags: ["--resume"],
    agentModelId: "claude-opus-4-8",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    persistAgentSessionMock.mockResolvedValue(undefined);
    ptyClient = {
      getTerminalAsync: vi.fn(),
      gracefulKill: vi.fn(),
      kill: vi.fn(),
    };
    worktreeService = { getMonitorAsync: vi.fn().mockResolvedValue({ branch: "feature/foo" }) };
  });

  function register() {
    const deps = { ptyClient, worktreeService } as unknown as HandlerDependencies;
    registerTerminalLifecycleHandlers(deps);
  }

  it("routes an agent terminal kill through gracefulKill and journals a record", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    register();

    await getKillHandler()({}, "term-1");

    expect(ptyClient.gracefulKill).toHaveBeenCalledWith("term-1");
    expect(ptyClient.kill).not.toHaveBeenCalled();
    expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
    const [record] = persistAgentSessionMock.mock.calls[0];
    expect(record.sessionId).toBe("sess-abc");
    expect(record.agentId).toBe("claude");
    expect(record.cwd).toBe("/repo/feature");
    expect(record.branch).toBe("feature/foo");
  });

  it("hard-kills a non-agent terminal without journaling", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue({ id: "term-2", cwd: "/repo" });
    register();

    await getKillHandler()({}, "term-2");

    expect(ptyClient.kill).toHaveBeenCalledWith("term-2");
    expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
    expect(persistAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not journal when gracefulKill yields no session id", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue(null);
    register();

    await getKillHandler()({}, "term-1");

    expect(ptyClient.gracefulKill).toHaveBeenCalledWith("term-1");
    expect(persistAgentSessionMock).not.toHaveBeenCalled();
  });

  it("journals on the gracefulKill handler and returns the session id", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-xyz");
    register();

    const result = await getGracefulKillHandler()({}, "term-1");

    expect(result).toBe("sess-xyz");
    expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(persistAgentSessionMock.mock.calls[0][0].sessionId).toBe("sess-xyz");
  });

  it("still journals (branch undefined) when the branch lookup fails", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    worktreeService.getMonitorAsync.mockRejectedValue(new Error("workspace host gone"));
    register();

    await getKillHandler()({}, "term-1");

    expect(persistAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(persistAgentSessionMock.mock.calls[0][0].branch).toBeUndefined();
  });

  it("treats a detached HEAD as no branch", async () => {
    ptyClient.getTerminalAsync.mockResolvedValue(agentInfo);
    ptyClient.gracefulKill.mockResolvedValue("sess-abc");
    worktreeService.getMonitorAsync.mockResolvedValue({ branch: "HEAD" });
    register();

    await getKillHandler()({}, "term-1");

    expect(persistAgentSessionMock.mock.calls[0][0].branch).toBeUndefined();
  });
});
