/**
 * Cross-process resource-snapshot shapes for persistent workers and utility
 * hosts (#10920 follow-up). Every long-lived worker subsystem — analysis
 * worker pool, DB maintenance worker, copytree worker, plugin workers, and the
 * utility-process hosts themselves — reports the same bounded shape so
 * governance can measure and (where safe) trim without subsystem-specific
 * plumbing in the consumers.
 *
 * Snapshots travel pty-host → main and workspace-host → main over the existing
 * request/response brokers, so everything here must be structured-clone-safe.
 */

export type WorkerSubsystemKind =
  | "analysis-pool"
  | "db-worker"
  | "copytree-worker"
  | "plugin-worker"
  | "workspace-host"
  | "pty-host";

/**
 * Best-effort memory attribution. worker_threads share their parent process,
 * so per-thread RSS does not exist (`rssBytes: null` for thread-backed
 * subsystems) — but each worker thread IS its own V8 isolate, so heap and
 * external memory are attributable when the worker self-reports them (the
 * analysis pool does; see `AnalysisWorkerMemorySample`). The owning process's
 * RSS appears on the host-level snapshot.
 */
export interface WorkerMemoryEstimate {
  rssBytes?: number | null;
  heapUsedBytes?: number | null;
  externalBytes?: number | null;
}

/**
 * What governance is allowed to do with this worker right now, as declared by
 * the subsystem that owns it. The policy layer never overrides a false flag:
 * persistent worker_threads are never restart-eligible (Electron 37+ crashes
 * on repeated spawn/terminate cycles — `!flush_tasks_`), and the DB worker is
 * never trim/dispose-eligible (write ordering and shutdown flushes own it).
 */
export interface WorkerActionEligibility {
  trim: boolean;
  dispose: boolean;
  restart: boolean;
}

export interface WorkerResourceSnapshot {
  kind: WorkerSubsystemKind;
  /** Stable identity within the subsystem: slot index, plugin id, host label. */
  id: string;
  pid: number | null;
  threadId: number | null;
  alive: boolean;
  /** Terminals, open panels, monitors — live attachments that block disposal. */
  activeSessionCount: number;
  /** In-flight requests/operations queued on the worker. */
  queueDepth: number;
  /** Epoch ms of the last observed request/output; null when unknown. */
  lastActivityAt: number | null;
  memory: WorkerMemoryEstimate | null;
  eligibility: WorkerActionEligibility;
  /** Subsystem lifecycle descriptor, e.g. "running" | "degraded" | "fallback-pinned". */
  state: string;
  detail?: Record<string, string | number | boolean | null>;
}

/** Aggregated report assembled by the main-process governance service. */
export interface WorkerGovernanceReport {
  timestamp: number;
  subsystems: WorkerResourceSnapshot[];
  /** Providers that failed or timed out — reported, never fatal. */
  errors: Array<{ provider: string; error: string }>;
}

/** Compact why-slow projection: only what explains pressure, no per-worker rows. */
export interface WhySlowWorkerSummary {
  subsystemCount: number;
  aliveWorkerCount: number;
  totalQueueDepth: number;
  /** Subsystem ids currently degraded or pinned to a fallback path. */
  degraded: string[];
}
