import type { BrowserWindow, MessagePortMain } from "electron";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { PortalManager } from "../services/PortalManager.js";
import type { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import { DisposableStore } from "../utils/lifecycle.js";

export interface WindowServices {
  portalManager?: PortalManager;
  eventBuffer?: EventBuffer;
  projectSwitchService?: ProjectSwitchService;
  projectViewManager?: ProjectViewManager;
  activeRendererPort?: MessagePortMain;
  activePtyHostPort?: MessagePortMain;
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

    if (this.primaryWindowId === null) {
      this.primaryWindowId = windowId;
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

    this.webContentsIndex.delete(ctx.webContentsId);
    const appViewWcIds = this.appViewWebContentsIds.get(windowId);
    if (appViewWcIds) {
      for (const wcId of appViewWcIds) {
        this.webContentsIndex.delete(wcId);
      }
      this.appViewWebContentsIds.delete(windowId);
    }
    this.windows.delete(windowId);

    if (this.primaryWindowId === windowId) {
      this.primaryWindowId = null;
      for (const [id, c] of this.windows) {
        if (!c.browserWindow.isDestroyed()) {
          this.primaryWindowId = id;
          break;
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
