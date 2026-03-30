import { readdir, stat } from "fs/promises";
import path from "path";
import type { AgentState } from "../../shared/types/agent.js";
import type { HibernationProjectHibernatedPayload } from "../../shared/types/ipc/hibernation.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";

export interface HibernationConfig {
  enabled: boolean;
  inactiveThresholdHours: number;
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
const ACTIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set([
  "working",
  "running",
  "waiting",
  "directing",
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
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // Every hour
  private readonly hibernationCallbacks: Array<(projectId: string) => void | Promise<void>> = [];
  private memoryPressureInactiveMs = DEFAULT_MEMORY_PRESSURE_INACTIVE_MS;

  setMemoryPressureThresholdMs(ms: number): void {
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

    // Dynamically import to avoid circular dependencies
    const { getPtyManager } = await import("./PtyManager.js");

    const ptyManager = getPtyManager();
    const allTerminals = ptyManager.getAll();

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
          ptyManager
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

    const { getPtyManager } = await import("./PtyManager.js");
    const ptyManager = getPtyManager();
    const allTerminals = ptyManager.getAll();

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
        await this.hibernateProject(project.id, project.name, "memory-pressure", ptyManager);
      } catch (error) {
        logError("memory-pressure-hibernate-failed", error, {
          project: project.name,
          projectId: project.id,
        });
      }
    }
  }

  private async hibernateProject(
    projectId: string,
    projectName: string,
    reason: "scheduled" | "memory-pressure",
    ptyManager: {
      gracefulKillByProject: (
        id: string,
        opts?: { preserveSession?: boolean }
      ) => Promise<Array<{ id: string; agentSessionId: string | null }>>;
    }
  ): Promise<number> {
    const results = await ptyManager.gracefulKillByProject(projectId, { preserveSession: true });
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

    return terminalsKilled;
  }

  getConfig(): HibernationConfig {
    return this.normalizeConfig(store.get("hibernation"));
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
  service.start();
  return service;
}
