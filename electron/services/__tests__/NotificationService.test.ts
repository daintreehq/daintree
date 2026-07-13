import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const notificationInstances: NotificationMockInstance[] = [];
  const webContentsById = new Map<number, WebContentsMock>();

  interface WebContentsMock {
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  }

  interface NotificationMockInstance {
    options: { title: string; body: string; silent?: boolean };
    handlers: Record<string, (...args: unknown[]) => void>;
    show: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    once(event: string, handler: (...args: unknown[]) => void): NotificationMockInstance;
    trigger(event: string, ...args: unknown[]): void;
  }

  class NotificationMock implements NotificationMockInstance {
    static isSupported = vi.fn(() => true);
    handlers: Record<string, (...args: unknown[]) => void> = {};
    show = vi.fn();
    removeAllListeners = vi.fn();
    constructor(public options: { title: string; body: string; silent?: boolean }) {
      notificationInstances.push(this);
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    trigger(event: string, ...args: unknown[]) {
      this.handlers[event]?.(...args);
    }
  }

  return {
    app: {
      setBadgeCount: vi.fn(),
    },
    Notification: NotificationMock,
    webContents: {
      fromId: vi.fn((id: number) => webContentsById.get(id)),
    },
    notificationInstances,
    webContentsById,
  };
});

vi.mock("electron", () => ({
  ...electronMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../ipc/utils.js", () => ({
  sendToRenderer: vi.fn(),
}));

// The service asks the registry which view a window is currently showing, and
// which window owns a webContents. Both are keyed off the ids the mocks hand out.
const registryMock = vi.hoisted(() => ({
  getAppWebContents: vi.fn(),
  getWindowForWebContents: vi.fn(),
}));

vi.mock("../../window/webContentsRegistry.js", () => registryMock);

import { sendToRenderer } from "../../ipc/utils.js";
import { notificationService } from "../NotificationService.js";

const sendToRendererMock = vi.mocked(sendToRenderer);

interface WindowListeners {
  focus?: () => void;
  blur?: () => void;
}

let nextWindowId = 1;

/**
 * A window plus the project views it hosts. `ownerIds[0]` is the view the window
 * is currently showing; the rest are cached (deactivated) views — alive, holding
 * their own waiting counts, invisible to the user.
 */
