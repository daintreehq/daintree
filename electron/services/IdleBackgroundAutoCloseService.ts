// eager-import-allow: reads auto-close settings via store.get synchronously
import {
  isIdleShellThresholdMinutes,
  type IdleBackgroundAutoCloseConfig,
  type IdleBackgroundClosedPayload,
  type IdleBackgroundClosedProjectEntry,
  type IdleBackgroundSweepTrigger,
} from "../../shared/types/ipc/idleBackgroundAutoClose.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../shared/types/resourceProfile.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { collectActiveProjectIds } from "../window/activeProjectIds.js";
import { projectVisibilityClock, type ProjectVisibilityClock } from "./projectVisibilityClock.js";
import {
  getPtyClient,
  getResourceProfileService,
  getWorkspaceClientRef,
} from "../window/serviceRefs.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { helpSessionService } from "./HelpSessionService.js";
import { sleepProject } from "./projectSleep.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import { probeRepositorySleepSafety } from "../utils/gitSleepSafety.js";
import { probeResourceConfig } from "../utils/resourceConfigProbe.js";
import { withTimeout } from "../utils/withTimeout.js";
import { observeExactAgentResumes } from "./pty/exactAgentResume.js";
import {
  censusMemoryKb,
  evaluateGit,
  evaluateShellTerminals,
  evaluateWorkspace,
  isAgentTerminal,
  isLiveTerminal,
  terminalsStillVetted,
  type IdleShellSkipReason,
  type ProcessInventoryRead,
  type VettedTerminals,
} from "./idleShellSleepGates.js";

const DEFAULT_CONFIG: IdleBackgroundAutoCloseConfig = {
  enabled: false,
  thresholdMinutes: 15,
  includeIdleShells: false,
  idleShellThresholdMinutes: 60,
};

/** Bounds the workspace-host read a shell project's sleep waits on. */
const WORKSPACE_READ_TIMEOUT_MS = 5_000;

/**
 * How long a pressure sweep keeps starting sleeps. The ladder's view and host
 * levers wait on it, so the smallest candidates are left for the next pass.
 */
const PRESSURE_SWEEP_BUDGET_MS = 30_000;

const MIN_THRESHOLD_MINUTES = 15;
const MAX_THRESHOLD_MINUTES = 1440; // 24h

/** One entry of the live terminal snapshot PtyClient serves. */
type AutoCloseTerminal = Awaited<ReturnType<PtyClient["getAllTerminalsAsync"]>>[number];

/** The observed kind of pending coordination, or null; `ownerOf` reads the latest terminal snapshot. */
type CoordinationHoldProvider = (
  projectId: string,
  ownerOf: (terminalId: string) => string | null
) => string | null;

/** The named plugin work keeping a project awake (`plugin-task:<instance>`), or null. */
type PluginWorkProvider = (projectId: string) => string | null;

/** Why a project must not be reclaimed this sweep. */
type BlockingReason = "terminal" | "assistant" | "coordination-hold" | "plugin-work";

/** Why a project past its threshold was left awake, as the sweep log names it. */
type SkipReason =
  | IdleShellSkipReason
  | "mcp-dispatch"
  | "dictation"
  | "ineligible"
  | "coordination-hold"
  | "plugin-work";

type ShellCloseResult =
  | { status: "slept"; entry: IdleBackgroundClosedProjectEntry; terminalsKilled: number }
  | { status: "skipped"; reason: SkipReason; terminalsKilled?: number }
  | { status: "ineligible" };

