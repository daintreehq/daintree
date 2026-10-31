import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenWindowRecord } from "../../services/persistence/windowManifest.js";

const writeOpenWindowsManifest = vi.fn<(records: OpenWindowRecord[]) => void>();
const getActiveShutdown = vi.fn<() => { initiator: string; phase: string } | null>(() => null);

// Both mocks use explicit factories rather than spreading `importOriginal()`:
// the store module reaches better-sqlite3 and shutdownCoordinator reaches
// electron, and pulling either in for real turns this into a suite that passes
// locally and fails on CI. windowManifest.js itself is dependency-free, so the
// constants below come from the real module.
vi.mock("../../services/persistence/windowManifestStore.js", () => ({
  writeOpenWindowsManifest: (records: OpenWindowRecord[]) => writeOpenWindowsManifest(records),
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
  enableOpenWindowsSaves,
  freezeAndSnapshotOpenWindows,
  initOpenWindowsTracker,
  onPendingRemoteRestoreChanged,
  removePendingRemoteBackgroundRestores,
  resetOpenWindowsTrackerForTests,
  resumeOpenWindowsSaves,
  saveOpenWindowsNow,
  scheduleOpenWindowsSave,
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

  it("records a window with no project as a picker window", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: null }]);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: null }]);
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
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: null }]);
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
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: null },
      { projectId: null },
      { projectId: `studio-2:${"a".repeat(64)}` },
    ]);
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

  it("keeps a window whose manager throws, as a picker window", () => {
    // Losing which project it was on beats losing the window entirely.
    const registry = makeRegistry([
      { windowId: 1, projectId: "a" },
      { windowId: 2, projectId: "b", throwsOnRead: true },
    ]);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "a" }, { projectId: null }]);
  });

  it("keeps a window whose manager is not built yet", () => {
    const registry = makeRegistry([{ windowId: 1, projectId: null, noManager: true }]);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: null }]);
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
      { windowId: 2, projectId: "b", views: [["b", 2], ["c", 1]] },
    ]);
    setPendingBackgroundRestores(2, ["a", "d"]);
    initOpenWindowsTracker({
      registry,
      readOnly: false,
      liveWorkspaceIds: () => new Set(["orphan"]),
    });

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

    win.projectId = "b";
    win.views = [["b", 1]];
    expect(buildOpenWindowRecords(registry)).toEqual([
      { projectId: "b", backgroundProjectIds: ["c"] },
    ]);

    clearPendingWindowRecreation(5);
    expect(buildOpenWindowRecords(registry)).toEqual([{ projectId: "b" }]);
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
