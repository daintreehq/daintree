import { app, Notification, webContents as webContentsModule } from "electron";
import type { WindowRegistry, WindowContext } from "../window/WindowRegistry.js";
import { sendToRenderer } from "../ipc/utils.js";
import { getAppWebContents, getWindowForWebContents } from "../window/webContentsRegistry.js";
import { revealWindow } from "../window/projectOwnership.js";
import {
  FALLBACK_WINDOW_TITLE,
  composeWindowTitle,
  resolveWindowProjectName,
  type ProjectTitleLookup,
} from "../window/windowTitle.js";
import { readUserPresence, type UserPresence } from "./userPresence.js";

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

/**
 * What a notification is about. The machine that presents it picks the sound
 * for it from its own settings: for a view on a remote Shell that is the
 * Shell, never the host that decided to notify.
 */
export type NotificationCategory = "completed" | "waiting" | "escalation" | "info";

export interface WatchNotificationOptions {
  silent?: boolean;
  /** Renderer that owns the panel — decides which window a click focuses. */
  ownerWebContentsId?: NotificationOwnerId;
  /**
   * Panels this banner is about. `closeNotificationsForPanel` removes it once
   * every one of them has been dealt with, so a grouped banner outlives the
   * first member to be handled. Omit it and the banner is never closed early.
   */
  closeWithPanels?: readonly string[];
  /** Defaults to "info" (no sound of its own) where a remote Shell presents it. */
  category?: NotificationCategory;
}

export interface NativeNotificationOptions extends WatchNotificationOptions {
  /** Attach to make the notification clickable. Without it, a click does nothing. */
  navigation?: NotificationNavigation;
}

const DEBOUNCE_MS = 300;

/** A decided notification whose owner is a view on a remote Shell. */
export interface RemoteNotification {
  /** The owning remote endpoint's handle (negative). */
  ownerHandle: number;
  title: string;
  body: string;
  category: NotificationCategory;
  navigation?: NotificationNavigation;
}

/**
 * Delivers a notification to the Shell that owns it. Installed by the Remote
 * Hosts host side; with none installed a remote owner's notification is
 * dropped, since this machine's screen is not the one being watched.
 */
export type RemoteNotificationSink = (notification: RemoteNotification) => void;

/**
 * Whether the owner is a view on a remote Shell. Remote endpoint handles are
 * negative; `WebContents` ids never are.
 */
export function isRemoteNotificationOwner(
  ownerId: NotificationOwnerId | undefined
): ownerId is number {
  return typeof ownerId === "number" && ownerId < 0;
}

interface TrackedWindow {
  browserWindow: import("electron").BrowserWindow;
  focusHandler: () => void;
  blurHandler: () => void;
}

class NotificationService {
  private registry: WindowRegistry | null = null;
  private projectLookup: ProjectTitleLookup | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private statesByOwner = new Map<NotificationOwnerId, NotificationState>();
  private focusedWindows = new Set<number>();
  private trackedWindows = new Map<number, TrackedWindow>();
  private activeNotifications = new Set<Notification>();
  /** Panels still outstanding for each banner that asked to close with them. */
  private pendingPanelsByNotification = new Map<Notification, Set<string>>();

  private remoteSink: RemoteNotificationSink | null = null;

  /** The host decides; the Shell that owns the view displays. */
  setRemoteNotificationSink(sink: RemoteNotificationSink | null): () => void {
    this.remoteSink = sink;
    return () => {
      if (this.remoteSink === sink) this.remoteSink = null;
    };
  }

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

  /**
   * `projectLookup` resolves a ProjectViewManager id to its project row so each
   * window's title can name what it is showing. Injected rather than imported
   * so the service stays free of the SQLite-backed project store — omit it and
   * every window falls back to the app name.
   */
  initialize(registry: WindowRegistry, projectLookup?: ProjectTitleLookup): void {
    this.detachAllWindowListeners();
    this.registry = registry;
    this.projectLookup = projectLookup ?? null;

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

    this.pruneDeadOwners();
    const countsByWindow = this.countsByWindow();

    let totalWaiting = 0;
    for (const ctx of this.registry.all()) {
      const waitingCount = countsByWindow.get(ctx.windowId) ?? 0;
      totalWaiting += waitingCount;
      this.writeTitle(ctx, waitingCount);
    }

    if (process.platform === "darwin") {
      app.setBadgeCount(totalWaiting);
    }
  }

  /**
   * Recompose every live window's title against the project each one is now
   * showing, without touching the waiting counts or the Dock badge.
   *
   * Called after a project switch, rename, close, or removal — the moments the
   * displayed identity changes but the notification state does not. Refreshing
   * every window rather than a named one is deliberate: each window answers from
   * its own ProjectViewManager, so there is no cross-window filter to get wrong
   * (a cached, non-visible view for the same project must not retitle its host).
   */
  refreshTitles(): void {
    if (!this.registry) return;

    const countsByWindow = this.countsByWindow();
    for (const ctx of this.registry.all()) {
      this.writeTitle(ctx, countsByWindow.get(ctx.windowId) ?? 0);
    }
  }

