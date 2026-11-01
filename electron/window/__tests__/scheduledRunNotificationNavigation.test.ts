import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const nav = vi.hoisted(() => ({
  shutdown: null as unknown,
  projects: new Map<string, { id: string; status: string }>(),
  owner: null as unknown,
  registry: null as unknown,
  remoteWindows: new Set<number>(),
  hydrated: new Set<number>(),
  waiters: new Map<number, Array<() => void>>(),
  redirect: vi.fn(),
  switchIn: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => nav.shutdown,
}));
vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => nav.projects.get(id) ?? null },
}));
vi.mock("../projectOwnership.js", () => ({
  findOtherProjectOwner: () => nav.owner,
  redirectToProjectOwner: nav.redirect,
  requestProjectSwitchInWindow: nav.switchIn,
  revealWindow: nav.reveal,
}));
vi.mock("../windowRef.js", () => ({ getWindowRegistry: () => nav.registry }));
vi.mock("../windowHost.js", () => ({
  isWindowOnRemoteHost: (id: number) => nav.remoteWindows.has(id),
}));
vi.mock("../viewHydration.js", () => ({
  isViewHydrated: (id: number) => nav.hydrated.has(id),
  whenViewHydrated: (wc: { id: number }, then: () => void) => {
    const list = nav.waiters.get(wc.id) ?? [];
    list.push(then);
    nav.waiters.set(wc.id, list);
    return () => {
      nav.waiters.set(
        wc.id,
        (nav.waiters.get(wc.id) ?? []).filter((waiter) => waiter !== then)
      );
    };
  },
}));

import {
  SCHEDULED_RUN_LANDING_TIMEOUT_MS,
  _resetScheduledRunNotificationNavigationForTesting,
  openScheduledRunFromNotification,
  setScheduledRunWindowOpener,
} from "../scheduledRunNotificationNavigation.js";

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
}

function windowContext(windowId: number, webContents = new FakeWebContents(windowId * 10)) {
  return {
    windowId,
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: { getActiveView: () => ({ webContents }) } },
    webContents,
  };
}

function registryOf(windows: Array<ReturnType<typeof windowContext>>, primary = windows[0]) {
  return { getPrimary: () => primary, all: () => windows };
}

function foregroundOwner(context: ReturnType<typeof windowContext>) {
  return {
    context,
    projectViewManager: context.services.projectViewManager,
    state: "foreground" as const,
  };
}

const target = {
  projectId: "project-1",
  scheduleId: "schedule-1",
  runId: "run-1",
  terminalId: "terminal-1",
};
const intent = {
  intent: "focus-scheduled-run",
  runId: "run-1",
  scheduleId: "schedule-1",
  panelId: "terminal-1",
};
const project = { id: "project-1", status: "active" };

function hydrate(webContentsId: number): void {
  nav.hydrated.add(webContentsId);
  const waiting = nav.waiters.get(webContentsId) ?? [];
  nav.waiters.delete(webContentsId);
  for (const then of waiting) then();
}

