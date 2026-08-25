import type { BrowserWindow, MessagePortMain } from "electron";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { PortalManager } from "../services/PortalManager.js";
import type { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { SurfaceViewManager } from "./SurfaceViewManager.js";
import type { SurfacePortBroker } from "./SurfacePortBroker.js";
import { DisposableStore } from "../utils/lifecycle.js";
import { disposeProjectHistory, resetProjectHistory } from "../services/ProjectHistoryService.js";

/**
 * Narrow structural type for the Electron `app` module — exposes only the
 * `on("browser-window-focus", ...)` subscription used by focus tracking.
 * Keeps WindowRegistry testable without mocking the whole electron module.
 */
export interface FocusTrackingApp {
  on(
    event: "browser-window-focus",
    listener: (event: unknown, win: BrowserWindow) => void
  ): unknown;
}

export interface WindowServices {
  portalManager?: PortalManager;
  eventBuffer?: EventBuffer;
  projectSwitchService?: ProjectSwitchService;
  projectViewManager?: ProjectViewManager;
  activeRendererPort?: MessagePortMain;
  activePtyHostPort?: MessagePortMain;
  // Paint-fabric surface views (Phase 1V substrate). Created lazily by the
  // paintSurface IPC namespace on first use; preloadDirname is stamped at
  // window creation so the lazily-built manager loads the same preload.cjs
  // the project views use.
  preloadDirname?: string;
  surfaceViewManager?: SurfaceViewManager;
  surfacePortBroker?: SurfacePortBroker;
  /**
   * Dedicated worker-ingest port pairs keyed by terminal id (issue #10960).
   * The pty-host end is neutered once transferred; both refs are kept so an
   * untransferred pair (host down) can still be closed deterministically.
   */
  terminalWorkerPorts?: Map<
    string,
    { rendererPort: MessagePortMain; ptyHostPort: MessagePortMain }
  >;
}

export interface WindowContext {
  windowId: number;
  webContentsId: number;
  browserWindow: BrowserWindow;
  projectPath: string | null;
  abortController: AbortController;
  services: WindowServices;
  cleanup: DisposableStore;
  /** @internal Set to true after unregister runs to prevent double-cleanup from deferred event listeners. */
  _unregistered?: boolean;
}

export interface WindowRegistryOptions {
  projectPath?: string | null;
}

export class WindowRegistry {
  private windows = new Map<number, WindowContext>();
  private webContentsIndex = new Map<number, number>();
  private appViewWebContentsIds = new Map<number, Set<number>>(); // windowId → all view webContentsIds
  private primaryWindowId: number | null = null;
  // Ordered list of recent focus targets (oldest → newest). Used to find the
  // next primary when the current primary is unregistered, so the surviving
  // window with the most recent focus wins instead of the first-registered.
  private focusHistory: number[] = [];
  private focusTrackingWired = false;

  register(win: BrowserWindow, opts?: WindowRegistryOptions): WindowContext {
    const windowId = win.id;
    const webContentsId = win.webContents.id;

    if (this.windows.has(windowId)) {
      return this.windows.get(windowId)!;
    }

    const ctx: WindowContext = {
      windowId,
      webContentsId,
      browserWindow: win,
      projectPath: opts?.projectPath ?? null,
      abortController: new AbortController(),
      services: {},
      cleanup: new DisposableStore(),
    };

    this.windows.set(windowId, ctx);
    this.webContentsIndex.set(webContentsId, windowId);

    // Lift the tombstone `unregister` left on this id. Until it is lifted the
    // id's history refuses to record, which is what keeps a switch completing
    // after its window closed from resurrecting one.
    resetProjectHistory(windowId);

    // Cold-start fallback: claim primary on first registration so getPrimary()
    // returns a sane value before any focus event fires.
    if (this.primaryWindowId === null) {
      this.primaryWindowId = windowId;
    }

    // If the window is already focused at registration time (sync show/focus
    // before the async browser-window-focus event arrives), promote it now.
    if (typeof win.isFocused === "function" && win.isFocused()) {
      this.primaryWindowId = windowId;
      this.recordFocus(windowId);
    }

    const doUnregister = () => {
      if (ctx._unregistered) return;
      this.unregister(windowId);
    };

    win.once("closed", doUnregister);
    win.webContents.once("destroyed", doUnregister);

    return ctx;
  }

  /**
   * Subscribe to `browser-window-focus` so `primaryWindowId` tracks the most
   * recently focused registered window. Idempotent — safe to call multiple
   * times.
   *
   * The `windows.has(win.id)` guard filters out detached DevTools windows and
   * any other Electron-internal BrowserWindow that isn't in our registry.
   */
  wireFocusTracking(app: FocusTrackingApp): void {
    if (this.focusTrackingWired) return;
    app.on("browser-window-focus", (_event, win) => {
      const ctx = this.windows.get(win.id);
      if (!ctx) return;
      // Defend against a focus event delivered for a window whose underlying
      // BrowserWindow has been destroyed but whose registry entry hasn't been
      // cleaned up yet.
      if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
      this.primaryWindowId = win.id;
      this.recordFocus(win.id);
    });
    this.focusTrackingWired = true;
  }

  private recordFocus(windowId: number): void {
    const existing = this.focusHistory.indexOf(windowId);
    if (existing !== -1) {
      this.focusHistory.splice(existing, 1);
    }
    this.focusHistory.push(windowId);
  }

  /**
   * Register an additional webContentsId → windowId mapping.
   * Used for WebContentsView's webContents so getByWebContentsId() works
   * when IPC event.sender is the app view's webContents.
   */
  registerAppViewWebContents(windowId: number, appViewWebContentsId: number): void {
    let ids = this.appViewWebContentsIds.get(windowId);
    if (!ids) {
      ids = new Set();
      this.appViewWebContentsIds.set(windowId, ids);
    }
    ids.add(appViewWebContentsId);
    this.webContentsIndex.set(appViewWebContentsId, windowId);
  }

  unregisterAppViewWebContents(windowId: number, appViewWebContentsId: number): void {
    const ids = this.appViewWebContentsIds.get(windowId);
    if (ids) {
      ids.delete(appViewWebContentsId);
      if (ids.size === 0) {
        this.appViewWebContentsIds.delete(windowId);
      }
    }
    this.webContentsIndex.delete(appViewWebContentsId);
  }

  unregister(windowId: number): void {
    const ctx = this.windows.get(windowId);
    if (!ctx || ctx._unregistered) return;
    ctx._unregistered = true;
    ctx.abortController.abort();

    ctx.cleanup.dispose();

    // Revoke help-session tokens bound to this closing window so a multi-
    // window close graceful-kills the PTY and writes a resume id to
    // PendingHelpHibernationStore — otherwise the orphaned PTY keeps
    // dispatching MCP calls and the user can't resume (#10053). Mirrors the
    // eviction-hook wire-up in main.ts; dynamic import breaks the runtime
    // cycle since HelpSessionService already imports `type { WindowRegistry }`.
    import("../services/HelpSessionService.js")
      .then(({ helpSessionService }) => helpSessionService.revokeByWindowId(windowId))
      .catch((err) => {
        console.warn("[WindowRegistry] revokeByWindowId failed during unregister:", err);
      });

    // And stop the native assistant engines this window owned.
    //
    // Started HERE, while the window is being unregistered, rather than left to a later
    // sweep: window ids are REUSED, so by the time this one comes round again it names a
    // different window, and a session still filed under it is one nothing will ever
    // match. The per-view cleanup in main.ts does not cover this — a window can close
    // without its views being individually evicted, and a quiet engine is never reaped
    // by the lazy dead-view path because it has nothing to deliver.
    import("../services/assistant-host/AssistantHostService.js")
      .then(({ assistantHostService }) => assistantHostService.stopByWindow(windowId))
      .catch((err) => {
        console.warn("[WindowRegistry] assistant host stop failed during unregister:", err);
      });

    this.webContentsIndex.delete(ctx.webContentsId);
    const appViewWcIds = this.appViewWebContentsIds.get(windowId);
    if (appViewWcIds) {
      for (const wcId of appViewWcIds) {
        this.webContentsIndex.delete(wcId);
      }
      this.appViewWebContentsIds.delete(windowId);
    }
    this.windows.delete(windowId);

    // Window ids are not guaranteed unique forever, so a stack left behind here
    // could resurface in an unrelated window that happens to be given the same
    // id — its Back would step into projects it never visited.
    disposeProjectHistory(windowId);

    // Drop the closing window from the focus history before falling back.
    const historyIdx = this.focusHistory.indexOf(windowId);
    if (historyIdx !== -1) {
      this.focusHistory.splice(historyIdx, 1);
    }

    if (this.primaryWindowId === windowId) {
      this.primaryWindowId = null;
      // Prefer the most recently focused live window over Map insertion order
      // so the user lands on the window they were last looking at.
      for (let i = this.focusHistory.length - 1; i >= 0; i--) {
        const id = this.focusHistory[i];
        const c = this.windows.get(id);
        if (c && !c.browserWindow.isDestroyed()) {
          this.primaryWindowId = id;
          break;
        }
      }
      if (this.primaryWindowId === null) {
        for (const [id, c] of this.windows) {
          if (!c.browserWindow.isDestroyed()) {
            this.primaryWindowId = id;
            break;
          }
        }
      }
    }
  }

  getByWindowId(windowId: number): WindowContext | undefined {
    return this.windows.get(windowId);
  }

  getByWebContentsId(webContentsId: number): WindowContext | undefined {
    const windowId = this.webContentsIndex.get(webContentsId);
    if (windowId === undefined) return undefined;
    return this.windows.get(windowId);
  }

  getPrimary(): WindowContext | undefined {
    if (this.primaryWindowId === null) return undefined;
    return this.windows.get(this.primaryWindowId);
  }

  setPrimary(windowId: number): void {
    if (!this.windows.has(windowId)) return;
    this.primaryWindowId = windowId;
  }

  all(): WindowContext[] {
    return Array.from(this.windows.values());
  }

  /**
   * Live windows ordered most-recently-focused first.
   *
   * `focusHistory` only ever records windows that have actually been focused,
   * so a window created but never focused (a restored background window, for
   * instance) is absent from it. Those are appended after the focused ones in
   * registration order rather than dropped — the open-window manifest (#11492)
   * has to describe every window, and its cap trims from the tail, so a window
   * missing from this list would be the first one silently lost.
   */
  focusOrder(): WindowContext[] {
    const ordered: WindowContext[] = [];
    const seen = new Set<number>();

    for (let i = this.focusHistory.length - 1; i >= 0; i--) {
      const id = this.focusHistory[i];
      if (seen.has(id)) continue;
      const ctx = this.windows.get(id);
      if (!ctx) continue;
      seen.add(id);
      ordered.push(ctx);
    }

    for (const [id, ctx] of this.windows) {
      if (seen.has(id)) continue;
      ordered.push(ctx);
    }

    return ordered;
  }

  get size(): number {
    return this.windows.size;
  }

  dispose(): void {
    const ids = Array.from(this.windows.keys());
    for (const id of ids) {
      this.unregister(id);
    }
  }
}
