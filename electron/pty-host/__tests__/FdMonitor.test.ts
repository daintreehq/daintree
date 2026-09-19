import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FdOwnerCounts } from "../../../shared/types/pty-host.js";

// Must mock before imports
const mockReaddirSync = vi.fn<(path: string) => string[]>();
const mockFstatSync = vi.fn<(fd: number) => unknown>();

vi.mock("node:fs", () => ({
  default: {
    readdirSync: (path: string) => mockReaddirSync(path),
    fstatSync: (fd: number) => mockFstatSync(fd),
  },
  readdirSync: (path: string) => mockReaddirSync(path),
  fstatSync: (fd: number) => mockFstatSync(fd),
}));

import { FdMonitor, classifyFds, isProcessAlive, type FdSample } from "../FdMonitor.js";

const INTERVAL = 30_000;
const WARMUP = 2 * 60_000;

function owners(overrides: Partial<FdOwnerCounts> = {}): FdOwnerCounts {
  return { terminals: 0, pooledPtys: 0, pluginPtys: 0, analysisWorkers: 0, ...overrides };
}

function listing(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(i));
}

function fakeStats(kind: "char" | "socket" | "fifo" | "file" | "dir" | "other") {
  return {
    isCharacterDevice: () => kind === "char",
    isSocket: () => kind === "socket",
    isFIFO: () => kind === "fifo",
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
  };
}

/**
 * Drives a monitor through a simulated host: every `sample()` advances the
 * clock one interval and reads `fds` descriptors against the current owners.
 */
function harness(platform: NodeJS.Platform = "darwin") {
  const monitor = new FdMonitor({ fdPath: "/dev/fd", platform, startedAt: 0 });
  let now = 0;
  const transitions: NonNullable<FdSample["transition"]>[] = [];
  const sample = (fds: number, current: FdOwnerCounts): FdSample | null => {
    now += INTERVAL;
    mockReaddirSync.mockReturnValue(listing(fds));
    const result = monitor.sample(current, now);
    if (result?.transition) transitions.push(result.transition);
    return result;
  };
  return { monitor, sample, transitions, now: () => now };
}

