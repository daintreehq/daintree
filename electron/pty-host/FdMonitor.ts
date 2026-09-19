import fs from "node:fs";
import type { FdGrowthPayload, FdOwnerCounts, FdTypeCounts } from "../../shared/types/pty-host.js";

// Descriptors one open PTY holds in this process: node-pty keeps the master on
// every platform, and on macOS also a kqueue watching the child until it exits.
// Measured against the bundled node-pty: five macOS PTYs added ten descriptors
// and closing them returned all ten.
const PTY_FDS: Partial<Record<NodeJS.Platform, number>> = { darwin: 2, linux: 1 };
// A worker_thread runs its own event loop for as long as it lives: a poller
// and an async wakeup handle everywhere, plus on Linux the SIGCHLD pipe libuv
// opens per loop (macOS watches child exits through kqueue instead) and an
// io_uring ring for batching epoll changes — one fewer where the kernel or a
// sandbox refuses io_uring, which only makes late-spawned workers read as
// slightly less growth, never more.
const WORKER_FDS: Partial<Record<NodeJS.Platform, number>> = { darwin: 2, linux: 5 };

// Startup opens descriptors that settle within the first minutes (module
// loads, pool warm, session restore), so nothing is calibrated before this.
const WARMUP_MS = 2 * 60_000;
// Owner counts must hold still for this many samples before the baseline is
// taken, so it is not measured in the middle of a spawn burst.
const SETTLE_SAMPLES = 3;
// A host that never settles (continuous churn) calibrates here regardless.
const CALIBRATION_DEADLINE_MS = 10 * 60_000;
// Growth beyond what the owners account for. Bounded noise the model does not
// cover (a one-off descriptor after the first spawn, worker respawns) stays
// well under this; a descriptor retained per open/close cycle crosses it after
// 32 cycles.
const ELEVATED_GROWTH = 32;
// Short-lived children (`ps`/`lsof` probes, spawns in flight) hold stdio
// sockets for well under a second. A burst can land on one sample; eleven or
// more of them live at five instants two minutes apart is not a burst.
const ELEVATED_SAMPLES = 5;
const RECOVERED_GROWTH = 16;
const RECOVERED_SAMPLES = 2;
// The baseline only moves down, and only on a sustained lower reading — never
// up, so growth is always measured against the settled post-restore state
// and a slow leak cannot be absorbed into a moving floor.
const LOWER_BASELINE_SAMPLES = 3;
const MAX_INSPECTED_FDS = 1024;

export type FdGrowthObservation = Omit<
  FdGrowthPayload,
  "hostPid" | "sampleIntervalMs" | "timestamp"
>;

export interface FdSample {
  fdCount: number;
  expectedFds: number;
  /** Null until the host has settled after startup and restore. */
  baselineFds: number | null;
  transition: FdGrowthObservation | null;
}

export interface FdMonitorOptions {
  fdPath?: string;
  platform?: NodeJS.Platform;
  startedAt?: number;
}

interface SettlingSample {
  excess: number;
  owners: FdOwnerCounts;
}

export class FdMonitor {
  private readonly fdPath: string | null;
  private readonly ptyFds: number;
  private readonly workerFds: number;
  private readonly startedAt: number;
  private settling: SettlingSample[] = [];
  private baselineFds: number | null = null;
  private lowerReadings: number[] = [];
  private elevatedStreak = 0;
  private elevatedSince = 0;
  private recoveredStreak = 0;
  private episodeStartedAt: number | null = null;

  constructor(options: FdMonitorOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (options.fdPath) {
      this.fdPath = options.fdPath;
    } else if (platform === "darwin") {
      this.fdPath = "/dev/fd";
    } else if (platform === "linux") {
      this.fdPath = "/proc/self/fd";
    } else {
      this.fdPath = null;
    }
    this.ptyFds = PTY_FDS[platform] ?? 1;
    this.workerFds = WORKER_FDS[platform] ?? 2;
    this.startedAt = options.startedAt ?? Date.now();
  }

  get supported(): boolean {
    return this.fdPath !== null;
  }

  /** Open descriptors, or null when the listing failed — never a guessed 0. */
  getFdCount(): number | null {
    return this.listFds()?.length ?? null;
  }

  expectedFds(owners: FdOwnerCounts): number {
    const ptys = owners.terminals + owners.pooledPtys + owners.pluginPtys;
    return ptys * this.ptyFds + owners.analysisWorkers * this.workerFds;
  }

