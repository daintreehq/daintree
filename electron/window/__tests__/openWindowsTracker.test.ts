import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  OpenWindowRecord,
  OpenWindowsManifestExtras,
} from "../../services/persistence/windowManifest.js";

const writeOpenWindowsManifest =
  vi.fn<(records: OpenWindowRecord[], extras?: OpenWindowsManifestExtras) => void>();
const getActiveShutdown = vi.fn<() => { initiator: string; phase: string } | null>(() => null);

// Both mocks use explicit factories rather than spreading `importOriginal()`:
// the store module reaches better-sqlite3 and shutdownCoordinator reaches
// electron, and pulling either in for real turns this into a suite that passes
// locally and fails on CI. windowManifest.js itself is dependency-free, so the
// constants below come from the real module.
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: (records: OpenWindowRecord[], extras?: OpenWindowsManifestExtras) =>
    writeOpenWindowsManifest(records, extras),
}));

vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => getActiveShutdown(),
}));

import {
  addPendingRemoteBackgroundRestores,
  buildOpenWindowRecords,
  captureWindowRecord,
  clearPendingBackgroundRestores,
  clearPendingWindowRecreation,
  clearPendingRemoteRestore,
  clearPendingRemoteRestoresForHost,
  createWindowHoldingRecord,
  enableOpenWindowsSaves,
  freezeAndSnapshotOpenWindows,
  initOpenWindowsTracker,
  markWindowRecreationSetupFailed,
  onPendingRemoteRestoreChanged,
  removePendingRemoteBackgroundRestores,
  resetOpenWindowsTrackerForTests,
  resumeOpenWindowsSaves,
  saveBeforeLastWindowCloses,
  saveOpenWindowsNow,
  scheduleOpenWindowsSave,
  setCanopyWindowOpen,
  setPendingBackgroundRestores,
  setPendingRemoteRestore,
  setPendingWindowRecreation,
  suppressOpenWindowsSaves,
} from "../openWindowsTracker.js";
import {
  MAX_BACKGROUND_HOST_PROJECTS_PER_WINDOW,
  MAX_BACKGROUND_PROJECTS_PER_WINDOW,
  MAX_RESTORED_WINDOWS,
} from "../../services/persistence/windowManifest.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";

interface FakeWindow {
  windowId: number;
  projectId: string | null;
  destroyed?: boolean;
  throwsOnRead?: boolean;
  noManager?: boolean;
  /** Cached views this window holds, as [projectId, lastUsed] pairs (#12320). */
  views?: Array<[string, number]>;
}

function makeCtx(win: FakeWindow): WindowContext {
  return {
    windowId: win.windowId,
    webContentsId: win.windowId * 10,
    browserWindow: { isDestroyed: () => win.destroyed === true },
    // Deliberately wrong on purpose: every test project id comes from the
    // ProjectViewManager, so a record built from projectPath would be visibly
    // wrong rather than accidentally right.
    projectPath: "/stale/path/from/registration",
    abortController: new AbortController(),
    services: win.noManager
      ? {}
      : {
          projectViewManager: {
            getActiveProjectId: () => {
              if (win.throwsOnRead) throw new Error("manager disposing");
              return win.projectId;
            },
            getAllViews: () =>
              (win.views ?? []).map(([projectId, lastUsed]) => ({ projectId, lastUsed })),
          },
        },
    cleanup: { dispose: () => {} },
  } as unknown as WindowContext;
}

/** Registry double whose focusOrder() is the ordering under test. */
function makeRegistry(wins: FakeWindow[]): WindowRegistry {
  const contexts = wins.map(makeCtx);
  return {
    focusOrder: () => contexts,
    all: () => contexts,
  } as unknown as WindowRegistry;
}

function lastWritten(): OpenWindowRecord[] {
  const calls = writeOpenWindowsManifest.mock.calls;
  return calls[calls.length - 1][0];
}

/** Whether the last write recorded the Canopy window as open. */
function lastWroteCanopyOpen(): boolean {
  const calls = writeOpenWindowsManifest.mock.calls;
  return calls[calls.length - 1][1]?.canopyWindowOpen === true;
}

beforeEach(() => {
  vi.useFakeTimers();
  writeOpenWindowsManifest.mockClear();
  getActiveShutdown.mockReturnValue(null);
  resetOpenWindowsTrackerForTests();
});

afterEach(() => {
  resetOpenWindowsTrackerForTests();
  vi.useRealTimers();
});

