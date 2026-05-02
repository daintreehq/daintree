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
const UPGRADE_HOLD_MS = 60_000;
const WARMUP_TICKS = 2;

// Active event-loop-lag mitigation. The diagnostics handler reads a separate
// lifetime histogram for IPC; this service owns its own histogram and resets
// it after each tumbling window so percentile() reflects only the recent slice.
// p99 is biased low by monitorEventLoopDelay (a long block records as a single
// large sample, not many) — thresholds are conservative to compensate.
// AND-gating with eventLoopUtilization rejects GC-pause false positives: a
// genuine sustained-saturation event has both high tail latency AND high loop
// occupancy. ELU alone doesn't catch periodic long sync work; p99 alone trips
// on isolated GC stalls.
const LAG_SAMPLE_INTERVAL_MS = 5_000;
const LAG_HISTOGRAM_RESOLUTION_MS = 10;
const LAG_ENTRY_P99_MS = 250;
const LAG_ENTRY_ELU = 0.7;
const LAG_ESCALATE_P99_MS = 500;
const LAG_EXIT_P99_MS = 150;
const LAG_ENTER_TICKS_REQUIRED = 2; // 10s sustained
const LAG_EXIT_TICKS_REQUIRED = 6; // 30s clean

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
  private interval: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private disposed = false;
  private cachedWorktreeCount = 0;
  private thermalState: "unknown" | "nominal" | "fair" | "serious" | "critical" = "unknown";
  private speedLimit = 100;
  private readonly memoryThresholdHighMb: number;
  private readonly memoryThresholdLowMb: number;
  private lagInterval: NodeJS.Timeout | null = null;
  private lagHistogram: IntervalHistogram | null = null;
  private lagPreviousElu: EventLoopUtilization | null = null;
  private lagPressureActive = false;
  private lagEscalatedActive = false;
  private lagEnterTicks = 0;
  private lagExitTicks = 0;

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

  setWorktreeCount(count: number): void {
    this.cachedWorktreeCount = count;
  }

  getProfile(): ResourceProfile {
    return this.currentProfile;
  }

  start(): void {
    if (this.interval) return;
    this.disposed = false;

    logInfo("resource-profile-service-started", { profile: this.currentProfile });

    this.refreshWorktreeCount();

    powerMonitor.on("thermal-state-change", this.onThermalStateChange);
    powerMonitor.on("speed-limit-change", this.onSpeedLimitChange);

    this.interval = setInterval(() => {
      this.refreshWorktreeCount();
      this.evaluate();
    }, EVAL_INTERVAL_MS);
    this.interval.unref();

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

  private sampleLag(): void {
    if (this.disposed || !this.lagHistogram) return;

    let p99Ms = 0;
    try {
      const raw = this.lagHistogram.percentile(99) / 1_000_000;
      if (Number.isFinite(raw)) p99Ms = raw;
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

    // Exit path runs first: a window that drops below 150ms while degraded
    // counts toward recovery even if it would also satisfy the entry condition
    // on a separate cycle.
    if (this.lagPressureActive) {
      if (p99Ms < LAG_EXIT_P99_MS) {
        this.lagExitTicks += 1;
        if (this.lagExitTicks >= LAG_EXIT_TICKS_REQUIRED) {
          this.lagPressureActive = false;
          this.lagEscalatedActive = false;
          this.lagEnterTicks = 0;
          this.lagExitTicks = 0;
          logInfo("event-loop-lag-cleared", { p99Ms: Math.round(p99Ms) });
        }
        return;
      }
      this.lagExitTicks = 0;

      if (p99Ms > LAG_ESCALATE_P99_MS && !this.lagEscalatedActive) {
        this.lagEscalatedActive = true;
        logInfo("event-loop-lag-escalated", {
          p99Ms: Math.round(p99Ms),
          utilization: Math.round(utilization * 100) / 100,
        });
      }
      return;
    }

    if (p99Ms > LAG_ENTRY_P99_MS && utilization > LAG_ENTRY_ELU) {
      this.lagEnterTicks += 1;
      if (this.lagEnterTicks >= LAG_ENTER_TICKS_REQUIRED) {
        this.lagPressureActive = true;
        this.lagEnterTicks = 0;
        logInfo("event-loop-lag-detected", {
          p99Ms: Math.round(p99Ms),
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

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
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
    this.lagPressureActive = false;
    this.lagEscalatedActive = false;
    this.lagEnterTicks = 0;
    this.lagExitTicks = 0;
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

    // Battery signal
    try {
      if (powerMonitor.isOnBatteryPower()) {
        pressureScore += 1;
      }
    } catch {
      // Skip battery signal (may throw in utility process context)
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
    // TODO: memory-pressure eviction bypasses the browser/dev-preview state-capture
    // flow used in project-switch-initiated eviction (see issue #5009).
    const pvm = this.deps.getProjectViewManager();
    if (pvm) {
      try {
        if (profile === "efficiency") {
          pvm.setCachedViewLimit(1);
        } else if (previous === "efficiency") {
          pvm.setCachedViewLimit(this.deps.getUserCachedViewLimit());
        }
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
