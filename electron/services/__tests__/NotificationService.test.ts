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
    /** Undefined means the window has no ProjectViewManager at all. */
    activeProjectId: undefined as string | null | undefined,
    bridgedProjectId: null as string | null,
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

/**
 * Reads the ids off the window mock on every call rather than closing over
 * them, so a test can move a window to another project mid-run the way a real
 * switch does.
 */
function projectViewManagerOf(w: WindowMock) {
  return {
    getActiveProjectId: () => w.activeProjectId ?? null,
    getOutgoingBridgeProjectId: () => w.bridgedProjectId,
  };
}

/** Project rows keyed by id, standing in for the SQLite-backed store. */
function lookupOf(rows: Record<string, { name: string; status?: string }>) {
  return (projectId: string) => rows[projectId] ?? null;
}

/** The last title a window was given — titles are rewritten on every pass. */
function lastTitle(w: WindowMock): string {
  const calls = w.setTitle.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

function createRegistryMock(windows: WindowMock[]) {
  const contexts = windows.map((w) => ({
    windowId: w.id,
    webContentsId: w.id + 1000,
    browserWindow: w,
    projectPath: null,
    abortController: new AbortController(),
    services:
      w.activeProjectId === undefined ? {} : { projectViewManager: projectViewManagerOf(w) },
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

  describe("project-aware titles", () => {
    const rows = lookupOf({
      alpha: { name: "alpha-app", status: "active" },
      beta: { name: "beta-app", status: "background" },
      gone: { name: "archived", status: "closed" },
    });

    it("titles each window from its own project, not a shared pointer", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "beta";

      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(winA)).toBe("alpha-app");
      expect(lastTitle(winB)).toBe("beta-app");
    });

    it("names the same project in both windows showing it", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(winB)).toBe(lastTitle(winA));
    });

    it("scopes the waiting count to the window that owns it", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "beta";

      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      notificationService.updateNotifications(11, { waitingCount: 4 });
      vi.advanceTimersByTime(301);

      expect(lastTitle(winA)).toBe("(4) alpha-app");
      expect(lastTitle(winB)).toBe("beta-app");
    });

    it("sums a window's cached views into one count beside its project name", () => {
      const win = createWindowMock(false, [11, 12]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, { waitingCount: 2 });
      notificationService.updateNotifications(12, { waitingCount: 3 });
      vi.advanceTimersByTime(301);

      expect(lastTitle(win)).toBe("(5) alpha-app");
    });

    it("keeps the waiting count when only the project identity changed", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, { waitingCount: 2 });
      vi.advanceTimersByTime(301);

      win.activeProjectId = "beta";
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("(2) beta-app");
    });

    it("does not disturb the badge when refreshing titles alone", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, { waitingCount: 2 });
      vi.advanceTimersByTime(301);
      electronMock.app.setBadgeCount.mockClear();

      notificationService.refreshTitles();

      expect(electronMock.app.setBadgeCount).not.toHaveBeenCalled();
    });

    it("falls back for a closed project whose window binding lingers", () => {
      const open = createWindowMock(false, [11]);
      const closed = createWindowMock(false, [21]);
      open.activeProjectId = "alpha";
      closed.activeProjectId = "gone";

      notificationService.initialize(createRegistryMock([open, closed]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(open)).toBe("alpha-app");
      expect(lastTitle(closed)).toBe("Daintree");
    });

    it("falls back for a scratch id that matches no project row", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "scratch-uuid";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("Daintree");
    });

    it("titles the project still painted behind a cold-switch bridge", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";
      win.bridgedProjectId = "beta";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("beta-app");
    });

    it("converges on the renamed project when a debounced tick lands after a refresh", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";
      const renamable: Record<string, { name: string; status?: string }> = {
        alpha: { name: "alpha-app", status: "active" },
      };

      notificationService.initialize(createRegistryMock([win]) as never, lookupOf(renamable));
      notificationService.updateNotifications(11, { waitingCount: 1 });

      renamable.alpha = { name: "renamed-app", status: "active" };
      notificationService.refreshTitles();
      expect(lastTitle(win)).toBe("(1) renamed-app");

      vi.advanceTimersByTime(301);
      expect(lastTitle(win)).toBe("(1) renamed-app");
    });

    it("skips a destroyed window without touching its title", () => {
      const live = createWindowMock(false, [11]);
      const dead = createWindowMock(false, [21]);
      live.activeProjectId = "alpha";
      dead.activeProjectId = "beta";
      dead.isDestroyed.mockReturnValue(true);

      notificationService.initialize(createRegistryMock([live, dead]) as never, rows);
      dead.setTitle.mockClear();
      notificationService.refreshTitles();

      expect(dead.setTitle).not.toHaveBeenCalled();
      expect(lastTitle(live)).toBe("alpha-app");
    });

    it("keeps titling the other windows when one view manager throws", () => {
      const broken = createWindowMock(false, [11]);
      const healthy = createWindowMock(false, [21]);
      broken.activeProjectId = "alpha";
      healthy.activeProjectId = "beta";

      const registry = createRegistryMock([broken, healthy]);
      registry.all()[0].services.projectViewManager = {
        getActiveProjectId: () => {
          throw new Error("disposing");
        },
        getOutgoingBridgeProjectId: () => null,
      };

      notificationService.initialize(registry as never, rows);
      expect(() => notificationService.refreshTitles()).not.toThrow();
      expect(lastTitle(healthy)).toBe("beta-app");
    });

    it("titles by app name alone once the project lookup is gone", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.dispose();

      const revived = createWindowMock(false, [31]);
      revived.activeProjectId = "alpha";
      notificationService.initialize(createRegistryMock([revived]) as never);
      notificationService.refreshTitles();

      expect(lastTitle(revived)).toBe("Daintree");
    });
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

    it("one owner reporting zero does not clear another owner's count", () => {
      // This is the renderer's real focus/unmount path: useWindowNotifications
      // pushes { waitingCount: 0 } for its own view. Under the old global
      // `currentState` that zero wiped every other window's title and the badge.
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, { waitingCount: 2 });
      notificationService.updateNotifications(21, { waitingCount: 3 });
      notificationService.updateNotifications(11, { waitingCount: 0 });
      vi.advanceTimersByTime(301);

      expect(win1.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
    });

    it("drops an owner that no longer resolves to a live window", () => {
      const win = createWindowMock(false, [11, 12]);
      const registry = createRegistryMock([win]);
      notificationService.initialize(registry as never);

      notificationService.updateNotifications(11, { waitingCount: 1 });
      notificationService.updateNotifications(12, { waitingCount: 2 });
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);

      // The view was evicted: WindowRegistry unindexes it before closing its
      // webContents, so it stops resolving. Its count must not linger.
      win.ownerIds = [11];

      notificationService.updateNotifications(11, { waitingCount: 1 });
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("drops owners whose window is destroyed", () => {
      const win = createWindowMock(false, [11]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, { waitingCount: 4 });
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(4);

      win.isDestroyed.mockReturnValue(true);
      notificationService.updateNotifications(11, { waitingCount: 4 });
      vi.advanceTimersByTime(301);

      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it("dispose forgets every owner's state", () => {
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, { waitingCount: 2 });
      vi.advanceTimersByTime(301);

      notificationService.dispose();
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(12, { waitingCount: 3 });
      vi.advanceTimersByTime(301);

      // 3, never 5 — owner 11's pre-dispose count must not survive.
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
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

    it("falls back to the primary window when the send to the owner throws", () => {
      const primary = createWindowMock(true, [11]);
      const secondary = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([primary, secondary]) as never);

      // Alive at the guard, torn down by the time we send.
      electronMock.webContentsById.set(21, {
        id: 21,
        isDestroyed: () => false,
        send: vi.fn(() => {
          throw new Error("render frame was disposed");
        }),
      });

      notificationService.showWatchNotification(
        "Agent waiting",
        "Needs input",
        context,
        "notification:watch-navigate",
        { ownerWebContentsId: 21 }
      );
      electronMock.notificationInstances.at(-1)!.trigger("click");

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
