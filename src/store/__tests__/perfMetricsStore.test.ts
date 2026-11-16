// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

import { filesClient } from "@/clients/filesClient";
import { ClientAppError } from "@/utils/clientAppError";
import {
  usePerfMetricsStore,
  resetPerfMetricsForTests,
  startLivePerfCapture,
  stopLivePerfCapture,
  type PerfMode,
} from "../perfMetricsStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";

const mockRead = filesClient.read as ReturnType<typeof vi.fn>;

function makeSummary(
  mode: PerfMode,
  aggregates: Array<{
    id: string;
    name: string;
    p95Ms: number;
    outsideReference: boolean;
    referenceNotes?: string;
  }>
) {
  return JSON.stringify({
    generatedAt: "2026-05-27T00:00:00.000Z",
    mode,
    nodeVersion: "v22.0.0",
    platform: "darwin",
    scenarioCount: aggregates.length,
    scenariosOutsideReference: aggregates.filter((a) => a.outsideReference).map((a) => a.id),
    aggregates: aggregates.map((a) => ({
      id: a.id,
      name: a.name,
      description: "",
      tier: "fast",
      runs: 5,
      p50Ms: a.p95Ms * 0.6,
      p95Ms: a.p95Ms,
      p99Ms: a.p95Ms * 1.1,
      maxMs: a.p95Ms * 1.2,
      meanMs: a.p95Ms * 0.7,
      stdDevMs: 1,
      metricAverages: {},
      outsideReference: a.outsideReference,
      referenceNotes: a.referenceNotes,
      notes: [],
    })),
  });
}

