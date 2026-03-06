import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { events } from "./events.js";
import { notificationService } from "./NotificationService.js";
import { store } from "../store.js";
import { playSound, type SoundHandle } from "../utils/soundPlayer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AgentNotificationService lives in electron/services/; sounds are in electron/resources/sounds/
const SOUNDS_DIR = path.join(__dirname, "..", "resources", "sounds");

const COMPLETION_DEBOUNCE_MS = 2000;
const NOTIFICATION_STAGGER_MS = 500;

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  triggerSound: boolean;
}

class AgentNotificationService {
  private completionTimers = new Map<string, NodeJS.Timeout>();
  private notificationQueue: PendingNotification[] = [];
  private staggerTimer: NodeJS.Timeout | null = null;
  private lastSoundHandle: SoundHandle | null = null;
  private unsubscribers: Array<() => void> = [];

  initialize(): void {
    const unsubStateChanged = events.on("agent:state-changed", (payload) => {
      this.handleStateChanged(payload);
    });

    this.unsubscribers.push(unsubStateChanged);
  }

  private handleStateChanged(payload: {
    state: string;
    previousState: string;
    worktreeId?: string;
    terminalId?: string;
    agentId?: string;
    timestamp: number;
  }): void {
    const { state, previousState, worktreeId, agentId } = payload;
    const settings = store.get("notificationSettings");

    if (state === previousState) return;

    // Skip if all OS notification types are disabled (off by default).
    // TODO: Scope to watched terminals once #2539 ships.
    if (!settings.completedEnabled && !settings.waitingEnabled && !settings.failedEnabled) {
      return;
    }

    // Cancel any pending completion timer for this agent when it leaves "completed"
    if (previousState === "completed" && state !== "completed") {
      const key = agentId ?? worktreeId ?? "agent";
      const timer = this.completionTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.completionTimers.delete(key);
      }
    }

    if (state === "completed" && settings.completedEnabled) {
      this.scheduleCompletionNotification(agentId ?? worktreeId ?? "agent", worktreeId, agentId);
    } else if (state === "waiting" && settings.waitingEnabled) {
      // Waiting (permission request) is urgent — show immediately, bypass queue stagger
      const label = this.getLabel(agentId, worktreeId);
      this.playNotificationSound(settings.soundEnabled);
      notificationService.showNativeNotification("Agent waiting", `${label} is waiting for input`);
    } else if (state === "failed" && settings.failedEnabled) {
      const label = this.getLabel(agentId, worktreeId);
      this.enqueue(
        {
          title: "Agent failed",
          body: `${label} encountered an error`,
          worktreeId,
          triggerSound: settings.soundEnabled,
        },
        false,
        "error.wav"
      );
    }
  }

  private scheduleCompletionNotification(key: string, worktreeId?: string, agentId?: string): void {
    if (this.completionTimers.has(key)) {
      clearTimeout(this.completionTimers.get(key)!);
    }

    const timer = setTimeout(() => {
      this.completionTimers.delete(key);
      const settings = store.get("notificationSettings");
      const label = this.getLabel(agentId, worktreeId);
      this.enqueue({
        title: "Agent completed",
        body: `${label} finished its task`,
        worktreeId,
        triggerSound: settings.soundEnabled,
      });
    }, COMPLETION_DEBOUNCE_MS);

    this.completionTimers.set(key, timer);
  }

  private enqueue(
    notification: PendingNotification,
    bypassFocusCheck = false,
    soundOverride?: string
  ): void {
    if (!bypassFocusCheck && this.isFocusedOnWorktree(notification.worktreeId)) {
      return;
    }

    this.notificationQueue.push({ ...notification });
    this.playNotificationSound(notification.triggerSound, soundOverride);

    if (!this.staggerTimer) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    const item = this.notificationQueue.shift();
    if (!item) return;

    notificationService.showNativeNotification(item.title, item.body);

    if (this.notificationQueue.length > 0) {
      this.staggerTimer = setTimeout(() => {
        this.staggerTimer = null;
        this.drainQueue();
      }, NOTIFICATION_STAGGER_MS);
    } else {
      this.staggerTimer = null;
    }
  }

  private isFocusedOnWorktree(worktreeId?: string): boolean {
    if (!notificationService.isWindowFocused()) return false;
    if (!worktreeId) return true;
    // Read active worktree directly from store — always reflects current state
    const activeWorktreeId = store.get("appState").activeWorktreeId;
    return activeWorktreeId === worktreeId;
  }

  private getLabel(agentId?: string, worktreeId?: string): string {
    if (agentId) return agentId;
    if (worktreeId) return worktreeId;
    return "Agent";
  }

  private playNotificationSound(enabled: boolean, fileOverride?: string): void {
    if (!enabled) return;

    const settings = store.get("notificationSettings");
    const soundFile = fileOverride ?? settings.soundFile;
    const soundPath = path.join(SOUNDS_DIR, soundFile);

    if (!existsSync(soundPath)) return;

    if (this.lastSoundHandle) {
      this.lastSoundHandle.cancel();
    }
    this.lastSoundHandle = playSound(soundPath);
  }

  playSoundPreview(soundFile: string): void {
    const soundPath = path.join(SOUNDS_DIR, soundFile);
    if (this.lastSoundHandle) {
      this.lastSoundHandle.cancel();
    }
    this.lastSoundHandle = playSound(soundPath);
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const timer of this.completionTimers.values()) {
      clearTimeout(timer);
    }
    this.completionTimers.clear();

    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }

    this.notificationQueue = [];

    if (this.lastSoundHandle) {
      this.lastSoundHandle.cancel();
      this.lastSoundHandle = null;
    }
  }
}

export const agentNotificationService = new AgentNotificationService();
