import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SAFETY_MARGIN = 10; // Empirical headroom for non-terminal FDs (event loop handles, IPC pipes, file watchers).
const WARNING_MULTIPLIER = 2; // Empirical factor accounting for per-terminal FD overhead. Not a claim about precise per-terminal FD count.

export interface FdCheckResult {
  totalFds: number;
  baselineFds: number;
  estimatedTerminalFds: number;
  activeTerminals: number;
  isWarning: boolean;
  orphanedPids: number[];
  ptmxLimit: number | null;
}

export class FdMonitor {
  private baselineFds: number;
  private calibrationChecksRemaining: number;
  private readonly ptmxLimit: number | null;
  private readonly fdPath: string | null;
  private readonly isSupported: boolean;

  constructor(fdPathOverride?: string, calibrationChecks = 5) {
    const platform = process.platform;

    if (fdPathOverride) {
      this.fdPath = fdPathOverride;
      this.isSupported = true;
    } else if (platform === "darwin") {
      this.fdPath = "/dev/fd";
      this.isSupported = true;
    } else if (platform === "linux") {
      this.fdPath = "/proc/self/fd";
      this.isSupported = true;
    } else {
      this.fdPath = null;
      this.isSupported = false;
    }

    this.baselineFds = this.getFdCount();
    this.calibrationChecksRemaining = calibrationChecks;
    this.ptmxLimit = this.readPtmxLimit();
  }

  getFdCount(): number {
    if (!this.fdPath) return 0;
    try {
      return fs.readdirSync(this.fdPath).length;
    } catch {
      return 0;
    }
  }

  checkForLeaks(activeTerminalCount: number, knownPids: number[]): FdCheckResult {
    const totalFds = this.getFdCount();
    const terminalAllowance = activeTerminalCount * WARNING_MULTIPLIER;
    const isCalibrating = this.calibrationChecksRemaining > 0;
    if (isCalibrating) {
      this.baselineFds = Math.max(this.baselineFds, totalFds - terminalAllowance);
      this.calibrationChecksRemaining--;
    }
    const estimatedTerminalFds = Math.max(0, totalFds - this.baselineFds);
    const threshold = terminalAllowance + SAFETY_MARGIN + this.baselineFds;
    const isWarning = !isCalibrating && this.isSupported && totalFds > threshold;
    const orphanedPids = this.findOrphanedPids(knownPids);

    return {
      totalFds,
      baselineFds: this.baselineFds,
      estimatedTerminalFds,
      activeTerminals: activeTerminalCount,
      isWarning,
      orphanedPids,
      ptmxLimit: this.ptmxLimit,
    };
  }

  private findOrphanedPids(knownPids: number[]): number[] {
    const orphaned: number[] = [];
    for (const pid of knownPids) {
      if (isProcessAlive(pid)) {
        orphaned.push(pid);
      }
    }
    return orphaned;
  }

  private readPtmxLimit(): number | null {
    if (process.platform === "linux") {
      try {
        const output = fs.readFileSync("/proc/sys/kernel/pty/max", "utf8");
        const parsed = parseInt(output.trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    if (process.platform === "darwin") {
      try {
        const output = execFileSync("sysctl", ["-n", "kern.tty.ptmx_max"], {
          encoding: "utf8",
          timeout: 2000,
        });
        const parsed = parseInt(output.trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        console.warn("[FdMonitor] sysctl kern.tty.ptmx_max failed, using default limit of 511");
        return 511;
      }
    }

    return null;
  }

  get supported(): boolean {
    return this.isSupported;
  }
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
