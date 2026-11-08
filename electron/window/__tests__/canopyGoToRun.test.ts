import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  shutdown: null as unknown,
  projects: new Map<string, { id: string; name: string; path: string; status?: string }>(),
  scratches: new Set<string>(),
  contexts: [] as unknown[],
  remoteWindows: new Set<number>(),
  hydrated: new Set<number>(),
  waiters: new Map<number, Array<() => void>>(),
  switchToLocal: vi.fn(async () => ({ outcome: "switched" })),
}));

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => nav.shutdown,
}));
vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => nav.projects.get(id) ?? null },
}));
vi.mock("../../services/ScratchStore.js", () => ({
  scratchStore: {
    getScratchById: (id: string) => (nav.scratches.has(id) ? { id, path: `/s/${id}` } : null),
  },
}));
vi.mock("../windowRef.js", () => ({
  getWindowRegistry: () => ({
    all: () => nav.contexts,
    getByWindowId: (id: number) =>
      nav.contexts.find((context) => (context as { windowId: number }).windowId === id),
  }),
}));
vi.mock("../windowHost.js", () => ({
  isWindowOnRemoteHost: (id: number) => nav.remoteWindows.has(id),
  switchWindowToLocal: nav.switchToLocal,
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
  CANOPY_RUN_OPENING_TIMEOUT_MS,
  _resetCanopyGoToRunForTesting,
  goToCanopyRun,
  setCanopyRunWindowOpener,
} from "../canopyGoToRun.js";
import { WORKSPACE_LANDING_TIMEOUT_MS } from "../workspaceLanding.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const SCRATCH = "11111111-2222-4333-8444-555555555555";
const RUN = "agent-1";
const FOCUS = { intent: "focus-panel", panelId: RUN };

let nextId = 1;

function makeWebContents() {
  return {
    id: 100 + nextId++,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    focus: vi.fn(),
    send: vi.fn(),
  };
}

type FakeWebContents = ReturnType<typeof makeWebContents>;

/** A project window: what it shows, and what it holds in its cache. */
function addWindow(active: string | null, cached: string[] = []) {
  const windowId = nextId++;
  const views = new Map<string, FakeWebContents>();
  for (const id of [active, ...cached]) if (id !== null) views.set(id, makeWebContents());
  const appWebContents = active !== null ? views.get(active)! : makeWebContents();
  const browserWindow = {
    appWebContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  const pvm = {
    getActiveProjectId: () => active,
    getOutgoingBridgeProjectId: () => null,
    getAllViews: () =>
      [...views].map(([projectId, webContents]) => ({
        projectId,
        state: "ready",
        view: { webContents },
      })),
    getActiveView: () => (active !== null ? { webContents: views.get(active)! } : null),
    setPendingFocusIntent: vi.fn(),
  };
  const context = { windowId, browserWindow, services: { projectViewManager: pvm } };
  nav.contexts.push(context);
  return { windowId, browserWindow, pvm, views, appWebContents };
}

function hydrate(webContents: FakeWebContents) {
  nav.hydrated.add(webContents.id);
  for (const waiter of nav.waiters.get(webContents.id) ?? []) waiter();
  nav.waiters.delete(webContents.id);
}

function landed(webContents: FakeWebContents) {
  return webContents.send.mock.calls.some(
    ([channel, intent]) =>
      channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE &&
      JSON.stringify(intent) === JSON.stringify(FOCUS)
  );
}

/** The panes a view was told to focus, in order. */
function focusedPanes(webContents: FakeWebContents) {
  return webContents.send.mock.calls
    .filter(([channel]) => channel === CHANNELS.PROJECT_FOCUS_ON_ACTIVATE)
    .map(([, intent]) => (intent as { panelId: string }).panelId);
}

/** Opens a window showing the workspace, as main's `createWindow` would, hydrated or not. */
function openerThatOpens({ hydrated = true }: { hydrated?: boolean } = {}) {
  const opened: Array<ReturnType<typeof addWindow>> = [];
  const opener = vi.fn(async (workspaceId: string) => {
    const window = addWindow(workspaceId);
    if (hydrated) nav.hydrated.add(window.appWebContents.id);
    opened.push(window);
    return window.windowId;
  });
  setCanopyRunWindowOpener(opener);
  return { opener, opened };
}

beforeEach(() => {
  nav.shutdown = null;
  nav.projects.clear();
  nav.projects.set(PROJECT, { id: PROJECT, name: "Alpha", path: "/alpha" });
  nav.projects.set(OTHER, { id: OTHER, name: "Beta", path: "/beta" });
  nav.scratches.clear();
  nav.scratches.add(SCRATCH);
  nav.contexts = [];
  nav.remoteWindows.clear();
  nav.hydrated.clear();
  nav.waiters.clear();
  nav.switchToLocal.mockClear();
  _resetCanopyGoToRunForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Go to pane from the Canopy window (#16337)", () => {
  it("brings forward the window showing the run's project and focuses the pane there", async () => {
    const elsewhere = addWindow(OTHER);
    const owner = addWindow(PROJECT);
    nav.hydrated.add(owner.appWebContents.id);
    const { opener } = openerThatOpens();

    await goToCanopyRun({ workspaceId: PROJECT, runId: RUN });

    expect(owner.browserWindow.focus).toHaveBeenCalled();
    expect(owner.appWebContents.focus).toHaveBeenCalled();
    expect(landed(owner.appWebContents)).toBe(true);
    expect(opener).not.toHaveBeenCalled();
    expect(elsewhere.browserWindow.focus).not.toHaveBeenCalled();
    expect(elsewhere.appWebContents.send).not.toHaveBeenCalled();
  });

  it("activates the project in the window that has it cached, carrying the pane to focus", async () => {
    const owner = addWindow(OTHER, [PROJECT]);
    const { opener } = openerThatOpens();

    await goToCanopyRun({ workspaceId: PROJECT, runId: RUN });

    expect(owner.pvm.setPendingFocusIntent).toHaveBeenCalledWith(PROJECT, FOCUS);
    expect(owner.appWebContents.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId: PROJECT },
    });
    expect(owner.browserWindow.focus).toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });

  it("opens a new window for a project no window has, leaving the others where they are", async () => {
    const elsewhere = addWindow(OTHER);
    const { opener, opened } = openerThatOpens();

    await goToCanopyRun({ workspaceId: PROJECT, runId: RUN });

    expect(opener).toHaveBeenCalledWith(PROJECT);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.appWebContents.focus).toHaveBeenCalled();
    expect(landed(opened[0]!.appWebContents)).toBe(true);
    expect(elsewhere.appWebContents.send).not.toHaveBeenCalled();
    expect(elsewhere.browserWindow.focus).not.toHaveBeenCalled();
  });

  it("focuses the pane in a new window only once its view has hydrated", async () => {
    const { opened } = openerThatOpens({ hydrated: false });

    let settled = false;
    const going = goToCanopyRun({ workspaceId: PROJECT, runId: RUN }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(landed(opened[0]!.appWebContents)).toBe(false);

    hydrate(opened[0]!.appWebContents);
    await going;

    expect(opened[0]!.appWebContents.focus).toHaveBeenCalled();
    expect(landed(opened[0]!.appWebContents)).toBe(true);
  });

  it("opens one window when Go to pane is pressed again before it has one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened: Array<ReturnType<typeof addWindow>> = [];
    const opener = vi.fn(async (workspaceId: string) => {
      await gate;
      const window = addWindow(workspaceId);
      nav.hydrated.add(window.appWebContents.id);
      opened.push(window);
      return window.windowId;
    });
    setCanopyRunWindowOpener(opener);

    const first = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-1" });
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    const second = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);

    expect(opener).toHaveBeenCalledTimes(1);
    expect(focusedPanes(opened[0]!.appWebContents)).toEqual(["agent-1", "agent-2"]);
  });

  it("lands a later press after the one that opened the window, never before it", async () => {
    const { opener, opened } = openerThatOpens({ hydrated: false });

    const first = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-1" });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    // The window is up and shows the project, but its view hasn't hydrated.
    const second = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    hydrate(opened[0]!.appWebContents);
    await Promise.all([first, second]);

    expect(opener).toHaveBeenCalledTimes(1);
    expect(focusedPanes(opened[0]!.appWebContents)).toEqual(["agent-1", "agent-2"]);
  });

  it("rejects when no window could open, and when one never comes up", async () => {
    setCanopyRunWindowOpener(async () => null);
    await expect(goToCanopyRun({ workspaceId: PROJECT, runId: RUN })).rejects.toMatchObject({
      code: "PROJECT_OPEN_FAILED",
    });

    vi.useFakeTimers();
    const { opened } = openerThatOpens({ hydrated: false });
    const outcome = goToCanopyRun({ workspaceId: PROJECT, runId: RUN }).then(
      () => "resolved",
      (error: { code?: string }) => error.code
    );
    await vi.advanceTimersByTimeAsync(CANOPY_RUN_OPENING_TIMEOUT_MS);
    expect(await outcome).toBe("PROJECT_OPEN_FAILED");
    expect(landed(opened[0]!.appWebContents)).toBe(false);
  });

  it("gives up on a window whose opening stalls, and a later press opens afresh", async () => {
    vi.useFakeTimers();
    const opener = vi.fn(() => new Promise<number | null>(() => {}));
    setCanopyRunWindowOpener(opener);
    const attempt = () =>
      goToCanopyRun({ workspaceId: PROJECT, runId: RUN }).then(
        () => "resolved",
        (error: { code?: string }) => error.code
      );

    let firstOutcome: string | undefined;
    const first = attempt().then((outcome) => {
      firstOutcome = outcome;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(CANOPY_RUN_OPENING_TIMEOUT_MS - 1);
    expect(firstOutcome).toBeUndefined();
    expect(opener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe("PROJECT_OPEN_FAILED");

    const second = attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(opener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CANOPY_RUN_OPENING_TIMEOUT_MS);
    expect(await second).toBe("PROJECT_OPEN_FAILED");
  });

  it("opens afresh for a press that was waiting on an opening that stalled", async () => {
    vi.useFakeTimers();
    const opened: Array<ReturnType<typeof addWindow>> = [];
    const opener = vi
      .fn<(workspaceId: string) => Promise<number | null>>()
      .mockImplementationOnce(() => new Promise<number | null>(() => {}))
      .mockImplementation(async (workspaceId) => {
        const window = addWindow(workspaceId);
        nav.hydrated.add(window.appWebContents.id);
        opened.push(window);
        return window.windowId;
      });
    setCanopyRunWindowOpener(opener);

    const first = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-1" }).then(
      () => "resolved",
      (error: { code?: string }) => error.code
    );
    await vi.advanceTimersByTimeAsync(0);
    const second = goToCanopyRun({ workspaceId: PROJECT, runId: "agent-2" });
    await vi.advanceTimersByTimeAsync(CANOPY_RUN_OPENING_TIMEOUT_MS);

    expect(await first).toBe("PROJECT_OPEN_FAILED");
    await second;
    expect(opener).toHaveBeenCalledTimes(2);
    expect(focusedPanes(opened[0]!.appWebContents)).toEqual(["agent-2"]);
  });

  it("opens nothing for a project that is gone, or whose folder is missing", async () => {
    const { opener } = openerThatOpens();

    await expect(goToCanopyRun({ workspaceId: "c".repeat(64), runId: RUN })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    nav.projects.set(PROJECT, { id: PROJECT, name: "Alpha", path: "/alpha", status: "missing" });
    await expect(goToCanopyRun({ workspaceId: PROJECT, runId: RUN })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(opener).not.toHaveBeenCalled();
  });

  it("still reaches a pane in a window showing a project whose folder went missing", async () => {
    nav.projects.set(PROJECT, { id: PROJECT, name: "Alpha", path: "/alpha", status: "missing" });
    const owner = addWindow(PROJECT);
    nav.hydrated.add(owner.appWebContents.id);

    await goToCanopyRun({ workspaceId: PROJECT, runId: RUN });

    expect(landed(owner.appWebContents)).toBe(true);
  });

  it("does nothing once Daintree is quitting", async () => {
    nav.shutdown = {};
    const owner = addWindow(PROJECT);
    nav.hydrated.add(owner.appWebContents.id);
    const { opener } = openerThatOpens();

    await goToCanopyRun({ workspaceId: PROJECT, runId: RUN });
    await goToCanopyRun({ workspaceId: OTHER, runId: RUN });

    expect(owner.browserWindow.focus).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });
});

describe("Go to pane from the Canopy window, for a run in a scratch", () => {
  it("focuses the pane in the window showing the scratch", async () => {
    const owner = addWindow(SCRATCH);
    nav.hydrated.add(owner.appWebContents.id);

    await goToCanopyRun({ workspaceId: SCRATCH, runId: RUN });

    expect(landed(owner.appWebContents)).toBe(true);
  });

  it("has a window caching the scratch open the run itself, which project.switch can't", async () => {
    const owner = addWindow(PROJECT, [SCRATCH]);

    await goToCanopyRun({ workspaceId: SCRATCH, runId: RUN });

    expect(owner.appWebContents.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
      actionId: "pilot.openRun",
      args: { runId: RUN, workspaceId: SCRATCH },
    });
    expect(owner.browserWindow.focus).toHaveBeenCalled();
  });

  it("brings a window that moved to a host back to this machine, onto the scratch", async () => {
    const owner = addWindow(null, [SCRATCH]);
    nav.remoteWindows.add(owner.windowId);

    await goToCanopyRun({ workspaceId: SCRATCH, runId: RUN });

    expect(owner.pvm.setPendingFocusIntent).toHaveBeenCalledWith(SCRATCH, FOCUS);
    expect(nav.switchToLocal).toHaveBeenCalledWith(owner.windowId, SCRATCH);
    expect(owner.appWebContents.send).not.toHaveBeenCalled();
  });

  it("stops waiting on that window's way back once a landing would have", async () => {
    vi.useFakeTimers();
    const owner = addWindow(null, [SCRATCH]);
    nav.remoteWindows.add(owner.windowId);
    nav.switchToLocal.mockImplementationOnce(() => new Promise(() => {}));

    let settled = false;
    const going = goToCanopyRun({ workspaceId: SCRATCH, runId: RUN }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(WORKSPACE_LANDING_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await going;
    expect(settled).toBe(true);
  });

  it("says so when that window couldn't come back to this machine", async () => {
    const owner = addWindow(null, [SCRATCH]);
    nav.remoteWindows.add(owner.windowId);
    nav.switchToLocal.mockRejectedValueOnce(new Error("The host went away"));

    await expect(goToCanopyRun({ workspaceId: SCRATCH, runId: RUN })).rejects.toThrow(
      "The host went away"
    );
  });

  it("opens a window on a scratch no window has, and nothing for one that is gone", async () => {
    const { opener, opened } = openerThatOpens();

    await goToCanopyRun({ workspaceId: SCRATCH, runId: RUN });
    expect(opener).toHaveBeenCalledWith(SCRATCH);
    expect(landed(opened[0]!.appWebContents)).toBe(true);

    nav.scratches.clear();
    await expect(goToCanopyRun({ workspaceId: SCRATCH, runId: RUN })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
