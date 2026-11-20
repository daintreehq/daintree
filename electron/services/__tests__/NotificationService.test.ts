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
    close: ReturnType<typeof vi.fn>;
    once(event: string, handler: (...args: unknown[]) => void): NotificationMockInstance;
    on(event: string, handler: (...args: unknown[]) => void): NotificationMockInstance;
    trigger(event: string, ...args: unknown[]): void;
  }

  class NotificationMock implements NotificationMockInstance {
    static isSupported = vi.fn(() => true);
    handlers: Record<string, (...args: unknown[]) => void> = {};
    show = vi.fn();
    removeAllListeners = vi.fn(() => {
      this.handlers = {};
    });
    // Like Electron, closing a shown notification emits "close".
    close = vi.fn(() => this.trigger("close"));
    constructor(public options: { title: string; body: string; silent?: boolean }) {
      notificationInstances.push(this);
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    on(event: string, handler: (...args: unknown[]) => void) {
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

const iconMock = vi.hoisted(() => ({ getLinuxWindowIcon: vi.fn(() => undefined as unknown) }));
vi.mock("../../window/linuxWindowIcon.js", () => iconMock);

// Live subscriptions to the question list and to where projects are open, so a
// test can tell a leaked or doubled listener from one whose effect is hidden.
const live = vi.hoisted(() => ({ questionListeners: 0, presenceListeners: 0 }));

vi.mock("../decisionsQuestionList.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../decisionsQuestionList.js")>();
  return {
    ...actual,
    onDecisionQuestionsChanged: (...args: Parameters<typeof actual.onDecisionQuestionsChanged>) => {
      live.questionListeners += 1;
      const off = actual.onDecisionQuestionsChanged(...args);
      return () => {
        live.questionListeners -= 1;
        off();
      };
    },
  };
});

vi.mock("../../window/projectPresenceChanges.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../window/projectPresenceChanges.js")>();
  return {
    ...actual,
    onProjectPresenceChanged: (...args: Parameters<typeof actual.onProjectPresenceChanged>) => {
      live.presenceListeners += 1;
      const off = actual.onProjectPresenceChanged(...args);
      return () => {
        live.presenceListeners -= 1;
        off();
      };
    },
  };
});

import { sendToRenderer } from "../../ipc/utils.js";
import { notificationService, type NotificationState } from "../NotificationService.js";
import { setDecisionQuestions } from "../decisionsQuestionList.js";
import { getSystemSleepService } from "../SystemSleepService.js";
import { needsPerson } from "../../../shared/utils/decisionWaiting.js";
import type {
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "../../../shared/types/decisionsQuestion.js";
import { notifyProjectPresenceChanged } from "../../window/projectPresenceChanges.js";
import {
  onWindowTitlesChanged,
  type ProjectTitleLookup,
  type ProjectTitleRow,
} from "../../window/windowTitle.js";

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
    /** The project a view is held under, by its webContents id; `project-<id>` when unnamed. */
    viewProjects: {} as Record<number, string>,
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
    // Each view is keyed `project-<webContents id>`, so a test can tell which one a click named.
    getAllViews: () =>
      w.ownerIds.map((id) => ({
        projectId: w.viewProjects[id] ?? `project-${id}`,
        view: { webContents: electronMock.webContentsById.get(id) },
      })),
  };
}

/** Project rows keyed by id, standing in for the SQLite-backed store. */
function lookupOf(rows: Record<string, ProjectTitleRow>): ProjectTitleLookup {
  return (projectId: string) => rows[projectId] ?? null;
}

/**
 * The last title a window was given — titles are rewritten on every pass.
 * Throws rather than returning undefined so a comparison between two windows
 * can't pass because neither of them was titled at all.
 */
function lastTitle(w: WindowMock): string {
  const calls = w.setTitle.mock.calls;
  if (calls.length === 0) throw new Error(`window ${w.id} was never given a title`);
  return calls[calls.length - 1][0] as string;
}

