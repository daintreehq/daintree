import { app, powerMonitor } from "electron";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { logInfo } from "../utils/logger.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { HibernationService } from "./HibernationService.js";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
  type ResourceProfilePayload,
} from "../../shared/types/resourceProfile.js";

const EVAL_INTERVAL_MS = 30_000;
const DOWNGRADE_HOLD_MS = 30_000;
const UPGRADE_HOLD_MS = 60_000;
const WARMUP_TICKS = 2;

const MEMORY_THRESHOLD_HIGH_MB = 1200;
const MEMORY_THRESHOLD_LOW_MB = 600;
const WORKTREE_COUNT_HIGH = 8;

export interface ResourceProfileDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getHibernationService: () => HibernationService | null;
}

export class ResourceProfileService {
  private currentProfile: ResourceProfile = "balanced";
  private candidateProfile: ResourceProfile | null = null;
  private candidateFirstSeenAt: number | null = null;
  private interval: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private disposed = false;
  private cachedWorktreeCount = 0;

  constructor(private deps: ResourceProfileDeps) {}

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
    this.interval = setInterval(() => {
      this.refreshWorktreeCount();
      this.evaluate();
    }, EVAL_INTERVAL_MS);
    this.interval.unref();
  }

  private refreshWorktreeCount(): void {
    if (this.disposed) return;
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
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.disposed = true;
    logInfo("resource-profile-service-stopped");
  }

  private evaluate(): void {
    this.tickCount++;

    if (this.tickCount <= WARMUP_TICKS) return;

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

      if (totalPrivateMb > MEMORY_THRESHOLD_HIGH_MB) {
        pressureScore += 2;
      } else if (totalPrivateMb > MEMORY_THRESHOLD_LOW_MB) {
        pressureScore += 1;
      }
    } catch {
      // Skip memory signal on error
    }

    // Battery signal
    try {
      if (powerMonitor.isOnBatteryPower()) {
        pressureScore += 2;
      }
    } catch {
      // Skip battery signal (may throw in utility process context)
    }

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

    // Broadcast to renderer
    try {
      const payload: ResourceProfilePayload = { profile, config };
      broadcastToRenderer(CHANNELS.RESOURCE_PROFILE_CHANGED, payload);
    } catch {
      // non-critical — window may be closing
    }
  }
}
