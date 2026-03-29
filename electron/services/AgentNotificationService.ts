import { events } from "./events.js";
import { notificationService, type WatchNotificationContext } from "./NotificationService.js";
import { store } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import { soundService } from "./SoundService.js";
import { CHANNELS } from "../ipc/channels.js";

const COMPLETION_DEBOUNCE_MS = 2000;
const NOTIFICATION_STAGGER_MS = 500;
const BURST_WINDOW_MS = 200;
const WORKING_PULSE_INITIAL_DELAY_MS = 10_000;
const WORKING_PULSE_MIN_INTERVAL_MS = 8_000;
const WORKING_PULSE_MAX_INTERVAL_MS = 10_000;
const ALL_CLEAR_DEBOUNCE_MS = 500;
const ACTIVE_AGENT_STATES = new Set(["working", "running", "directing"]);

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
}

interface BurstWaitingEntry {
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  soundFile: string;
  soundEnabled: boolean;
}

class AgentNotificationService {
  private completionTimers = new Map<string, NodeJS.Timeout>();
  private waitingEscalationTimers = new Map<string, NodeJS.Timeout>();
  private workingPulseDelayTimers = new Map<string, NodeJS.Timeout>();
  private workingPulseIntervalTimers = new Map<string, NodeJS.Timeout>();
  private notificationQueue: PendingNotification[] = [];
  private staggerTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];
  private watchedTerminals = new Set<string>();
  private hasEverGoneWorking = false;
  private peakConcurrentWorking = 0;
  private allClearTimer: NodeJS.Timeout | null = null;

  private waitingBurstBuffer: BurstWaitingEntry[] = [];
  private waitingBurstTimer: NodeJS.Timeout | null = null;
  private completionBurstBuffer: PendingNotification[] = [];
  private completionBurstTimer: NodeJS.Timeout | null = null;
  private completionBurstSoundFile: string | undefined;
  private waitingTerminalIds = new Set<string>();

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

    // All-clear tracking runs regardless of notification settings
    this.checkAllClear(state, previousState);

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

    // Track currently-waiting terminal IDs for escalation grouping
    if (state === "waiting" && terminalId) {
      this.waitingTerminalIds.add(terminalId);
    }

    // Cancel waiting escalation when agent leaves "waiting"
    if (previousState === "waiting" && state !== "waiting" && terminalId) {
      this.waitingTerminalIds.delete(terminalId);
      this.clearWaitingEscalation(terminalId);
    }

    // Cancel working pulse when agent leaves "working"
    if (previousState === "working" && state !== "working" && terminalId) {
      this.clearWorkingPulse(terminalId);
    }

    // Master toggle — skip all notifications when disabled
    if (settings.enabled === false) return;

    // Schedule waiting escalation for docked agents (independent of watched status)
    if (state === "waiting" && terminalId) {
      this.scheduleWaitingEscalation(terminalId, worktreeId, agentId);
    }

    // Schedule working pulse for watched/docked agents entering working state
    if (state === "working" && previousState !== "working" && terminalId) {
      this.scheduleWorkingPulse(terminalId, worktreeId, agentId);
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
      this.waitingBurstBuffer.push({
        worktreeId,
        terminalId,
        agentId,
        soundFile: settings.waitingSoundFile,
        soundEnabled: settings.soundEnabled,
      });
      if (this.waitingBurstTimer === null) {
        this.waitingBurstTimer = setTimeout(() => this.flushWaitingBurst(), BURST_WINDOW_MS);
      }
    }
  }

  private countActiveAgents(): number {
    const terminals = store.get("appState").terminals;
    return terminals.filter(
      (t: { agentState?: string }) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
    ).length;
  }

  private checkAllClear(state: string, previousState: string): void {
    const wasActive = ACTIVE_AGENT_STATES.has(previousState);
    const isActive = ACTIVE_AGENT_STATES.has(state);

    // Track when agents start working
    if (!wasActive && isActive) {
      this.hasEverGoneWorking = true;
      const activeCount = this.countActiveAgents();
      this.peakConcurrentWorking = Math.max(this.peakConcurrentWorking, activeCount);

      // Cancel any pending all-clear — a new agent just started
      if (this.allClearTimer) {
        clearTimeout(this.allClearTimer);
        this.allClearTimer = null;
      }
      return;
    }

    // Only consider transitions OUT of active states
    if (!wasActive || isActive) return;

    const activeCount = this.countActiveAgents();

    // All conditions must hold to schedule the all-clear
    if (!this.hasEverGoneWorking || this.peakConcurrentWorking < 2 || activeCount > 0) return;

    // Cancel any existing timer (rapid succession of completions)
    if (this.allClearTimer) {
      clearTimeout(this.allClearTimer);
    }

    this.allClearTimer = setTimeout(() => {
      this.allClearTimer = null;

      // Re-check after debounce — an agent may have started during the window
      const currentActive = this.countActiveAgents();
      if (currentActive > 0) return;

      // Fire the all-clear
      const settings = projectStore.getEffectiveNotificationSettings();
      if (settings.soundEnabled) {
        soundService.play("all-clear");
      }
      events.emit("agent:all-clear", { timestamp: Date.now() });

      // Reset for next multi-agent session
      this.peakConcurrentWorking = 0;
      this.hasEverGoneWorking = false;
    }, ALL_CLEAR_DEBOUNCE_MS);
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
      this.completionBurstBuffer.push({
        title: "Agent completed",
        body: `${label} finished its task`,
        worktreeId,
        terminalId,
        agentId,
        triggerSound: settings.soundEnabled,
      });
      if (!this.completionBurstSoundFile) {
        this.completionBurstSoundFile = settings.completedSoundFile;
      }
      if (this.completionBurstTimer === null) {
        this.completionBurstTimer = setTimeout(() => this.flushCompletionBurst(), 0);
      }
    }, COMPLETION_DEBOUNCE_MS);

    this.completionTimers.set(key, timer);
  }

  private flushWaitingBurst(): void {
    this.waitingBurstTimer = null;
    const items = this.waitingBurstBuffer.splice(0);
    if (items.length === 0) return;

    const first = items[0];
    this.playNotificationSound(first.soundEnabled, first.soundFile);

    if (items.length === 1) {
      const label = this.getLabel(first.agentId, first.worktreeId);
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      notificationService.showWatchNotification(
        "Agent waiting",
        `${label} is waiting for input`,
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        true
      );
    } else {
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      notificationService.showWatchNotification(
        "Agents waiting",
        `${items.length} agents waiting for input`,
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        true
      );
    }
  }

  private flushCompletionBurst(): void {
    this.completionBurstTimer = null;
    const items = this.completionBurstBuffer.splice(0);
    const soundFile = this.completionBurstSoundFile;
    this.completionBurstSoundFile = undefined;
    if (items.length === 0) return;

    if (items.length === 1) {
      this.enqueue(items[0], true, soundFile);
    } else {
      const first = items[0];
      this.enqueue(
        {
          title: "Agents completed",
          body: `${items.length} agents finished their tasks`,
          worktreeId: first.worktreeId,
          terminalId: first.terminalId,
          agentId: first.agentId,
          triggerSound: first.triggerSound,
        },
        true,
        soundFile
      );
    }
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

      // Count all dock terminals currently waiting (for grouped escalation)
      const waitingDockTerminalIds = currentTerminals
        .filter((t) => t.location === "dock" && this.waitingTerminalIds.has(t.id))
        .map((t) => t.id);

      this.playNotificationSound(currentSettings.soundEnabled, currentSettings.escalationSoundFile);

      if (waitingDockTerminalIds.length > 1) {
        // Cancel sibling escalation timers so only one grouped notification fires
        for (const siblingId of waitingDockTerminalIds) {
          if (siblingId !== terminalId) {
            this.clearWaitingEscalation(siblingId);
          }
        }
        notificationService.showNativeNotification(
          "Agents still waiting",
          `${waitingDockTerminalIds.length} agents have been waiting for input`
        );
      } else {
        const label = currentTerminal.title || this.getLabel(agentId, worktreeId);
        notificationService.showNativeNotification(
          "Agent still waiting",
          `${label} has been waiting for input`
        );
      }
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

  acknowledgeWorkingPulse(terminalId: string): void {
    this.clearWorkingPulse(terminalId);
  }

  private scheduleWorkingPulse(terminalId: string, _worktreeId?: string, _agentId?: string): void {
    this.clearWorkingPulse(terminalId);

    const settings = projectStore.getEffectiveNotificationSettings();
    if (!settings.workingPulseEnabled || !settings.soundEnabled) return;

    // Eligibility: watched OR (docked + escalation enabled)
    const isWatched = this.watchedTerminals.has(terminalId);
    if (!isWatched) {
      const terminals = store.get("appState").terminals;
      const terminal = terminals.find((t) => t.id === terminalId);
      if (!terminal || terminal.location !== "dock" || !settings.waitingEscalationEnabled) return;
    }

    const delayTimer = setTimeout(() => {
      this.workingPulseDelayTimers.delete(terminalId);
      this.startPulseInterval(terminalId);
    }, WORKING_PULSE_INITIAL_DELAY_MS);

    this.workingPulseDelayTimers.set(terminalId, delayTimer);
  }

  private startPulseInterval(terminalId: string): void {
    const tick = () => {
      const currentSettings = projectStore.getEffectiveNotificationSettings();
      if (!currentSettings.workingPulseEnabled || !currentSettings.soundEnabled) {
        this.clearWorkingPulse(terminalId);
        return;
      }
      soundService.playPulse(currentSettings.workingPulseSoundFile);

      const jitter =
        WORKING_PULSE_MIN_INTERVAL_MS +
        Math.random() * (WORKING_PULSE_MAX_INTERVAL_MS - WORKING_PULSE_MIN_INTERVAL_MS);
      const nextTimer = setTimeout(tick, jitter);
      this.workingPulseIntervalTimers.set(terminalId, nextTimer);
    };
    tick();
  }

  private clearWorkingPulse(terminalId: string): void {
    const delayTimer = this.workingPulseDelayTimers.get(terminalId);
    if (delayTimer) {
      clearTimeout(delayTimer);
      this.workingPulseDelayTimers.delete(terminalId);
    }
    const intervalTimer = this.workingPulseIntervalTimers.get(terminalId);
    if (intervalTimer) {
      clearTimeout(intervalTimer);
      this.workingPulseIntervalTimers.delete(terminalId);
    }
    soundService.cancelPulse();
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

    for (const timer of this.workingPulseDelayTimers.values()) {
      clearTimeout(timer);
    }
    this.workingPulseDelayTimers.clear();

    for (const timer of this.workingPulseIntervalTimers.values()) {
      clearTimeout(timer);
    }
    this.workingPulseIntervalTimers.clear();

    if (this.allClearTimer) {
      clearTimeout(this.allClearTimer);
      this.allClearTimer = null;
    }

    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }

    if (this.waitingBurstTimer) {
      clearTimeout(this.waitingBurstTimer);
      this.waitingBurstTimer = null;
    }
    this.waitingBurstBuffer = [];

    if (this.completionBurstTimer) {
      clearTimeout(this.completionBurstTimer);
      this.completionBurstTimer = null;
    }
    this.completionBurstBuffer = [];
    this.completionBurstSoundFile = undefined;

    this.waitingTerminalIds.clear();
    this.notificationQueue = [];
    this.hasEverGoneWorking = false;
    this.peakConcurrentWorking = 0;

    soundService.cancel();
    soundService.cancelPulse();
  }
}

export const agentNotificationService = new AgentNotificationService();
