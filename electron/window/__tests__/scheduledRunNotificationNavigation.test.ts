import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const nav = vi.hoisted(() => ({
  shutdown: null as unknown,
  projects: new Map<string, { id: string; status: string }>(),
  owner: null as { projectId: string } | null,
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
  findOtherProjectOwner: (_registry: unknown, projectId: string) =>
    nav.owner?.projectId === projectId ? nav.owner : null,
  redirectToProjectOwner: nav.redirect,
  requestProjectSwitchInWindow: nav.switchIn,
  revealWindow: nav.reveal,
}));
vi.mock("../windowRef.js", () => ({ getWindowRegistry: () => nav.registry }));
vi.mock("../windowHost.js", () => ({
  isWindowOnRemoteHost: (id: number) => nav.remoteWindows.has(id),
}));
vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: (win: { appWebContents: unknown }) => win.appWebContents,
}));
vi.mock("../viewHydration.js", () => ({
  isViewHydrated: (id: number) => nav.hydrated.has(id),
  whenViewHydrated: (wc: { id: number }, then: () => void) => {
    nav.waiters.set(wc.id, [...(nav.waiters.get(wc.id) ?? []), then]);
    return () => {
      nav.waiters.set(
        wc.id,
        (nav.waiters.get(wc.id) ?? []).filter((waiter) => waiter !== then)
      );
    };
  },
}));

import { CHANNELS } from "../../ipc/channels.js";
import {
  SCHEDULED_RUN_LANDING_TIMEOUT_MS,
  SCHEDULED_RUN_OPENING_TIMEOUT_MS,
  _resetScheduledRunNotificationNavigationForTesting,
  openScheduledRunFromNotification,
  setScheduledRunWindowOpener,
} from "../scheduledRunNotificationNavigation.js";

class FakeWebContents extends EventEmitter {
  readonly sent: Array<[string, unknown]> = [];
  focused = 0;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return false;
  }
  focus(): void {
    this.focused++;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload]);
  }
}

/**
 * A window showing `projectId`, or with none bound (the project picker), whose
 * manager has no active view, as the real one, and only its startup renderer.
 */
function windowContext(windowId: number, projectId: string | null = "project-1") {
  const webContents = new FakeWebContents(windowId * 10);
  const projectViewManager = {
    activeProjectId: projectId,
    getActiveProjectId(): string | null {
      return this.activeProjectId;
    },
    getActiveView(): { webContents: FakeWebContents } | null {
      return this.activeProjectId === null ? null : { webContents };
    },
  };
  return {
    windowId,
    browserWindow: { isDestroyed: () => false, appWebContents: webContents },
    services: { projectViewManager },
    webContents,
  };
}
type FakeContext = ReturnType<typeof windowContext>;

function registryOf(windows: FakeContext[], primary = windows[0]) {
  return {
    getPrimary: () => primary,
    all: () => windows,
    getByWindowId: (id: number) => windows.find((w) => w.windowId === id),
  };
}

