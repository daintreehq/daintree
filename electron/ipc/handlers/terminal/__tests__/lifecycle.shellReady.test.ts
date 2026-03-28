import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: {
    getPath: vi.fn(() => "/tmp/test"),
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

vi.mock("../../utils.js", () => ({
  waitForRateLimitSlot: vi.fn(async () => {}),
  consumeRestoreQuota: vi.fn(() => false),
}));

vi.mock("../../../../shared/config/agentRegistry.js", () => ({
  isRegisteredAgent: vi.fn(() => false),
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

function createEmitterPtyClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    spawn: vi.fn(),
    hasTerminal: vi.fn(() => true),
    write: vi.fn(),
  });
}

describe("agent command injection via shell -c flag", () => {
  const project = { id: "proj-id", name: "Project", path: process.cwd() };
  const originalPlatform = process.platform;

  let ptyClient: ReturnType<typeof createEmitterPtyClient>;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "linux" });
    ptyClient = createEmitterPtyClient();
    cleanup = undefined;
    mockGetCurrentProject.mockReturnValue(project);
    mockGetProjectById.mockReturnValue(null);
    mockGetProjectSettings.mockResolvedValue({});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    cleanup?.();
    ptyClient.removeAllListeners();
  });

  it("spawns agent with -lic flag on Unix instead of writing to stdin", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "claude",
      command: "claude --dangerously-skip-permissions",
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-lic", "exec claude --dangerously-skip-permissions"]);
    // No stdin writes for Unix agent terminals
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it("uses -c without -li for non-bash/zsh shells", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "claude",
      command: "claude",
      shell: "/usr/bin/fish",
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-c", "exec claude"]);
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it("non-agent terminal with command uses delayed stdin write", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls -la",
    });

    // No immediate writes
    expect(ptyClient.write).not.toHaveBeenCalled();

    // Command written after delay
    await vi.waitFor(
      () => {
        expect(ptyClient.write).toHaveBeenCalledTimes(1);
      },
      { timeout: 500 }
    );
    expect(ptyClient.write.mock.calls[0][1]).toBe("ls -la\r");
  });

  it("Windows agent terminal falls back to stdin write", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "claude",
      command: "claude",
    });

    // Spawn args should NOT include -lic on Windows
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toBeUndefined();

    // Command written to stdin after delay
    await vi.waitFor(
      () => {
        expect(ptyClient.write).toHaveBeenCalledTimes(1);
      },
      { timeout: 500 }
    );
    expect(ptyClient.write.mock.calls[0][1]).toContain("claude");
  });

  it("rejects multi-line commands for agent terminals", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "claude",
      command: "claude\nmalicious",
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Multi-line"));
    // Spawn should still happen (just without the command in args)
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("does not register data/exit listeners for Unix agent terminals", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    // No data/exit listeners since we don't need sentinel detection
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });
});
