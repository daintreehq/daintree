// eager-import-allow: reads auto-close settings via store.get synchronously
import type {
  IdleBackgroundAutoCloseConfig,
  IdleBackgroundClosedPayload,
  IdleBackgroundClosedProjectEntry,
} from "../../shared/types/ipc/idleBackgroundAutoClose.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { collectActiveProjectIds } from "../window/activeProjectIds.js";
import { getPtyClient, getWorkspaceClientRef } from "../window/serviceRefs.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { getHibernationService } from "./HibernationService.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";
import { helpSessionService } from "./HelpSessionService.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";

const DEFAULT_CONFIG: IdleBackgroundAutoCloseConfig = {
  enabled: false,
  thresholdMinutes: 15,
};

const MIN_THRESHOLD_MINUTES = 15;
const MAX_THRESHOLD_MINUTES = 1440; // 24h

/**
 * IdleBackgroundAutoCloseService — Auto-closes background projects that have
 * been idle past a configurable threshold (default 15 min) AND hold zero
 * terminals, reclaiming their resident memory the same way the manual
 * "Close (free memory)" action (#10829) does.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Structurally mirrors {@link IdleTerminalNotificationService} (timer, startup
 * quiet, wake quiet, sleep/wake lifecycle) but ACTS instead of notifying:
 * - Gate is terminal presence only — any terminal means skip (never destroy
 *   agent scrollback silently). Exception: the Daintree Assistant's help PTY
 *   is tooling-internal and never blocks the reclaim; it's capture-revoked
 *   (conversation preserved via pending hibernation) before teardown.
 * - Never touches the foreground/active project in ANY window — the multi-window
 *   guard reads every per-window ProjectViewManager's active project, not just
 *   the SQLite-backed `getCurrentProjectId()` (which only reflects the
 *   last-focused window — lesson #8607).
 * - Defaults OFF: it's a structural project-lifecycle change, so it's opt-in.
 */
