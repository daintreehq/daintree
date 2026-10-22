import { readdir, stat } from "fs/promises";
import path from "path";
import { ACTIVE_AGENT_STATES } from "../../shared/types/agent.js";
import type { HibernationProjectHibernatedPayload } from "../../shared/types/ipc/hibernation.js";
import { projectStore } from "./ProjectStore.js";
import { logInfo, logError } from "../utils/logger.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { writeHibernatedMarker } from "./pty/terminalSessionPersistence.js";
import type { PtyClient } from "./PtyClient.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { collectActiveProjectIds } from "../window/activeProjectIds.js";
import { getPtyClient } from "../window/serviceRefs.js";

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
 * HibernationService - Stops a project's terminals and dev servers when asked,
 * and evicts its cached renderer. Nothing hibernates on a timer: the scheduled
 * sweep and its "Hibernate inactive projects" setting were retired (#13840).
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Why this pattern:
 * - Requires lazy initialization: depends on PtyManager which uses dynamic import
 * - Singleton with deferred construction: getHibernationService() + initializeHibernationService()
 *
 * When to use Pattern C:
 * - Service has circular or dynamic dependencies (import() at runtime)
 * - Lazy initialization saves startup time if service isn't always needed
 * - Initialization timing matters (must wait for other services to be ready)
 */
export class HibernationService {
  // EXPERIMENT (hibernation removal, step 4): disables the PTY-kill so a
  // backgrounded project's terminals are never torn down by the *background*
  // path — memory pressure (hibernateUnderMemoryPressure, which skips its whole
  // sweep rather than running it to a no-op on every tier-2 pass, #12517).
  // User-initiated closes (#10831 — the idle "Close Them" action) deliberately
  // bypass this guard and DO kill, since the user explicitly asked for it; see the
  // `reason !== "user-initiated"` check in hibernateProject(). Every kill
  // funnels through the single `gracefulKillByProject` chokepoint there,
  // guarded below. On the paths that still reach it, the rest of the flow
  // (callbacks, the project-hibernated event, and the user-initiated
  // WebContentsView eviction we KEEP) is preserved. Typed
  // `boolean` (not the `true` literal) so the kill branch stays type-reachable
  // for the step-7 deletion; flip to `false` to revert.
  private static readonly EXPERIMENT_HIBERNATION_DISABLED: boolean = true;

  private readonly hibernationCallbacks: Array<(projectId: string) => void | Promise<void>> = [];
  private memoryPressureInactiveMs = DEFAULT_MEMORY_PRESSURE_INACTIVE_MS;
  private ptyClient: PtyClient | null = null;
  private projectViewManagersProvider: (() => ProjectViewManager[]) | null = null;
  private hasLiveAssistantBackend: ((projectId: string) => boolean) | null = null;

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
   * Inject the same live-assistant predicate `ProjectViewEvictionController`
   * uses, so background hibernation can't kill a running Daintree Assistant's
   * PTY process tree either (#11477).
   *
   * `hibernateUnderMemoryPressure` reaches this service from the very tier-2
   * ladder that drives cached-view reclaim, and its own guard is
   * `ACTIVE_AGENT_STATES` — the wrong signal, and knowingly so (#11157): an
   * assistant that dispatched a sub-agent or a background shell reads as idle
   * while that work runs on, which is precisely the case being lost. Binding
   * plus PTY liveness is the correct pair.
   *
   * Lazy closure, not a listener — nothing to dispose. Passing `null` clears it
   * and restores the unguarded behaviour.
   */
  setHasLiveAssistantBackend(predicate: ((projectId: string) => boolean) | null): void {
    this.hasLiveAssistantBackend = predicate;
  }

  /**
   * Inject a lazy provider over every open window's ProjectViewManager so
   * user-initiated hibernation can evict the hibernated project's cached
   * `WebContentsView` renderer (#10668) — the bulk of per-project memory that
   * killing PTYs alone leaves resident. Mirrors the `getAllProjectViewManagers`
   * lambda `ResourceProfileService` uses. Must stay lazy: windows open/close
   * after wiring. Never cleared on shutdown: it's a stateless closure over the
   * window registry, so it pins no stale object.
   */
  setProjectViewManagersProvider(provider: (() => ProjectViewManager[]) | null): void {
    this.projectViewManagersProvider = provider;
  }

  /**
   * The set of project IDs on-screen in ANY window. The DB current-project
   * pointer only tracks the last-focused window, so comparing against it alone
   * would hibernate a project the user is actively looking at in a second,
   * unfocused window (#11102).
   */
  private collectActiveProjectIds(): Set<string> {
    return collectActiveProjectIds(
      this.projectViewManagersProvider,
      projectStore.getCurrentProjectId(),
      "hibernation"
    );
  }

  setMemoryPressureThresholdMs(ms: number): void {
    // Reject non-finite/negative values: a NaN threshold fails every idle-time
    // comparison and would make every background project eligible.
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

  /**
   * Resolves with the number of terminals killed, which is the only account the
   * tier-2 ladder gets of whether this lever did anything (#12517).
   */
  async hibernateUnderMemoryPressure(): Promise<number> {
    // Under the experiment this path cannot kill anything, yet everything ahead
    // of the kill still ran on every tier-2 pass: a registry enumeration, a git
    // probe per candidate project, and then a "hibernated — 0 terminals
    // suspended" toast plus a dev-preview stop for a project that was never
    // hibernated (#12517). Skip it whole.
    if (HibernationService.EXPERIMENT_HIBERNATION_DISABLED) return 0;

    const projects = projectStore.getAllProjects();
    const now = Date.now();

    if (!this.ptyClient) return 0;
    const ptyClient = this.ptyClient;
    const allTerminals = await ptyClient.getAllTerminalsAsync();

    const activeIds = this.collectActiveProjectIds();
    let terminalsKilled = 0;
    let failures = 0;

    for (const project of projects) {
      // Never hibernate a project that's on-screen in ANY window (#11102).
      if (activeIds.has(project.id)) continue;

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

      // Re-read visibility immediately before acting — the git probe above is a
      // filesystem round-trip the user can bring the project on-screen during.
      if (this.collectActiveProjectIds().has(project.id)) continue;

      logInfo("memory-pressure-hibernate-project", {
        project: project.name,
        projectId: project.id,
        inactiveMinutes: Math.floor(inactiveDuration / 60000),
        terminalCount: projectTerminals.length,
      });

      try {
        terminalsKilled += await this.hibernateProject(
          project.id,
          project.name,
          "memory-pressure",
          ptyClient
        );
      } catch (error) {
        failures++;
        logError("memory-pressure-hibernate-failed", error, {
          project: project.name,
          projectId: project.id,
        });
      }
    }
    // A sweep that failed outright is not one that found nothing to do: the
    // ladder backs off a lever that did nothing, and must not mistake this
    // for one.
    if (failures > 0 && terminalsKilled === 0) {
      throw new Error(`memory-pressure hibernation failed for ${failures} project(s)`);
    }
    return terminalsKilled;
  }

  /**
   * Public entry point for hibernating a project on demand (e.g. from the
   * idle-terminal "Close Them" action). Routes through the injected PtyClient
   * so DevPreview callbacks fire and the renderer sees the standard
   * `hibernation:project-hibernated` event. No-op if the PtyClient has not been
   * injected yet.
   *
   * Defaults to `"user-initiated"` — this entry point is only reached through
   * explicit user actions, which (unlike memory-pressure hibernation) also
   * evict the project's cached renderer (#10668).
   */
  async hibernateProjectOnDemand(
    projectId: string,
    projectName: string,
    reason: HibernationProjectHibernatedPayload["reason"] = "user-initiated"
  ): Promise<number> {
    if (!this.ptyClient) return 0;
    return this.hibernateProject(projectId, projectName, reason, this.ptyClient);
  }

  private async hibernateProject(
    projectId: string,
    projectName: string,
    reason: HibernationProjectHibernatedPayload["reason"],
    ptyClient: PtyClient
  ): Promise<number> {
    // A running Daintree Assistant outranks background hibernation (#11477).
    // `hibernateUnderMemoryPressure` is driven by the same tier-2 ladder as
    // cached-view reclaim, and its own filter is `ACTIVE_AGENT_STATES` — the
    // signal #11157 established is wrong for this: an assistant that dispatched
    // a sub-agent or background shell reads as idle while that work runs on.
    // Killing here takes down its whole PTY process tree. Scoped to the
    // background reason — a user-initiated close asked for exactly this.
    const assistantProtected =
      reason !== "user-initiated" && this.hasLiveAssistantBackend?.(projectId) === true;
    if (assistantProtected) {
      logInfo("hibernate-skip-live-assistant", { project: projectName, projectId, reason });
    }

    // EXPERIMENT (hibernation removal, step 4): skip the PTY-kill so backgrounded
    // projects' terminals stay fully alive; report 0 killed. Scoped to the
    // background paths only — a user-initiated close (#10831, the idle "Close
    // Them" action) bypasses the guard and actually kills, because the user
    // explicitly requested it and the idle notification only surfaces when every
    // terminal is below the active-agent states. `preserveSession: true` flushes
    // scrollback before kill, so `.restore` files survive and terminals come back
    // on next project open.
    const results =
      assistantProtected ||
      (HibernationService.EXPERIMENT_HIBERNATION_DISABLED && reason !== "user-initiated")
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
    // renderer (#10668). Memory-pressure hibernation stays conservative — it
    // would silently turn a warm project cold, and renderer
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
  return service;
}