function createWindowMock(isFocused = false, ownerIds: number[] = []) {
  const listeners: WindowListeners = {};
  const id = nextWindowId++;
  return {
    id,
    ownerIds,
    listeners,
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => isFocused),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
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

type WindowMock = ReturnType<typeof createWindowMock>;

function createRegistryMock(windows: WindowMock[]) {
  const contexts = windows.map((w) => ({
    windowId: w.id,
    webContentsId: w.id + 1000,
    browserWindow: w,
    projectPath: null,
    abortController: new AbortController(),
    services: {},
    cleanup: [],
  }));

  const windowForOwner = (ownerId: number) =>
    windows.find((w) => w.ownerIds.includes(ownerId)) ?? null;

  // Wire the webContents lookups the service uses for focus scoping and click
  // routing so they agree with the window/owner topology under test.
  registryMock.getAppWebContents.mockImplementation((win: WindowMock) => ({
    id: win.ownerIds[0] ?? win.id + 1000,
  }));
  registryMock.getWindowForWebContents.mockImplementation(
    (wc: { id: number }) => windowForOwner(wc.id) ?? null
  );

  for (const w of windows) {
    for (const ownerId of w.ownerIds) {
      electronMock.webContentsById.set(ownerId, {
        id: ownerId,
        isDestroyed: () => false,
        send: vi.fn(),
      });
    }
  }

  return {
    all: () => contexts,
    getPrimary: () => contexts[0],
    getByWindowId: (id: number) => contexts.find((c) => c.windowId === id),
    getByWebContentsId: (id: number) => {
      const owned = windowForOwner(id);
      if (owned) return contexts.find((c) => c.windowId === owned.id);
      return contexts.find((c) => c.webContentsId === id);
    },
    size: contexts.length,
  };
}

const ownerSend = (ownerId: number) => electronMock.webContentsById.get(ownerId)!.send;

describe("NotificationService", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    electronMock.webContentsById.clear();
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
    const firstWindow = createWindowMock(false, [11]);
    const secondWindow = createWindowMock(false, [12]);

    notificationService.initialize(createRegistryMock([firstWindow]) as never);
    notificationService.initialize(createRegistryMock([secondWindow]) as never);

    expect(firstWindow.off).toHaveBeenCalledTimes(2);
    expect(firstWindow.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(firstWindow.off).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("clears title when focus event fires", () => {
    const windowMock = createWindowMock(false, [11]);
    notificationService.initialize(createRegistryMock([windowMock]) as never);

    notificationService.updateNotifications(11, { waitingCount: 2 });
    vi.advanceTimersByTime(301);
    expect(windowMock.setTitle).toHaveBeenCalledWith("(2) Daintree");

    windowMock.trigger("focus");
    expect(windowMock.setTitle).toHaveBeenCalledWith("Daintree");
    expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it("does not throw if update is called after dispose", () => {
    const windowMock = createWindowMock(false, [11]);
    notificationService.initialize(createRegistryMock([windowMock]) as never);
    notificationService.dispose();

    expect(() => notificationService.updateNotifications(11, { waitingCount: 1 })).not.toThrow();
  });

  it("dispose detaches listeners from all tracked windows", () => {
    const win1 = createWindowMock(false, [11]);
    const win2 = createWindowMock(false, [21]);
    notificationService.initialize(createRegistryMock([win1, win2]) as never);
    notificationService.dispose();

    expect(win1.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win1.off).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(win2.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win2.off).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("detachWindowListeners clears focus state when the window was destroyed mid-session", () => {
    const win = createWindowMock(true, [11]);
    notificationService.initialize(createRegistryMock([win]) as never);

    expect(notificationService.isWindowFocused()).toBe(true);

    // Simulate native destruction before cleanup runs
    win.isDestroyed.mockReturnValue(true);
    notificationService.detachWindowListeners(win.id);

    // Guarded: off() must NOT be called on a destroyed window (Electron 41 throws)
    expect(win.off).not.toHaveBeenCalled();
    // Stale focus state must be cleared so isWindowFocused() is correct
    expect(notificationService.isWindowFocused()).toBe(false);

    // Second call is a no-op — must not throw
    expect(() => notificationService.detachWindowListeners(win.id)).not.toThrow();
  });

  it("detachWindowListeners removes focus/blur listeners when the window is still alive", () => {
    const win = createWindowMock(true, [11]);
    notificationService.initialize(createRegistryMock([win]) as never);

    expect(notificationService.isWindowFocused()).toBe(true);

    notificationService.detachWindowListeners(win.id);

    expect(win.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win.off).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(notificationService.isWindowFocused()).toBe(false);
  });

  it("detachWindowListeners only clears the targeted window in a multi-window setup", () => {
    const win1 = createWindowMock(true, [11]);
    const win2 = createWindowMock(true, [21]);
    notificationService.initialize(createRegistryMock([win1, win2]) as never);

    expect(notificationService.isWindowFocused()).toBe(true);

    notificationService.detachWindowListeners(win1.id);

    // win1's listeners gone
    expect(win1.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(win1.off).toHaveBeenCalledWith("blur", expect.any(Function));
    // win2 untouched
    expect(win2.off).not.toHaveBeenCalled();
    // win2 still focused, so service still reports focused
    expect(notificationService.isWindowFocused()).toBe(true);

    notificationService.detachWindowListeners(win2.id);
    expect(notificationService.isWindowFocused()).toBe(false);
  });

  it("isWindowFocused returns true if any window is focused", () => {
    const win1 = createWindowMock(false, [11]);
    const win2 = createWindowMock(false, [21]);
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

  it("warns and cleans up when a native notification fails (Electron 42 UNNotification)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    notificationService.showNativeNotification("Agent waiting", "Needs your input");
    const instance = electronMock.notificationInstances.at(-1)!;
    expect(instance.show).toHaveBeenCalled();

    const error = "notification not allowed";
    expect(() => instance.trigger("failed", {}, error)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("native notification failed"),
      error
    );
    // cleanup() must run on failure so the notification is dropped from the
    // active set (otherwise it leaks until dispose()).
    expect(
      (notificationService as unknown as { activeNotifications: Set<unknown> }).activeNotifications
        .size
    ).toBe(0);
  });

  it("warns when a watch notification fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    notificationService.showWatchNotification(
      "Watch hit",
      "Pattern matched",
      { foo: "bar" } as never,
      "navigate:channel"
    );
    const instance = electronMock.notificationInstances.at(-1)!;
    expect(instance.show).toHaveBeenCalled();

    instance.trigger("failed", {}, "unsigned dev build");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("native notification failed"),
      "unsigned dev build"
    );
  });

  // #11110 — state used to be one global `currentState` that any renderer could
  // overwrite, so the last window to report won and every other window's title
  // and the dock badge followed it.
  describe("per-owner waiting counts", () => {
    it("aggregates the badge across owners instead of taking the last writer", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, { waitingCount: 2 });
      notificationService.updateNotifications(21, { waitingCount: 3 });
      vi.advanceTimersByTime(301);

      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(5);
    });

    it("titles each window from its own owners only", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, { waitingCount: 2 });
      notificationService.updateNotifications(21, { waitingCount: 3 });
      vi.advanceTimersByTime(301);

      expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
    });

    it("sums the cached project views a window hosts into one title", () => {
      // One window, active view + a cached one, each with waiting agents.
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, { waitingCount: 1 });
      notificationService.updateNotifications(12, { waitingCount: 2 });
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
    });

    it("focusing one window leaves another window's title and its badge share intact", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, { waitingCount: 2 });
      notificationService.updateNotifications(21, { waitingCount: 3 });
      vi.advanceTimersByTime(301);

      // Old behavior: this zeroed the badge and reset every window's title.
      win2.trigger("focus");

      expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
    });

    it("focus clears only the view the window is showing, not its cached views", () => {
      // The user focuses the window and sees view 11. View 12's waiting agents
      // are still unseen, so they must survive — the renderer only re-reports on
      // a count *change*, so discarding them here would lose the signal for good.
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, { waitingCount: 1 });
      notificationService.updateNotifications(12, { waitingCount: 2 });
      vi.advanceTimersByTime(301);

      win.trigger("focus");

      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
    });

    it("removeOwner drops that owner's count from the badge and title", () => {
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, { waitingCount: 1 });
      notificationService.updateNotifications(12, { waitingCount: 2 });
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);

      notificationService.removeOwner(12);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);

      // Idempotent — the webContents "destroyed" listener and the window's
      // cleanup can both fire for the same owner.
      expect(() => notificationService.removeOwner(12)).not.toThrow();
    });
  });

  describe("click routing", () => {
    const context = { panelId: "term-9", panelTitle: "Agent", worktreeId: "wt-1" };

    it("focuses the window that owns the panel, not the primary window", () => {
      const primary = createWindowMock(true, [11]);
      const secondary = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([primary, secondary]) as never);

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 21 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(secondary.focus).toHaveBeenCalled();
      expect(primary.focus).not.toHaveBeenCalled();
    });

    it("sends the navigate to the owning view, not whichever view the window is showing", () => {
      // Owner 12 is a cached view: sendToRenderer would deliver to the active
      // view (11) and the navigate would land in the wrong renderer.
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 12 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(ownerSend(12)).toHaveBeenCalledWith("notification:watch-navigate", context);
      expect(ownerSend(11)).not.toHaveBeenCalled();
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it("restores a minimized owner window", () => {
      const win = createWindowMock(false, [11]);
      win.isMinimized.mockReturnValue(true);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 11 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(win.restore).toHaveBeenCalled();
      expect(win.show).toHaveBeenCalled();
    });

    it("falls back to the primary window when the owner is gone", () => {
      const primary = createWindowMock(true, [11]);
      notificationService.initialize(createRegistryMock([primary]) as never);

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 999 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(primary.focus).toHaveBeenCalled();
      expect(sendToRendererMock).toHaveBeenCalledWith(
        primary,
        "notification:watch-navigate",
        context
      );
    });

    it("falls back to the primary window when the owner's webContents is destroyed", () => {
      const primary = createWindowMock(true, [11]);
      const secondary = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([primary, secondary]) as never);

      electronMock.webContentsById.set(21, {
        id: 21,
        isDestroyed: () => true,
        send: vi.fn(),
      });

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 21 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(ownerSend(21)).not.toHaveBeenCalled();
      expect(sendToRendererMock).toHaveBeenCalledWith(
        primary,
        "notification:watch-navigate",
        context
      );
    });

    it("navigates from an escalation notification — the path that had no click handler", () => {
      const win = createWindowMock(false, [11]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.showNativeNotification("Agent still waiting", "3 minutes", {
        ownerWebContentsId: 11,
        navigation: { channel: "notification:watch-navigate", context },
      });
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(win.focus).toHaveBeenCalled();
      expect(ownerSend(11)).toHaveBeenCalledWith("notification:watch-navigate", context);
    });

    it("a native notification with no navigation stays unclickable", () => {
      const win = createWindowMock(false, [11]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.showNativeNotification("Disk space low", "2GB left");
      const instance = electronMock.notificationInstances.at(-1)!;

      expect(instance.handlers.click).toBeUndefined();
    });
  });
});
