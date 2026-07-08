import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type {
  WhySlowWorkerSummary,
  WorkerGovernanceReport,
  WorkerResourceSnapshot,
} from "../../shared/types/workerGovernance.js";

/**
 * Main-process aggregation point for persistent-worker governance (#10920
 * follow-up). Subsystems register providers; the service collects their
 * bounded {@link WorkerResourceSnapshot}s for diagnostics and fans out the
 * efficiency-profile trim request. It owns no policy of its own — each
 * provider applies the shared policy (`workerGovernancePolicy`) against state
 * only it can see, so a snapshot here is always observational and a trim here
 * is always a request, never a command.
 */

const PROVIDER_TIMEOUT_MS = 4_000;
// Efficiency can be re-entered repeatedly under a flapping pressure signal;
// trims are one-shot per cooldown window so governance never becomes its own
// churn source ("no aggressive pool shrinking on every profile transition").
export const GOVERNANCE_TRIM_COOLDOWN_MS = 5 * 60_000;

export interface WorkerGovernanceProvider {
  name: string;
  collect(): Promise<WorkerResourceSnapshot[]> | WorkerResourceSnapshot[];
  /**
   * Optional efficiency-entry hook: trim caches / dispose idle workers, per
   * the subsystem's own safety gates. Must never throw across the boundary —
   * but the fan-out isolates each call anyway.
   */
  trim?: () => Promise<unknown> | unknown;
}

function timeoutError(name: string, ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`governance provider "${name}" timed out after ${ms}ms`)),
      ms
    );
    timer.unref?.();
  });
}

export class WorkerGovernanceService {
  private readonly providers: WorkerGovernanceProvider[] = [];
  private lastTrimAt = 0;

  register(provider: WorkerGovernanceProvider): void {
    this.providers.push(provider);
  }

  /**
   * Collect every provider's snapshots, per-provider isolated and time-boxed:
   * a hung pty-host or a throwing plugin sweep degrades to an `errors` entry
   * without blanking the rest of the report. Snapshots that carry a pid but no
   * memory are joined to the shared app-metrics sweep (workingSetSize) so
   * utility-process workers get memory attribution without new sampling.
   */
  async collectReport(timeoutMs = PROVIDER_TIMEOUT_MS): Promise<WorkerGovernanceReport> {
    const errors: Array<{ provider: string; error: string }> = [];
    const collected = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          return await Promise.race([
            Promise.resolve(provider.collect()),
            timeoutError(provider.name, timeoutMs),
          ]);
        } catch (error) {
          errors.push({
            provider: provider.name,
            error: formatErrorMessage(error, "governance provider failed"),
          });
          return [] as WorkerResourceSnapshot[];
        }
      })
    );
    const subsystems = collected.flat();
    this.attachMemoryByPid(subsystems);
    return { timestamp: Date.now(), subsystems, errors };
  }

  /**
   * Efficiency-entry fan-out. Each provider's trim runs in its own isolation
   * boundary — one subsystem throwing (or rejecting later) cannot skip the
   * others, mirroring `applyProfile`'s per-consumer try/catch contract. Fire
   * and forget: profile transitions must never await worker cleanup.
   */
  requestEfficiencyTrim(now = Date.now()): boolean {
    if (now - this.lastTrimAt < GOVERNANCE_TRIM_COOLDOWN_MS) return false;
    this.lastTrimAt = now;
    for (const provider of this.providers) {
      if (!provider.trim) continue;
      try {
        void Promise.resolve(provider.trim()).catch((error: unknown) => {
          logWarn("worker-governance-trim-failed", {
            provider: provider.name,
            error: formatErrorMessage(error, "trim failed"),
          });
        });
      } catch (error) {
        logWarn("worker-governance-trim-failed", {
          provider: provider.name,
          error: formatErrorMessage(error, "trim failed"),
        });
      }
    }
    logInfo("worker-governance-trim-requested", { providers: this.providers.length });
    return true;
  }

  /** Compact why-slow projection — pressure explanation, not a worker table. */
  summarize(report: WorkerGovernanceReport): WhySlowWorkerSummary {
    const degraded: string[] = [];
    let aliveWorkerCount = 0;
    let totalQueueDepth = 0;
    for (const s of report.subsystems) {
      if (s.alive) aliveWorkerCount++;
      totalQueueDepth += s.queueDepth;
      if (
        s.state === "degraded" ||
        s.state === "fallback-pinned" ||
        s.state === "dead" ||
        s.state === "unreachable"
      ) {
        degraded.push(s.id);
      }
    }
    return {
      subsystemCount: report.subsystems.length,
      aliveWorkerCount,
      totalQueueDepth,
      degraded,
    };
  }

  private attachMemoryByPid(subsystems: WorkerResourceSnapshot[]): void {
    if (!subsystems.some((s) => s.pid !== null && s.memory === null)) return;
    let metrics: ReturnType<typeof getAppMetricsSnapshot>;
    try {
      metrics = getAppMetricsSnapshot();
    } catch {
      return;
    }
    const rssByPid = new Map<number, number>();
    for (const proc of metrics) {
      rssByPid.set(proc.pid, proc.memory.workingSetSize * 1024);
    }
    for (const snapshot of subsystems) {
      if (snapshot.pid === null || snapshot.memory !== null) continue;
      const rssBytes = rssByPid.get(snapshot.pid);
      if (rssBytes !== undefined) {
        snapshot.memory = { rssBytes };
      }
    }
  }
}

let instance: WorkerGovernanceService | null = null;

export function getWorkerGovernanceService(): WorkerGovernanceService {
  if (!instance) {
    instance = new WorkerGovernanceService();
  }
  return instance;
}

/** Test-only: drop the singleton so each suite wires a fresh provider set. */
export function disposeWorkerGovernanceService(): void {
  instance = null;
}
