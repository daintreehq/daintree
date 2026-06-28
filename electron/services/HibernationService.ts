// eager-import-allow: reads hibernation settings via store.get synchronously
import { readdir, stat } from "fs/promises";
import path from "path";
import { ACTIVE_AGENT_STATES } from "../../shared/types/agent.js";
import type { HibernationProjectHibernatedPayload } from "../../shared/types/ipc/hibernation.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { getPtyClient } from "../window/serviceRefs.js";

export interface HibernationConfig {
  enabled: boolean;
  inactiveThresholdHours: number;
}

/** Runtime hibernation state surfaced in the diagnostics export (#10500). */
export interface HibernationSnapshot {
  config: HibernationConfig;
  /** True while the scheduled-check interval is armed (service is running). */
  isRunning: boolean;
  /** Inactivity window before a background project is eligible under memory pressure, in ms. */
  memoryPressureThresholdMs: number;
}

const DEFAULT_CONFIG: HibernationConfig = {
  enabled: false,
  inactiveThresholdHours: 24,
};

const DEFAULT_MEMORY_PRESSURE_INACTIVE_MS = 30 * 60 * 1000;
const GIT_SENTINEL_NAMES = new Set([
  "index.lock",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
]);
/**
 * HibernationService - Auto-hibernates inactive projects to free resources.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Why this pattern:
 * - Requires lazy initialization: depends on PtyManager which uses dynamic import
 * - Has explicit lifecycle (start/stop) that callers control
 * - Singleton with deferred construction: getHibernationService() + initializeHibernationService()
 * - Factory separates creation from start(), allowing config check at runtime
 *
 * When to use Pattern C:
 * - Service has circular or dynamic dependencies (import() at runtime)
 * - Lazy initialization saves startup time if service isn't always needed
 * - Explicit dispose() method pairs with factory for resource management
 * - Initialization timing matters (must wait for other services to be ready)
 */
export class HibernationService {
  // EXPERIMENT (hibernation removal, step 4): disables the PTY-kill so a
  // backgrounded project's terminals are never torn down — by the scheduled
  // sweep (checkAndHibernate), under memory pressure (hibernateUnderMemoryPressure),
  // or on demand (hibernateProjectOnDemand). All three funnel through the single
  // `gracefulKillByProject` chokepoint in hibernateProject(), guarded below.
  // The rest of the flow (callbacks, the project-hibernated event, and the
  // user-initiated WebContentsView eviction we KEEP) is preserved. Typed
  // `boolean` (not the `true` literal) so the kill branch stays type-reachable
  // for the step-7 deletion; flip to `false` to revert.
  private static readonly EXPERIMENT_HIBERNATION_DISABLED: boolean = true;

  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // Every hour
  private readonly hibernationCallbacks: Array<(projectId: string) => void | Promise<void>> = [];
  private memoryPressureInactiveMs = DEFAULT_MEMORY_PRESSURE_INACTIVE_MS;
  private ptyClient: PtyClient | null = null;
  private projectViewManagersProvider: (() => ProjectViewManager[]) | null = null;

  /**
   * Inject the live PtyClient so hibernation reads the real terminal registry
   * in the pty-host process and routes kills through it. The main-process
   * `getPtyManager()` singleton is never populated (#10054). Passing `null`
   * clears the reference on shutdown.
   */
  setPtyClient(client: PtyClient | null): void {
    this.ptyClient = client;
  }

  /**
   * Inject a lazy provider over every open window's ProjectViewManager so
   * user-initiated hibernation can evict the hibernated project's cached
   * `WebContentsView` renderer (#10668) — the bulk of per-project memory that
   * killing PTYs alone leaves resident. Mirrors the `getAllProjectViewManagers`
   * lambda `ResourceProfileService` uses. Must stay lazy: windows open/close
   * after wiring. NOT cleared in stop(): it's a stateless closure over the
   * window registry (no stale object pinned), and the user-initiated close path
   * stays reachable even when scheduled hibernation is toggled off.
   */
  setProjectViewManagersProvider(provider: (() => ProjectViewManager[]) | null): void {
    this.projectViewManagersProvider = provider;
  }

  setMemoryPressureThresholdMs(ms: number): void {
    // Reject non-finite/negative values: they'd otherwise surface in the
    // diagnostics snapshot (NaN coerces to null in JSON) and silently mislead.
    if (!Number.isFinite(ms) || ms < 0) return;
    this.memoryPressureInactiveMs = ms;
  }

