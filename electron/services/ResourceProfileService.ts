import os from "os";
import { powerMonitor } from "electron";
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from "node:perf_hooks";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { getFocusThrottlePollMultiplier } from "../window/focusThrottleState.js";
import { logInfo } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { getCachedMemoryRollup } from "./memoryAccounting.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { HibernationService } from "./HibernationService.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import type { ProjectStatsService } from "./ProjectStatsService.js";
import type { FleetSnapshotService } from "./FleetSnapshotService.js";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
  type ResourceProfilePayload,
  type ResourceProfileSnapshot,
} from "../../shared/types/resourceProfile.js";
import type { WhySlowResourceReason, WhySlowResourceSnapshot } from "../../shared/types/whySlow.js";
import { ACTIVE_AGENT_STATES, type AgentState } from "../../shared/types/agent.js";
import { getSystemMemoryThresholds, readActionableSystemMemoryMb } from "../utils/systemMemory.js";
import type { MemoryPressurePolicy } from "../utils/cachedProjectViews.js";
import { resolveResourceProfileConfig } from "../utils/resourceProfileConfig.js";

/** Map an additive pressure score to a profile. Efficiency latches at ≥ 3; a
 *  zero score (no pressure signals) unlocks performance; anything else is
 *  balanced. Shared by the scoring path and the why-slow snapshot so the
 *  reported target never drifts from the applied decision. */
function profileForScore(pressureScore: number): ResourceProfile {
  if (pressureScore >= 3) return "efficiency";
  if (pressureScore === 0) return "performance";
  return "balanced";
}

/**
 * Subset of PtyClient's TerminalInfoResponse used by the active-agent filter.
 * Declared structurally so we don't depend on a non-exported interface.
 */
type ActiveAgentTerminalLike = {
  agentState?: AgentState;
  isTrashed?: boolean;
  hasPty?: boolean;
  detectedAgentId?: string;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
};

const EVAL_INTERVAL_MS = 30_000;
const DOWNGRADE_HOLD_MS = 30_000;
const UPGRADE_HOLD_MS = 90_000;
const WARMUP_TICKS = 2;

// Active event-loop-lag mitigation. The diagnostics handler reads a separate
// lifetime histogram for IPC; this service owns its own histogram and resets
// it after each tumbling window so percentile() reflects only the recent slice.
// p99 is biased low by monitorEventLoopDelay (a single long block records as
// ONE large sample, not many) — thresholds are conservative to compensate.
// AND-gating with eventLoopUtilization rejects three classes of false positive:
// (1) isolated GC stalls — GC runs on the JS thread, so GC time counts as
// ACTIVE in ELU, not idle. A single long GC pause produces ONE histogram
// sample which cannot move p99 meaningfully across a 5-second window; the
// p99 threshold rejects these before ELU is even consulted.
// (2) bursty IPC reply storms — p99 climbs from queueing but the loop
// reaches idle between bursts so ELU stays moderate; (3) synchronous native
// UI work (file dialogs, window-drag, plugin loads that block libuv) — ELU
// pegs near 1.0 while V8 sits idle waiting on the OS run loop, so p99 stays
// low. A genuine sustained-saturation event has both high tail latency AND
// high loop occupancy. ELU alone doesn't catch periodic long sync work; p99
// alone trips on the cases above.
// Exit uses a sliding K-of-N window so occasional jitter (e.g. efficiency
// mode's own batched work) doesn't permanently restart recovery. A hard time
// cap bounds the latch so a pathological feedback loop can't pin the app to
// efficiency forever — after the cap the latch force-clears and the normal
// entry path will re-arm if saturation is genuinely ongoing. The cap is a
// stuck-latch escape, not a saturation override: under truly sustained lag
// (p99 + ELU both still elevated) the moderate entry path will re-latch
// within 10s, which is correct.
const LAG_SAMPLE_INTERVAL_MS = 5_000;
const LAG_HISTOGRAM_RESOLUTION_MS = 10;
const LAG_ENTRY_P99_MS = 250;
const LAG_ENTRY_ELU = 0.7;
const LAG_ESCALATE_P99_MS = 500;
const LAG_EXIT_P99_MS = 150;
const LAG_ENTER_TICKS_REQUIRED = 2; // 10s sustained for moderate entry
const LAG_EXIT_WINDOW_SAMPLES = 9; // 45s sliding window
const LAG_EXIT_CLEAN_REQUIRED = 7; // 7-of-9 clean tolerates 2 noisy samples
const LAG_PRESSURE_MAX_MS = 120_000; // 2-minute hard cap on stuck latch

// Upper bound on a SINGLE interactive-override request, so one bad/oversized
// call can't hold the profile off efficiency for long. The trusted renderer
// requests ~1.5s windows and re-requests while interaction continues, so a
// genuine continuous scroll renews the hold — and the hold self-expires within
// this bound once interaction stops, letting efficiency relief resume.
const MAX_INTERACTIVE_OVERRIDE_MS = 5_000;

// Memory-pressure thresholds scale with device RAM so machines with very
// different physical memory behave sensibly. On an 8 GB machine these
// fractions evaluate to ~1229 MB / ~655 MB, preserving the originally-tuned
// behavior; on a 64 GB machine they scale up to ~9830 MB / ~5243 MB, which
// stops false "efficiency" drops when the app has plenty of headroom.
const HIGH_FRACTION = 0.15;
const LOW_FRACTION = 0.08;

// Fleet-size signal (live agent terminals in working/waiting/directing states).
// Each running agent's resident memory is ~200–500 MB, so a graduated curve
// reflects that fleet size scales pressure roughly linearly. A flat +1 was
// indistinguishable across 8, 16, and 24 agents — those have wildly different
// memory footprints and the service must react accordingly.
// The tier boundaries scale with device RAM like every other memory signal:
// the per-GB rates reproduce the originally-tuned 8/16/24 on a 16 GB
// baseline, and the absolute values act as floors so smaller machines keep
// the original behavior. On a 128 GB machine 24 agents (~5–12 GB at the
// estimate above) are trivial, and the RAM-scaled sys-available signal
// catches genuine starvation independently.
const FLEET_COUNT_HIGH = 8;
const FLEET_COUNT_VERY_HIGH = 16;
const FLEET_COUNT_CRITICAL = 24;
const FLEET_AGENTS_PER_GB_HIGH = FLEET_COUNT_HIGH / 16;
const FLEET_AGENTS_PER_GB_VERY_HIGH = FLEET_COUNT_VERY_HIGH / 16;
const FLEET_AGENTS_PER_GB_CRITICAL = FLEET_COUNT_CRITICAL / 16;