describe("buildOpenWindowRecords", () => {
  it("reads each window's project from its view manager, not the stale registration path", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "switched-to" },
      { windowId: 2, projectId: "other" },
    ]);
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "switched-to" },
      { projectId: "other" },
    ]);
  });

  it("keeps two windows showing the same project as two records", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "shared" },
      { windowId: 2, projectId: "shared" },
    ]);
    expect(buildOpenWindowRecords(registry)).toHaveLength(2);
  });

  // A picker holds nothing to restore, and one saved came back on every
  // launch until it was closed by hand (#16740).
  it("leaves windows on the picker out of the manifest", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: null },
      { windowId: 2, projectId: "a" },
      { windowId: 3, projectId: null },
    ]);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "a" }]);
    // An OOM rebuild still reads the window as the picker it is.
    expect(captureWindowRecord(registry, 1)).toEqual({ projectId: null });
  });

  it("hands a picker's background projects to the first window with a workspace", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: null, views: [["warm", 1]] },
      {
        windowId: 2,
        projectId: "a",
        views: [
          ["a", 2],
          ["own", 1],
        ],
      },
      { windowId: 3, projectId: "b", views: [["b", 1]] },
    ]);
    expect(buildOpenWindowRecords(registry, undefined, new Set(["running"]))).toEqual([
      { projectId: "a", backgroundProjectIds: ["own", "warm", "running"] },
      { projectId: "b" },
    ]);
  });

  it("keeps one picker to carry the background projects when no window has a workspace", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: null },
      { windowId: 2, projectId: null, views: [["warm", 1]] },
    ]);
    expect(buildOpenWindowRecords(registry, undefined, new Set(["running"]))).toEqual([
      { projectId: null, backgroundProjectIds: ["running", "warm"] },
    ]);
  });

  it("gives every manifest slot to a window with a workspace, however many pickers are open", () => {
    const registry = makeRegistry([
      ...Array.from({ length: 3 }, (_, i) => ({ windowId: 100 + i, projectId: null })),
      ...Array.from({ length: MAX_RESTORED_WINDOWS }, (_, i) => ({
        windowId: i + 1,
        projectId: `p${i}`,
      })),
    ]);
    expect(buildOpenWindowRecords(registry).map((r) => r.projectId)).toEqual(
      Array.from({ length: MAX_RESTORED_WINDOWS }, (_, i) => `p${i}`)
    );
  });

  it("keeps naming a restored window's host project while it waits on the picker", () => {
    const remote = `studio-01:${"a".repeat(64)}`;
    const win: FakeWindow = { windowId: 1, projectId: null };
    const registry = makeRegistry([win]);
    setPendingRemoteRestore(1, remote);
    // The host was unreachable this launch: quitting now must not forget it.
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: remote }]);
    // The person opened a project here instead: the intent is spent for good.
    win.projectId = "local";
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "local" }]);
    win.projectId = null;
    expect(buildOpenWindowRecords(registry)).toEqual([]);
  });

  it("stops naming a removed host's projects for any window, and only that host's", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: null },
      { windowId: 2, projectId: null },
      { windowId: 3, projectId: null },
    ]);
    setPendingRemoteRestore(1, `studio:${"a".repeat(64)}`);
    setPendingRemoteRestore(2, `studio:${"b".repeat(64)}`);
    setPendingRemoteRestore(3, `studio-2:${"a".repeat(64)}`);
    clearPendingRemoteRestoresForHost("studio");
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: `studio-2:${"a".repeat(64)}` }]);
  });

  it("tells listeners when a window starts or stops waiting for a host's project", () => {
    const listener = vi.fn();
    const unsubscribe = onPendingRemoteRestoreChanged(listener);

    setPendingRemoteRestore(1, `studio:${"a".repeat(64)}`);
    setPendingRemoteRestore(2, `studio-2:${"a".repeat(64)}`);
    expect(listener).toHaveBeenCalledTimes(2);

    clearPendingRemoteRestore(1);
    clearPendingRemoteRestore(1);
    clearPendingRemoteRestoresForHost("studio");
    expect(listener).toHaveBeenCalledTimes(3);

    clearPendingRemoteRestoresForHost("studio-2");
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    setPendingRemoteRestore(1, `studio:${"a".repeat(64)}`);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("keeps a window whose manager throws on the workspace it was last seen showing", () => {
    // Pickers are left out, so recording it as one would lose the window.
    const disposing: FakeWindow = { windowId: 2, projectId: "b", views: [["warm", 1]] };
    const registry = makeRegistry([{ windowId: 1, projectId: "a" }, disposing]);
    buildOpenWindowRecords(registry);
    disposing.projectId = "c";
    buildOpenWindowRecords(registry);

    disposing.throwsOnRead = true;
    // Its background list goes with the manager that can't answer for it.
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "a" }, { projectId: "c" }]);
  });

  it("gives a throwing manager no workspace it was never seen showing", () => {
    const win: FakeWindow = { windowId: 2, projectId: "b" };
    const registry = makeRegistry([{ windowId: 1, projectId: "a" }, win]);
    expect(
      buildOpenWindowRecords(
        makeRegistry([
          { windowId: 1, projectId: "a" },
          { windowId: 2, projectId: "b", throwsOnRead: true },
        ])
      )
    ).toEqual([{ projectId: "a" }]);

    // Seen showing a workspace, then the picker: the picker is the last answer.
    buildOpenWindowRecords(registry);
    win.projectId = null;
    buildOpenWindowRecords(registry);
    win.throwsOnRead = true;
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "a" }]);
  });

  it("lets a host intent outrank the workspace a throwing manager was last seen showing", () => {
    const remote = `studio-01:${"a".repeat(64)}`;
    const win: FakeWindow = { windowId: 1, projectId: "local" };
    const registry = makeRegistry([win]);
    buildOpenWindowRecords(registry);
    setPendingRemoteRestore(1, remote);
    win.throwsOnRead = true;
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: remote }]);
  });

  it("forgets what a closed window was showing", () => {
    const win: FakeWindow = { windowId: 2, projectId: "b" };
    buildOpenWindowRecords(makeRegistry([{ windowId: 1, projectId: "a" }, win]));
    // Closed: a save without it lets go of what it showed.
    buildOpenWindowRecords(makeRegistry([{ windowId: 1, projectId: "a" }]));
    win.throwsOnRead = true;
    expect(buildOpenWindowRecords(makeRegistry([{ windowId: 1, projectId: "a" }, win]))).toEqual([
      { projectId: "a" },
    ]);
  });

  it("leaves out a window whose manager is not built yet unless it holds a record", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: null, noManager: true }]);
    expect(buildOpenWindowRecords(registry)).toEqual([]);
    setPendingWindowRecreation(1, { projectId: "restoring" });
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "restoring" }]);
  });

  it("skips a destroyed window", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a", destroyed: true },
      { windowId: 2, projectId: "b" },
    ]);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "b" }]);
  });

  it("excludes the window whose teardown is already committed", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a" },
      { windowId: 2, projectId: "closing" },
      { windowId: 3, projectId: "c" },
    ]);
    expect(buildOpenWindowRecords(registry, 2)).toEqual([{ projectId: "a" }, { projectId: "c" }]);
  });

  it("caps the record list", () => {
    const registry = makeRegistry(
      Array.from({ length: MAX_RESTORED_WINDOWS + 5 }, (_, i) => ({
        windowId: i + 1,
        projectId: `p${i}`,
      }))
    );
    expect(buildOpenWindowRecords(registry)).toHaveLength(MAX_RESTORED_WINDOWS);
  });
});

