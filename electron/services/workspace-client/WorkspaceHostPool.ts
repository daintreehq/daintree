// eager-import-allow: reads workspace-host config via store.get synchronously during pool setup
import os from "node:os";
import { type WebContents } from "electron";
import path from "path";
import { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";
import { store } from "../../store.js";
import { computeDefaultCachedViews } from "../../utils/cachedProjectViews.js";
import { CHANNELS } from "../../ipc/channels.js";
import { isValidLogOverrideLevel } from "../../utils/logger.js";
import { type ProcessEntry, sendToEntryWindows } from "./types.js";
import type { WorkspaceClientConfig } from "../../../shared/types/workspace-host.js";
import type { ForgeProviderMatcher } from "../../../shared/utils/forgeHostnames.js";
import { projectStore } from "../ProjectStore.js";
import { generateProjectId } from "../projectStorePaths.js";
import { normalizeProviderId } from "../../../shared/utils/forgeProviderIds.js";

const CLEANUP_GRACE_MS = 180_000;

// Dormant workspace-host warm pool, RAM-scaled to match the project-view cache
// default (computeDefaultCachedViews: 2/3/4/5 across <16/16/32/64 GiB). The old
// fixed 3 meant cycling 5+ projects evicted/respawned a host on nearly every
// switch (utility-process fork + a full git rescan each time) — churn that
// shows up as workspace-host spawn storms. Switch-away hosts are paused
// (background: polling/PR/fetch timers stopped) and every dormant host still
// expires after CLEANUP_GRACE_MS, so a larger pool mainly avoids respawns on
// switch-back. The cost is bounded-resident (a few more paused utility
// processes + their health checks), not steady-state polling.
const DEFAULT_CONFIG: Required<WorkspaceClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 10000,
  showCrashDialog: true,
  maxWarmEntries: computeDefaultCachedViews(os.totalmem()),
};

async function readForgeSettingsForProject(projectPath: string): Promise<{
  forgeProviderOverride: string | null;
  forgeDefaultProviderId: string | null;
  forgeRemote: string | null;
}> {
  let forgeProviderOverride: string | null = null;
  let forgeRemote: string | null = null;
  try {
    const projectId = generateProjectId(projectPath);
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
}

export class WorkspaceHostPool {
  private config: Required<WorkspaceClientConfig>;

  readonly entries = new Map<string, ProcessEntry>();
  readonly windowToProject = new Map<number, string>();
  readonly worktreePathToProject = new Map<string, string>();

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
    | import("../../../shared/types/workspace-host.js").MonitorConfig
    | null = null;

  private emit: EmitFn;
  private onProjectSwitch?: (windowId: number) => void;
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

  private makeInitPromise(host: WorkspaceHostProcess, normalizedPath: string): Promise<void> {
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
        globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
        wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
        forgeProviderOverride: forgeSettings.forgeProviderOverride,
        forgeDefaultProviderId: forgeSettings.forgeDefaultProviderId,
        forgeRemote: forgeSettings.forgeRemote,
      });
    })();
  }

  async loadProject(rootPath: string, windowId: number): Promise<void> {
    const normalizedPath = this.normalizeProjectPath(rootPath);
    const oldProjectPath = this.windowToProject.get(windowId);
    const isSwitching = oldProjectPath !== undefined && oldProjectPath !== normalizedPath;

    const existingEntry = this.entries.get(normalizedPath);
    if (existingEntry) {
      const isReadyFailed = await existingEntry.currentReadyPromise.then(
        () => false,
        () => true
      );
      if (isReadyFailed) {
        existingEntry.host.dispose();
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
        return;
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

    const initPromise = this.makeInitPromise(host, normalizedPath);

    const newEntry: ProcessEntry = {
      host,
      refCount: 1,
      initPromise,
      currentReadyPromise: initPromise,
      cleanupTimeout: null,
      windowIds: new Set([windowId]),
      projectPath: normalizedPath,
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
        newEntry.host.dispose();
      }
      throw error;
    }

    this.windowToProject.set(windowId, normalizedPath);

    if (isSwitching) {
      this.onProjectSwitch?.(windowId);
      this.releaseOldProject(windowId, oldProjectPath);
    }
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

    const initPromise = this.makeInitPromise(host, normalizedPath);

    const entry: ProcessEntry = {
      host,
      refCount: 0,
      initPromise,
      currentReadyPromise: initPromise,
      cleanupTimeout: null,
      windowIds: new Set(),
      projectPath: normalizedPath,
      directPortViews: new Map(),
    };

    this.entries.set(normalizedPath, entry);
    this.wireHostEvents(entry);
    this.scheduleDormantCleanup(normalizedPath, entry);

    initPromise.catch(() => {
      if (this.entries.get(normalizedPath) === entry) {
        this.entries.delete(normalizedPath);
        entry.host.dispose();
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
      this.scheduleDormantCleanup(projectPath, entry);
    }
  }

  unregisterWindow(windowId: number): void {
    this.releaseWindow(windowId);
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
    this.evictEntry(normalized, entry);
    return true;
  }

  private evictEntry(projectPath: string, entry: ProcessEntry): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
    entry.host.dispose();
    this.entries.delete(projectPath);
  }

  private enforceDormantCap(): void {
    let dormantCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.refCount <= 0 && entry.cleanupTimeout !== null) {
        dormantCount++;
      }
    }

    while (dormantCount > this.config.maxWarmEntries) {
      for (const [path, entry] of this.entries) {
        if (entry.refCount <= 0 && entry.cleanupTimeout !== null) {
          this.evictEntry(path, entry);
          dormantCount--;
          break;
        }
      }
    }
  }

  private scheduleDormantCleanup(projectPath: string, entry: ProcessEntry): void {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
    }
    entry.cleanupTimeout = setTimeout(() => {
      entry.host.dispose();
      this.entries.delete(projectPath);
    }, CLEANUP_GRACE_MS);
    this.enforceDormantCap();
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

  // ── Disposal ──

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.cleanupTimeout) {
        clearTimeout(entry.cleanupTimeout);
      }
      entry.host.dispose();
    }
    this.entries.clear();
    this.windowToProject.clear();
    this.worktreePathToProject.clear();
  }
}