describe("perfMetricsStore refreshSummaries", () => {
  beforeEach(() => {
    mockRead.mockReset();
    resetPerfMetricsForTests();
  });

  afterEach(() => {
    resetPerfMetricsForTests();
  });

  it("reads all 4 mode files and flattens aggregates", async () => {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-smoke.summary.json")) {
        return {
          content: makeSummary("smoke", [
            { id: "boot", name: "Boot", p95Ms: 100, outsideReference: false },
          ]),
        };
      }
      if (path.endsWith("latest-ci.summary.json")) {
        return {
          content: makeSummary("ci", [
            {
              id: "boot",
              name: "Boot",
              p95Ms: 220,
              outsideReference: true,
              referenceNotes: "Over p95",
            },
            { id: "render", name: "Render", p95Ms: 30, outsideReference: false },
          ]),
        };
      }
      throw new ClientAppError("NOT_FOUND", "file missing");
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.length).toBe(3);
    expect(state.outsideReferenceCount).toBe(1);
    expect(state.isLoadingSummaries).toBe(false);
    expect(state.summaryLoadError).toBeNull();
    expect(state.lastLoadedAt).not.toBeNull();
    expect(mockRead).toHaveBeenCalledTimes(4);
  });

  it("silently skips missing files (NOT_FOUND)", async () => {
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.outsideReferenceCount).toBe(0);
    expect(state.summaryLoadError).toBeNull();
  });

  it("sets summaryLoadError when read fails with a non-NOT_FOUND code", async () => {
    mockRead.mockRejectedValue(new ClientAppError("PERMISSION", "no access"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryLoadError).not.toBeNull();
    expect(state.isLoadingSummaries).toBe(false);
  });

  it("replaces stale rows on repeated refresh", async () => {
    mockRead.mockResolvedValueOnce({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, outsideReference: true }]),
    });
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(1);

    mockRead.mockReset();
    mockRead.mockResolvedValueOnce({
      content: makeSummary("ci", [
        { id: "y", name: "Y", p95Ms: 50, outsideReference: false },
        { id: "z", name: "Z", p95Ms: 70, outsideReference: false },
      ]),
    });
    mockRead.mockRejectedValue(new ClientAppError("NOT_FOUND", "file missing"));

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.length).toBe(2);
    expect(state.summaryRows.map((r) => r.scenarioId).sort()).toEqual(["y", "z"]);
    expect(state.outsideReferenceCount).toBe(0);
  });

  it("ignores stale results when a newer refresh starts first", async () => {
    let resolveFirst!: (value: { content: string }) => void;
    const firstCall = new Promise<{ content: string }>((res) => {
      resolveFirst = res;
    });

    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);
    mockRead.mockReturnValueOnce(firstCall);

    const firstPromise = usePerfMetricsStore.getState().refreshSummaries("/project");

    mockRead.mockReset();
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "new", name: "New", p95Ms: 80, outsideReference: false }]),
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(4); // 4 mode reads × 1 row each

    resolveFirst({
      content: makeSummary("smoke", [
        { id: "stale", name: "Stale", p95Ms: 999, outsideReference: true },
      ]),
    });
    await firstPromise;

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows.some((r) => r.scenarioId === "stale")).toBe(false);
  });

  it("clearSummaries empties summary rows and resets count", async () => {
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, outsideReference: true }]),
    });
    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBe(4);

    usePerfMetricsStore.getState().clearSummaries();
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.outsideReferenceCount).toBe(0);
    expect(state.lastLoadedAt).toBeNull();
  });

  it("clearSummaries invalidates an in-flight refresh", async () => {
    let resolveFirst!: (value: { content: string }) => void;
    const firstCall = new Promise<{ content: string }>((res) => {
      resolveFirst = res;
    });
    mockRead.mockReturnValue(firstCall);

    const refreshPromise = usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().isLoadingSummaries).toBe(true);

    usePerfMetricsStore.getState().clearSummaries();
    expect(usePerfMetricsStore.getState().isLoadingSummaries).toBe(false);
    expect(usePerfMetricsStore.getState().summaryRows).toEqual([]);

    resolveFirst({
      content: makeSummary("ci", [
        { id: "stale", name: "Stale", p95Ms: 100, outsideReference: true },
      ]),
    });
    await refreshPromise;

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.outsideReferenceCount).toBe(0);
    expect(state.isLoadingSummaries).toBe(false);
  });

  it("rejects summaries with malformed aggregate fields", async () => {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-ci.summary.json")) {
        return {
          content: JSON.stringify({
            generatedAt: "2026-05-27T00:00:00.000Z",
            mode: "ci",
            aggregates: [{ id: "broken", name: "Broken", p95Ms: null, outsideReference: false }],
          }),
        };
      }
      throw new ClientAppError("NOT_FOUND", "file missing");
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.summaryLoadError).toBeNull();
  });

  it("normalizes mode to the filename mode even when summary.mode disagrees", async () => {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-ci.summary.json")) {
        return {
          content: JSON.stringify({
            generatedAt: "2026-05-27T00:00:00.000Z",
            mode: "smoke",
            aggregates: [
              {
                id: "boot",
                name: "Boot",
                p95Ms: 100,
                outsideReference: false,
              },
            ],
          }),
        };
      }
      throw new ClientAppError("NOT_FOUND", "file missing");
    });

    await usePerfMetricsStore.getState().refreshSummaries("/project");

    const rows = usePerfMetricsStore.getState().summaryRows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.mode).toBe("ci");
  });

  it("treats empty projectRoot as a clear", async () => {
    mockRead.mockResolvedValue({
      content: makeSummary("ci", [{ id: "x", name: "X", p95Ms: 100, outsideReference: true }]),
    });
    await usePerfMetricsStore.getState().refreshSummaries("/project");
    expect(usePerfMetricsStore.getState().summaryRows.length).toBeGreaterThan(0);

    await usePerfMetricsStore.getState().refreshSummaries("");
    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toEqual([]);
    expect(state.outsideReferenceCount).toBe(0);
    expect(mockRead).toHaveBeenCalledTimes(4);
  });
});

