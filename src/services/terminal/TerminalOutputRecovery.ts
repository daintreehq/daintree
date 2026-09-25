import { logInfo, logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import type { MissingOutputRecoveryOutcome } from "./TerminalRestoreController";
import type { ManagedTerminal } from "./types";

// Time a pane must sit on-screen with nothing received before the first probe.
// Covers the ordinary spawn-to-first-byte latency so a healthy launch is never
// probed at all.
export const OUTPUT_RECOVERY_GRACE_MS = 3000;

// Interval between probes of a pane that is still silent. Silence is normal for
// a pane whose host has produced nothing, and a probe is an IPC round trip plus
// a mirror serialize, so this stays well above the watchdog cadence.
export const OUTPUT_RECOVERY_PROBE_INTERVAL_MS = 15000;

// Failed recoveries (the host had output but it could not be replayed) allowed
// before the pane is reported as unrecoverable and probing stops.
export const OUTPUT_RECOVERY_MAX_FAILURES = 2;

/** The slice of a managed terminal this scheduler reads and writes. */
export type OutputRecoveryPane = Pick<
  ManagedTerminal,
  | "hasReceivedOutput"
  | "lastScrollbackRestoreError"
  | "outputRecoveryFirstSeenAt"
  | "outputRecoveryNextProbeAt"
  | "outputRecoveryInFlight"
  | "outputRecoveryFailures"
  | "outputRecoveryGaveUp"
>;

export interface OutputRecoveryDeps {
  getInstance: (id: string) => OutputRecoveryPane | undefined;
  recoverMissingOutput: (id: string) => Promise<MissingOutputRecoveryOutcome>;
  reportUnrecoverable: (id: string, error: TerminalScrollbackRestoreError) => void;
}

/**
 * Recovers panes whose host produced output that never reached the renderer's
 * xterm (#12754). The trigger is an observation, not an inference: the pane has
 * received nothing AND the host mirror is non-empty. Silence alone — normal for
 * an agent pane — only schedules another probe.
 *
 * Driven by the reconciliation watchdog, which already restricts the sweep to
 * genuinely on-screen, settled panes and rations IPC-heavy repairs per tick.
 */
export class TerminalOutputRecovery {
  private deps: OutputRecoveryDeps;

  constructor(deps: OutputRecoveryDeps) {
    this.deps = deps;
  }

  /** Whether this pane still needs watching at all. */
  isCandidate(managed: OutputRecoveryPane): boolean {
    return (
      managed.hasReceivedOutput !== true &&
      managed.outputRecoveryGaveUp !== true &&
      managed.outputRecoveryInFlight !== true
    );
  }

  /**
   * Start a probe if this pane is due. Returns whether one was started, so the
   * caller can charge it against its IPC budget.
   */
  maybeProbe(id: string, managed: OutputRecoveryPane, now: number): boolean {
    if (!this.isCandidate(managed)) return false;

    if (managed.outputRecoveryFirstSeenAt === undefined) {
      managed.outputRecoveryFirstSeenAt = now;
      managed.outputRecoveryNextProbeAt = now + OUTPUT_RECOVERY_GRACE_MS;
      return false;
    }
    if (now < (managed.outputRecoveryNextProbeAt ?? 0)) return false;

    managed.outputRecoveryInFlight = true;
    managed.outputRecoveryNextProbeAt = now + OUTPUT_RECOVERY_PROBE_INTERVAL_MS;
    void this.runProbe(id, managed);
    return true;
  }

  private async runProbe(id: string, managed: OutputRecoveryPane): Promise<void> {
    let outcome: MissingOutputRecoveryOutcome;
    try {
      outcome = await this.deps.recoverMissingOutput(id);
    } catch (error) {
      managed.lastScrollbackRestoreError = {
        type: "error",
        message: formatErrorMessage(error, "Missing-output recovery failed"),
        timestamp: Date.now(),
      };
      outcome = "failed";
    } finally {
      managed.outputRecoveryInFlight = false;
    }

    // A respawn under the same id replaced the instance mid-probe; its fresh
    // bookkeeping owns the pane now.
    if (this.deps.getInstance(id) !== managed) return;

    switch (outcome) {
      case "recovered":
        managed.hasReceivedOutput = true;
        logInfo("[TerminalOutputRecovery] repainted a pane that never received its host output", {
          id,
        });
        return;
      case "failed": {
        const failures = (managed.outputRecoveryFailures ?? 0) + 1;
        managed.outputRecoveryFailures = failures;
        logWarn(
          "[TerminalOutputRecovery] host had output this pane never received; replay failed",
          {
            id,
            failures,
            limit: OUTPUT_RECOVERY_MAX_FAILURES,
            error: managed.lastScrollbackRestoreError,
          }
        );
        if (failures < OUTPUT_RECOVERY_MAX_FAILURES) return;
        managed.outputRecoveryGaveUp = true;
        this.deps.reportUnrecoverable(
          id,
          managed.lastScrollbackRestoreError ?? {
            type: "error",
            message:
              "Output the terminal produced never reached this pane and couldn't be replayed.",
            timestamp: Date.now(),
          }
        );
        return;
      }
      case "no-host-output":
      case "live-output":
      case "stale":
        return;
    }
  }
}
