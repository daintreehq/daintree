import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PluginPanelLifecycleEvent } from "@shared/types/plugin";
import {
  VIEW_RELOAD_LIMIT,
  VIEW_RELOAD_WINDOW_MS,
  admitViewReload,
  clearViewRenderFailure,
  getPanelRemovedSignal,
  hasViewUnsavedChanges,
  isViewReloadBlocked,
  registerUserViewReload,
  reportViewMounted,
  reportViewRenderFailed,
  resetPluginPanelLifecycleForTests,
  resetViewReloadBudget,
  requestUserViewReload,
  setViewUnsavedChanges,
  syncPluginPanels,
  type PluginPanelSnapshotEntry,
} from "@/services/plugin/pluginPanelLifecycle";

const IDENTITY = { kindId: "acme.dash", pluginId: "acme" };

function panel(overrides: Partial<PluginPanelSnapshotEntry> = {}): PluginPanelSnapshotEntry {
  return { panelId: "p1", kindId: "acme.dash", pluginId: "acme", location: "grid", ...overrides };
}

let report: ReturnType<typeof vi.fn<(events: PluginPanelLifecycleEvent[]) => Promise<void>>>;

/** Drain the microtask-coalesced flush and return every phase reported so far. */
async function drainPhases(): Promise<string[]> {
  await Promise.resolve();
  return report.mock.calls.flatMap(([events]) => events.map((e) => e.phase));
}

