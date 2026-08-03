/**
 * WorkspaceClient - Per-project workspace host process manager.
 *
 * Manages one UtilityProcess per active project path, with refcounting
 * for windows sharing the same project. Replaces the former singleton
 * host pattern that caused cross-project contamination.
 *
 * This file is the public facade. Internal modules live under
 * `workspace-client/`: WorkspaceHostPool, WorkspaceHostEventRouter,
 * WorkspaceCopyTreeClient.
 */

import { EventEmitter } from "events";
import { CHANNELS } from "../ipc/channels.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { type ProcessEntry, sendToEntryWindows } from "./workspace-client/types.js";
import {
  WorkspaceHostPool,
  WorkspaceHostEventRouter,
  WorkspaceCopyTreeClient,
} from "./workspace-client/index.js";
import type { WorkspaceHostProcess } from "./WorkspaceHostProcess.js";
import type { ForgeProviderMatcher } from "../../shared/utils/forgeHostnames.js";
import type {
  WorkspaceClientConfig,
  WorktreeSnapshot,
  MonitorConfig,
  CreateWorktreeOptions,
  BranchInfo,
  WorkspaceHostGovernanceSnapshot,
} from "../../shared/types/workspace-host.js";
import type {
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeResult,
  FileTreeNode,
} from "../../shared/types/ipc.js";
import type { ProjectPulse, PulseRangeDays } from "../../shared/types/pulse.js";
import type { GitFileDiffResult } from "../../shared/types/ipc/git.js";

const STATES_INFLIGHT_COALESCE_WINDOW_MS = 150;

// Manual PR refresh re-resolves the forge provider, re-detects every PR, and
// now awaits the CI-status batch on top, so it needs more than the host's 30s
// default per-request budget. Matches HOST_REFRESH_TIMEOUT_MS (WorkspaceService),
// the watchdog the port-driven refresh already bounds the same work with, so
// both entry points give up at the same point instead of one reporting failure
// while the other is still waiting. Raised only for this request type.
const REFRESH_PRS_TIMEOUT_MS = 45_000;

// Upper bound on how long a worktree-state read waits for the host to finish
// (re)populating its monitor map before giving up and reporting "unknown" ([]).
//
// Deliberately NOT sized against the host's 30s per-request timeout: this gate
// sits on hydration's critical path — every PTY restore awaits
// resolveRestoredWorktreeId -> the worktree prefetch -> this gate before its
// panel is added — so a host that forks but hangs before posting "ready"
// (waitForReady() carries no timeout of its own) would hold back EVERY terminal
// for the whole deadline. Timing out costs only a missed re-home: the failure
// path returns [], the established "unknown, keep saved state" sentinel
// (#11234), which is exactly what restore did before the gate existed. So the
// bound is set by what a user can be made to stare at, not by the host's
// request budget — 5s matches the app's other hydration-facing give-up bound
// (SIDEBAR_HYDRATION_UNLOCK_FALLBACK_MS, #10827) and still leaves a healthy
// cold-start syncMonitors ample room to finish, so the gate keeps doing its
// job in every non-pathological case.
const STATES_READY_GATE_TIMEOUT_MS = 5_000;

export type CopyTreeProgressCallback = (progress: CopyTreeProgress) => void;

function dedupeSnapshotsById(states: WorktreeSnapshot[]): WorktreeSnapshot[] {
  const seen = new Set<string>();
  const deduped: WorktreeSnapshot[] = [];
  for (const state of states) {
    if (seen.has(state.id)) continue;
    seen.add(state.id);
    deduped.push(state);
  }
  return deduped;
}

/**
 * A host's worktree snapshot read plus its own "is there a repository here"
 * verdict. `gitBacked: null` is "not classified" — never read it as `false`
 * (#11650). Main-process shape; the renderer sees `WorktreeListResult`.
 */