function titleCount(w: WindowMock): number {
  return w.setTitle.mock.calls.length;
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

/** A view's report of `count` waiting agent panes, none of them a question's. */
function waiting(count: number): NotificationState {
  return { waitingPanelIds: Array.from({ length: count }, (_, i) => `agent-${i}`) };
}

/** A view's report naming the panes it saw an agent waiting in. */
function waitingIn(...panelIds: string[]): NotificationState {
  return { waitingPanelIds: panelIds };
}

/** A view's report where only which panes wait moved, not how many. */
function swappedTo(...panelIds: string[]): NotificationState {
  return { waitingPanelIds: panelIds, membershipOnly: true };
}

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

    notificationService.updateNotifications(11, waiting(2));
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

    expect(() => notificationService.updateNotifications(11, waiting(1))).not.toThrow();
  });

  it("carries the app icon when there is one, so Linux daemons don't draw a generic one", () => {
    const icon = { isEmpty: () => false };
    iconMock.getLinuxWindowIcon.mockReturnValueOnce(icon);
    notificationService.showNativeNotification("Agent waiting", "a");
    expect(electronMock.notificationInstances.at(-1)!.options).toMatchObject({ icon });

    notificationService.showNativeNotification("Agent waiting", "b");
    expect(electronMock.notificationInstances.at(-1)!.options).not.toHaveProperty("icon");
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

    it("announces the new titles once every one is written", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "beta";
      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      const listener = vi.fn();
      const unsubscribe = onWindowTitlesChanged(listener);

      notificationService.refreshTitles();
      unsubscribe();

      const announced = listener.mock.invocationCallOrder;
      expect(announced).toHaveLength(1);
      const titleWrites = [
        ...winA.setTitle.mock.invocationCallOrder,
        ...winB.setTitle.mock.invocationCallOrder,
      ];
      expect(Math.max(...titleWrites)).toBeLessThan(announced[0]!);
    });

    it("announces the new titles once a waiting count reaches every one", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "beta";
      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      const listener = vi.fn();
      const unsubscribe = onWindowTitlesChanged(listener);

      notificationService.updateNotifications(11, waiting(3));
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(301);
      unsubscribe();

      expect(lastTitle(winA)).toBe("(3) alpha-app");
      const announced = listener.mock.invocationCallOrder;
      expect(announced).toHaveLength(1);
      const titleWrites = [
        ...winA.setTitle.mock.invocationCallOrder,
        ...winB.setTitle.mock.invocationCallOrder,
      ];
      expect(titleWrites).toHaveLength(2);
      expect(Math.max(...titleWrites)).toBeLessThan(announced[0]!);
    });

    it("scopes the waiting count to the window that owns it", () => {
      const winA = createWindowMock(false, [11]);
      const winB = createWindowMock(false, [21]);
      winA.activeProjectId = "alpha";
      winB.activeProjectId = "beta";

      notificationService.initialize(createRegistryMock([winA, winB]) as never, rows);
      notificationService.updateNotifications(11, waiting(4));
      vi.advanceTimersByTime(301);

      expect(lastTitle(winA)).toBe("(4) alpha-app");
      expect(lastTitle(winB)).toBe("beta-app");
    });

    it("keeps the waiting count when only the project identity changed", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, waiting(2));
      vi.advanceTimersByTime(301);

      win.activeProjectId = "beta";
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("(2) beta-app");
    });

    it("does not disturb the badge when refreshing titles alone", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, waiting(2));
      vi.advanceTimersByTime(301);
      electronMock.app.setBadgeCount.mockClear();

      notificationService.refreshTitles();

      expect(electronMock.app.setBadgeCount).not.toHaveBeenCalled();
    });

    it("falls back for a closed project whose window binding lingers", () => {
      const open = createWindowMock(false, [11]);
      const closed = createWindowMock(false, [21]);
      const unbound = createWindowMock(false, [31]);
      open.activeProjectId = "alpha";
      closed.activeProjectId = "gone";
      unbound.activeProjectId = null;

      notificationService.initialize(createRegistryMock([open, closed, unbound]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(open)).toBe("alpha-app");
      expect(lastTitle(closed)).not.toContain("archived");
      expect(lastTitle(closed)).toBe(lastTitle(unbound));
    });

    it("falls back for a scratch id that matches no project row", () => {
      const scratch = createWindowMock(false, [11]);
      const unbound = createWindowMock(false, [21]);
      scratch.activeProjectId = "scratch-uuid";
      unbound.activeProjectId = null;

      notificationService.initialize(createRegistryMock([scratch, unbound]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(scratch)).toBe(lastTitle(unbound));
    });

    it("titles the project still painted behind a cold-switch bridge", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";
      win.bridgedProjectId = "beta";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("beta-app");
    });

    it("leaves the pending tick armed and converges it on the renamed project", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";
      const renamable: Record<string, ProjectTitleRow> = {
        alpha: { name: "alpha-app", status: "active" },
      };

      notificationService.initialize(createRegistryMock([win]) as never, lookupOf(renamable));
      notificationService.updateNotifications(11, waiting(1));

      renamable.alpha = { name: "renamed-app", status: "active" };
      notificationService.refreshTitles();
      expect(lastTitle(win)).toBe("(1) renamed-app");

      // The refresh must not have swallowed the debounce: the tick still owes a
      // write, and it recomputes rather than replaying the name it was queued with.
      const beforeTick = titleCount(win);
      renamable.alpha = { name: "renamed-again", status: "active" };
      vi.advanceTimersByTime(301);

      expect(titleCount(win)).toBeGreaterThan(beforeTick);
      expect(lastTitle(win)).toBe("(1) renamed-again");
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
        getAllViews: () => [],
      };

      notificationService.initialize(registry as never, rows);
      expect(() => notificationService.refreshTitles()).not.toThrow();
      expect(lastTitle(healthy)).toBe("beta-app");
    });

    it("drops the project lookup when reinitialized without one", () => {
      const bound = createWindowMock(false, [11]);
      bound.activeProjectId = "alpha";
      notificationService.initialize(createRegistryMock([bound]) as never, rows);
      notificationService.refreshTitles();
      expect(lastTitle(bound)).toBe("alpha-app");

      // No dispose in between: a re-init that supplies no lookup must not keep
      // resolving names through the previous one.
      const rebound = createWindowMock(false, [21]);
      const unbound = createWindowMock(false, [31]);
      rebound.activeProjectId = "alpha";
      unbound.activeProjectId = null;
      notificationService.initialize(createRegistryMock([rebound, unbound]) as never);
      notificationService.refreshTitles();

      expect(lastTitle(rebound)).not.toContain("alpha-app");
      expect(lastTitle(rebound)).toBe(lastTitle(unbound));
    });

    it("names a project whose row went missing rather than blanking the window", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "vanished";

      const withMissing = lookupOf({ vanished: { name: "on-a-dead-mount", status: "missing" } });
      notificationService.initialize(createRegistryMock([win]) as never, withMissing);
      notificationService.refreshTitles();

      expect(lastTitle(win)).toBe("on-a-dead-mount");
    });

    it("resolves a window whose view manager reports no active project", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = null;

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, waiting(3));
      vi.advanceTimersByTime(301);

      expect(lastTitle(win).startsWith("(3) ")).toBe(true);
      expect(lastTitle(win)).not.toContain("alpha-app");
    });

    it("leaves a dead owner for removeOwner to clear, so the badge still settles", () => {
      const win = createWindowMock(false, [11]);
      win.activeProjectId = "alpha";

      notificationService.initialize(createRegistryMock([win]) as never, rows);
      notificationService.updateNotifications(11, waiting(4));
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(4);

      // The owner's window dies without its destroyed event being processed, so
      // the count is now unbacked. A title-only refresh must not consume it: if
      // it did, removeOwner's delete would find nothing and return before ever
      // recomputing the badge, stranding it at 4.
      win.isDestroyed.mockReturnValue(true);
      notificationService.refreshTitles();
      electronMock.app.setBadgeCount.mockClear();

      notificationService.removeOwner(11);

      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
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

  describe("closing banners with their panels (#12793)", () => {
    const tracked = () =>
      (
        notificationService as unknown as {
          pendingPanelsByNotification: Map<unknown, Set<string>>;
        }
      ).pendingPanelsByNotification;

    it("closes a banner once its only panel is dealt with", () => {
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
      });
      const instance = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationsForPanel("term-1");

      expect(instance.close).toHaveBeenCalledTimes(1);
      expect(tracked().size).toBe(0);
    });

    it("leaves other panels' banners alone", () => {
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
      });
      const first = electronMock.notificationInstances.at(-1)!;
      notificationService.showNativeNotification("Agent waiting", "b", {
        closeWithPanels: ["term-2"],
      });
      const second = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationsForPanel("term-2");

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledTimes(1);
    });

    it("keeps a grouped banner until every panel it names is dealt with", () => {
      notificationService.showNativeNotification("Agents waiting", "2 agents", {
        closeWithPanels: ["term-1", "term-2"],
      });
      const instance = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationsForPanel("term-1");
      expect(instance.close).not.toHaveBeenCalled();

      notificationService.closeNotificationsForPanel("term-1");
      expect(instance.close).not.toHaveBeenCalled();

      notificationService.closeNotificationsForPanel("term-2");
      expect(instance.close).toHaveBeenCalledTimes(1);
    });

    it("never closes a banner that did not ask to close with its panel", () => {
      notificationService.showWatchNotification(
        "Agent completed",
        "done",
        { panelId: "term-1", panelTitle: "Agent" },
        "notification:watch-navigate"
      );
      const instance = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationsForPanel("term-1");

      expect(instance.close).not.toHaveBeenCalled();
    });

    it("carries closeWithPanels through watch notifications", () => {
      notificationService.showWatchNotification(
        "Agent waiting",
        "a",
        { panelId: "term-1", panelTitle: "Agent" },
        "notification:watch-navigate",
        { closeWithPanels: ["term-1"] }
      );
      const instance = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationsForPanel("term-1");

      expect(instance.close).toHaveBeenCalledTimes(1);
    });

    it.each(["close", "click", "failed"])("stops tracking a banner once it emits %s", (event) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
        navigation: {
          channel: "notification:watch-navigate",
          context: { panelId: "term-1", panelTitle: "Agent" },
        },
      });
      const instance = electronMock.notificationInstances.at(-1)!;

      instance.trigger(event, {}, "err");
      notificationService.closeNotificationsForPanel("term-1");

      expect(tracked().size).toBe(0);
      expect(instance.close).not.toHaveBeenCalled();
    });

    it("keeps a Windows toast that timed out into Action Center closeable", () => {
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
      });
      const instance = electronMock.notificationInstances.at(-1)!;

      instance.trigger("close", { reason: "timedOut" });
      expect(tracked().size).toBe(1);

      notificationService.closeNotificationsForPanel("term-1");
      expect(instance.close).toHaveBeenCalledTimes(1);
      expect(tracked().size).toBe(0);
    });

    it("forgets a timed-out toast that nothing could close later", () => {
      notificationService.showNativeNotification("Agent completed", "done");
      const instance = electronMock.notificationInstances.at(-1)!;

      instance.trigger("close", { reason: "timedOut" });

      expect(
        (notificationService as unknown as { activeNotifications: Set<unknown> })
          .activeNotifications.size
      ).toBe(0);
    });

    it("drops tracking even when close() throws", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
      });
      const instance = electronMock.notificationInstances.at(-1)!;
      instance.close.mockImplementation(() => {
        throw new Error("gone");
      });

      expect(() => notificationService.closeNotificationsForPanel("term-1")).not.toThrow();
      expect(tracked().size).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("clears tracking on dispose", () => {
      notificationService.showNativeNotification("Agent waiting", "a", {
        closeWithPanels: ["term-1"],
      });

      notificationService.dispose();

      expect(tracked().size).toBe(0);
    });
  });

  // #11110 — state used to be one global `currentState` that any renderer could
  // overwrite, so the last window to report won and every other window's title
  // and the dock badge followed it.
  describe("replacing and click handlers (#13505)", () => {
    it("closes the banner showing under the same key before the next goes up", () => {
      notificationService.showNativeNotification("t", "first", { replaceKey: "k" });
      const first = electronMock.notificationInstances.at(-1)!;
      notificationService.showNativeNotification("t", "second", { replaceKey: "k" });
      const second = electronMock.notificationInstances.at(-1)!;

      expect(first.close).toHaveBeenCalledTimes(1);
      expect(first.removeAllListeners).toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(second.show).toHaveBeenCalledTimes(1);
    });

    it("a replaced banner's late click runs nothing; only its successor's does", () => {
      const first = vi.fn();
      const second = vi.fn();
      notificationService.showNativeNotification("t", "a", { replaceKey: "k", onClick: first });
      const old = electronMock.notificationInstances.at(-1)!;
      notificationService.showNativeNotification("t", "b", { replaceKey: "k", onClick: second });

      old.trigger("click");
      expect(first).not.toHaveBeenCalled();
      electronMock.notificationInstances.at(-1)!.trigger("click");
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("keeps a keyed banner that timed out into Action Center replaceable", () => {
      notificationService.showNativeNotification("t", "a", { replaceKey: "k" });
      const first = electronMock.notificationInstances.at(-1)!;
      first.trigger("close", { reason: "timedOut" });

      notificationService.showNativeNotification("t", "b", { replaceKey: "k" });

      expect(first.close).toHaveBeenCalledTimes(1);
    });

    it("stops tracking the oldest keyed banners past the cap", () => {
      for (let i = 0; i < 51; i++) {
        notificationService.showNativeNotification("t", `${i}`, { replaceKey: `k${i}` });
        electronMock.notificationInstances.at(-1)!.trigger("close", { reason: "timedOut" });
      }
      const oldest = electronMock.notificationInstances.at(-51)!;
      const newest = electronMock.notificationInstances.at(-1)!;

      notificationService.closeNotificationByKey("k0");
      notificationService.closeNotificationByKey("k50");

      expect(oldest.close).not.toHaveBeenCalled();
      expect(newest.close).toHaveBeenCalledTimes(1);
    });

    it("leaves banners under other keys, and unkeyed ones, alone", () => {
      notificationService.showNativeNotification("t", "a", { replaceKey: "a" });
      const keyed = electronMock.notificationInstances.at(-1)!;
      notificationService.showNativeNotification("t", "plain");
      const plain = electronMock.notificationInstances.at(-1)!;

      notificationService.showNativeNotification("t", "b", { replaceKey: "b" });

      expect(keyed.close).not.toHaveBeenCalled();
      expect(plain.close).not.toHaveBeenCalled();
    });

    it("forgets a key once its banner is gone, so a late close can't drop its successor", () => {
      notificationService.showNativeNotification("t", "first", { replaceKey: "k" });
      const first = electronMock.notificationInstances.at(-1)!;
      first.trigger("close");
      notificationService.showNativeNotification("t", "second", { replaceKey: "k" });
      const second = electronMock.notificationInstances.at(-1)!;

      first.trigger("close");
      notificationService.closeNotificationByKey("k");

      expect(second.close).toHaveBeenCalledTimes(1);
    });

    it("runs onClick in main instead of routing navigation", () => {
      const onClick = vi.fn();
      notificationService.showNativeNotification("t", "b", {
        onClick,
        navigation: { channel: "nav", context: { panelId: "p", panelTitle: "P" } },
      });
      electronMock.notificationInstances.at(-1)!.trigger("click");

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it("survives a throwing click handler", () => {
      notificationService.showNativeNotification("t", "b", {
        onClick: () => {
          throw new Error("boom");
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => electronMock.notificationInstances.at(-1)!.trigger("click")).not.toThrow();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe("per-owner waiting counts", () => {
    it("aggregates the badge across owners instead of taking the last writer", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, waiting(2));
      notificationService.updateNotifications(21, waiting(3));
      vi.advanceTimersByTime(301);

      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(5);
    });

    it("titles each window from its own owners only", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, waiting(2));
      notificationService.updateNotifications(21, waiting(3));
      vi.advanceTimersByTime(301);

      expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
    });

    it("sums the cached project views a window hosts into one title", () => {
      // One window, active view + a cached one, each with waiting agents.
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, waiting(1));
      notificationService.updateNotifications(12, waiting(2));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
    });

    it("focusing one window leaves another window's title and its badge share intact", () => {
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, waiting(2));
      notificationService.updateNotifications(21, waiting(3));
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

      notificationService.updateNotifications(11, waiting(1));
      notificationService.updateNotifications(12, waiting(2));
      vi.advanceTimersByTime(301);

      win.trigger("focus");

      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
    });

    it("one owner reporting zero does not clear another owner's count", () => {
      // This is the renderer's real focus/unmount path: useWindowNotifications
      // pushes waiting(0) for its own view. Under the old global
      // `currentState` that zero wiped every other window's title and the badge.
      const win1 = createWindowMock(false, [11]);
      const win2 = createWindowMock(false, [21]);
      notificationService.initialize(createRegistryMock([win1, win2]) as never);

      notificationService.updateNotifications(11, waiting(2));
      notificationService.updateNotifications(21, waiting(3));
      notificationService.updateNotifications(11, waiting(0));
      vi.advanceTimersByTime(301);

      expect(win1.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
    });

    it("drops an owner that no longer resolves to a live window", () => {
      const win = createWindowMock(false, [11, 12]);
      const registry = createRegistryMock([win]);
      notificationService.initialize(registry as never);

      notificationService.updateNotifications(11, waiting(1));
      notificationService.updateNotifications(12, waiting(2));
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);

      // The view was evicted: WindowRegistry unindexes it before closing its
      // webContents, so it stops resolving. Its count must not linger.
      win.ownerIds = [11];

      notificationService.updateNotifications(11, waiting(1));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("drops owners whose window is destroyed", () => {
      const win = createWindowMock(false, [11]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, waiting(4));
      vi.advanceTimersByTime(301);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(4);

      win.isDestroyed.mockReturnValue(true);
      notificationService.updateNotifications(11, waiting(4));
      vi.advanceTimersByTime(301);

      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it("dispose forgets every owner's state", () => {
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, waiting(2));
      vi.advanceTimersByTime(301);

      notificationService.dispose();
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(12, waiting(3));
      vi.advanceTimersByTime(301);

      // 3, never 5 — owner 11's pre-dispose count must not survive.
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
    });

    it("removeOwner drops that owner's count from the badge and title", () => {
      const win = createWindowMock(false, [11, 12]);
      notificationService.initialize(createRegistryMock([win]) as never);

      notificationService.updateNotifications(11, waiting(1));
      notificationService.updateNotifications(12, waiting(2));
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

  describe("waiting Decisions questions (#17233)", () => {
    const open: DecisionQuestionStanding = { kind: "waiting", reason: "open" };
    const stopped: DecisionQuestionStanding = {
      kind: "needs-attention",
      deliveryStatus: "needs-attention",
    };

    function question(
      projectId: string,
      terminalId: string,
      standing: DecisionQuestionStanding = open,
      questionId = `q-${terminalId}`
    ): DecisionQuestionListItem {
      return {
        reference: { hostId: "host-1", projectId, terminalId, questionId },
        alias: 1,
        agentKind: "claude",
        projectLabel: null,
        worktreeId: "wt-1",
        worktreeRoot: "/repo",
        requirement: "human-required",
        askedAt: "2026-11-17T00:00:00.000Z",
        expiresAt: null,
        settledAt: null,
        standing,
        replyRequest: null,
        stall: null,
      };
    }

    /** A window with a view manager, so its views can be told apart by project. */
    function windowWithViews(...ownerIds: number[]) {
      const win = createWindowMock(false, ownerIds);
      win.activeProjectId = null;
      return win;
    }

    /** The service reads the question list through an import made on demand: let it land. */
    async function questionsLoaded(): Promise<void> {
      await vi.dynamicImportSettled();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }

    afterEach(() => {
      setDecisionQuestions([]);
    });

    it("counts a pane with a question waiting on the person in its project's window and the Dock", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-11", "terminal-a")]);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("counts the questions the toolbar marks, by the same rules, queued and stopped deliveries included (#18046, #18045)", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      const standings: DecisionQuestionStanding[] = [
        open,
        { kind: "waiting", reason: "reply" },
        { kind: "queued" },
        { kind: "send-failed" },
        { kind: "to-type" },
        { kind: "needs-attention", deliveryStatus: "needs-attention" },
        { kind: "settled", outcome: "answered", handled: false },
        { kind: "settled", outcome: "withdrawn" },
      ];
      const marked = { ask: null, seen: true, cleared: false };
      const list = [
        ...standings.map((standing, i) => question("project-11", `terminal-${i}`, standing)),
        {
          ...question("project-11", "terminal-seen", { kind: "queued" }),
          inbox: marked,
        },
        {
          ...question("project-11", "terminal-cleared", open),
          inbox: { ...marked, seen: false, cleared: true },
        },
      ];

      // Each standing on a pane of its own: it counts there exactly when the toolbar's rules say so.
      for (const [i, standing] of standings.entries()) {
        setDecisionQuestions([question("project-11", "terminal-solo", standing)]);
        const solo = needsPerson({ standing }, Date.now()) ? 1 : 0;
        expect(win.setTitle, `${i}:${standing.kind}`).toHaveBeenLastCalledWith(
          solo === 0 ? "Daintree" : `(${solo}) Daintree`
        );
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(solo);
      }
      setDecisionQuestions(list);

      // One pane each, so the pane count is the question count here.
      const expected = list.filter((item) => needsPerson(item, Date.now())).length;
      expect(expected).toBe(4);
      expect(win.setTitle).toHaveBeenLastCalledWith(`(${expected}) Daintree`);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(expected);
    });

    it("reads the questions already waiting when it starts", async () => {
      setDecisionQuestions([question("project-11", "terminal-a")]);
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("counts open, queued and replied-to questions and stopped deliveries, and nothing else", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([
        question("project-11", "terminal-a", open),
        question("project-11", "terminal-b", { kind: "waiting", reason: "reply" }),
        // Still queued to send, so still the person's to answer: the toolbar counts it too (#18046).
        question("project-11", "terminal-c", { kind: "queued" }),
        question("project-11", "terminal-d", { kind: "send-failed" }),
        question("project-11", "terminal-e", { kind: "to-type" }),
        // Its answer stopped on its way: the person has to decide what happens to it (#18045).
        question("project-11", "terminal-f", {
          kind: "needs-attention",
          deliveryStatus: "needs-attention",
        }),
        question("project-11", "terminal-g", {
          kind: "settled",
          outcome: "answered",
          handled: false,
        }),
        question("project-11", "terminal-h", { kind: "settled", outcome: "withdrawn" }),
        question("project-11", "terminal-i", { kind: "settled", outcome: "expired" }),
        question("project-11", "terminal-j", { kind: "settled", outcome: "declined" }),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(4) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(4);

      // Answered, then the reply's request withdrawn by a later expiry.
      setDecisionQuestions([
        question("project-11", "terminal-a", { kind: "to-type" }),
        question("project-11", "terminal-b", { kind: "settled", outcome: "expired" }),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it("stops counting a question once the person has seen or cleared what it asks, until it asks again (#17895)", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();
      const marked = (
        terminalId: string,
        inbox: NonNullable<DecisionQuestionListItem["inbox"]>,
        questionId?: string
      ) => ({ ...question("project-11", terminalId, open, questionId), inbox });

      setDecisionQuestions([
        marked("terminal-a", { ask: null, seen: true, cleared: false }),
        marked("terminal-b", { ask: null, seen: false, cleared: true }),
        marked("terminal-c", { ask: null, seen: false, cleared: false }),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);

      // Seen and cleared everywhere: nothing waits on the person.
      setDecisionQuestions([
        marked("terminal-a", { ask: null, seen: true, cleared: false }),
        marked("terminal-b", { ask: null, seen: true, cleared: true }),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);

      // The same question asks something new: main lists the new ask unmarked, and it counts again.
      setDecisionQuestions([
        marked("terminal-a", { ask: "note-2", seen: false, cleared: false }),
        marked("terminal-b", { ask: null, seen: true, cleared: true }),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);

      // A pane still counts for a question there that hasn't been seen, beside one that has.
      setDecisionQuestions([
        marked("terminal-b", { ask: null, seen: true, cleared: false }),
        marked("terminal-b", { ask: "note-3", seen: false, cleared: false }, "q-second"),
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
      setDecisionQuestions([
        marked("terminal-b", { ask: null, seen: true, cleared: false }),
        marked("terminal-b", { ask: "note-3", seen: true, cleared: false }, "q-second"),
      ]);
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it("keeps counting a waiting question when its window is focused, as agents' counts don't", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-11", "terminal-a")]);
      notificationService.updateNotifications(11, waitingIn("terminal-b"));
      vi.advanceTimersByTime(301);
      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");

      win.trigger("focus");
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);

      // The focused renderer's own report of no waiting agents clears nothing more.
      notificationService.updateNotifications(11, waitingIn());
      vi.advanceTimersByTime(301);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("counts a pane once when its agent waits and it holds a waiting question", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-11", "terminal-a")]);
      notificationService.updateNotifications(11, waitingIn("terminal-a", "terminal-b"));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
    });

    it("counts a pane once when its agent waits, a question waits and a delivery stopped there (#18045)", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([
        question("project-11", "terminal-a", open, "q-1"),
        question("project-11", "terminal-a", stopped, "q-2"),
        question("project-11", "terminal-b", stopped, "q-3"),
      ]);
      notificationService.updateNotifications(11, waitingIn("terminal-a"));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

      // The person settled the stopped deliveries: only the question to answer is left.
      setDecisionQuestions([question("project-11", "terminal-a", open, "q-1")]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("keeps a stopped delivery in the Dock once its terminal and project are gone (#18045)", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-closed", "terminal-gone", stopped)]);

      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("counts a pane once however many of its questions wait", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([
        question("project-11", "terminal-a", open, "q-1"),
        question("project-11", "terminal-a", { kind: "waiting", reason: "reply" }, "q-2"),
      ]);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("keeps a pane of one project apart from the same panel id in another", async () => {
      const win = windowWithViews(11, 12);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-11", "terminal-a")]);
      notificationService.updateNotifications(12, waitingIn("terminal-a"));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
    });

    it("counts a question in the window holding a cached view of its project", async () => {
      const win = windowWithViews(11, 12);
      const other = windowWithViews(21);
      notificationService.initialize(createRegistryMock([win, other]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-12", "terminal-a")]);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(other.setTitle).toHaveBeenLastCalledWith("Daintree");
    });

    it("counts a question whose project no window holds in the Dock alone", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-closed", "terminal-a")]);

      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("titles both windows holding a question's project but counts it once in the Dock", async () => {
      const win1 = windowWithViews(11);
      const win2 = windowWithViews(21);
      win1.viewProjects[11] = "shared";
      win2.viewProjects[21] = "shared";
      notificationService.initialize(createRegistryMock([win1, win2]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("shared", "terminal-a")]);
      // Both views saw the pane's agent waiting too.
      notificationService.updateNotifications(11, waitingIn("terminal-a"));
      notificationService.updateNotifications(21, waitingIn("terminal-a"));
      vi.advanceTimersByTime(301);

      expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(win2.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("keeps a stopped delivery counted as its question's deadline passes, where the ask beside it goes (#18045)", async () => {
      const start = Date.parse("2026-11-20T14:00:00.000Z");
      vi.setSystemTime(start);
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      const soon = new Date(start + 60_000).toISOString();
      setDecisionQuestions([
        { ...question("project-11", "terminal-a"), expiresAt: soon },
        { ...question("project-11", "terminal-b", stopped), expiresAt: soon },
      ]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");

      vi.advanceTimersByTime(60_000);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("takes an ask out of both windows' titles and the Dock as its deadline passes, and on a wake (#17943)", async () => {
      const start = Date.parse("2026-11-20T14:00:00.000Z");
      vi.setSystemTime(start);
      let wake: ((sleptMs: number) => void) | null = null;
      const onWake = vi.spyOn(getSystemSleepService(), "onWake").mockImplementation((listener) => {
        wake = listener;
        return () => {
          wake = null;
        };
      });
      try {
        const win1 = windowWithViews(11);
        const win2 = windowWithViews(21);
        win1.viewProjects[11] = "shared";
        win2.viewProjects[21] = "shared";
        notificationService.initialize(createRegistryMock([win1, win2]) as never);
        await questionsLoaded();

        const at = (ms: number) => new Date(start + ms).toISOString();
        setDecisionQuestions([
          { ...question("shared", "terminal-a"), expiresAt: at(60_000) },
          { ...question("shared", "terminal-b", { kind: "queued" }), expiresAt: at(120_000) },
          // A reply asked for isn't bound by the question's deadline.
          {
            ...question("shared", "terminal-c", { kind: "waiting", reason: "reply" }),
            expiresAt: at(60_000),
          },
        ]);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(3) Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("(3) Daintree");

        vi.advanceTimersByTime(60_000);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

        // A queued question is bound by its deadline too (#18046).
        vi.advanceTimersByTime(60_000);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);

        // Only a deadline moves, on a pane already counted: the sooner one is waited for.
        setDecisionQuestions([
          { ...question("shared", "terminal-d"), expiresAt: at(60_000 + 5 * 60_000) },
        ]);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        setDecisionQuestions([
          { ...question("shared", "terminal-d"), expiresAt: at(60_000 + 2 * 60_000) },
        ]);
        vi.advanceTimersByTime(2 * 60_000);
        expect(win1.setTitle).toHaveBeenLastCalledWith("Daintree");

        // A sleep: the wall clock moves on while no timer runs, and the wake counts again.
        setDecisionQuestions([
          { ...question("shared", "terminal-c", open), expiresAt: at(30 * 60_000) },
        ]);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        vi.setSystemTime(start + 60 * 60_000);
        wake!(60 * 60_000);
        expect(win1.setTitle).toHaveBeenLastCalledWith("Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);

        // Disposed with a deadline still armed: the timer goes with it.
        setDecisionQuestions([
          { ...question("shared", "terminal-a"), expiresAt: at(2 * 60 * 60_000) },
        ]);
        const armed = vi.getTimerCount();
        notificationService.dispose();
        expect(vi.getTimerCount()).toBeLessThan(armed);
        expect(wake).toBeNull();
      } finally {
        onWake.mockRestore();
      }
    });

    it("moves a question's count to a window when a view of its project opens there", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-12", "terminal-a")]);
      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");

      electronMock.webContentsById.set(12, { id: 12, isDestroyed: () => false, send: vi.fn() });
      win.ownerIds.push(12);
      notifyProjectPresenceChanged();
      notifyProjectPresenceChanged();
      const writes = titleCount(win);
      await Promise.resolve();

      expect(titleCount(win)).toBe(writes + 1);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("watches where projects are open only while a question waits", async () => {
      const win = windowWithViews(11);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();
      expect(live.presenceListeners).toBe(0);

      setDecisionQuestions([question("project-11", "terminal-a")]);
      expect(live.presenceListeners).toBe(1);
      setDecisionQuestions([question("project-11", "terminal-b")]);
      expect(live.presenceListeners).toBe(1);

      setDecisionQuestions([]);
      expect(live.presenceListeners).toBe(0);
    });

    it("moves the count when the only waiting question is now another pane's", async () => {
      const win = windowWithViews(11, 12);
      const other = windowWithViews(21);
      notificationService.initialize(createRegistryMock([win, other]) as never);
      await questionsLoaded();

      setDecisionQuestions([question("project-11", "terminal-a")]);
      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(other.setTitle).toHaveBeenLastCalledWith("Daintree");

      setDecisionQuestions([question("project-21", "terminal-b")]);
      expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      expect(other.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it("keeps a waiting question's count through a title refresh after a rename", async () => {
      const win = windowWithViews(11);
      win.activeProjectId = "alpha";
      const rows: Record<string, ProjectTitleRow> = {
        alpha: { name: "alpha-app", status: "active" },
      };
      notificationService.initialize(createRegistryMock([win]) as never, lookupOf(rows));
      await questionsLoaded();
      setDecisionQuestions([question("project-11", "terminal-a")]);

      rows.alpha = { name: "alpha-renamed", status: "active" };
      notificationService.refreshTitles();

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) alpha-renamed");
    });

    it("counts a window's other views when one of them has been torn down", async () => {
      const win = windowWithViews(11, 12);
      notificationService.initialize(createRegistryMock([win]) as never);
      await questionsLoaded();
      // Electron leaves a destroyed view's webContents undefined while its entry lingers.
      electronMock.webContentsById.delete(12);

      setDecisionQuestions([question("project-11", "terminal-a")]);
      notificationService.updateNotifications(11, waitingIn("terminal-a"));
      vi.advanceTimersByTime(301);

      expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
    });

    it.each(["win32", "linux"])(
      "carries waiting questions in the window title on %s, which has no Dock badge",
      async (platform) => {
        Object.defineProperty(process, "platform", { value: platform, writable: true });
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();

        setDecisionQuestions([question("project-11", "terminal-a")]);
        win.trigger("focus");

        expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).not.toHaveBeenCalled();
      }
    );

    describe("with Decisions off", () => {
      it("counts agents alone, a pane that also had a question included", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();

        setDecisionQuestions([question("project-11", "terminal-a")]);
        notificationService.updateNotifications(11, waitingIn("terminal-a", "terminal-b"));
        vi.advanceTimersByTime(301);
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

        // Turning Decisions off empties the list.
        setDecisionQuestions([]);

        expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

        win.trigger("focus");
        expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
      });

      it("writes nothing more than the agents' counts did", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        expect(titleCount(win)).toBe(0);
        expect(electronMock.app.setBadgeCount).not.toHaveBeenCalled();

        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);
        expect(titleCount(win)).toBe(1);
        expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      });

      it("rewrites nothing for panes swapping places at the same count", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);
        const writes = titleCount(win);

        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        vi.advanceTimersByTime(301);

        expect(titleCount(win)).toBe(writes);
        expect(electronMock.app.setBadgeCount).toHaveBeenCalledTimes(1);
      });

      it("drops a swap that lands after focus cleared its view's report", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);
        win.trigger("focus");

        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        notificationService.refreshTitles();

        expect(win.setTitle).toHaveBeenLastCalledWith("Daintree");
      });

      it("never lets a swap postpone another view's pending change", async () => {
        const win1 = windowWithViews(11);
        const win2 = windowWithViews(21);
        notificationService.initialize(createRegistryMock([win1, win2]) as never);
        await questionsLoaded();
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);

        notificationService.updateNotifications(21, waitingIn("terminal-x", "terminal-y"));
        vi.advanceTimersByTime(200);
        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        vi.advanceTimersByTime(101);

        expect(win2.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
      });

      it("keeps a swap's panes, so a question arriving later still counts the pane once", async () => {
        const win1 = windowWithViews(11);
        const win2 = windowWithViews(21);
        notificationService.initialize(createRegistryMock([win1, win2]) as never);
        await questionsLoaded();
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);

        notificationService.updateNotifications(21, waitingIn("terminal-x"));
        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        setDecisionQuestions([question("project-11", "terminal-b")]);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        vi.advanceTimersByTime(301);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

        setDecisionQuestions([
          question("project-11", "terminal-b", { kind: "settled", outcome: "withdrawn" }),
        ]);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);
      });

      it("runs the pass of a report whose count moved and came back, as it always did", async () => {
        const win = windowWithViews(11, 12);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        notificationService.updateNotifications(12, waitingIn("terminal-x"));
        vi.advanceTimersByTime(301);
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(2);

        // View 12 was evicted and its "destroyed" never arrived. View 11's count
        // went to two and back to one within its renderer's wait: not marked.
        win.ownerIds = [11];
        notificationService.updateNotifications(11, waitingIn("terminal-b"));
        vi.advanceTimersByTime(301);

        expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
      });

      it("still counts a swap once a question waits, which it may now matter to", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        setDecisionQuestions([question("project-11", "terminal-b")]);
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);
        expect(win.setTitle).toHaveBeenLastCalledWith("(2) Daintree");

        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        vi.advanceTimersByTime(301);

        expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
      });
    });

    describe("a swap while a question waits", () => {
      async function setup() {
        const win1 = windowWithViews(11);
        const win2 = windowWithViews(21);
        const win3 = windowWithViews(31);
        notificationService.initialize(createRegistryMock([win1, win2, win3]) as never);
        await questionsLoaded();
        setDecisionQuestions([question("project-11", "terminal-b")]);
        notificationService.updateNotifications(11, waitingIn("terminal-a"));
        vi.advanceTimersByTime(301);
        expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");

        notificationService.updateNotifications(21, waitingIn("terminal-x", "terminal-y"));
        vi.advanceTimersByTime(200);
        // The agent moves into the pane whose question already counts.
        notificationService.updateNotifications(11, swappedTo("terminal-b"));
        return { win1, win2, win3 };
      }

      it("lands with another view's pending change, at its deadline", async () => {
        const { win1, win2 } = await setup();
        vi.advanceTimersByTime(101);

        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
      });

      it("lands at once when a window's focus runs the pass early", async () => {
        const { win1, win2, win3 } = await setup();
        expect(win1.setTitle).toHaveBeenLastCalledWith("(2) Daintree");

        win3.trigger("focus");

        expect(win1.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
        expect(win2.setTitle).toHaveBeenLastCalledWith("(2) Daintree");
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(3);
        const writes = titleCount(win1);
        vi.advanceTimersByTime(400);
        expect(titleCount(win1)).toBe(writes);
      });
    });

    describe("lifecycle", () => {
      it("watches the list once however often it is initialized", async () => {
        const win = windowWithViews(11);
        const registry = createRegistryMock([win]);
        notificationService.initialize(registry as never);
        notificationService.initialize(registry as never);
        await questionsLoaded();
        notificationService.initialize(registry as never);
        await questionsLoaded();

        expect(live.questionListeners).toBe(1);
        setDecisionQuestions([question("project-11", "terminal-a")]);
        expect(titleCount(win)).toBe(1);
      });

      it("stops listening, and counting questions, once disposed", async () => {
        const win = windowWithViews(11);
        notificationService.initialize(createRegistryMock([win]) as never);
        await questionsLoaded();
        setDecisionQuestions([question("project-11", "terminal-a")]);
        expect(live.presenceListeners).toBe(1);

        notificationService.dispose();
        expect(live.questionListeners).toBe(0);
        expect(live.presenceListeners).toBe(0);
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
        const writes = titleCount(win);

        setDecisionQuestions([question("project-11", "terminal-b")]);
        notifyProjectPresenceChanged();
        await Promise.resolve();
        expect(titleCount(win)).toBe(writes);
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(0);
      });

      it("leaves an import from before dispose inert once initialized again", async () => {
        const win = windowWithViews(11);
        const registry = createRegistryMock([win]);
        notificationService.initialize(registry as never);
        notificationService.dispose();
        notificationService.initialize(registry as never);
        await questionsLoaded();

        expect(live.questionListeners).toBe(1);
        setDecisionQuestions([question("project-11", "terminal-a")]);
        expect(win.setTitle).toHaveBeenLastCalledWith("(1) Daintree");
      });

      it("forgets the questions it counted once disposed", async () => {
        const win = windowWithViews(11);
        const registry = createRegistryMock([win]);
        notificationService.initialize(registry as never);
        await questionsLoaded();
        setDecisionQuestions([question("project-11", "terminal-a")]);

        notificationService.dispose();
        notificationService.initialize(registry as never);
        notificationService.updateNotifications(11, waitingIn("terminal-b"));
        vi.advanceTimersByTime(301);

        // Before the list is read again, only the agent counts.
        expect(electronMock.app.setBadgeCount).toHaveBeenLastCalledWith(1);
      });
    });
  });

  describe("opening a Decisions question (#17232)", () => {
    /** A reference to a question asked in the project view `ownerId` would show. */
    const referenceIn = (ownerId: number) => ({
      hostId: "host-1",
      projectId: `project-${ownerId}`,
      terminalId: "term-1",
      questionId: "q-1",
    });

    /** Each window's app view, with the focus spy the click should hit. */
    const viewFocus = new Map<number, ReturnType<typeof vi.fn>>();

    /**
     * `windows` registered in order, each showing its first view, and ranked by
     * focus as `focusOrder` lists them, most recent first.
     */
    function windowsWith(windows: WindowMock[], focusOrder: WindowMock[] = windows) {
      for (const w of windows) w.activeProjectId = `project-${w.ownerIds[0]}`;
      const registry = createRegistryMock(windows);
      viewFocus.clear();
      registryMock.getAppWebContents.mockImplementation((win: WindowMock) => {
        const id = win.ownerIds[0]!;
        if (!viewFocus.has(id)) viewFocus.set(id, vi.fn());
        return { ...electronMock.webContentsById.get(id)!, focus: viewFocus.get(id) };
      });
      notificationService.initialize({
        ...registry,
        focusOrder: () =>
          focusOrder.map((w) => registry.all().find((ctx) => ctx.windowId === w.id)!),
      } as never);
      return registry;
    }

    const opened = (ownerId: number) =>
      ownerSend(ownerId).mock.calls.filter(
        ([, event]) => (event as { name: string }).name === "decisions:open-question"
      );

    const envelope = (reference: ReturnType<typeof referenceIn>) => [
      "events:push",
      { name: "decisions:open-question", payload: { reference } },
    ];

    it("opens it in the most recently focused window showing the question's project, brought forward", () => {
      const other = createWindowMock(false, [11]);
      const olderShowing = createWindowMock(false, [21]);
      const recentShowing = createWindowMock(false, [31]);
      recentShowing.isMinimized.mockReturnValue(true);
      // Registration order puts the older of the two first.
      const registry = windowsWith(
        [other, olderShowing, recentShowing],
        [other, recentShowing, olderShowing]
      );
      // Both show the project the question was asked in.
      const reference = referenceIn(31);
      const older = registry.all().find((ctx) => ctx.windowId === olderShowing.id)!;
      Object.assign((older.services as { projectViewManager: object }).projectViewManager, {
        getAllViews: () => [
          {
            projectId: reference.projectId,
            view: { webContents: electronMock.webContentsById.get(21) },
          },
        ],
      });

      expect(notificationService.openDecisionQuestion(reference)).toBe(true);

      expect(opened(31)).toEqual([envelope(reference)]);
      expect(opened(21)).toHaveLength(0);
      expect(opened(11)).toHaveLength(0);
      expect(recentShowing.restore).toHaveBeenCalled();
      expect(recentShowing.focus).toHaveBeenCalled();
      expect(viewFocus.get(31)).toHaveBeenCalled();
    });

    it("opens it in the most recently focused window when none shows its project", () => {
      const older = createWindowMock(false, [11]);
      const recent = createWindowMock(false, [21]);
      windowsWith([older, recent], [recent, older]);
      const reference = { ...referenceIn(11), projectId: "project-closed" };

      expect(notificationService.openDecisionQuestion(reference)).toBe(true);

      expect(opened(21)).toEqual([envelope(reference)]);
      expect(opened(11)).toHaveLength(0);
      expect(recent.focus).toHaveBeenCalled();
      expect(viewFocus.get(21)).toHaveBeenCalled();
    });

    it("passes over a window that has gone, and one with no app view to show it", () => {
      const gone = createWindowMock(false, [11]);
      gone.isDestroyed.mockReturnValue(true);
      const blank = createWindowMock(false, [21]);
      const live = createWindowMock(false, [31]);
      windowsWith([gone, blank, live]);
      // With its view gone, a window answers with its own blank contents.
      const blankContents = electronMock.webContentsById.get(21)!;
      Object.assign(blank, { webContents: blankContents });
      const appContents = registryMock.getAppWebContents.getMockImplementation()!;
      registryMock.getAppWebContents.mockImplementation((win: WindowMock) =>
        win === blank ? blankContents : appContents(win)
      );

      notificationService.openDecisionQuestion(referenceIn(11));

      expect(opened(11)).toHaveLength(0);
      expect(opened(21)).toHaveLength(0);
      expect(opened(31)).toHaveLength(1);
    });

    it("reports that nothing could take it with no window open", () => {
      windowsWith([]);

      expect(notificationService.openDecisionQuestion(referenceIn(11))).toBe(false);
      expect(notificationService.openDecisionAttention(referenceIn(11))).toBe(false);
    });

    it("opens it at a follow-up in its thread when one is named (#17235)", () => {
      const only = createWindowMock(false, [11]);
      windowsWith([only]);
      const reference = referenceIn(11);

      expect(notificationService.openDecisionQuestion(reference, "ask-1")).toBe(true);

      expect(opened(11)).toEqual([
        [
          "events:push",
          { name: "decisions:open-question", payload: { reference, messageId: "ask-1" } },
        ],
      ]);
    });

    it("opens the answers needing attention at the pane that asked, in the window a question would open in (#17235)", () => {
      const other = createWindowMock(false, [11]);
      const recent = createWindowMock(false, [21]);
      windowsWith([other, recent], [recent, other]);
      const reference = { ...referenceIn(11), terminalId: "term-asked" };

      expect(notificationService.openDecisionAttention(reference)).toBe(true);

      const attention = (ownerId: number) =>
        ownerSend(ownerId).mock.calls.filter(
          ([, event]) => (event as { name: string }).name === "decisions:open-attention"
        );
      // The window showing its project, though another was focused more recently.
      expect(attention(11)).toEqual([
        [
          "events:push",
          { name: "decisions:open-attention", payload: { terminalId: "term-asked" } },
        ],
      ]);
      expect(attention(21)).toHaveLength(0);
      expect(opened(11)).toHaveLength(0);
      expect(other.focus).toHaveBeenCalled();
    });
  });

  describe("click routing", () => {
    const context = { panelId: "term-9", panelTitle: "Agent", worktreeId: "wt-1" };

    describe("a project that isn't on screen (#15233)", () => {
      function cachedOwnerWindow() {
        const win = createWindowMock(false, [11, 12]);
        win.activeProjectId = "project-11";
        return win;
      }

      it("switches to a cached view's project instead of focusing a panel nobody can see", () => {
        const win = cachedOwnerWindow();
        const openProject = vi.fn(() => true);
        notificationService.initialize(createRegistryMock([win]) as never, undefined, openProject);

        notificationService.showWatchNotification(
          "Agent waiting",
          "Needs input",
          context,
          "notification:watch-navigate",
          { ownerWebContentsId: 12 }
        );
        electronMock.notificationInstances.at(-1)!.trigger("click");

        expect(openProject).toHaveBeenCalledWith(
          { windowId: win.id, workspaceKey: "project-12" },
          "term-9"
        );
        expect(ownerSend(12)).not.toHaveBeenCalled();
        expect(ownerSend(11)).not.toHaveBeenCalled();
        expect(sendToRendererMock).not.toHaveBeenCalled();
      });

      it("still reaches a cached view when its project can't be switched to", () => {
        const win = cachedOwnerWindow();
        const openProject = vi.fn(() => false);
        notificationService.initialize(createRegistryMock([win]) as never, undefined, openProject);

        notificationService.showWatchNotification(
          "Agent waiting",
          "Needs input",
          context,
          "notification:watch-navigate",
          { ownerWebContentsId: 12 }
        );
        electronMock.notificationInstances.at(-1)!.trigger("click");

        expect(openProject).toHaveBeenCalledTimes(1);
        expect(ownerSend(12)).toHaveBeenCalledWith("notification:watch-navigate", context);
      });

      it("leaves the view a cold switch still shows over the incoming one to its own navigate", () => {
        const win = cachedOwnerWindow();
        // Mid switch 12 -> 11: the app view is already 11, but 12 still covers it.
        win.bridgedProjectId = "project-12";
        const openProject = vi.fn(() => true);
        notificationService.initialize(createRegistryMock([win]) as never, undefined, openProject);

        notificationService.showWatchNotification(
          "Agent waiting",
          "Needs input",
          context,
          "notification:watch-navigate",
          { ownerWebContentsId: 12 }
        );
        electronMock.notificationInstances.at(-1)!.trigger("click");

        expect(openProject).not.toHaveBeenCalled();
        expect(ownerSend(12)).toHaveBeenCalledWith("notification:watch-navigate", context);
      });

      it("leaves a view the window is showing to its own navigate", () => {
        const win = cachedOwnerWindow();
        const openProject = vi.fn(() => true);
        notificationService.initialize(createRegistryMock([win]) as never, undefined, openProject);

        notificationService.showWatchNotification(
          "Agent waiting",
          "Needs input",
          context,
          "notification:watch-navigate",
          { ownerWebContentsId: 11 }
        );
        electronMock.notificationInstances.at(-1)!.trigger("click");

        expect(openProject).not.toHaveBeenCalled();
        expect(ownerSend(11)).toHaveBeenCalledWith("notification:watch-navigate", context);
      });

      it("opens the project the banner came from once its view is gone, not the primary window's", () => {
        const primary = createWindowMock(true, [11]);
        const other = cachedOwnerWindow();
        const openProject = vi.fn(() => true);
        notificationService.initialize(
          createRegistryMock([primary, other]) as never,
          undefined,
          openProject
        );

        notificationService.showWatchNotification(
          "Agent waiting",
          "Needs input",
          context,
          "notification:watch-navigate",
          { ownerWebContentsId: 12 }
        );
        // Evicted while the banner sat in Notification Center.
        electronMock.webContentsById.delete(12);
        electronMock.notificationInstances.at(-1)!.trigger("click");

        expect(openProject).toHaveBeenCalledWith(
          { windowId: other.id, workspaceKey: "project-12" },
          "term-9"
        );
        expect(sendToRendererMock).not.toHaveBeenCalled();
      });
    });

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

describe("NotificationService remote owners", () => {
  afterEach(() => {
    notificationService.dispose();
  });

  function fakeSink() {
    return { show: vi.fn(), close: vi.fn() };
  }

  it("hands a remote view's notification to its Shell, as a category, instead of this screen", () => {
    const shown = electronMock.notificationInstances.length;
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    const context = { panelId: "t1", panelTitle: "Claude" };

    notificationService.showWatchNotification("Agent waiting", "b", context, "nav:channel", {
      ownerWebContentsId: -4,
      silent: true,
      category: "waiting",
    });

    expect(sink.show).toHaveBeenCalledWith({
      ownerHandle: -4,
      title: "Agent waiting",
      body: "b",
      category: "waiting",
      navigation: { channel: "nav:channel", context },
    });
    expect(electronMock.notificationInstances.length).toBe(shown);
  });

  it("sends an uncategorised notification to a Shell as info, which carries no sound", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    notificationService.showNativeNotification("t", "b", { ownerWebContentsId: -4 });
    expect(sink.show).toHaveBeenCalledWith(expect.objectContaining({ category: "info" }));
    expect(sink.show.mock.calls[0]![0]).not.toHaveProperty("id");
  });

  it("closes a remote banner on its owner once every panel it names is dealt with", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    notificationService.showNativeNotification("Agents waiting", "b", {
      ownerWebContentsId: -4,
      closeWithPanels: ["t1", "t2"],
    });
    notificationService.showNativeNotification("Agent waiting", "b", {
      ownerWebContentsId: -6,
      closeWithPanels: ["t1"],
    });
    const [grouped, single] = sink.show.mock.calls.map(([n]) => (n as { id: string }).id);
    expect(grouped).not.toBe(single);

    notificationService.closeNotificationsForPanel("t1");
    expect(sink.close.mock.calls).toEqual([[-6, [single]]]);
    notificationService.closeNotificationsForPanel("t2");
    notificationService.closeNotificationsForPanel("t2");
    expect(sink.close.mock.calls).toEqual([
      [-6, [single]],
      [-4, [grouped]],
    ]);
  });

  it("supersedes a remote banner under the same key for the same owner", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    const keyed = (owner: number) =>
      notificationService.showNativeNotification("t", "b", {
        ownerWebContentsId: owner,
        replaceKey: "k",
      });
    keyed(-4);
    keyed(-6);
    keyed(-4);
    const shown = sink.show.mock.calls.map(([n]) => n as { id: string; supersedes?: string[] });
    expect(shown[1]!.supersedes).toBeUndefined();
    expect(shown[2]!.supersedes).toEqual([shown[0]!.id]);
  });

  it("stops tracking a remote owner's banners once it is forgotten, and only that owner's", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    for (const owner of [-4, -6]) {
      notificationService.showNativeNotification("t", "b", {
        ownerWebContentsId: owner,
        closeWithPanels: ["t1"],
      });
    }
    const kept = (sink.show.mock.calls[1]![0] as { id: string }).id;
    notificationService.forgetRemoteOwner(-4);
    expect(notificationService.remoteBannerIds(-4)).toEqual([]);
    expect(notificationService.remoteBannerIds(-6)).toEqual([kept]);
    notificationService.closeNotificationsForPanel("t1");
    expect(sink.close.mock.calls).toEqual([[-6, [kept]]]);
  });

  it("supersedes its own oldest banner on the same owner past the bound, and keeps the rest closable", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    for (let i = 0; i < 201; i++) {
      notificationService.showNativeNotification("t", "b", {
        ownerWebContentsId: -4,
        closeWithPanels: [`p${i}`],
      });
    }
    const shown = sink.show.mock.calls.map(([n]) => n as { id: string; supersedes?: string[] });
    expect(shown[200]!.supersedes).toEqual([shown[0]!.id]);
    expect(sink.close).not.toHaveBeenCalled();
    notificationService.closeNotificationsForPanel("p0");
    expect(sink.close).not.toHaveBeenCalled();
    notificationService.closeNotificationsForPanel("p1");
    expect(sink.close.mock.calls).toEqual([[-4, [shown[1]!.id]]]);
  });

  it("bounds remote banners it keeps closable, closing the oldest on its Shell", () => {
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    for (let i = 0; i < 201; i++) {
      notificationService.showNativeNotification("t", "b", {
        ownerWebContentsId: i === 0 ? -6 : -4,
        closeWithPanels: [`p${i}`],
      });
    }
    const firstId = (sink.show.mock.calls[0]![0] as { id: string }).id;
    expect(sink.close.mock.calls).toEqual([[-6, [firstId]]]);
    expect((sink.show.mock.calls[200]![0] as { supersedes?: string[] }).supersedes).toBeUndefined();
    notificationService.closeNotificationsForPanel("p0");
    notificationService.closeNotificationsForPanel("p1");
    const secondId = (sink.show.mock.calls[1]![0] as { id: string }).id;
    expect(sink.close.mock.calls).toEqual([
      [-6, [firstId]],
      [-4, [secondId]],
    ]);
  });

  it("never shows a remote owner's notification here, even with no sink", () => {
    const shown = electronMock.notificationInstances.length;
    notificationService.setRemoteNotificationSink(null);
    notificationService.showNativeNotification("t", "b", { ownerWebContentsId: -1 });
    expect(electronMock.notificationInstances.length).toBe(shown);
  });

  it("keeps showing local owners' notifications natively", () => {
    const shown = electronMock.notificationInstances.length;
    const sink = fakeSink();
    notificationService.setRemoteNotificationSink(sink);
    notificationService.showNativeNotification("t", "b", { ownerWebContentsId: 12 });
    expect(sink.show).not.toHaveBeenCalled();
    expect(electronMock.notificationInstances.length).toBe(shown + 1);
  });
});
