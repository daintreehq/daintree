import { app, Notification } from "electron";
import type { WindowRegistry, WindowContext } from "../window/WindowRegistry.js";
import { sendToRenderer } from "../ipc/utils.js";

export interface NotificationState {
  waitingCount: number;
}

export interface WatchNotificationContext {
  worktreeId?: string;
  panelId: string;
  panelTitle: string;
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
  private currentState: NotificationState = { waitingCount: 0 };
  private focusedWindows = new Set<number>();
  private trackedWindows = new Map<number, TrackedWindow>();
  private activeNotifications = new Set<Notification>();

  private detachAllWindowListeners(): void {
    for (const [, tracked] of this.trackedWindows) {
      if (!tracked.browserWindow.isDestroyed()) {
        tracked.browserWindow.off("focus", tracked.focusHandler);
        tracked.browserWindow.off("blur", tracked.blurHandler);
      }
    }
    this.trackedWindows.clear();
    this.focusedWindows.clear();
  }

  private attachWindowListeners(ctx: WindowContext): void {
    const windowId = ctx.windowId;

    if (this.trackedWindows.has(windowId)) return;

    if (ctx.browserWindow.isFocused()) {
      this.focusedWindows.add(windowId);
    }

    const focusHandler = () => {
      this.focusedWindows.add(windowId);
      this.currentState = { waitingCount: 0 };

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      this.clearNotifications();
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

  updateNotifications(state: NotificationState): void {
    this.currentState = state;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.applyNotifications();
    }, DEBOUNCE_MS);
  }

  private applyNotifications(): void {
    if (!this.registry) return;

    if (this.isWindowFocused()) {
      this.clearNotifications();
      return;
    }

    const { waitingCount } = this.currentState;
    const title = waitingCount > 0 ? `(${waitingCount}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;

    for (const ctx of this.registry.all()) {
      if (!ctx.browserWindow.isDestroyed()) {
        ctx.browserWindow.setTitle(title);
      }
    }

    if (process.platform === "darwin") {
      app.setBadgeCount(waitingCount > 0 ? waitingCount : 0);
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

  showNativeNotification(title: string, body: string): void {
    if (!Notification.isSupported()) return;

    const notification = new Notification({ title, body, silent: true });
    this.activeNotifications.add(notification);

    const cleanup = () => {
      this.activeNotifications.delete(notification);
    };
    notification.on("close", cleanup);
    notification.on("failed" as "close", cleanup);

    notification.show();
  }

  showWatchNotification(
    title: string,
    body: string,
    context: WatchNotificationContext,
    navigateChannel: string,
    silent = false
  ): void {
    if (!Notification.isSupported()) return;

    const notification = new Notification({ title, body, silent });
    this.activeNotifications.add(notification);

    const cleanup = () => {
      this.activeNotifications.delete(notification);
    };
    notification.on("close", cleanup);
    notification.on("failed" as "close", cleanup);

    notification.on("click", () => {
      cleanup();
      const targetWin = this.registry?.getPrimary()?.browserWindow;
      if (targetWin && !targetWin.isDestroyed()) {
        if (targetWin.isMinimized()) {
          targetWin.restore();
        }
        targetWin.show();
        targetWin.focus();
        sendToRenderer(targetWin, navigateChannel, context);
      }
    });

    notification.show();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.detachAllWindowListeners();
    this.clearNotifications();
    this.activeNotifications.clear();

    this.registry = null;
  }
}

export const notificationService = new NotificationService();
