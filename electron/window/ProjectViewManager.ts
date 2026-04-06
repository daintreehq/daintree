/**
 * ProjectViewManager — Per-project WebContentsView manager.
 *
 * Each project gets its own WebContentsView with an independent V8 context.
 * Switching projects swaps the visible view (<16ms for cached views).
 */

import { BrowserWindow, WebContentsView, session } from "electron";
import path from "path";
import {
  registerWebContents,
  registerAppView,
  unregisterWebContents,
  registerProjectView,
  unregisterProjectView,
} from "./webContentsRegistry.js";
import { registerProtocolsForSession, getDistPath } from "../setup/protocols.js";
import { getDevServerUrl } from "../../shared/config/devServer.js";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { isLocalhostUrl } from "../../shared/utils/urlUtils.js";
import { canOpenExternalUrl, openExternalUrl } from "../utils/openExternal.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { notifyError } from "../ipc/errorHandlers.js";
import { injectSkeletonCss } from "./skeletonCss.js";

const GC_DELAY_MS = 100;
const LOAD_TIMEOUT_MS = 10_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

type ViewState = "loading" | "active" | "cached";

interface ViewEntry {
  view: WebContentsView;
  projectId: string;
  projectPath: string;
  lastUsed: number;
  state: ViewState;
  crashTimestamps: number[];
}

export interface ProjectViewManagerOptions {
  dirname: string;
  onRecreateWindow?: () => Promise<void>;
  windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  /** Called when a view is evicted (destroyed) with its webContents.id, for port cleanup */
  onViewEvicted?: (webContentsId: number) => void;
  /** Called on every did-finish-load for any managed view (initial load and reloads) */
  onViewReady?: (webContents: Electron.WebContents) => void;
  /** Number of project views to keep cached in memory (1–5, default: 1) */
  cachedProjectViews?: number;
}

export class ProjectViewManager {
  private views = new Map<string, ViewEntry>();
  private webContentsToProject = new Map<number, string>();
  private activeProjectId: string | null = null;
  private maxCachedViews = 1;
  private win: BrowserWindow;
  private dirname: string;
  private onRecreateWindow?: () => Promise<void>;
  private onViewEvicted?: (webContentsId: number) => void;
  private onViewReady?: (webContents: Electron.WebContents) => void;
  private windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
  private switchChain: Promise<void> = Promise.resolve();
  private resizeHandler: (() => void) | null = null;

  constructor(win: BrowserWindow, opts: ProjectViewManagerOptions) {
    this.win = win;
    this.dirname = opts.dirname;
    this.onRecreateWindow = opts.onRecreateWindow;
    this.onViewEvicted = opts.onViewEvicted;
    this.onViewReady = opts.onViewReady;
    this.windowRegistry = opts.windowRegistry;
    if (opts.cachedProjectViews != null) {
      this.maxCachedViews = opts.cachedProjectViews;
    }

    // Single resize handler that always updates the active view's bounds.
    // Before registerInitialView() is called, falls back to the first child view
    // (the initial appView attached in createWindow.ts).
    this.resizeHandler = () => {
      if (win.isDestroyed()) return;
      const view = this.getActiveView() ?? win.contentView.children[0];
      if (view) {
        const { width, height } = win.getContentBounds();
        (view as WebContentsView).setBounds({ x: 0, y: 0, width, height });
      }
    };
    win.on("resize", this.resizeHandler);
    win.on("maximize", this.resizeHandler);
    win.on("unmaximize", this.resizeHandler);
    win.on("enter-full-screen", this.resizeHandler);
    win.on("leave-full-screen", this.resizeHandler);
  }

  /**
   * Register the initial view created by setupBrowserWindow.
   */
  registerInitialView(view: WebContentsView, projectId: string, projectPath: string): void {
    const entry: ViewEntry = {
      view,
      projectId,
      projectPath,
      lastUsed: Date.now(),
      state: "active",
      crashTimestamps: [],
    };
    this.views.set(projectId, entry);
    this.webContentsToProject.set(view.webContents.id, projectId);
    registerProjectView(projectId, view.webContents);
    this.activeProjectId = projectId;
  }

