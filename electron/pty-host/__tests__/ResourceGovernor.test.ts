import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock FdMonitor before importing ResourceGovernor
vi.mock("../FdMonitor.js", () => {
  const FdMonitor = vi.fn().mockImplementation(() => ({
    supported: true,
    getFdCount: vi.fn().mockReturnValue(10),
    checkForLeaks: vi.fn().mockReturnValue({
      totalFds: 10,
      baselineFds: 5,
      estimatedTerminalFds: 5,
      activeTerminals: 2,
      isWarning: false,
      orphanedPids: [],
      ptmxLimit: 511,
    }),
  }));
  return { FdMonitor, isProcessAlive: vi.fn() };
});

vi.mock("../metrics.js", () => ({
  metricsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("node:v8", () => ({
  default: {
    getHeapStatistics: vi.fn().mockReturnValue({
      heap_size_limit: 1024 * 1024 * 1024,
    }),
  },
}));

import { ResourceGovernor, type ResourceGovernorDeps } from "../ResourceGovernor.js";
import { FdMonitor } from "../FdMonitor.js";

function createMockDeps(overrides?: Partial<ResourceGovernorDeps>): ResourceGovernorDeps {
  return {
    getTerminals: vi.fn().mockReturnValue([]),
    getTerminalPids: vi.fn().mockReturnValue([]),
    incrementPauseCount: vi.fn(),
    sendEvent: vi.fn(),
    ...overrides,
  };
}

describe("ResourceGovernor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops monitoring interval", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();
    governor.dispose();
  });

  it("calls checkResources on interval", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);
    expect(deps.getTerminalPids).toHaveBeenCalled();

    governor.dispose();
  });

  it("emits fd-leak-warning when FD monitor reports warning", () => {
    const mockFdMonitor = {
      supported: true,
      getFdCount: vi.fn().mockReturnValue(10),
      checkForLeaks: vi.fn().mockReturnValue({
        totalFds: 50,
        baselineFds: 5,
        estimatedTerminalFds: 45,
        activeTerminals: 2,
        isWarning: true,
        orphanedPids: [1234],
        ptmxLimit: 511,
      }),
    };

    (FdMonitor as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockFdMonitor);

    const deps = createMockDeps({
      getTerminalPids: vi.fn().mockReturnValue([
        { id: "t1", pid: 100 },
        { id: "t2", pid: 200 },
      ]),
    });

    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    expect(deps.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fd-leak-warning",
        fdCount: 50,
        activeTerminals: 2,
        orphanedPids: [1234],
        ptmxLimit: 511,
      })
    );

    governor.dispose();
  });

  it("does not emit warning when FD monitor reports no warning", () => {
    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    const calls = (deps.sendEvent as ReturnType<typeof vi.fn>).mock.calls;
    const fdWarnings = calls.filter((c: any[]) => c[0]?.type === "fd-leak-warning");
    expect(fdWarnings).toHaveLength(0);

    governor.dispose();
  });

  describe("trackKilledPid", () => {
    it("tracks killed PIDs and passes them to FdMonitor after grace period", () => {
      const mockCheckForLeaks = vi.fn().mockReturnValue({
        totalFds: 10,
        baselineFds: 5,
        estimatedTerminalFds: 5,
        activeTerminals: 0,
        isWarning: false,
        orphanedPids: [],
        ptmxLimit: 511,
      });

      const mockFdMonitor = {
        supported: true,
        getFdCount: vi.fn().mockReturnValue(10),
        checkForLeaks: mockCheckForLeaks,
      };

      (FdMonitor as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockFdMonitor);

      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      governor.trackKilledPid(5678);

      // First tick — grace period not elapsed yet
      vi.advanceTimersByTime(2000);
      expect(mockCheckForLeaks).toHaveBeenCalledWith(0, []);

      // After grace period (4s total)
      vi.advanceTimersByTime(4000);
      expect(mockCheckForLeaks).toHaveBeenCalledWith(0, [5678]);

      governor.dispose();
    });
  });
});