// Terminal-workload signal: summed RSS of every live terminal's descendant
// tree (agent CLIs, dev servers, language servers, test runners) from the
// pty-host memory rollup. These are the largest real consumers in Daintree
// sessions and invisible to app.getAppMetrics(). Fractions of total RAM like
// the other memory signals, sitting well above the app-private bands because
// RSS double-counts shared pages across the fleet — this is a generous
// pressure heuristic, not a unique-footprint budget. Bounded at +2 so
// terminal workloads alone can reach `balanced` but can never latch
// `efficiency` (score ≥ 3) without a second corroborating signal; like every
// score input it only tunes cadences and budgets — it never pauses, kills,
// or hibernates a live workload.
const TERMINAL_WORKLOAD_HIGH_FRACTION = 0.4;
const TERMINAL_WORKLOAD_LOW_FRACTION = 0.25;
// Per-tier exit band: once a tier is engaged it releases at 90% of its entry
// threshold, so a workload hovering at a boundary can't flap the score (and
// with it the candidate-profile hold timers) on every 30s tick.
const TERMINAL_WORKLOAD_EXIT_RATIO = 0.9;
// Contributions are taken only from a successful process-table sweep newer
// than this (2 eval ticks). A huge-but-stale reading — ps wedged, pty-host
// unresponsive — must never hold the profile down; no measurement, no score.
const TERMINAL_WORKLOAD_FRESH_MS = 60_000;

export interface ResourceProfileDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getHibernationService: () => HibernationService | null;
  getAllProjectViewManagers: () => ProjectViewManager[];
  getProjectStatsService: () => ProjectStatsService | null;
  getFleetSnapshotService?: () => FleetSnapshotService | null;
  getUserCachedViewLimit: () => number;
  /**
   * Renderer-saturation signal from ProcessMemoryMonitor's 30s LoAF sampling
   * (any active view with a sustained high-blocking streak). Optional so test
   * fixtures and legacy callers keep compiling; absent reads as no pressure.
   */
  hasSustainedRendererSaturation?: () => boolean;
  /**
   * Worker-governance trim fan-out, requested once on each ENTRY into the
   * efficiency profile (the service's own cooldown absorbs flapping). Optional
   * so test fixtures and legacy callers keep compiling; fire-and-forget — a
   * profile transition never awaits worker cleanup.
   */
  requestWorkerTrim?: () => Promise<void> | void;
}

export type { ResourceProfileSnapshot };

export class ResourceProfileService {
  private currentProfile: ResourceProfile = "balanced";
  private candidateProfile: ResourceProfile | null = null;
  private candidateFirstSeenAt: number | null = null;
  private evalCleanup: (() => void) | null = null;
  private tickCount = 0;
  private disposed = false;
  private cachedActiveAgentCount = 0;
  // Monotonic counter; bumped on every start() and refreshFleetState() invocation
  // so that promises from a previous lifecycle (or out-of-order responses within
  // one lifecycle) can be detected and dropped without contaminating the cache.
  private refreshGeneration = 0;
  private thermalState: "unknown" | "nominal" | "fair" | "serious" | "critical" = "unknown";
  private speedLimit = 100;
  private isOnBattery = false;
  private readonly memoryThresholdHighMb: number;
  private readonly memoryThresholdLowMb: number;
  private readonly sysMemThresholdHighMb: number;
  private readonly sysMemThresholdLowMb: number;
  /**
   * Cached-view reclaim band, pushed to every PVM. Deliberately NOT part of
   * RESOURCE_PROFILE_CONFIGS: it is a property of the machine's RAM, not of the
   * profile, so it stays armed at one value across every transition — including
   * the interactive efficiency→balanced clamp, which used to loosen the floor
   * 1024→768 exactly when memory was lowest (#11469).
   */
  private readonly memoryPressurePolicy: MemoryPressurePolicy;
  private readonly terminalWorkloadHighMb: number;
  private readonly terminalWorkloadLowMb: number;
  // Latest terminal-workload rollup sample; null until the first successful
  // async refresh. Read synchronously by the scoring path, mirroring the
  // cachedActiveAgentCount pattern.
  private cachedTerminalWorkload: {
    totalMemoryMb: number;
    available: boolean;
    sampledAt: number;
  } | null = null;
  // Engaged contribution tier (0/1/2) for the exit-band hysteresis.
  private terminalWorkloadTier = 0;
  // Monotonic generation for the workload refresh, independent of the fleet
  // counter so neither refresh path can invalidate the other's in-flight work.
  private workloadRefreshGeneration = 0;
  private readonly fleetCountHigh: number;
  private readonly fleetCountVeryHigh: number;
  private readonly fleetCountCritical: number;
  private lagInterval: NodeJS.Timeout | null = null;
  private lagHistogram: IntervalHistogram | null = null;
  private lagPreviousElu: EventLoopUtilization | null = null;
  private lagPressureActive = false;
  private lagEscalatedActive = false;
  private lagEnterTicks = 0;
  private lagExitWindow: boolean[] = [];
  private lagPressureStartedAt: number | null = null;
  // Wall-clock until which an interactive override is in effect. While active,
  // the profile is clamped to ≥ balanced (efficiency is never entered/held) so
  // an actively-scrolled full-screen TUI keeps full PTY throughput. Renderer-
  // driven and time-boxed (see requestInteractiveOverride); 0 = inactive.
  private interactiveOverrideUntil = 0;

  constructor(private deps: ResourceProfileDeps) {
    const totalRamMb = os.totalmem() / 1024 / 1024;
    this.memoryThresholdHighMb = totalRamMb * HIGH_FRACTION;
    this.memoryThresholdLowMb = totalRamMb * LOW_FRACTION;
    const systemMemoryThresholds = getSystemMemoryThresholds(totalRamMb);
    this.sysMemThresholdHighMb = systemMemoryThresholds.warningMb;
    this.sysMemThresholdLowMb = systemMemoryThresholds.criticalMb;
    // Same thresholds that promote the profile on the memory signal, so a
    // promotion and the reclaim it implies now arm at the same reading.
    this.memoryPressurePolicy = {
      criticalMb: systemMemoryThresholds.criticalMb,
      warningMb: systemMemoryThresholds.warningMb,
    };
    this.terminalWorkloadHighMb = totalRamMb * TERMINAL_WORKLOAD_HIGH_FRACTION;
    this.terminalWorkloadLowMb = totalRamMb * TERMINAL_WORKLOAD_LOW_FRACTION;
    const totalRamGb = totalRamMb / 1024;
    this.fleetCountHigh = Math.max(
      FLEET_COUNT_HIGH,
      Math.ceil(totalRamGb * FLEET_AGENTS_PER_GB_HIGH)
    );
    this.fleetCountVeryHigh = Math.max(
      FLEET_COUNT_VERY_HIGH,
      Math.ceil(totalRamGb * FLEET_AGENTS_PER_GB_VERY_HIGH)
    );
    this.fleetCountCritical = Math.max(
      FLEET_COUNT_CRITICAL,
      Math.ceil(totalRamGb * FLEET_AGENTS_PER_GB_CRITICAL)
    );
  }