  /**
   * Switch to a project's view. Creates a new view if none exists.
   * Serialized: rapid switches queue and only the last one's result matters.
   */
  async switchTo(
    projectId: string,
    projectPath: string
  ): Promise<{ view: WebContentsView; isNew: boolean }> {
    const task = this.switchChain.then(() => this.performSwitch(projectId, projectPath));
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async performSwitch(
    projectId: string,
    projectPath: string
  ): Promise<{ view: WebContentsView; isNew: boolean }> {
    if (this.win.isDestroyed()) {
      throw new Error("Cannot switch view — window is destroyed");
    }

    // Already active — no-op
    if (this.activeProjectId === projectId) {
      const existing = this.views.get(projectId);
      if (existing) {
        return { view: existing.view, isNew: false };
      }
    }

    // Snapshot previous state for rollback
    const previousProjectId = this.activeProjectId;
    const previousEntry = previousProjectId ? this.views.get(previousProjectId) : null;

    // Detach current active view (keep in cache)
    this.deactivateCurrentView();

    // Try to activate cached view
    const cached = this.views.get(projectId);
    if (cached && !cached.view.webContents.isDestroyed()) {
      this.activateView(cached);
      return { view: cached.view, isNew: false };
    }

    // Cold start — create new view
    if (cached) {
      this.cleanupEntry(projectId);
    }

    const view = this.createView(projectId);
    const entry: ViewEntry = {
      view,
      projectId,
      projectPath,
      lastUsed: Date.now(),
      state: "loading",
      crashTimestamps: [],
    };
    this.views.set(projectId, entry);
    this.webContentsToProject.set(view.webContents.id, projectId);
    registerProjectView(projectId, view.webContents);

    // Set up security handlers and attach to window
    this.setupViewHandlers(view);
    registerWebContents(view.webContents, this.win);
    registerAppView(this.win, view);

    // Register in WindowRegistry for IPC routing
    if (this.windowRegistry) {
      this.windowRegistry.registerAppViewWebContents(this.win.id, view.webContents.id);
    }

    this.win.contentView.addChildView(view);
    this.updateViewBounds(view);
    this.activeProjectId = projectId;
    entry.state = "active";

    try {
      // Load the renderer with projectId context
      await this.loadView(view, projectId);
    } catch (loadError) {
      // Rollback: clean up the failed new view
      this.cleanupEntry(projectId);

      // Restore the previous view if it's still alive
      if (previousEntry && !previousEntry.view.webContents.isDestroyed()) {
        try {
          this.activateView(previousEntry);
        } catch {
          // Window may be destroyed concurrently — don't mask the original error
          this.activeProjectId = previousProjectId;
        }
      } else {
        this.activeProjectId = previousProjectId;
      }

      notifyError(loadError, { source: "project-switch" });

      throw loadError;
    }

    // Explicit focus after load
    if (!view.webContents.isDestroyed()) {
      view.webContents.focus();
    }

    // Evict LRU views if over limit
    this.evictStaleViews();

    return { view, isNew: true };
  }

  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  getActiveView(): WebContentsView | null {
    if (!this.activeProjectId) return null;
    return this.views.get(this.activeProjectId)?.view ?? null;
  }

  getProjectIdForWebContents(webContentsId: number): string | null {
    return this.webContentsToProject.get(webContentsId) ?? null;
  }

  getAllViews(): ViewEntry[] {
    return Array.from(this.views.values());
  }

  getAllWebContentsIds(): number[] {
    return Array.from(this.webContentsToProject.keys());
  }

  setCachedViewLimit(n: number): void {
    this.maxCachedViews = n;
    this.evictStaleViews();
  }

  destroyView(projectId: string): void {
    const entry = this.views.get(projectId);
    if (!entry) return;

    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
    }

    this.cleanupEntry(projectId);
  }

  dispose(): void {
    // Remove window-level listeners
    if (this.resizeHandler) {
      this.win.removeListener("resize", this.resizeHandler);
      this.win.removeListener("maximize", this.resizeHandler);
      this.win.removeListener("unmaximize", this.resizeHandler);
      this.win.removeListener("enter-full-screen", this.resizeHandler);
      this.win.removeListener("leave-full-screen", this.resizeHandler);
      this.resizeHandler = null;
    }

    for (const projectId of Array.from(this.views.keys())) {
      this.cleanupEntry(projectId);
    }
    this.views.clear();
    this.webContentsToProject.clear();
    this.activeProjectId = null;
  }

  // ── Private ──

  private deactivateCurrentView(): void {
    if (!this.activeProjectId) return;
    const current = this.views.get(this.activeProjectId);
    if (!current || this.win.isDestroyed()) return;

    try {
      this.win.contentView.removeChildView(current.view);
    } catch {
      // View may not be attached
    }
    current.state = "cached";
    current.lastUsed = Date.now();

    // Throttle background view to reduce CPU and allow Chromium to reclaim memory
    if (!current.view.webContents.isDestroyed()) {
      current.view.webContents.setBackgroundThrottling(true);

      // Trigger V8 GC after a short delay to reclaim orphaned heap from
      // unmounted React components, stale closures, and detached DOM.
      // The delay lets React's unmount microtasks flush before collection.
      const capturedProjectId = current.projectId;
      const { view, webContents } = { view: current.view, webContents: current.view.webContents };
      setTimeout(() => {
        const liveEntry = this.views.get(capturedProjectId);
        if (
          liveEntry &&
          liveEntry.view === view &&
          liveEntry.state === "cached" &&
          !webContents.isDestroyed()
        ) {
          webContents.executeJavaScript("window.gc && window.gc()").catch(() => {});
        }
      }, GC_DELAY_MS);
    }
  }

