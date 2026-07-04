import { events } from "./events.js";
import { notificationService, type WatchNotificationContext } from "./NotificationService.js";
import { store, type StoreSchema } from "../store.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import { projectStore } from "./ProjectStore.js";
import { soundService } from "./SoundService.js";
import { CHANNELS } from "../ipc/channels.js";
import { isScheduledQuietNow } from "../../shared/utils/quietHours.js";
import { getOsDndService } from "./OsDndService.js";
import { coerceWaitingReason, type WaitingReason } from "../../shared/types/agent.js";
import {
  actionableWaitingReason,
  describeWaiting,
  describeWaitingMany,
} from "../../shared/utils/waitingReasonDisplay.js";

const COMPLETION_DEBOUNCE_MS = 2000;
const NOTIFICATION_STAGGER_MS = 500;
const BURST_WINDOW_MS = 200;
const WORKING_PULSE_INITIAL_DELAY_MS = 10_000;
const WORKING_PULSE_MIN_INTERVAL_MS = 8_000;
const WORKING_PULSE_MAX_INTERVAL_MS = 10_000;
const ALL_CLEAR_DEBOUNCE_MS = 500;
const ACTIVE_AGENT_STATES = new Set(["working", "directing"]);

/**
 * Grace period after spawn during which waiting sounds are suppressed.
 * Agents that initialize and immediately enter waiting (without doing real work)
 * should not trigger notification sounds.
 */
const SPAWN_GRACE_PERIOD_MS = 5_000;

/**
 * Grace period after service initialization during which all agent sounds are
 * suppressed. On app startup, restored terminals re-emit spawn and state events
 * which would otherwise produce unwanted notification sounds.
 */
const BOOT_GRACE_PERIOD_MS = 8_000;

type TerminalSnapshot = StoreSchema["appState"]["terminals"];

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
  soundFile?: string;
}

interface BurstWaitingEntry {
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  waitingReason?: WaitingReason;
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
  /** Tracks when each agent spawned to suppress sounds during the grace period */
  private agentSpawnTimestamps = new Map<string, number>();
  /** Timestamp when the service was initialized — sounds are suppressed during boot */
  private initializedAt = 0;
  /** Session-mute expiry mirrored from the renderer's quick-action buttons. */
  private sessionMuteUntil = 0;

  syncWatchedPanels(panelIds: string[]): void {
    this.watchedTerminals = new Set(panelIds);
  }

  setSessionMuteUntil(timestampMs: number): void {
    this.sessionMuteUntil = Number.isFinite(timestampMs) ? timestampMs : 0;
  }

  private isSessionMuted(): boolean {
    return Date.now() < this.sessionMuteUntil;
  }

  initialize(): void {
    // Idempotent — repeat calls are a no-op so a deferred-task race during
    // window close + reopen can't double-subscribe event listeners.
    if (this.unsubscribers.length > 0) return;

    this.initializedAt = Date.now();

    const unsubStateChanged = events.on("agent:state-changed", (payload) => {
      this.handleStateChanged(payload);
    });

    const unsubSpawned = events.on("agent:spawned", (payload) => {
      // Prefer terminalId so grace keys are always unique per-terminal —
      // runtime-detected agents share agentId values across terminals (both
      // are just "claude"), and collisions would cause one terminal's grace
      // to expire a sibling's. #5773
      const agentKey = payload.terminalId ?? payload.agentId;
      if (agentKey) {
        this.agentSpawnTimestamps.set(agentKey, Date.now());
      }
      const settings = projectStore.getEffectiveNotificationSettings();
      if (settings.uiFeedbackSoundEnabled && !this.isWithinBootGrace() && !this.isSessionMuted()) {
        if (!isScheduledQuietNow(settings)) {
          soundService.play("agent-spawned");
        }
      }
    });

    // Runtime-detected agents (plain terminals where a CLI was detected) never
    // fire agent:spawned — that event is only emitted for kind="agent" panels
    // with a persisted launch-time agentId. Seed spawn grace from agent:detected
    // so startup "waiting" states don't trigger immediate notification sounds
    // for runtime-detected agents. Key exclusively by terminalId to avoid
    // cross-terminal grace bleed when two terminals detect the same agent type.
    // #5773
    const unsubDetected = events.on("agent:detected", (payload) => {
      if (!payload.agentType || !payload.terminalId) return;
      this.agentSpawnTimestamps.set(payload.terminalId, Date.now());
    });

    // Prune spawn-grace tracking when an agent exits — otherwise an agent that
    // goes spawn→working→completed without ever hitting "waiting" leaks its
    // timestamp entry (the lazy delete only fires on a "waiting" lookup).
    const unsubExited = events.on("agent:exited", (payload) => {
      if (payload.terminalId) {
        this.agentSpawnTimestamps.delete(payload.terminalId);
      }
    });

    this.unsubscribers.push(unsubStateChanged, unsubSpawned, unsubDetected, unsubExited);
  }