  private onThermalStateChange = (details: { state: string }): void => {
    const { state } = details;
    if (
      state === "unknown" ||
      state === "nominal" ||
      state === "fair" ||
      state === "serious" ||
      state === "critical"
    ) {
      this.thermalState = state;
    }
  };

  private onSpeedLimitChange = (details: { limit: number }): void => {
    const { limit } = details;
    if (typeof limit === "number" && !isNaN(limit) && limit >= 0 && limit <= 100) {
      this.speedLimit = limit;
    }
  };

  private primeThermalState(): void {
    if (process.platform !== "darwin") return;
    try {
      const state = powerMonitor.getCurrentThermalState();
      if (
        state === "unknown" ||
        state === "nominal" ||
        state === "fair" ||
        state === "serious" ||
        state === "critical"
      ) {
        this.thermalState = state;
      }
    } catch {
      this.thermalState = "unknown";
    }
  }

  private onBatteryPower = (): void => {
    this.isOnBattery = true;
  };

  private onAcPower = (): void => {
    this.isOnBattery = false;
  };

  getProfile(): ResourceProfile {
    return this.currentProfile;
  }

  private isInteractiveOverrideActive(): boolean {
    return Date.now() < this.interactiveOverrideUntil;
  }

  /**
   * Hold the profile at ≥ balanced for `durationMs` because the user is actively
   * interacting (e.g. scrolling a full-screen mouse-reporting TUI). Efficiency
   * stretches the pty-host's port-batch delay 16ms→40ms, which throttles the
   * returned-redraw stream and makes scroll feel slow ("gets slow and stays
   * slow"). This is the deliberate, lighter "no efficiency while scrolling" clamp
   * (NOT a full Performance pin): it (1) lifts out of efficiency immediately if
   * we're there, releasing the lag latch, and (2) blocks re-entry to efficiency
   * for the window via the guards in sampleLag/applyProfile. The window is
   * time-boxed and extended on each call (the renderer throttles calls), so it
   * self-expires shortly after interaction stops; the next lag/eval sample then
   * resumes normal scoring with no explicit revert needed.
   */
  requestInteractiveOverride(durationMs: number): void {
    if (this.disposed) return;
    // Reject non-finite input: a NaN would poison `interactiveOverrideUntil`
    // (Date.now() < NaN is always false, and Math.max(NaN, x) === NaN), bricking
    // every future request until restart. Negatives/Infinity are clamped below.
    if (!Number.isFinite(durationMs)) return;
    const clamped = Math.max(0, Math.min(durationMs, MAX_INTERACTIVE_OVERRIDE_MS));
    this.interactiveOverrideUntil = Math.max(this.interactiveOverrideUntil, Date.now() + clamped);
    // Lift out of efficiency right now if we're sitting in it — releasing the lag
    // latch so normal scoring (now clamped to ≥ balanced by the guards) governs.
    if (this.currentProfile === "efficiency") {
      this.clearLagPressure();
      this.applyProfile("balanced");
    }
  }

  /**
   * Read-only snapshot of the active resource profile and the pressure inputs
   * that drive it, for the diagnostics export (#10500). Narrow projection — the
   * scoring internals (histograms, thresholds, candidate timers) stay private.
   */
  getSnapshot(): ResourceProfileSnapshot {
    return {
      profile: this.currentProfile,
      thermalState: this.thermalState,
      isOnBattery: this.isOnBattery,
      speedLimit: this.speedLimit,
      lagPressureActive: this.lagPressureActive,
    };
  }

  /**
   * E2E seam: synchronously drive a profile transition, bypassing the
   * pressure-scoring and hold-timer machinery so fault-mode specs can assert
   * `applyProfile`'s side-effects (PVM fan-out, the `resource:profile-changed`
   * broadcast) deterministically. Gated to `DAINTREE_E2E_FAULT_MODE` at the
   * sole call site in `globalServicesInit.ts`; never invoked in production.
   */
  _forceProfileForTesting(profile: ResourceProfile): void {
    this.applyProfile(profile);
  }

  start(): void {
    if (this.evalCleanup) return;
    this.disposed = false;
    this.tickCount = 0;
    this.candidateProfile = null;
    this.candidateFirstSeenAt = null;
    // Zero the fleet-count cache so a stop → start cycle does not inherit
    // pressure from a previous lifecycle's fleet. The first refresh below
    // re-populates from the live PTY host.
    this.cachedActiveAgentCount = 0;
    // Bump the generation so any in-flight promise from the previous lifecycle
    // (or any earlier refresh in this lifecycle) will see a stale generation
    // in its .then() and drop its result.
    this.refreshGeneration += 1;
    // Same reset for the terminal-workload sample and its hysteresis latch.
    this.cachedTerminalWorkload = null;
    this.terminalWorkloadTier = 0;
    this.workloadRefreshGeneration += 1;

    logInfo("resource-profile-service-started", { profile: this.currentProfile });

    this.refreshFleetState();
    this.refreshTerminalWorkloadState();

    powerMonitor.on("thermal-state-change", this.onThermalStateChange);
    powerMonitor.on("speed-limit-change", this.onSpeedLimitChange);

    this.primeThermalState();
    try {
      this.isOnBattery = powerMonitor.isOnBatteryPower();
    } catch {
      this.isOnBattery = false;
    }
    powerMonitor.on("on-battery", this.onBatteryPower);
    powerMonitor.on("on-ac", this.onAcPower);

    this.evalCleanup = setAlignedInterval(() => {
      this.refreshFleetState();
      this.refreshTerminalWorkloadState();
      this.evaluate();
    }, EVAL_INTERVAL_MS);

    // Push the initial profile's PVM settings so they are armed on launch
    // even when the service stays on its default profile (`balanced`) and
    // applyProfile() never runs. Fan out to every window's PVM so
    // multi-window sessions are armed alongside the original window.
    // Paint-gate values are no-ops at default but pushed for symmetry so the
    // profile config remains the single source of truth — drift in the PVM
    // defaults stops mattering.
    for (const pvm of this.getProjectViewManagersSafe()) {
      this.applyCurrentProfileTo(pvm);
    }

    this.startLagMonitor();
  }