  onProjectHibernated(callback: (projectId: string) => void | Promise<void>): () => void {
    this.hibernationCallbacks.push(callback);
    return () => {
      const idx = this.hibernationCallbacks.indexOf(callback);
      if (idx >= 0) this.hibernationCallbacks.splice(idx, 1);
    };
  }

  private normalizeThreshold(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(1, Math.min(168, Math.round(value)));
  }

  private normalizeConfig(value: unknown): HibernationConfig {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    const candidate = (raw ?? {}) as {
      enabled?: unknown;
      inactiveThresholdHours?: unknown;
    };

    return {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_CONFIG.enabled,
      inactiveThresholdHours: this.normalizeThreshold(
        candidate.inactiveThresholdHours,
        DEFAULT_CONFIG.inactiveThresholdHours
      ),
    };
  }

  private async hasActiveGitOperation(
    projectPath: string,
    staleThresholdMs: number
  ): Promise<boolean> {
    const mainGitDir = path.join(projectPath, ".git");
    const gitDirs = [mainGitDir];

    try {
      const worktreeEntries = await readdir(path.join(mainGitDir, "worktrees"), {
        withFileTypes: true,
      });
      for (const entry of worktreeEntries) {
        if (entry.isDirectory()) {
          gitDirs.push(path.join(mainGitDir, "worktrees", entry.name));
        }
      }
    } catch {
      // No linked worktrees or .git/worktrees doesn't exist
    }

    for (const gitDir of gitDirs) {
      try {
        const entries = await readdir(gitDir);
        const sentinels = entries.filter((e) => GIT_SENTINEL_NAMES.has(e));

        for (const sentinel of sentinels) {
          if (sentinel === "index.lock") {
            try {
              const lockStat = await stat(path.join(gitDir, sentinel));
              if (Date.now() - lockStat.mtimeMs < staleThresholdMs) {
                return true;
              }
            } catch {
              // Lock disappeared between readdir and stat — not active
            }
          } else {
            return true;
          }
        }
      } catch {
        // gitdir doesn't exist or isn't readable — skip
      }
    }

    return false;
  }

