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

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

import { dialog } from "electron";
import { notifyError } from "../../ipc/errorHandlers.js";

type EventHandler = (...args: unknown[]) => void;
type WebContentsEventHandler = (event: unknown, ...args: unknown[]) => void;

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

function createMockWindow() {
  const listeners = new Map<string, EventHandler[]>();
  const wcListeners = new Map<string, WebContentsEventHandler[]>();

  const win = {
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
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
      getURL: vi.fn(() => "app://daintree/index.html"),
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

interface CrashRecoveryOptions {
  onRecreateWindow?: () => Promise<void>;
}

function setupCrashRecovery(
  win: ReturnType<typeof createMockWindow>,
  options: CrashRecoveryOptions = {}
) {
  const { onRecreateWindow } = options;
  const rendererCrashTimestamps: number[] = [];
  const oomRecreationTimestamps: number[] = [];
  const recordCrash = vi.fn();

  const getRecoveryUrl = (reason: string, exitCode: number): string => {
    const params = new URLSearchParams({ reason, exitCode: String(exitCode) });
    return `app://daintree/recovery.html?${params}`;
  };

  win.webContents.on("render-process-gone", (_event, ...args) => {
    const details = args[0] as { reason: string; exitCode: number };
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

    const isOom = details.reason === "oom";

    if (rendererCrashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
      setImmediate(() => {
        if (win.isDestroyed()) return;
        win.webContents.loadURL(getRecoveryUrl(details.reason, details.exitCode));
      });
    } else if (isOom && onRecreateWindow) {
      const now2 = Date.now();
      while (
        oomRecreationTimestamps.length > 0 &&
        now2 - oomRecreationTimestamps[0] > CRASH_LOOP_WINDOW_MS
      ) {
        oomRecreationTimestamps.shift();
      }
      oomRecreationTimestamps.push(now2);

      if (oomRecreationTimestamps.length >= CRASH_LOOP_THRESHOLD) {
        setImmediate(() => {
          if (win.isDestroyed()) return;
          win.webContents.loadURL(getRecoveryUrl(details.reason, details.exitCode));
        });
      } else {
        notifyError(
          new Error(
            "The window ran out of memory and was automatically recreated. Some state may have been lost."
          ),
          { source: "renderer-crash" }
        );
        setImmediate(() => {
          if (!win.isDestroyed()) win.destroy();
          onRecreateWindow().catch(() => {});
        });
      }
    } else {
      notifyError(new Error("The renderer process crashed and was automatically reloaded."), {
        source: "renderer-crash",
      });
      setImmediate(() => {
        if (win.isDestroyed()) return;
        win.webContents.reload();
      });
    }
  });

  return { rendererCrashTimestamps, oomRecreationTimestamps, recordCrash };
}

function setupUnresponsiveHandling(win: ReturnType<typeof createMockWindow>) {
  let unresponsiveDialogId = 0;
  let unresponsiveDialogOpen = false;

  win.on("unresponsive", () => {
    if (unresponsiveDialogOpen || win.isDestroyed()) return;
    unresponsiveDialogOpen = true;
    const dialogId = ++unresponsiveDialogId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog.showMessageBox as any)(win, {
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
    vi.mocked(notifyError).mockClear();
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

  it("auto-reloads on first crash (deferred)", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    // Not called synchronously — deferred via setImmediate
    expect(win.webContents.reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledOnce();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("auto-reloads on second crash within 60s (threshold is 3)", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("loads recovery page on third crash within 60s", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(5_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    vi.advanceTimersByTime(5_000);
    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);

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
    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(61_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("third crash loads recovery but does not also reload", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    win.webContents.reload.mockClear();

    vi.advanceTimersByTime(5_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("treats crash at exactly 60s boundary as a new first crash", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("handles three crashes in quick succession", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    expect(win.webContents.reload).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_000);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
  });

  it("does not act on crash if window is destroyed", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win.isDestroyed.mockReturnValue(true);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("OOM crash calls onRecreateWindow instead of reload", () => {
    const win = createMockWindow();
    const onRecreateWindow = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(win, { onRecreateWindow });

    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);

    expect(win.destroy).toHaveBeenCalledOnce();
    expect(onRecreateWindow).toHaveBeenCalledOnce();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("OOM crash buffers notification before destroying window", () => {
    const win = createMockWindow();
    const onRecreateWindow = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(win, { onRecreateWindow });

    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });

    // notifyError is called synchronously before setImmediate
    expect(notifyError).toHaveBeenCalledOnce();
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), { source: "renderer-crash" });
    const errorArg = vi.mocked(notifyError).mock.calls[0][0] as Error;
    expect(errorArg.message).toContain("out of memory");
  });

  it("non-OOM crash buffers notification before reload", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(notifyError).toHaveBeenCalledOnce();
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), { source: "renderer-crash" });
    const errorArg = vi.mocked(notifyError).mock.calls[0][0] as Error;
    expect(errorArg.message).toContain("crashed");
  });

  it("OOM crash still triggers recovery page at crash loop threshold", () => {
    const win = createMockWindow();
    const onRecreateWindow = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(win, { onRecreateWindow });

    // First two OOM crashes → recreate window
    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);
    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);

    // Third OOM crash → recovery page, not recreate
    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
    const url = win.webContents.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("recovery.html");
    // onRecreateWindow called only for first two OOM crashes
    expect(onRecreateWindow).toHaveBeenCalledTimes(2);
  });

  it("OOM crash without onRecreateWindow falls back to reload", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).toHaveBeenCalledOnce();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("does not reload if window is destroyed between crash and deferred execution", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    // Window destroyed after crash event but before setImmediate fires
    win.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("non-OOM crash with onRecreateWindow provided still reloads", () => {
    const win = createMockWindow();
    const onRecreateWindow = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(win, { onRecreateWindow });

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(win.webContents.reload).toHaveBeenCalledOnce();
    expect(onRecreateWindow).not.toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("OOM crashes in one window do not affect another window's recreation budget", () => {
    const winA = createMockWindow();
    const onRecreateA = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(winA, { onRecreateWindow: onRecreateA });

    const winB = createMockWindow();
    const onRecreateB = vi.fn().mockResolvedValue(undefined);
    setupCrashRecovery(winB, { onRecreateWindow: onRecreateB });

    // Two OOM crashes on window A
    winA._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);
    winA._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);
    expect(onRecreateA).toHaveBeenCalledTimes(2);

    // First OOM crash on window B — should still recreate, not trigger recovery
    winB._emitWc("render-process-gone", { reason: "oom", exitCode: 137 });
    vi.advanceTimersByTime(0);
    expect(onRecreateB).toHaveBeenCalledOnce();
    expect(winB.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("does not buffer notification when crash loop threshold is reached", () => {
    const win = createMockWindow();
    setupCrashRecovery(win);

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);
    vi.mocked(notifyError).mockClear();

    win._emitWc("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(notifyError).not.toHaveBeenCalled();
    expect(win.webContents.loadURL).toHaveBeenCalledOnce();
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