export class IdleBackgroundAutoCloseService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  /**
   * Timestamp before which we suppress all sweeps. Set once on the very first
   * `start()` for this process lifetime and never bumped again — so toggling
   * `enabled` off/on in Settings doesn't keep pushing the first real sweep out.
   */
  private quietUntil: number | null = null;
  private wakeQuietUntil: number | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly STARTUP_QUIET_MS = 2 * 60 * 1000; // 2 minutes
  private readonly INITIAL_CHECK_DELAY_MS = 5_000;
  private readonly WAKE_QUIET_MS = 30_000;
  private ptyClient: PtyClient | null = null;
  private projectViewManagersProvider: (() => ProjectViewManager[]) | null = null;
  /** Guards against overlapping sweeps when one cycle outruns the 5-min tick. */
  private sweepInProgress = false;

  /**
   * Inject the live PtyClient so terminal-presence checks read the real registry
   * in the pty-host process (the main-process PtyManager singleton is never
   * populated — #10054). Passing `null` clears the reference on shutdown.
   */
  setPtyClient(client: PtyClient | null): void {
    this.ptyClient = client;
  }

  /**
   * Inject a lazy provider over every window's ProjectViewManager so the active
   * guard sees foreground projects across ALL windows. Lazy because windows open
   * and close after this wires; re-read on each sweep. Same pattern as
   * HibernationService / ResourceProfileService.
   */
  setProjectViewManagersProvider(provider: (() => ProjectViewManager[]) | null): void {
    this.projectViewManagersProvider = provider;
  }

  /**
   * Is this PTY the Daintree Assistant's tooling-internal help terminal?
   * Checks BOTH registries: the renderer-fed availability mark (durable, but
   * lands only after the renderer's `help.markTerminal` — a parked renderer
   * may never send it) and main's own live session binding (set at spawn,
   * dropped on revoke). Either alone has a blind window; together the
   * assistant PTY can never masquerade as a real terminal and block sweeps
   * indefinitely.
   */
  private isHelpTerminal(terminalId: string): boolean {
    return (
      getAgentAvailabilityStore().isHelpTerminal(terminalId) ||
      helpSessionService.isHelpTerminal(terminalId)
    );
  }

  private normalizeThreshold(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(MIN_THRESHOLD_MINUTES, Math.min(MAX_THRESHOLD_MINUTES, Math.round(value)));
  }

  private normalizeConfig(value: unknown): IdleBackgroundAutoCloseConfig {
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

  getConfig(): IdleBackgroundAutoCloseConfig {
    return this.normalizeConfig(store.get("idleBackgroundAutoClose"));
  }

  updateConfig(config: Partial<IdleBackgroundAutoCloseConfig>): IdleBackgroundAutoCloseConfig {
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
    store.set("idleBackgroundAutoClose", current);

    const updated = this.getConfig();
    if (updated.enabled) {
      if (!this.checkInterval) {
        this.start();
      }
    } else {
      this.stop();
    }
    logInfo("idle-background-auto-close-config-updated", { ...updated });
    return updated;
  }

  start(): void {
    if (this.checkInterval) return;

    // Re-acquire the PtyClient on (re)start — stop() clears it, so a Settings
    // toggle off→on would otherwise leave checkAndClose() guarded-out forever.
    this.ptyClient ??= getPtyClient();

    const config = this.getConfig();
    if (!config.enabled) {
      logInfo("idle-background-auto-close-disabled");
      return;
    }

    // Seed the startup quiet period only on the very first start in this process
    // lifetime — toggling the feature off/on must not re-apply the 2-min window.
    if (this.quietUntil === null) {
      this.quietUntil = Date.now() + this.STARTUP_QUIET_MS;
    }
    logInfo("idle-background-auto-close-started");

    this.checkInterval = setInterval(() => {
      void this.checkAndClose().catch((error) => {
        logError("idle-background-auto-close-check-failed", error);
      });
    }, this.CHECK_INTERVAL_MS);

    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
    }
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.checkAndClose().catch((error) => {
        logError("idle-background-auto-close-initial-check-failed", error);
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
            void this.checkAndClose().catch((error) => {
              logError("idle-background-auto-close-check-failed", error);
            });
          }, this.CHECK_INTERVAL_MS);
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
      logInfo("idle-background-auto-close-stopped");
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

    // Clear the injected PtyClient ref on shutdown so we don't pin a stale host
    // client across a restart (lesson #8637).
    this.ptyClient = null;
  }

  /**
   * Collect the set of project IDs that are foreground in ANY window. Reads every
   * per-window ProjectViewManager and falls back to the SQLite current-project
   * pointer so an early-startup sweep (before the provider is wired) still skips
   * the active project.
   */
  private collectActiveProjectIds(): Set<string> {
    return collectActiveProjectIds(
      this.projectViewManagersProvider,
      projectStore.getCurrentProjectId(),
      "idle-background-auto-close"
    );
  }

  private async checkAndClose(): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;

    // Startup quiet period — let services settle and don't act immediately after
    // launch. Gated on `quietUntil`, seeded once on first start.
    if (this.quietUntil !== null && Date.now() < this.quietUntil) {
      return;
    }

    // Post-wake quiet period — don't sweep while the OS is still stabilizing.
    if (this.wakeQuietUntil !== null && Date.now() < this.wakeQuietUntil) {
      return;
    }

    // Skip if a prior sweep is still running — a stalled `getAllTerminalsAsync`
    // (pty-host backpressure/restart) must not let the 5-min tick stack overlapping
    // sweeps that double-evaluate the same project against pre-write snapshots.
    if (this.sweepInProgress) return;
    this.sweepInProgress = true;
    try {
      await this.runSweep();
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async runSweep(): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;

    const projects = projectStore.getAllProjects();
    if (projects.length === 0) return;

    if (!this.ptyClient) return;
    // Read the live terminal registry every sweep — never cache it in the timer
    // closure, so a project that briefly held a terminal and dropped back to
    // zero is re-evaluated fresh (lesson #8998).
    const allTerminals = await this.ptyClient.getAllTerminalsAsync();

    const now = Date.now();
    const thresholdMs = config.thresholdMinutes * 60 * 1000;
    const activeIds = this.collectActiveProjectIds();

    const closed: IdleBackgroundClosedProjectEntry[] = [];

    for (const project of projects) {
      if (!project.id) continue;
      const pid = project.id;

      // Never touch the foreground project in any window.
      if (activeIds.has(pid)) continue;

      // Defensive: the active project should already be in `activeIds`, but if
      // the PVM provider and DB pointer both lagged, the persisted status is a
      // second line of defense — never auto-close a project the store calls
      // "active".
      if (project.status === "active") continue;

      // Already reclaimed or gone — nothing resident to free.
      if (project.status === "closed" || project.status === "missing") continue;

      // Never opened in this install — no cached resources to reclaim.
      if (!project.lastOpened || project.lastOpened <= 0) continue;

      // Still within the idle threshold.
      if (now - project.lastOpened < thresholdMs) continue;

      // Gate: terminal presence only. Any live PTY means skip — we never tear
      // down a project that still has agent/terminal scrollback. The Daintree
      // Assistant's help PTY is the one exception: it's tooling-internal (the
      // switcher already hides it, #10989) and must not keep an idle project
      // resident — `closeProject` capture-revokes it so the conversation
      // still resumes on the next open.
      const hasTerminal = allTerminals.some(
        (t) => t.projectId === pid && t.hasPty !== false && !this.isHelpTerminal(t.id)
      );
      if (hasTerminal) continue;

      try {
        const result = await this.closeProject(pid, now, thresholdMs);
        if (result) closed.push(result);
      } catch (error) {
        // Isolate per project — one teardown failure must not abort the sweep.
        logError("idle-background-auto-close-project-failed", error, { projectId: pid });
      }
    }

    if (closed.length === 0) return;

    logInfo("idle-background-auto-close-fire", {
      projectCount: closed.length,
      thresholdMinutes: config.thresholdMinutes,
    });

    const payload: IdleBackgroundClosedPayload = {
      projects: closed,
      timestamp: now,
    };
    try {
      broadcastToRenderer(CHANNELS.IDLE_BACKGROUND_CLOSED, payload);
    } catch {
      // Window may be closing.
    }
  }

  /**
   * Tear down a single background project — the same reclamation sequence as the
   * manual `project:free-memory` action (#10829): graceful session-preserving
   * PTY kill, cached renderer eviction, workspace-host eviction, then mark
   * `closed` with the `autoParkedAt` marker so the switcher labels it distinctly.
   */
  private async closeProject(
    projectId: string,
    now: number,
    thresholdMs: number
  ): Promise<IdleBackgroundClosedProjectEntry | null> {
    // Re-verify eligibility against FRESH state immediately before the
    // irreversible teardown. The sweep snapshotted projects (status, lastOpened)
    // and terminals before this async loop, so during an earlier project's awaits
    // the user could have switched to this project — which bumps its lastOpened
    // to `now-1` and flips its status — or spawned a terminal in it (TOCTOU). Re-
    // read the project row and the live registry, and bail if anything now
    // disqualifies it. Also re-check `enabled` so a toggle-off mid-sweep halts.
    if (!this.getConfig().enabled) return null;

    const fresh = projectStore.getProjectById(projectId);
    if (!fresh) return null;
    if (fresh.status !== "background") return null;
    if (!fresh.lastOpened || fresh.lastOpened <= 0) return null;
    if (now - fresh.lastOpened < thresholdMs) return null;
    if (this.collectActiveProjectIds().has(projectId)) return null;

    const liveTerminals = (await this.ptyClient?.getAllTerminalsAsync()) ?? [];
    if (
      liveTerminals.some(
        (t) => t.projectId === projectId && t.hasPty !== false && !this.isHelpTerminal(t.id)
      )
    ) {
      return null;
    }

    const project = fresh;

    // A still-running assistant help PTY must not survive the reclaim, and it
    // must not lose the conversation either: capture-revoke it first (graceful
    // kill + pending-hibernation entry — the LRU-eviction path), so the next
    // panel open resumes the session. Await it so the PTY is down before the
    // project-wide kill below; a failure degrades to that kill, losing only
    // the resume entry, never blocking the reclaim.
    try {
      await helpSessionService.revokeByProjectId(projectId);
    } catch (error) {
      logError("idle-background-auto-close-help-revoke-failed", error, { projectId });
    }

    // The capture-revoke's gracefulKill can take seconds — long enough for the
    // user to switch to this project or spawn a real terminal in it. Re-verify
    // eligibility once more before the irreversible teardown; bailing here is
    // safe because the revoke above already persisted the assistant's
    // pending-hibernation entry, so a reopened panel still resumes.
    if (this.collectActiveProjectIds().has(projectId)) return null;
    const refreshed = projectStore.getProjectById(projectId);
    if (!refreshed || refreshed.status !== "background") return null;
    const postRevokeTerminals = (await this.ptyClient?.getAllTerminalsAsync()) ?? [];
    if (
      postRevokeTerminals.some(
        (t) => t.projectId === projectId && t.hasPty !== false && !this.isHelpTerminal(t.id)
      )
    ) {
      return null;
    }

    // Graceful, session-preserving kill — scrollback survives via hibernation
    // markers so a later reopen restores panels instead of starting cold. For a
    // zero-terminal project this returns `[]`, but call it for correctness.
    const results =
      (await this.ptyClient?.gracefulKillByProject(projectId, {
        preserveSession: true,
      })) ?? [];
    for (const result of results) {
      writeHibernatedMarker(result.id);
    }

    // Tear down the cached WebContentsView across every window (guarded inside
    // the service — no-ops where the project is on-screen).
    getHibernationService().evictProjectRenderer(projectId);

    // Drop the workspace-host process (skips when another window still holds it).
    getWorkspaceClientRef()?.evictProject(project.path);

    // Keep the project in the list as `closed` WITHOUT clearProjectState, so its
    // panel/terminal layout survives a non-destructive reopen. The autoParkedAt
    // marker distinguishes this from a manual close in the switcher.
    projectStore.updateProjectStatus(projectId, "closed", {
      autoParkedAt: now,
    });
    const updated = projectStore.getProjectById(projectId);
    if (updated) {
      try {
        broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
      } catch {
        // Window may be closing.
      }
    }

    logInfo("idle-background-auto-close-closed", {
      projectId,
      terminalsKilled: results.length,
    });

    return { projectId, projectName: project.name };
  }
}

let idleBackgroundAutoCloseService: IdleBackgroundAutoCloseService | null = null;

export function getIdleBackgroundAutoCloseService(): IdleBackgroundAutoCloseService {
  if (!idleBackgroundAutoCloseService) {
    idleBackgroundAutoCloseService = new IdleBackgroundAutoCloseService();
  }
  return idleBackgroundAutoCloseService;
}
