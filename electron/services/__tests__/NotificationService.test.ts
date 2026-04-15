import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: {
    setBadgeCount: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ...electronMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../ipc/utils.js", () => ({
  sendToRenderer: vi.fn(),
}));

import { notificationService } from "../NotificationService.js";

interface WindowListeners {
  focus?: () => void;
  blur?: () => void;
}

function createWindowMock(isFocused = false) {
  const listeners: WindowListeners = {};
  return {
    id: Math.floor(Math.random() * 10000),
    listeners,
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => isFocused),
    setTitle: vi.fn(),
    on: vi.fn((event: "focus" | "blur", handler: () => void) => {
      listeners[event] = handler;
    }),
    off: vi.fn((event: "focus" | "blur") => {
      delete listeners[event];
    }),
    trigger(event: "focus" | "blur") {
      listeners[event]?.();
    },
  };
}

function createRegistryMock(windows: ReturnType<typeof createWindowMock>[]) {
  const contexts = windows.map((w) => ({
    windowId: w.id,
    webContentsId: w.id + 1000,
    browserWindow: w,
    projectPath: null,
    abortController: new AbortController(),
    services: {},
    cleanup: [],
  }));

  return {
    all: () => contexts,
    getPrimary: () => contexts[0],
    getByWindowId: (id: number) => contexts.find((c) => c.windowId === id),
    getByWebContentsId: (id: number) => contexts.find((c) => c.webContentsId === id),
    size: contexts.length,
  };
}

describe("NotificationService", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  afterEach(() => {
    notificationService.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detaches old window listeners when reinitialized with a new registry", () => {
    const firstWindow = createWindowMock(false);
    const secondWindow = createWindowMock(false);

    notificationService.initialize(createRegistryMock([firstWindow]) as never);
    notificationService.initialize(createRegistryMock([secondWindow]) as never);

    expect(firstWindow.off).toHaveBeenCalledTimes(2);
    expect(firstWindow.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(firstWindow.off).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("clears title when focus event fires", () => {
    const windowMock = createWindowMock(false);
    notificationService.initialize(createRegistryMock([windowMock]) as never);

    notificationService.updateNotifications({ waitingCount: 2 });
    vi.advanceTimersByTime(301);
    expect(windowMock.setTitle).toHaveBeenCalledWith("(2) Daintree");

    windowMock.trigger("focus");
    expect(windowMock.setTitle).toHaveBeenCalledWith("Daintree");
  });

  it("does not throw if update is called after dispose", () => {
    const windowMock = createWindowMock(false);
    notificationService.initialize(createRegistryMock([windowMock]) as never);
    notificationService.dispose();

    expect(() => notificationService.updateNotifications({ waitingCount: 1 })).not.toThrow();
  });

  it("tracks focus across multiple windows — badge is 0 when any window focused", () => {
    const win1 = createWindowMock(false);
    const win2 = createWindowMock(true); // win2 starts focused
    notificationService.initialize(createRegistryMock([win1, win2]) as never);

    notificationService.updateNotifications({ waitingCount: 3 });
    vi.advanceTimersByTime(301);

    // win2 is focused, so no title update should show count
    expect(win1.setTitle).toHaveBeenCalledWith("Daintree");
    expect(win2.setTitle).toHaveBeenCalledWith("Daintree");
    expect(electronMock.app.setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("shows badge and title when all windows are blurred", () => {
    const win1 = createWindowMock(true);
    const win2 = createWindowMock(false);
    notificationService.initialize(createRegistryMock([win1, win2]) as never);

    // Blur win1 so both windows are blurred
    win1.trigger("blur");

    notificationService.updateNotifications({ waitingCount: 5 });
    vi.advanceTimersByTime(301);

    expect(win1.setTitle).toHaveBeenCalledWith("(5) Daintree");
    expect(win2.setTitle).toHaveBeenCalledWith("(5) Daintree");
  });

  it("dispose detaches listeners from all tracked windows", () => {
    const win1 = createWindowMock(false);
    const win2 = createWindowMock(false);
    notificationService.initialize(createRegistryMock([win1, win2]) as never);
    notificationService.dispose();

    expect(win1.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win1.off).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(win2.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win2.off).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("isWindowFocused returns true if any window is focused", () => {
    const win1 = createWindowMock(false);
    const win2 = createWindowMock(false);
    notificationService.initialize(createRegistryMock([win1, win2]) as never);

    expect(notificationService.isWindowFocused()).toBe(false);

    win1.trigger("focus");
    expect(notificationService.isWindowFocused()).toBe(true);

    win2.trigger("focus");
    expect(notificationService.isWindowFocused()).toBe(true);

    win1.trigger("blur");
    expect(notificationService.isWindowFocused()).toBe(true);

    win2.trigger("blur");
    expect(notificationService.isWindowFocused()).toBe(false);
  });
});