beforeEach(() => {
  resetPluginPanelLifecycleForTests();
  report = vi.fn<(events: PluginPanelLifecycleEvent[]) => Promise<void>>(() => Promise.resolve());
  vi.stubGlobal("window", { electron: { plugin: { reportPanelLifecycle: report } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPluginPanelLifecycleForTests();
});

describe("panelRemovedSignal identity", () => {
  it("hands every mount of one panel the same signal object", () => {
    const first = getPanelRemovedSignal("p1");
    const second = getPanelRemovedSignal("p1");
    expect(second).toBe(first);
    expect(getPanelRemovedSignal("p2")).not.toBe(first);
  });

  it("survives a temporary unmount while the panel record stays live", async () => {
    const signal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()]);
    const release = reportViewMounted("p1", IDENTITY);

    // Maximizing a sibling pane unmounts the subtree — the exact case that used
    // to abort the one-and-only dispose signal.
    release();
    syncPluginPanels([panel()]);

    expect(signal.aborted).toBe(false);
    // The panel is known before any view commits, so it opens at `hidden`.
    expect(await drainPhases()).toEqual(["hidden", "mounted", "hidden"]);
  });

  it("survives trash and restore, and aborts only on permanent removal", async () => {
    const signal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()]);

    syncPluginPanels([panel({ location: "trash" })]);
    expect(signal.aborted).toBe(false);

    syncPluginPanels([panel({ location: "grid" })]);
    expect(signal.aborted).toBe(false);

    syncPluginPanels([]);
    expect(signal.aborted).toBe(true);
    expect(await drainPhases()).toEqual(["hidden", "trashed", "restored", "hidden", "removed"]);
  });

  it("aborts synchronously, before the coalesced report is flushed", () => {
    const signal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()]);
    syncPluginPanels([]);
    // Cleanup tied to the signal must run in the same tick as the store
    // mutation, not one microtask later behind an IPC round trip.
    expect(signal.aborted).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("phase derivation", () => {
  it("reports mounted only once a view commits, and hidden when none is live", async () => {
    syncPluginPanels([panel()]);
    const release = reportViewMounted("p1", IDENTITY);
    release();
    expect(await drainPhases()).toEqual(["hidden", "mounted", "hidden"]);
  });

  it("ranks record state above view state — a trashed panel with a live view is trashed", async () => {
    syncPluginPanels([panel()]);
    reportViewMounted("p1", IDENTITY);
    syncPluginPanels([panel({ location: "trash" })]);
    expect(await drainPhases()).toEqual(["hidden", "mounted", "trashed"]);
  });

  it("reports background location as backgrounded rather than hidden", async () => {
    syncPluginPanels([panel({ location: "background" })]);
    expect(await drainPhases()).toEqual(["backgrounded"]);
  });

  it("emits restored as an edge, then the phase the panel actually landed in", async () => {
    syncPluginPanels([panel({ location: "trash" })]);
    reportViewMounted("p1", IDENTITY);
    syncPluginPanels([panel({ location: "grid" })]);
    expect(await drainPhases()).toEqual(["trashed", "restored", "mounted"]);
  });

  it("does not re-emit a phase that did not change", async () => {
    syncPluginPanels([panel()]);
    syncPluginPanels([panel()]);
    syncPluginPanels([panel()]);
    expect(await drainPhases()).toEqual(["hidden"]);
  });
});

describe("mount tokens", () => {
  it("ignores a stale unmount from a superseded view attempt", async () => {
    syncPluginPanels([panel()]);
    const releaseOld = reportViewMounted("p1", IDENTITY);
    reportViewMounted("p1", IDENTITY);

    // React runs the OLD effect's cleanup after the NEW effect has committed
    // (StrictMode, a generation swap). A boolean `mounted` flag would report the
    // live view as hidden here.
    releaseOld();

    expect(await drainPhases()).toEqual(["hidden", "mounted"]);
  });

  it("is idempotent — calling one release twice does not double-drop", async () => {
    syncPluginPanels([panel()]);
    const release = reportViewMounted("p1", IDENTITY);
    reportViewMounted("p1", IDENTITY);
    release();
    release();
    expect(await drainPhases()).toEqual(["hidden", "mounted"]);
  });
});

describe("render failure", () => {
  it("reports render-failed and clears it on retry", async () => {
    syncPluginPanels([panel()]);
    reportViewRenderFailed("p1", IDENTITY);
    clearViewRenderFailure("p1");
    expect(await drainPhases()).toEqual(["hidden", "render-failed", "hidden"]);
  });

  it("clears the failure when a later attempt commits", async () => {
    syncPluginPanels([panel()]);
    reportViewRenderFailed("p1", IDENTITY);
    reportViewMounted("p1", IDENTITY);
    expect(await drainPhases()).toEqual(["hidden", "render-failed", "mounted"]);
  });

  it("does not mask a trashed panel", async () => {
    syncPluginPanels([panel({ location: "trash" })]);
    reportViewRenderFailed("p1", IDENTITY);
    expect(await drainPhases()).toEqual(["trashed"]);
  });
});

describe("reporting", () => {
  it("coalesces a burst of transitions into a single IPC call", async () => {
    syncPluginPanels([panel({ panelId: "a" }), panel({ panelId: "b" }), panel({ panelId: "c" })]);
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0].map((e) => e.panelId)).toEqual(["a", "b", "c"]);
  });

  it("carries plugin identity on every event", async () => {
    syncPluginPanels([panel()]);
    await Promise.resolve();
    expect(report.mock.calls[0]?.[0][0]).toMatchObject({
      panelId: "p1",
      panelKindId: "acme.dash",
      pluginId: "acme",
    });
  });

  it("stops tracking a removed panel so a reused id starts clean", async () => {
    const firstSignal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()]);
    syncPluginPanels([]);
    await Promise.resolve();

    const secondSignal = getPanelRemovedSignal("p1");
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
  });

  it("does not report removed while a plugin upgrade unregisters its kinds", async () => {
    const signal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()], new Set(["p1"]));
    reportViewMounted("p1", IDENTITY);

    // Mid-upgrade: `unregisterPluginPanelKinds` has run, so the panel's kind no
    // longer resolves to a plugin — but the panel record is untouched.
    syncPluginPanels([], new Set(["p1"]));
    expect(signal.aborted).toBe(false);

    // Kinds re-register with the new generation; the panel was never gone.
    syncPluginPanels([panel()], new Set(["p1"]));
    expect(signal.aborted).toBe(false);
    expect(await drainPhases()).toEqual(["hidden", "mounted"]);
  });

  it("still reports removed once the panel record itself is gone", async () => {
    const signal = getPanelRemovedSignal("p1");
    syncPluginPanels([panel()], new Set(["p1"]));
    syncPluginPanels([], new Set());
    expect(signal.aborted).toBe(true);
    expect(await drainPhases()).toEqual(["hidden", "removed"]);
  });

  it("survives a rejected report without throwing", async () => {
    report.mockRejectedValueOnce(new Error("bridge down"));
    expect(() => syncPluginPanels([panel()])).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does not throw when no bridge is present", async () => {
    vi.stubGlobal("window", {});
    expect(() => syncPluginPanels([panel()])).not.toThrow();
    await Promise.resolve();
  });
});

