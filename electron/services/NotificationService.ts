import { BrowserWindow, app } from "electron";

export interface NotificationState {
  waitingCount: number;
  failedCount: number;
}

const DEBOUNCE_MS = 300;
const DEFAULT_TITLE = "Canopy";

class NotificationService {
  private mainWindow: BrowserWindow | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private currentState: NotificationState = { waitingCount: 0, failedCount: 0 };
  private windowFocused = true;
  private focusHandler: (() => void) | null = null;
  private blurHandler: (() => void) | null = null;

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
      this.clearNotifications();
    };

    this.blurHandler = () => {
      this.windowFocused = false;
      // Immediately apply notifications when window loses focus if there are any
      const { waitingCount, failedCount } = this.currentState;
      if (waitingCount > 0 || failedCount > 0) {
        this.applyNotifications();
      }
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

    const { waitingCount, failedCount } = this.currentState;
    const totalAttention = waitingCount + failedCount;

    if (totalAttention > 0) {
      this.mainWindow.setTitle(`(${totalAttention}) ${DEFAULT_TITLE}`);
    } else {
      this.mainWindow.setTitle(DEFAULT_TITLE);
    }

    // Update macOS dock badge
    if (process.platform === "darwin") {
      if (totalAttention > 0) {
        app.setBadgeCount(totalAttention);
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

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.detachWindowListeners();

    // Clear notifications before disposing
    this.clearNotifications();

    this.focusHandler = null;
    this.blurHandler = null;
    this.mainWindow = null;
  }
}

export const notificationService = new NotificationService();