export interface HostWorktreeStates {
  states: WorktreeSnapshot[];
  gitBacked: boolean | null;
}

export class WorkspaceClient extends EventEmitter {
  private isDisposed = false;
  private pool: WorkspaceHostPool;
  private eventRouter: WorkspaceHostEventRouter;
  private copyTree: WorkspaceCopyTreeClient;

  private readonly _statesInflight = new Map<string, Promise<WorktreeSnapshot[]>>();
  private readonly _statesWithGitBackedInflight = new Map<string, Promise<HostWorktreeStates>>();

  constructor(config: WorkspaceClientConfig = {}) {
    super();

    this.pool = new WorkspaceHostPool({
      config,
      emit: this.emit.bind(this),
      onProjectSwitch: (windowId) => {
        this._statesInflight.delete(`w:${windowId}`);
      },
    });

    this.copyTree = new WorkspaceCopyTreeClient({
      resolveHostForPath: (p) => this.pool.resolveHostForPath(p),
      iterateEntries: () => this.pool.entries.values(),
    });

    this.eventRouter = new WorkspaceHostEventRouter({
      emit: this.emit.bind(this),
      worktreePathToProject: this.pool.worktreePathToProject,
      copyTreeProgressCallbacks: this.copyTree.copyTreeProgressCallbacks,
    });

    this.pool.setRouteHostEvent((entry, event) => {
      if (this.isDisposed) return;
      this.eventRouter.routeHostEvent(entry, event);
    });
  }

  // ── Readiness ──

  async waitForReady(): Promise<void> {
    return this.pool.waitForReady();
  }

  isReady(): boolean {
    if (this.isDisposed) return false;
    return this.pool.isReady();
  }

  // ── Entry resolution (public) ──

  getHostForProject(projectPath: string): WorkspaceHostProcess | undefined {
    return this.pool.getHostForProject(projectPath);
  }

  getHostForWindow(windowId: number): WorkspaceHostProcess | undefined {
    return this.pool.getHostForWindow(windowId);
  }

  // ── Process lifecycle ──

  async loadProject(rootPath: string, windowId: number): Promise<void> {
    if (this.isDisposed) {
      throw new Error("WorkspaceClient disposed");
    }
    return this.pool.loadProject(rootPath, windowId);
  }

  prewarmProject(rootPath: string): void {
    if (this.isDisposed) return;
    this.pool.prewarmProject(rootPath);
  }

  /**
   * Push updated forge settings to the live host for `projectPath` so its
   * PR provider re-resolves after the user changes the provider override or
   * selected remote (#8456). No-ops when no host is loaded for the project.
   */
  async updateForgeSettings(projectPath: string): Promise<void> {
    if (this.isDisposed) return;
    await this.pool.updateForgeSettings(projectPath);
  }

  // ── Direct port management ──

  attachDirectPort(windowId: number, webContents: Electron.WebContents): void {
    this.pool.attachDirectPort(windowId, webContents);
  }

  removeDirectPort(webContentsId: number): void {
    this.pool.removeDirectPort(webContentsId);
  }

  unregisterWindow(windowId: number): void {
    this.pool.unregisterWindow(windowId);
  }

  manualRestartForWindow(windowId: number): void {
    if (this.isDisposed) return;
    this.pool.manualRestartForWindow(windowId);
  }

  // ── Fan-out: sync / refresh ──

  async sync(
    worktrees: import("../../shared/types/worktree.js").Worktree[],
    activeWorktreeId: string | null = null,
    mainBranch: string = "main",
    monitorConfig?: MonitorConfig
  ): Promise<void> {
    for (const entry of this.pool.entries.values()) {
      const requestId = entry.host.generateRequestId();
      await entry.host.sendWithResponse({
        type: "sync",
        requestId,
        worktrees,
        activeWorktreeId,
        mainBranch,
        monitorConfig,
      });
    }
  }