describe("OOM recreation records (#15564)", () => {
  it("captures a window past the fleet cap", () => {
    const registry = makeRegistry(
      Array.from({ length: MAX_RESTORED_WINDOWS + 2 }, (_, i) => ({
        windowId: i + 1,
        projectId: `p${i}`,
      }))
    );
    const last = MAX_RESTORED_WINDOWS + 2;
    expect(captureWindowRecord(registry, last)).toEqual({ projectId: `p${last - 1}` });
    expect(captureWindowRecord(registry, last + 1)).toBeNull();
  });

  it("captures the window's record as the manifest holds it, without orphaned live workspaces", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a", views: [["a", 3]] },
      {
        windowId: 2,
        projectId: "b",
        views: [
          ["b", 2],
          ["c", 1],
        ],
      },
    ]);
    setPendingBackgroundRestores(2, ["a", "d"]);
    const live = new Set(["orphan"]);

    // The manifest hands the orphan to the primary window; a capture of that
    // window describes what it held, not what the next save would assign it.
    expect(buildOpenWindowRecords(registry, undefined, live)[0]).toEqual({
      projectId: "a",
      backgroundProjectIds: ["orphan"],
    });
    expect(captureWindowRecord(registry, 1)).toEqual({ projectId: "a" });
    expect(captureWindowRecord(registry, 2)).toEqual({
      projectId: "b",
      backgroundProjectIds: ["c", "d"],
    });
  });

  it("names a replacement window's captured workspace until it shows one of its own", () => {
    const win: FakeWindow = { windowId: 5, projectId: null };
    const registry = makeRegistry([win]);
    setPendingWindowRecreation(5, { projectId: "b", backgroundProjectIds: ["c"] });

    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "b", backgroundProjectIds: ["c"] },
    ]);

    // The person switched while setup still awaits: what the window shows
    // wins, and the backgrounds setup has yet to queue stay with it.
    win.projectId = "x";
    win.views = [["x", 1]];
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "x", backgroundProjectIds: ["c"] },
    ]);

    clearPendingWindowRecreation(5);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "x" }]);
  });

  it("spends a failed replacement's record once the person opens something there", () => {
    const win: FakeWindow = { windowId: 5, projectId: null };
    const registry = makeRegistry([win]);
    setPendingWindowRecreation(5, { projectId: "b", backgroundProjectIds: ["c"] });
    markWindowRecreationSetupFailed(5);

    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "b", backgroundProjectIds: ["c"] },
    ]);

    win.projectId = "x";
    win.views = [["x", 1]];
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "x" }]);
    win.projectId = null;
    win.views = [];
    expect(buildOpenWindowRecords(registry)).toEqual([]);
  });

  it("leaves a host-scoped replacement's pending host intent unspent", () => {
    const remote = `studio-01:${"a".repeat(64)}`;
    const registry = makeRegistry([{ windowId: 5, projectId: null }]);
    setPendingRemoteRestore(5, remote);
    setPendingWindowRecreation(5, { projectId: remote });

    buildOpenWindowRecords(registry);
    clearPendingWindowRecreation(5);

    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: remote }]);
  });

  it("keeps a host-scoped replacement's backgrounds while it waits on the picker for its host", () => {
    const remote = `studio-01:${"a".repeat(64)}`;
    const registry = makeRegistry([{ windowId: 5, projectId: null }]);
    setPendingRemoteRestore(5, remote);
    setPendingWindowRecreation(5, { projectId: remote, backgroundProjectIds: ["c"] });

    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: remote, backgroundProjectIds: ["c"] },
    ]);
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: remote, backgroundProjectIds: ["c"] },
    ]);
  });
});