describe("perfMetricsStore wire-format compatibility", () => {
  beforeEach(() => {
    mockRead.mockReset();
    resetPerfMetricsForTests();
  });

  afterEach(() => {
    resetPerfMetricsForTests();
  });

  /** A summary carrying arbitrary aggregate keys, bypassing makeSummary's shape. */
  function rawSummary(aggregates: Array<Record<string, unknown>>) {
    return JSON.stringify({
      generatedAt: "2026-05-27T00:00:00.000Z",
      mode: "ci",
      nodeVersion: "v22.0.0",
      platform: "darwin",
      scenarioCount: aggregates.length,
      scenariosOutsideReference: [],
      aggregates,
    });
  }

  function onlyCi(content: string) {
    mockRead.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("latest-ci.summary.json")) return { content };
      // Must be a real ClientAppError: `refreshSummaries` swallows NOT_FOUND
      // only when `isClientAppError` recognises it, and rethrows anything else.
      throw new ClientAppError("NOT_FOUND", "file missing");
    });
  }

  it("reads a pre-rename summary file", async () => {
    // Summaries written before the harness stopped gating carry `failedBudget`
    // / `budgetReason`, and they live in `.tmp/perf-results`, which survives a
    // branch switch. Rejecting them would blank the Perf tab with no
    // explanation.
    onlyCi(
      rawSummary([{ id: "a", name: "A", p95Ms: 100, failedBudget: true, budgetReason: "slow" }])
    );

    await usePerfMetricsStore.getState().refreshSummaries("/repo");

    const state = usePerfMetricsStore.getState();
    expect(state.summaryRows).toHaveLength(1);
    expect(state.summaryRows[0]?.outsideReference).toBe(true);
    expect(state.summaryRows[0]?.referenceNotes).toBe("slow");
    expect(state.outsideReferenceCount).toBe(1);
  });

  it("reads a post-rename summary file", async () => {
    onlyCi(
      rawSummary([
        { id: "a", name: "A", p95Ms: 100, outsideReference: true, referenceNotes: "drift" },
      ])
    );

    await usePerfMetricsStore.getState().refreshSummaries("/repo");
    expect(usePerfMetricsStore.getState().summaryRows[0]?.referenceNotes).toBe("drift");
  });

  it("rejects a summary carrying BOTH spellings rather than picking a winner", async () => {
    // Both keys present means two writers disagreed. Silently preferring one
    // would surface a value nothing in the system actually asserted.
    onlyCi(
      rawSummary([{ id: "a", name: "A", p95Ms: 100, outsideReference: false, failedBudget: true }])
    );

    await usePerfMetricsStore.getState().refreshSummaries("/repo");
    expect(usePerfMetricsStore.getState().summaryRows).toHaveLength(0);
  });

  it("rejects a summary carrying neither spelling", async () => {
    onlyCi(rawSummary([{ id: "a", name: "A", p95Ms: 100 }]));

    await usePerfMetricsStore.getState().refreshSummaries("/repo");
    expect(usePerfMetricsStore.getState().summaryRows).toHaveLength(0);
  });

  it("rejects a malformed value under either spelling", async () => {
    onlyCi(rawSummary([{ id: "a", name: "A", p95Ms: 100, failedBudget: "yes" }]));

    await usePerfMetricsStore.getState().refreshSummaries("/repo");
    expect(usePerfMetricsStore.getState().summaryRows).toHaveLength(0);
  });
});