describe("FdMonitor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockReaddirSync.mockReset();
    mockFstatSync.mockReset();
    mockReaddirSync.mockReturnValue(listing(5));
    mockFstatSync.mockReturnValue(fakeStats("file"));
  });

  describe("getFdCount", () => {
    it("returns the number of entries in the fd directory", () => {
      const monitor = new FdMonitor({ fdPath: "/dev/fd" });
      mockReaddirSync.mockReturnValue(listing(7));
      expect(monitor.getFdCount()).toBe(7);
    });

    it("returns null rather than 0 when the listing fails", () => {
      const monitor = new FdMonitor({ fdPath: "/dev/fd" });
      mockReaddirSync.mockImplementation(() => {
        throw new Error("EMFILE");
      });
      expect(monitor.getFdCount()).toBeNull();
    });
  });

  describe("platform support and accounting", () => {
    it("is supported on macOS and Linux only", () => {
      expect(new FdMonitor({ platform: "darwin" }).supported).toBe(true);
      expect(new FdMonitor({ platform: "linux" }).supported).toBe(true);
      expect(new FdMonitor({ platform: "win32" }).supported).toBe(false);
    });

    it("reads /dev/fd on macOS and /proc/self/fd on Linux", () => {
      new FdMonitor({ platform: "darwin" }).getFdCount();
      new FdMonitor({ platform: "linux" }).getFdCount();
      expect(mockReaddirSync.mock.calls).toEqual([["/dev/fd"], ["/proc/self/fd"]]);
    });

    it("accounts two descriptors per PTY on macOS, one on Linux, two per worker", () => {
      const counts = owners({ terminals: 25, pooledPtys: 2, pluginPtys: 1, analysisWorkers: 3 });
      expect(new FdMonitor({ platform: "darwin" }).expectedFds(counts)).toBe(28 * 2 + 3 * 2);
      expect(new FdMonitor({ platform: "linux" }).expectedFds(counts)).toBe(28 + 3 * 2);
    });
  });

  describe("calibration", () => {
    it("takes no baseline and reports nothing during the startup warm-up", () => {
      const { sample, transitions } = harness();
      for (let t = INTERVAL; t < WARMUP; t += INTERVAL) {
        expect(sample(500, owners())?.baselineFds).toBeNull();
      }
      expect(transitions).toEqual([]);
    });

    it("waits for owner counts to hold still before taking the baseline", () => {
      const { sample } = harness();
      for (let i = 0; i < 4; i++) sample(40, owners());

      // Restore still spawning terminals: owners change on every sample.
      expect(sample(50, owners({ terminals: 5 }))?.baselineFds).toBeNull();
      expect(sample(60, owners({ terminals: 10 }))?.baselineFds).toBeNull();
      expect(sample(70, owners({ terminals: 15 }))?.baselineFds).toBeNull();

      expect(sample(70, owners({ terminals: 15 }))?.baselineFds).toBeNull();
      // Lowest settled excess across the three stable samples.
      expect(sample(69, owners({ terminals: 15 }))?.baselineFds).toBe(39);
    });

    it("calibrates at the deadline even if the host never settles", () => {
      const { sample } = harness();
      let result: FdSample | null = null;
      for (let i = 1; i <= 20; i++) {
        result = sample(40 + (i % 2) * 2, owners({ terminals: i % 2 }));
      }
      expect(result?.baselineFds).toBe(40);
    });
  });

  describe.each(["darwin", "linux"] as const)("episodes on %s", (platform) => {
    const ptyFds = platform === "darwin" ? 2 : 1;
    // A restored fleet at the issue's scale: 25 terminals, two pooled shells,
    // three analysis workers, on top of the host's own 37 descriptors.
    const fleet = owners({ terminals: 25, pooledPtys: 2, analysisWorkers: 3 });
    const fleetFds = 37 + 27 * ptyFds + 3 * 2;

    function calibrated() {
      const h = harness(platform);
      // Calibrated before the session restore landed: an empty host.
      for (let i = 0; i < 6; i++) h.sample(37, owners());
      expect(h.sample(37, owners())?.baselineFds).toBe(37);
      return h;
    }

    it("never reports a healthy fleet, however long it runs", () => {
      const { sample, transitions } = calibrated();

      // Restore brings 25 terminals back after the baseline was taken.
      for (let i = 0; i < 120; i++) sample(fleetFds, fleet);

      // Twenty more terminals, which also spawn the rest of the worker pool.
      const bigger = owners({ terminals: 45, pooledPtys: 2, analysisWorkers: 6 });
      for (let i = 0; i < 60; i++) sample(37 + 47 * ptyFds + 6 * 2, bigger);

      // Close them again; the workers stay.
      const after = owners({ ...fleet, analysisWorkers: 6 });
      for (let i = 0; i < 60; i++) sample(fleetFds + 6, after);

      expect(transitions).toEqual([]);
    });

    it("ignores a burst of descriptors that does not last three samples", () => {
      const { sample, transitions } = calibrated();
      sample(fleetFds, fleet);
      sample(fleetFds + 200, fleet);
      sample(fleetFds + 200, fleet);
      sample(fleetFds, fleet);
      sample(fleetFds + 200, fleet);
      expect(transitions).toEqual([]);
    });

    it("reports a descriptor retained per open/close cycle once, then its recovery", () => {
      const { sample, transitions } = calibrated();
      const busier = owners({ ...fleet, terminals: 26 });
      let leaked = 0;
      const cycle = () => {
        // Open: the new terminal is accounted for.
        sample(fleetFds + ptyFds + leaked, busier);
        // Close: its PTY goes away, one descriptor stays behind.
        leaked++;
        sample(fleetFds + leaked, fleet);
      };

      for (let i = 0; i < 31; i++) cycle();
      expect(transitions).toEqual([]);

      mockFstatSync.mockImplementation((fd: number) =>
        fakeStats(fd % 3 === 0 ? "char" : fd % 3 === 1 ? "fifo" : "file")
      );
      cycle();
      cycle();
      expect(transitions).toHaveLength(1);
      const elevated = transitions[0]!;
      expect(elevated).toMatchObject({
        state: "elevated",
        ...fleet,
        baselineFds: 37,
        sustainedSamples: 3,
      });
      expect(elevated.growth).toBeGreaterThanOrEqual(32);
      expect(elevated.fdCount - elevated.expectedFds - elevated.baselineFds).toBe(elevated.growth);
      const types = elevated.descriptorTypes!;
      expect(types.charDevice + types.fifo + types.file).toBe(elevated.fdCount);

      // Still leaking for hours: the same episode, no repeat and no drift.
      for (let i = 0; i < 400; i++) cycle();
      expect(transitions).toHaveLength(1);

      // Whatever held the descriptors releases them.
      sample(fleetFds, fleet);
      sample(fleetFds, fleet);
      expect(transitions).toHaveLength(2);
      expect(transitions[1]).toMatchObject({
        state: "recovered",
        growth: 0,
        baselineFds: 37,
        sustainedSamples: 2,
        episodeStartedAt: elevated.episodeStartedAt,
      });
      expect(transitions[1]!.descriptorTypes).toBeUndefined();

      // A second leak is a second episode.
      for (let i = 0; i < 3; i++) sample(fleetFds + 40, fleet);
      expect(transitions.map((t) => t.state)).toEqual(["elevated", "recovered", "elevated"]);
      expect(transitions[2]!.episodeStartedAt).toBeGreaterThan(elevated.episodeStartedAt);
    });

    it("dates the episode from the first sample over the threshold", () => {
      const { sample, transitions, now } = calibrated();
      sample(fleetFds + 40, fleet);
      const firstHigh = now();
      sample(fleetFds + 40, fleet);
      sample(fleetFds + 40, fleet);
      expect(transitions[0]?.episodeStartedAt).toBe(firstHigh);
    });

    it("catches a slow leak and never raises the baseline to absorb it", () => {
      const { sample, transitions } = calibrated();
      // One descriptor every ten samples (five minutes).
      for (let i = 0; i < 400 && transitions.length === 0; i++) {
        sample(fleetFds + Math.floor(i / 10), fleet);
      }
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.baselineFds).toBe(37);
    });

    it("stays elevated while the growth holds, without recovering on a plateau", () => {
      const { sample, transitions } = calibrated();
      for (let i = 0; i < 200; i++) sample(fleetFds + 50, fleet);
      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
    });

    it("needs two consecutive low samples to recover", () => {
      const { sample, transitions } = calibrated();
      for (let i = 0; i < 3; i++) sample(fleetFds + 50, fleet);
      sample(fleetFds, fleet);
      sample(fleetFds + 50, fleet);
      sample(fleetFds + 10, fleet);
      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
      sample(fleetFds + 16, fleet);
      expect(transitions.map((t) => t.state)).toEqual(["elevated", "recovered"]);
    });
  });

  describe("baseline", () => {
    function calibratedAt(excess: number) {
      const h = harness();
      for (let i = 0; i < 6; i++) h.sample(excess, owners());
      expect(h.sample(excess, owners())?.baselineFds).toBe(excess);
      return h;
    }

    it("lowers only after three consecutive lower readings, to the highest of them", () => {
      const { sample } = calibratedAt(40);
      expect(sample(35, owners())?.baselineFds).toBe(40);
      expect(sample(36, owners())?.baselineFds).toBe(40);
      expect(sample(34, owners())?.baselineFds).toBe(36);
    });

    it("does not lower on an interrupted run of lower readings", () => {
      const { sample } = calibratedAt(40);
      sample(35, owners());
      sample(35, owners());
      sample(40, owners());
      expect(sample(35, owners())?.baselineFds).toBe(40);
    });

    it("never rises on its own", () => {
      const { sample } = calibratedAt(40);
      for (let i = 0; i < 100; i++) sample(60, owners());
      expect(sample(60, owners())?.baselineFds).toBe(40);
    });
  });

  describe("failed listings", () => {
    it("neither extends nor breaks a streak", () => {
      const { monitor, sample, transitions, now } = harness();
      for (let i = 0; i < 7; i++) sample(40, owners());

      sample(80, owners());
      sample(80, owners());
      mockReaddirSync.mockImplementation(() => {
        throw new Error("EMFILE");
      });
      expect(monitor.sample(owners(), now() + INTERVAL)).toBeNull();
      mockReaddirSync.mockReset();
      expect(transitions).toEqual([]);

      sample(80, owners());
      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
    });

    it("never reads as a drop to zero that could end an episode", () => {
      const { monitor, sample, transitions, now } = harness();
      for (let i = 0; i < 7; i++) sample(40, owners());
      for (let i = 0; i < 3; i++) sample(80, owners());

      mockReaddirSync.mockImplementation(() => {
        throw new Error("EMFILE");
      });
      for (let i = 1; i <= 5; i++) monitor.sample(owners(), now() + i * INTERVAL);

      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
    });
  });
});

