import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PluginPanelLifecycleEvent } from "@shared/types/plugin";
import {
  clearViewRenderFailure,
  getPanelRemovedSignal,
  reportViewMounted,
  reportViewRenderFailed,
  resetPluginPanelLifecycleForTests,
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