  start(): void {
    if (this.checkInterval) return;

    // Re-acquire the PtyClient on (re)start — stop() clears it, so a Settings
    // toggle off→on would otherwise leave checkAndHibernate() guarded-out forever.
    this.ptyClient ??= getPtyClient();

    const config = this.getConfig();
    if (!config.enabled) {
      logInfo("auto-hibernation-disabled");
      return;
    }

    logInfo("auto-hibernation-started");

    this.checkInterval = setInterval(() => {
      void this.checkAndHibernate().catch((error) => {
        logError("auto-hibernation-check-failed", error);
      });
    }, this.CHECK_INTERVAL_MS);

    // Initial check on start (delayed to let services fully initialize)
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
    }

    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.checkAndHibernate().catch((error) => {
        logError("auto-hibernation-initial-check-failed", error);
      });
    }, 5000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logInfo("auto-hibernation-stopped");
    }

    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }

    // Clear the injected PtyClient ref on shutdown so we don't pin a stale
    // host client across a restart (lesson #8637).
    this.ptyClient = null;
  }

  private async checkAndHibernate(): Promise<void> {
    const config = this.getConfig();

    if (!config.enabled) {
      return;
    }

    const currentProjectId = projectStore.getCurrentProjectId();
    const projects = projectStore.getAllProjects();
    const now = Date.now();
    const thresholdMs = config.inactiveThresholdHours * 60 * 60 * 1000;

    if (!this.ptyClient) return;
    const ptyClient = this.ptyClient;
    const allTerminals = await ptyClient.getAllTerminalsAsync();

    for (const project of projects) {
      // Never hibernate the active project
      if (project.id === currentProjectId) continue;

      // Skip projects with missing/invalid lastOpened to avoid treating them as infinitely inactive
      if (!project.lastOpened) continue;

      // Check if project has been inactive long enough
      const inactiveDuration = now - project.lastOpened;
      if (inactiveDuration < thresholdMs) continue;

      // Check if project has running terminals
      const projectTerminals = allTerminals.filter((t) => t.projectId === project.id);
      if (projectTerminals.length === 0) continue;

      // Skip projects with active AI agents
      const hasActiveAgent = projectTerminals.some(
        (t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
      );
      if (hasActiveAgent) {
        logInfo("scheduled-hibernate-skip-active-agent", {
          project: project.name,
          projectId: project.id,
        });
        continue;
      }

      // Skip projects with in-progress git operations
      if (await this.hasActiveGitOperation(project.path, thresholdMs)) {
        logInfo("scheduled-hibernate-skip-git-operation", {
          project: project.name,
          projectId: project.id,
        });
        continue;
      }

      const hoursInactive = Math.floor(inactiveDuration / 3600000);
      logInfo("scheduled-hibernate-project", {
        project: project.name,
        projectId: project.id,
        hoursInactive,
        terminalCount: projectTerminals.length,
      });

      try {
        const terminalsKilled = await this.hibernateProject(
          project.id,
          project.name,
          "scheduled",
          ptyClient
        );

        logInfo("scheduled-hibernate-complete", {
          project: project.name,
          projectId: project.id,
          terminalsKilled,
        });
      } catch (error) {
        logError("scheduled-hibernate-failed", error, {
          project: project.name,
          projectId: project.id,
        });
      }
    }
  }

  async hibernateUnderMemoryPressure(): Promise<void> {
    const currentProjectId = projectStore.getCurrentProjectId();
    const projects = projectStore.getAllProjects();
    const now = Date.now();

    if (!this.ptyClient) return;
    const ptyClient = this.ptyClient;
    const allTerminals = await ptyClient.getAllTerminalsAsync();

    for (const project of projects) {
      if (project.id === currentProjectId) continue;

      if (!project.lastOpened) continue;

      const inactiveDuration = now - project.lastOpened;
      if (inactiveDuration < this.memoryPressureInactiveMs) continue;

      const projectTerminals = allTerminals.filter((t) => t.projectId === project.id);
      if (projectTerminals.length === 0) continue;

      const hasActiveAgent = projectTerminals.some(
        (t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
      );
      if (hasActiveAgent) continue;

      if (await this.hasActiveGitOperation(project.path, this.memoryPressureInactiveMs)) {
        logInfo("memory-pressure-hibernate-skip-git-operation", {
          project: project.name,
          projectId: project.id,
        });
        continue;
      }

      logInfo("memory-pressure-hibernate-project", {
        project: project.name,
        projectId: project.id,
        inactiveMinutes: Math.floor(inactiveDuration / 60000),
        terminalCount: projectTerminals.length,
      });

      try {
        await this.hibernateProject(project.id, project.name, "memory-pressure", ptyClient);
      } catch (error) {
        logError("memory-pressure-hibernate-failed", error, {
          project: project.name,
          projectId: project.id,
        });
      }
    }
  }

  /**
   * Public entry point for hibernating a project on demand (e.g. from the
   * idle-terminal "Close Them" action). Routes through the injected PtyClient
   * and runs the same flow as scheduled hibernation so DevPreview callbacks
   * fire and the renderer sees the standard `hibernation:project-hibernated`
   * event. No-op if the PtyClient has not been injected yet.
   *
   * Defaults to `"user-initiated"` — this entry point is only reached through
   * explicit user actions, which (unlike scheduled/memory-pressure hibernation)
   * also evict the project's cached renderer (#10668).
   */
  async hibernateProjectOnDemand(
    projectId: string,
    projectName: string,
    reason: "scheduled" | "memory-pressure" | "user-initiated" = "user-initiated"
  ): Promise<number> {
    if (!this.ptyClient) return 0;
    return this.hibernateProject(projectId, projectName, reason, this.ptyClient);
  }

  private async hibernateProject(
    projectId: string,
    projectName: string,
    reason: "scheduled" | "memory-pressure" | "user-initiated",
    ptyClient: PtyClient
  ): Promise<number> {
    // EXPERIMENT (hibernation removal, step 4): skip the PTY-kill so backgrounded
    // projects' terminals stay fully alive; report 0 killed. The kill branch is
    // kept reachable so ptyClient/gracefulKillByProject stay referenced.
    const results = HibernationService.EXPERIMENT_HIBERNATION_DISABLED
      ? []
      : await ptyClient.gracefulKillByProject(projectId, { preserveSession: true });
    const terminalsKilled = results.length;

    // Write hibernation markers for each killed terminal
    for (const result of results) {
      writeHibernatedMarker(result.id);
    }

    // Invoke registered callbacks (e.g., DevPreview cleanup)
    await Promise.allSettled(this.hibernationCallbacks.map((cb) => Promise.resolve(cb(projectId))));

    // Emit event to renderer
    const payload: HibernationProjectHibernatedPayload = {
      projectId,
      projectName,
      reason,
      terminalsKilled,
      timestamp: Date.now(),
    };
    try {
      broadcastToRenderer(CHANNELS.HIBERNATION_PROJECT_HIBERNATED, payload);
    } catch {
      // Window may be closing
    }

    // Only explicit/user-initiated hibernation evicts the cached project
    // renderer (#10668). Scheduled and memory-pressure hibernation stay
    // conservative — they silently turn a warm project cold, and renderer
    // reclaim under pressure is already owned by ResourceProfileService's
    // setCachedViewLimit(1) path. Killing PTYs alone leaves ~240 MB of
    // Chromium renderer resident per project, so without this hibernation
    // appears to free almost nothing.
    if (reason === "user-initiated") {
      this.evictProjectRenderer(projectId);
    }

    return terminalsKilled;
  }

  /**
   * Tear down the hibernated project's cached `WebContentsView` across every
   * open window. `destroyView` runs the full `cleanupEntry` teardown — detach,
   * listener removal, port cleanup, `webContents.close()` — and is a no-op when
   * the project has no cached view in that window. No-op if the provider has not
   * been wired yet.
   *
   * Skips any window where the project is on-screen: the active/foreground view,
   * or the still-visible anti-flash bridge of an open paint gate (during a cold
   * switch the outgoing project stays painted until the gate settles, even
   * though `activeProjectId` already points at the incoming project). Destroying
   * either would expose a blank/unpainted frame. Both guards are per-manager —
   * each window tracks its own active and outgoing project.
   *
   * Public so the user-initiated `project:free-memory` IPC handler can reclaim
   * the renderer directly without routing through the (experiment-gated)
   * `hibernateProject` PTY-kill path. Returns the number of windows whose
   * cached view was torn down.
   */
  evictProjectRenderer(projectId: string): number {
    const provider = this.projectViewManagersProvider;
    if (!provider) return 0;

    let managers: ProjectViewManager[];
    try {
      managers = provider();
    } catch (error) {
      // windowRegistry may be tearing down — eviction is best-effort.
      logError("user-initiated-hibernate-evict-provider-failed", error, { projectId });
      return 0;
    }

    let evictedViewCount = 0;
    for (const manager of managers) {
      try {
        if (
          manager.getActiveProjectId() === projectId ||
          manager.getOutgoingBridgeProjectId() === projectId
        ) {
          continue;
        }
        if (manager.destroyView(projectId)) {
          evictedViewCount++;
        }
      } catch (error) {
        // A disposing/closing ProjectViewManager can throw inside cleanupEntry.
        // Isolate per window so one failure doesn't skip the rest (#8607).
        logError("user-initiated-hibernate-evict-failed", error, { projectId });
      }
    }

    if (evictedViewCount > 0) {
      logInfo("user-initiated-hibernate-renderer-evicted", { projectId, evictedViewCount });
    }

    return evictedViewCount;
  }

  getConfig(): HibernationConfig {
    return this.normalizeConfig(store.get("hibernation"));
  }

  /**
   * Read-only runtime snapshot for the diagnostics export (#10500). The service
   * keeps no per-project hibernation records — it kills PTYs and forgets — so
   * the diagnostic value is the config plus whether the scheduler is live and
   * the memory-pressure inactivity window currently in effect.
   */
  getSnapshot(): HibernationSnapshot {
    return {
      config: this.getConfig(),
      isRunning: this.checkInterval !== null,
      memoryPressureThresholdMs: this.memoryPressureInactiveMs,
    };
  }

  updateConfig(config: Partial<HibernationConfig>): void {
    const current = this.getConfig();

    if (typeof config.enabled === "boolean") {
      current.enabled = config.enabled;
    }
    if (config.inactiveThresholdHours !== undefined) {
      current.inactiveThresholdHours = this.normalizeThreshold(
        config.inactiveThresholdHours,
        current.inactiveThresholdHours
      );
    }

    store.set("hibernation", current);

    // Restart/stop checks based on enabled state
    const currentConfig = this.getConfig();
    if (currentConfig.enabled) {
      if (!this.checkInterval) {
        this.start();
      }
    } else {
      this.stop();
    }

    logInfo("hibernation-config-updated", { ...this.getConfig() });
  }
}

let hibernationService: HibernationService | null = null;

export function getHibernationService(): HibernationService {
  if (!hibernationService) {
    hibernationService = new HibernationService();
  }
  return hibernationService;
}

export function initializeHibernationService(): HibernationService {
  const service = getHibernationService();
  service.setPtyClient(getPtyClient());
  service.start();
  return service;
}