describe("classifyFds", () => {
  beforeEach(() => {
    mockFstatSync.mockReset();
  });

  it("counts descriptors by fstat type", () => {
    const kinds = ["char", "socket", "fifo", "file", "dir", "other", "file"] as const;
    mockFstatSync.mockImplementation((fd: number) => fakeStats(kinds[fd]!));

    expect(classifyFds(listing(kinds.length))).toEqual({
      charDevice: 1,
      socket: 1,
      fifo: 1,
      file: 2,
      directory: 1,
      other: 1,
      unavailable: 0,
    });
  });

  it("counts descriptors that closed before inspection as unavailable", () => {
    mockFstatSync.mockImplementation((fd: number) => {
      if (fd === 1) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
      return fakeStats("file");
    });

    expect(classifyFds(["0", "1", "2", "not-a-number"])).toMatchObject({
      file: 2,
      unavailable: 2,
    });
  });

  it("inspects at most 1024 descriptors", () => {
    mockFstatSync.mockReturnValue(fakeStats("file"));

    const counts = classifyFds(listing(1100));

    expect(mockFstatSync).toHaveBeenCalledTimes(1024);
    expect(counts).toMatchObject({ file: 1024, unavailable: 76 });
  });
});

describe("isProcessAlive", () => {
  it("returns true for current process PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    expect(isProcessAlive(99999)).toBe(false);
  });
});
