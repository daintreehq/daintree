import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SAFETY_MARGIN = 10;
const WARNING_MULTIPLIER = 2;

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
  private readonly baselineFds: number;
  private readonly ptmxLimit: number | null;
  private readonly fdPath: string | null;
  private readonly isSupported: boolean;

  constructor() {
    const platform = process.platform;
    this.isSupported = platform === "darwin" || platform === "linux";

    if (platform === "darwin") {
      this.fdPath = "/dev/fd";
    } else if (platform === "linux") {
      this.fdPath = "/proc/self/fd";
    } else {
      this.fdPath = null;
    }

    this.baselineFds = this.getFdCount();
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
    const estimatedTerminalFds = Math.max(0, totalFds - this.baselineFds);
    const threshold = activeTerminalCount * WARNING_MULTIPLIER + SAFETY_MARGIN + this.baselineFds;
    const isWarning = this.isSupported && totalFds > threshold;
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
    if (process.platform !== "darwin") return null;
    try {
      const output = execFileSync("sysctl", ["-n", "kern.tty.ptmx_max"], {
        encoding: "utf8",
        timeout: 2000,
      });
      const parsed = parseInt(output.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return 511; // macOS default
    }
  }

  get supported(): boolean {
    return this.isSupported;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return e instanceof Error && (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
