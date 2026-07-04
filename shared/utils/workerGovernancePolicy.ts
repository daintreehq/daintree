import { ACTIVE_AGENT_STATES, type AgentState } from "../types/agent.js";
import type { WorkerResourceSnapshot } from "../types/workerGovernance.js";

/**
 * Pure decision layer for worker governance. Subsystems declare what is
 * allowed (eligibility flags on the snapshot); these functions decide what to
 * actually do given idle time, queue depth, and memory pressure. Pure and
 * side-effect-free so the same rules run identically in main, the pty-host,
 * and unit tests.
 *
 * The bias is deliberate: when a signal is missing or ambiguous, the answer is
 * "none". A wrongly-skipped trim costs some memory; a wrongly-fired dispose or
 * restart costs a working agent.
 */

export type WorkerGovernanceAction = "none" | "trim" | "dispose" | "restart";

export interface WorkerGovernanceDecision {
  action: WorkerGovernanceAction;
  reason: string;
}

/** Idle floor before an eligible worker may be disposed. */
export const WORKER_IDLE_DISPOSE_MS = 30 * 60_000;
/** Idle floor before an inactive analysis session may be trimmed. */
export const ANALYSIS_SESSION_IDLE_TRIM_MS = 10 * 60_000;
/** Minimum spacing between governance-initiated restarts of one worker. */
export const WORKER_RESTART_COOLDOWN_MS = 5 * 60_000;
/** Recent crashes at or above this count disqualify a worker from restart. */
export const WORKER_CRASH_LOOP_LIMIT = 3;

export interface WorkerGovernancePolicyContext {
  now: number;
  /** True when the efficiency profile (or an equivalent pressure signal) is active. */
  memoryPressure: boolean;
  idleDisposeMs?: number;
  /** Wall-clock of the last governance-initiated restart for this worker. */
  lastRestartAt?: number | null;
  restartCooldownMs?: number;
  /** Crashes observed in the subsystem's sliding window. */
  recentCrashCount?: number;
}

/**
 * Decide the strongest safe action for one worker snapshot.
 *
 * Guardrails, in order:
 * - a dead worker is the subsystem's own recovery problem, never governance's;
 * - in-flight work (queue depth) blocks dispose/restart outright — the existing
 *   fallback paths only cover worker *death*, not a governance kill;
 * - dispose/restart require zero live attachments and a long idle window;
 * - restart additionally requires explicit eligibility (no persistent
 *   worker_thread sets it — Electron worker-churn crash), a cooldown since the
 *   last governance restart, and no crash-loop in progress;
 * - trim is the only action allowed while sessions are attached, and only under
 *   memory pressure — the subsystem's own per-session policy protects active
 *   agents (see {@link shouldTrimAnalysisSession}).
 */
export function decideWorkerAction(
  snapshot: WorkerResourceSnapshot,
  ctx: WorkerGovernancePolicyContext
): WorkerGovernanceDecision {
  if (!snapshot.alive) {
    return { action: "none", reason: "worker not running" };
  }

  const idleMs = snapshot.lastActivityAt === null ? null : ctx.now - snapshot.lastActivityAt;
  const idleDisposeMs = ctx.idleDisposeMs ?? WORKER_IDLE_DISPOSE_MS;
  const quiescent =
    snapshot.queueDepth === 0 &&
    snapshot.activeSessionCount === 0 &&
    idleMs !== null &&
    idleMs >= idleDisposeMs;

  if (snapshot.eligibility.dispose && quiescent) {
    return { action: "dispose", reason: `idle ${Math.round(idleMs / 1000)}s with no attachments` };
  }

  if (snapshot.eligibility.restart && quiescent) {
    const cooldownMs = ctx.restartCooldownMs ?? WORKER_RESTART_COOLDOWN_MS;
    const lastRestartAt = ctx.lastRestartAt ?? null;
    const cooldownElapsed = lastRestartAt === null || ctx.now - lastRestartAt >= cooldownMs;
    const crashLooping = (ctx.recentCrashCount ?? 0) >= WORKER_CRASH_LOOP_LIMIT;
    if (cooldownElapsed && !crashLooping) {
      return { action: "restart", reason: "idle worker past restart cooldown" };
    }
    return {
      action: "none",
      reason: crashLooping ? "crash-loop protection" : "restart cooldown active",
    };
  }

  if (snapshot.eligibility.trim && ctx.memoryPressure) {
    return { action: "trim", reason: "memory pressure with trim-eligible worker" };
  }

  return { action: "none", reason: "no eligible action" };
}

