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
  buildOpenWindowRecords,
  freezeAndSnapshotOpenWindows,
  initOpenWindowsTracker,
  resetOpenWindowsTrackerForTests,
  resumeOpenWindowsSaves,
  saveOpenWindowsNow,
  scheduleOpenWindowsSave,
  suppressOpenWindowsSaves,
} from "../openWindowsTracker.js";
import { MAX_RESTORED_WINDOWS } from "../../services/persistence/windowManifest.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";

interface FakeWindow {
  windowId: number;
  projectId: string | null;
  destroyed?: boolean;
  throwsOnRead?: boolean;
  noManager?: boolean;
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

  it("still writes nothing after a window closes", () => {
    saveOpenWindowsNow(1);
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

  it("writes immediately, without waiting on the debounce", () => {
    saveOpenWindowsNow();
    expect(writeOpenWindowsManifest).toHaveBeenCalledTimes(1);
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
