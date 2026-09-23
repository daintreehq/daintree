// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WhySlowContent, describeSlowdowns, isAllClear } from "../WhySlowContent";
import type { WhySlowSnapshot } from "@shared/types/whySlow";

const getWhySlowSnapshot = vi.fn();
vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    getWhySlowSnapshot: (...args: unknown[]) => getWhySlowSnapshot(...args),
  },
}));

const logError = vi.fn();
vi.mock("@/utils/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));

const quietRenderer: WhySlowSnapshot["rendererTerminals"] = [
  {
    webContentsId: 1,
    webglMode: "webgl",
    wantsWebgl: 2,
    terminalCount: 2,
    countsByTier: { VISIBLE: 2 },
    timestamp: 1,
    ageMs: 500,
    stale: false,
  },
];

const quietMemory: WhySlowSnapshot["memory"] = {
  appMemoryMb: 400,
  terminalWorkloads: {
    available: true,
    stale: false,
    ageMs: 1000,
    totalMemoryMb: 800,
    processCount: 10,
    terminalCount: 3,
    topProjects: [],
  },
};

function makeSnapshot(overrides?: Partial<WhySlowSnapshot>): WhySlowSnapshot {
  return {
    timestamp: 1,
    resource: null,
    focusThrottle: { throttled: false, pollMultiplier: 1 },
    rendererTerminals: [],
    pty: null,
    worktrees: null,
    workers: null,
    memory: null,
    ...overrides,
  };
}

function makeQuietResource(): NonNullable<WhySlowSnapshot["resource"]> {
  return {
    currentProfile: "performance",
    targetProfile: "performance",
    pressureScore: 0,
    reasons: [],
    lagPressureActive: false,
    lagEscalatedActive: false,
    thermalState: "nominal",
    isOnBattery: false,
    speedLimit: 100,
  };
}

function makeQuietPty(): NonNullable<WhySlowSnapshot["pty"]> {
  return {
    totalPendingBytes: 0,
    terminalCount: 2,
    pausedCount: 0,
    memoryPausedCount: 0,
    suspendedCount: 0,
    maxPausedDurationMs: 0,
    eventLoopP99Ms: 3,
    eventLoopMaxMs: 6,
    eventLoopUtilization: 0.1,
  };
}

const quietWorktrees: NonNullable<WhySlowSnapshot["worktrees"]> = {
  monitorCount: 3,
  fetchInFlightCount: 0,
};

describe("WhySlowContent", () => {
  beforeEach(() => {
    getWhySlowSnapshot.mockReset();
    logError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates renderer samples across views into a mixed WebGL mode", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        rendererTerminals: [
          {
            webContentsId: 1,
            webglMode: "webgl",
            wantsWebgl: 2,
            terminalCount: 3,
            countsByTier: { FOCUSED: 1, BACKGROUND: 2 },
            timestamp: 0,
            ageMs: 0,
            stale: false,
          },
          {
            webContentsId: 2,
            webglMode: "dom",
            wantsWebgl: 1,
            terminalCount: 4,
            countsByTier: { FOCUSED: 1, BACKGROUND: 3 },
            timestamp: 0,
            ageMs: 0,
            stale: false,
          },
        ],
      })
    );

    render(<WhySlowContent />);

    // One webgl + one dom view → mixed; counts sum across views.
    expect(await screen.findByText("Partly GPU")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy(); // summed terminalCount
    expect(screen.getByText("FOCUSED: 2")).toBeTruthy(); // summed tier bucket
    expect(screen.getByText("BACKGROUND: 5")).toBeTruthy();
  });

  it("renders the worker queue depth and degraded-subsystem badges", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        workers: {
          subsystemCount: 5,
          aliveWorkerCount: 4,
          totalQueueDepth: 3,
          degraded: ["copytree-worker:/proj", "analysis-worker-1"],
        },
      })
    );

    render(<WhySlowContent />);

    expect(await screen.findByText("Queued jobs")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("degraded: copytree-worker:/proj")).toBeTruthy();
    expect(screen.getByText("degraded: analysis-worker-1")).toBeTruthy();
  });

  it("renders a dash for the worker queue when the summary is unavailable", async () => {
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot({ workers: null }));

    render(<WhySlowContent />);

    expect(await screen.findByText("Queued jobs")).toBeTruthy();
    expect(screen.queryByText(/^degraded:/)).toBeNull();
  });

  it("renders the app vs terminal-workload memory split", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        memory: {
          appMemoryMb: 512,
          terminalWorkloads: {
            available: true,
            stale: false,
            ageMs: 2_000,
            totalMemoryMb: 2048,
            processCount: 12,
            terminalCount: 4,
            topProjects: [],
          },
        },
      })
    );

    render(<WhySlowContent />);

    expect(await screen.findByText("Terminal workloads")).toBeTruthy();
    expect(screen.getByText("512")).toBeTruthy(); // Daintree app MB
    expect(screen.getByText("2048")).toBeTruthy(); // workload MB
    expect(screen.getByText("12")).toBeTruthy(); // workload processes
    expect(screen.queryByText("process table unavailable")).toBeNull();
    expect(screen.queryByText("workload sample stale")).toBeNull();
  });

  it("flags unavailable and stale workload samples without hiding last-good totals", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        memory: {
          appMemoryMb: null,
          terminalWorkloads: {
            available: false,
            stale: true,
            ageMs: 90_000,
            totalMemoryMb: 3100,
            processCount: 9,
            terminalCount: 3,
            topProjects: [],
          },
        },
      })
    );

    render(<WhySlowContent />);

    expect(await screen.findByText("process table unavailable")).toBeTruthy();
    expect(screen.getByText("workload sample stale")).toBeTruthy();
    // The last-good total still shows, flagged rather than zeroed.
    expect(screen.getByText("3100")).toBeTruthy();
  });

  it("renders dashes, not zeros, when workloads were never sampled", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        memory: {
          appMemoryMb: 512,
          terminalWorkloads: {
            available: false,
            stale: false,
            ageMs: null,
            totalMemoryMb: 0,
            processCount: 0,
            terminalCount: 0,
            topProjects: [],
          },
        },
      })
    );

    render(<WhySlowContent />);

    expect(await screen.findByText("process table unavailable")).toBeTruthy();
    // A never-sampled slice must not imply a measured empty workload.
    expect(screen.queryByText("0")).toBeNull();
  });

  it("degrades the memory section when collection failed", async () => {
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot());

    render(<WhySlowContent />);

    expect(await screen.findByText("Memory breakdown unavailable")).toBeTruthy();
  });

  it("does not start overlapping refreshes while one is in flight", async () => {
    vi.useFakeTimers();
    // A never-resolving snapshot keeps the initial fetch in flight.
    getWhySlowSnapshot.mockReturnValue(new Promise<WhySlowSnapshot>(() => {}));

    render(<WhySlowContent />);
    expect(getWhySlowSnapshot).toHaveBeenCalledTimes(1);

    // The poll interval fires but the in-flight guard suppresses a second call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(getWhySlowSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not log or throw when a fetch resolves after unmount", async () => {
    let resolveFetch: (value: WhySlowSnapshot) => void = () => {};
    getWhySlowSnapshot.mockReturnValue(
      new Promise<WhySlowSnapshot>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { unmount } = render(<WhySlowContent />);
    unmount();

    await act(async () => {
      resolveFetch(makeSnapshot());
      await Promise.resolve();
    });

    expect(logError).not.toHaveBeenCalled();
  });

  it("marks the snapshot stale when a refresh fails, and recovers on the next success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    getWhySlowSnapshot.mockResolvedValueOnce(makeSnapshot({ timestamp: 60_000 }));

    render(<WhySlowContent />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("why-slow-updated-note").textContent).toBe("Updated just now");

    // Poll ticks fail → the old snapshot stays visible but is flagged stale.
    getWhySlowSnapshot.mockRejectedValue(new Error("collector down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId("why-slow-stale-note").textContent).toBe(
      "Refresh failed · data from 15s ago"
    );
    expect(screen.queryByTestId("why-slow-updated-note")).toBeNull();

    // The poll keeps retrying; the next success clears the stale note.
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot({ timestamp: 80_000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByTestId("why-slow-stale-note")).toBeNull();
    expect(screen.getByTestId("why-slow-updated-note")).toBeTruthy();
  });

  it("logs only the first failure of a streak, then again after recovery", async () => {
    vi.useFakeTimers();
    getWhySlowSnapshot.mockRejectedValue(new Error("collector down"));

    render(<WhySlowContent />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(logError).toHaveBeenCalledTimes(1);

    // Repeated failing poll ticks stay silent — no error loop in the log.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(logError).toHaveBeenCalledTimes(1);

    // Success resets the streak; a fresh outage logs once more.
    getWhySlowSnapshot.mockResolvedValueOnce(makeSnapshot());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    getWhySlowSnapshot.mockRejectedValue(new Error("down again"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("lists pressure reasons bottleneck-first, keeping collector order for ties", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: {
          currentProfile: "efficiency",
          targetProfile: "efficiency",
          pressureScore: 5,
          reasons: [
            { signal: "memory", contribution: 1, detail: "app memory 2.1 GB" },
            { signal: "fleetSize", contribution: 3, detail: "24 active agents" },
            { signal: "systemMemory", contribution: 1, detail: "system memory low" },
          ],
          lagPressureActive: false,
          lagEscalatedActive: false,
          thermalState: "nominal",
          isOnBattery: false,
          speedLimit: 100,
        },
      })
    );

    render(<WhySlowContent />);

    const list = await screen.findByRole("list", { name: "Pressure contributions" });
    const texts = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    // fleetSize (+3) leads despite the collector emitting memory (+1) first;
    // the tied +1 reasons keep their collector order (stable sort).
    expect(texts[0]).toContain("24 active agents");
    expect(texts[1]).toContain("app memory 2.1 GB");
    expect(texts[2]).toContain("system memory low");
  });

  it("shows the all-clear line only when every section is present and quiet", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: quietMemory,
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);

    expect(await screen.findByTestId("why-slow-all-clear")).toBeTruthy();
  });

  it("qualifies a quiet verdict when a reading is missing instead of claiming all clear", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: null,
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);

    expect(
      await screen.findByText("No slowdowns found, but some readings are unavailable")
    ).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("treats an unreadable app-memory sweep as a missing reading", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: { ...quietMemory!, appMemoryMb: null },
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);

    expect(
      await screen.findByText("No slowdowns found, but some readings are unavailable")
    ).toBeTruthy();
  });

  it("does not claim all-clear when the resource section degraded to null", async () => {
    // Partial payload: resource section missing — "unknown" must not read as healthy.
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot({ pty: makeQuietPty() }));

    render(<WhySlowContent />);

    expect(await screen.findByText("Resource mode unavailable")).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("does not claim all-clear when the pty section degraded to null", async () => {
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot({ resource: makeQuietResource() }));

    render(<WhySlowContent />);

    await screen.findByText("Resource mode");
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("does not claim all-clear when a warn tone is visible (focus throttle, pty lag)", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: quietMemory,
        rendererTerminals: quietRenderer,
        focusThrottle: { throttled: true, pollMultiplier: 4 },
      })
    );

    const { unmount } = render(<WhySlowContent />);
    expect(await screen.findByText(/background checks run 4× less often/)).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
    unmount();

    // PTY host lag above the warn threshold vetoes all-clear on its own.
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: { ...makeQuietPty(), eventLoopP99Ms: 80 },
        worktrees: quietWorktrees,
        memory: quietMemory,
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);
    expect(await screen.findByText(/terminal host is busy: 80ms/)).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("hides the all-clear line while a refresh is failing", async () => {
    vi.useFakeTimers();
    getWhySlowSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        memory: quietMemory,
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("why-slow-all-clear")).toBeTruthy();

    // The snapshot on screen still says all-clear, but it is stale now — the
    // calm line must not present old data as "right now" next to the stale note.
    getWhySlowSnapshot.mockRejectedValue(new Error("collector down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId("why-slow-stale-note")).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("never claims all-clear while a reading is flagged, and every flag has a finding", () => {
    const quiet = makeSnapshot({
      resource: {
        currentProfile: "performance",
        targetProfile: "performance",
        pressureScore: 0,
        reasons: [],
        lagPressureActive: false,
        lagEscalatedActive: false,
        thermalState: "nominal",
        isOnBattery: false,
        speedLimit: 100,
      },
      pty: {
        totalPendingBytes: 0,
        terminalCount: 1,
        pausedCount: 0,
        memoryPausedCount: 0,
        suspendedCount: 0,
        maxPausedDurationMs: 0,
        eventLoopP99Ms: 5,
        eventLoopMaxMs: 8,
        eventLoopUtilization: 0.1,
      },
      worktrees: { monitorCount: 2, fetchInFlightCount: 0 },
      workers: { subsystemCount: 2, aliveWorkerCount: 2, totalQueueDepth: 0, degraded: [] },
    });
    expect(isAllClear(quiet)).toBe(true);
    expect(describeSlowdowns(quiet)).toEqual([]);

    const flagged: WhySlowSnapshot[] = [
      { ...quiet, workers: { ...quiet.workers!, totalQueueDepth: 4 } },
      { ...quiet, workers: { ...quiet.workers!, degraded: ["file-search"] } },
      { ...quiet, worktrees: { monitorCount: 2, fetchInFlightCount: 1 } },
      { ...quiet, focusThrottle: { throttled: true, pollMultiplier: 4 } },
      { ...quiet, pty: { ...quiet.pty!, pausedCount: 2, totalPendingBytes: 2048 } },
      { ...quiet, pty: { ...quiet.pty!, eventLoopP99Ms: 120 } },
      { ...quiet, resource: { ...quiet.resource!, isOnBattery: true } },
      { ...quiet, resource: { ...quiet.resource!, currentProfile: "balanced" } },
    ];
    for (const snapshot of flagged) {
      expect(isAllClear(snapshot)).toBe(false);
      expect(describeSlowdowns(snapshot).length).toBeGreaterThan(0);
    }
  });

  it("puts alert findings ahead of warnings", () => {
    const findings = describeSlowdowns(
      makeSnapshot({
        focusThrottle: { throttled: true, pollMultiplier: 4 },
        resource: {
          currentProfile: "efficiency",
          targetProfile: "efficiency",
          pressureScore: 4,
          reasons: [],
          lagPressureActive: true,
          lagEscalatedActive: false,
          thermalState: "nominal",
          isOnBattery: true,
          speedLimit: 100,
        },
      })
    );
    const firstWarn = findings.findIndex((f) => f.tone === "warn");
    const lastAlert = findings.map((f) => f.tone).lastIndexOf("alert");
    expect(lastAlert).toBeGreaterThanOrEqual(0);
    expect(lastAlert).toBeLessThan(firstWarn);
  });

  it("treats terminals with no renderer report as a missing reading", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: quietMemory,
        rendererTerminals: [],
      })
    );

    render(<WhySlowContent />);

    expect(
      await screen.findByText("No slowdowns found, but some readings are unavailable")
    ).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("qualifies a quiet verdict when a reading is present but out of date", async () => {
    getWhySlowSnapshot.mockResolvedValue(
      makeSnapshot({
        resource: makeQuietResource(),
        pty: makeQuietPty(),
        worktrees: quietWorktrees,
        memory: {
          ...quietMemory!,
          terminalWorkloads: { ...quietMemory!.terminalWorkloads, stale: true },
        },
        rendererTerminals: quietRenderer,
      })
    );

    render(<WhySlowContent />);

    expect(
      await screen.findByText("No slowdowns found, but some readings are out of date")
    ).toBeTruthy();
    expect(screen.queryByTestId("why-slow-all-clear")).toBeNull();
  });

  it("says which way a pending profile switch is heading", () => {
    const base = makeQuietResource();
    const easing = describeSlowdowns(
      makeSnapshot({
        resource: { ...base, currentProfile: "efficiency", targetProfile: "balanced" },
      })
    ).find((f) => f.id === "profile");
    const worsening = describeSlowdowns(
      makeSnapshot({
        resource: { ...base, currentProfile: "balanced", targetProfile: "efficiency" },
      })
    ).find((f) => f.id === "profile");
    expect(easing?.suggestion).toMatch(/eased/);
    // The lag latch holds the profile down whatever the target says.
    const held = describeSlowdowns(
      makeSnapshot({
        resource: {
          ...base,
          currentProfile: "efficiency",
          targetProfile: "performance",
          lagPressureActive: true,
        },
      })
    ).find((f) => f.id === "profile");
    expect(held?.suggestion).not.toMatch(/eased/);
    expect(held?.suggestion).toMatch(/catches up/);
    expect(worsening?.suggestion).not.toMatch(/eased/);
    expect(worsening?.suggestion).toMatch(/power-saving/);
  });
});

