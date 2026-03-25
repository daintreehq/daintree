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

vi.mock("../../../services/pty/terminalShell.js", () => ({
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
import { registerTerminalLifecycleHandlers, AGENT_INIT_DONE_MARKER } from "../lifecycle.js";
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

describe("agent command injection - shell ready detection", () => {
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

  it("writes stty -echo then sentinel, waits for sentinel before agent command", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    // First write: stty -echo
    expect(ptyClient.write.mock.calls[0][1]).toBe("stty -echo\r");
    // Second write: sentinel echo
    const sentinelWrite = ptyClient.write.mock.calls[1];
    expect(sentinelWrite[0]).toBe(id);
    expect(sentinelWrite[1]).toMatch(/echo __CANOPY_READY_/);
    expect(ptyClient.write).toHaveBeenCalledTimes(2);

    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0];
    ptyClient.emit("data", id, `some init output\n${sentinel}\n`);

    expect(ptyClient.write).toHaveBeenCalledTimes(3);
    expect(ptyClient.write.mock.calls[2][1]).toBe(
      `stty echo; echo ${AGENT_INIT_DONE_MARKER}; exec gemini chat\r`
    );
  });

  it("does not write command twice after sentinel arrives", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "claude",
      command: "claude",
    });

    const sentinelWrite = ptyClient.write.mock.calls[1];
    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0];

    ptyClient.emit("data", id, sentinel!);
    expect(ptyClient.write).toHaveBeenCalledTimes(3);

    ptyClient.emit("data", id, sentinel!);
    expect(ptyClient.write).toHaveBeenCalledTimes(3);
  });

  it("cleans up listeners if terminal exits before sentinel", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    expect(ptyClient.listenerCount("data")).toBeGreaterThan(0);

    ptyClient.emit("exit", id, 1);

    expect(ptyClient.listenerCount("data")).toBe(0);
    expect(ptyClient.listenerCount("exit")).toBe(0);
    // stty -echo + sentinel only, no command written
    expect(ptyClient.write).toHaveBeenCalledTimes(2);
  });

  it("ignores data from different terminal ids", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    const sentinelWrite = ptyClient.write.mock.calls[1];
    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0];

    ptyClient.emit("data", "other-terminal-id", sentinel!);
    expect(ptyClient.write).toHaveBeenCalledTimes(2);

    ptyClient.emit("data", id, sentinel!);
    expect(ptyClient.write).toHaveBeenCalledTimes(3);
  });

  it("detects sentinel split across multiple data chunks", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    const sentinelWrite = ptyClient.write.mock.calls[1];
    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0] as string;

    const mid = Math.floor(sentinel.length / 2);
    ptyClient.emit("data", id, sentinel.slice(0, mid));
    expect(ptyClient.write).toHaveBeenCalledTimes(2);

    ptyClient.emit("data", id, sentinel.slice(mid));
    expect(ptyClient.write).toHaveBeenCalledTimes(3);
  });

  it("non-agent terminal with command does not use sentinel or stty", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls -la",
    });

    expect(ptyClient.write).not.toHaveBeenCalled();

    await vi.waitFor(
      () => {
        expect(ptyClient.write).toHaveBeenCalledTimes(1);
      },
      { timeout: 500 }
    );
    expect(ptyClient.write.mock.calls[0][1]).toBe("ls -la\r");
  });

  it("includes marker and stty echo when sentinel times out", async () => {
    vi.useFakeTimers();
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

    // stty -echo + sentinel
    expect(ptyClient.write).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3000);

    expect(ptyClient.write).toHaveBeenCalledTimes(3);
    expect(ptyClient.write.mock.calls[2][1]).toBe(
      `stty echo; echo ${AGENT_INIT_DONE_MARKER}; exec gemini chat\r`
    );
    vi.useRealTimers();
  });

  it("does not write command when terminal is gone before sentinel", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    ptyClient.hasTerminal.mockReturnValue(false);
    const sentinelWrite = ptyClient.write.mock.calls[1];
    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0];
    ptyClient.emit("data", id, sentinel!);

    // stty -echo + sentinel only, command skipped (terminal gone)
    expect(ptyClient.write).toHaveBeenCalledTimes(2);
  });

  it("non-agent command does not include marker", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      command: "ls -la",
    });

    await vi.waitFor(
      () => {
        expect(ptyClient.write).toHaveBeenCalledTimes(1);
      },
      { timeout: 500 }
    );
    expect(ptyClient.write.mock.calls[0][1]).not.toContain(AGENT_INIT_DONE_MARKER);
  });

  it("detects sentinel from Uint8Array data", async () => {
    const deps = { ptyClient } as unknown as HandlerDependencies;
    cleanup = registerTerminalLifecycleHandlers(deps);
    const handler = getSpawnHandler();

    const id = await handler({} as Electron.IpcMainInvokeEvent, {
      cols: 80,
      rows: 24,
      kind: "agent",
      agentId: "gemini",
      command: "gemini chat",
    });

    const sentinelWrite = ptyClient.write.mock.calls[1];
    const sentinel = sentinelWrite[1].match(/__CANOPY_READY_\w+__/)?.[0] as string;
    const encoded = new TextEncoder().encode(sentinel);

    ptyClient.emit("data", id, encoded);
    expect(ptyClient.write).toHaveBeenCalledTimes(3);
  });
});
