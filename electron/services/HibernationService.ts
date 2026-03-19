import { readdir, stat } from "fs/promises";
import path from "path";
import type { AgentState } from "../../shared/types/agent.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { logInfo, logError } from "../utils/logger.js";

export interface HibernationConfig {
  enabled: boolean;
  inactiveThresholdHours: number;
}

const DEFAULT_CONFIG: HibernationConfig = {
  enabled: false,
  inactiveThresholdHours: 24,
};

const MEMORY_PRESSURE_INACTIVE_MS = 30 * 60 * 1000;
const GIT_SENTINEL_NAMES = new Set([
  "index.lock",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
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
      console.log("[HibernationService] Auto-hibernation disabled, not starting checks");
      return;
    }

    console.log("[HibernationService] Starting auto-hibernation checks");

    this.checkInterval = setInterval(() => {
      void this.checkAndHibernate().catch((error) => {
        console.error("[HibernationService] Check failed:", error);
      });
    }, this.CHECK_INTERVAL_MS);

    // Initial check on start (delayed to let services fully initialize)
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
    }

    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.checkAndHibernate().catch((error) => {
        console.error("[HibernationService] Initial check failed:", error);
      });
    }, 5000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log("[HibernationService] Stopped auto-hibernation checks");
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
      console.log(
        `[HibernationService] Auto-hibernating project "${project.name}" ` +
          `(inactive for ${hoursInactive} hours, ${projectTerminals.length} processes)`
      );

      try {
        // Gracefully kill terminals (allows agents to print session IDs before dying).
        // Project state (state.json) is preserved so terminal IDs remain valid
        // for matching .restore snapshot files on re-open.
        const results = await ptyManager.gracefulKillByProject(project.id);
        const terminalsKilled = results.length;

        console.log(
          `[HibernationService] Hibernated "${project.name}": ${terminalsKilled} terminals killed`
        );
      } catch (error) {
        console.error(`[HibernationService] Failed to hibernate project "${project.name}":`, error);
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
      if (inactiveDuration < MEMORY_PRESSURE_INACTIVE_MS) continue;

      const projectTerminals = allTerminals.filter((t) => t.projectId === project.id);
      if (projectTerminals.length === 0) continue;

      const hasActiveAgent = projectTerminals.some(
        (t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
      );
      if (hasActiveAgent) continue;

      if (await this.hasActiveGitOperation(project.path, MEMORY_PRESSURE_INACTIVE_MS)) {
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
        await ptyManager.gracefulKillByProject(project.id);
      } catch (error) {
        logError("memory-pressure-hibernate-failed", error, {
          project: project.name,
          projectId: project.id,
        });
      }
    }
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

    console.log("[HibernationService] Config updated:", this.getConfig());
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