// A restored window binds its workspace only once its setup gets there, and
// one that stalls past its turn lets saves resume while it still shows the
// picker (#16740).
describe("createWindowHoldingRecord", () => {
  it("saves a restored window as its record until its setup settles", async () => {
    const win: FakeWindow = { windowId: 7, projectId: null };
    const registry = makeRegistry([win]);
    let finish!: () => void;
    const created = createWindowHoldingRecord(
      { projectId: "b", backgroundProjectIds: ["c"] },
      (onRegistered) =>
        new Promise<string>((resolve) => {
          onRegistered(7);
          finish = () => resolve("ok");
        })
    );

    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "b", backgroundProjectIds: ["c"] },
    ]);
    // What the window shows wins while setup still runs; back on the picker,
    // the record is still what it is becoming.
    win.projectId = "x";
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "x", backgroundProjectIds: ["c"] },
    ]);
    win.projectId = null;
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "b", backgroundProjectIds: ["c"] },
    ]);

    // Setup found the workspace gone and left the window on the picker.
    finish();
    await expect(created).resolves.toBe("ok");
    expect(buildOpenWindowRecords(registry)).toEqual([]);
  });

  it("stops naming background projects once the restore has taken them", async () => {
    // A setup that stalls after queuing them must not keep saving a project the
    // person has since slept: the restore tracks them from here.
    const host = `studio-01:${"h".repeat(64)}`;
    const registry = makeRegistry([{ windowId: 7, projectId: null }]);
    let finish!: () => void;
    const created = createWindowHoldingRecord(
      { projectId: "b", backgroundProjectIds: ["c", "d", host] },
      (onRegistered) =>
        new Promise<void>((resolve) => {
          onRegistered(7);
          finish = resolve;
        })
    );

    setPendingBackgroundRestores(7, ["c", "d"]);
    addPendingRemoteBackgroundRestores(7, [host]);
    // "c" restored; "d" was slept and the queue let it go.
    setPendingBackgroundRestores(7, []);
    removePendingRemoteBackgroundRestores(7, (key) => key === host);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "b" }]);

    finish();
    await created;
  });

  it("keeps the record after a setup that threw, until the window shows a workspace", async () => {
    const win: FakeWindow = { windowId: 7, projectId: null };
    const registry = makeRegistry([win]);
    const failure = new Error("setup threw");
    await expect(
      createWindowHoldingRecord({ projectId: "b" }, async (onRegistered) => {
        onRegistered(7);
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "b" }]);
    win.projectId = "x";
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "x" }]);
    win.projectId = null;
    expect(buildOpenWindowRecords(registry)).toEqual([]);
  });
});

