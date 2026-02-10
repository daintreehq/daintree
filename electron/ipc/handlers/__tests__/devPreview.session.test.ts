import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const scanOutputMock = vi.fn();

vi.mock("../../../services/UrlDetector.js", () => ({
  UrlDetector: class MockUrlDetector {
    scanOutput = scanOutputMock;
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerDevPreviewHandlers } from "../devPreview.js";
import type { HandlerDependencies } from "../../types.js";

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;

function createMockPtyClient() {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();

  return {
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") {
        dataListeners.add(callback as DataListener);
      }
      if (event === "exit") {
        exitListeners.add(callback as ExitListener);
      }
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") {
        dataListeners.delete(callback as DataListener);
      }
      if (event === "exit") {
        exitListeners.delete(callback as ExitListener);
      }
    }),
    setIpcDataMirror: vi.fn(),
    spawn: vi.fn((id: string, options: { projectId?: string }) => {
      terminals.set(id, { projectId: options.projectId, hasPty: true });
    }),
    hasTerminal: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      return Boolean(terminal && terminal.hasPty);
    }),
    submit: vi.fn(),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
    }),
    getTerminalAsync: vi.fn(async (id: string) => {
      const terminal = terminals.get(id);
      if (!terminal) return null;
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/tmp",
        spawnedAt: Date.now(),
      };
    }),
    replayHistoryAsync: vi.fn(async () => 0),
    emitData: (id: string, data: string) => {
      for (const listener of dataListeners) {
        listener(id, data);
      }
    },
    emitExit: (id: string, exitCode: number) => {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
      for (const listener of exitListeners) {
        listener(id, exitCode);
      }
    },
  };
}

describe("dev preview session handlers", () => {
  let cleanup: () => void = () => {};
  let ptyClient: ReturnType<typeof createMockPtyClient>;
  let send: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    scanOutputMock.mockReset();
    scanOutputMock.mockReturnValue({ buffer: "", url: null, error: null });

    ptyClient = createMockPtyClient();
    send = vi.fn();

    const deps = {
      ptyClient: ptyClient as unknown as HandlerDependencies["ptyClient"],
      mainWindow: {
        webContents: {
          isDestroyed: () => false,
          send,
        },
        isDestroyed: () => false,
      },
    } as unknown as HandlerDependencies;

    cleanup = registerDevPreviewHandlers(deps);
  });

  afterEach(() => {
    cleanup();
  });

  function getRegisteredHandle<TArgs extends unknown[], TResult>(
    channel: string
  ): ((...args: TArgs) => Promise<TResult>) | undefined {
    const calls = (ipcMain.handle as Mock).mock.calls;
    const call = calls.find(([ch]) => ch === channel);
    return call?.[1] as ((...args: TArgs) => Promise<TResult>) | undefined;
  }

  it("ensures a session, spawns terminal, and emits running state on URL detection", async () => {
    const ensureHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { terminalId: string | null; status: string }
    >(CHANNELS.DEV_PREVIEW_ENSURE);
    expect(ensureHandler).toBeDefined();

    const ensureResult = await ensureHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-1",
      projectId: "project-1",
      cwd: "/repo",
      devCommand: "npm run dev",
      worktreeId: "wt-1",
    });

    expect(ensureResult.status).toBe("starting");
    expect(ensureResult.terminalId).toBeTruthy();
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    expect(ptyClient.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        projectId: "project-1",
        worktreeId: "wt-1",
      })
    );

    scanOutputMock.mockReturnValue({ buffer: "", url: "http://localhost:5173/", error: null });
    ptyClient.emitData(ensureResult.terminalId!, "ready");

    const lastCall = send.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(CHANNELS.DEV_PREVIEW_STATE_CHANGED);
    expect(lastCall?.[1]).toEqual({
      state: expect.objectContaining({
        panelId: "panel-1",
        projectId: "project-1",
        status: "running",
        url: "http://localhost:5173/",
      }),
    });
  });

  it("restart kills previous terminal and spawns a fresh generation", async () => {
    const ensureHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { terminalId: string | null; generation: number }
    >(CHANNELS.DEV_PREVIEW_ENSURE);
    const restartHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { terminalId: string | null; generation: number; status: string }
    >(CHANNELS.DEV_PREVIEW_RESTART);
    expect(ensureHandler).toBeDefined();
    expect(restartHandler).toBeDefined();

    const first = await ensureHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-2",
      projectId: "project-2",
      cwd: "/repo",
      devCommand: "npm run dev",
    });

    const second = await restartHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-2",
      projectId: "project-2",
    });

    expect(second.status).toBe("starting");
    expect(second.generation).toBe(first.generation + 1);
    expect(second.terminalId).toBeTruthy();
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(ptyClient.kill).toHaveBeenCalledWith(first.terminalId, "dev-preview:restart");
  });

  it("returns an error state for empty dev command", async () => {
    const ensureHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { status: string; error: { message: string } | null }
    >(CHANNELS.DEV_PREVIEW_ENSURE);
    expect(ensureHandler).toBeDefined();

    const result = await ensureHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-3",
      projectId: "project-3",
      cwd: "/repo",
      devCommand: "   ",
    });

    expect(result.status).toBe("error");
    expect(result.error?.message).toBe("No dev command configured");
    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("returns stopped state for unknown session on getState", async () => {
    const getStateHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { status: string; panelId: string; projectId: string }
    >(CHANNELS.DEV_PREVIEW_GET_STATE);
    expect(getStateHandler).toBeDefined();

    const result = await getStateHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "missing-panel",
      projectId: "missing-project",
    });

    expect(result.status).toBe("stopped");
    expect(result.panelId).toBe("missing-panel");
    expect(result.projectId).toBe("missing-project");
  });

  it("stops and deletes all sessions for a panel via stop-by-panel", async () => {
    const ensureHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { terminalId: string | null }
    >(CHANNELS.DEV_PREVIEW_ENSURE);
    const stopByPanelHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      void
    >(CHANNELS.DEV_PREVIEW_STOP_BY_PANEL);
    const getStateHandler = getRegisteredHandle<
      [Electron.IpcMainInvokeEvent, Record<string, unknown>],
      { status: string; terminalId: string | null }
    >(CHANNELS.DEV_PREVIEW_GET_STATE);

    expect(ensureHandler).toBeDefined();
    expect(stopByPanelHandler).toBeDefined();
    expect(getStateHandler).toBeDefined();

    const started = await ensureHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-stop-test",
      projectId: "project-stop-test",
      cwd: "/repo",
      devCommand: "npm run dev",
    });

    expect(started.terminalId).toBeTruthy();

    await stopByPanelHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-stop-test",
    });

    expect(ptyClient.kill).toHaveBeenCalledWith(started.terminalId, "dev-preview:panel-closed");

    const afterStop = await getStateHandler!({} as Electron.IpcMainInvokeEvent, {
      panelId: "panel-stop-test",
      projectId: "project-stop-test",
    });

    expect(afterStop.status).toBe("stopped");
    expect(afterStop.terminalId).toBeNull();
  });
});
