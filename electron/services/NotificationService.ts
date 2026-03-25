import { BrowserWindow, app, Notification } from "electron";

export interface NotificationState {
  waitingCount: number;
}

export interface WatchNotificationContext {
  worktreeId?: string;
  panelId: string;
  panelTitle: string;
}

const DEBOUNCE_MS = 300;
const DEFAULT_TITLE = "Canopy";

class NotificationService {
  private mainWindow: BrowserWindow | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private currentState: NotificationState = { waitingCount: 0 };
  private windowFocused = true;
  private focusHandler: (() => void) | null = null;
  private blurHandler: (() => void) | null = null;
  private activeNotifications = new Set<Notification>();

  private detachWindowListeners(): void {
    if (!this.mainWindow || !this.focusHandler || !this.blurHandler) {
      return;
    }

    this.mainWindow.off("focus", this.focusHandler);
    this.mainWindow.off("blur", this.blurHandler);
  }

  initialize(window: BrowserWindow): void {
    this.detachWindowListeners();
    this.mainWindow = window;

    // Initialize with actual focus state
    this.windowFocused = window.isFocused();

    this.focusHandler = () => {
      this.windowFocused = true;
      this.currentState = { waitingCount: 0 };

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      this.clearNotifications();
    };

    this.blurHandler = () => {
      this.windowFocused = false;
    };

    window.on("focus", this.focusHandler);
    window.on("blur", this.blurHandler);
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    // Don't show notifications when window is focused
    if (this.windowFocused) {
      this.clearNotifications();
      return;
    }

    const { waitingCount } = this.currentState;

    if (waitingCount > 0) {
      this.mainWindow.setTitle(`(${waitingCount}) ${DEFAULT_TITLE}`);
    } else {
      this.mainWindow.setTitle(DEFAULT_TITLE);
    }

    // Update macOS dock badge
    if (process.platform === "darwin") {
      if (waitingCount > 0) {
        app.setBadgeCount(waitingCount);
      } else {
        app.setBadgeCount(0);
      }
    }
  }

  private clearNotifications(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    this.mainWindow.setTitle(DEFAULT_TITLE);

    if (process.platform === "darwin") {
      app.setBadgeCount(0);
    }
  }

  isWindowFocused(): boolean {
    return this.windowFocused;
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
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        if (this.mainWindow.isMinimized()) {
          this.mainWindow.restore();
        }
        this.mainWindow.show();
        this.mainWindow.focus();
        this.mainWindow.webContents.send(navigateChannel, context);
      }
    });

    notification.show();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.detachWindowListeners();
    this.clearNotifications();
    this.activeNotifications.clear();

    this.focusHandler = null;
    this.blurHandler = null;
    this.mainWindow = null;
  }
}

export const notificationService = new NotificationService();