  /**
   * Takes one reading and returns a transition only when an episode starts or
   * ends. Returns null when the descriptor listing failed; that reading
   * neither extends nor breaks a streak.
   */
  sample(owners: FdOwnerCounts, now: number): FdSample | null {
    const entries = this.listFds();
    if (entries === null) return null;

    const fdCount = entries.length;
    const expectedFds = this.expectedFds(owners);
    // Descriptors the owners do not account for: the host's own runtime,
    // sockets, log files — and anything retained after its owner went away.
    const excess = fdCount - expectedFds;

    if (this.baselineFds === null) {
      this.calibrate(excess, owners, now);
      return { fdCount, expectedFds, baselineFds: this.baselineFds, transition: null };
    }

    this.lowerBaseline(excess);
    const baselineFds = this.baselineFds;
    const growth = excess - baselineFds;
    const observe = (
      state: FdGrowthObservation["state"],
      sustainedSamples: number,
      episodeStartedAt: number
    ): FdGrowthObservation => ({
      state,
      ...owners,
      fdCount,
      expectedFds,
      baselineFds,
      growth,
      sustainedSamples,
      episodeStartedAt,
    });

    let transition: FdGrowthObservation | null = null;
    if (this.episodeStartedAt === null) {
      if (growth >= ELEVATED_GROWTH) {
        if (this.elevatedStreak === 0) this.elevatedSince = now;
        this.elevatedStreak++;
        if (this.elevatedStreak >= ELEVATED_SAMPLES) {
          this.episodeStartedAt = this.elevatedSince;
          transition = {
            ...observe("elevated", this.elevatedStreak, this.elevatedSince),
            descriptorTypes: classifyFds(entries),
          };
          this.elevatedStreak = 0;
          this.recoveredStreak = 0;
        }
      } else {
        this.elevatedStreak = 0;
      }
    } else if (growth <= RECOVERED_GROWTH) {
      this.recoveredStreak++;
      if (this.recoveredStreak >= RECOVERED_SAMPLES) {
        transition = observe("recovered", this.recoveredStreak, this.episodeStartedAt);
        this.episodeStartedAt = null;
        this.recoveredStreak = 0;
      }
    } else {
      this.recoveredStreak = 0;
    }

    return { fdCount, expectedFds, baselineFds, transition };
  }

  private calibrate(excess: number, owners: FdOwnerCounts, now: number): void {
    const age = now - this.startedAt;
    if (age < WARMUP_MS) return;

    // Restored terminals are accounted for by the owner model, so a restore
    // that lands after calibration does not shift the baseline; settling only
    // keeps the reading away from descriptors held mid-spawn.
    const previous = this.settling[this.settling.length - 1];
    if (previous && !sameOwners(previous.owners, owners)) this.settling = [];
    this.settling.push({ excess, owners });
    if (this.settling.length > SETTLE_SAMPLES) this.settling.shift();

    if (this.settling.length < SETTLE_SAMPLES && age < CALIBRATION_DEADLINE_MS) return;
    this.baselineFds = Math.min(...this.settling.map((s) => s.excess));
    this.settling = [];
  }

  private lowerBaseline(excess: number): void {
    if (this.baselineFds === null || excess >= this.baselineFds) {
      this.lowerReadings = [];
      return;
    }
    this.lowerReadings.push(excess);
    if (this.lowerReadings.length >= LOWER_BASELINE_SAMPLES) {
      this.baselineFds = Math.max(...this.lowerReadings);
      this.lowerReadings = [];
    }
  }

  private listFds(): string[] | null {
    if (!this.fdPath) return null;
    try {
      return fs.readdirSync(this.fdPath);
    } catch {
      return null;
    }
  }
}

function sameOwners(a: FdOwnerCounts, b: FdOwnerCounts): boolean {
  return (
    a.terminals === b.terminals &&
    a.pooledPtys === b.pooledPtys &&
    a.pluginPtys === b.pluginPtys &&
    a.analysisWorkers === b.analysisWorkers
  );
}

/**
 * Counts descriptors by the type `fstat` reports. Metadata only — nothing is
 * opened, read, or named. A PTY master is a character device, but so is
 * /dev/null; kqueue and epoll descriptors land wherever the platform's fstat
 * puts them.
 *
 * Synchronous on purpose, and only when an episode starts: the host already
 * stats and reads session and history files synchronously far more often, so
 * a stalled network mount would stop it there first.
 */
export function classifyFds(entries: readonly string[]): FdTypeCounts {
  const counts: FdTypeCounts = {
    charDevice: 0,
    socket: 0,
    fifo: 0,
    file: 0,
    directory: 0,
    other: 0,
    unavailable: 0,
  };
  entries.forEach((entry, index) => {
    const fd = Number(entry);
    if (index >= MAX_INSPECTED_FDS || !Number.isInteger(fd)) {
      counts.unavailable++;
      return;
    }
    try {
      const stats = fs.fstatSync(fd);
      if (stats.isCharacterDevice()) counts.charDevice++;
      else if (stats.isSocket()) counts.socket++;
      else if (stats.isFIFO()) counts.fifo++;
      else if (stats.isFile()) counts.file++;
      else if (stats.isDirectory()) counts.directory++;
      else counts.other++;
    } catch {
      // The listing's own descriptor is closed by now, and others can close
      // between the listing and this call.
      counts.unavailable++;
    }
  });
  return counts;
}

/**
 * Checks whether a PID exists and is signalable via `kill(pid, 0)`.
 *
 * This only verifies PID existence, not process identity. PID reuse within
 * the grace window (`ResourceGovernor.ORPHAN_GRACE_MS = 4000`) can produce
 * false-positive orphanedPids warnings. The grace window reduces noise but
 * does not eliminate this POSIX-level race.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return e instanceof Error && (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
