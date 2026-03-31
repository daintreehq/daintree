import type { BrowserWindow, MessagePortMain } from "electron";
import type { EventBuffer } from "../services/EventBuffer.js";
import type { PortalManager } from "../services/PortalManager.js";
import type { ProjectSwitchService } from "../services/ProjectSwitchService.js";

export interface WindowServices {
  portalManager?: PortalManager;
  eventBuffer?: EventBuffer;
  projectSwitchService?: ProjectSwitchService;
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
  cleanup: Array<() => void>;
  /** @internal Set to true after unregister runs to prevent double-cleanup from deferred event listeners. */
  _unregistered?: boolean;
}

export interface WindowRegistryOptions {
  projectPath?: string | null;
}

export class WindowRegistry {
  private windows = new Map<number, WindowContext>();
  private webContentsIndex = new Map<number, number>();
  private appViewWebContentsIds = new Map<number, number>(); // windowId → appView webContentsId
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
      cleanup: [],
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
    // Clean up any previous app view webContents for this window
    const prevId = this.appViewWebContentsIds.get(windowId);
    if (prevId !== undefined && prevId !== appViewWebContentsId) {
      this.webContentsIndex.delete(prevId);
    }
    this.webContentsIndex.set(appViewWebContentsId, windowId);
    this.appViewWebContentsIds.set(windowId, appViewWebContentsId);
  }

  unregister(windowId: number): void {
    const ctx = this.windows.get(windowId);
    if (!ctx || ctx._unregistered) return;
    ctx._unregistered = true;
    ctx.abortController.abort();

    for (const fn of ctx.cleanup) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors during disposal
      }
    }

    this.webContentsIndex.delete(ctx.webContentsId);
    const appViewWcId = this.appViewWebContentsIds.get(windowId);
    if (appViewWcId !== undefined) {
      this.webContentsIndex.delete(appViewWcId);
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
