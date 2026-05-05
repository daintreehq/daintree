import type { AgentState } from "../../shared/types/agent.js";
import type {
  IdleTerminalNotifyConfig,
  IdleTerminalNotifyPayload,
  IdleTerminalProjectEntry,
} from "../../shared/types/ipc/idleTerminals.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";

const DEFAULT_CONFIG: IdleTerminalNotifyConfig = {
  enabled: true,
  thresholdMinutes: 60,
};

const MIN_THRESHOLD_MINUTES = 15;
const MAX_THRESHOLD_MINUTES = 1440; // 24h
const MIN_COOLDOWN_MINUTES = 60;

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set(["working", "waiting", "directing"]);

interface PtyManagerLike {
  getAll: () => Array<{
    id: string;
    projectId?: string;
    agentState?: AgentState;
    lastInputTime: number;
    lastOutputTime: number;
    hasPty?: boolean;
  }>;
}

/**
 * IdleTerminalNotificationService — Notifies users when background-project terminals
 * have been idle past a configurable threshold (default 60 min).
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Mirrors HibernationService structurally, but acts as a *gentler* layer:
 * - Notifies instead of auto-killing
 * - Default 60min threshold (vs 24h for hibernation)
 * - Aggregates all qualifying projects into a single broadcast per check cycle
 *   so the renderer-side `coalesce` mechanism can group multi-project notices.
 */
