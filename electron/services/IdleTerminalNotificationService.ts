// eager-import-allow: reads idle-notification settings via store.get synchronously
import type { AgentState } from "../../shared/types/agent.js";
import type {
  IdleTerminalNotifyConfig,
  IdleTerminalNotifyPayload,
  IdleTerminalProjectEntry,
} from "../../shared/types/ipc/idleTerminals.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManagersProvider } from "../window/activeProjectIds.js";
import { collectActiveProjectIds } from "../window/activeProjectIds.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { getSystemSleepService } from "./SystemSleepService.js";
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
  private wakeQuietUntil: number | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly STARTUP_QUIET_MS = 2 * 60 * 1000; // 2 minutes
  private readonly INITIAL_CHECK_DELAY_MS = 5_000;
  private readonly WAKE_QUIET_MS = 30_000;
  private currentCheckIntervalMs = this.CHECK_INTERVAL_MS;
  private ptyClient: PtyClient | null = null;
  private projectViewManagersProvider: ProjectViewManagersProvider | null = null;

  /**
   * Inject the live PtyClient so idle checks read the real terminal registry
   * in the pty-host process. The main-process `getPtyManager()` singleton is
   * never populated (#10054). Passing `null` clears the reference on shutdown.
   */
  setPtyClient(client: PtyClient | null): void {
    this.ptyClient = client;
  }

  /**
   * Inject a lazy provider over every window's ProjectViewManager so a project
   * on-screen in a non-focused window is never nudged about its "idle"
   * terminals (#11102). Lazy because windows open and close after this wires —
   * re-read on each check. NOT cleared in stop(): it's a stateless closure over
   * the window registry (no stale object pinned), so a Settings off→on toggle
   * doesn't lose multi-window awareness (#8637).
   */
  setProjectViewManagersProvider(provider: ProjectViewManagersProvider | null): void {
    this.projectViewManagersProvider = provider;
  }

  /**
   * The set of project IDs on-screen in ANY window — see #11102.
   */
  private collectActiveProjectIds(): Set<string> {
    return collectActiveProjectIds(
      this.projectViewManagersProvider,
      projectStore.getCurrentProjectId(),
      "idle-terminal-notification"
    );
  }

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

    // Re-acquire the PtyClient on (re)start — stop() clears it, so a Settings
    // toggle off→on would otherwise leave checkAndNotify() guarded-out forever.
    this.ptyClient ??= getPtyClient();

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

    try {
      this.removeSuspendListener = getSystemSleepService().onSuspend(() => {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        if (this.initialCheckTimer) {
          clearTimeout(this.initialCheckTimer);
          this.initialCheckTimer = null;
        }
      });
      this.removeWakeListener = getSystemSleepService().onWake(() => {
        this.wakeQuietUntil = Date.now() + this.WAKE_QUIET_MS;
        if (!this.checkInterval) {
          this.checkInterval = setInterval(() => {
            void this.checkAndNotify().catch((error) => {
              logError("idle-terminal-notify-check-failed", error);
            });
          }, this.currentCheckIntervalMs);
        }
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
    }
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
    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }
    if (this.removeWakeListener) {
      this.removeWakeListener();
      this.removeWakeListener = null;
    }

    // Clear the injected PtyClient ref on shutdown so we don't pin a stale
    // host client across a restart (lesson #8637).
    this.ptyClient = null;
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
   * project-scoped cleanup callbacks (e.g. DevPreview session teardown) run and
   * the renderer sees the standard hibernation event. Passes `"user-initiated"`
   * so this explicit action also evicts the project's cached renderer (#10668) —
   * unlike the silent scheduled/memory-pressure paths, which leave it warm.
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
        "user-initiated"
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

  /**
   * Per-project "last broadcast" timestamps. Distinct from dismissals: a
   * dismissal is an *explicit* user mute that persists for the whole cooldown,
   * whereas this is *producer throttling* — it stops an ignored project from
   * being re-broadcast every check cycle, and is cleared the moment the project
   * leaves the idle-eligible state so a fresh idle period notifies again.
   */
  private readNotifiedAt(): Record<string, number> {
    const raw = store.get("idleTerminalNotifiedAt");
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

    // Post-wake quiet period — prevent notification burst right after
    // system resume while the OS is still stabilizing.
    if (this.wakeQuietUntil !== null && Date.now() < this.wakeQuietUntil) {
      return;
    }

    const now = Date.now();
    const thresholdMs = config.thresholdMinutes * 60 * 1000;
    const cooldownMs = this.cooldownMs(config.thresholdMinutes);

    // Read dismissals + notified-throttle once and clean stale entries
    // opportunistically. Run this before any early returns so cleanup keeps
    // progressing even when there are no projects to evaluate. An entry older
    // than the cooldown no longer suppresses anything, so dropping it is safe
    // and bounds the maps against deleted projects.
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

    const notifiedAt = this.readNotifiedAt();
    let notifiedChanged = false;
    for (const [pid, ts] of Object.entries(notifiedAt)) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || now - ts > cooldownMs) {
        delete notifiedAt[pid];
        notifiedChanged = true;
      }
    }

    const activeIds = this.collectActiveProjectIds();
    const projects = projectStore.getAllProjects();
    if (projects.length === 0) {
      if (notifiedChanged) store.set("idleTerminalNotifiedAt", notifiedAt);
      return;
    }

    if (!this.ptyClient) {
      if (notifiedChanged) store.set("idleTerminalNotifiedAt", notifiedAt);
      return;
    }
    const allTerminals = await this.ptyClient.getAllTerminalsAsync();

    const clearNotified = (pid: string): void => {
      if (notifiedAt[pid] !== undefined) {
        delete notifiedAt[pid];
        notifiedChanged = true;
      }
    };

    const qualifying: IdleTerminalProjectEntry[] = [];

    for (const project of projects) {
      if (!project.id) continue;
      const pid = project.id;

      // A project on-screen in ANY window is never notified (#11102 — the DB
      // pointer alone only tracks the last-focused one). We deliberately do NOT
      // reset its throttle here: merely viewing a project isn't engaging with
      // its terminals, and clearing on focus alone would let a switch-to-then-
      // away round trip re-notify the same still-idle terminals inside the
      // cooldown. A genuine reset (typing, agent activity) surfaces as terminal
      // activity below and clears the throttle through the ineligible path.
      if (activeIds.has(pid)) continue;

      // Any remaining non-qualifying reason (no terminals, active agent, recent
      // activity) means the project has left the idle state, so its notified
      // throttle is cleared — a later idle period then notifies fresh. The
      // explicit dismissal is deliberately NOT cleared here.
      const projectTerminals = allTerminals.filter(
        (t) => t.projectId === pid && t.hasPty !== false
      );

      const hasActiveAgent = projectTerminals.some(
        (t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
      );

      const allIdle =
        projectTerminals.length > 0 &&
        projectTerminals.every((t) => {
          const lastActivity = Math.max(t.lastInputTime ?? 0, t.lastOutputTime ?? 0);
          if (!lastActivity) return false; // unknown activity — be conservative
          return now - lastActivity >= thresholdMs;
        });

      const eligible = projectTerminals.length > 0 && !hasActiveAgent && allIdle;
      if (!eligible) {
        clearNotified(pid);
        continue;
      }

      // Eligible — but suppress when the user has explicitly muted the project
      // or it was already broadcast within the cooldown window. Neither path
      // clears the throttle: the project is still idle, so it stays suppressed
      // until the cooldown lapses.
      const dismissedAt = dismissals[pid];
      if (typeof dismissedAt === "number" && now - dismissedAt < cooldownMs) continue;
      const lastNotified = notifiedAt[pid];
      if (typeof lastNotified === "number" && now - lastNotified < cooldownMs) continue;

      // Compute idle minutes from the *most recently active* terminal
      const newestActivity = projectTerminals.reduce(
        (max, t) => Math.max(max, t.lastInputTime ?? 0, t.lastOutputTime ?? 0),
        0
      );
      const idleMinutes = newestActivity > 0 ? Math.floor((now - newestActivity) / 60000) : 0;

      qualifying.push({
        projectId: pid,
        projectName: project.name,
        terminalCount: projectTerminals.length,
        idleMinutes,
      });
      notifiedAt[pid] = now;
      notifiedChanged = true;
    }

    if (notifiedChanged) {
      store.set("idleTerminalNotifiedAt", notifiedAt);
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

/**
 * `projectViewManagersProvider` is wired BEFORE start() so the first (5s) check
 * already sees every window's foreground project — taking it here makes that
 * ordering correct by construction rather than by convention.
 */
export function initializeIdleTerminalNotificationService(
  projectViewManagersProvider?: ProjectViewManagersProvider
): IdleTerminalNotificationService {
  const service = getIdleTerminalNotificationService();
  service.setPtyClient(getPtyClient());
  if (projectViewManagersProvider) {
    service.setProjectViewManagersProvider(projectViewManagersProvider);
  }
  service.start();
  return service;
}