describe("view reload budget (#12609)", () => {
  const LIMIT = VIEW_RELOAD_LIMIT;
  const WINDOW = VIEW_RELOAD_WINDOW_MS;
  /** Spacing that fits the whole budget comfortably inside one window. */
  const STEP = WINDOW / (LIMIT + 2);

  /** Request `count` reloads for `panelId`, {@link STEP} apart from `start`. */
  function admitMany(panelId: string, count: number, start = 0): string[] {
    return Array.from({ length: count }, (_, i) => admitViewReload(panelId, start + i * STEP));
  }

  it("accepts the budget inside one window and blocks the request after it", () => {
    syncPluginPanels([panel()]);
    const outcomes = admitMany("p1", LIMIT + 1);
    expect(outcomes.slice(0, LIMIT).every((outcome) => outcome === "accepted")).toBe(true);
    expect(outcomes[LIMIT]).toBe("blocked");
    expect(isViewReloadBlocked("p1")).toBe(true);
  });

  it("rolls the window rather than resetting it on a fixed schedule", () => {
    syncPluginPanels([panel()]);
    admitMany("p1", LIMIT);
    // Exactly one reload — the first, at 0 — has aged out, so exactly one more
    // fits; the rest of the budget is still inside the window.
    expect(admitViewReload("p1", WINDOW)).toBe("accepted");
    expect(admitViewReload("p1", WINDOW + 1)).toBe("blocked");
  });

  it("keeps a block after the window expires", () => {
    syncPluginPanels([panel()]);
    admitMany("p1", LIMIT + 1);
    // Long after every recorded reload aged out: the block is one-way.
    expect(admitViewReload("p1", 10 * WINDOW)).toBe("blocked");
    expect(isViewReloadBlocked("p1")).toBe(true);
  });

  it("lifts the block and starts the budget over when the user reloads", () => {
    syncPluginPanels([panel()]);
    admitMany("p1", LIMIT + 1);
    resetViewReloadBudget("p1");
    expect(isViewReloadBlocked("p1")).toBe(false);
    // A full budget, not whatever was left of the old window.
    const outcomes = admitMany("p1", LIMIT + 1, LIMIT * STEP);
    expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(LIMIT);
    expect(outcomes[LIMIT]).toBe("blocked");
  });

  it("charges each panel separately", () => {
    syncPluginPanels([panel({ panelId: "a" }), panel({ panelId: "b" })]);
    admitMany("a", LIMIT + 1);
    expect(isViewReloadBlocked("a")).toBe(true);
    expect(admitViewReload("b", 0)).toBe("accepted");
    expect(isViewReloadBlocked("b")).toBe(false);
  });

  it("reports a blocked panel as render-failed, even with a view mounted, until reset", async () => {
    syncPluginPanels([panel()]);
    const release = reportViewMounted("p1", IDENTITY);
    admitMany("p1", LIMIT + 1);
    // The view's unmount lands after the block; it must not surface as hidden.
    release();
    // A later commit clears `renderFailed`, but not the block.
    reportViewMounted("p1", IDENTITY);
    resetViewReloadBudget("p1");
    expect(await drainPhases()).toEqual(["hidden", "mounted", "render-failed", "mounted"]);
  });

  it("keeps its history across a temporary unmount and a trash round trip", () => {
    syncPluginPanels([panel()]);
    const release = reportViewMounted("p1", IDENTITY);
    admitMany("p1", LIMIT);
    release();
    syncPluginPanels([panel({ location: "trash" })]);
    syncPluginPanels([panel()]);
    expect(admitViewReload("p1", LIMIT * STEP)).toBe("blocked");
  });

  it("refuses a panel it does not track, without starting to track it", async () => {
    expect(admitViewReload("ghost", 0)).toBe("refused");
    expect(isViewReloadBlocked("ghost")).toBe(false);
    resetViewReloadBudget("ghost");
    // A tracked id missing from the store is swept as removed, so a reconcile
    // is what would expose one of these calls having registered it.
    syncPluginPanels([]);
    expect(await drainPhases()).toEqual([]);
  });

  it("refuses a removed panel and gives a reused id a fresh budget", async () => {
    syncPluginPanels([panel()]);
    admitMany("p1", LIMIT + 1);
    syncPluginPanels([]);
    expect(admitViewReload("p1", WINDOW)).toBe("refused");
    await Promise.resolve();

    syncPluginPanels([panel()]);
    expect(isViewReloadBlocked("p1")).toBe(false);
    expect(admitViewReload("p1", WINDOW)).toBe("accepted");
  });
});