describe("host memory pause findings", () => {
  const base = () =>
    makeSnapshot({
      resource: makeQuietResource(),
      pty: { ...makeQuietPty(), terminalCount: 6, pausedCount: 6, memoryPausedCount: 6 },
      worktrees: quietWorktrees,
    });

  it("never attributes a memory governor's holds to a drawing backlog", () => {
    const findings = describeSlowdowns(base(), { active: true, paused: true, stalled: false });
    expect(findings.map((f) => f.id)).not.toContain("pty-backlog");
    expect(findings.filter((f) => f.id === "host-memory")).toHaveLength(1);
  });

  it("still reports the terminals held by something other than the memory governor", () => {
    const snapshot = base();
    snapshot.pty = { ...snapshot.pty!, pausedCount: 8, totalPendingBytes: 4096 };
    const backlog = describeSlowdowns(snapshot).find((f) => f.id === "pty-backlog");
    expect(backlog?.text).toMatch(/^2 terminals are paused/);
  });

  it("names the memory pause from the collector alone when the episode hasn't synced", () => {
    expect(describeSlowdowns(base()).map((f) => f.id)).toContain("host-memory");
  });

  it("tells a live pause from a lifted one", () => {
    const paused = describeSlowdowns(base(), { active: true, paused: true, stalled: false });
    const lifted = describeSlowdowns(
      { ...base(), pty: makeQuietPty() },
      { active: true, paused: false, stalled: false }
    );
    const pausedText = paused.find((f) => f.id === "host-memory")?.text;
    const liftedText = lifted.find((f) => f.id === "host-memory")?.text;
    expect(pausedText).toBeTruthy();
    expect(liftedText).toBeTruthy();
    expect(pausedText).not.toBe(liftedText);
  });

  it("is never all clear while the episode the toolbar shows is open", () => {
    const quiet = { ...base(), pty: makeQuietPty() };
    expect(isAllClear(quiet)).toBe(true);
    expect(isAllClear(quiet, { active: true, paused: false, stalled: false })).toBe(false);
  });
});