  /**
   * Resolve the PVM fan-out targets without letting a throwing provider take
   * down the caller. Both start() and applyProfile() iterate this list ahead
   * of other consumers (and ahead of the renderer broadcast) — a throw from
   * the dep would otherwise skip everything after it, leaving the profile
   * half-applied with no retry trigger.
   */
  private getProjectViewManagersSafe(): ProjectViewManager[] {
    try {
      return this.deps.getAllProjectViewManagers();
    } catch {
      return [];
    }
  }

  /**
   * Push the current profile's settings to a single ProjectViewManager.
   * Called from start() for managers alive at service start AND for every
   * manager created later (new window) — applyProfile() fans out only on
   * transitions, so without this a late-created PVM keeps its DEFAULT_*
   * balanced constants while the app sits in another profile. Each setter is
   * isolated in its own try/catch, mirroring applyProfile().
   */
  applyCurrentProfileTo(pvm: ProjectViewManager): void {
    const config = RESOURCE_PROFILE_CONFIGS[this.currentProfile];
    if (this.currentProfile === "efficiency") {
      // Efficiency freezes cached views (CPU/timer suppression) but never
      // destroys them. RAM is reclaimed only by evictStaleViews()'s own
      // memory-pressure band when free RAM is genuinely low, keeping the
      // user's working set warm under battery/thermal/CPU-only pressure.
      try {
        pvm.setEfficiencyFreeze(true);
      } catch {
        // non-critical
      }
    }
    try {
      pvm.setMemoryPressurePolicy(this.memoryPressurePolicy);
    } catch {
      // non-critical
    }
    try {
      pvm.setPaintGateTimeoutMs(config.paintGateTimeoutMs);
    } catch {
      // non-critical
    }
    try {
      pvm.setPaintGateHardTimeoutMs(config.paintGateHardTimeoutMs);
    } catch {
      // non-critical
    }
    try {
      pvm.setWarmPaintGateTimeoutMs(config.warmPaintGateTimeoutMs);
    } catch {
      // non-critical
    }
    try {
      pvm.setWarmPaintGateHardTimeoutMs(config.warmPaintGateHardTimeoutMs);
    } catch {
      // non-critical
    }
    try {
      pvm.setViewLoadTimeoutMs(config.viewLoadTimeoutMs);
    } catch {
      // non-critical
    }
    try {
      pvm.setViewLoadHardTimeoutMs(config.viewLoadHardTimeoutMs);
    } catch {
      // non-critical
    }
  }

  private startLagMonitor(): void {
    if (this.lagInterval) return;
    try {
      this.lagHistogram = monitorEventLoopDelay({
        resolution: LAG_HISTOGRAM_RESOLUTION_MS,
      });
      this.lagHistogram.enable();
    } catch {
      // perf_hooks may be unavailable in some embedded contexts; skip silently
      this.lagHistogram = null;
      this.lagPreviousElu = null;
      return;
    }
    try {
      this.lagPreviousElu = performance.eventLoopUtilization();
    } catch {
      // ELU unavailable: tear the histogram down so it isn't orphaned in the
      // native layer accumulating samples no one will ever read.
      try {
        this.lagHistogram.disable();
      } catch {
        // non-critical
      }
      this.lagHistogram = null;
      this.lagPreviousElu = null;
      return;
    }
    this.lagInterval = setInterval(() => {
      this.sampleLag();
    }, LAG_SAMPLE_INTERVAL_MS);
    this.lagInterval.unref();
  }

  private clearLagPressure(): void {
    this.lagPressureActive = false;
    this.lagEscalatedActive = false;
    this.lagEnterTicks = 0;
    this.lagExitWindow = [];
    this.lagPressureStartedAt = null;
  }

