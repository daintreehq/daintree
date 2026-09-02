import { events } from "./events.js";
import {
  notificationService,
  type NotificationOwnerId,
  type WatchNotificationContext,
} from "./NotificationService.js";
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
type TerminalSnapshotEntry = TerminalSnapshot[number];

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
  soundFile?: string;
  ownerWebContentsId?: NotificationOwnerId;
}

interface BurstWaitingEntry {
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  waitingReason?: WaitingReason;
  soundFile: string;
  soundEnabled: boolean;
  ownerWebContentsId?: NotificationOwnerId;
}

class AgentNotificationService {
  private completionTimers = new Map<string, NodeJS.Timeout>();
  private waitingEscalationTimers = new Map<string, NodeJS.Timeout>();
  private workingPulseDelayTimers = new Map<string, NodeJS.Timeout>();
  private workingPulseIntervalTimers = new Map<string, NodeJS.Timeout>();
  private notificationQueue: PendingNotification[] = [];
  private staggerTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];
  /** Watched panels per owning renderer — a sync replaces only its own set. */
  private watchedPanelsByOwner = new Map<NotificationOwnerId, Set<string>>();
  /**
   * Reverse index. A set, not a single owner: the same project can be open in
   * two windows (#11101), so two renderers can watch the same panel, and a
   * single value would reintroduce last-writer-wins inside the fix.
   */
  private ownersByPanel = new Map<string, Set<NotificationOwnerId>>();
  /**
   * Last renderer known to own a panel, kept after it stops being watched.
   * Routing metadata only — never a watched-state source. The renderer unwatches
   * one-shot the instant a state lands, so by the time a completion debounce or
   * a minutes-later escalation fires, the live index no longer knows the owner.
   */
  private lastOwnerByPanel = new Map<string, NotificationOwnerId>();
  private terminalIndexById = new Map<string, number>();
  private hasEverGoneWorking = false;
  private peakConcurrentWorking = 0;
  private activeTerminalIds = new Set<string>();
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

  syncWatchedPanels(ownerWebContentsId: NotificationOwnerId, panelIds: string[]): void {
    const previous = this.watchedPanelsByOwner.get(ownerWebContentsId);
    const next = new Set(panelIds);

    if (previous) {
      for (const panelId of previous) {
        if (next.has(panelId)) continue;
        this.detachOwnerFromPanel(panelId, ownerWebContentsId);
      }
    }

    for (const panelId of next) {
      let owners = this.ownersByPanel.get(panelId);
      if (!owners) {
        owners = new Set();
        this.ownersByPanel.set(panelId, owners);
      }
      owners.add(ownerWebContentsId);
      this.lastOwnerByPanel.set(panelId, ownerWebContentsId);
    }

    if (next.size === 0) {
      this.watchedPanelsByOwner.delete(ownerWebContentsId);
    } else {
      this.watchedPanelsByOwner.set(ownerWebContentsId, next);
    }
  }

  /**
   * Drop everything owned by a renderer that no longer exists. Idempotent — the
   * webContents "destroyed" listener and its window's cleanup can both fire.
   *
   * Deliberately does not touch `waitingTerminalIds` or escalation timers: those
   * track main-process terminal state, which outlives any renderer watching it.
   */
  removeOwner(ownerWebContentsId: NotificationOwnerId): void {
    const watched = this.watchedPanelsByOwner.get(ownerWebContentsId);
    if (watched) {
      for (const panelId of watched) {
        this.detachOwnerFromPanel(panelId, ownerWebContentsId);
      }
      this.watchedPanelsByOwner.delete(ownerWebContentsId);
    }

    for (const [panelId, ownerId] of [...this.lastOwnerByPanel]) {
      if (ownerId !== ownerWebContentsId) continue;
      // Hand the hint to a surviving watcher rather than dropping it: with the
      // same project open in two windows, the dead renderer may not have been
      // the panel's only owner, and orphaning it here would send the click to
      // the primary window instead of the window that still shows the panel.
      const survivor = this.firstOwnerOf(panelId);
      if (survivor === undefined) {
        this.lastOwnerByPanel.delete(panelId);
      } else {
        this.lastOwnerByPanel.set(panelId, survivor);
      }
    }
  }

  private detachOwnerFromPanel(panelId: string, ownerWebContentsId: NotificationOwnerId): void {
    const owners = this.ownersByPanel.get(panelId);
    if (!owners) return;
    owners.delete(ownerWebContentsId);
    if (owners.size === 0) {
      this.ownersByPanel.delete(panelId);
    }
  }

  private isWatched(terminalId: string): boolean {
    return this.ownersByPanel.has(terminalId);
  }

  private firstOwnerOf(panelId: string): NotificationOwnerId | undefined {
    for (const ownerId of this.ownersByPanel.get(panelId) ?? []) {
      return ownerId;
    }
    return undefined;
  }

  /**
   * The renderer a notification for this panel should navigate. Prefers a live
   * watcher; falls back to the last one that watched it, which is what survives
   * the renderer's one-shot unwatch.
   */
  private resolveOwner(terminalId?: string): NotificationOwnerId | undefined {
    if (!terminalId) return undefined;
    return this.firstOwnerOf(terminalId) ?? this.lastOwnerByPanel.get(terminalId);
  }

  /**
   * Owner for a notification that is about to be shown. Re-resolving at emit
   * time matters because an owner captured when the event arrived can be
   * destroyed during the burst/debounce window, while a sibling window that
   * watches the same panel is still alive and is the right click target.
   */
  private emitOwner(
    terminalId?: string,
    capturedOwnerId?: NotificationOwnerId
  ): NotificationOwnerId | undefined {
    return this.resolveOwner(terminalId) ?? capturedOwnerId;
  }

  private forgetPanelOwnership(terminalId: string): void {
    this.lastOwnerByPanel.delete(terminalId);
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
    const initialTerminals = store.get("appState")?.terminals ?? [];
    this.rebuildTerminalIndex(initialTerminals);
    this.activeTerminalIds = new Set(
      initialTerminals
        .filter((terminal) =>
          terminal.agentState ? ACTIVE_AGENT_STATES.has(terminal.agentState) : false
        )
        .map((terminal) => terminal.id)
    );

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
        this.activeTerminalIds.delete(payload.terminalId);
        this.terminalIndexById.delete(payload.terminalId);
        // Bound the routing hint's lifetime to the agent's. A re-watch of the
        // same panel repopulates it; notifications already in flight captured
        // their owner when the event fired.
        this.forgetPanelOwnership(payload.terminalId);
      }
    });

    // A killed terminal never emits agent:exited (TerminalExitHandler suppresses
    // it for `wasKilled`), so without this the routing hint for every killed
    // agent would sit in the map for the rest of the session.
    const unsubKilled = events.on("agent:killed", (payload) => {
      if (payload.terminalId) {
        this.agentSpawnTimestamps.delete(payload.terminalId);
        this.activeTerminalIds.delete(payload.terminalId);
        this.terminalIndexById.delete(payload.terminalId);
        this.forgetPanelOwnership(payload.terminalId);
      }
    });

    this.unsubscribers.push(
      unsubStateChanged,
      unsubSpawned,
      unsubDetected,
      unsubExited,
      unsubKilled
    );
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

  private rebuildTerminalIndex(terminals: TerminalSnapshot): void {
    this.terminalIndexById.clear();
    terminals.forEach((terminal, index) => this.terminalIndexById.set(terminal.id, index));
  }

  private getTerminalSnapshotFrom(
    terminals: TerminalSnapshot,
    terminalId?: string
  ): TerminalSnapshotEntry | undefined {
    if (!terminalId) return undefined;
    const index = this.terminalIndexById.get(terminalId);
    if (index !== undefined) {
      const terminal = terminals[index];
      if (terminal?.id === terminalId) return terminal;
    }

    this.rebuildTerminalIndex(terminals);
    return terminals.find((terminal) => terminal.id === terminalId);
  }

  /**
   * Look up a terminal's persisted entry — notably its renderer-owned
   * worktreeId — from persisted app state.
   *
   * Backend-emitted agent events (agent:state-changed, agent:completed, etc.) no
   * longer carry worktreeId — it's renderer-owned layout state. Main-side
   * consumers that need worktreeId for focus/dedup/routing should resolve it
   * here from the IPC-synced appState. May briefly lag a drag-to-worktree
   * gesture; that is acceptable because the fallback (undefined) simply means
   * notifications aren't suppressed, not that they fire wrongly.
   *
   * Each `store.get` deep-clones the whole appState, so callers resolving more
   * than one terminal should read `terminals` once and use
   * `getTerminalSnapshotFrom`.
   */
  private getTerminalSnapshot(terminalId?: string): TerminalSnapshotEntry | undefined {
    if (!terminalId) return undefined;
    return this.getTerminalSnapshotFrom(store.get("appState").terminals, terminalId);
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
    this.checkAllClear(state, previousState, terminalId);
    if (state === previousState) return;

    // Idle is never a notification, escalation, or working-pulse destination,
    // so no branch below consumes terminal metadata for it.
    const terminal = state === "idle" ? undefined : this.getTerminalSnapshot(terminalId);
    const settings = projectStore.getEffectiveNotificationSettings();
    // Backend no longer emits worktreeId on agent events (#5139). Resolve it
    // from persisted renderer state so focus suppression, dedup keying, and
    // notification context still work correctly.
    const worktreeId = payload.worktreeId ?? terminal?.worktreeId;

    // Clear spawn grace tracking once the agent starts doing real work
    // (waiting→working means the user gave input, so future waiting sounds are legitimate)
    if (state === "working" && previousState === "waiting") {
      const graceKey = terminalId ?? agentId;
      if (graceKey) this.agentSpawnTimestamps.delete(graceKey);
    }

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
        terminal,
        worktreeId,
        agentId,
        coerceWaitingReason(payload.waitingReason)
      );
    }

    // Schedule working pulse for watched/docked agents entering working state
    if (state === "working" && previousState !== "working" && terminalId) {
      this.scheduleWorkingPulse(terminalId, settings, terminal);
    }

    // Skip if all OS notification types are disabled (off by default).
    if (!settings.completedEnabled && !settings.waitingEnabled) {
      return;
    }

    // Snapshot watched status at event time — not at debounce-fire time.
    // The renderer one-shot unwatches immediately on state change, so by the time
    // the 2s completion debounce fires, the terminal is already removed from the
    // watched set. Capturing here preserves the intent.
    const isWatched = terminalId !== undefined && this.isWatched(terminalId);
    if (!isWatched) return;

    // Capture the owner alongside the watched snapshot — same reason the
    // snapshot exists at all: the renderer unwatches one-shot on this very
    // transition, so the live index is empty by the time the notification fires.
    const ownerWebContentsId = this.resolveOwner(terminalId);

    if ((state === "completed" || state === "exited") && settings.completedEnabled) {
      this.scheduleCompletionNotification(key, worktreeId, terminalId, agentId, ownerWebContentsId);
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
        ownerWebContentsId,
      });
      if (this.waitingBurstTimer === null) {
        this.waitingBurstTimer = setTimeout(() => this.flushWaitingBurst(), BURST_WINDOW_MS);
      }
    }
  }

  private countActiveAgents(terminals: TerminalSnapshot): number {
    return terminals.filter((t) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)).length;
  }

  private checkAllClear(state: string, previousState: string, terminalId?: string): void {
    const wasActive = ACTIVE_AGENT_STATES.has(previousState);
    const isActive = ACTIVE_AGENT_STATES.has(state);

    if (terminalId) {
      if (isActive) this.activeTerminalIds.add(terminalId);
      else this.activeTerminalIds.delete(terminalId);
    }

    let activeCount = terminalId
      ? this.activeTerminalIds.size
      : this.countActiveAgents(store.get("appState").terminals);

    // Track when agents start working
    if (!wasActive && isActive) {
      // Preserve the persisted-snapshot contract on the first active transition
      // of a session. Renderer state can already contain active siblings whose
      // transitions preceded initialization (or were not observed here). The
      // peak only has a two-agent floor, so later transitions can stay on the
      // event-maintained set without rescanning the fleet.
      if (!this.hasEverGoneWorking) {
        activeCount = Math.max(
          activeCount,
          this.countActiveAgents(store.get("appState").terminals)
        );
      }
      this.hasEverGoneWorking = true;
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
    agentId?: string,
    ownerWebContentsId?: NotificationOwnerId
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
        ownerWebContentsId,
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

    const ownerWebContentsId = this.emitOwner(first.terminalId, first.ownerWebContentsId);

    if (dedupedItems.length === 1) {
      const label = this.getLabel(first.agentId, first.worktreeId);
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      notificationService.showWatchNotification(
        "Agent waiting",
        describeWaiting(label, first.waitingReason),
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        { silent: true, ownerWebContentsId }
      );
    } else {
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      // Reason-specific plural copy only when the whole burst shares one
      // classified reason — a mixed burst keeps the generic body so the copy
      // never overclaims for any member.
      const uniformReason = dedupedItems.every((item) => item.waitingReason === first.waitingReason)
        ? actionableWaitingReason(first.waitingReason)
        : null;
      // Context and owner both come from `first` so the click lands on the
      // panel the body is about, in the renderer that actually owns it.
      notificationService.showWatchNotification(
        "Agents waiting",
        describeWaitingMany(dedupedItems.length, uniformReason ?? undefined),
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        { silent: true, ownerWebContentsId }
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
          ownerWebContentsId: first.ownerWebContentsId,
        },
        true,
        soundFile
      );
    }
  }

  private scheduleWaitingEscalation(
    terminalId: string,
    settings: NotificationSettings,
    terminal: TerminalSnapshotEntry | undefined,
    worktreeId?: string,
    agentId?: string,
    waitingReason?: WaitingReason
  ): void {
    if (this.waitingEscalationTimers.has(terminalId)) {
      clearTimeout(this.waitingEscalationTimers.get(terminalId)!);
    }

    if (!settings.waitingEscalationEnabled || !settings.waitingEnabled) return;

    // Only escalate for docked terminals
    if (!terminal || terminal.location !== "dock") return;

    const timer = setTimeout(() => {
      this.waitingEscalationTimers.delete(terminalId);
      const currentSettings = projectStore.getEffectiveNotificationSettings();
      if (currentSettings.enabled === false) return;
      if (!currentSettings.waitingEscalationEnabled || !currentSettings.waitingEnabled) return;

      // Re-read terminal state — skip if moved out of dock or removed. One
      // appState read serves every lookup below; each `store.get` deep-clones it.
      const currentTerminals = store.get("appState").terminals;
      const currentTerminal = this.getTerminalSnapshotFrom(currentTerminals, terminalId);
      if (!currentTerminal || currentTerminal.location !== "dock") return;

      // Count all dock terminals currently waiting (for grouped escalation)
      const waitingDockTerminalIds = [...this.waitingTerminalIds].filter(
        (id) => this.getTerminalSnapshotFrom(currentTerminals, id)?.location === "dock"
      );

      this.playNotificationSound(currentSettings.soundEnabled, currentSettings.escalationSoundFile);

      // Escalation is the most urgent notification and was the only one with no
      // click handler at all, so it could never navigate anywhere. Attach panel
      // context and resolve the owner now rather than at schedule time: minutes
      // have passed, and the renderer that watched this panel may have been
      // destroyed since. A docked terminal that was never watched has no known
      // owner — the click then falls back to the primary window, which is
      // explicit and no worse than today's dead click.
      // Take the worktree from the terminal as it is NOW, not as it was when the
      // timer was armed: the body below already uses the fresh title, and a panel
      // dragged to another worktree during the wait would otherwise navigate to
      // the worktree it used to live in. The agent id can't change for a terminal.
      const navigation = {
        channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        context: this.makeContext(terminalId, agentId, currentTerminal.worktreeId ?? worktreeId),
      };
      const ownerWebContentsId = this.resolveOwner(terminalId);

      if (waitingDockTerminalIds.length > 1) {
        // Cancel sibling escalation timers so only one grouped notification fires
        for (const siblingId of waitingDockTerminalIds) {
          if (siblingId !== terminalId) {
            this.clearWaitingEscalation(siblingId);
          }
        }
        notificationService.showNativeNotification(
          "Agents still waiting",
          `${waitingDockTerminalIds.length} agents have been waiting for input`,
          { ownerWebContentsId, navigation }
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
          reason ? describeWaiting(label, reason) : `${label} has been waiting for input`,
          { ownerWebContentsId, navigation }
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
    terminal: TerminalSnapshotEntry | undefined
  ): void {
    this.clearWorkingPulse(terminalId);

    if (!settings.workingPulseEnabled || !settings.soundEnabled) return;

    // Eligibility: watched OR (docked + escalation enabled)
    const isWatched = this.isWatched(terminalId);
    if (!isWatched) {
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
      { silent: true, ownerWebContentsId: this.emitOwner(item.terminalId, item.ownerWebContentsId) }
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
    this.watchedPanelsByOwner.clear();
    this.ownersByPanel.clear();
    this.lastOwnerByPanel.clear();
    this.terminalIndexById.clear();
    this.notificationQueue = [];
    this.hasEverGoneWorking = false;
    this.peakConcurrentWorking = 0;
    this.activeTerminalIds.clear();
    this.sessionMuteUntil = 0;

    soundService.cancel();
    soundService.cancelPulse();
  }
}

export const agentNotificationService = new AgentNotificationService();
