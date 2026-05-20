import os from "os";
import { app, powerMonitor } from "electron";
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
  type IntervalHistogram,
} from "node:perf_hooks";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { logInfo } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { HibernationService } from "./HibernationService.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import type { ProjectStatsService } from "./ProjectStatsService.js";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
  type ResourceProfilePayload,
} from "../../shared/types/resourceProfile.js";

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

// Memory-pressure thresholds scale with device RAM so machines with very
// different physical memory behave sensibly. On an 8 GB machine these
// fractions evaluate to ~1229 MB / ~655 MB, preserving the originally-tuned
// behavior; on a 64 GB machine they scale up to ~9830 MB / ~5243 MB, which
// stops false "efficiency" drops when the app has plenty of headroom.
const HIGH_FRACTION = 0.15;
const LOW_FRACTION = 0.08;
const WORKTREE_COUNT_HIGH = 8;

export interface ResourceProfileDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getHibernationService: () => HibernationService | null;
  getProjectViewManager: () => ProjectViewManager | null;
  getProjectStatsService: () => ProjectStatsService | null;
  getUserCachedViewLimit: () => number;
}

export class ResourceProfileService {
  private currentProfile: ResourceProfile = "balanced";
  private candidateProfile: ResourceProfile | null = null;
  private candidateFirstSeenAt: number | null = null;
  private evalCleanup: (() => void) | null = null;
  private tickCount = 0;
  private disposed = false;
  private cachedWorktreeCount = 0;
  private thermalState: "unknown" | "nominal" | "fair" | "serious" | "critical" = "unknown";
  private speedLimit = 100;
  private isOnBattery = false;
  private readonly memoryThresholdHighMb: number;
  private readonly memoryThresholdLowMb: number;
  private lagInterval: NodeJS.Timeout | null = null;
  private lagHistogram: IntervalHistogram | null = null;
  private lagPreviousElu: EventLoopUtilization | null = null;
  private lagPressureActive = false;
  private lagEscalatedActive = false;
  private lagEnterTicks = 0;
  private lagExitWindow: boolean[] = [];
  private lagPressureStartedAt: number | null = null;

  constructor(private deps: ResourceProfileDeps) {
    const totalRamMb = os.totalmem() / 1024 / 1024;
    this.memoryThresholdHighMb = totalRamMb * HIGH_FRACTION;
    this.memoryThresholdLowMb = totalRamMb * LOW_FRACTION;
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

  setWorktreeCount(count: number): void {
    this.cachedWorktreeCount = count;
  }

  getProfile(): ResourceProfile {
    return this.currentProfile;
  }

  start(): void {
    if (this.evalCleanup) return;
    this.disposed = false;
    this.tickCount = 0;
    this.candidateProfile = null;
    this.candidateFirstSeenAt = null;

    logInfo("resource-profile-service-started", { profile: this.currentProfile });

    this.refreshWorktreeCount();

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
      this.refreshWorktreeCount();
      this.evaluate();
    }, EVAL_INTERVAL_MS);

    // Push the initial profile's low-memory floor so the feature is armed on
    // launch even when the service stays on its default profile (`balanced`)
    // and applyProfile() never runs.
    const pvm = this.deps.getProjectViewManager();
    if (pvm) {
      try {
        pvm.setLowMemoryFreeThresholdMb(
          RESOURCE_PROFILE_CONFIGS[this.currentProfile].lowMemoryFreeThresholdMb
        );
      } catch {
        // non-critical
      }
    }

    this.startLagMonitor();
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