  /**
   * An owner that no longer resolves to a window is dead or dying: a view's
   * webContents id is indexed at creation, before its renderer can send any
   * IPC, and is unindexed only on eviction (which closes it) or window
   * teardown. Pruning keeps the badge honest even if a "destroyed" event is
   * missed.
   *
   * Only `applyNotifications` prunes, because dropping an owner changes the
   * total the badge is about to be set from. A title-only pass that pruned
   * would leave the badge stale AND make the later `removeOwner` a no-op, since
   * its `delete` would find nothing left to remove.
   */
  private pruneDeadOwners(): void {
    if (!this.registry) return;

    for (const ownerId of [...this.statesByOwner.keys()]) {
      const ctx = this.registry.getByWebContentsId(ownerId);
      if (!ctx || ctx.browserWindow.isDestroyed()) {
        this.statesByOwner.delete(ownerId);
      }
    }
  }

  private countsByWindow(): Map<number, number> {
    const counts = new Map<number, number>();
    if (!this.registry) return counts;

    for (const [ownerId, state] of this.statesByOwner) {
      const ctx = this.registry.getByWebContentsId(ownerId);
      if (!ctx || ctx.browserWindow.isDestroyed()) continue;
      counts.set(ctx.windowId, (counts.get(ctx.windowId) ?? 0) + state.waitingCount);
    }
    return counts;
  }

  /**
   * Best-effort by construction: callers invoke this from a `finally` after a
   * switch or rename has already committed, so a throw here would replace the
   * original result and mask the real failure.
   */
  private writeTitle(ctx: WindowContext, waitingCount: number): void {
    if (ctx.browserWindow.isDestroyed()) return;

    try {
      const projectName = resolveWindowProjectName(
        ctx.services.projectViewManager,
        this.projectLookup
      );
      ctx.browserWindow.setTitle(composeWindowTitle(projectName, waitingCount));
    } catch (err) {
      console.warn("[NotificationService] failed to set window title:", err);
    }
  }

  /**
   * Only runs from `dispose()`, so it deliberately drops back to the plain app
   * name rather than resolving project names: the store is closing on the
   * shutdown path, and nothing reads these titles again.
   */
  private clearNotifications(): void {
    if (this.registry) {
      for (const ctx of this.registry.all()) {
        if (!ctx.browserWindow.isDestroyed()) {
          ctx.browserWindow.setTitle(FALLBACK_WINDOW_TITLE);
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

  /**
   * True only while the owner's renderer is the view its window is showing and
   * that window has focus. A cached view, or a window behind another, does not
   * count — its panels are out of sight.
   */
  isOwnerViewFocused(ownerWebContentsId: NotificationOwnerId | undefined): boolean {
    if (ownerWebContentsId === undefined || !this.registry) return false;
    const ctx = this.registry.getByWebContentsId(ownerWebContentsId);
    if (!ctx || ctx.browserWindow.isDestroyed()) return false;
    if (!this.focusedWindows.has(ctx.windowId)) return false;
    return this.activeOwnerOf(ctx.browserWindow) === ownerWebContentsId;
  }

  getUserPresence(): UserPresence {
    return readUserPresence();
  }

  /**
   * The panel has been dealt with — acknowledged, or its agent stopped waiting.
   * Banners that were only about it leave Notification Center; grouped banners
   * just drop it and stay until their last member goes the same way.
   *
   * `close()` is a no-op for a banner the user already dismissed, and on
   * unsigned macOS builds, so the tracking is cleared here rather than relying
   * on the "close" event to arrive.
   */
  closeNotificationsForPanel(panelId: string): void {
    for (const [notification, pending] of [...this.pendingPanelsByNotification]) {
      if (!pending.delete(panelId) || pending.size > 0) continue;
      this.forgetNotification(notification);
      try {
        notification.close();
      } catch (err) {
        console.warn("[NotificationService] failed to close native notification:", err);
      }
    }
  }

  private forgetNotification(notification: Notification): void {
    this.activeNotifications.delete(notification);
    this.pendingPanelsByNotification.delete(notification);
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
    const {
      silent = true,
      ownerWebContentsId,
      navigation,
      closeWithPanels,
      category = "info",
    } = options;
    if (isRemoteNotificationOwner(ownerWebContentsId)) {
      try {
        this.remoteSink?.({ ownerHandle: ownerWebContentsId, title, body, category, navigation });
      } catch (error) {
        console.warn("[NotificationService] remote notification delivery failed:", error);
      }
      return;
    }

    if (!Notification.isSupported()) return;

    const notification = new Notification({ title, body, silent });
    this.activeNotifications.add(notification);
    if (closeWithPanels && closeWithPanels.length > 0) {
      this.pendingPanelsByNotification.set(notification, new Set(closeWithPanels));
    }

    const cleanup = () => {
      this.forgetNotification(notification);
    };
    notification.on("close", (details) => {
      // A Windows toast that times out moves to Action Center rather than
      // going away, so one that closes with its panels stays tracked until
      // they are dealt with. Nothing else could ever close it, so the rest go.
      if (details?.reason === "timedOut" && this.pendingPanelsByNotification.has(notification)) {
        return;
      }
      cleanup();
    });
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

    revealWindow(fallbackWindow);
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
      revealWindow(ownerWindow);
    }

    try {
      ownerWebContents.send(navigateChannel, context);
      return true;
    } catch {
      return false;
    }
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
    this.pendingPanelsByNotification.clear();

    this.registry = null;
    this.projectLookup = null;
    this.remoteSink = null;
  }
}

export const notificationService = new NotificationService();