  async refresh(worktreeId?: string): Promise<void> {
    for (const entry of this.pool.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "refresh",
          requestId,
          worktreeId,
        });
      } catch {
        // Host may be crashed
      }
    }
  }

  async refreshOnWake(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.pool.entries.values()).map(async (entry) => {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "refresh-on-wake",
          requestId,
        });
      })
    );
  }

  async refreshPullRequests(): Promise<void> {
    // Fan out concurrently (matching refreshOnWake above): hosts are
    // independent projects, so awaiting them in sequence made a multi-project
    // refresh walk them one at a time for no quota benefit — each provider
    // owns its own transport limits.
    await Promise.allSettled(
      Array.from(this.pool.entries.values()).map(async (entry) => {
        try {
          const requestId = entry.host.generateRequestId();
          // A manual refresh now awaits CI enrichment on top of provider
          // re-resolution and PR re-detection, so the default 30s response
          // budget is tight for the extra round trip.
          await entry.host.sendWithResponse(
            {
              type: "refresh-prs",
              requestId,
            },
            REFRESH_PRS_TIMEOUT_MS
          );
        } catch {
          // Host may be crashed
        }
      })
    );
  }

  // ── Fan-out: PR / polling / config ──

  async getPRStatus(): Promise<
    import("../../shared/types/workspace-host.js").PRServiceStatus | null
  > {
    for (const entry of this.pool.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        const result = await entry.host.sendWithResponse<{
          status: import("../../shared/types/workspace-host.js").PRServiceStatus | null;
        }>({
          type: "get-pr-status",
          requestId,
        });
        return result.status;
      } catch {
        // Try next
      }
    }
    return null;
  }

  async resetPRState(): Promise<void> {
    for (const entry of this.pool.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "reset-pr-state",
          requestId,
        });
      } catch {
        // ignore
      }
    }
  }

  setPollingEnabled(enabled: boolean): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "set-polling-enabled", enabled });
    }
  }

  /**
   * Broadcast that a forge provider descriptor was registered (startup scan
   * or runtime plugin install/enable) so hosts whose PR polling paused on a
   * "no provider matches" resolution re-evaluate (#9997). Fire-and-forget,
   * mirroring the polling-control sends above.
   */
  notifyForgeProviderRegistryUpdated(): void {
    if (this.isDisposed) return;
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "forge:provider-registry-updated" });
    }
  }

  setPRPollCadence(focused: boolean): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "set-pr-poll-cadence", focused });
    }
  }

  setWslOptIn(worktreeId: string, enabled: boolean, dismissed: boolean): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({
        type: "set-wsl-opt-in",
        worktreeId,
        enabled,
        dismissed,
      });
    }
  }

  reprobeWsl(worktreeId: string): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "reprobe-wsl", worktreeId });
    }
  }

  updateMonitorConfig(config: MonitorConfig): void {
    this.pool.updateMonitorConfig(config);
  }

  pauseProject(projectPath: string): void {
    const host = this.pool.getHostForProject(projectPath);
    if (host) {
      host.send({ type: "background" });
    }
  }

  resumeProject(projectPath: string): void {
    const host = this.pool.getHostForProject(projectPath);
    if (host) {
      host.send({ type: "foreground" });
    }
  }

  /**
   * Force-evict the workspace host for `projectPath` (user-initiated "free
   * memory"). No-op when the client is disposed. Returns false when no host is
   * loaded or the project is still held by a window (see
   * {@link WorkspaceHostPool.evictProject}).
   */
  evictProject(projectPath: string): boolean {
    if (this.isDisposed) return false;
    return this.pool.evictProject(projectPath);
  }

  /**
   * Force-evict the workspace host for a project being RELOCATED, bypassing the
   * `refCount > 0` guard that {@link evictProject} honors. Only the phase-3
   * relocation coordinator calls this — after the folder moves, the old host is
   * respawned at the new path by the reopening `loadProject`
   * (see {@link WorkspaceHostPool.evictProjectForRelocation}).
   */
  evictProjectForRelocation(projectPath: string): void {
    if (this.isDisposed) return;
    this.pool.evictProjectForRelocation(projectPath);
  }

  pauseHealthCheck(): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.pauseHealthCheck();
    }
  }

  resumeHealthCheck(): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.resumeHealthCheck();
    }
  }

  // ── Forge credentials ──

  updateForgeCredentials(
    providerId: string,
    credentials: import("../../shared/types/forge.js").Credentials | null
  ): void {
    this.eventRouter.updateForgeCredentials(providerId, credentials);
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "update-forge-credentials", providerId, credentials });
    }
  }

  /**
   * User-triggered retry of auth-suspended fetches across every workspace-host.
   * Clears the per-repo auth suspension and re-fetches — the only safe way out
   * of indefinite auth suspension (see WorkspaceService.retryAuthFetch).
   */
  retryAuthFetch(): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "retry-auth-fetch" });
    }
  }

  // ── Log overrides ──

  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.pool.setLogLevelOverrides(overrides);
  }

  // ── Fetch throttle ──

  relayFetchThrottle(multiplier: number): void {
    this.pool.relayFetchThrottle(multiplier);
  }

  // ── Forge provider matchers ──

  relayForgeProviderMatchers(matchers: ForgeProviderMatcher[]): void {
    this.pool.relayForgeProviderMatchers(matchers);
  }

  // ── Worker governance ──

  /**
   * Pull the worker-governance snapshot from every live workspace host
   * (copytree worker state + host memory), tagged with the owning project
   * path. Per-host failures degrade to an entry in `errors` — one crashed or
   * slow host must not blank the report for the others.
   */
  async getWorkerGovernanceSnapshotsAsync(): Promise<{
    hosts: Array<{ projectPath: string; snapshot: WorkspaceHostGovernanceSnapshot }>;
    errors: Array<{ projectPath: string; error: string }>;
  }> {
    if (this.isDisposed) return { hosts: [], errors: [] };
    const entries = [...this.pool.entries.values()];
    const hosts: Array<{ projectPath: string; snapshot: WorkspaceHostGovernanceSnapshot }> = [];
    const errors: Array<{ projectPath: string; error: string }> = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const requestId = entry.host.generateRequestId();
          const result = await entry.host.sendWithResponse<{
            snapshot: WorkspaceHostGovernanceSnapshot;
          }>({ type: "governance:snapshot", requestId });
          hosts.push({ projectPath: entry.projectPath, snapshot: result.snapshot });
        } catch (error) {
          errors.push({
            projectPath: entry.projectPath,
            error: formatErrorMessage(error, "governance snapshot failed"),
          });
        }
      })
    );
    return { hosts, errors };
  }

  // ── State queries ──

  getAllStatesAsync(windowId?: number): Promise<WorktreeSnapshot[]> {
    const key = windowId !== undefined ? `w:${windowId}` : "all";
    const existing = this._statesInflight.get(key);
    if (existing) return existing;

    const promise = this._doGetAllStates(windowId).then(
      (result) => {
        setTimeout(() => this._statesInflight.delete(key), STATES_INFLIGHT_COALESCE_WINDOW_MS);
        return result;
      },
      (error) => {
        this._statesInflight.delete(key);
        throw error;
      }
    );
    this._statesInflight.set(key, promise);
    return promise;
  }

  /**
   * The project-scoped read of {@link getAllStatesForProjectAsync}, but keeping
   * the host's `gitBacked` verdict alongside the states instead of discarding
   * it (#11650).
   *
   * Coalesced through its own map rather than sharing `_statesInflight`:
   * callers of the array-shaped method rely on getting the *same promise
   * object* back for concurrent equivalent calls, which deriving one from the
   * other with `.then()` would break. The extra `get-all-states` round trip in
   * the rare overlap is a snapshot read off an already-ready host's in-memory
   * monitor map, not a git spawn.
   */
  getAllStatesWithGitBackedForProjectAsync(
    projectPath: string,
    expectedProjectId: string
  ): Promise<HostWorktreeStates> {
    const normalized = this.pool.normalizeProjectPath(projectPath);
    const key = `p:${expectedProjectId}:${normalized}`;
    const existing = this._statesWithGitBackedInflight.get(key);
    if (existing) return existing;

    const entry = this.pool.entries.get(normalized);
    const matchedEntry =
      entry !== undefined && entry.projectId === expectedProjectId ? entry : undefined;
    const promise = (
      matchedEntry === undefined
        ? // No host for this project yet. `gitBacked: null` rather than `false`
          // — nothing has probed the folder, so this is "unknown", and a caller
          // that read it as "not a repository" would strip a real repo's saved
          // worktree state during the boot race this sentinel exists for.
          Promise.resolve({ states: [], gitBacked: null } satisfies HostWorktreeStates)
        : this._readStatesWithGitBackedWhenReady(matchedEntry)
    ).then(
      (result) => {
        setTimeout(
          () => this._statesWithGitBackedInflight.delete(key),
          STATES_INFLIGHT_COALESCE_WINDOW_MS
        );
        return result;
      },
      (error) => {
        this._statesWithGitBackedInflight.delete(key);
        throw error;
      }
    );
    this._statesWithGitBackedInflight.set(key, promise);
    return promise;
  }

  /**
   * States for one project's host, keyed by project path rather than window.
   * `windowToProject` is repointed to the incoming project the moment a switch
   * starts, so window-scoped lookups from a backgrounded view resolve against
   * the active project's host; this resolves the host from the pool's
   * project-path entries, which stay bound to their project for the host's
   * lifetime. No host for the path returns `[]` — never a wildcard scan.
   *
   * `expectedProjectId` must match the entry's immutable `projectId` (resolved
   * once at host construction). The project *row*'s path is mutable through
   * `project:update`, so a path alone is not an authorization identity: a
   * renderer that rewrote its own project's path to a sibling's would
   * otherwise select the sibling's warm host. A mismatch returns `[]`.
   */
  getAllStatesForProjectAsync(
    projectPath: string,
    expectedProjectId: string
  ): Promise<WorktreeSnapshot[]> {
    const normalized = this.pool.normalizeProjectPath(projectPath);
    const key = `p:${expectedProjectId}:${normalized}`;
    const existing = this._statesInflight.get(key);
    if (existing) return existing;

    const entry = this.pool.entries.get(normalized);
    const matchedEntry =
      entry !== undefined && entry.projectId === expectedProjectId ? entry : undefined;
    const promise = (
      matchedEntry === undefined
        ? Promise.resolve([] as WorktreeSnapshot[])
        : // Gate on the host's readiness so a mid-`syncMonitors` partial list is
          // never returned to a hydration prefetch (#11387) — same guard as the
          // window-scoped path.
          this._readStatesWhenReady(matchedEntry)
    ).then(
      (result) => {
        setTimeout(() => this._statesInflight.delete(key), STATES_INFLIGHT_COALESCE_WINDOW_MS);
        return result;
      },
      (error) => {
        this._statesInflight.delete(key);
        throw error;
      }
    );
    this._statesInflight.set(key, promise);
    return promise;
  }

  /**
   * Read a single host's worktree states, but only once the host has FINISHED
   * (re)populating its monitor map — and never otherwise. `syncMonitors` builds
   * `this.monitors` one worktree at a time inside `load-project`, so a
   * `get-all-states` request that lands mid-loop returns a non-empty PARTIAL
   * list (often just the main worktree, since git enumerates it first). Restore
   * then trusts that partial snapshot as authoritative and re-homes every
   * not-yet-synced panel onto the active worktree — the exact collapse in
   * #11387.
   *
   * `entry.currentReadyPromise` resolves only after `load-project` (and thus the
   * whole `syncMonitors` loop) completes, and it is reassigned to the reload
   * promise on crash-restart, so it gates both the initial and the post-restart
   * populate — the only two windows in which the map is genuinely partial
   * (steady-state reconciles never drop a live monitor mid-loop).
   *
   * When readiness does NOT resolve cleanly we must not read at all: a rejected
   * `load-project` (e.g. its 30s request timeout fires while the host keeps
   * syncing, or `addNewWorktreeMonitor` throws mid-loop) leaves the host's map
   * genuinely partial, and reading it would resurrect #11387; a host that forks
   * but hangs before posting "ready" would leave the await pending forever
   * (`waitForReady` has no timeout). Both cases return `[]` — the established
   * "unknown, keep saved state" sentinel (#11234) — never a partial and never a
   * hang. Once the host is ready the gate is a resolved-promise microtask, so
   * steady-state reads are unaffected.
   */
  private async _readStatesWhenReady(entry: ProcessEntry): Promise<WorktreeSnapshot[]> {
    return (await this._readStatesWithGitBackedWhenReady(entry)).states;
  }

  /**
   * The same readiness-gated read, keeping the host's `gitBacked` verdict.
   *
   * A host that never became ready answers `gitBacked: null`, matching the `[]`
   * states sentinel: both mean "unknown", and a caller must not read either as
   * "this folder has no repository" (#11650). A host that predates the field
   * also answers `null` via the `?? null`, so an older host degrades to today's
   * permissive behavior rather than to a wrong `false`.
   */
  private async _readStatesWithGitBackedWhenReady(
    entry: ProcessEntry
  ): Promise<HostWorktreeStates> {
    if (!(await this._awaitHostReady(entry))) return { states: [], gitBacked: null };
    const requestId = entry.host.generateRequestId();
    const result = await entry.host.sendWithResponse<{
      states: WorktreeSnapshot[];
      gitBacked?: boolean | null;
    }>({
      type: "get-all-states",
      requestId,
    });
    return { states: result.states, gitBacked: result.gitBacked ?? null };
  }

  /**
   * Resolves `true` when the host's monitor populate completed, `false` if it
   * failed or did not settle within {@link STATES_READY_GATE_TIMEOUT_MS}.
   * Callers must treat `false` as "unknown" and return `[]` rather than reading
   * a possibly-partial map. Never rejects.
   */
  private _awaitHostReady(entry: ProcessEntry): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STATES_READY_GATE_TIMEOUT_MS);
    });
    const settled = entry.currentReadyPromise.then(
      () => true,
      () => false
    );
    return Promise.race([settled, timedOut]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private async _doGetAllStates(windowId?: number): Promise<WorktreeSnapshot[]> {
    if (windowId !== undefined) {
      const entry = this.pool.resolveEntryForWindow(windowId);
      if (!entry) return [];
      return this._readStatesWhenReady(entry);
    }

    const entries = [...this.pool.entries.values()];
    const results = await Promise.allSettled(
      entries.map((entry) => this._readStatesWhenReady(entry))
    );
    return dedupeSnapshotsById(
      results
        .filter((r): r is PromiseFulfilledResult<WorktreeSnapshot[]> => r.status === "fulfilled")
        .flatMap((r) => r.value)
    );
  }

  async getMonitorAsync(worktreeId: string): Promise<WorktreeSnapshot | null> {
    for (const entry of this.pool.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        const result = await entry.host.sendWithResponse<{
          state: WorktreeSnapshot | null;
        }>({
          type: "get-monitor",
          requestId,
          worktreeId,
        });
        if (result.state) return result.state;
      } catch {
        // Try next host
      }
    }
    return null;
  }

  // ── Worktree activation ──

  async setActiveWorktree(
    worktreeId: string,
    windowId?: number,
    options?: { silent?: boolean }
  ): Promise<void> {
    const hosts =
      windowId !== undefined
        ? ([this.pool.resolveHostForWindow(windowId)].filter(Boolean) as WorkspaceHostProcess[])
        : [...this.pool.entries.values()].map((e) => e.host);

    let accepted = false;
    for (const host of hosts) {
      try {
        const requestId = host.generateRequestId();
        await host.sendWithResponse({
          type: "set-active",
          requestId,
          worktreeId,
          // Propagate the silent flag so the host's `worktree-activated` event
          // carries the same gating intent. Every successful `set-active`
          // round-trips a `worktree-activated` event back to the main-process
          // router (`WorkspaceHostEventRouter`), which is the SOLE plugin-bus
          // source — it suppresses the emit when silent. We do NOT emit
          // `worktree-activated` here ourselves; doing so double-fired
          // `PluginService.onDidChangeActiveWorktree` (#9945). The
          // `CHANNELS.WORKTREE_ACTIVATED` legacy renderer echo below is a
          // separate surface and is still gated by this same flag.
          silent: options?.silent,
        });
        accepted = true;
        break;
      } catch {
        // Try next
      }
    }

    if (accepted && !options?.silent) {
      // Legacy renderer echo only. The plugin-bus `worktree-activated` emit is
      // owned solely by `WorkspaceHostEventRouter`, fed by the host round-trip
      // — emitting it here too double-fired plugin subscribers (#9945).
      if (windowId !== undefined) {
        const entry = this.pool.resolveEntryForWindow(windowId);
        if (entry) {
          sendToEntryWindows(entry, CHANNELS.WORKTREE_ACTIVATED, {
            worktreeId,
          });
        }
      } else {
        for (const entry of this.pool.entries.values()) {
          sendToEntryWindows(entry, CHANNELS.WORKTREE_ACTIVATED, {
            worktreeId,
          });
        }
      }
    }
  }

  // ── Path-routed CRUD passthroughs ──

  async listBranches(rootPath: string): Promise<BranchInfo[]> {
    const host = this.pool.resolveHostForPath(rootPath);
    if (!host) return [];
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ branches: BranchInfo[] }>({
      type: "list-branches",
      requestId,
      rootPath,
    });
    return result.branches;
  }

  async getRecentBranches(rootPath: string): Promise<string[]> {
    const host = this.pool.resolveHostForPath(rootPath);
    if (!host) return [];
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ branches: string[] }>({
      type: "get-recent-branches",
      requestId,
      rootPath,
    });
    return result.branches;
  }

  async fetchPRBranch(rootPath: string, prNumber: number, headRefName: string): Promise<void> {
    const host = this.pool.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for project");
    const requestId = host.generateRequestId();
    await host.sendWithResponse({
      type: "fetch-pr-branch",
      requestId,
      rootPath,
      prNumber,
      headRefName,
    });
  }

  async createWorktree(rootPath: string, options: CreateWorktreeOptions): Promise<string> {
    const host = this.pool.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for project");
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ worktreeId?: string }>({
      type: "create-worktree",
      requestId,
      rootPath,
      options,
    });
    return result.worktreeId ?? options.path;
  }

  async deleteWorktree(
    worktreeId: string,
    force: boolean = false,
    deleteBranch: boolean = false
  ): Promise<void> {
    let lastError: Error | undefined;
    for (const entry of this.pool.entries.values()) {
      try {
        const requestId = entry.host.generateRequestId();
        await entry.host.sendWithResponse({
          type: "delete-worktree",
          requestId,
          worktreeId,
          force,
          deleteBranch,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error(`Worktree not found: ${worktreeId}`);
  }

  async getFileDiff(
    cwd: string,
    filePath: string,
    status: string,
    ignoreWhitespace?: boolean,
    offset?: number,
    maxBytes?: number
  ): Promise<GitFileDiffResult> {
    const host = this.pool.resolveHostForPath(cwd);
    if (!host) throw new Error("No workspace host for path");
    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{
      diff: string;
      offset: number;
      totalBytes: number;
      truncated: boolean;
      nextOffset: number | null;
    }>({
      type: "get-file-diff",
      requestId,
      cwd,
      filePath,
      status,
      ignoreWhitespace,
      offset,
      maxBytes,
    });
    return {
      content: result.diff,
      offset: result.offset,
      totalBytes: result.totalBytes,
      truncated: result.truncated,
      nextOffset: result.nextOffset,
    };
  }

  // ── CopyTree ──

  async generateContext(
    rootPath: string,
    options?: CopyTreeOptions,
    onProgress?: CopyTreeProgressCallback,
    outputPath?: string
  ): Promise<CopyTreeResult> {
    return this.copyTree.generateContext(rootPath, options, onProgress, outputPath);
  }

  cancelContext(operationId: string): void {
    this.copyTree.cancelContext(operationId);
  }

  async testConfig(
    rootPath: string,
    options?: CopyTreeOptions
  ): Promise<import("../../shared/types/index.js").CopyTreeTestConfigResult> {
    return this.copyTree.testConfig(rootPath, options);
  }

  cancelAllContext(): void {
    this.copyTree.cancelAllContext();
  }

  // ── Project Pulse ──

  async getProjectPulse(
    worktreePath: string,
    worktreeId: string,
    mainBranch: string,
    rangeDays: PulseRangeDays,
    options?: {
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }
  ): Promise<ProjectPulse> {
    const host = this.pool.resolveHostForPath(worktreePath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{ data: ProjectPulse }>(
      {
        type: "git:get-project-pulse",
        requestId,
        worktreePath,
        worktreeId,
        mainBranch,
        rangeDays,
        includeDelta: options?.includeDelta,
        includeRecentCommits: options?.includeRecentCommits,
        forceRefresh: options?.forceRefresh,
      },
      30000
    );
    return result.data;
  }

  // ── Pulse cache ──

  invalidatePulseCache(worktreeId: string): void {
    for (const entry of this.pool.entries.values()) {
      entry.host.send({ type: "invalidate-pulse-cache", worktreeId });
    }
  }

  // ── File tree ──

  /**
   * Raw listing for the file browser: every entry, hidden client-side (#11330).
   * For "what would actually land in the context", use `getContextFileTree`.
   */
  async getFileTree(worktreePath: string, dirPath?: string): Promise<FileTreeNode[]> {
    const host = this.pool.resolveHostForPath(worktreePath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const result = await host.sendWithResponse<{
      nodes: FileTreeNode[];
      error?: string;
    }>(
      {
        type: "get-file-tree",
        requestId,
        worktreePath,
        dirPath,
      },
      30000
    );

    if (result.error) {
      throw new Error(result.error);
    }
    return result.nodes;
  }

  async getContextFileTree(
    worktreePath: string,
    dirPath?: string,
    options?: CopyTreeOptions,
    includeExcluded?: boolean
  ): Promise<FileTreeNode[]> {
    return this.copyTree.getContextFileTree(worktreePath, dirPath, options, includeExcluded);
  }

  // ── Disposal ──

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.eventRouter.dispose();
    this.copyTree.dispose();
    this.pool.dispose();
    this._statesInflight.clear();
    this.removeAllListeners();
  }
}

// Singleton management
let workspaceClientInstance: WorkspaceClient | null = null;

export function getWorkspaceClient(config?: WorkspaceClientConfig): WorkspaceClient {
  if (!workspaceClientInstance) {
    workspaceClientInstance = new WorkspaceClient(config);
  }
  return workspaceClientInstance;
}

export function disposeWorkspaceClient(): void {
  if (workspaceClientInstance) {
    workspaceClientInstance.dispose();
    workspaceClientInstance = null;
  }
}
