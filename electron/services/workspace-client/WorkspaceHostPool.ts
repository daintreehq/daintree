// eager-import-allow: reads workspace-host config via store.get synchronously during pool setup
import os from "node:os";
import { type WebContents } from "electron";
import path from "path";
import { WorkspaceHostProcess, type WorkspaceHostDisposeReason } from "../WorkspaceHostProcess.js";
import { store } from "../../store.js";
import { computeDefaultWarmWorkspaceHosts } from "../../utils/warmWorkspaceHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { isValidLogOverrideLevel } from "../../utils/logger.js";
import { type ProcessEntry, sendToEntryWindows } from "./types.js";
import type { WorkspaceClientConfig } from "../../../shared/types/workspace-host.js";
import type { ForgeProviderMatcher } from "../../../shared/utils/forgeHostnames.js";
import { projectStore } from "../ProjectStore.js";
import { normalizeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import type { HostLoadKind } from "../ProjectSwitchStatusTiming.js";

const CLEANUP_GRACE_MS = 180_000;

// Dormant workspace-host warm pool, RAM-scaled (2/3/4/5 across <16/16/32/64
// GiB). The old fixed 3 meant cycling 5+ projects evicted/respawned a host on
// nearly every switch (utility-process fork + a full git rescan each time) —
// churn that shows up as workspace-host spawn storms. Switch-away hosts are
// paused (background: polling/PR/fetch timers stopped) and a dormant host
// expires within one CLEANUP_GRACE_MS of the last view of its project going
// away, so a larger pool mainly avoids respawns on switch-back. The cost is
// bounded-resident (a few more paused utility processes + their health
// checks), not steady-state polling.
//
// The ladder lives in computeDefaultWarmWorkspaceHosts rather than being
// borrowed from computeDefaultCachedViews, which it used to call: see that
// function for why a paused utility process and a cached renderer must be
// sized apart (#11926).
const DEFAULT_CONFIG: Required<WorkspaceClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 10000,
  showCrashDialog: true,
  maxWarmEntries: computeDefaultWarmWorkspaceHosts(os.totalmem()),
};

async function readForgeSettingsForProject(projectPath: string): Promise<{
  forgeProviderOverride: string | null;
  forgeDefaultProviderId: string | null;
  forgeRemote: string | null;
}> {
  let forgeProviderOverride: string | null = null;
  let forgeRemote: string | null = null;
  try {
    const projectId = projectStore.resolveProjectIdForPath(projectPath);
    const settings = await projectStore.getProjectSettings(projectId).catch(() => null);
    forgeProviderOverride = settings?.forgeProviderOverride ?? null;
    forgeRemote = settings?.forgeRemote ?? settings?.githubRemote ?? null;
  } catch {
    forgeProviderOverride = null;
    forgeRemote = null;
  }
  const forgeDefaultProviderId = normalizeProviderId(store.get("forgeDefaultProviderId"));
  return { forgeProviderOverride, forgeDefaultProviderId, forgeRemote };
}

