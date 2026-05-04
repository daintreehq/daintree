import { MessageChannelMain, type WebContents } from "electron";
import path from "path";
import { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { isValidLogOverrideLevel } from "../../utils/logger.js";
import { type ProcessEntry, sendToEntryWindows } from "./types.js";
import type { WorkspaceClientConfig } from "../../../shared/types/workspace-host.js";

const CLEANUP_GRACE_MS = 180_000;
const MAX_WARM_ENTRIES = 3;

const DEFAULT_CONFIG: Required<WorkspaceClientConfig> = {
  maxRestartAttempts: 3,
  healthCheckIntervalMs: 60000,
  showCrashDialog: true,
};

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

  private emit: EmitFn;
  private onProjectSwitch?: (windowId: number) => void;
  private routeHostEventFn: RouteHostEventFn | null = null;

  constructor(deps: WorkspaceHostPoolDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
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

    const initPromise = (async () => {
      await host.waitForReady();
      const requestId = host.generateRequestId();
      await host.sendWithResponse({
        type: "load-project",
        requestId,
        rootPath: normalizedPath,
        globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
        wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
      });
    })();

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

    const initPromise = (async () => {
      await host.waitForReady();
      const requestId = host.generateRequestId();
      await host.sendWithResponse({
        type: "load-project",
        requestId,
        rootPath: normalizedPath,
        globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
        wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
      });
    })();

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

  // ── Eviction / dormant management ──

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

    while (dormantCount > MAX_WARM_ENTRIES) {
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
    this.createDirectPortForEntry(entry, webContents);
  }

  private createDirectPortForEntry(entry: ProcessEntry, webContents: WebContents): void {
    if (webContents.isDestroyed()) return;

    const { port1, port2 } = new MessageChannelMain();

    const attached = entry.host.attachRendererPort(port1);
    if (!attached) {
      port1.close();
      port2.close();
      return;
    }

    webContents.postMessage("workspace-port", null, [port2]);
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
    await host.waitForReady();

    const requestId = host.generateRequestId();
    await host.sendWithResponse({
      type: "load-project",
      requestId,
      rootPath: entry.projectPath,
      globalEnvVars: store.get("globalEnvironmentVariables") ?? {},
      wslGitByWorktree: store.get("wslGitByWorktree") ?? {},
    });

    for (const [wcId, wc] of entry.directPortViews) {
      if (wc.isDestroyed()) {
        entry.directPortViews.delete(wcId);
        continue;
      }
      this.createDirectPortForEntry(entry, wc);
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