describe("the user's reload (#12611)", () => {
  it("hands it to the newest mounted host and reports that one took it", () => {
    const older = vi.fn();
    const newer = vi.fn();
    registerUserViewReload("p1", older);
    registerUserViewReload("p1", newer);

    expect(requestUserViewReload("p1")).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it("falls back to the remaining host when the newest unregisters", () => {
    const older = vi.fn();
    registerUserViewReload("p1", older);
    const release = registerUserViewReload("p1", vi.fn());
    release();

    expect(requestUserViewReload("p1")).toBe(true);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it("releases only its own registration, even when called twice", () => {
    const kept = vi.fn();
    const release = registerUserViewReload("p1", vi.fn());
    registerUserViewReload("p1", kept);
    release();
    release();

    requestUserViewReload("p1");
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("lifts a block when no view is mounted, so the next mount starts fresh", () => {
    syncPluginPanels([panel()]);
    for (let i = 0; i <= VIEW_RELOAD_LIMIT; i += 1) admitViewReload("p1", i);
    expect(isViewReloadBlocked("p1")).toBe(true);

    expect(requestUserViewReload("p1")).toBe(false);
    expect(isViewReloadBlocked("p1")).toBe(false);
  });
});

describe("unsaved changes (#12611)", () => {
  it("is raised and lowered by the attempt that owns it", () => {
    const owner = {};
    expect(hasViewUnsavedChanges("p1")).toBe(false);
    setViewUnsavedChanges("p1", owner, true);
    expect(hasViewUnsavedChanges("p1")).toBe(true);
    setViewUnsavedChanges("p1", owner, false);
    expect(hasViewUnsavedChanges("p1")).toBe(false);
  });

  it("cannot be lowered by a stale attempt's token", () => {
    const stale = {};
    const current = {};
    setViewUnsavedChanges("p1", stale, true);
    setViewUnsavedChanges("p1", current, true);
    setViewUnsavedChanges("p1", stale, false);

    expect(hasViewUnsavedChanges("p1")).toBe(true);
  });

  it("stays raised while an overlapping host still holds unsaved work", () => {
    const leaving = {};
    const staying = {};
    setViewUnsavedChanges("p1", staying, true);
    setViewUnsavedChanges("p1", leaving, true);
    setViewUnsavedChanges("p1", leaving, false);

    expect(hasViewUnsavedChanges("p1")).toBe(true);
    setViewUnsavedChanges("p1", staying, false);
    expect(hasViewUnsavedChanges("p1")).toBe(false);
  });

  it("is per panel", () => {
    setViewUnsavedChanges("p1", {}, true);
    expect(hasViewUnsavedChanges("p2")).toBe(false);
  });

  it("goes with the panel when it is removed", () => {
    syncPluginPanels([panel()]);
    setViewUnsavedChanges("p1", {}, true);
    syncPluginPanels([], new Set());

    expect(hasViewUnsavedChanges("p1")).toBe(false);
  });
});
