// "Why am I slow?" diagnostics snapshot (#10910). A single, at-a-glance view of
// the app's self-throttling governance state — which mechanisms are currently
// active and why — so a "it feels slow" report is diagnosable in minutes instead
// of a fresh log-correlation investigation each time.
//
// Assembled in the main process by DiagnosticsCollector.collectWhySlowSnapshot.
// Each section degrades to null on collection failure rather than failing the
// whole snapshot; the renderer-terminal section is a per-view cache populated by
// renderer pushes, so it may be empty (no active views have reported yet).

import type { ResourceProfile, ResourceThermalState } from "./resourceProfile.js";
import type { WhySlowWorkerSummary } from "./workerGovernance.js";

export type { WhySlowWorkerSummary };

/** A single pressure signal that contributed to the current resource-profile decision. */
export interface WhySlowResourceReason {
  /** Which governance input fired. */
  signal:
    | "memory"
    | "battery"
    | "thermal"
    | "cpuSpeedLimit"
    | "fleetSize"
    | "rendererSaturation"
    | "systemMemory";
  /** Additive pressure-score contribution (efficiency latches at total ≥ 3). */
  contribution: number;
  /** Human-readable detail, e.g. "12 active agents" or "thermal serious". */
  detail: string;
}

/**
 * Resource-profile state plus the reasons behind it. `targetProfile` is what the
 * pressure score maps to right now; it can differ from `currentProfile` because
 * of hold timers, the interactive override, or the event-loop-lag latch (which
 * forces efficiency directly, bypassing the pressure score — hence the separate
 * lag flags).
 */
export interface WhySlowResourceSnapshot {
  currentProfile: ResourceProfile;
  targetProfile: ResourceProfile;
  pressureScore: number;
  reasons: WhySlowResourceReason[];
  /** Event-loop-lag latch: sustained main-thread lag holding the profile down. */
  lagPressureActive: boolean;
  /** Escalated lag latch (a single severe sample fast-pathed the latch on). */
  lagEscalatedActive: boolean;
  /** A renderer interactive-override window is clamping the profile to ≥ balanced. */
  interactiveOverrideActive: boolean;
  thermalState: ResourceThermalState;
  isOnBattery: boolean;
  /** CPU speed limit % (100 = unthrottled). */
  speedLimit: number;
}

/** Focus-loss polling throttle: on blur, poll intervals are multiplied. */
export interface WhySlowFocusThrottleSnapshot {
  throttled: boolean;
  /** Poll-interval multiplier currently applied (1 when focused). */
  pollMultiplier: number;
}

/**
 * Per-renderer terminal-rendering state, pushed by each project view when its
 * WebGL mode or terminal-tier distribution changes. `ageMs`/`stale` describe how
 * fresh the cached sample is — since pushes are event-driven, an old sample is
 * still accurate (state simply hasn't changed), so `stale` is informational.
 */
export interface WhySlowRendererTerminalSample {
  webContentsId: number;
  /** Whether terminals are rendering via WebGL or the DOM fallback. */
  webglMode: "webgl" | "dom";
  /** Number of terminals currently wanting a WebGL context (drives the mode switch). */
  wantsWebgl: number;
  terminalCount: number;
  /** Terminal counts bucketed by refresh tier (BURST/FOCUSED/VISIBLE/BACKGROUND). */
  countsByTier: Record<string, number>;
  /** Wall-clock time the sample was recorded. */
  timestamp: number;
  /** Age of the sample at snapshot time, in ms. */
  ageMs: number;
  /** True when the sample is old enough that its liveness is worth flagging. */
  stale: boolean;
}

/** Condensed PTY flow-control state: queued/stalled output the terminals are absorbing. */
export interface WhySlowPtySummary {
  /** Total bytes queued across all transports, awaiting delivery to renderers. */
  totalPendingBytes: number;
  terminalCount: number;
  /** Terminals currently paused by backpressure or the resource governor. */
  pausedCount: number;
  /** Terminals in a suspended flow state. */
  suspendedCount: number;
  /** Longest current pause duration across terminals, in ms. */
  maxPausedDurationMs: number;
  /**
   * Pty-host event-loop p99 delay (ms) since the previous snapshot pull, or
   * null when unmonitored. High values with pausedCount 0 = the host thread
   * is CPU-saturated (parse load), not backpressured.
   */
  eventLoopP99Ms: number | null;
  /** Pty-host event-loop max delay (ms) over the same window, or null. */
  eventLoopMaxMs: number | null;
  /** Pty-host event-loop utilization (0-1) over the same window, or null. */
  eventLoopUtilization: number | null;
}

/** Workspace-host monitoring load: how many worktrees are watched and fetching. */
export interface WhySlowWorktreeSummary {
  monitorCount: number;
  fetchInFlightCount: number;
}

/** The full "why am I slow?" snapshot. */
export interface WhySlowSnapshot {
  timestamp: number;
  resource: WhySlowResourceSnapshot | null;
  focusThrottle: WhySlowFocusThrottleSnapshot;
  rendererTerminals: WhySlowRendererTerminalSample[];
  pty: WhySlowPtySummary | null;
  worktrees: WhySlowWorktreeSummary | null;
  /** Persistent-worker pressure summary (queue depth, degraded subsystems), or null. */
  workers: WhySlowWorkerSummary | null;
}

/** Renderer-pushed payload for {@link WhySlowRendererTerminalSample} (id + freshness added main-side). */
export interface WhySlowRendererTerminalReport {
  webglMode: "webgl" | "dom";
  wantsWebgl: number;
  terminalCount: number;
  countsByTier: Record<string, number>;
}