  private sampleLag(): void {
    if (this.disposed || !this.lagHistogram) return;

    let p99Ms = 0;
    let maxMs = 0;
    try {
      const rawP99 = this.lagHistogram.percentile(99) / 1_000_000;
      if (Number.isFinite(rawP99)) p99Ms = rawP99;
      // max is diagnostic-only — never gates entry/exit. Pairs with p99 in logs
      // so a single long block (which barely moves p99) is still visible.
      const rawMax = this.lagHistogram.max / 1_000_000;
      if (Number.isFinite(rawMax)) maxMs = rawMax;
    } catch {
      // Read failure: histogram still needs reset below so the window stays bounded.
    }
    try {
      this.lagHistogram.reset();
    } catch {
      // non-critical
    }

    let utilization = 0;
    try {
      const current = performance.eventLoopUtilization();
      const delta = this.lagPreviousElu
        ? performance.eventLoopUtilization(current, this.lagPreviousElu)
        : current;
      this.lagPreviousElu = current;
      if (Number.isFinite(delta.utilization)) utilization = delta.utilization;
    } catch {
      utilization = 0;
    }

    // Exit path runs first while the latch is held. A sliding K-of-N window
    // tolerates jitter (e.g. efficiency mode's own batched work spiking p99
    // a few times in a 9-sample window), and a hard time cap force-clears the
    // latch if it has been held too long — preventing pathological feedback
    // loops from pinning the app to efficiency indefinitely.
    if (this.lagPressureActive) {
      const now = Date.now();
      // Defensive: if lagPressureStartedAt is null while the latch is held the
      // cap can never measure elapsed time, so honor it as "definitely past
      // the cap" and force-clear. The two entry paths always set both fields
      // together, so this branch is unreachable in production — but the cap is
      // the last-resort escape and shouldn't be silently disarmed by an
      // unexpected state.
      if (
        this.lagPressureStartedAt === null ||
        now - this.lagPressureStartedAt >= LAG_PRESSURE_MAX_MS
      ) {
        const durationMs = this.lagPressureStartedAt === null ? 0 : now - this.lagPressureStartedAt;
        logInfo("event-loop-lag-force-cleared", {
          p99Ms: Math.round(p99Ms),
          maxMs: Math.round(maxMs),
          durationMs,
        });
        this.clearLagPressure();
        return;
      }

      const isClean = p99Ms < LAG_EXIT_P99_MS;
      this.lagExitWindow.push(isClean);
      if (this.lagExitWindow.length > LAG_EXIT_WINDOW_SAMPLES) {
        this.lagExitWindow.shift();
      }
      if (this.lagExitWindow.length >= LAG_EXIT_WINDOW_SAMPLES) {
        const cleanCount = this.lagExitWindow.reduce((sum, clean) => (clean ? sum + 1 : sum), 0);
        if (cleanCount >= LAG_EXIT_CLEAN_REQUIRED) {
          logInfo("event-loop-lag-cleared", {
            p99Ms: Math.round(p99Ms),
            maxMs: Math.round(maxMs),
          });
          this.clearLagPressure();
          return;
        }
      }

      if (p99Ms > LAG_ESCALATE_P99_MS && !this.lagEscalatedActive) {
        this.lagEscalatedActive = true;
        logInfo("event-loop-lag-escalated", {
          p99Ms: Math.round(p99Ms),
          maxMs: Math.round(maxMs),
          utilization: Math.round(utilization * 100) / 100,
        });
      }
      return;
    }

    // While an interactive override holds the floor at ≥ balanced, do not enter
    // the efficiency latch. applyProfile would redirect efficiency→balanced
    // anyway, so latching here would only strand a held-but-not-applied latch.
    // Lag is still sampled (the histogram was reset above), so detection resumes
    // cleanly the instant the override expires.
    if (this.isInteractiveOverrideActive()) {
      this.lagEnterTicks = 0;
      return;
    }

    // Severe-spike fast path: a single sample above the escalation threshold
    // with sustained high ELU enters the latch immediately, halving the
    // worst-case reaction time for genuine saturation bursts. ELU is still
    // AND-gated to preserve the GC/native-UI false-positive filter.
    if (p99Ms > LAG_ESCALATE_P99_MS && utilization > LAG_ENTRY_ELU) {
      this.lagPressureActive = true;
      this.lagEscalatedActive = true;
      this.lagEnterTicks = 0;
      this.lagExitWindow = [];
      this.lagPressureStartedAt = Date.now();
      // Emit both events on the same tick: log consumers expect the standard
      // entry signal first, then the escalation signal. The dual-emit keeps
      // the event stream consistent for code that subscribes only to one.
      logInfo("event-loop-lag-detected", {
        p99Ms: Math.round(p99Ms),
        maxMs: Math.round(maxMs),
        utilization: Math.round(utilization * 100) / 100,
      });
      logInfo("event-loop-lag-escalated", {
        p99Ms: Math.round(p99Ms),
        maxMs: Math.round(maxMs),
        utilization: Math.round(utilization * 100) / 100,
      });
      if (this.currentProfile !== "efficiency") {
        this.applyProfile("efficiency");
      }
      return;
    }

    if (p99Ms > LAG_ENTRY_P99_MS && utilization > LAG_ENTRY_ELU) {
      this.lagEnterTicks += 1;
      if (this.lagEnterTicks >= LAG_ENTER_TICKS_REQUIRED) {
        this.lagPressureActive = true;
        this.lagEnterTicks = 0;
        this.lagExitWindow = [];
        this.lagPressureStartedAt = Date.now();
        logInfo("event-loop-lag-detected", {
          p99Ms: Math.round(p99Ms),
          maxMs: Math.round(maxMs),
          utilization: Math.round(utilization * 100) / 100,
        });
        if (this.currentProfile !== "efficiency") {
          this.applyProfile("efficiency");
        }
      }
    } else {
      this.lagEnterTicks = 0;
    }
  }

  private refreshFleetState(): void {
    if (this.disposed) return;
    // Under sustained event-loop saturation, skip the only optional async work
    // in this service. Cached counts are used until pressure clears.
    if (this.lagEscalatedActive) return;

    const ptyClient = this.deps.getPtyClient();
    if (!ptyClient) return;

    // Capture the generation at request time. Any later refresh (or a stop →
    // start cycle) bumps the counter, so when our .then() runs we can detect
    // that a fresher request is in flight and drop our stale result.
    this.refreshGeneration += 1;
    const generation = this.refreshGeneration;

    ptyClient
      .getAllTerminalsAsync()
      .then((terminals) => {
        if (this.disposed) return;
        if (generation !== this.refreshGeneration) return;
        this.cachedActiveAgentCount = this.countActiveAgentTerminals(terminals);
      })
      .catch(() => {
        // PtyClient.getAllTerminalsAsync absorbs IPC failures and resolves
        // with []; this branch only fires for an unexpected throw inside the
        // .then() above. Leave the cache untouched in that case.
      });
  }

  /**
   * Async refresh of the terminal-workload memory sample, mirroring
   * refreshFleetState: fire-and-forget each tick, cached result read
   * synchronously by the scoring path. Reads through the shared rollup TTL
   * cache in memoryAccounting so this adds at most one pty-host round-trip
   * per 5s across all snapshot consumers.
   */
  private refreshTerminalWorkloadState(): void {
    if (this.disposed) return;
    // Under sustained event-loop saturation, skip optional async work — the
    // cached sample is used until it ages past the freshness gate.
    if (this.lagEscalatedActive) return;

    const ptyClient = this.deps.getPtyClient();
    if (!ptyClient) return;

    this.workloadRefreshGeneration += 1;
    const generation = this.workloadRefreshGeneration;

    getCachedMemoryRollup(ptyClient)
      .then((rollup) => {
        if (this.disposed || rollup === null) return;
        if (generation !== this.workloadRefreshGeneration) return;
        this.cachedTerminalWorkload = {
          totalMemoryMb: rollup.totalMemoryKb / 1024,
          available: rollup.available,
          sampledAt: rollup.sampledAt,
        };
      })
      .catch(() => {
        // A PtyClient without the rollup surface (test doubles) or an
        // unexpected throw: leave the cache untouched — no measurement,
        // no contribution.
      });
  }

