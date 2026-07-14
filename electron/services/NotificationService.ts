import { app, Notification, webContents as webContentsModule } from "electron";
import type { WindowRegistry, WindowContext } from "../window/WindowRegistry.js";
import { sendToRenderer } from "../ipc/utils.js";
import { getAppWebContents, getWindowForWebContents } from "../window/webContentsRegistry.js";

export interface NotificationState {
  waitingCount: number;
}

export interface WatchNotificationContext {
  worktreeId?: string;
  panelId: string;
  panelTitle: string;
}

/**
 * A notification owner is the renderer that reported the state — a project
 * view's `webContents.id`, taken from `event.sender` at IPC time.
 *
 * Not the window id: one window hosts an active project view plus any number of
 * cached ones, each its own renderer with its own panel store. Not the project
 * id: `null` is a legitimate distinct identity (an unbound window showing the
 * project picker), and one project can be open in two windows at once (#11101).
 */
export type NotificationOwnerId = number;

export interface NotificationNavigation {
  channel: string;
  context: WatchNotificationContext;
}

export interface WatchNotificationOptions {
  silent?: boolean;
  /** Renderer that owns the panel — decides which window a click focuses. */
  ownerWebContentsId?: NotificationOwnerId;
}

export interface NativeNotificationOptions extends WatchNotificationOptions {
  /** Attach to make the notification clickable. Without it, a click does nothing. */
  navigation?: NotificationNavigation;
}

const DEBOUNCE_MS = 300;
const DEFAULT_TITLE = "Daintree";

interface TrackedWindow {
  browserWindow: import("electron").BrowserWindow;
  focusHandler: () => void;
  blurHandler: () => void;
}

class NotificationService {
  private registry: WindowRegistry | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private statesByOwner = new Map<NotificationOwnerId, NotificationState>();
  private focusedWindows = new Set<number>();
  private trackedWindows = new Map<number, TrackedWindow>();
  private activeNotifications = new Set<Notification>();

  detachWindowListeners(windowId: number): void {
    const tracked = this.trackedWindows.get(windowId);
    if (!tracked) return;
    if (!tracked.browserWindow.isDestroyed()) {
      tracked.browserWindow.off("focus", tracked.focusHandler);
      tracked.browserWindow.off("blur", tracked.blurHandler);
    }
    this.trackedWindows.delete(windowId);
    this.focusedWindows.delete(windowId);
  }

  private detachAllWindowListeners(): void {
    for (const id of [...this.trackedWindows.keys()]) {
      this.detachWindowListeners(id);
    }
  }

  /**
   * The webContents id of the view a window is currently showing — the renderer
   * that receives the DOM focus event and zeroes its own count. Clearing only
   * this owner on window focus keeps a cached project view's unseen waiting
   * agents counted: the user hasn't looked at them yet, and switching to that
   * view focuses its webContents, which zeroes it through the normal path.
   */
  private activeOwnerOf(
    browserWindow: import("electron").BrowserWindow
  ): NotificationOwnerId | null {
    try {
      const webContents = getAppWebContents(browserWindow);
      return typeof webContents?.id === "number" ? webContents.id : null;
    } catch {
      return null;
    }
  }

  private attachWindowListeners(ctx: WindowContext): void {
    const windowId = ctx.windowId;

    if (this.trackedWindows.has(windowId)) return;

    if (ctx.browserWindow.isFocused()) {
      this.focusedWindows.add(windowId);
    }

    const focusHandler = () => {
      this.focusedWindows.add(windowId);

      const activeOwner = this.activeOwnerOf(ctx.browserWindow);
      if (activeOwner !== null) {
        this.statesByOwner.delete(activeOwner);
      }

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      this.applyNotifications();
    };

    const blurHandler = () => {
      this.focusedWindows.delete(windowId);
    };

    ctx.browserWindow.on("focus", focusHandler);
    ctx.browserWindow.on("blur", blurHandler);

    this.trackedWindows.set(windowId, {
      browserWindow: ctx.browserWindow,
      focusHandler,
      blurHandler,
    });
  }

  initialize(registry: WindowRegistry): void {
    this.detachAllWindowListeners();
    this.registry = registry;

    for (const ctx of registry.all()) {
      this.attachWindowListeners(ctx);
    }
  }

