import type { PatternDetectionResult } from "./AgentPatternDetector.js";
import type { ProcessStateValidator } from "../ActivityMonitor.js";
import type { CpuHighStateTracker } from "./CpuHighStateTracker.js";

export interface WaitingWatchdogOptions {
  failThreshold: number;
  maxWaitingSilenceMs: number;
  workingIndicatorTtlMs: number;
  cpuTracker: CpuHighStateTracker;
  processStateValidator?: ProcessStateValidator;
  onFire: (id: string, spawnedAt: number) => void;
}

export interface WaitingWatchdogProbeInputs {
  state: "busy" | "idle";
  idleSince: number;
  isSpinnerActive: boolean;
  lastPatternResult: PatternDetectionResult | undefined;
  lastPatternResultAt: number;
  lastDataTimestamp: number;
  terminalId: string;
  spawnedAt: number;
  /** Time since the previous probe. Absent means the 5s active cadence. */
  sinceLastProbeMs?: number;
}

export class WaitingWatchdog {
  private failCount = 0;
  private fired = false;

  private readonly failThreshold: number;
  private readonly maxWaitingSilenceMs: number;
  private readonly workingIndicatorTtlMs: number;
  private readonly cpuTracker: CpuHighStateTracker;
  private readonly validator?: ProcessStateValidator;
  private readonly onFire: (id: string, spawnedAt: number) => void;

  constructor(opts: WaitingWatchdogOptions) {
    this.failThreshold = opts.failThreshold;
    this.maxWaitingSilenceMs = opts.maxWaitingSilenceMs;
    this.workingIndicatorTtlMs = opts.workingIndicatorTtlMs;
    this.cpuTracker = opts.cpuTracker;
    this.validator = opts.processStateValidator;
    this.onFire = opts.onFire;
  }

  check(now: number, inputs: WaitingWatchdogProbeInputs): void {
    if (inputs.state !== "idle") return;
    if (this.fired) return;
    if (now - inputs.idleSince < this.maxWaitingSilenceMs) return;

    // Alive-veto probes — any positive signal that the agent is still alive
    // resets the consecutive-fail streak. Order matters only insofar as the
    // cheapest checks come first. A single lenient veto here is preferable
    // to a stuck dead-vote streak: the 10-minute ceiling has already elapsed,
    // so any fresh evidence of life genuinely should restart the consensus.
    if (inputs.isSpinnerActive) {
      this.failCount = 0;
      return;
    }
    if (
      inputs.lastPatternResult?.isWorking &&
      now - inputs.lastPatternResultAt < this.workingIndicatorTtlMs
    ) {
      this.failCount = 0;
      return;
    }
    // Veto when PTY data arrived during the current waiting period AND the
    // arrival was recent. The `> idleSince` guard rejects the field's
    // construction-time default (set equal to idleSince) and any stale value
    // carried over from a prior busy cycle; the recency window decays so a
    // single mid-cycle data event doesn't pin the streak open forever. It
    // spans at least the gap since the previous probe: the power policy
    // stretches the cadence to 10s/15s and re-times it on every level change,
    // and a window shorter than the gap would miss output that landed between
    // probes and vote a live agent dead.
    const dataRecencyMs = Math.max(this.workingIndicatorTtlMs, inputs.sinceLastProbeMs ?? 0);
    if (
      inputs.lastDataTimestamp > inputs.idleSince &&
      now - inputs.lastDataTimestamp < dataRecencyMs
    ) {
      this.failCount = 0;
      return;
    }
    if (this.cpuTracker.isHighAndNotDeadlined(now)) {
      this.failCount = 0;
      return;
    }

    // Process-tree probe is the sole dead-vote signal. `null` (validator
    // unavailable or threw) is ambiguous and resets the streak — silence
    // alone, without an affirmative dead vote, must never fire the watchdog.
    const hasChildren = this.hasActiveChildrenSafe();
    if (hasChildren !== false) {
      this.failCount = 0;
      return;
    }

    this.failCount += 1;
    if (this.failCount < this.failThreshold) return;

    this.fired = true;
    this.onFire(inputs.terminalId, inputs.spawnedAt);
  }

  reset(): void {
    this.failCount = 0;
    this.fired = false;
  }

  private hasActiveChildrenSafe(): boolean | null {
    if (!this.validator) {
      return null;
    }
    try {
      return this.validator.hasActiveChildren();
    } catch (error) {
      if (process.env.DAINTREE_VERBOSE) {
        console.warn("[ActivityMonitor] Process state validation failed:", error);
      }
      return true;
    }
  }
}
