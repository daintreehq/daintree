import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared mock state that tests can reconfigure
let mockCheckForLeaks: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
let mockFdMonitorSupported: boolean;

vi.mock("../FdMonitor.js", () => {
  return {
    FdMonitor: class {
      get supported() {
        return mockFdMonitorSupported;
      }
      getFdCount = vi.fn().mockReturnValue(10);
      checkForLeaks = (...args: unknown[]) => mockCheckForLeaks(...args);
    },
    isProcessAlive: vi.fn(),
  };
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

function createMockDeps(overrides?: Partial<ResourceGovernorDeps>): ResourceGovernorDeps {
  return {
    getTerminals: vi.fn().mockReturnValue([]),
    getTerminalPids: vi.fn().mockReturnValue([]),
    incrementPauseCount: vi.fn(),
    sendEvent: vi.fn(),
    ...overrides,
  };
}

const defaultLeakResult = {
  totalFds: 10,
  baselineFds: 5,
  estimatedTerminalFds: 5,
  activeTerminals: 2,
  isWarning: false,
  orphanedPids: [] as number[],
  ptmxLimit: 511,
};

describe("ResourceGovernor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFdMonitorSupported = true;
    mockCheckForLeaks = vi.fn().mockReturnValue({ ...defaultLeakResult });
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
    expect(mockCheckForLeaks).toHaveBeenCalled();

    governor.dispose();
  });

  it("emits fd-leak-warning when FD monitor reports warning", () => {
    mockCheckForLeaks.mockReturnValue({
      totalFds: 50,
      baselineFds: 5,
      estimatedTerminalFds: 45,
      activeTerminals: 2,
      isWarning: true,
      orphanedPids: [1234],
      ptmxLimit: 511,
    });

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
    const fdWarnings = calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.type === "fd-leak-warning"
    );
    expect(fdWarnings).toHaveLength(0);

    governor.dispose();
  });

  it("skips FD monitoring on unsupported platforms", () => {
    mockFdMonitorSupported = false;

    const deps = createMockDeps();
    const governor = new ResourceGovernor(deps);
    governor.start();

    vi.advanceTimersByTime(2000);

    expect(mockCheckForLeaks).not.toHaveBeenCalled();

    governor.dispose();
  });

  describe("trackKilledPid", () => {
    it("tracks killed PIDs and passes them to FdMonitor after grace period", () => {
      const deps = createMockDeps();
      const governor = new ResourceGovernor(deps);
      governor.start();

      governor.trackKilledPid(5678);

      // First tick — grace period not elapsed yet (only 2s, need 4s)
      vi.advanceTimersByTime(2000);
      expect(mockCheckForLeaks).toHaveBeenLastCalledWith(0, []);

      // After grace period (6s total from start, 4s from trackKilledPid)
      vi.advanceTimersByTime(4000);
      expect(mockCheckForLeaks).toHaveBeenLastCalledWith(0, [5678]);

      governor.dispose();
    });
  });
});