describe("perfMetricsStore live capture", () => {
  const originalElectron = window.electron;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let now: number;
  let cache: (() => void) | null;
  let warmActivate: (() => void) | null;

  beforeEach(() => {
    resetPerfMetricsForTests();
    __resetProjectViewCacheStateForTests();
    frames = new Map();
    nextFrameId = 0;
    now = 0;
    cache = null;
    warmActivate = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++nextFrameId, cb);
      return nextFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        app: {
          isViewCached: () => false,
          onViewCached: (callback: () => void) => {
            cache = callback;
            return () => {
              cache = null;
            };
          },
          onViewWarmActivated: (callback: () => void) => {
            warmActivate = callback;
            return () => {
              warmActivate = null;
            };
          },
          onViewRevealed: () => () => {},
        },
      },
    });
  });

  afterEach(() => {
    resetPerfMetricsForTests();
    __resetProjectViewCacheStateForTests();
    Reflect.deleteProperty(document, "hidden");
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: originalElectron,
    });
    vi.restoreAllMocks();
  });

  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((cb) => cb(now));
    }
  }

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  const state = () => usePerfMetricsStore.getState();

  it("reads the frame rate while the view can be seen", () => {
    startLivePerfCapture();
    runFrames(70);
    expect(state().fps).toBeGreaterThan(55);
    expect(state().isBackgrounded).toBe(false);
  });

  it("schedules no frames while the window is hidden, then reads afresh on return", () => {
    startLivePerfCapture();
    runFrames(70);
    expect(state().fps).not.toBeNull();

    setHidden(true);
    expect(frames.size).toBe(0);
    expect(state().isBackgrounded).toBe(true);
    expect(state().fps).toBeNull();

    // Five seconds pass unseen, partway into a bucket. A reading that spanned
    // them, or kept the frames counted before them, would be off the rate.
    now += 5000;
    setHidden(false);
    expect(frames.size).toBe(1);
    expect(state().isBackgrounded).toBe(false);
    runFrames(62);
    expect(state().fps).toBeNull();
    // 63 frames in 1008ms, counted from the resume alone.
    runFrames(1);
    expect(state().fps).toBe(Math.round((63 * 1000) / 1008));
  });

  // A store subscriber runs inside the frame that published to it, so it can
  // release, restart or hide the capture before that frame schedules the next.
  function onFirstReading(react: () => void) {
    let fired = false;
    return usePerfMetricsStore.subscribe((next) => {
      if (fired || next.fps === null) return;
      fired = true;
      react();
    });
  }

  it.each([
    { name: "releases the capture", react: () => stopLivePerfCapture(), pending: 0 },
    {
      name: "restarts the capture",
      react: () => {
        stopLivePerfCapture();
        startLivePerfCapture();
      },
      pending: 1,
    },
    { name: "hides the window", react: () => setHidden(true), pending: 0 },
  ])("keeps at most one loop when a subscriber $name mid-frame", ({ react, pending }) => {
    startLivePerfCapture();
    const off = onFirstReading(react);
    try {
      runFrames(63);
      expect(frames.size).toBe(pending);
    } finally {
      off();
    }
  });

  it("schedules nothing when a subscriber releases the capture as the view returns", () => {
    startLivePerfCapture();
    setHidden(true);
    const off = usePerfMetricsStore.subscribe((next, previous) => {
      if (previous.isBackgrounded && !next.isBackgrounded) stopLivePerfCapture();
    });
    try {
      setHidden(false);
      expect(frames.size).toBe(0);
    } finally {
      off();
    }
  });

  it("schedules no frames in a cached view, which still reports itself visible", () => {
    startLivePerfCapture();
    expect(frames.size).toBe(1);

    cache?.();
    expect(document.visibilityState).toBe("visible");
    expect(frames.size).toBe(0);
    expect(state().isBackgrounded).toBe(true);

    warmActivate?.();
    expect(frames.size).toBe(1);
    expect(state().isBackgrounded).toBe(false);
  });

  it("starts paused when capture begins in a hidden window", () => {
    setHidden(true);
    startLivePerfCapture();
    expect(frames.size).toBe(0);
    expect(state().isBackgrounded).toBe(true);

    setHidden(false);
    expect(frames.size).toBe(1);
  });

  it("runs one loop for overlapping captures and lets go only at the last release", () => {
    startLivePerfCapture();
    startLivePerfCapture();
    expect(frames.size).toBe(1);

    stopLivePerfCapture();
    runFrames(3);
    expect(frames.size).toBe(1);

    stopLivePerfCapture();
    expect(frames.size).toBe(0);
    // Released: a view that becomes visible again no longer restarts it.
    setHidden(true);
    setHidden(false);
    expect(frames.size).toBe(0);
  });
});