  private isWithinBootGrace(): boolean {
    return Date.now() - this.initializedAt < BOOT_GRACE_PERIOD_MS;
  }

  private isWithinSpawnGrace(agentId?: string, terminalId?: string): boolean {
    // Prefer terminalId so grace lookups match the per-terminal key used when
    // seeding from agent:spawned / agent:detected. #5773
    const key = terminalId ?? agentId;
    if (!key) return false;
    const spawnTime = this.agentSpawnTimestamps.get(key);
    if (spawnTime === undefined) return false;
    const elapsed = Date.now() - spawnTime;
    if (elapsed >= SPAWN_GRACE_PERIOD_MS) {
      this.agentSpawnTimestamps.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Look up the renderer-owned worktreeId for a terminal from persisted app state.
   *
   * Backend-emitted agent events (agent:state-changed, agent:completed, etc.) no
   * longer carry worktreeId — it's renderer-owned layout state. Main-side
   * consumers that need worktreeId for focus/dedup/routing should resolve it
   * here from the IPC-synced appState. May briefly lag a drag-to-worktree
   * gesture; that is acceptable because the fallback (undefined) simply means
   * notifications aren't suppressed, not that they fire wrongly.
   */
  private resolveWorktreeIdForTerminal(
    terminals: TerminalSnapshot,
    terminalId?: string
  ): string | undefined {
    if (!terminalId) return undefined;
    const entry = terminals.find((t) => t.id === terminalId);
    return entry?.worktreeId;
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
    const { state, previousState, terminalId, agentId } = payload;
    // Snapshot store-backed state once — each store.get() re-reads the full
    // store file from disk, so the helpers below take these as parameters.
    const terminals = store.get("appState").terminals;
    const settings = projectStore.getEffectiveNotificationSettings();
    // Backend no longer emits worktreeId on agent events (#5139). Resolve it
    // from persisted renderer state so focus suppression, dedup keying, and
    // notification context still work correctly.
    const worktreeId =
      payload.worktreeId ?? this.resolveWorktreeIdForTerminal(terminals, terminalId);

    // Clear spawn grace tracking once the agent starts doing real work
    // (waiting→working means the user gave input, so future waiting sounds are legitimate)
    if (state === "working" && previousState === "waiting") {
      const graceKey = terminalId ?? agentId;
      if (graceKey) this.agentSpawnTimestamps.delete(graceKey);
    }

    // All-clear tracking runs regardless of notification settings
    this.checkAllClear(state, previousState, terminals);

    if (state === previousState) return;

    // Prefer terminalId so per-terminal dedup timers don't collide when two
    // runtime-detected terminals share the same agentId value (e.g. both
    // detected as "claude"). #5773
    const key = terminalId ?? agentId ?? worktreeId ?? "agent";

    // Cancel any pending completion timer for this agent when it leaves "completed"
    // (must run even when master toggle is off to prevent stale timers)
    if (
      (previousState === "completed" || previousState === "exited") &&
      state !== "completed" &&
      state !== "exited"
    ) {
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

    // Purge any waiting-burst entry for this terminal once the terminal
    // enters a terminal state. Defense-in-depth (#9867): if a synthetic
    // `working → waiting` transition were ever to slip through the
    // `handleActivityState` `dispose` suppression, the buffered entry
    // must not outlive the terminal — otherwise the BURST_WINDOW_MS
    // timer would fire `showWatchNotification` against a dead terminal
    // ~200ms after the kill/exit. Per-terminal splice keeps entries for
    // other terminals intact.
    if ((state === "completed" || state === "exited") && terminalId) {
      const before = this.waitingBurstBuffer.length;
      this.waitingBurstBuffer = this.waitingBurstBuffer.filter(
        (entry) => entry.terminalId !== terminalId
      );
      if (this.waitingBurstBuffer.length === 0 && this.waitingBurstTimer !== null) {
        clearTimeout(this.waitingBurstTimer);
        this.waitingBurstTimer = null;
      } else if (this.waitingBurstBuffer.length !== before) {
        // Buffer still has items for other terminals — let the existing
        // timer continue to fire. Only the spliced entry was dropped.
      }
    }

    // Cancel working pulse when agent leaves "working"
    if (previousState === "working" && state !== "working" && terminalId) {
      this.clearWorkingPulse(terminalId);
    }

    // Master toggle — skip all notifications when disabled
    if (settings.enabled === false) return;

    // Schedule waiting escalation for docked agents (independent of watched status)
    // Suppress during spawn grace period — agents that initialize directly into waiting
    // should not trigger escalation sounds.
    if (state === "waiting" && terminalId && !this.isWithinSpawnGrace(agentId, terminalId)) {
      this.scheduleWaitingEscalation(
        terminalId,
        settings,
        terminals,
        worktreeId,
        agentId,
        coerceWaitingReason(payload.waitingReason)
      );
    }

    // Schedule working pulse for watched/docked agents entering working state
    if (state === "working" && previousState !== "working" && terminalId) {
      this.scheduleWorkingPulse(terminalId, settings, terminals);
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

    if ((state === "completed" || state === "exited") && settings.completedEnabled) {
      this.scheduleCompletionNotification(key, worktreeId, terminalId, agentId);
    } else if (
      state === "waiting" &&
      settings.waitingEnabled &&
      !this.isWithinSpawnGrace(agentId, terminalId)
    ) {
      this.waitingBurstBuffer.push({
        worktreeId,
        terminalId,
        agentId,
        waitingReason: coerceWaitingReason(payload.waitingReason),
        soundFile: settings.waitingSoundFile,
        soundEnabled: settings.soundEnabled,
      });
      if (this.waitingBurstTimer === null) {
        this.waitingBurstTimer = setTimeout(() => this.flushWaitingBurst(), BURST_WINDOW_MS);
      }
    }
  }

  private countActiveAgents(terminals: TerminalSnapshot): number {
    return terminals.filter((t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)).length;
  }

  private checkAllClear(state: string, previousState: string, terminals: TerminalSnapshot): void {
    const wasActive = ACTIVE_AGENT_STATES.has(previousState);
    const isActive = ACTIVE_AGENT_STATES.has(state);

    // Track when agents start working
    if (!wasActive && isActive) {
      this.hasEverGoneWorking = true;
      const activeCount = this.countActiveAgents(terminals);
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

    const activeCount = this.countActiveAgents(terminals);

    // All conditions must hold to schedule the all-clear
    if (!this.hasEverGoneWorking || this.peakConcurrentWorking < 2 || activeCount > 0) return;

    // Cancel any existing timer (rapid succession of completions)
    if (this.allClearTimer) {
      clearTimeout(this.allClearTimer);
    }

    this.allClearTimer = setTimeout(() => {
      this.allClearTimer = null;

      // Re-check after debounce — an agent may have started during the window
      const currentActive = this.countActiveAgents(store.get("appState").terminals);
      if (currentActive > 0) return;

      // Fire the all-clear
      const settings = projectStore.getEffectiveNotificationSettings();
      if (settings.enabled !== false && settings.soundEnabled) {
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

    // Last entry wins per terminal: a terminal that cycles
    // waiting → working → waiting inside the burst window keeps its most
    // recent classification, so the body never names a stale reason.
    // Map preserves first-insertion order, so burst ordering is stable.
    const dedupedByKey = new Map<string, BurstWaitingEntry>();
    for (const [index, item] of items.entries()) {
      const key =
        (item.terminalId ?? item.agentId ?? item.worktreeId)
          ? `${item.terminalId ?? ""}|${item.agentId ?? ""}|${item.worktreeId ?? ""}`
          : `unknown:${index}`;
      dedupedByKey.set(key, item);
    }
    const dedupedItems = Array.from(dedupedByKey.values());

    const first = dedupedItems[0];
    this.playNotificationSound(first.soundEnabled, first.soundFile);

    if (dedupedItems.length === 1) {
      const label = this.getLabel(first.agentId, first.worktreeId);
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      notificationService.showWatchNotification(
        "Agent waiting",
        describeWaiting(label, first.waitingReason),
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        true
      );
    } else {
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      // Reason-specific plural copy only when the whole burst shares one
      // classified reason — a mixed burst keeps the generic body so the copy
      // never overclaims for any member.
      const uniformReason = dedupedItems.every((item) => item.waitingReason === first.waitingReason)
        ? actionableWaitingReason(first.waitingReason)
        : null;
      notificationService.showWatchNotification(
        "Agents waiting",
        describeWaitingMany(dedupedItems.length, uniformReason ?? undefined),
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
    settings: NotificationSettings,
    terminals: TerminalSnapshot,
    worktreeId?: string,
    agentId?: string,
    waitingReason?: WaitingReason
  ): void {
    if (this.waitingEscalationTimers.has(terminalId)) {
      clearTimeout(this.waitingEscalationTimers.get(terminalId)!);
    }

    if (!settings.waitingEscalationEnabled || !settings.waitingEnabled) return;

    // Only escalate for docked terminals
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
        // Reason captured at the waiting transition — repeated waiting events
        // while already waiting don't reschedule this timer, so the closure
        // value is the reason for this wait episode. The duration-flavored
        // fallback stays for the weak `prompt` classification.
        const reason = actionableWaitingReason(waitingReason);
        notificationService.showNativeNotification(
          "Agent still waiting",
          reason ? describeWaiting(label, reason) : `${label} has been waiting for input`
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

  private scheduleWorkingPulse(
    terminalId: string,
    settings: NotificationSettings,
    terminals: TerminalSnapshot
  ): void {
    this.clearWorkingPulse(terminalId);

    if (!settings.workingPulseEnabled || !settings.soundEnabled) return;

    // Eligibility: watched OR (docked + escalation enabled)
    const isWatched = this.watchedTerminals.has(terminalId);
    if (!isWatched) {
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
      // During scheduled quiet hours, an active session mute, or OS-level
      // Do-Not-Disturb / Focus, skip this tick's sound but keep the loop alive
      // so pulses resume automatically after. Treat an `undefined` OS state
      // (unsupported platform / detection failed) as "do not gate".
      const osDndActive = getOsDndService().getState() === true;
      if (isScheduledQuietNow(currentSettings) || this.isSessionMuted() || osDndActive) {
        const jitter =
          WORKING_PULSE_MIN_INTERVAL_MS +
          Math.random() * (WORKING_PULSE_MAX_INTERVAL_MS - WORKING_PULSE_MIN_INTERVAL_MS);
        const nextTimer = setTimeout(tick, jitter);
        this.workingPulseIntervalTimers.set(terminalId, nextTimer);
        return;
      }
      // Randomize pitch ±15 cents per pulse to slow auditory habituation.
      // Exceeds JND (~5-10 cents) but preserves sound identity.
      const detuneCents = Math.random() * 30 - 15;
      soundService.playPulse(currentSettings.workingPulseSoundFile, detuneCents);

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

    this.notificationQueue.push({ ...notification, soundFile });

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

    // Quiet hours schedule and renderer-driven session mute both suppress
    // completion/pulse alerts but not waiting alerts — waiting agents block
    // user work and should page through.
    if (isScheduledQuietNow(settings) || this.isSessionMuted()) {
      if (this.notificationQueue.length > 0) {
        this.staggerTimer = setTimeout(() => {
          this.staggerTimer = null;
          this.drainQueue();
        }, NOTIFICATION_STAGGER_MS);
      } else {
        this.staggerTimer = null;
      }
      return;
    }

    if (item.soundFile) {
      this.playNotificationSound(item.triggerSound, item.soundFile);
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
    this.agentSpawnTimestamps.clear();
    this.notificationQueue = [];
    this.hasEverGoneWorking = false;
    this.peakConcurrentWorking = 0;
    this.sessionMuteUntil = 0;

    soundService.cancel();
    soundService.cancelPulse();
  }
}

export const agentNotificationService = new AgentNotificationService();