function owner(
  context: FakeContext,
  state: "foreground" | "cached" | "activating" = "foreground",
  projectId = "project-1"
) {
  return { context, projectViewManager: context.services.projectViewManager, state, projectId };
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

function hydrate(context: FakeContext): void {
  const id = context.webContents.id;
  nav.hydrated.add(id);
  const waiting = nav.waiters.get(id) ?? [];
  nav.waiters.delete(id);
  for (const then of waiting) then();
}

const intentsSent = (context: FakeContext) =>
  context.webContents.sent
    .filter(([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE)
    .map(([, payload]) => payload);

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
  it("sends the intent to the hydrated view already showing the project", () => {
    const context = windowContext(1);
    nav.hydrated.add(context.webContents.id);
    nav.registry = registryOf([context]);
    nav.owner = owner(context);

    openScheduledRunFromNotification(target);

    expect(intentsSent(context)).toEqual([intent]);
    expect(context.webContents.focused).toBe(1);
    expect(nav.reveal).toHaveBeenCalledWith(context.browserWindow);
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it("waits for a view still arriving to hydrate, and sends nothing once it shows another project", () => {
    const context = windowContext(1);
    nav.registry = registryOf([context]);
    nav.owner = owner(context);

    openScheduledRunFromNotification(target);
    expect(intentsSent(context)).toEqual([]);
    hydrate(context);
    expect(intentsSent(context)).toEqual([intent]);

    const moved = windowContext(2);
    nav.registry = registryOf([moved]);
    nav.owner = owner(moved);
    openScheduledRunFromNotification(target);
    moved.services.projectViewManager.activeProjectId = "project-2";
    hydrate(moved);
    expect(intentsSent(moved)).toEqual([]);
  });

  it.each(["cached", "activating"] as const)(
    "hands a %s owner the intent for the switch it runs",
    (state) => {
      const context = windowContext(1);
      nav.registry = registryOf([context]);
      nav.owner = owner(context, state);

      openScheduledRunFromNotification(target);

      expect(nav.redirect).toHaveBeenCalledWith(nav.owner, project, intent);
      expect(intentsSent(context)).toEqual([]);
    }
  );

  it("switches the primary window to the project when no window holds it", () => {
    const first = windowContext(1, "project-9");
    const primary = windowContext(2, "project-9");
    nav.hydrated = new Set([first.webContents.id, primary.webContents.id]);
    nav.registry = registryOf([first, primary], primary);

    openScheduledRunFromNotification(target);

    expect(nav.switchIn).toHaveBeenCalledWith(
      primary,
      primary.services.projectViewManager,
      project,
      intent
    );
  });

  it("asks a window to switch only once its view can take the request", () => {
    vi.useFakeTimers();
    const booting = windowContext(1, null);
    nav.registry = registryOf([booting]);

    openScheduledRunFromNotification(target);
    expect(nav.switchIn).not.toHaveBeenCalled();
    hydrate(booting);
    expect(nav.switchIn).toHaveBeenCalledTimes(1);

    const stuck = windowContext(2, null);
    nav.registry = registryOf([stuck]);
    openScheduledRunFromNotification(target);
    vi.advanceTimersByTime(SCHEDULED_RUN_LANDING_TIMEOUT_MS);
    hydrate(stuck);
    expect(nav.switchIn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes over a window driving a Remote Host, and opens one when every window is", () => {
    const remote = windowContext(1, null);
    const local = windowContext(2, null);
    nav.hydrated = new Set([remote.webContents.id, local.webContents.id]);
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
      nav.owner = owner(opened);
      return 7;
    });
    setScheduledRunWindowOpener(opener);

    openScheduledRunFromNotification(target);
    expect(opener).toHaveBeenCalledWith("project-1");
    await vi.waitFor(() => expect(nav.waiters.get(opened.webContents.id)).toHaveLength(1));
    expect(intentsSent(opened)).toEqual([]);

    hydrate(opened);
    await vi.waitFor(() => expect(intentsSent(opened)).toEqual([intent]));
    expect(opener).toHaveBeenCalledTimes(1);
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

    nav.owner = owner(opened);
    nav.hydrated.add(opened.webContents.id);
    finish(7);
    await vi.waitFor(() => expect(intentsSent(opened)).toHaveLength(2));
    expect(
      intentsSent(opened)
        .map((sent) => (sent as { runId: string }).runId)
        .sort()
    ).toEqual(["run-1", "run-2"]);
  });

  it("holds another project's click until the opening window can switch", async () => {
    nav.projects.set("project-2", { id: "project-2", status: "active" });
    const opened = windowContext(7);
    let finish: (id: number) => void = () => {};
    setScheduledRunWindowOpener(
      () =>
        new Promise<number | null>((resolve) => {
          finish = resolve;
        })
    );

    openScheduledRunFromNotification(target);
    nav.registry = registryOf([opened]);
    openScheduledRunFromNotification({ ...target, projectId: "project-2", runId: "run-2" });
    expect(nav.switchIn).not.toHaveBeenCalled();

    nav.owner = owner(opened);
    finish(7);
    await vi.waitFor(() => expect(nav.waiters.get(opened.webContents.id)).toHaveLength(1));
    expect(nav.switchIn).not.toHaveBeenCalled();
    hydrate(opened);
    await vi.waitFor(() => expect(nav.switchIn).toHaveBeenCalledTimes(1));
    expect(nav.switchIn.mock.calls[0][2]).toEqual({ id: "project-2", status: "active" });
  });

  it("opens again on a later click after an opening failed", async () => {
    const opened = windowContext(7);
    const opener = vi
      .fn<(projectId: string) => Promise<number | null>>()
      .mockRejectedValueOnce(new Error("window failed"))
      .mockImplementationOnce(async () => {
        nav.registry = registryOf([opened]);
        nav.owner = owner(opened);
        nav.hydrated.add(opened.webContents.id);
        return 7;
      });
    setScheduledRunWindowOpener(opener);

    openScheduledRunFromNotification(target);
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    openScheduledRunFromNotification(target);
    await vi.waitFor(() => expect(intentsSent(opened)).toEqual([intent]));
    expect(opener).toHaveBeenCalledTimes(2);
  });

  it("stops holding later clicks behind a window that never comes up", async () => {
    vi.useFakeTimers();
    const opener = vi.fn(() => new Promise<number | null>(() => {}));
    setScheduledRunWindowOpener(opener);
    openScheduledRunFromNotification(target);

    const healthy = windowContext(3);
    nav.hydrated.add(healthy.webContents.id);
    nav.registry = registryOf([healthy]);
    nav.owner = owner(healthy);
    openScheduledRunFromNotification({ ...target, runId: "run-2" });
    await vi.advanceTimersByTimeAsync(SCHEDULED_RUN_OPENING_TIMEOUT_MS - 1);
    expect(intentsSent(healthy)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(intentsSent(healthy)).toEqual([{ ...intent, runId: "run-2" }]);
    expect(opener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the click when no window opens, without trying again", async () => {
    openScheduledRunFromNotification(target);
    expect(nav.switchIn).not.toHaveBeenCalled();

    const ready = windowContext(7);
    const opener = vi.fn(async () => {
      // A window turned up anyway; a declined opening still routes nothing.
      nav.registry = registryOf([ready]);
      nav.owner = owner(ready);
      nav.hydrated.add(ready.webContents.id);
      return null;
    });
    setScheduledRunWindowOpener(opener);
    openScheduledRunFromNotification(target);
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(intentsSent(ready)).toEqual([]);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("drops a landing whose view closes first", () => {
    const closing = windowContext(2);
    nav.registry = registryOf([closing]);
    nav.owner = owner(closing);
    openScheduledRunFromNotification(target);
    closing.webContents.emit("destroyed");
    expect(nav.waiters.get(closing.webContents.id)).toHaveLength(0);
    hydrate(closing);
    expect(intentsSent(closing)).toEqual([]);
  });

  it("opens a closed project, and nothing for one that is gone or missing on disk", () => {
    const context = windowContext(1, null);
    nav.hydrated.add(context.webContents.id);
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

  it("does nothing once Daintree is quitting, even for a landing already waiting", () => {
    const context = windowContext(1);
    nav.registry = registryOf([context]);
    nav.owner = owner(context);
    openScheduledRunFromNotification(target);
    nav.shutdown = { phase: "running" };
    hydrate(context);
    expect(intentsSent(context)).toEqual([]);

    openScheduledRunFromNotification(target);
    expect(nav.reveal).toHaveBeenCalledTimes(1);
  });
});
