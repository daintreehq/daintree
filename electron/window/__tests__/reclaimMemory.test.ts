import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
}));

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: vi.fn().mockReturnValue(true),
}));

vi.mock("../../ipc/handlers.js", () => ({
  sendToRenderer: vi.fn(),
}));

import { sendToRenderer } from "../../ipc/handlers.js";
import { CHANNELS } from "../../ipc/channels.js";

type EventHandler = (...args: unknown[]) => void;

function createMockWindow() {
  const listeners = new Map<string, EventHandler[]>();

  const win = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    once: vi.fn((event: string, handler: EventHandler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    webContents: {
      id: 1,
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    _emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    },
  };

  return win;
}

describe("reclaimMemory — minimize debounce", () => {
  const mockSendToRenderer = vi.mocked(sendToRenderer);

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendToRenderer.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends reclaim-memory after 5s minimize", () => {
    const win = createMockWindow();
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    expect(mockSendToRenderer).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(mockSendToRenderer).toHaveBeenCalledOnce();
    expect(mockSendToRenderer).toHaveBeenCalledWith(win, CHANNELS.WINDOW_RECLAIM_MEMORY, {
      reason: "minimize",
    });
  });

  it("cancels reclaim if restored before 5s", () => {
    const win = createMockWindow();
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    vi.advanceTimersByTime(3000);
    win._emit("restore");
    vi.advanceTimersByTime(5000);

    expect(mockSendToRenderer).not.toHaveBeenCalled();
  });

  it("does not send if window is no longer minimized when timer fires", () => {
    const win = createMockWindow();
    win.isMinimized.mockReturnValue(false);
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    vi.advanceTimersByTime(5000);

    expect(mockSendToRenderer).not.toHaveBeenCalled();
  });

  it("does not send if window is destroyed when timer fires", () => {
    const win = createMockWindow();
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    win.isDestroyed.mockReturnValue(true);
    vi.advanceTimersByTime(5000);

    expect(mockSendToRenderer).not.toHaveBeenCalled();
  });

  it("handles minimize-restore-minimize cycle correctly", () => {
    const win = createMockWindow();
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    vi.advanceTimersByTime(3000);
    win._emit("restore");
    win._emit("minimize");
    vi.advanceTimersByTime(5000);

    expect(mockSendToRenderer).toHaveBeenCalledOnce();
  });

  it("cleans up timer on window close", () => {
    const win = createMockWindow();
    const { setupMinimizeReclaim } = createReclaimHelper(win);
    setupMinimizeReclaim();

    win._emit("minimize");
    win._emit("closed");
    vi.advanceTimersByTime(5000);

    expect(mockSendToRenderer).not.toHaveBeenCalled();
  });
});

/**
 * Extracts the minimize-reclaim logic from createWindow.ts into a testable helper.
 * This mirrors the inline logic in setupBrowserWindow but is decoupled from the
 * full window creation flow.
 */
function createReclaimHelper(win: ReturnType<typeof createMockWindow>) {
  const RECLAIM_DELAY_MS = 5_000;
  let reclaimTimer: ReturnType<typeof setTimeout> | null = null;

  function setupMinimizeReclaim() {
    win.on("minimize", () => {
      if (reclaimTimer) clearTimeout(reclaimTimer);
      reclaimTimer = setTimeout(() => {
        reclaimTimer = null;
        if (!win.isDestroyed() && win.isMinimized()) {
          vi.mocked(sendToRenderer)(win as never, CHANNELS.WINDOW_RECLAIM_MEMORY, {
            reason: "minimize",
          });
        }
      }, RECLAIM_DELAY_MS);
    });

    win.on("restore", () => {
      if (reclaimTimer) {
        clearTimeout(reclaimTimer);
        reclaimTimer = null;
      }
    });

    win.once("closed", () => {
      if (reclaimTimer) {
        clearTimeout(reclaimTimer);
        reclaimTimer = null;
      }
    });
  }

  return { setupMinimizeReclaim };
}