/**
 * IdleBackgroundAutoCloseService — Auto-closes background projects that have
 * been idle past a configurable threshold (default 15 min) AND hold zero
 * terminals, putting them to sleep through the same teardown the manual
 * Sleep project runs (#13845).
 *
 * With `includeIdleShells` on it also sleeps projects whose terminals are all
 * plain shells with nothing running (#13849) or agents at rest that will
 * resume their conversation (#13854), on their own 1h–8h threshold, behind the
 * gates in `idleShellSleepGates`. One scheduler for both, so the two classes
 * can never race each other over the same project.
 *
 * Memory pressure runs the same sweep early through
 * {@link sleepUnderMemoryPressure} (#13852): the idle-terminal threshold
 * shortens to the resource profile's, and nothing else the project is held to
 * changes.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Structurally mirrors {@link IdleTerminalNotificationService} (timer, startup
 * quiet, wake quiet, sleep/wake lifecycle) but ACTS instead of notifying:
 * - Gate is terminal presence only — any live terminal means skip (never
 *   destroy agent scrollback silently), and that includes the Daintree
 *   Assistant's help PTY (#11807). A live assistant is floored a second time
 *   by its session binding, so a pty-host snapshot that never listed it still
 *   can't get it reclaimed out from under itself. Once the assistant's PTY is
 *   gone the project is eligible again, and `closeProject` capture-revokes any
 *   leftover binding (conversation preserved via pending hibernation).
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
  private coordinationHoldProvider: CoordinationHoldProvider | null = null;
  private pluginWorkProvider: PluginWorkProvider | null = null;
  /**
   * Owners from the latest terminal read. It still lists a terminal that has
   * exited, which the spawn registry and the fleet no longer do, so a record
   * left on one keeps its project instead of reading as unattributable.
   */
  private terminalOwners: ReadonlyMap<string, string> = new Map();
  /** Guards against overlapping sweeps when one cycle outruns the 5-min tick. */
  private sweepInProgress = false;

  constructor(private readonly visibilityClock: ProjectVisibilityClock = projectVisibilityClock) {}

  /**
   * Inject the live PtyClient so terminal-presence checks read the real registry
   * in the pty-host process (the main-process PtyManager singleton is never
   * populated — #10054). Passing `null` clears the reference on shutdown.
   */
  setPtyClient(client: PtyClient | null): void {
    this.ptyClient = client;
  }

  /**
   * Inject the question of whether a project has in-memory agent coordination
   * that sleeping would drop. Read synchronously and only on the automatic
   * path; manual Sleep never asks. A missing provider holds nothing; a throwing
   * one holds the project.
   */
  setCoordinationHoldProvider(provider: CoordinationHoldProvider | null): void {
    this.coordinationHoldProvider = provider;
  }

  private coordinationHold(projectId: string): string | null {
    try {
      return (
        this.coordinationHoldProvider?.(projectId, (id) => this.terminalOwners.get(id) ?? null) ??
        null
      );
    } catch (error) {
      logError("idle-background-auto-close-hold-read-failed", error, { projectId });
      // An unreadable hold is not a clear one: leave the project awake.
      return "unreadable";
    }
  }

  /**
   * Inject the question of whether a project's plugins hold work sleep would
   * interrupt: a live task or a call still in flight (#14093). Read
   * synchronously at every gate a coordination hold is, and only on the
   * automatic path; manual Sleep goes through and reports what it stopped.
   */
  setPluginWorkProvider(provider: PluginWorkProvider | null): void {
    this.pluginWorkProvider = provider;
  }

  private pluginWorkHold(projectId: string): string | null {
    try {
      return this.pluginWorkProvider?.(projectId) ?? null;
    } catch (error) {
      logError("idle-background-auto-close-plugin-work-read-failed", error, { projectId });
      return "unreadable";
    }
  }

  /**
   * Plugin work holding a project past the sweep's own screen, logged by name:
   * the sleep that backs off for it reports only that it was ineligible.
   */
  private latePluginWorkHold(projectId: string): string | null {
    const hold = this.pluginWorkHold(projectId);
    if (hold !== null) {
      logInfo("idle-background-auto-close-plugin-work-hold", { projectId, hold });
    }
    return hold;
  }

  /** Neither coordination nor plugin work holds the project. */
  private isUnheld(projectId: string): boolean {
    return this.coordinationHold(projectId) === null && this.latePluginWorkHold(projectId) === null;
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
   * Is a Daintree Assistant still running in this project?
   *
   * Binding + PTY liveness — the same pair `ProjectViewEvictionController` and
   * `HibernationService` already gate on (#11477). The binding alone is NOT
   * liveness: nothing drops it when the assistant exits under its own steam,
   * so without the second half a quit assistant would pin its project forever.
   * `hasTerminal` is PtyClient's main-local spawn registry, written
   * synchronously by `spawn()` and dropped on both exit and kill, so it is
   * authoritative from the assistant's first instant and — unlike
   * `getAllTerminalsAsync` — cannot be silently truncated by a pty-host shard
   * timeout.
   *
   * Agent state is deliberately NOT consulted. An assistant that scheduled a
   * wakeup or dispatched a sub-agent reads `idle` while that work is still
   * pending, and `assistant/CLAUDE.md` tells it to pace long work exactly that way.
   * Nothing main-process-side separates "idle at its prompt" from "idle with
   * work pending" (#11807, and #11157/#11477 before it), so the floor has to
   * be unconditional; it lifts as soon as the PTY exits.
   */
  private hasLiveAssistantBackend(projectId: string): boolean {
    // ANY live lane floors the whole project (#12108). Reclaim closes the
    // project, not one lane, and it finishes by revoking every session the
    // project owns — so a lane whose PTY has exited must never be read as
    // "clear" while a sibling is still running.
    const backends = helpSessionService.getAssistantBackends(projectId);
    return backends.some((backend) => this.ptyClient?.hasTerminal(backend.terminalId) === true);
  }

  /**
   * A terminal snapshot we can actually act on, or `null` when there isn't one.
   *
   * `getAllTerminalsAsync` substitutes `[]` for a shard that failed to answer,
   * which makes a pty-host outage indistinguishable from a machine with no
   * terminals. That is fine for a self-correcting count and disqualifying for
   * this gate, whose whole contract is "empty means genuinely nothing running"
   * — reporting a busy project as clear is the one wrong answer here, because
   * the next step kills its processes. So read completeness explicitly and fail
   * closed on a degraded snapshot; the sweep runs again in five minutes, and a
   * deferred reclaim costs nothing next to a wrongly reclaimed one.
   *
   * Also `null` once `stop()` has cleared the client mid-sweep — same reasoning.
   */
  private async readTerminals(): Promise<AutoCloseTerminal[] | null> {
    const client = this.ptyClient;
    if (!client) return null;
    const snapshot = await client.getAllTerminalsWithCompletenessAsync();
    // `stop()` may have landed while that request was in flight — app shutdown
    // clears the client without touching `enabled`, so the config re-checks
    // downstream would wave this through on a snapshot nobody owns any more.
    if (this.ptyClient !== client) return null;
    if (snapshot.degraded) {
      logInfo("idle-background-auto-close-skip-degraded-snapshot", {
        shardsFailed: snapshot.shardsFailed,
        shardsTotal: snapshot.shardsTotal,
      });
      return null;
    }
    this.terminalOwners = new Map(
      snapshot.terminals.flatMap((t) => (t.projectId ? [[t.id, t.projectId] as const] : []))
    );
    return snapshot.terminals;
  }

  /**
   * Why this project must not be reclaimed right now, or `null` when it is
   * free to close. ONE predicate behind all three gates — the sweep filter and
   * both `closeProject` TOCTOU re-checks — so they cannot drift apart (#11800).
   *
   * The assistant floor is consulted FIRST so that a live assistant is named as
   * the reason even when its help PTY is also sitting in the snapshot as an
   * ordinary terminal. Both answers block; only this order makes the skip log
   * report the case operators actually hit.
   */
  private blockingReason(
    projectId: string,
    terminals: readonly AutoCloseTerminal[]
  ): BlockingReason | null {
    if (this.hasLiveAssistantBackend(projectId)) return "assistant";
    if (terminals.some((t) => t.projectId === projectId && t.hasPty !== false)) {
      return "terminal";
    }
    if (this.coordinationHold(projectId) !== null) return "coordination-hold";
    if (this.pluginWorkHold(projectId) !== null) return "plugin-work";
    return null;
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
      includeIdleShells?: unknown;
      idleShellThresholdMinutes?: unknown;
    };
    return {
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_CONFIG.enabled,
      thresholdMinutes: this.normalizeThreshold(
        candidate.thresholdMinutes,
        DEFAULT_CONFIG.thresholdMinutes
      ),
      includeIdleShells:
        typeof candidate.includeIdleShells === "boolean"
          ? candidate.includeIdleShells
          : DEFAULT_CONFIG.includeIdleShells,
      idleShellThresholdMinutes: isIdleShellThresholdMinutes(candidate.idleShellThresholdMinutes)
        ? candidate.idleShellThresholdMinutes
        : DEFAULT_CONFIG.idleShellThresholdMinutes,
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
    if (typeof config.includeIdleShells === "boolean") {
      current.includeIdleShells = config.includeIdleShells;
    }
    if (isIdleShellThresholdMinutes(config.idleShellThresholdMinutes)) {
      current.idleShellThresholdMinutes = config.idleShellThresholdMinutes;
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
   *
   * Every read is also an observation for the visibility clock, so a project
   * that left the screen since the clock last looked is stamped before any idle
   * age is measured from it. Not before the provider is wired, though: a read
   * holding only the DB pointer would take a project another window still
   * shows off the clock's screen, and its real departure would then go unseen.
   */
  private collectActiveProjectIds(): Set<string> {
    const activeIds = collectActiveProjectIds(
      this.projectViewManagersProvider,
      projectStore.getCurrentProjectId(),
      "idle-background-auto-close"
    );
    if (this.projectViewManagersProvider) this.visibilityClock.observe(activeIds);
    return activeIds;
  }

  /**
   * Idle runs from the last time the project was on screen anywhere (#13844).
   * `lastOpened` is only a floor: the MRU field keeps its open time on every
   * way out but a project-to-project switch, so on its own it read a project
   * left a minute ago as hours idle. A recent open still counts, though — the
   * legacy single-view switch moves nothing but the DB pointer.
   */
  private isWithinIdleThreshold(
    projectId: string,
    lastOpened: number,
    now: number,
    thresholdMs: number
  ): boolean {
    const idleSince = Math.max(this.visibilityClock.lastVisibleAt(projectId), lastOpened);
    return now - idleSince < thresholdMs;
  }

  private async checkAndClose(): Promise<void> {
    await this.sweep("idle");
  }

  /**
   * The tier-2 memory ladder's sleep lever (#13852). Runs the regular sweep
   * now, for idle terminal projects only, with their threshold shortened to the
   * resource profile's `memoryPressureInactiveMs` — never past the user's own
   * — and every other gate as it is. Projects with no terminals hold no
   * processes to free and stay on their own schedule.
   *
   * Resolves with the number of terminals Sleep killed, the ladder's only
   * account of whether this lever did anything (#12517). Zero, touching
   * nothing, unless idle shells are opted in, and whenever a quiet window or
   * another sweep is in the way: the ladder re-measures and backs off.
   */
  async sleepUnderMemoryPressure(): Promise<number> {
    const config = this.getConfig();
    if (!config.enabled || !config.includeIdleShells) return 0;
    return this.sweep("memory-pressure");
  }

  private async sweep(trigger: IdleBackgroundSweepTrigger): Promise<number> {
    const config = this.getConfig();
    if (!config.enabled) return 0;

    // Startup quiet period — let services settle and don't act immediately after
    // launch. Gated on `quietUntil`, seeded once on first start.
    if (this.quietUntil !== null && Date.now() < this.quietUntil) {
      return 0;
    }

    // Post-wake quiet period — don't sweep while the OS is still stabilizing.
    if (this.wakeQuietUntil !== null && Date.now() < this.wakeQuietUntil) {
      return 0;
    }

    // Skip if a prior sweep is still running — a stalled `getAllTerminalsAsync`
    // (pty-host backpressure/restart) must not let the 5-min tick stack overlapping
    // sweeps that double-evaluate the same project against pre-write snapshots.
    // A pressure sweep and a scheduled one share the guard for the same reason.
    if (this.sweepInProgress) return 0;
    this.sweepInProgress = true;
    try {
      return await this.runSweep(trigger);
    } finally {
      this.sweepInProgress = false;
    }
  }

  /** Resolves with the number of terminals the sweep's sleeps killed. */
  private async runSweep(trigger: IdleBackgroundSweepTrigger): Promise<number> {
    const startedAt = performance.now();
    const config = this.getConfig();
    if (!config.enabled) return 0;
    const underPressure = trigger === "memory-pressure";
    if (underPressure && !config.includeIdleShells) return 0;

    // Read at every check rather than fixed here, so a threshold the user
    // raises mid-sweep holds the projects the sweep hasn't reached yet.
    const shellThresholdMs = !config.includeIdleShells
      ? null
      : underPressure
        ? () => this.pressureShellThresholdMs()
        : () => this.shellThresholdMs();
    const thresholdMs = underPressure ? null : config.thresholdMinutes * 60 * 1000;

    const projects = projectStore.getAllProjects();
    if (projects.length === 0) return 0;

    // Read the live terminal registry every sweep — never cache it in the timer
    // closure, so a project that briefly held a terminal and dropped back to
    // zero is re-evaluated fresh (lesson #8998). A degraded read aborts the
    // whole sweep: one silent shard would make every project on it look empty.
    const allTerminals = await this.readTerminals();
    if (!allTerminals) return 0;

    const now = Date.now();
    const activeIds = this.collectActiveProjectIds();

    const closed: IdleBackgroundClosedProjectEntry[] = [];
    let terminalsKilled = 0;
    /** Shell projects through the sweep's screen, slept after it, largest first. */
    const shellCandidates: Array<{ projectId: string; memoryKb: number }> = [];
    /** Projects held back purely by a live assistant — logged once per sweep. */
    const assistantProtected: string[] = [];
    /** Shell projects past their threshold that stayed awake, by the gate that held them. */
    const skipped: Partial<Record<SkipReason, string[]>> = {};
    const skip = (reason: SkipReason, projectId: string) => {
      (skipped[reason] ??= []).push(projectId);
    };
    /** The named plugin work holding each project the sweep screened out for it. */
    const pluginHolds: Record<string, string> = {};
    const holdForPluginWork = (projectId: string): boolean => {
      const hold = this.pluginWorkHold(projectId);
      if (hold === null) return false;
      pluginHolds[projectId] = hold;
      return true;
    };

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

      // The user opted this project out of automatic sleep; manual Sleep is
      // unaffected because it never passes through the sweep.
      if (project.neverAutoSleep) continue;

      // A project with idle shells or resting agents has a separate opt-in, a
      // separate threshold and a far longer list of things that hold it.
      const hasTerminals = allTerminals.some((t) => t.projectId === pid && isLiveTerminal(t));
      if (hasTerminals && shellThresholdMs) {
        if (this.hasLiveAssistantBackend(pid)) {
          assistantProtected.push(pid);
          continue;
        }
        if (!this.isShellIdleOffScreen(pid, project.lastOpened, shellThresholdMs())) continue;
        if (this.hasRemoteView(pid)) {
          skip("remote-host", pid);
          continue;
        }
        if (this.coordinationHold(pid) !== null) {
          skip("coordination-hold", pid);
          continue;
        }
        if (holdForPluginWork(pid)) {
          skip("plugin-work", pid);
          continue;
        }
        // Screen with the sweep's own snapshot first, so a project with a busy
        // shell costs no workspace or git reads. The census is read per project
        // because an earlier project's teardown can outlast its freshness bound.
        const census = await this.readProcessInventory();
        const screened = evaluateShellTerminals(
          pid,
          allTerminals,
          census,
          Date.now(),
          shellThresholdMs(),
          this.awakeSince
        );
        if (!screened.ok) {
          skip(screened.reason, pid);
          continue;
        }
        shellCandidates.push({
          projectId: pid,
          memoryKb: censusMemoryKb(census, pid, screened.value),
        });
        continue;
      }

      // Pressure only brings idle shells forward; these keep their own clock.
      if (thresholdMs === null) continue;

      // Still within the idle threshold.
      if (this.isWithinIdleThreshold(pid, project.lastOpened, now, thresholdMs)) continue;

      // Gate: terminal presence. Any live PTY means skip — we never tear down a
      // project that still has agent/terminal scrollback, and the Daintree
      // Assistant's help PTY now counts too (#11807). It used to be waved
      // through as tooling-internal, but the capture-revoke only preserves the
      // conversation: whatever wakeup or sub-agent the assistant had in flight
      // dies with the PTY, which is the reclaim this issue reports losing.
      const blocked = this.blockingReason(pid, allTerminals);
      if (blocked) {
        if (blocked === "assistant") assistantProtected.push(pid);
        else if (blocked === "coordination-hold") skip("coordination-hold", pid);
        else if (blocked === "plugin-work" && holdForPluginWork(pid)) skip("plugin-work", pid);
        continue;
      }

      try {
        const result = await this.closeProject(pid, now, thresholdMs);
        if (result) {
          closed.push(result.entry);
          terminalsKilled += result.terminalsKilled;
        }
      } catch (error) {
        // Isolate per project — one teardown failure must not abort the sweep.
        logError("idle-background-auto-close-project-failed", error, { projectId: pid });
      }
    }

    // Largest first, by the census's estimate: under pressure the ladder
    // re-measures as soon as this returns, so the projects freeing the most
    // shouldn't queue behind ones a later gate might hold anyway. Each one is
    // still vetted from scratch before its sleep; this order is all the
    // screen's census decides. Ties keep the store's order.
    if (shellThresholdMs) {
      shellCandidates.sort((a, b) => b.memoryKb - a.memoryKb);
      for (const [index, { projectId }] of shellCandidates.entries()) {
        if (
          underPressure &&
          index > 0 &&
          performance.now() - startedAt >= PRESSURE_SWEEP_BUDGET_MS
        ) {
          logInfo("idle-background-auto-close-pressure-budget-spent", {
            deferred: shellCandidates.slice(index).map((candidate) => candidate.projectId),
          });
          break;
        }
        try {
          const result = await this.closeShellProject(projectId, shellThresholdMs);
          if (result.status === "slept") {
            closed.push(result.entry);
            terminalsKilled += result.terminalsKilled;
          } else if (result.status === "skipped") {
            skip(result.reason, projectId);
            // A refusal after the kill still took the terminals.
            terminalsKilled += result.terminalsKilled ?? 0;
          }
        } catch (error) {
          logError("idle-background-auto-close-project-failed", error, { projectId });
        }
      }
    }

    // Mirrors HibernationService's `hibernate-skip-live-assistant`. Emitted from
    // the sweep only — the two `closeProject` re-checks share the predicate, so
    // logging there as well would just repeat this line.
    if (assistantProtected.length > 0) {
      logInfo("idle-background-auto-close-skip-live-assistant", {
        projectIds: assistantProtected,
      });
    }
    if (Object.keys(skipped).length > 0) {
      logInfo("idle-background-auto-close-skip-idle-shells", { reasons: skipped, trigger });
    }
    if (Object.keys(pluginHolds).length > 0) {
      logInfo("idle-background-auto-close-skip-plugin-work", { holds: pluginHolds, trigger });
    }

    if (closed.length === 0) return terminalsKilled;

    logInfo("idle-background-auto-close-fire", {
      trigger,
      projectCount: closed.length,
      terminalsKilled,
      estimatedMemoryKb: closed.reduce((sum, entry) => sum + (entry.estimatedMemoryKb ?? 0), 0),
      thresholdMinutes: config.thresholdMinutes,
      ...(shellThresholdMs
        ? { shellThresholdMinutes: Math.round(shellThresholdMs() / 60_000) }
        : {}),
    });

    const payload: IdleBackgroundClosedPayload = {
      projects: closed,
      timestamp: now,
      trigger,
    };
    try {
      broadcastToRenderer(CHANNELS.IDLE_BACKGROUND_CLOSED, payload);
    } catch {
      // Window may be closing.
    }
    return terminalsKilled;
  }

  /**
   * The fresh row if the project is still a reclaim candidate: auto-close still
   * enabled, the row still `background` and idle past the threshold, and not
   * foreground in any window. Synchronous, so callers can fence a write on it.
   */
  private readEligibleProject(projectId: string, now: number, thresholdMs: number) {
    if (!this.getConfig().enabled) return null;
    const fresh = projectStore.getProjectById(projectId);
    if (!fresh || fresh.status !== "background") return null;
    if (fresh.neverAutoSleep) return null;
    if (!fresh.lastOpened || fresh.lastOpened <= 0) return null;
    // Read the active set first: it is what stamps a visit that came and went
    // during the caller's await, and the age check below has to see that stamp.
    // Such a stamp postdates the sweep's `now`, so the age goes negative and the
    // project stays put.
    if (this.collectActiveProjectIds().has(projectId)) return null;
    if (this.isWithinIdleThreshold(projectId, fresh.lastOpened, now, thresholdMs)) return null;
    return fresh;
  }

  /** Sleep-adjusted time since `timestamp`; zero when that can't be measured. */
  private readonly awakeSince = (timestamp: number): number => {
    try {
      const sleepService = getSystemSleepService();
      if (sleepService.isSleeping()) return 0;
      return sleepService.getAwakeTimeSince(timestamp);
    } catch {
      return 0;
    }
  };

  private shellThresholdMs(): number {
    return this.getConfig().idleShellThresholdMinutes * 60 * 1000;
  }

  /**
   * The idle-shell threshold while memory is short: the active resource
   * profile's `memoryPressureInactiveMs`, but never longer than the threshold
   * the user chose. Read per check, so a profile change mid-sweep applies.
   */
  private pressureShellThresholdMs(): number {
    const profile = getResourceProfileService()?.getProfile() ?? "balanced";
    return Math.min(
      this.shellThresholdMs(),
      RESOURCE_PROFILE_CONFIGS[profile].memoryPressureInactiveMs
    );
  }

  /**
   * Off screen everywhere for the whole shell threshold, counting only time
   * the machine was awake. `getAwakeTimeSince` also starts no earlier than
   * this launch, so a restart gives every project the full threshold again.
   */
  private isShellIdleOffScreen(
    projectId: string,
    lastOpened: number,
    thresholdMs: number
  ): boolean {
    const idleSince = Math.max(this.visibilityClock.lastVisibleAt(projectId), lastOpened);
    if (idleSince > Date.now()) return false;
    return this.awakeSince(idleSince) >= thresholdMs;
  }

  /**
   * A remote Shell holds a view of this project, shown or cached. Hidden views
   * report no timestamp, so how long they have been out of sight is unknown,
   * and the project stays awake while any is attached.
   */
  private hasRemoteView(projectId: string): boolean {
    try {
      return getEndpointRegistry()
        .getRemote()
        .some((endpoint) => endpoint.projectId === projectId);
    } catch {
      return true;
    }
  }

  /** Every shard's census, or `null` when the read itself failed. */
  private async readProcessInventory(): Promise<ProcessInventoryRead | null> {
    const client = this.ptyClient;
    if (!client) return null;
    try {
      return await client.getProcessInventory();
    } catch {
      return null;
    }
  }

  /**
   * The project host's worktree states, or `null` when there's no answer. A
   * project whose host has been reclaimed has none, and stays awake: a setup
   * command it started can outlive it, and only it knows the worktree list.
   */
  private async readWorkspace(projectPath: string, projectId: string) {
    const workspaceClient = getWorkspaceClientRef();
    if (!workspaceClient) return null;
    try {
      return await withTimeout(
        workspaceClient.getAllStatesWithGitBackedForProjectAsync(projectPath, projectId),
        WORKSPACE_READ_TIMEOUT_MS,
        "workspace states read timed out"
      );
    } catch {
      return null;
    }
  }

  /** {@link readEligibleProject} for a project with idle shells. */
  private readEligibleShellProject(projectId: string, thresholdMs: () => number) {
    const config = this.getConfig();
    if (!config.enabled || !config.includeIdleShells) return null;
    const fresh = projectStore.getProjectById(projectId);
    if (!fresh || fresh.status !== "background") return null;
    if (fresh.neverAutoSleep) return null;
    if (!fresh.lastOpened || fresh.lastOpened <= 0) return null;
    if (this.collectActiveProjectIds().has(projectId)) return null;
    if (this.hasRemoteView(projectId)) return null;
    if (!this.isShellIdleOffScreen(projectId, fresh.lastOpened, thresholdMs())) return null;
    if (this.hasLiveAssistantBackend(projectId)) return null;
    return fresh;
  }

  /**
   * Put a project whose terminals are all idle shells or resting agents to
   * sleep (#13849, #13854).
   *
   * Every gate reads fresh here rather than trusting the sweep: workspace,
   * resource config and git first, then the terminal registry and the process
   * census together, then each agent's transcript, so what the kill trusts is
   * the last thing read before it. Sleep's own kill snapshot is then held to
   * the exact terminals vetted here, still quiet and each agent still the same
   * session at rest, so a shell opened or typed into after this point, or an
   * agent that takes a turn, stops it. Resource config and the repository are
   * read from disk rather than from the host, whose view of both is a cache.
   *
   * `thresholdMs` is the sweep's idle-shell threshold, the user's or the
   * shorter one memory pressure allows; every check here reads it.
   */
  private async closeShellProject(
    projectId: string,
    thresholdMs: () => number
  ): Promise<ShellCloseResult> {
    const project = this.readEligibleShellProject(projectId, thresholdMs);
    if (!project) return { status: "ineligible" };

    const read = await this.readWorkspace(project.path, projectId);
    const workspace = evaluateWorkspace(read);
    if (!workspace.ok) return { status: "skipped", reason: workspace.reason };
    const worktreePaths = workspace.value;
    const resources = await probeResourceConfig(project.path, worktreePaths);
    if (resources === "configured") return { status: "skipped", reason: "resource-configured" };
    if (resources === "unknown") return { status: "skipped", reason: "resource-unknown" };
    const gitBlock = evaluateGit(
      await probeRepositorySleepSafety([project.path, ...worktreePaths], {
        missingRepoIsClear: read?.gitBacked === false,
      })
    );
    if (gitBlock) return { status: "skipped", reason: gitBlock };

    const client = this.ptyClient;
    const [terminals, census] = await Promise.all([
      this.readTerminals(),
      this.readProcessInventory(),
    ]);
    if (!terminals) return { status: "skipped", reason: "terminal-unknown" };
    if (!this.readEligibleShellProject(projectId, thresholdMs)) return { status: "ineligible" };
    if (this.coordinationHold(projectId) !== null) {
      return { status: "skipped", reason: "coordination-hold" };
    }
    if (this.latePluginWorkHold(projectId) !== null) {
      return { status: "skipped", reason: "plugin-work" };
    }
    const vetted = evaluateShellTerminals(
      projectId,
      terminals,
      census,
      Date.now(),
      thresholdMs(),
      this.awakeSince
    );
    if (!vetted.ok) return { status: "skipped", reason: vetted.reason };
    // Every shell it had is gone since the sweep looked, so it is a project
    // with no terminals now, and those sleep on their own clock.
    if (vetted.value.size === 0) return { status: "ineligible" };
    const resumeRefusal = await this.agentResumeRefusal(projectId, vetted.value);
    if (resumeRefusal) return { status: "skipped", reason: resumeRefusal };
    if (!this.readEligibleShellProject(projectId, thresholdMs)) return { status: "ineligible" };
    // Taken now: once the kill lands there is no tree left to read. The kill
    // is held to exactly these terminals, so this is what it frees.
    const estimatedMemoryKb = censusMemoryKb(census, projectId, vetted.value);

    const outcome = await sleepProject(
      projectId,
      {
        initiator: "policy",
        autoParkedAt: Date.now(),
        isStillEligible: () =>
          this.ptyClient === client &&
          this.readEligibleShellProject(projectId, thresholdMs) !== null &&
          this.isUnheld(projectId),
        allowsTerminals: (snapshot) =>
          !snapshot.degraded &&
          terminalsStillVetted(
            projectId,
            snapshot.terminals,
            vetted.value,
            Date.now(),
            thresholdMs(),
            this.awakeSince
          ),
      },
      {
        ptyClient: client,
        workspaceClient: getWorkspaceClientRef(),
        projectViewManagers: this.projectViewManagersProvider ?? (() => []),
      }
    );
    if (outcome.status === "skipped") {
      return {
        status: "skipped",
        reason: outcome.reason === "in-flight" ? "ineligible" : outcome.reason,
        terminalsKilled: outcome.terminalsKilled,
      };
    }
    if (outcome.status !== "slept") return { status: "ineligible" };

    logInfo("idle-background-auto-close-slept-idle-shells", {
      projectId,
      terminalsKilled: outcome.terminalsKilled,
      estimatedMemoryKb,
    });
    return {
      status: "slept",
      entry: {
        projectId,
        projectName: project.name,
        ...(estimatedMemoryKb > 0 ? { estimatedMemoryKb } : {}),
      },
      terminalsKilled: outcome.terminalsKilled,
    };
  }

  /**
   * Whether every vetted agent would come back to this exact conversation
   * (#13848), asked last because it reads each transcript. Only a yes passes:
   * an agent without an assigned id, a transcript store that isn't certain or a
   * lookup that couldn't decide all hold the project, and the refusals are
   * logged as observed.
   */
  private async agentResumeRefusal(
    projectId: string,
    vetted: VettedTerminals
  ): Promise<IdleShellSkipReason | null> {
    const agents = [...vetted.values()].filter(isAgentTerminal);
    if (agents.length === 0) return null;
    let observations: Awaited<ReturnType<typeof observeExactAgentResumes>>;
    try {
      observations = await observeExactAgentResumes(agents);
    } catch (error) {
      logError("idle-background-auto-close-resume-read-failed", error, { projectId });
      return "agent-resume-unproven";
    }
    const refused = observations.flatMap(({ terminalId, verdict }) =>
      verdict.resumesExactly ? [] : [{ terminalId, reason: verdict.reason }]
    );
    if (refused.length === 0 && observations.length === agents.length) return null;
    logInfo("idle-background-auto-close-resume-unproven", { projectId, refused });
    return "agent-resume-unproven";
  }

  /**
   * Put a single background project to sleep — the same Sleep the user's
   * Sleep project runs (#13845), so an auto-closed project keeps its agents'
   * sessions and reopens exactly as a manually slept one does, but as a
   * POLICY: it re-asks eligibility at every await, never destroys a view an
   * MCP dispatch is waiting on, and stamps `autoParkedAt` so the switcher
   * labels it distinctly.
   */
  private async closeProject(
    projectId: string,
    now: number,
    thresholdMs: number
  ): Promise<{ entry: IdleBackgroundClosedProjectEntry; terminalsKilled: number } | null> {
    // Re-verify eligibility against FRESH state immediately before the
    // irreversible teardown. The sweep snapshotted projects (status, lastOpened)
    // and terminals before this async loop, so during an earlier project's awaits
    // the user could have switched to this project — which puts it on screen,
    // bumps its lastOpened and flips its status — or spawned a terminal in it
    // (TOCTOU). Re-
    // read the project row and the live registry, and bail if anything now
    // disqualifies it. Also re-check `enabled` so a toggle-off mid-sweep halts.
    const fresh = this.readEligibleProject(projectId, now, thresholdMs);
    if (!fresh) return null;

    const client = this.ptyClient;
    const liveTerminals = await this.readTerminals();
    // Re-read `enabled` after the await too: `stop()` nulls the client, and
    // without this a toggle-off landing mid-request would sail past every
    // remaining guard on an empty snapshot and tear the project down anyway.
    if (!liveTerminals) return null;
    const project = this.readEligibleProject(projectId, now, thresholdMs);
    if (!project) return null;
    const blocked = this.blockingReason(projectId, liveTerminals);
    if (blocked) {
      if (blocked === "plugin-work") this.latePluginWorkHold(projectId);
      return null;
    }

    // From here Sleep owns the order. Its capture-revoke settles whatever
    // non-live session records the project has left — the gate above floors a
    // live assistant — and every later await is followed by these same two
    // questions: is the project still a candidate (a window can activate it,
    // #13570, and `stop()` can clear the client), and do the terminals the
    // kill is about to take still leave it empty? A degraded snapshot can't
    // answer the second, so it reads as no.
    const outcome = await sleepProject(
      projectId,
      {
        initiator: "policy",
        autoParkedAt: now,
        isStillEligible: () =>
          this.ptyClient === client &&
          this.readEligibleProject(projectId, now, thresholdMs) !== null &&
          this.isUnheld(projectId),
        allowsTerminals: (snapshot) =>
          !snapshot.degraded && this.blockingReason(projectId, snapshot.terminals) === null,
      },
      {
        ptyClient: client,
        workspaceClient: getWorkspaceClientRef(),
        projectViewManagers: this.projectViewManagersProvider ?? (() => []),
      }
    );
    if (outcome.status !== "slept") return null;

    logInfo("idle-background-auto-close-closed", {
      projectId,
      terminalsKilled: outcome.terminalsKilled,
    });

    return {
      entry: { projectId, projectName: project.name },
      terminalsKilled: outcome.terminalsKilled,
    };
  }
}

let idleBackgroundAutoCloseService: IdleBackgroundAutoCloseService | null = null;

export function getIdleBackgroundAutoCloseService(): IdleBackgroundAutoCloseService {
  if (!idleBackgroundAutoCloseService) {
    idleBackgroundAutoCloseService = new IdleBackgroundAutoCloseService();
  }
  return idleBackgroundAutoCloseService;
}