  private activateView(entry: ViewEntry): void {
    registerAppView(this.win, entry.view);

    // Restore full priority before making visible
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.setBackgroundThrottling(false);
    }

    this.win.contentView.addChildView(entry.view);
    this.updateViewBounds(entry.view);

    // Explicit focus — addChildView does not auto-focus
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.focus();
    }

    entry.state = "active";
    entry.lastUsed = Date.now();
    this.activeProjectId = entry.projectId;
  }

  private createView(_projectId: string): WebContentsView {
    const ses = session.fromPartition("persist:canopy-app");

    // Register app:// and canopy-file:// protocol handlers on this session.
    // protocol.handle() only covers the default session — custom partitions need explicit setup.
    const distPath = getDistPath();
    if (distPath) {
      registerProtocolsForSession(ses, distPath);
    }

    return new WebContentsView({
      webPreferences: {
        preload: path.join(this.dirname, "preload.cjs"),
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        navigateOnDragDrop: false,
        v8CacheOptions: "code",
      },
    });
  }

  private loadView(view: WebContentsView, projectId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wc = view.webContents;
      let settled = false;

      const cleanup = () => {
        wc.removeListener("did-finish-load", onFinish);
        wc.removeListener("did-fail-load", onFail);
        wc.removeListener("preload-error", onPreloadError);
        wc.removeListener("render-process-gone", onProcessGone);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        fn();
      };

      const timeout = setTimeout(() => {
        settle(() => reject(new Error("View load timed out")));
      }, LOAD_TIMEOUT_MS);

      const onFinish = () => settle(() => resolve());
      const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string) =>
        settle(() => reject(new Error(`View load failed: ${errorDescription} (${errorCode})`)));
      const onPreloadError = (_event: Electron.Event, _preloadPath: string, error: Error) =>
        settle(() => reject(error ?? new Error("Preload script failed")));
      const onProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
        settle(() => reject(new Error(`Renderer process gone during load: ${details.reason}`)));

      wc.once("did-finish-load", onFinish);
      wc.once("did-fail-load", onFail);
      wc.once("preload-error", onPreloadError);
      wc.once("render-process-gone", onProcessGone);

      injectSkeletonCss(wc);

      const encodedId = encodeURIComponent(projectId);
      if (process.env.NODE_ENV === "development") {
        const devServerUrl = getDevServerUrl();
        wc.loadURL(`${devServerUrl}?projectId=${encodedId}`).catch(() => {});
      } else {
        wc.loadURL(`app://canopy/index.html?projectId=${encodedId}`).catch(() => {});
      }
    });
  }

  private updateViewBounds(view: WebContentsView): void {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  private setupViewHandlers(view: WebContentsView): void {
    const wc = view.webContents;
    const win = this.win;

    wc.setWindowOpenHandler(({ url }) => {
      if (url && canOpenExternalUrl(url)) {
        void openExternalUrl(url).catch((error) => {
          console.error("[ProjectViewManager] Failed to open external URL:", error);
        });
      } else {
        console.warn(`[ProjectViewManager] Blocked window.open for unsupported URL: ${url}`);
      }
      return { action: "deny" };
    });

    wc.on("will-navigate", (event, navigationUrl) => {
      if (!isTrustedRendererUrl(navigationUrl)) {
        console.error("[ProjectViewManager] Blocked navigation to untrusted URL:", navigationUrl);
        event.preventDefault();
      }
    });

    wc.on("will-redirect", (event, redirectUrl) => {
      if (!isTrustedRendererUrl(redirectUrl)) {
        console.error("[ProjectViewManager] Blocked redirect to untrusted URL:", redirectUrl);
        event.preventDefault();
      }
    });

    wc.on("will-attach-webview", (event, webPreferences, params) => {
      const allowedPartitions = ["persist:browser", "persist:dev-preview"];
      const isAllowedLocalhostUrl = isLocalhostUrl(params.src);
      const isValidPartition =
        allowedPartitions.includes(params.partition || "") ||
        (params.partition?.startsWith("persist:dev-preview-") ?? false);

      if (!isAllowedLocalhostUrl || !isValidPartition) {
        console.warn(
          `[ProjectViewManager] Blocked webview: url=${params.src}, partition=${params.partition}`
        );
        event.preventDefault();
        return;
      }

      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.navigateOnDragDrop = false;
      webPreferences.disableBlinkFeatures = "Auxclick";
      webPreferences.partition = params.partition;
    });

    wc.on("before-input-event", (_event, input) => {
      const isMac = process.platform === "darwin";
      const isCloseShortcut =
        input.type === "keyDown" &&
        input.key.toLowerCase() === "w" &&
        ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
        !input.alt;
      wc.setIgnoreMenuShortcuts(isCloseShortcut);
    });

    // Fire onViewReady on load/reload, but ONLY for the active view.
    // A cached view reloading (e.g. after crash recovery) must not steal
    // the PTY MessagePort from the currently visible view.
    wc.on("did-finish-load", () => {
      if (wc.isDestroyed()) return;
      const projectId = this.webContentsToProject.get(wc.id);
      if (projectId && projectId === this.activeProjectId) {
        this.onViewReady?.(wc);
      }
    });

    wc.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;

      const projectId = this.webContentsToProject.get(wc.id);
      console.error(
        `[ProjectViewManager] View renderer gone (project: ${projectId}):`,
        details.reason,
        details.exitCode
      );
      getCrashRecoveryService().recordCrash(
        new Error(`View renderer gone: ${details.reason} (exit code ${details.exitCode})`)
      );

      if (win.isDestroyed()) return;

      const entry = projectId ? this.views.get(projectId) : null;

      // If the view is still loading, loadView's one-shot handler will handle
      // the failure and trigger rollback — skip crash recovery here.
      if (entry?.state === "loading") return;
      const crashTimestamps = entry?.crashTimestamps ?? [];
      const now = Date.now();
      while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_LOOP_WINDOW_MS) {
        crashTimestamps.shift();
      }
      crashTimestamps.push(now);

      if (crashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
        console.error("[ProjectViewManager] Crash loop detected, loading recovery page");
        setImmediate(() => {
          if (wc.isDestroyed()) return;
          const params = new URLSearchParams({
            reason: details.reason,
            exitCode: String(details.exitCode),
          });
          if (process.env.NODE_ENV === "development") {
            wc.loadURL(`${getDevServerUrl()}/recovery.html?${params}`);
          } else {
            wc.loadURL(`app://canopy/recovery.html?${params}`);
          }
        });
      } else if (details.reason === "oom" && this.onRecreateWindow) {
        console.warn("[ProjectViewManager] OOM crash, destroying and recreating window");
        notifyError(new Error("A project view ran out of memory and the window was recreated."), {
          source: "renderer-crash",
        });
        setImmediate(() => {
          if (!win.isDestroyed()) win.destroy();
          this.onRecreateWindow!().catch((err) => {
            console.error("[ProjectViewManager] Failed to recreate window after OOM:", err);
          });
        });
      } else {
        console.log("[ProjectViewManager] Renderer crash, auto-reloading view");
        notifyError(new Error("A project view crashed and was automatically reloaded."), {
          source: "renderer-crash",
        });
        setImmediate(() => {
          if (!wc.isDestroyed()) wc.reload();
        });
      }
    });

    // Fullscreen events are handled by the window-level resize handler
    // and the sendToRenderer in createWindow.ts — no per-view listeners needed.
  }

  private cleanupEntry(projectId: string): void {
    const entry = this.views.get(projectId);
    if (!entry) return;

    // Remove from window if attached
    if (!this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(entry.view);
      } catch {
        // May not be attached
      }
    }

    // Unregister from WindowRegistry
    const wcId = entry.view.webContents.id;
    if (this.windowRegistry) {
      this.windowRegistry.unregisterAppViewWebContents(this.win.id, wcId);
    }

    this.webContentsToProject.delete(wcId);
    unregisterProjectView(wcId);

    // Notify listeners (e.g. WorkspaceClient) so they can clean up direct ports
    this.onViewEvicted?.(wcId);

    // Close webContents — only unregister from webContentsRegistry, NOT unregisterAppView
    // (which would remove the active view's registration)
    if (!entry.view.webContents.isDestroyed()) {
      unregisterWebContents(entry.view.webContents);
      entry.view.webContents.close();
    }

    this.views.delete(projectId);
  }

  private evictStaleViews(): void {
    if (this.views.size <= this.maxCachedViews) return;

    const evictable = Array.from(this.views.entries())
      .filter(([id]) => id !== this.activeProjectId)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

    while (this.views.size > this.maxCachedViews && evictable.length > 0) {
      const [projectId] = evictable.shift()!;
      console.log(`[ProjectViewManager] Evicting cached view for project: ${projectId}`);
      this.cleanupEntry(projectId);
    }
  }
}
