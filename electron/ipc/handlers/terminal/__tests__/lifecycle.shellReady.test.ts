import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

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
  waitForRateLimitSlot: vi.fn(async () => {}),
  consumeRestoreQuota: vi.fn(() => false),
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
        console.error(`[IPC] Validation failed for ${channel}:`, parsed.error);
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

/**
 * Drain pending microtasks interleaved with fake-timer advances. Resolving a
 * Promise from a timer callback queues a microtask that cannot be flushed by
 * `vi.advanceTimersByTimeAsync` alone, so `.then(...)` bodies (the command
 * write) may still be pending after the last timer fires. Alternating timer
 * advances with `await Promise.resolve()` flushes them deterministically.
 */
async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe("agent command launch", () => {
  const project = { id: "proj-id", name: "Project", path: process.cwd() };
  const originalPlatform = process.platform;

  let ptyClient: ReturnType<typeof createEmitterPtyClient>;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  it("launches a POSIX agent command through shell startup without echoing stdin", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude --dangerously-skip-permissions",
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.shell).toBe("/bin/zsh");
    expect(spawnArgs.args).toEqual([
      "-lic",
      "trap : INT\nclaude --dangerously-skip-permissions\ntrap - INT\nexec '/bin/zsh' -l",
    ]);
    const id = ptyClient.spawn.mock.calls[0][0];

    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
    expect(id).toBeTruthy();
  });

  it("does not wait for slow shell RC output before launching the command", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls -la",
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-lic", "trap : INT\nls -la\ntrap - INT\nexec '/bin/zsh' -l"]);
    expect(ptyClient.write).not.toHaveBeenCalled();
  });

  it("does not register shell-ready listeners for p10k-style prompt output", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "echo hi",
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-lic", "trap : INT\necho hi\ntrap - INT\nexec '/bin/zsh' -l"]);
    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("Windows agent terminal writes command immediately without clear preamble", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
    });

    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    expect(ptyClient.write.mock.calls[0][1]).toBe("claude\r");
  });

  it("skips stdin write entirely for POSIX command launches", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    ptyClient.hasTerminal.mockReturnValue(false);
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-lic", "trap : INT\nclaude\ntrap - INT\nexec '/bin/zsh' -l"]);
    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("launches the command without a timeout fallback when no prompt appears", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls",
    });

    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toEqual(["-lic", "trap : INT\nls\ntrap - INT\nexec '/bin/zsh' -l"]);
    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("rejects multi-line commands for agent terminals at the schema boundary (#6065)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await expect(
      handler({} as Electron.IpcMainInvokeEvent, {
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude\nmalicious",
      })
    ).rejects.toThrow(/IPC validation failed: terminal:spawn/);

    expect(consoleSpy).toHaveBeenCalled();
    expect(ptyClient.spawn).not.toHaveBeenCalled();

    await flush(1_500);
    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
    consoleSpy.mockRestore();
  });

  it("does not register listeners for terminals spawned without a command", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
    });

    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
    expect(ptyClient.write).not.toHaveBeenCalled();
  });
});
