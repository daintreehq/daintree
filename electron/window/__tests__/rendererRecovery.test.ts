import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: vi.fn(),
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: vi.fn(() => ({
    recordCrash: vi.fn(),
  })),
}));

vi.mock("../../setup/environment.js", () => ({
  isSmokeTest: false,
}));

vi.mock("../../../shared/config/devServer.js", () => ({
  getDevServerUrl: vi.fn(() => "http://localhost:5173"),
}));

import { dialog } from "electron";

type EventHandler = (...args: unknown[]) => void;
type WebContentsEventHandler = (event: unknown, ...args: unknown[]) => void;

const CRASH_LOOP_WINDOW_MS = 60_000;

function createMockWindow() {
  const listeners = new Map<string, EventHandler[]>();
  const wcListeners = new Map<string, WebContentsEventHandler[]>();

  const win = {
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    once: vi.fn(),
    webContents: {
      id: 1,
      on: vi.fn((event: string, handler: WebContentsEventHandler) => {
        if (!wcListeners.has(event)) wcListeners.set(event, []);
        wcListeners.get(event)!.push(handler);
      }),
      reload: vi.fn(),
      loadURL: vi.fn(),
      getURL: vi.fn(() => "app://canopy/index.html"),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    _emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    },
    _emitWc(event: string, ...args: unknown[]) {
      for (const handler of wcListeners.get(event) ?? []) {
        handler({}, ...args);
      }
    },
  };

  return win;
}

function setupCrashRecovery(win: ReturnType<typeof createMockWindow>) {
  const rendererCrashTimestamps: number[] = [];
  const recordCrash = vi.fn();

  const getRecoveryUrl = (reason: string, exitCode: number): string => {
    const params = new URLSearchParams({ reason, exitCode: String(exitCode) });
    return `app://canopy/recovery.html?${params}`;
  };

  win.webContents.on(
    "render-process-gone",
    (_event: unknown, details: { reason: string; exitCode: number }) => {
      if (details.reason === "clean-exit") return;
      recordCrash(details);

      if (win.isDestroyed()) return;

      const now = Date.now();
      while (
        rendererCrashTimestamps.length > 0 &&
        now - rendererCrashTimestamps[0] > CRASH_LOOP_WINDOW_MS
      ) {
        rendererCrashTimestamps.shift();
      }
      rendererCrashTimestamps.push(now);

      if (rendererCrashTimestamps.length >= 2) {
        win.webContents.loadURL(getRecoveryUrl(details.reason, details.exitCode));
      } else {
        win.webContents.reload();
      }
    }
  );

  return { rendererCrashTimestamps, recordCrash };
}

function setupUnresponsiveHandling(win: ReturnType<typeof createMockWindow>) {
  let unresponsiveDialogId = 0;
  let unresponsiveDialogOpen = false;

  win.on("unresponsive", () => {
    if (unresponsiveDialogOpen || win.isDestroyed()) return;
    unresponsiveDialogOpen = true;
    const dialogId = ++unresponsiveDialogId;

    (dialog.showMessageBox as ReturnType<typeof vi.fn>)(win, {
      type: "warning",
      buttons: ["Wait", "Reload"],
      defaultId: 0,
      title: "Window Not Responding",
      message: "The window is not responding.",
      detail: "You can wait for it to recover or reload the window.",
    })
      .then(({ response }: { response: number }) => {
        if (dialogId !== unresponsiveDialogId) return;
        unresponsiveDialogOpen = false;
        if (response === 1 && !win.isDestroyed()) {
          win.webContents.reload();
        }
      })
      .catch(() => {
        unresponsiveDialogOpen = false;
      });
  });

  win.on("responsive", () => {
    if (unresponsiveDialogOpen) {
      unresponsiveDialogId++;
      unresponsiveDialogOpen = false;
    }
  });

  return {
    getDialogOpen: () => unresponsiveDialogOpen,
  };
}

describe("renderer crash recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores clean-exit", () => {
    const win = createMockWindow();
    const { recordCrash } = setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "clean-exit", exitCode: 0 });

    expect(recordCrash).not.toHaveBeenCalled();
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("auto-reloads on first crash", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(win.webContents.reload).toHaveBeenCalledOnce();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("loads recovery page on second crash within 60s", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10_000);
    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });

    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
    const url = win.webContents.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("recovery.html");
    expect(url).toContain("reason=oom");
    expect(url).toContain("exitCode=137");
  });

  it("resets crash timestamps after 60s window", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(61_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    // Should auto-reload again (not show recovery) since the first crash is outside the window
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("second crash loads recovery but does not also reload", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    win.webContents.reload.mockClear();

    vi.advanceTimersByTime(5_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("treats crash at exactly 60s boundary as a new first crash", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("handles three crashes in quick succession", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.loadURL).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    expect(win.webContents.loadURL).toHaveBeenCalledTimes(2);
  });

  it("does not act on crash if window is destroyed", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win.isDestroyed.mockReturnValue(true);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });
});

describe("unresponsive handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(dialog.showMessageBox).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows dialog when window becomes unresponsive", () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const win = createMockWindow();
    setupUnresponsiveHandling(win);

    win._emit("unresponsive");

    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it("reloads when user clicks Reload", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    const win = createMockWindow();
    setupUnresponsiveHandling(win);

    win._emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);

    expect(win.webContents.reload).toHaveBeenCalledOnce();
  });

  it("does not reload when user clicks Wait", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const win = createMockWindow();
    setupUnresponsiveHandling(win);

    win._emit("unresponsive");
    await vi.advanceTimersByTimeAsync(0);

    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("ignores stale dialog result when window becomes responsive", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    const win = createMockWindow();
    setupUnresponsiveHandling(win);

    win._emit("unresponsive");
    win._emit("responsive");
    await vi.advanceTimersByTimeAsync(0);

    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("does not open duplicate dialogs", () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const win = createMockWindow();
    setupUnresponsiveHandling(win);

    win._emit("unresponsive");
    win._emit("unresponsive");

    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });
});