describe("scheduleOpenWindowsSave", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
      readOnly: false,
    });
  });

  it("does not write until the debounce elapses", () => {
    scheduleOpenWindowsSave();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one write", () => {
    scheduleOpenWindowsSave();
    scheduleOpenWindowsSave();
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("refuses a write for a shutdown that lands inside the debounce window", () => {
    // The updater closes windows one at a time once a quit is committed; a save
    // landing then would walk the persisted list down to empty.
    scheduleOpenWindowsSave();
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("refuses to schedule at all once a shutdown owns the process", () => {
    getActiveShutdown.mockReturnValue({ initiator: "update-install", phase: "cleaning" });
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("stays frozen through the handoff phase, not just cleaning", () => {
    getActiveShutdown.mockReturnValue({ initiator: "update-install", phase: "handoff" });
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("does nothing before the tracker is initialised", () => {
    resetOpenWindowsTrackerForTests();
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("survives a failing write and logs the cause", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = new Error("db closed");
    writeOpenWindowsManifest.mockImplementationOnce(() => {
      throw cause;
    });

    scheduleOpenWindowsSave();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.any(String), cause);
    warn.mockRestore();
  });

  it("keeps saving after a write failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOpenWindowsManifest.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    writeOpenWindowsManifest.mockClear();

    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("recovery launches", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([{ windowId: 1, projectId: "only-one" }]),
      readOnly: true,
    });
  });

  it("never overwrites the stored fleet with the one window safe mode opened", () => {
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    saveOpenWindowsNow();
    freezeAndSnapshotOpenWindows();

    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("writes nothing across the real recovery startup sequence", () => {
    // The exact production ordering: read-only tracker, fan-out hold, then a
    // resume that would normally persist. The fleet on disk must survive it.
    suppressOpenWindowsSaves();
    resumeOpenWindowsSaves(true);
    vi.runAllTimers();

    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("writes again once a single-crash fleet restore lifts the hold (#12801)", () => {
    suppressOpenWindowsSaves();
    enableOpenWindowsSaves();
    // Still suppressed: lifting read-only must not release the fan-out hold.
    saveOpenWindowsNow();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();

    resumeOpenWindowsSaves(true);
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("cannot undo the shutdown freeze", () => {
    freezeAndSnapshotOpenWindows();
    enableOpenWindowsSaves();
    saveOpenWindowsNow();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });
});

describe("a shutdown that lands during the startup fan-out", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
      readOnly: false,
    });
  });

  it("writes nothing, even though the fan-out resume asks it to", () => {
    // Quitting mid-restore: the freeze latches while suppression is still held,
    // so the resume that follows must not write a half-restored fleet.
    scheduleOpenWindowsSave();
    suppressOpenWindowsSaves();
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    freezeAndSnapshotOpenWindows();
    resumeOpenWindowsSaves(true);
    vi.runAllTimers();

    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });
});

describe("saveOpenWindowsNow", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([
        { windowId: 1, projectId: "a" },
        { windowId: 2, projectId: "b" },
      ]),
      readOnly: false,
    });
  });

  it("drops a pending debounce so a close does not double-write", () => {
    scheduleOpenWindowsSave();
    saveOpenWindowsNow();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("omits the closing window from the manifest it writes", () => {
    saveOpenWindowsNow(2);
    expect(lastWritten()).toEqual([{ projectId: "a" }]);
  });

  it("refuses to write during a shutdown, so closes cannot empty the list", () => {
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    saveOpenWindowsNow(1);
    saveOpenWindowsNow(2);
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  describe("the last window closing", () => {
    const platform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
    });

    it.each(["win32", "linux"])(
      "keeps the previous fleet on %s, where that close is the quit (#12320)",
      (value) => {
        Object.defineProperty(process, "platform", { value });
        initOpenWindowsTracker({
          registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
          readOnly: false,
        });
        saveOpenWindowsNow(1);
        expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
      }
    );

    it.each(["win32", "linux"])(
      "records what the last window shows as it starts closing on %s",
      (value) => {
        Object.defineProperty(process, "platform", { value });
        const remote = `ubuntu-24.04:${"b".repeat(64)}`;
        const win: FakeWindow = { windowId: 1, projectId: "local" };
        initOpenWindowsTracker({ registry: makeRegistry([win]), readOnly: false });

        // The window moved onto a host, which schedules no save of its own.
        win.projectId = remote;
        saveBeforeLastWindowCloses(1);
        expect(lastWritten()).toEqual([{ projectId: remote }]);

        // Its `closed` save then finds nothing and keeps that record.
        writeOpenWindowsManifest.mockClear();
        saveOpenWindowsNow(1);
        expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
      }
    );

    it.each(["win32", "linux"])(
      "lets go of a closed project window on %s while a picker window stays open (#16740)",
      (value) => {
        Object.defineProperty(process, "platform", { value });
        initOpenWindowsTracker({
          registry: makeRegistry([
            { windowId: 1, projectId: "a" },
            { windowId: 2, projectId: null },
          ]),
          readOnly: false,
        });
        // The picker leaves no record, but it is a window the session kept, so
        // the save lands rather than leaving the closed project on disk.
        saveOpenWindowsNow(1);
        expect(lastWritten()).toEqual([]);
      }
    );

    it("leaves a closing window alone while another stays open", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      initOpenWindowsTracker({
        registry: makeRegistry([
          { windowId: 1, projectId: "a" },
          { windowId: 2, projectId: "b" },
        ]),
        readOnly: false,
      });
      saveBeforeLastWindowCloses(1);
      expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
    });

    it("does nothing on darwin, where Cmd+Q snapshots the live windows", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      initOpenWindowsTracker({
        registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
        readOnly: false,
      });
      saveBeforeLastWindowCloses(1);
      expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
    });

    it("still records an empty set on darwin, where the app survives windowless", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      initOpenWindowsTracker({
        registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
        readOnly: false,
      });
      saveOpenWindowsNow(1);
      expect(lastWritten()).toEqual([]);
    });
  });
});