export class IdleTerminalNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  /**
   * Timestamp before which we suppress all broadcasts. Set once on the very
   * first `start()` for this process lifetime and never bumped again — so
   * toggling `enabled` off/on in Settings doesn't keep pushing the first
   * real check further out.
   */
  private quietUntil: number | null = null;
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly STARTUP_QUIET_MS = 2 * 60 * 1000; // 2 minutes
  private readonly INITIAL_CHECK_DELAY_MS = 5_000;
  private currentCheckIntervalMs = this.CHECK_INTERVAL_MS;

  private normalizeThreshold(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(MIN_THRESHOLD_MINUTES, Math.min(MAX_THRESHOLD_MINUTES, Math.round(value)));
  }

  private normalizeConfig(value: unknown): IdleTerminalNotifyConfig {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    const candidate = (raw ?? {}) as {
      enabled?: unknown;
      thresholdMinutes?: unknown;
    };
    return {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_CONFIG.enabled,
      thresholdMinutes: this.normalizeThreshold(
        candidate.thresholdMinutes,
        DEFAULT_CONFIG.thresholdMinutes
      ),
    };
  }

  getConfig(): IdleTerminalNotifyConfig {
    return this.normalizeConfig(store.get("idleTerminalNotify"));
  }

  updateConfig(config: Partial<IdleTerminalNotifyConfig>): IdleTerminalNotifyConfig {
    const current = this.getConfig();
    if (typeof config.enabled === "boolean") {
      current.enabled = config.enabled;
    }
    if (config.thresholdMinutes !== undefined) {
      current.thresholdMinutes = this.normalizeThreshold(
        config.thresholdMinutes,
        current.thresholdMinutes
      );
    }
    store.set("idleTerminalNotify", current);

    const updated = this.getConfig();
    if (updated.enabled) {
      if (!this.checkInterval) {
        this.start();
      }
    } else {
      this.stop();
    }
    logInfo("idle-terminal-notify-config-updated", { ...updated });
    return updated;
  }

  start(): void {
    if (this.checkInterval) return;
    const config = this.getConfig();
    if (!config.enabled) {
      logInfo("idle-terminal-notify-disabled");
      return;
    }

    // Only seed the startup quiet period on the very first start in this
    // process lifetime. Toggling the feature off/on in Settings should not
    // re-apply the 2-minute suppression window.
    if (this.quietUntil === null) {
      this.quietUntil = Date.now() + this.STARTUP_QUIET_MS;
    }
    logInfo("idle-terminal-notify-started");

    this.checkInterval = setInterval(() => {
      void this.checkAndNotify().catch((error) => {
        logError("idle-terminal-notify-check-failed", error);
      });
    }, this.currentCheckIntervalMs);

    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
    }
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.checkAndNotify().catch((error) => {
        logError("idle-terminal-notify-initial-check-failed", error);
      });
    }, this.INITIAL_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logInfo("idle-terminal-notify-stopped");
    }
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }
  }

  updatePollInterval(ms: number): void {
    if (ms === this.currentCheckIntervalMs) return;
    this.currentCheckIntervalMs = ms;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = setInterval(() => {
        void this.checkAndNotify().catch((error) => {
          logError("idle-terminal-notify-check-failed", error);
        });
      }, this.currentCheckIntervalMs);
    }
  }

  /**
   * Persist a dismissal cooldown for a project.
   * Cooldown duration is `max(thresholdMinutes, 60)` to honor the
   * "at least an hour" guarantee from the issue.
   */
  dismissProject(projectId: string): void {
    if (!projectId) return;
    const dismissals = this.readDismissals();
    dismissals[projectId] = Date.now();
    store.set("idleTerminalDismissals", dismissals);
    logInfo("idle-terminal-notify-dismissed", { projectId });
  }

  /**
   * "Close Them" action handler. Delegates to HibernationService so that
   * project-scoped cleanup callbacks (e.g. DevPreview session teardown) run
   * and the renderer sees the standard hibernation event — same as if the
   * scheduled hibernation timer had closed the project itself.
   */
  async closeProject(projectId: string): Promise<number> {
    if (!projectId) return 0;

    const project = projectStore.getAllProjects().find((p) => p.id === projectId);
    const projectName = project?.name ?? projectId;

    try {
      const { getHibernationService } = await import("./HibernationService.js");
      const terminalsKilled = await getHibernationService().hibernateProjectOnDemand(
        projectId,
        projectName,
        "scheduled"
      );

      // Only burn a cooldown slot if we actually acted on something — otherwise
      // an empty project would silently suppress future legitimate notifications.
      if (terminalsKilled > 0) {
        this.dismissProject(projectId);
      }

      logInfo("idle-terminal-notify-closed", {
        projectId,
        terminalsKilled,
      });
      return terminalsKilled;
    } catch (error) {
      logError("idle-terminal-notify-close-failed", error, { projectId });
      throw error;
    }
  }

  private readDismissals(): Record<string, number> {
    const raw = store.get("idleTerminalDismissals");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return { ...(raw as Record<string, number>) };
    }
    return {};
  }

  private cooldownMs(thresholdMinutes: number): number {
    return Math.max(thresholdMinutes, MIN_COOLDOWN_MINUTES) * 60 * 1000;
  }

  private async checkAndNotify(): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;

    // Startup quiet period — give services time to settle and don't fire
    // immediately after the user opens the app. Gated on `quietUntil`, which
    // is seeded once on first start and never bumped thereafter.
    if (this.quietUntil !== null && Date.now() < this.quietUntil) {
      return;
    }

    const now = Date.now();
    const thresholdMs = config.thresholdMinutes * 60 * 1000;
    const cooldownMs = this.cooldownMs(config.thresholdMinutes);

    // Read dismissals once and clean stale entries opportunistically. Run this
    // before any early returns so cleanup keeps progressing even when there
    // are no projects to evaluate.
    const dismissals = this.readDismissals();
    let dismissalsChanged = false;
    for (const [pid, ts] of Object.entries(dismissals)) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || now - ts > cooldownMs) {
        delete dismissals[pid];
        dismissalsChanged = true;
      }
    }
    if (dismissalsChanged) {
      store.set("idleTerminalDismissals", dismissals);
    }

    const currentProjectId = projectStore.getCurrentProjectId();
    const projects = projectStore.getAllProjects();
    if (projects.length === 0) return;

    const { getPtyManager } = await import("./PtyManager.js");
    const ptyManager = getPtyManager() as unknown as PtyManagerLike;
    const allTerminals = ptyManager.getAll();

    const qualifying: IdleTerminalProjectEntry[] = [];

    for (const project of projects) {
      if (!project.id) continue;
      if (project.id === currentProjectId) continue;

      // Skip if dismissed within cooldown window
      const dismissedAt = dismissals[project.id];
      if (typeof dismissedAt === "number" && now - dismissedAt < cooldownMs) continue;

      const projectTerminals = allTerminals.filter(
        (t) => t.projectId === project.id && t.hasPty !== false
      );
      if (projectTerminals.length === 0) continue;

      // Skip if any terminal in the project has an active agent
      const hasActiveAgent = projectTerminals.some(
        (t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
      );
      if (hasActiveAgent) continue;

      // All running terminals must be idle past the threshold
      const allIdle = projectTerminals.every((t) => {
        const lastActivity = Math.max(t.lastInputTime ?? 0, t.lastOutputTime ?? 0);
        if (!lastActivity) return false; // unknown activity — be conservative
        return now - lastActivity >= thresholdMs;
      });
      if (!allIdle) continue;

      // Compute idle minutes from the *most recently active* terminal
      const newestActivity = projectTerminals.reduce(
        (max, t) => Math.max(max, t.lastInputTime ?? 0, t.lastOutputTime ?? 0),
        0
      );
      const idleMinutes = newestActivity > 0 ? Math.floor((now - newestActivity) / 60000) : 0;

      qualifying.push({
        projectId: project.id,
        projectName: project.name,
        terminalCount: projectTerminals.length,
        idleMinutes,
      });
    }

    if (qualifying.length === 0) return;

    logInfo("idle-terminal-notify-fire", {
      projectCount: qualifying.length,
      thresholdMinutes: config.thresholdMinutes,
    });

    const payload: IdleTerminalNotifyPayload = {
      projects: qualifying,
      timestamp: now,
    };
    try {
      broadcastToRenderer(CHANNELS.IDLE_TERMINAL_NOTIFY, payload);
    } catch {
      // Window may be closing
    }
  }
}

let idleTerminalNotificationService: IdleTerminalNotificationService | null = null;

export function getIdleTerminalNotificationService(): IdleTerminalNotificationService {
  if (!idleTerminalNotificationService) {
    idleTerminalNotificationService = new IdleTerminalNotificationService();
  }
  return idleTerminalNotificationService;
}

export function initializeIdleTerminalNotificationService(): IdleTerminalNotificationService {
  const service = getIdleTerminalNotificationService();
  service.start();
  return service;
}
