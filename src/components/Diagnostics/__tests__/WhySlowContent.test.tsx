// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WhySlowContent } from "../WhySlowContent";
import type { WhySlowSnapshot } from "@shared/types/whySlow";

const getWhySlowSnapshot = vi.fn();
vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    getWhySlowSnapshot: (...args: unknown[]) => getWhySlowSnapshot(...args),
  },
}));

const logError = vi.fn();
vi.mock("@/utils/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));

function makeSnapshot(overrides?: Partial<WhySlowSnapshot>): WhySlowSnapshot {
  return {
    timestamp: 1,
    resource: null,
    focusThrottle: { throttled: false, pollMultiplier: 1 },
    rendererTerminals: [],
    pty: null,
    worktrees: null,
    workers: null,
    ...overrides,
  };
}

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

    // One webgl + one dom view → "mixed"; counts sum across views.
    expect(await screen.findByText("mixed")).toBeTruthy();
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

    expect(await screen.findByText("Worker queue")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("degraded: copytree-worker:/proj")).toBeTruthy();
    expect(screen.getByText("degraded: analysis-worker-1")).toBeTruthy();
  });

  it("renders a dash for the worker queue when the summary is unavailable", async () => {
    getWhySlowSnapshot.mockResolvedValue(makeSnapshot({ workers: null }));

    render(<WhySlowContent />);

    expect(await screen.findByText("Worker queue")).toBeTruthy();
    expect(screen.queryByText(/^degraded:/)).toBeNull();
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
});