  private countActiveAgentTerminals(terminals: ActiveAgentTerminalLike[]): number {
    let count = 0;
    for (const t of terminals) {
      if (t.isTrashed) continue;
      // Orphaned terminals whose PTY process exited still carry stale agent
      // metadata. Mirrors ProjectStatsService's per-project active-agent
      // counter — without this, a fleet that exited without being trashed
      // would keep the score pinned to `efficiency` forever.
      if (t.hasPty === false) continue;
      if (!t.agentState || !ACTIVE_AGENT_STATES.has(t.agentState)) continue;
      // Only count terminals with an agent identity. `detectedAgentId` is the
      // strongest signal (runtime-detected). A non-empty `launchAgentId` is
      // accepted only before runtime detection has ever fired — once
      // `everDetectedAgent` is true, missing `detectedAgentId` means the agent
      // exited and we should not double-count the residual shell.
      const hasIdentity =
        Boolean(t.detectedAgentId) || (Boolean(t.launchAgentId) && t.everDetectedAgent !== true);
      if (!hasIdentity) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Read system-wide available memory in MB. Mirrors
   * ProjectViewManager.getAvailableMemoryMb(): on macOS "available" =
   * free + purgeable, because Darwin holds reclaimable pages as purgeable
   * rather than free. On Windows/Linux, `free` alone is accurate. Returns
   * null when the Chromium API is unavailable (e.g., under test mocks).
   */
  private getAvailableSystemMemoryMb(): number | null {
    return readActionableSystemMemoryMb();
  }

  stop(): void {
    powerMonitor.removeListener("thermal-state-change", this.onThermalStateChange);
    powerMonitor.removeListener("speed-limit-change", this.onSpeedLimitChange);
    powerMonitor.removeListener("on-battery", this.onBatteryPower);
    powerMonitor.removeListener("on-ac", this.onAcPower);

    if (this.evalCleanup) {
      this.evalCleanup();
      this.evalCleanup = null;
    }
    if (this.lagInterval) {
      clearInterval(this.lagInterval);
      this.lagInterval = null;
    }
    if (this.lagHistogram) {
      try {
        this.lagHistogram.disable();
      } catch {
        // non-critical
      }
      this.lagHistogram = null;
    }
    this.lagPreviousElu = null;
    this.clearLagPressure();
    this.interactiveOverrideUntil = 0;
    this.cachedTerminalWorkload = null;
    this.terminalWorkloadTier = 0;
    this.thermalState = "unknown";
    this.isOnBattery = false;
    this.speedLimit = 100;
    this.disposed = true;
    logInfo("resource-profile-service-stopped");
  }

  private evaluate(): void {
    this.tickCount++;

    if (this.tickCount <= WARMUP_TICKS) return;

    // While the lag monitor holds the floor at efficiency, don't let memory or
    // worktree-count signals upgrade out of it. Recovery is gated by the lag
    // exit path which clears the flag and re-enables normal scoring.
    if (this.lagPressureActive && this.currentProfile === "efficiency") {
      this.candidateProfile = null;
      this.candidateFirstSeenAt = null;
      return;
    }

    const target = this.computeTargetProfile();

    if (target !== this.currentProfile) {
      if (this.candidateProfile !== target) {
        this.candidateProfile = target;
        this.candidateFirstSeenAt = Date.now();
      } else if (this.candidateFirstSeenAt !== null) {
        const holdMs = this.isUpgrade(target) ? UPGRADE_HOLD_MS : DOWNGRADE_HOLD_MS;
        if (Date.now() - this.candidateFirstSeenAt >= holdMs) {
          this.applyProfile(target);
        }
      }
    } else {
      this.candidateProfile = null;
      this.candidateFirstSeenAt = null;
    }
  }

  private computeTargetProfile(): ResourceProfile {
    return profileForScore(this.computePressureBreakdown().pressureScore);
  }

  /**
   * Additive pressure scoring plus a per-signal breakdown for the "why am I
   * slow?" snapshot (#10910). `computeTargetProfile` reads only the score; the
   * `reasons` are the same signals expressed for humans. Keeping both on one
   * code path guarantees the reported reasons never drift from the decision.
   */
  private computePressureBreakdown(): {
    pressureScore: number;
    reasons: WhySlowResourceReason[];
  } {
    let pressureScore = 0;
    let memoryScore = 0;
    const reasons: WhySlowResourceReason[] = [];

    // Memory signal. Read through the shared snapshot: ProcessMemoryMonitor's
    // poll runs on the same aligned 30s tick (registered earlier) and primes
    // it, so this eval normally reuses that sweep instead of re-scanning the
    // full process table back-to-back.
    try {
      const metrics = getAppMetricsSnapshot();
      let totalPrivateMb = 0;
      for (const proc of metrics) {
        // workingSetSize is the only cross-platform field — privateBytes is
        // Windows-only and returns 0 (not undefined) on macOS/Linux, so the
        // previous `?? workingSetSize` fallback silently never fired there.
        totalPrivateMb += proc.memory.workingSetSize / 1024;
      }

      if (totalPrivateMb > this.memoryThresholdHighMb) {
        memoryScore = 2;
      } else if (totalPrivateMb > this.memoryThresholdLowMb) {
        memoryScore = 1;
      }
      if (memoryScore > 0) {
        reasons.push({
          signal: "memory",
          contribution: memoryScore,
          detail: `app memory ${Math.round(totalPrivateMb)}MB`,
        });
      }
    } catch {
      // Skip memory signal on error — memoryScore stays 0 (correct: no measurement, no clamp)
    }
    pressureScore += memoryScore;

    // Battery signal (cached from startup + transition events)
    if (this.isOnBattery) {
      pressureScore += 1;
      reasons.push({ signal: "battery", contribution: 1, detail: "on battery" });
    }

    // Thermal signal (macOS only)
    if (this.thermalState === "critical") {
      pressureScore += 2;
      reasons.push({ signal: "thermal", contribution: 2, detail: "thermal critical" });
    } else if (this.thermalState === "serious") {
      pressureScore += 1;
      reasons.push({ signal: "thermal", contribution: 1, detail: "thermal serious" });
    }

    // CPU speed-limit signal (macOS & Windows)
    if (this.speedLimit < 50) {
      pressureScore += 2;
      reasons.push({
        signal: "cpuSpeedLimit",
        contribution: 2,
        detail: `cpu speed limit ${this.speedLimit}%`,
      });
    } else if (this.speedLimit < 100) {
      pressureScore += 1;
      reasons.push({
        signal: "cpuSpeedLimit",
        contribution: 1,
        detail: `cpu speed limit ${this.speedLimit}%`,
      });
    }

    // Fleet-size signal (graduated). Counts live agent terminals filtered
    // through ACTIVE_AGENT_STATES rather than worktrees: an idle worktree
    // costs negligible incremental memory, but each running agent runtime
    // (Claude, Gemini, Codex) is hundreds of MB. With a flat +1 at 8, a 24-
    // agent fleet scored identically to an 8-worktree project and could
    // never reach `efficiency` from fleet size alone.
    const agentCount = this.cachedActiveAgentCount;
    let fleetScore = 0;
    if (agentCount >= this.fleetCountCritical) {
      fleetScore = 3;
    } else if (agentCount >= this.fleetCountVeryHigh) {
      fleetScore = 2;
    } else if (agentCount >= this.fleetCountHigh) {
      fleetScore = 1;
    }
    if (fleetScore > 0) {
      pressureScore += fleetScore;
      reasons.push({
        signal: "fleetSize",
        contribution: fleetScore,
        detail: `${agentCount} active agents`,
      });
    }

    // Renderer-saturation signal. The lag monitor watches only the MAIN
    // process event loop; the saturation users actually feel under agent
    // output floods — xterm parse/paint jank — lives in renderer loops and is
    // sampled by ProcessMemoryMonitor's LoAF collection on the same cadence.
    try {
      if (this.deps.hasSustainedRendererSaturation?.()) {
        pressureScore += 1;
        reasons.push({
          signal: "rendererSaturation",
          contribution: 1,
          detail: "sustained renderer saturation",
        });
      }
    } catch {
      // Signal unavailable — score stays unchanged.
    }

    // System-available memory signal. The app-private signal above only sees
    // this process's footprint; if another app on the box is hoarding RAM
    // and the OS is paging, we want to back off even when our own memory
    // looks fine. Mirrors the (free + purgeable) pattern ProjectViewManager
    // already uses for cached-view eviction.
    const sysAvailMb = this.getAvailableSystemMemoryMb();
    if (sysAvailMb !== null) {
      let sysScore = 0;
      if (sysAvailMb < this.sysMemThresholdLowMb) {
        sysScore = 3;
      } else if (sysAvailMb < this.sysMemThresholdHighMb) {
        sysScore = 1;
      }
      if (sysScore > 0) {
        pressureScore += sysScore;
        reasons.push({
          signal: "systemMemory",
          contribution: sysScore,
          detail: `system available ${Math.round(sysAvailMb)}MB`,
        });
      }
    }

    // Terminal-workload signal. Gated on a fresh, successful process-table
    // sweep: an unavailable rollup (ps/PowerShell failed, pty-host down) or a
    // sample past the freshness bound contributes nothing, whatever its
    // magnitude, and drops the hysteresis latch. Tier recomputation is
    // idempotent for a given sample, so the why-slow read path sharing this
    // code can't skew it.
    const workload = this.cachedTerminalWorkload;
    // Negative age = the clock moved backwards (suspend correction, fake
    // timers): reject as not-fresh rather than letting an old sample read as
    // "from the future" and contribute until the clock catches up.
    const workloadAgeMs = workload === null ? null : Date.now() - workload.sampledAt;
    const workloadFresh =
      workload !== null &&
      workload.available &&
      workload.sampledAt > 0 &&
      workloadAgeMs !== null &&
      workloadAgeMs >= 0 &&
      workloadAgeMs <= TERMINAL_WORKLOAD_FRESH_MS;
    if (workloadFresh) {
      const workloadMb = workload.totalMemoryMb;
      const highBar =
        this.terminalWorkloadTier >= 2
          ? this.terminalWorkloadHighMb * TERMINAL_WORKLOAD_EXIT_RATIO
          : this.terminalWorkloadHighMb;
      const lowBar =
        this.terminalWorkloadTier >= 1
          ? this.terminalWorkloadLowMb * TERMINAL_WORKLOAD_EXIT_RATIO
          : this.terminalWorkloadLowMb;
      this.terminalWorkloadTier = workloadMb > highBar ? 2 : workloadMb > lowBar ? 1 : 0;
      if (this.terminalWorkloadTier > 0) {
        pressureScore += this.terminalWorkloadTier;
        reasons.push({
          signal: "terminalWorkloads",
          contribution: this.terminalWorkloadTier,
          detail: `terminal workloads ${Math.round(workloadMb)}MB`,
        });
      }
    } else {
      // Hysteresis only spans consecutive fresh readings. A stale/unavailable
      // gap drops the latch so a post-gap sample re-qualifies at the full
      // entry threshold — otherwise a tier engaged before the gap would let a
      // below-entry value ride the 0.9× exit band back to a higher score.
      this.terminalWorkloadTier = 0;
    }

    return { pressureScore, reasons };
  }

  /**
   * Read-only "why am I slow?" projection (#10910): the active profile, the
   * profile the current pressure would target, the per-signal reasons, and the
   * event-loop-lag latch / interactive-override state that can override scoring.
   */
  getWhySlowResourceSnapshot(): WhySlowResourceSnapshot {
    const { pressureScore, reasons } = this.computePressureBreakdown();
    return {
      currentProfile: this.currentProfile,
      targetProfile: profileForScore(pressureScore),
      pressureScore,
      reasons,
      lagPressureActive: this.lagPressureActive,
      lagEscalatedActive: this.lagEscalatedActive,
      interactiveOverrideActive: this.isInteractiveOverrideActive(),
      thermalState: this.thermalState,
      isOnBattery: this.isOnBattery,
      speedLimit: this.speedLimit,
    };
  }

  private isUpgrade(target: ResourceProfile): boolean {
    const order: ResourceProfile[] = ["efficiency", "balanced", "performance"];
    return order.indexOf(target) > order.indexOf(this.currentProfile);
  }

  private applyProfile(profile: ResourceProfile): void {
    if (this.disposed) return;

    // While an interactive override is active, never drop to efficiency — clamp
    // to balanced. This is the single choke point for ALL transitions, so it
    // catches both the lag-latch entry (sampleLag) and a memory/fleet-driven
    // downgrade (computeTargetProfile) without each needing its own guard.
    if (profile === "efficiency" && this.isInteractiveOverrideActive()) {
      profile = "balanced";
    }

    const previous = this.currentProfile;

    // No-op transition: skip the fan-out + broadcast. This matters for the
    // override redirect above — a scoring-driven efficiency target redirected to
    // balanced while ALREADY balanced would otherwise re-push profile settings
    // and fire resource:profile-changed, churning renderer WebGL/scrollback work
    // during the very interaction the override is protecting. Candidate state is
    // still cleared so the hold machinery doesn't re-fire the same target.
    if (profile === previous) {
      this.candidateProfile = null;
      this.candidateFirstSeenAt = null;
      return;
    }
    this.currentProfile = profile;
    this.candidateProfile = null;
    this.candidateFirstSeenAt = null;

    const config = RESOURCE_PROFILE_CONFIGS[profile];

    logInfo("resource-profile-changed", { from: previous, to: profile });

    // While the window-focus throttle is engaged, polling cadences are owned
    // by the throttle (profile baseline × multiplier). Push multiplied values
    // so a transition landing mid-blur can't silently un-throttle the pollers;
    // the next focus event rewrites baselines from the live profile.
    const pollMultiplier = getFocusThrottlePollMultiplier();

    // Update workspace-host polling intervals
    const workspaceClient = this.deps.getWorkspaceClient();
    if (workspaceClient) {
      try {
        workspaceClient.updateMonitorConfig({
          pollIntervalActive: config.pollIntervalActive * pollMultiplier,
          pollIntervalBackground: config.pollIntervalBackground * pollMultiplier,
          fetchIntervalActiveMs: config.fetchIntervalActiveMs,
          fetchIntervalBackgroundMs: config.fetchIntervalBackgroundMs,
          backgroundGitWatcherCap: config.backgroundGitWatcherCap,
        });
      } catch {
        // non-critical
      }
    }

    // Update HibernationService threshold
    const hibernationService = this.deps.getHibernationService();
    if (hibernationService) {
      try {
        hibernationService.setMemoryPressureThresholdMs(config.memoryPressureInactiveMs);
      } catch {
        // non-critical
      }
    }

    // Notify pty-host
    const ptyClient = this.deps.getPtyClient();
    if (ptyClient) {
      try {
        ptyClient.setResourceProfile(profile);
        if (pollMultiplier !== 1) {
          // set-resource-profile resets the host's process-tree cadence to the
          // profile baseline — re-apply the throttle on top.
          ptyClient.setProcessTreePollInterval(config.processTreePollInterval * pollMultiplier);
        }
      } catch {
        // non-critical
      }
    }

    // Update the terminal-poll cadence. Both services fan out to every pty
    // shard on the same interval, so they move together — leaving one at the
    // fast cadence would keep paying the cost the profile exists to avoid.
    for (const poller of [
      this.deps.getProjectStatsService(),
      this.deps.getFleetSnapshotService?.() ?? null,
    ]) {
      if (!poller) continue;
      try {
        poller.updatePollInterval(config.projectStatsPollInterval * pollMultiplier);
      } catch {
        // non-critical
      }
    }

    // Freeze cached project views under efficiency to reclaim CPU, but never
    // destroy them to reclaim RAM. Destruction is owned exclusively by
    // evictStaleViews()'s memory-pressure band, which contracts the cache
    // only when free RAM is genuinely low (independent of profile). This keeps
    // the user's working set warm under battery/thermal/CPU-only pressure,
    // avoiding cold-start storms when switching among many open projects.
    // Fan out across every open window's PVM so multi-window sessions all
    // honor the profile change, not just the most-recently-created window.
    for (const pvm of this.getProjectViewManagersSafe()) {
      // Split try/catch per call: a throw from setCachedViewLimit (e.g. an
      // onViewEvicted callback failing inside evictStaleViews) must NOT block
      // setEfficiencyFreeze(false) on the exit path — leaving renderers
      // frozen after we've left efficiency has no recovery trigger. The same
      // isolation applies per-PVM: a failure on one window must not skip the
      // remaining windows in the iteration.
      if (profile === "efficiency") {
        try {
          // Freeze cached project views' renderers via CDP under efficiency to
          // suppress timer wake-ups on top of background throttling. PVM
          // debounces the actual freeze pass internally.
          pvm.setEfficiencyFreeze(true);
        } catch {
          // non-critical
        }
      } else if (previous === "efficiency") {
        try {
          pvm.setCachedViewLimit(this.deps.getUserCachedViewLimit());
        } catch {
          // non-critical
        }
        try {
          pvm.setEfficiencyFreeze(false);
        } catch {
          // non-critical
        }
      }
      // The cached-view reclaim band is deliberately NOT pushed here. Every PVM
      // is armed once — at `start()` for existing windows, at
      // `applyCurrentProfileTo()` for each window created later — so no
      // transition can move it, least of all the interactive
      // efficiency→balanced clamp above, which used to swap the active floor
      // 1024→768 at the exact moment memory was lowest (#11469).
      //
      // Re-pushing here would not make the arming self-healing anyway: a no-op
      // transition returns above, and a session sitting at a stable profile
      // never reaches this loop at all. It would, though, silently re-arm the
      // `setLowMemoryFreeThresholdMb(null)` escape hatch that six E2E specs rely
      // on to keep their eviction assertions deterministic.

      // Push per-profile paint-gate timeouts (cold and warm). Both cold
      // starts and warm wake fan-outs run measurably slower under efficiency
      // (memory/thermal/battery pressure), so the bounds stretch with the
      // profile. Each setter wrapped in its own try/catch so a throw from
      // one doesn't skip the others.
      try {
        pvm.setPaintGateTimeoutMs(config.paintGateTimeoutMs);
      } catch {
        // non-critical
      }
      try {
        pvm.setPaintGateHardTimeoutMs(config.paintGateHardTimeoutMs);
      } catch {
        // non-critical
      }
      try {
        pvm.setWarmPaintGateTimeoutMs(config.warmPaintGateTimeoutMs);
      } catch {
        // non-critical
      }
      try {
        pvm.setWarmPaintGateHardTimeoutMs(config.warmPaintGateHardTimeoutMs);
      } catch {
        // non-critical
      }
      // Same rationale for the cold view-load bounds: the main-process
      // contention that selects efficiency also slows the `app://` chunks the
      // incoming renderer is waiting on (#11459).
      try {
        pvm.setViewLoadTimeoutMs(config.viewLoadTimeoutMs);
      } catch {
        // non-critical
      }
      try {
        pvm.setViewLoadHardTimeoutMs(config.viewLoadHardTimeoutMs);
      } catch {
        // non-critical
      }
    }

    // Ask persistent worker subsystems to trim/drain on efficiency ENTRY.
    // Isolated like every other consumer: a throwing (or rejecting) dep must
    // not skip the renderer broadcast below. Downgrades and efficiency-exit
    // transitions deliberately skip this — trims are for pressure, and undoing
    // one is impossible anyway.
    if (profile === "efficiency") {
      try {
        void Promise.resolve(this.deps.requestWorkerTrim?.()).catch(() => {
          // non-critical
        });
      } catch {
        // non-critical
      }
    }

    // Broadcast to renderer. Resolve the full config (base table + RAM-derived
    // WebGL flip thresholds) so the push carries the same thresholds the pull
    // path builds — see resolveResourceProfileConfig (#11192).
    try {
      const payload: ResourceProfilePayload = {
        profile,
        config: resolveResourceProfileConfig(profile),
      };
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "resource:profile-changed", payload });
    } catch {
      // non-critical — window may be closing
    }
  }
}