function readPersistedLogOverrides(): Record<string, string> {
  try {
    const raw = store.get("logLevelOverrides") ?? {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === "string" && key && isValidLogOverrideLevel(value)) {
        clean[key] = value as string;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export type RouteHostEventFn = (
  entry: ProcessEntry,
  event: import("../../../shared/types/workspace-host.js").WorkspaceHostEvent
) => void;

export type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

export interface WorkspaceHostPoolDeps {
  config: WorkspaceClientConfig;
  emit: EmitFn;
  onProjectSwitch?: (windowId: number) => void;
  /**
   * Whether any window still holds a live (active or cached) view of the
   * project. A dormant host backed by one outlives the idle grace (#12519).
   */
  hasLiveProjectView?: (projectId: string) => boolean;
}

export class WorkspaceHostPool {
  private config: Required<WorkspaceClientConfig>;

  readonly entries = new Map<string, ProcessEntry>();
  readonly windowToProject = new Map<number, string>();
  readonly worktreePathToProject = new Map<string, string>();

  /**
   * Monotonic per-window `loadProject` request sequence — makes the mapping
   * "last requested wins" instead of "last completion wins". The switch IPC
   * handler starts the git load concurrently with the view swap, so two rapid
   * switches (A→B→C) can have loads in flight at once; without this, a slow
   * cold host for the superseded B could complete after C and flip
   * `windowToProject` back to B while the window displays C, routing B's
   * worktree events into C's view.
   */
  private windowLoadSeq = new Map<number, number>();

  private logLevelOverridesCache: Record<string, string> = readPersistedLogOverrides();

  /** Last GitHub fetch-throttle multiplier relayed from main — seeded into
   * hosts created after the rate-limit state last changed. */
  private fetchThrottleMultiplierCache = 1;

  /** Last forge provider-matcher table relayed from main — seeded into hosts
   * created after the registry last changed. `null` until the first relay. */
  private forgeProviderMatchersCache: ForgeProviderMatcher[] | null = null;

  /** Merged monitor config (profile polling, fetch cadence, watcher cap) —
   * seeded into hosts created after the last push so a project opened while
   * a non-balanced profile is active doesn't run the in-host defaults. */
  private monitorConfigCache:
    import("../../../shared/types/workspace-host.js").MonitorConfig | null = null;

  private emit: EmitFn;
  private onProjectSwitch?: (windowId: number) => void;
  private hasLiveProjectView: (projectId: string) => boolean;
  private routeHostEventFn: RouteHostEventFn | null = null;

  constructor(deps: WorkspaceHostPoolDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    // Normalize the warm-pool cap: the spread above lets a caller passing
    // `{ maxWarmEntries: undefined }` (or a NaN/negative/Infinity) override the
    // default, and a negative cap would spin `enforceDormantCap()` forever
    // (dormantCount can never drop below 0). Coerce to a finite non-negative
    // integer, falling back to the RAM-scaled default. 0 is valid (evict all
    // dormant hosts immediately).
    const cap = this.config.maxWarmEntries;
    this.config.maxWarmEntries =
      Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_CONFIG.maxWarmEntries;
    this.emit = deps.emit;
    this.onProjectSwitch = deps.onProjectSwitch;
    this.hasLiveProjectView = deps.hasLiveProjectView ?? (() => false);
  }

  setRouteHostEvent(fn: RouteHostEventFn): void {
    this.routeHostEventFn = fn;
  }

  // ── Entry resolution ──

  normalizeProjectPath(p: string): string {
    return path.resolve(p);
  }

  resolveEntryForWindow(windowId: number): ProcessEntry | undefined {
    const projectPath = this.windowToProject.get(windowId);
    if (!projectPath) return undefined;
    return this.entries.get(projectPath);
  }

  resolveHostForWindow(windowId: number): WorkspaceHostProcess | undefined {
    return this.resolveEntryForWindow(windowId)?.host;
  }

  getHostForProject(projectPath: string): WorkspaceHostProcess | undefined {
    const normalized = this.normalizeProjectPath(projectPath);
    return this.entries.get(normalized)?.host;
  }

  getHostForWindow(windowId: number): WorkspaceHostProcess | undefined {
    return this.resolveHostForWindow(windowId);
  }

  resolveHostForPath(targetPath: string): WorkspaceHostProcess | undefined {
    const normalized = this.normalizeProjectPath(targetPath);

    const exactEntry = this.entries.get(normalized);
    if (exactEntry) return exactEntry.host;

    for (const entry of this.entries.values()) {
      if (normalized.startsWith(entry.projectPath + path.sep) || normalized === entry.projectPath) {
        return entry.host;
      }
    }

    const projectPath = this.worktreePathToProject.get(normalized);
    if (projectPath) {
      const entry = this.entries.get(projectPath);
      if (entry) return entry.host;
    }

    for (const [wtPath, projPath] of this.worktreePathToProject) {
      if (normalized.startsWith(wtPath + path.sep)) {
        const entry = this.entries.get(projPath);
        if (entry) return entry.host;
      }
    }

    if (this.entries.size === 1) {
      const [entry] = this.entries.values();
      if (entry.host.isReady()) return entry.host;
    }

    return undefined;
  }

  // ── Process lifecycle ──

  private makeInitPromise(
    host: WorkspaceHostProcess,
    normalizedPath: string,
    projectId: string
  ): Promise<void> {
    return (async () => {
      const [, forgeSettings] = await Promise.all([
        host.waitForReady(),
        readForgeSettingsForProject(normalizedPath),
      ]);
      const requestId = host.generateRequestId();
      await host.sendWithResponse({
        type: "load-project",
        requestId,
        rootPath: normalizedPath,
        projectId,
        globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
        wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
        forgeProviderOverride: forgeSettings.forgeProviderOverride,
        forgeDefaultProviderId: forgeSettings.forgeDefaultProviderId,
        forgeRemote: forgeSettings.forgeRemote,
      });
    })();
  }

  /** Resolves with whether an existing host was reused ("warm") or one was spawned ("cold"). */
  async loadProject(rootPath: string, windowId: number): Promise<HostLoadKind> {
    const normalizedPath = this.normalizeProjectPath(rootPath);
    const seq = (this.windowLoadSeq.get(windowId) ?? 0) + 1;
    this.windowLoadSeq.set(windowId, seq);
    const isStale = () => this.windowLoadSeq.get(windowId) !== seq;

    const oldProjectPath = this.windowToProject.get(windowId);
    const isSwitching = oldProjectPath !== undefined && oldProjectPath !== normalizedPath;

    const existingEntry = this.entries.get(normalizedPath);
    if (existingEntry) {
      const isReadyFailed = await existingEntry.currentReadyPromise.then(
        () => false,
        () => true
      );
      // Superseded while waiting on the entry's readiness — the newer request
      // owns the mapping and all attachment bookkeeping (including disposing a
      // ready-failed entry, which it detects itself on the same code path).
      if (isStale()) return "warm";
      // No reference is held across that wait, so the entry was still dormant
      // and a reclaim, the warm cap or the grace timer may have disposed it.
      // Re-inserting it would attach the window to a dead host; start over.
      if (this.entries.get(normalizedPath) !== existingEntry) {
        return this.loadProject(rootPath, windowId);
      }
      if (isReadyFailed) {
        existingEntry.host.dispose("ready-failed");
        this.entries.delete(normalizedPath);
      } else {
        this.entries.delete(normalizedPath);
        this.entries.set(normalizedPath, existingEntry);

        if (!existingEntry.windowIds.has(windowId)) {
          existingEntry.refCount++;
          existingEntry.windowIds.add(windowId);
        }
        if (existingEntry.cleanupTimeout) {
          clearTimeout(existingEntry.cleanupTimeout);
          existingEntry.cleanupTimeout = null;
        }
        // Resume a warm host that may have been demoted to background by an
        // earlier switch-away (#10743). Symmetric with the `background` send in
        // `releaseOldProject`: the pool pauses on release, so it resumes on
        // re-attach — covering every caller (menu open, IPC switch/reopen)
        // without each having to remember to foreground first. `resume()` is
        // idempotent, so this is harmless when the host was never paused.
        existingEntry.host.send({ type: "foreground" });
        this.windowToProject.set(windowId, normalizedPath);

        if (isSwitching) {
          this.onProjectSwitch?.(windowId);
          this.releaseOldProject(windowId, oldProjectPath);
        }
        return "warm";
      }
    }

    const host = new WorkspaceHostProcess(normalizedPath, this.config);
    host.setLogLevelOverrides(this.logLevelOverridesCache);
    host.relayFetchThrottle(this.fetchThrottleMultiplierCache);
    if (this.forgeProviderMatchersCache !== null) {
      host.relayForgeProviderMatchers(this.forgeProviderMatchersCache);
    }
    if (this.monitorConfigCache !== null) {
      host.updateMonitorConfig(this.monitorConfigCache);
    }

    const projectId = projectStore.resolveProjectIdForPath(normalizedPath);
    const initPromise = this.makeInitPromise(host, normalizedPath, projectId);

    const newEntry: ProcessEntry = {
      host,
      refCount: 1,
      initPromise,
      currentReadyPromise: initPromise,
      cleanupTimeout: null,
      windowIds: new Set([windowId]),
      projectPath: normalizedPath,
      projectId,
      directPortViews: new Map(),
    };

    this.entries.set(normalizedPath, newEntry);
    this.wireHostEvents(newEntry);

    try {
      await initPromise;
    } catch (error) {
      if (this.entries.get(normalizedPath) === newEntry) {
        this.entries.delete(normalizedPath);
        newEntry.windowIds.delete(windowId);
        newEntry.refCount--;
        newEntry.host.dispose("init-failed");
      }
      throw error;
    }

    if (isStale()) {
      // Superseded while the host was spawning. Keep the now-warm host for a
      // future switch-back, but undo this window's attachment and leave the
      // mapping to the newer request. Skip the undo when the winning request
      // landed on this same project — it re-owns the existing attachment
      // rather than adding its own, so releasing here would strand it.
      if (
        this.entries.get(normalizedPath) === newEntry &&
        this.windowToProject.get(windowId) !== normalizedPath
      ) {
        newEntry.windowIds.delete(windowId);
        newEntry.refCount--;
        if (newEntry.refCount <= 0) {
          newEntry.host.send({ type: "background" });
          this.scheduleDormantCleanup(normalizedPath, newEntry);
        }
      }
      return "cold";
    }

    this.windowToProject.set(windowId, normalizedPath);

    if (isSwitching) {
      this.onProjectSwitch?.(windowId);
      this.releaseOldProject(windowId, oldProjectPath);
    }
    return "cold";
  }

  prewarmProject(rootPath: string): void {
    const normalizedPath = this.normalizeProjectPath(rootPath);

    if (this.entries.has(normalizedPath)) return;

    const host = new WorkspaceHostProcess(normalizedPath, this.config);
    host.setLogLevelOverrides(this.logLevelOverridesCache);
    host.relayFetchThrottle(this.fetchThrottleMultiplierCache);
    if (this.forgeProviderMatchersCache !== null) {
      host.relayForgeProviderMatchers(this.forgeProviderMatchersCache);
    }
    if (this.monitorConfigCache !== null) {
      host.updateMonitorConfig(this.monitorConfigCache);
    }

    const projectId = projectStore.resolveProjectIdForPath(normalizedPath);
    const initPromise = this.makeInitPromise(host, normalizedPath, projectId);

    const entry: ProcessEntry = {
      host,
      refCount: 0,
      initPromise,
      currentReadyPromise: initPromise,
      cleanupTimeout: null,
      windowIds: new Set(),
      projectPath: normalizedPath,
      projectId,
      directPortViews: new Map(),
    };

    this.entries.set(normalizedPath, entry);
    this.wireHostEvents(entry);
    this.scheduleDormantCleanup(normalizedPath, entry);

    initPromise.catch(() => {
      if (this.entries.get(normalizedPath) === entry) {
        this.entries.delete(normalizedPath);
        entry.host.dispose("init-failed");
      }
    });
  }

  private releaseOldProject(windowId: number, oldProjectPath: string): void {
    const oldEntry = this.entries.get(oldProjectPath);
    if (!oldEntry) return;

    oldEntry.windowIds.delete(windowId);
    oldEntry.refCount--;

    if (oldEntry.refCount <= 0) {
      // No window holds this project anymore — demote its host to background so
      // it stops full-rate git status / fetch / PR polling while it sits dormant
      // (#10743). Switching back resumes it via `resumeProject` (foreground).
      // Gated on refCount: a project still visible in another window must keep
      // polling. Sent before scheduling cleanup so the grace-period host is
      // already quiesced. Resume on switch-back is driven by the IPC handler's
      // `resumeWorkspace` flag, not here.
      oldEntry.host.send({ type: "background" });
      this.scheduleDormantCleanup(oldProjectPath, oldEntry);
    }
  }

  releaseWindow(windowId: number): void {
    // Invalidate any in-flight loadProject for this window so a late
    // completion can't resurrect the mapping after the window released it.
    this.windowLoadSeq.delete(windowId);

    const projectPath = this.windowToProject.get(windowId);
    if (!projectPath) return;

    this.windowToProject.delete(windowId);
    const entry = this.entries.get(projectPath);
    if (!entry) return;

    entry.windowIds.delete(windowId);
    entry.refCount--;

    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
      }
    }

    if (entry.refCount <= 0) {
      this.backgroundIfDormant(projectPath, entry);
      this.scheduleDormantCleanup(projectPath, entry);
    }
  }

  unregisterWindow(windowId: number): void {
    this.releaseWindow(windowId);
  }

  /**
   * Release `windowId`'s reference ONLY if it is still mapped to
   * `projectPath` — returns whether it was.
   *
   * `releaseWindow` drops whatever project the window is currently mapped to,
   * which is the right behaviour for a window that is closing. A caller
   * reclaiming ONE project must not use it: during a cold switch this map can
   * still name the outgoing project while the view already reports the
   * incoming one as active, so an unguarded release would sever a different
   * project's still-needed worktree feed.
   */
  releaseWindowForProject(windowId: number, projectPath: string): boolean {
    const normalized = this.normalizeProjectPath(projectPath);
    if (this.windowToProject.get(windowId) !== normalized) return false;
    this.releaseWindow(windowId);
    return true;
  }

  /**
   * Push updated forge settings (provider override / default / selected
   * remote) to a live workspace host so its `PullRequestService` re-resolves
   * the provider without waiting for a project reload (#8456). No-ops when
   * the project has no live or prewarmed host — the next `load-project`
   * already carries fresh settings. Waits for any in-flight load to settle
   * first so a slower `load-project` cannot clobber the newer values.
   */
  async updateForgeSettings(projectPath: string): Promise<void> {
    const normalizedPath = this.normalizeProjectPath(projectPath);
    const entry = this.entries.get(normalizedPath);
    if (!entry) return;

    try {
      await entry.currentReadyPromise;
    } catch {
      // Host failed to load; the eventual restart re-reads settings via
      // load-project, so there is nothing to push here.
      return;
    }

    const forgeSettings = await readForgeSettingsForProject(normalizedPath);
    entry.host.send({
      type: "update-forge-settings",
      forgeProviderOverride: forgeSettings.forgeProviderOverride,
      forgeDefaultProviderId: forgeSettings.forgeDefaultProviderId,
      forgeRemote: forgeSettings.forgeRemote,
    });
  }

  /**
   * Push forge settings to every host. For the global default provider, which
   * no per-project settings save carries and which a host otherwise reads only
   * at `load-project` — stale for as long as a retained host lives (#12519).
   */
  async updateForgeSettingsForAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.updateForgeSettings(entry.projectPath))
    );
  }

  // ── Eviction / dormant management ──

  /**
   * Force-evict the workspace host for `projectPath` on demand (user-initiated
   * "free memory"). Disposes the utility process and drops the entry. Returns
   * false — without evicting — when no host is loaded, or when the project is
   * still held by a window (`refCount > 0`): another open window may be using
   * the same host, and severing it mid-use would break that window's worktree
   * monitoring. Unlike `scheduleDormantCleanup`, this skips the grace period.
   */
  evictProject(projectPath: string): boolean {
    const normalized = this.normalizeProjectPath(projectPath);
    const entry = this.entries.get(normalized);
    if (!entry || entry.refCount > 0) return false;
    this.evictEntry(normalized, entry, "evicted");
    return true;
  }

  /**
   * Force-evict the workspace host for a project being RELOCATED, even while a
   * window still holds it (`refCount > 0`). The normal {@link evictProject}
   * refuses a held host; relocation is the one caller that must drop a live one —
   * its folder is moving out from under it, so the process (and its watchers,
   * rooted at the vanishing old path) has to be torn down and respawned at the
   * new path by a subsequent `loadProject`. Reverse routing rooted at the old
   * path is cleared here so a worktree lookup for a since-moved path can't match
   * a stale entry; the reload repopulates it for the new root. Fire-and-forget
   * dispose: a same-volume `fs.rename` doesn't require the host to have exited
   * first (POSIX moves the inode; open handles follow it).
   */
  evictProjectForRelocation(projectPath: string): void {
    const normalized = this.normalizeProjectPath(projectPath);
    const entry = this.entries.get(normalized);
    if (entry) this.evictEntry(normalized, entry, "relocation");
    for (const [worktreePath, rootPath] of this.worktreePathToProject) {
      if (rootPath === normalized) this.worktreePathToProject.delete(worktreePath);
    }
  }

  private evictEntry(
    projectPath: string,
    entry: ProcessEntry,
    reason: WorkspaceHostDisposeReason
  ): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
    entry.host.dispose(reason);
    this.entries.delete(projectPath);
  }

  private isViewBacked(entry: ProcessEntry): boolean {
    try {
      return this.hasLiveProjectView(entry.projectId);
    } catch {
      // Unknown residency must not pin a host: fall back to the plain grace.
      return false;
    }
  }

  private enforceDormantCap(): void {
    const dormant: Array<[string, ProcessEntry]> = [];
    for (const [path, entry] of this.entries) {
      if (entry.refCount <= 0 && entry.cleanupTimeout !== null) {
        dormant.push([path, entry]);
      }
    }

    const excess = dormant.length - this.config.maxWarmEntries;
    if (excess <= 0) return;

    // LRU within each group (Map order is re-attach order), but a host whose
    // project no longer has a view goes before one that does: a switch back
    // to a cached view is the reveal a warm host exists to serve.
    const viewBacked = dormant.map(([, entry]) => this.isViewBacked(entry));
    const ordered = [
      ...dormant.filter((_, i) => !viewBacked[i]),
      ...dormant.filter((_, i) => viewBacked[i]),
    ];
    for (const [path, entry] of ordered.slice(0, excess)) {
      this.evictEntry(path, entry, "warm-cap");
    }
  }

  /**
   * A released host is paused (`background`) and then kept for at least
   * CLEANUP_GRACE_MS. While any window still caches a view of the project it
   * is kept past that too, re-checking once per grace period (#12519): the
   * view is the likeliest switch-back, and reaping its host bought a fork, a
   * native reload and a full worktree rescan for a paused process's memory.
   * Retention stays bounded: the warm cap still counts these hosts, view
   * eviction (LRU, or pressure) hands a host back to the plain grace, and the
   * pressure ladder's forced tier reclaims them outright (`reclaimDormantHosts`).
   */
  private scheduleDormantCleanup(projectPath: string, entry: ProcessEntry): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
    }
    this.armDormantTimer(projectPath, entry);
    this.enforceDormantCap();
  }

  private armDormantTimer(projectPath: string, entry: ProcessEntry): void {
    entry.cleanupTimeout = setTimeout(() => {
      entry.cleanupTimeout = null;
      if (this.entries.get(projectPath) !== entry || entry.refCount > 0) return;
      if (this.isViewBacked(entry)) {
        // Re-asserted each period rather than trusted: a prewarm nobody
        // attached to was never paused, and neither is a process that
        // restarted after its last pause.
        this.backgroundIfDormant(projectPath, entry);
        this.armDormantTimer(projectPath, entry);
        return;
      }
      entry.host.dispose("idle-grace");
      this.entries.delete(projectPath);
    }, CLEANUP_GRACE_MS);
  }

  /**
   * Dispose every host no window holds, view-backed or not — the pool's lever
   * for the memory-pressure ladder's forced tier (#12519). Deliberately not
   * reached from any reading of its own: that ladder is the one authority for
   * "pressure is real" (#11477). A dormant host is paused and fully
   * re-derivable, so dropping it costs a cold start and nothing else.
   */
  reclaimDormantHosts(): number {
    let reclaimed = 0;
    for (const [path, entry] of [...this.entries]) {
      if (entry.refCount > 0) continue;
      this.evictEntry(path, entry, "memory-pressure");
      reclaimed++;
    }
    return reclaimed;
  }

  /**
   * Pause a host that is dormant. A switch-away does this inline; the other
   * ways in (window close, a prewarm nobody attached to, a crash restart) go
   * through here, since a view-backed host can sit dormant for hours and must
   * not poll meanwhile. `pause()` is idempotent host-side.
   */
  private backgroundIfDormant(projectPath: string, entry: ProcessEntry): void {
    if (this.entries.get(projectPath) !== entry || entry.refCount > 0) return;
    entry.host.send({ type: "background" });
  }

  // ── Direct port management ──

  attachDirectPort(windowId: number, webContents: WebContents): void {
    const entry = this.resolveEntryForWindow(windowId);
    if (!entry) {
      console.warn("[WorkspaceClient] No entry for window, cannot attach direct port");
      return;
    }
    if (webContents.isDestroyed()) return;
    entry.directPortViews.set(webContents.id, webContents);
  }

  removeDirectPort(webContentsId: number): void {
    for (const entry of this.entries.values()) {
      entry.directPortViews.delete(webContentsId);
    }
  }

  // ── Host restart ──

  manualRestartForWindow(windowId: number): void {
    const entry = this.resolveEntryForWindow(windowId);
    if (!entry) {
      console.warn(
        `[WorkspaceClient] No entry for window ${windowId}; cannot manual-restart workspace host`
      );
      return;
    }

    entry.host.manualRestart();
  }

  private async reloadProjectAfterRestart(entry: ProcessEntry): Promise<void> {
    const host = entry.host;
    const [, forgeSettings] = await Promise.all([
      host.waitForReady(),
      readForgeSettingsForProject(entry.projectPath),
    ]);

    const requestId = host.generateRequestId();
    await host.sendWithResponse({
      type: "load-project",
      requestId,
      rootPath: entry.projectPath,
      projectId: entry.projectId,
      globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
      wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
      forgeProviderOverride: forgeSettings.forgeProviderOverride,
      forgeDefaultProviderId: forgeSettings.forgeDefaultProviderId,
      forgeRemote: forgeSettings.forgeRemote,
    });

    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
      }
    }

    // A restarted process comes back foregrounded.
    this.backgroundIfDormant(entry.projectPath, entry);

    this.emit("host-restarted", {
      projectPath: entry.projectPath,
      host,
    });
  }

  // ── Event wiring ──

  private wireHostEvents(entry: ProcessEntry): void {
    const host = entry.host;

    host.on("host-event", (event) => {
      this.routeHostEventFn?.(entry, event);
    });

    host.on("host-recovering", () => {
      sendToEntryWindows(entry, CHANNELS.WORKTREE_HOST_DISCONNECTED, {
        fatal: false,
      });
    });

    host.on("host-crash", (code: number) => {
      sendToEntryWindows(entry, CHANNELS.WORKTREE_HOST_DISCONNECTED, {
        fatal: true,
      });
      this.emit("host-crash", code);
    });

    host.on("restarted", () => {
      const restartPromise = this.reloadProjectAfterRestart(entry);
      restartPromise.catch((err) => {
        console.error(`[WorkspaceClient] Failed to reload project after host restart:`, err);
      });
      entry.currentReadyPromise = restartPromise;
    });
  }

  // ── Readiness ──

  async waitForReady(): Promise<void> {
    const promises = [...this.entries.values()].map((e) => e.currentReadyPromise);
    if (promises.length === 0) return;
    await Promise.all(promises);
  }

  isReady(): boolean {
    if (this.entries.size === 0) return true;
    for (const entry of this.entries.values()) {
      if (entry.host.isReady()) return true;
    }
    return false;
  }

  // ── Log overrides ──

  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.logLevelOverridesCache = { ...overrides };
    for (const entry of this.entries.values()) {
      entry.host.setLogLevelOverrides(this.logLevelOverridesCache);
    }
  }

  // ── Fetch throttle ──

  relayFetchThrottle(multiplier: number): void {
    this.fetchThrottleMultiplierCache = multiplier;
    for (const entry of this.entries.values()) {
      entry.host.relayFetchThrottle(this.fetchThrottleMultiplierCache);
    }
  }

  // ── Monitor config ──

  updateMonitorConfig(
    config: import("../../../shared/types/workspace-host.js").MonitorConfig
  ): void {
    this.monitorConfigCache = { ...this.monitorConfigCache, ...config };
    for (const entry of this.entries.values()) {
      entry.host.updateMonitorConfig(config);
    }
  }

  // ── Forge provider matchers ──

  relayForgeProviderMatchers(matchers: ForgeProviderMatcher[]): void {
    this.forgeProviderMatchersCache = matchers;
    for (const entry of this.entries.values()) {
      entry.host.relayForgeProviderMatchers(this.forgeProviderMatchersCache);
    }
  }

  // ── Fan-out helpers (used by facade) ──

  forEachHost(fn: (entry: ProcessEntry) => void): void {
    for (const entry of this.entries.values()) {
      fn(entry);
    }
  }

  /**
   * Hosts some window currently holds. App-wide focus and wake passes must not
   * reach the rest: a dormant host is paused, and waking it on every focus
   * would undo the pause for as long as its cached view keeps it resident
   * (#12519). It catches up when a window re-attaches and foregrounds it.
   */
  attachedEntries(): ProcessEntry[] {
    return [...this.entries.values()].filter((entry) => entry.refCount > 0);
  }

  // ── Disposal ──

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.cleanupTimeout) {
        clearTimeout(entry.cleanupTimeout);
      }
      entry.host.dispose("pool-dispose");
    }
    this.entries.clear();
    this.windowToProject.clear();
    this.worktreePathToProject.clear();
    this.windowLoadSeq.clear();
  }
}