beforeEach(() => {
  nav.shutdown = null;
  nav.projects = new Map([["project-1", project]]);
  nav.owner = null;
  nav.registry = registryOf([]);
  nav.remoteWindows = new Set();
  nav.hydrated = new Set();
  nav.waiters = new Map();
  nav.redirect.mockReset();
  nav.switchIn.mockReset();
  nav.reveal.mockReset();
  _resetScheduledRunNotificationNavigationForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openScheduledRunFromNotification", () => {
  it("lands on the run in the window already showing its project", () => {
    const context = windowContext(1);
    nav.hydrated.add(context.webContents.id);
    nav.registry = registryOf([context]);
    nav.owner = foregroundOwner(context);

    openScheduledRunFromNotification(target);

    expect(nav.redirect).toHaveBeenCalledWith(nav.owner, project, intent);
  });

  it("hands a cached owner the intent to land once it switches in", () => {
    const context = windowContext(1);
    nav.registry = registryOf([context]);
    nav.owner = { ...foregroundOwner(context), state: "cached" };

    openScheduledRunFromNotification(target);

    expect(nav.redirect).toHaveBeenCalledWith(nav.owner, project, intent);
  });

  it("switches the primary window to the project when no window holds it", () => {
    const first = windowContext(1);
    const primary = windowContext(2);
    nav.registry = registryOf([first, primary], primary);

    openScheduledRunFromNotification(target);

    expect(nav.switchIn).toHaveBeenCalledWith(
      primary,
      primary.services.projectViewManager,
      project,
      intent
    );
  });

  it("passes over a window driving a Remote Host, and opens one when every window is", async () => {
    const remote = windowContext(1);
    const local = windowContext(2);
    nav.remoteWindows = new Set([1]);
    nav.registry = registryOf([remote, local], remote);
    openScheduledRunFromNotification(target);
    expect(nav.switchIn).toHaveBeenCalledWith(
      local,
      local.services.projectViewManager,
      project,
      intent
    );

    nav.registry = registryOf([remote], remote);
    const opener = vi.fn(async () => null);
    setScheduledRunWindowOpener(opener);
    openScheduledRunFromNotification(target);
    expect(opener).toHaveBeenCalledWith("project-1");
  });

  it("opens a window when there is none, and lands only once its view has hydrated", async () => {
    const opened = windowContext(7);
    const opener = vi.fn(async () => {
      nav.registry = registryOf([opened]);
      nav.owner = foregroundOwner(opened);
      return 7;
    });
    setScheduledRunWindowOpener(opener);

    openScheduledRunFromNotification(target);
    expect(opener).toHaveBeenCalledWith("project-1");
    await vi.waitFor(() => expect(nav.waiters.get(opened.webContents.id)).toHaveLength(1));
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.reveal).toHaveBeenCalledWith(opened.browserWindow);

    hydrate(opened.webContents.id);
    expect(nav.redirect).toHaveBeenCalledWith(nav.owner, project, intent);
    expect(opened.webContents.listenerCount("destroyed")).toBe(0);
  });

  it("opens one window for clicks that arrive while it opens, and lands each", async () => {
    const opened = windowContext(7);
    let finish: (id: number) => void = () => {};
    const opener = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          finish = resolve;
        })
    );
    setScheduledRunWindowOpener(opener);

    openScheduledRunFromNotification(target);
    // The opening window is registered at once, before it shows the project.
    nav.registry = registryOf([opened]);
    openScheduledRunFromNotification({ ...target, runId: "run-2" });
    expect(opener).toHaveBeenCalledTimes(1);
    expect(nav.switchIn).not.toHaveBeenCalled();

    nav.owner = foregroundOwner(opened);
    nav.hydrated.add(opened.webContents.id);
    finish(7);
    await vi.waitFor(() => expect(nav.redirect).toHaveBeenCalledTimes(2));
    expect(nav.redirect.mock.calls.map(([, , sent]) => sent.runId)).toEqual(["run-1", "run-2"]);
  });

  it("drops a landing whose view never hydrates, or closes first", async () => {
    vi.useFakeTimers();
    const slow = windowContext(1);
    nav.registry = registryOf([slow]);
    nav.owner = foregroundOwner(slow);

    openScheduledRunFromNotification(target);
    expect(nav.waiters.get(slow.webContents.id)).toHaveLength(1);
    vi.advanceTimersByTime(SCHEDULED_RUN_LANDING_TIMEOUT_MS);
    expect(nav.waiters.get(slow.webContents.id)).toHaveLength(0);
    hydrate(slow.webContents.id);
    expect(nav.redirect).not.toHaveBeenCalled();

    const closing = windowContext(2);
    nav.registry = registryOf([closing]);
    nav.owner = foregroundOwner(closing);
    openScheduledRunFromNotification(target);
    closing.webContents.emit("destroyed");
    expect(nav.waiters.get(closing.webContents.id)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens nothing when no window can open", async () => {
    openScheduledRunFromNotification(target);
    expect(nav.redirect).not.toHaveBeenCalled();

    const opener = vi.fn(async () => null);
    setScheduledRunWindowOpener(opener);
    openScheduledRunFromNotification(target);
    await Promise.resolve();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(nav.switchIn).not.toHaveBeenCalled();
  });

  it("opens a closed project, and nothing for one that is gone or missing on disk", () => {
    const context = windowContext(1);
    nav.registry = registryOf([context]);

    nav.projects.set("project-1", { id: "project-1", status: "closed" });
    openScheduledRunFromNotification(target);
    expect(nav.switchIn).toHaveBeenCalledTimes(1);

    nav.projects.set("project-1", { id: "project-1", status: "missing" });
    openScheduledRunFromNotification(target);
    nav.projects.delete("project-1");
    openScheduledRunFromNotification(target);
    expect(nav.switchIn).toHaveBeenCalledTimes(1);
  });

  it("does nothing once Daintree is quitting", () => {
    nav.registry = registryOf([windowContext(1)]);
    nav.shutdown = { phase: "running" };
    openScheduledRunFromNotification(target);
    expect(nav.switchIn).not.toHaveBeenCalled();
  });
});
