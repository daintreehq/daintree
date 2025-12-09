import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";

export interface HibernationConfig {
  enabled: boolean;
  inactiveThresholdHours: number;
}

const DEFAULT_CONFIG: HibernationConfig = {
  enabled: false,
  inactiveThresholdHours: 24,
};

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
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // Every hour

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
    setTimeout(() => {
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

    for (const project of projects) {
      // Never hibernate the active project
      if (project.id === currentProjectId) continue;

      // Check if project has been inactive long enough
      const inactiveDuration = now - (project.lastOpened || 0);
      if (inactiveDuration < thresholdMs) continue;

      // Check if project has running terminals
      const ptyStats = ptyManager.getProjectStats(project.id);
      const processCount = ptyStats.terminalCount;

      if (processCount === 0) {
        continue; // No processes to hibernate
      }

      const hoursInactive = Math.floor(inactiveDuration / 3600000);
      console.log(
        `[HibernationService] Auto-hibernating project "${project.name}" ` +
          `(inactive for ${hoursInactive} hours, ${processCount} processes)`
      );

      try {
        // Kill terminals (synchronous)
        const terminalsKilled = ptyManager.killByProject(project.id);

        // Clear persisted state
        await projectStore.clearProjectState(project.id);

        console.log(
          `[HibernationService] Hibernated "${project.name}": ${terminalsKilled} terminals killed`
        );
      } catch (error) {
        console.error(`[HibernationService] Failed to hibernate project "${project.name}":`, error);
      }
    }
  }

  getConfig(): HibernationConfig {
    const hibernation = store.get("hibernation");
    return {
      enabled: hibernation?.enabled ?? DEFAULT_CONFIG.enabled,
      inactiveThresholdHours:
        hibernation?.inactiveThresholdHours ?? DEFAULT_CONFIG.inactiveThresholdHours,
    };
  }

  updateConfig(config: Partial<HibernationConfig>): void {
    const current = { ...(store.get("hibernation") ?? DEFAULT_CONFIG) };

    if (config.enabled !== undefined) {
      current.enabled = config.enabled;
    }
    if (config.inactiveThresholdHours !== undefined) {
      // Clamp to valid range (1-168 hours)
      current.inactiveThresholdHours = Math.max(
        1,
        Math.min(168, Math.round(config.inactiveThresholdHours))
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