describe("fan-out suppression", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([
        { windowId: 1, projectId: "a" },
        { windowId: 2, projectId: "b" },
      ]),
      readOnly: false,
    });
  });

  it("holds every write while the restore fan-out is in flight", () => {
    suppressOpenWindowsSaves();
    scheduleOpenWindowsSave();
    saveOpenWindowsNow();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("cancels a debounce that was already pending when suppression started", () => {
    scheduleOpenWindowsSave();
    suppressOpenWindowsSaves();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("writes one full snapshot when the fan-out completes cleanly", () => {
    suppressOpenWindowsSaves();
    resumeOpenWindowsSaves(true);
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    expect(lastWritten()).toEqual([{ projectId: "a" }, { projectId: "b" }]);
  });

  it("leaves the stored manifest alone when the fan-out died partway", () => {
    // A partial fleet must never overwrite a manifest that is still correct.
    suppressOpenWindowsSaves();
    resumeOpenWindowsSaves(false);
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("re-arms saves after the fan-out, however it ended", () => {
    suppressOpenWindowsSaves();
    resumeOpenWindowsSaves(false);
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });
});

describe("freezeAndSnapshotOpenWindows", () => {
  beforeEach(() => {
    initOpenWindowsTracker({
      registry: makeRegistry([
        { windowId: 1, projectId: "a" },
        { windowId: 2, projectId: "b" },
      ]),
      readOnly: false,
    });
  });

  it("captures the window set even though a shutdown already owns the process", () => {
    // startShutdown() sets the active shutdown before running the chain, so an
    // ordinary save would refuse here and a pending switch would be lost.
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    freezeAndSnapshotOpenWindows();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    expect(lastWritten()).toEqual([{ projectId: "a" }, { projectId: "b" }]);
  });

  it("captures what a pending debounce still owed", () => {
    scheduleOpenWindowsSave();
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    freezeAndSnapshotOpenWindows();
    vi.runAllTimers();
    // Exactly one write: the snapshot. The debounce was folded into it, not
    // left to fire against a closing database.
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("latches writes off, so the closes that follow cannot empty the list", () => {
    freezeAndSnapshotOpenWindows();
    writeOpenWindowsManifest.mockClear();

    saveOpenWindowsNow(1);
    saveOpenWindowsNow(2);
    scheduleOpenWindowsSave();
    vi.runAllTimers();

    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("stays latched even if the shutdown is somehow cleared afterwards", () => {
    freezeAndSnapshotOpenWindows();
    writeOpenWindowsManifest.mockClear();
    getActiveShutdown.mockReturnValue(null);

    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("is safe to call twice and only snapshots once", () => {
    freezeAndSnapshotOpenWindows();
    freezeAndSnapshotOpenWindows();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("does not snapshot mid-fan-out, where the fleet is only partly up", () => {
    suppressOpenWindowsSaves();
    freezeAndSnapshotOpenWindows();
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("survives a failing write without breaking the shutdown chain", () => {
    writeOpenWindowsManifest.mockImplementationOnce(() => {
      throw new Error("db closed");
    });
    expect(() => freezeAndSnapshotOpenWindows()).not.toThrow();
  });
});

describe("the Canopy window (#16336)", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  const track = (wins: FakeWindow[], readOnly = false) =>
    initOpenWindowsTracker({ registry: makeRegistry(wins), readOnly });

  it("is saved open as it opens, beside the windows and never as one of them", () => {
    track([{ windowId: 1, projectId: "a" }]);
    setCanopyWindowOpen(true);
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    expect(lastWritten()).toEqual([{ projectId: "a" }]);
    expect(lastWroteCanopyOpen()).toBe(true);
  });

  it("is saved closed as it closes, and stays so in every later save", () => {
    track([{ windowId: 1, projectId: "a" }]);
    setCanopyWindowOpen(true);
    setCanopyWindowOpen(false);
    expect(lastWroteCanopyOpen()).toBe(false);
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(3);
    expect(lastWroteCanopyOpen()).toBe(false);
  });

  it("writes nothing for a report that changes nothing", () => {
    track([{ windowId: 1, projectId: "a" }]);
    setCanopyWindowOpen(false);
    setCanopyWindowOpen(true);
    setCanopyWindowOpen(true);
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
  });

  it("rides along in every save while it stands", () => {
    track([{ windowId: 1, projectId: "a" }]);
    setCanopyWindowOpen(true);
    writeOpenWindowsManifest.mockClear();
    scheduleOpenWindowsSave();
    vi.runAllTimers();
    expect(lastWroteCanopyOpen()).toBe(true);
  });

  it("stays open in the quit's snapshot, whatever closes after it", () => {
    track([{ windowId: 1, projectId: "a" }]);
    setCanopyWindowOpen(true);
    writeOpenWindowsManifest.mockClear();
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });

    freezeAndSnapshotOpenWindows();
    setCanopyWindowOpen(false);
    saveOpenWindowsNow(1);

    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    expect(lastWroteCanopyOpen()).toBe(true);
  });

  it("is not saved by a recovery launch, which never writes", () => {
    track([{ windowId: 1, projectId: "a" }], true);
    setCanopyWindowOpen(true);
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it("waits out the restore fan-out, and lands with the save that ends it", () => {
    track([{ windowId: 1, projectId: "a" }]);
    suppressOpenWindowsSaves();
    setCanopyWindowOpen(true);
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
    resumeOpenWindowsSaves(true);
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
    expect(lastWroteCanopyOpen()).toBe(true);
  });

  it("leaves the stored manifest alone when the fan-out died partway", () => {
    track([{ windowId: 1, projectId: "a" }]);
    suppressOpenWindowsSaves();
    setCanopyWindowOpen(true);
    resumeOpenWindowsSaves(false);
    expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])(
    "is saved with no project window beside it on %s, where it keeps the app running",
    (value) => {
      Object.defineProperty(process, "platform", { value });
      track([{ windowId: 1, projectId: "a" }]);
      setCanopyWindowOpen(true);

      // The last project window closes while the Canopy window stays.
      saveOpenWindowsNow(1);
      expect(lastWritten()).toEqual([]);
      expect(lastWroteCanopyOpen()).toBe(true);
    }
  );

  it.each(["win32", "linux"])(
    "keeps it open on %s when it is the last window to close, since that close is the quit",
    (value) => {
      Object.defineProperty(process, "platform", { value });
      track([]);
      setCanopyWindowOpen(true);
      writeOpenWindowsManifest.mockClear();

      setCanopyWindowOpen(false);
      expect(writeOpenWindowsManifest).not.toHaveBeenCalled();
    }
  );

  it("is saved closed on darwin when it closes with no project window, as the app runs on", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    track([]);
    setCanopyWindowOpen(true);
    setCanopyWindowOpen(false);
    expect(lastWritten()).toEqual([]);
    expect(lastWroteCanopyOpen()).toBe(false);
  });
});

describe("background project capture (#12320)", () => {
  it("records a window's cached views, most-recently-used first", () => {
    const registry = makeRegistry([
      {
        windowId: 1,
        projectId: "active",
        views: [
          ["active", 500],
          ["older", 100],
          ["newer", 400],
        ],
      },
    ]);
    const records = buildOpenWindowRecords(registry);
    expect(records[0].backgroundProjectIds).toEqual(["newer", "older"]);
  });

  it("never lists the window's own active project as a background one", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "active", views: [["active", 900]] }]);
    expect(buildOpenWindowRecords(registry)[0]).toEqual({ projectId: "active" });
  });

  it("gives each project to exactly one window", () => {
    // Two views for the same workspace would cold-start two renderers on the
    // next launch, each burning a warm-cache slot.
    const registry = makeRegistry([
      { windowId: 1, projectId: "a", views: [["shared", 300]] },
      { windowId: 2, projectId: "b", views: [["shared", 900]] },
    ]);
    const records = buildOpenWindowRecords(registry);
    expect(records[0].backgroundProjectIds).toEqual(["shared"]);
    expect(records[1].backgroundProjectIds).toBeUndefined();
  });

  it("never reassigns a project that is another window's foreground", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a", views: [["b", 900]] },
      { windowId: 2, projectId: "b" },
    ]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toBeUndefined();
  });

  it("gives the primary window live workspaces no view holds", () => {
    // The case view-based capture cannot see: LRU eviction destroyed the
    // renderer while the project's agents kept running.
    const registry = makeRegistry([
      { windowId: 1, projectId: "a" },
      { windowId: 2, projectId: "b" },
    ]);
    const records = buildOpenWindowRecords(registry, undefined, new Set(["a", "b", "evicted"]));
    expect(records[0].backgroundProjectIds).toEqual(["evicted"]);
    expect(records[1].backgroundProjectIds).toBeUndefined();
  });

  it("does not duplicate a live workspace that already has a view somewhere", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [["warm", 100]] }]);
    const records = buildOpenWindowRecords(registry, undefined, new Set(["a", "warm"]));
    expect(records[0].backgroundProjectIds).toEqual(["warm"]);
  });

  it("keeps pending restores in the manifest while they are still booting", () => {
    // The startup save lands while the restore pass is mid-flight: those
    // projects have neither a view nor a live terminal yet, so without the
    // pending set the manifest would persist a fleet smaller than this launch
    // actually restored.
    const registry = makeRegistry([{ windowId: 1, projectId: "a" }]);
    setPendingBackgroundRestores(1, ["queued-1", "queued-2"]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([
      "queued-1",
      "queued-2",
    ]);
  });

  it("orders live views ahead of still-pending restores", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [["restored", 50]] }]);
    setPendingBackgroundRestores(1, ["pending"]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([
      "restored",
      "pending",
    ]);
  });

  it("drops pending intent once cleared", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a" }]);
    setPendingBackgroundRestores(1, ["queued"]);
    clearPendingBackgroundRestores(1);
    expect(buildOpenWindowRecords(registry)[0]).toEqual({ projectId: "a" });
  });

  it("caps a window's background list", () => {
    const views: Array<[string, number]> = Array.from(
      { length: MAX_BACKGROUND_PROJECTS_PER_WINDOW + 4 },
      (_v, i) => [`p${i}`, 1000 - i]
    );
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views }]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toHaveLength(
      MAX_BACKGROUND_PROJECTS_PER_WINDOW
    );
  });

  it("persists background ids through the debounced save", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [["warm", 10]] }]);
    initOpenWindowsTracker({
      registry,
      readOnly: false,
      liveWorkspaceIds: () => new Set(["a", "warm", "orphan"]),
    });
    scheduleOpenWindowsSave();
    vi.advanceTimersByTime(500);
    expect(lastWritten()[0].backgroundProjectIds).toEqual(["warm", "orphan"]);
  });

  it("falls back to view-only capture when the live-workspace source throws", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [["warm", 10]] }]);
    initOpenWindowsTracker({
      registry,
      readOnly: false,
      liveWorkspaceIds: () => {
        throw new Error("pty client disposing");
      },
    });
    saveOpenWindowsNow();
    expect(lastWritten()[0].backgroundProjectIds).toEqual(["warm"]);
  });
});