  private refreshWorktreeCount(): void {
    if (this.disposed) return;
    // Under sustained event-loop saturation, skip the only optional async work
    // in this service. Cached count is used until pressure clears.
    if (this.lagEscalatedActive) return;
    const workspaceClient = this.deps.getWorkspaceClient();
    if (!workspaceClient) return;
    workspaceClient
      .getAllStatesAsync()
      .then((states) => {
        if (this.disposed) return;
        this.cachedWorktreeCount = states.length;
      })
      .catch(() => {
        // non-critical — use last known count
      });
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
    let pressureScore = 0;

    // Memory signal
    try {
      const metrics = app.getAppMetrics();
      let totalPrivateMb = 0;
      for (const proc of metrics) {
        totalPrivateMb += (proc.memory.privateBytes ?? proc.memory.workingSetSize) / 1024;
      }

      if (totalPrivateMb > this.memoryThresholdHighMb) {
        pressureScore += 2;
      } else if (totalPrivateMb > this.memoryThresholdLowMb) {
        pressureScore += 1;
      }
    } catch {
      // Skip memory signal on error
    }

    // Battery signal (cached from startup + transition events)
    if (this.isOnBattery) {
      pressureScore += 1;
    }

    // Thermal signal (macOS only)
    if (this.thermalState === "critical") pressureScore += 2;
    else if (this.thermalState === "serious") pressureScore += 1;

    // CPU speed-limit signal (macOS & Windows)
    if (this.speedLimit < 50) pressureScore += 2;
    else if (this.speedLimit < 100) pressureScore += 1;

    // Worktree count signal
    const worktreeCount = this.cachedWorktreeCount;
    if (worktreeCount >= WORKTREE_COUNT_HIGH) {
      pressureScore += 1;
    }

    if (pressureScore >= 3) return "efficiency";
    if (pressureScore === 0) return "performance";
    return "balanced";
  }

  private isUpgrade(target: ResourceProfile): boolean {
    const order: ResourceProfile[] = ["efficiency", "balanced", "performance"];
    return order.indexOf(target) > order.indexOf(this.currentProfile);
  }

  private applyProfile(profile: ResourceProfile): void {
    if (this.disposed) return;

    const previous = this.currentProfile;
    this.currentProfile = profile;
    this.candidateProfile = null;
    this.candidateFirstSeenAt = null;

    const config = RESOURCE_PROFILE_CONFIGS[profile];

    logInfo("resource-profile-changed", { from: previous, to: profile });

    // Update workspace-host polling intervals
    const workspaceClient = this.deps.getWorkspaceClient();
    if (workspaceClient) {
      try {
        workspaceClient.updateMonitorConfig({
          pollIntervalActive: config.pollIntervalActive,
          pollIntervalBackground: config.pollIntervalBackground,
          fetchIntervalActiveMs: config.fetchIntervalActiveMs,
          fetchIntervalBackgroundMs: config.fetchIntervalBackgroundMs,
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
      } catch {
        // non-critical
      }
    }

    // Update project stats polling cadence
    const statsService = this.deps.getProjectStatsService();
    if (statsService) {
      try {
        statsService.updatePollInterval(config.projectStatsPollInterval);
      } catch {
        // non-critical
      }
    }

    // Adjust cached project view limit under memory pressure.
    // Cached WebContentsViews cost ~100–500 MB RSS each (full Chromium renderer),
    // so clamping to 1 on efficiency reclaims the largest memory chunk available.
    // NOTE: only reaches the primary window's PVM (single-window scope) — mirrors
    // the existing PtyClient/HibernationService ref pattern.
    const pvm = this.deps.getProjectViewManager();
    if (pvm) {
      // Split try/catch per call: a throw from setCachedViewLimit (e.g. an
      // onViewEvicted callback failing inside evictStaleViews) must NOT block
      // setEfficiencyFreeze(false) on the exit path — leaving renderers
      // frozen after we've left efficiency has no recovery trigger.
      if (profile === "efficiency") {
        try {
          pvm.setCachedViewLimit(1);
        } catch {
          // non-critical
        }
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
      // Push the profile's low-memory floor unconditionally on every transition
      // so an upgrade out of efficiency doesn't leave the stricter threshold
      // stuck in place. PVM checks this floor inside `evictStaleViews` and
      // clamps `effectiveMax` to 1 for the pass when available RAM drops below
      // it, without mutating the user-configured `maxCachedViews`.
      try {
        pvm.setLowMemoryFreeThresholdMb(config.lowMemoryFreeThresholdMb);
      } catch {
        // non-critical
      }
    }

    // Broadcast to renderer
    try {
      const payload: ResourceProfilePayload = { profile, config };
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "resource:profile-changed", payload });
    } catch {
      // non-critical — window may be closing
    }
  }
}
