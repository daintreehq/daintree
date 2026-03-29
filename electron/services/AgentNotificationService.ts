import { events } from "./events.js";
import { notificationService, type WatchNotificationContext } from "./NotificationService.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { soundService } from "./SoundService.js";
import { CHANNELS } from "../ipc/channels.js";

const COMPLETION_DEBOUNCE_MS = 2000;
const NOTIFICATION_STAGGER_MS = 500;

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
}

class AgentNotificationService {
  private completionTimers = new Map<string, NodeJS.Timeout>();
  private waitingEscalationTimers = new Map<string, NodeJS.Timeout>();
  private notificationQueue: PendingNotification[] = [];
  private staggerTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];
  private watchedTerminals = new Set<string>();

  syncWatchedPanels(panelIds: string[]): void {
    this.watchedTerminals = new Set(panelIds);
  }

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
    waitingReason?: string;
  }): void {
    const { state, previousState, worktreeId, terminalId, agentId, waitingReason } = payload;
    const settings = projectStore.getEffectiveNotificationSettings();

    // Allow same-state transitions for waitingReason changes (e.g., prompt -> question)
    if (state === previousState && !(state === "waiting" && waitingReason !== undefined)) return;

    const key = agentId ?? worktreeId ?? "agent";

    // Cancel any pending completion timer for this agent when it leaves "completed"
    // (must run even when master toggle is off to prevent stale timers)
    if (previousState === "completed" && state !== "completed") {
      const timer = this.completionTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.completionTimers.delete(key);
      }
    }

    // Cancel waiting escalation when agent leaves "waiting"
    if (previousState === "waiting" && state !== "waiting" && terminalId) {
      this.clearWaitingEscalation(terminalId);
    }

    // Master toggle — skip all notifications when disabled
    if (settings.enabled === false) return;

    // Schedule waiting escalation for docked agents (independent of watched status)
    if (state === "waiting" && terminalId) {
      this.scheduleWaitingEscalation(terminalId, worktreeId, agentId);
    }

    // Skip if all OS notification types are disabled (off by default).
    if (!settings.completedEnabled && !settings.waitingEnabled) {
      return;
    }

    // Snapshot watched status at event time — not at debounce-fire time.
    // The renderer one-shot unwatches immediately on state change, so by the time
    // the 2s completion debounce fires, the terminal is already removed from the
    // watched set. Capturing here preserves the intent.
    const isWatched = terminalId !== undefined && this.watchedTerminals.has(terminalId);
    if (!isWatched) return;

    if (state === "completed" && settings.completedEnabled) {
      this.scheduleCompletionNotification(key, worktreeId, terminalId, agentId);
    } else if (state === "waiting" && settings.waitingEnabled) {
      // Waiting (permission request) is urgent — show immediately, bypass queue stagger
      const label = this.getLabel(agentId, worktreeId);
      const context = this.makeContext(terminalId, agentId, worktreeId);
      this.playNotificationSound(settings.soundEnabled, settings.waitingSoundFile);
      notificationService.showWatchNotification(
        "Agent waiting",
        `${label} is waiting for input`,
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        true
      );
    }
  }

  private scheduleCompletionNotification(
    key: string,
    worktreeId?: string,
    terminalId?: string,
    agentId?: string
  ): void {
    if (this.completionTimers.has(key)) {
      clearTimeout(this.completionTimers.get(key)!);
    }

    const timer = setTimeout(() => {
      this.completionTimers.delete(key);
      const settings = projectStore.getEffectiveNotificationSettings();
      if (settings.enabled === false || !settings.completedEnabled) return;
      const label = this.getLabel(agentId, worktreeId);
      this.enqueue(
        {
          title: "Agent completed",
          body: `${label} finished its task`,
          worktreeId,
          terminalId,
          agentId,
          triggerSound: settings.soundEnabled,
        },
        true,
        settings.completedSoundFile
      );
    }, COMPLETION_DEBOUNCE_MS);

    this.completionTimers.set(key, timer);
  }

  private scheduleWaitingEscalation(
    terminalId: string,
    worktreeId?: string,
    agentId?: string
  ): void {
    if (this.waitingEscalationTimers.has(terminalId)) {
      clearTimeout(this.waitingEscalationTimers.get(terminalId)!);
    }

    const settings = projectStore.getEffectiveNotificationSettings();
    if (!settings.waitingEscalationEnabled || !settings.waitingEnabled) return;

    // Only escalate for docked terminals
    const terminals = store.get("appState").terminals;
    const terminal = terminals.find((t) => t.id === terminalId);
    if (!terminal || terminal.location !== "dock") return;

    const timer = setTimeout(() => {
      this.waitingEscalationTimers.delete(terminalId);
      const currentSettings = projectStore.getEffectiveNotificationSettings();
      if (currentSettings.enabled === false) return;
      if (!currentSettings.waitingEscalationEnabled || !currentSettings.waitingEnabled) return;

      // Re-read terminal state — skip if moved out of dock or removed
      const currentTerminals = store.get("appState").terminals;
      const currentTerminal = currentTerminals.find((t) => t.id === terminalId);
      if (!currentTerminal || currentTerminal.location !== "dock") return;

      const label = currentTerminal.title || this.getLabel(agentId, worktreeId);
      this.playNotificationSound(currentSettings.soundEnabled, currentSettings.escalationSoundFile);
      notificationService.showNativeNotification(
        "Agent still waiting",
        `${label} has been waiting for input`
      );
    }, settings.waitingEscalationDelayMs);

    this.waitingEscalationTimers.set(terminalId, timer);
  }

  private clearWaitingEscalation(key: string): void {
    const timer = this.waitingEscalationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.waitingEscalationTimers.delete(key);
    }
  }

  acknowledgeWaiting(terminalId: string): void {
    this.clearWaitingEscalation(terminalId);
  }

  private enqueue(
    notification: PendingNotification,
    bypassFocusCheck = false,
    soundFile?: string
  ): void {
    if (!bypassFocusCheck && this.isFocusedOnWorktree(notification.worktreeId)) {
      return;
    }

    this.notificationQueue.push({ ...notification });
    if (soundFile) {
      this.playNotificationSound(notification.triggerSound, soundFile);
    }

    if (!this.staggerTimer) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    const item = this.notificationQueue.shift();
    if (!item) return;

    const settings = projectStore.getEffectiveNotificationSettings();
    if (settings.enabled === false) {
      this.notificationQueue = [];
      return;
    }

    const context = this.makeContext(item.terminalId, item.agentId, item.worktreeId);
    notificationService.showWatchNotification(
      item.title,
      item.body,
      context,
      CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      true
    );

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

  private makeContext(
    terminalId?: string,
    agentId?: string,
    worktreeId?: string
  ): WatchNotificationContext {
    return {
      panelId: terminalId ?? agentId ?? "unknown",
      panelTitle: agentId ?? terminalId ?? "Agent",
      worktreeId,
    };
  }

  private playNotificationSound(enabled: boolean, soundFile: string): void {
    if (!enabled) return;
    soundService.playFile(soundFile);
  }

  playSoundPreview(soundFile: string): void {
    soundService.previewFile(soundFile);
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

    for (const timer of this.waitingEscalationTimers.values()) {
      clearTimeout(timer);
    }
    this.waitingEscalationTimers.clear();

    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }

    this.notificationQueue = [];

    soundService.cancel();
  }
}

export const agentNotificationService = new AgentNotificationService();
