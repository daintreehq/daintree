import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: {
    setBadgeCount: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ...electronMock,
}));

import { notificationService } from "../NotificationService.js";

interface WindowListeners {
  focus?: () => void;
  blur?: () => void;
}

function createWindowMock(isFocused = false) {
  const listeners: WindowListeners = {};
  return {
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

describe("NotificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    notificationService.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detaches old window listeners when reinitialized with a new window", () => {
    const firstWindow = createWindowMock(false);
    const secondWindow = createWindowMock(false);

    notificationService.initialize(firstWindow as never);
    notificationService.initialize(secondWindow as never);

    expect(firstWindow.off).toHaveBeenCalledTimes(2);
    expect(firstWindow.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(firstWindow.off).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("clears title when focus event fires", () => {
    const windowMock = createWindowMock(false);
    notificationService.initialize(windowMock as never);

    notificationService.updateNotifications({ waitingCount: 2, failedCount: 1 });
    vi.advanceTimersByTime(301);
    expect(windowMock.setTitle).toHaveBeenCalledWith("(3) Canopy");

    windowMock.trigger("focus");
    expect(windowMock.setTitle).toHaveBeenCalledWith("Canopy");
  });

  it("does not throw if update is called after dispose", () => {
    const windowMock = createWindowMock(false);
    notificationService.initialize(windowMock as never);
    notificationService.dispose();

    expect(() =>
      notificationService.updateNotifications({ waitingCount: 1, failedCount: 0 })
    ).not.toThrow();
  });
});