  updateNotifications(ownerWebContentsId: NotificationOwnerId, state: NotificationState): void {
    this.statesByOwner.set(ownerWebContentsId, state);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.applyNotifications();
    }, DEBOUNCE_MS);
  }

  /**
   * Drop an owner's state when its renderer is gone. Idempotent — a destroyed
   * webContents and its window's cleanup can both fire.
   */
  removeOwner(ownerWebContentsId: NotificationOwnerId): void {
    if (!this.statesByOwner.delete(ownerWebContentsId)) return;
    this.applyNotifications();
  }

  private applyNotifications(): void {
    if (!this.registry) return;

    // An owner that no longer resolves to a window is dead or dying: a view's
    // webContents id is indexed at creation, before its renderer can send any
    // IPC, and is unindexed only on eviction (which closes it) or window
    // teardown. Pruning here keeps the badge honest even if a "destroyed"
    // event is missed.
    const countsByWindow = new Map<number, number>();
    for (const [ownerId, state] of [...this.statesByOwner]) {
      const ctx = this.registry.getByWebContentsId(ownerId);
      if (!ctx || ctx.browserWindow.isDestroyed()) {
        this.statesByOwner.delete(ownerId);
        continue;
      }
      countsByWindow.set(
        ctx.windowId,
        (countsByWindow.get(ctx.windowId) ?? 0) + state.waitingCount
      );
    }

    let totalWaiting = 0;
    for (const ctx of this.registry.all()) {
      const waitingCount = countsByWindow.get(ctx.windowId) ?? 0;
      totalWaiting += waitingCount;

      if (!ctx.browserWindow.isDestroyed()) {
        ctx.browserWindow.setTitle(
          waitingCount > 0 ? `(${waitingCount}) ${DEFAULT_TITLE}` : DEFAULT_TITLE
        );
      }
    }

    if (process.platform === "darwin") {
      app.setBadgeCount(totalWaiting);
    }
  }

  private clearNotifications(): void {
    if (this.registry) {
      for (const ctx of this.registry.all()) {
        if (!ctx.browserWindow.isDestroyed()) {
          ctx.browserWindow.setTitle(DEFAULT_TITLE);
        }
      }
    }

    if (process.platform === "darwin") {
      app.setBadgeCount(0);
    }
  }

  isWindowFocused(): boolean {
    return this.focusedWindows.size > 0;
  }

  showNativeNotification(
    title: string,
    body: string,
    options: NativeNotificationOptions = {}
  ): void {
    this.showNotification(title, body, options);
  }

  showWatchNotification(
    title: string,
    body: string,
    context: WatchNotificationContext,
    navigateChannel: string,
    options: WatchNotificationOptions = {}
  ): void {
    this.showNotification(title, body, {
      ...options,
      navigation: { channel: navigateChannel, context },
    });
  }

  private showNotification(title: string, body: string, options: NativeNotificationOptions): void {
    if (!Notification.isSupported()) return;

    const { silent = true, ownerWebContentsId, navigation } = options;
    const notification = new Notification({ title, body, silent });
    this.activeNotifications.add(notification);

    const cleanup = () => {
      this.activeNotifications.delete(notification);
    };
    notification.once("close", cleanup);
    notification.once("failed", (_event, error) => {
      // Electron 42 routes macOS notifications through UNNotification, which
      // silently emits "failed" on unsigned dev builds instead of displaying.
      // Surface it as a diagnostic — signed release builds never hit this.
      console.warn(
        "[NotificationService] native notification failed (unsigned macOS dev build?):",
        error
      );
      cleanup();
    });

    if (navigation) {
      notification.once("click", () => {
        cleanup();
        this.routeNavigation(navigation.channel, navigation.context, ownerWebContentsId);
      });
    }

    notification.show();
  }

  /**
   * Focus the window that owns the panel and hand the navigate to the owning
   * renderer itself. The owner is re-resolved here rather than captured when
   * the notification was created: a view can be evicted or its window closed
   * while the banner sits on screen.
   *
   * `sendToRenderer` would deliver to whichever project view the window happens
   * to be showing, so a panel in a cached view would never receive it — send
   * straight to the owning webContents instead. The primary window is the
   * explicit last resort for a notification whose owner is gone.
   *
   * Known limit: if the owning view is cached (its project isn't the one the
   * window is showing), the panel is focused in that renderer's store but the
   * project is not switched to — making a background project visible from main
   * means driving the full renderer-owned project-switch path, which persists
   * outgoing layout state. Still strictly better than before, when the click
   * went to the primary window's active view and matched no panel at all.
   */
  private routeNavigation(
    navigateChannel: string,
    context: WatchNotificationContext,
    ownerWebContentsId?: NotificationOwnerId
  ): void {
    if (this.sendToOwner(navigateChannel, context, ownerWebContentsId)) return;

    // The owner is gone, or died between the guard and the send. Falling back to
    // the primary window is a guess — it delivers to whichever view that window
    // is showing — but a click that does nothing at all is worse.
    const fallbackWindow = this.registry?.getPrimary()?.browserWindow;
    if (!fallbackWindow || fallbackWindow.isDestroyed()) return;

    this.revealWindow(fallbackWindow);
    sendToRenderer(fallbackWindow, navigateChannel, context);
  }

  /** False when the owner could not be reached, so the caller falls back. */
  private sendToOwner(
    navigateChannel: string,
    context: WatchNotificationContext,
    ownerWebContentsId?: NotificationOwnerId
  ): boolean {
    if (ownerWebContentsId === undefined) return false;

    const ownerWebContents = webContentsModule.fromId(ownerWebContentsId);
    if (!ownerWebContents || ownerWebContents.isDestroyed()) return false;

    const ownerWindow = getWindowForWebContents(ownerWebContents);
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      this.revealWindow(ownerWindow);
    }

    try {
      ownerWebContents.send(navigateChannel, context);
      return true;
    } catch {
      return false;
    }
  }

  private revealWindow(browserWindow: import("electron").BrowserWindow): void {
    if (browserWindow.isMinimized()) {
      browserWindow.restore();
    }
    browserWindow.show();
    browserWindow.focus();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.detachAllWindowListeners();
    this.clearNotifications();
    this.statesByOwner.clear();

    for (const notification of this.activeNotifications) {
      notification.removeAllListeners();
    }
    this.activeNotifications.clear();

    this.registry = null;
  }
}

export const notificationService = new NotificationService();