describe("background host projects (#13932)", () => {
  const host = (hostId: string, ch = "9") => `${hostId}:${ch.repeat(64)}`;

  it("keeps all of a window's local projects beside its host ones", () => {
    // The host views are the most recent: under one shared cap they used to
    // push out local projects that would have come back.
    const local: Array<[string, number]> = Array.from(
      { length: MAX_BACKGROUND_PROJECTS_PER_WINDOW },
      (_v, i) => [`p${i}`, 100 - i]
    );
    const remote: Array<[string, number]> = [
      [host("studio-01"), 300],
      [host("studio-02"), 200],
    ];
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [...remote, ...local] }]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([
      ...local.map(([id]) => id),
      host("studio-01"),
      host("studio-02"),
    ]);
  });

  it.each([
    ["first", [1, 2]],
    ["second", [2, 1]],
  ])(
    "leaves a waiting host project to the window holding its view, focused %s",
    (_label, order) => {
      // Window 1 never got to it; the person opened it in window 2 meanwhile.
      const wins: Record<number, FakeWindow> = {
        1: { windowId: 1, projectId: "a" },
        2: { windowId: 2, projectId: "b", views: [[host("studio-01"), 10]] },
      };
      addPendingRemoteBackgroundRestores(1, [host("studio-01")]);
      const records = buildOpenWindowRecords(makeRegistry(order.map((id) => wins[id]!)));
      expect(records.find((r) => r.projectId === "a")).toEqual({ projectId: "a" });
      expect(records.find((r) => r.projectId === "b")).toEqual({
        projectId: "b",
        backgroundProjectIds: [host("studio-01")],
      });
    }
  );

  it("keeps naming a window's waiting host projects until each is let go", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: "a", views: [["warm", 10]] }]);
    addPendingRemoteBackgroundRestores(1, [host("studio-01"), host("studio-02")]);
    addPendingRemoteBackgroundRestores(1, [host("studio-01")]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([
      "warm",
      host("studio-01"),
      host("studio-02"),
    ]);
    removePendingRemoteBackgroundRestores(1, (key) => key === host("studio-01"));
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([
      "warm",
      host("studio-02"),
    ]);
  });

  it.each([
    ["first", [1, 2]],
    ["second", [2, 1]],
  ])("keeps a waiting host project another window's cap left out, focused %s", (_label, order) => {
    const over = MAX_BACKGROUND_HOST_PROJECTS_PER_WINDOW + 1;
    const views: Array<[string, number]> = Array.from({ length: over }, (_v, i) => [
      host(`studio-${i}`),
      100 - i,
    ]);
    const oldest = views[over - 1]![0];
    const wins: Record<number, FakeWindow> = {
      1: { windowId: 1, projectId: "a" },
      2: { windowId: 2, projectId: "b", views },
    };
    addPendingRemoteBackgroundRestores(1, [oldest]);
    const records = buildOpenWindowRecords(makeRegistry(order.map((id) => wins[id]!)));
    expect(records.find((r) => r.projectId === "a")).toEqual({
      projectId: "a",
      backgroundProjectIds: [oldest],
    });
    expect(records.find((r) => r.projectId === "b")?.backgroundProjectIds).toEqual(
      views.slice(0, MAX_BACKGROUND_HOST_PROJECTS_PER_WINDOW).map(([id]) => id)
    );
  });

  it("never names a waiting host project twice once its view is back", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a", views: [[host("studio-01"), 10]] },
    ]);
    addPendingRemoteBackgroundRestores(1, [host("studio-01")]);
    expect(buildOpenWindowRecords(registry)[0].backgroundProjectIds).toEqual([host("studio-01")]);
  });

  it("stops naming a removed host's background projects, and only that host's", () => {
    const registry = makeRegistry([
      { windowId: 1, projectId: "a" },
      { windowId: 2, projectId: "b" },
    ]);
    addPendingRemoteBackgroundRestores(1, [host("studio-01"), host("studio-02")]);
    addPendingRemoteBackgroundRestores(2, [host("studio-01", "8")]);
    clearPendingRemoteRestoresForHost("studio-01");
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "a", backgroundProjectIds: [host("studio-02")] },
      { projectId: "b" },
    ]);
  });

  it("keeps waiting host projects in the quit's snapshot, while the local queue's go", () => {
    // A host that stayed unreachable all session still holds those projects
    // for the next launch; the local queue's unfinished work does not.
    initOpenWindowsTracker({
      registry: makeRegistry([{ windowId: 1, projectId: "a" }]),
      readOnly: false,
    });
    setPendingBackgroundRestores(1, ["queued"]);
    addPendingRemoteBackgroundRestores(1, [host("studio-01")]);
    clearPendingBackgroundRestores(1);
    getActiveShutdown.mockReturnValue({ initiator: "app-quit", phase: "cleaning" });
    freezeAndSnapshotOpenWindows();
    expect(lastWritten()).toEqual([{ projectId: "a", backgroundProjectIds: [host("studio-01")] }]);
  });
});