export interface AnalysisSessionTrimInput {
  agentState?: AgentState;
  lastInputTime: number;
  lastOutputTime: number;
  scrollbackLines: number;
  minScrollbackLines: number;
  now: number;
  idleTrimMs?: number;
}

/**
 * Per-session gate for analysis-buffer trims. A session is trimmable only when
 * no agent is mid-work on it (ACTIVE_AGENT_STATES — the same set that protects
 * terminals from eviction/hibernation), the terminal has been quiet past the
 * idle floor, and the scrollback is actually above the trim target.
 */
export function shouldTrimAnalysisSession(input: AnalysisSessionTrimInput): boolean {
  if (input.agentState && ACTIVE_AGENT_STATES.has(input.agentState)) return false;
  if (input.scrollbackLines <= input.minScrollbackLines) return false;
  const idleMs = input.now - Math.max(input.lastInputTime, input.lastOutputTime);
  return idleMs >= (input.idleTrimMs ?? ANALYSIS_SESSION_IDLE_TRIM_MS);
}

export interface PluginWorkerIdleInput {
  isBuiltin: boolean;
  devMode: boolean;
  /** Manifest-declared panel contributions — open panels are invisible to main. */
  panelContributionCount: number;
  /** Manifest-declared MCP server contributions. */
  mcpServerContributionCount: number;
  /** Declared `onStartupFinished` — the plugin asked to run in the background. */
  startupActivation: boolean;
  /** Live host-event/forge/worktree subscriptions registered during activate. */
  eventSubscriptionCount: number;
  /**
   * Actions registered imperatively via `host.registerAction` (manifest
   * commands excluded). They die with the worker and nothing re-triggers
   * activation for them, so disposing would strand the plugin's palette
   * entries until restart.
   */
  imperativeActionCount: number;
  pendingInvokeCount: number;
  /** In-flight worker→main host calls, incl. open prompts (showQuickPick etc.). */
  pendingHostCallCount: number;
  managedProcessCount: number;
  fsWatcherCount: number;
  lastActivityAt: number | null;
  now: number;
  idleDisposeMs?: number;
}

/**
 * Gate for disposing one idle plugin worker through the narrow deactivation
 * path (worker + imperative registrations torn down; the plugin stays loaded
 * and re-forks lazily on next use, mirroring the dev-reload cycle).
 *
 * Every disqualifier is a live surface a disposed worker would silently break:
 * built-ins have no worker; dev workers own their reload cycle via the file
 * watcher; panel plugins may have an open panel main can't see; MCP plugins may
 * be serving an agent; pending invokes / spawned processes / fs watchers are
 * work in flight. Manifest-declared palette commands do NOT disqualify — they
 * re-bind lazily on first dispatch, which re-forks the worker on demand.
 */
export function canDisposeIdlePluginWorker(input: PluginWorkerIdleInput): {
  ok: boolean;
  reason: string;
} {
  if (input.isBuiltin) return { ok: false, reason: "builtin runs in-process" };
  if (input.devMode) return { ok: false, reason: "dev worker owns its reload cycle" };
  if (input.panelContributionCount > 0) {
    return { ok: false, reason: "contributes panels (open state unknown)" };
  }
  if (input.mcpServerContributionCount > 0) {
    return { ok: false, reason: "contributes MCP servers" };
  }
  if (input.startupActivation) {
    return { ok: false, reason: "startup-activated background plugin" };
  }
  if (input.eventSubscriptionCount > 0) {
    return { ok: false, reason: "live event subscriptions" };
  }
  if (input.imperativeActionCount > 0) {
    return { ok: false, reason: "imperative actions would be stranded" };
  }
  if (input.pendingInvokeCount > 0) return { ok: false, reason: "invokes in flight" };
  if (input.pendingHostCallCount > 0) return { ok: false, reason: "host calls in flight" };
  if (input.managedProcessCount > 0) return { ok: false, reason: "managed processes running" };
  if (input.fsWatcherCount > 0) return { ok: false, reason: "fs watchers active" };
  if (input.lastActivityAt === null) return { ok: false, reason: "activity unknown" };
  const idleMs = input.now - input.lastActivityAt;
  const idleDisposeMs = input.idleDisposeMs ?? WORKER_IDLE_DISPOSE_MS;
  if (idleMs < idleDisposeMs) return { ok: false, reason: "not idle long enough" };
  return { ok: true, reason: `idle ${Math.round(idleMs / 1000)}s` };
}
