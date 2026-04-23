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

describe("agent command injection via stdin write", () => {
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

  it("waits for a prompt before injecting the agent command", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      agentId: "claude",
      command: "claude --dangerously-skip-permissions",
    });

    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toBeUndefined();
    const id = ptyClient.spawn.mock.calls[0][0];

    // No prompt yet → no write.
    await flush(50);
    expect(ptyClient.write).not.toHaveBeenCalled();

    ptyClient.emit("data", id, "$ ");
    await flush(199);
    expect(ptyClient.write).not.toHaveBeenCalled();

    await flush(1);
    expect(ptyClient.write).toHaveBeenCalledTimes(2);
    const writes = ptyClient.write.mock.calls.map((c) => c[1] as string);
    expect(writes[0]).toContain("\\x1b[2J");
    expect(writes[1]).toBe("claude --dangerously-skip-permissions\r");
  });

  it("tolerates a slow shell (1200ms RC delay) before the first prompt", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls -la",
    });

    const id = ptyClient.spawn.mock.calls[0][0];

    ptyClient.emit("data", id, "loading nvm...\r\n");
    await flush(600);
    ptyClient.emit("data", id, "sourcing ~/.zshrc...\r\n");
    await flush(600);
    expect(ptyClient.write).not.toHaveBeenCalled();

    ptyClient.emit("data", id, "$ ");
    await flush(200);
    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    expect(ptyClient.write.mock.calls[0][1]).toBe("ls -la\r");
  });

  it("handles p10k-style two-phase prompt by resetting quiescence", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "echo hi",
    });

    const id = ptyClient.spawn.mock.calls[0][0];

    ptyClient.emit("data", id, "❯ "); // instant prompt
    await flush(100);
    ptyClient.emit("data", id, "\r\n❯ "); // real prompt redraw
    await flush(100);
    expect(ptyClient.write).not.toHaveBeenCalled();

    await flush(100);
    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    expect(ptyClient.write.mock.calls[0][1]).toBe("echo hi\r");
  });

  it("Windows agent terminal writes command without clear preamble once shell is ready", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      agentId: "claude",
      command: "claude",
    });

    const id = ptyClient.spawn.mock.calls[0][0];

    ptyClient.emit("data", id, "> ");
    await flush(200);
    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    expect(ptyClient.write.mock.calls[0][1]).toBe("claude\r");
  });

  it("skips write when terminal is killed mid-wait", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      agentId: "claude",
      command: "claude",
    });

    const id = ptyClient.spawn.mock.calls[0][0];

    ptyClient.hasTerminal.mockReturnValue(false);
    ptyClient.emit("exit", id, 0);
    await flush(0);

    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
  });

  it("injects the command via timeout fallback when no prompt ever appears", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls",
    });

    await flush(10_000);
    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    expect(ptyClient.write.mock.calls[0][1]).toBe("ls\r");
  });

  it("rejects multi-line commands for agent terminals", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "terminal",
      agentId: "claude",
      command: "claude\nmalicious",
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Multi-line"));
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = ptyClient.spawn.mock.calls[0][1];
    expect(spawnArgs.args).toBeUndefined();

    // Multi-line commands don't get written to stdin; no listeners registered.
    await flush(10_000);
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
