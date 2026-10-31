import { events } from "./events.js";
import {
  notificationService,
  type NotificationCategory,
  type NotificationOwnerId,
  type WatchNotificationContext,
} from "./NotificationService.js";
import { isRemoteEndpointHandle } from "../ipc/endpoint.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import { projectStore } from "./ProjectStore.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { isHostThrowawayTerminalId } from "../../shared/config/hostThrowaway.js";
import { PanelRecordIndex, type PanelRecord } from "./agentNotificationPanels.js";
import { soundService } from "./SoundService.js";
import { CHANNELS } from "../ipc/channels.js";
import { isScheduledQuietNow } from "../../shared/utils/quietHours.js";
import { getOsDndService } from "./OsDndService.js";
import type { UserPresence } from "./userPresence.js";
import { shouldPlayUiFeedbackSound } from "../utils/uiFeedbackSound.js";
import { coerceWaitingReason, type WaitingReason } from "../../shared/types/agent.js";
import { getEffectiveRegistry } from "../../shared/config/agentRegistry.js";
import {
  actionableWaitingReason,
  describeWaiting,
  describeWaitingMany,
} from "../../shared/utils/waitingReasonDisplay.js";

/** A view on a remote Shell owns it: that Shell presents it, sound included. */
function isRemoteNotificationOwner(
  ownerId: NotificationOwnerId | undefined
): ownerId is NotificationOwnerId {
  return ownerId !== undefined && isRemoteEndpointHandle(ownerId);
}

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

interface PendingNotification {
  title: string;
  body: string;
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  triggerSound: boolean;
  soundFile?: string;
  ownerWebContentsId?: NotificationOwnerId;
  /** The agent's project, frozen when its event arrived: a natural exit drops the live record. */
  projectId: string | null;
  category: NotificationCategory;
}

interface BurstWaitingEntry {
  worktreeId?: string;
  terminalId?: string;
  agentId?: string;
  waitingReason?: WaitingReason;
  soundFile: string;
  soundEnabled: boolean;
  ownerWebContentsId?: NotificationOwnerId;
  projectId: string | null;
}

/**
 * What a Shell decides for the notifications this host sends its views
 * (#14701): which events alert it, and when an unanswered wait is raised again.
 */
export type ShellNotificationPolicy = Pick<
  NotificationSettings,
  | "enabled"
  | "completedEnabled"
  | "waitingEnabled"
  | "waitingEscalationEnabled"
  | "waitingEscalationDelayMs"
>;

/** An agent Canopy read as asking the user something. */
export interface CanopyAskNotice {
  terminalId: string;
  worktreeId?: string;
  agentId?: string;
  kind: "approval" | "question";
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
  /** Each panel's dock, worktree and title, from its project's saved record (#15636). */
  private panels = new PanelRecordIndex();
  /** Projects whose alert overrides are being read now. */
  private overridesLoading = new Set<string>();
  /**
   * The project each agent's live terminal last named. A natural exit drops
   * the live record before the agent's last transition, and a panel that was
   * never saved has no record to fall back on.
   */
  private projectByTerminal = new Map<string, string>();
  /**
   * The worktree each view has selected, as it last reported. Every view has
   * its own, so the global `appState.activeWorktreeId` (whichever view changed
   * worktree last) can't say what the view that owns a panel is showing.
   */
  private selectedWorktreeByOwner = new Map<NotificationOwnerId, string | null>();
  private hasEverGoneWorking = false;
  private peakConcurrentWorking = 0;
  private activeTerminalIds = new Set<string>();
  /** Agents an event spoke for while the startup seed was in flight: the seed is older news. */
  private activeSeedTouched: Set<string> | null = null;
  /** An all-clear that came due while the seed was in flight, and waits on its answer. */
  private allClearHeldForSeed = false;
  private allClearTimer: NodeJS.Timeout | null = null;
  /**
   * The project of the agent whose transition left nothing working: the
   * all-clear is the fleet's, and its sound goes by the last one's choices.
   */
  private allClearProjectId: string | null = null;

  private waitingBurstBuffer: BurstWaitingEntry[] = [];
  private waitingBurstTimer: NodeJS.Timeout | null = null;
  private completionBurstBuffer: PendingNotification[] = [];
  private completionBurstTimer: NodeJS.Timeout | null = null;
  private waitingTerminalIds = new Set<string>();
  /**
   * Waits Daintree's own banner already went out for, until the agent stops
   * waiting or is dealt with — so Canopy reading the same wait doesn't page twice.
   */
  private announcedWaitingIds = new Set<string>();
  /** The same, the other way round: asks Canopy paged for, until the agent works again or is dealt with. */
  private canopyAnnouncedIds = new Set<string>();
  /** Each with the panels that list it: what's in front of one ask says nothing of another's. */
  private canopyAskBuffer: Array<
    CanopyAskNotice & {
      canopyOpenIn: () => readonly NotificationOwnerId[];
      projectId: string | null;
    }
  > = [];
  private canopyAskTimer: NodeJS.Timeout | null = null;
  /** Tracks when each agent spawned to suppress sounds during the grace period */
  private agentSpawnTimestamps = new Map<string, number>();
  /** Timestamp when the service was initialized — sounds are suppressed during boot */
  private initializedAt = 0;
  /** Session-mute expiry mirrored from this machine's renderers' quick-action buttons. */
  private sessionMuteUntil = 0;
  /**
   * Session mutes of remote Shells, by client. Muting is about the person at
   * one screen, so a Shell's mute holds back only the notifications this host
   * sends that Shell, never this machine's own or another Shell's.
   */
  private remoteSessionMuteUntil = new Map<string, number>();
  /** Each Shell's own alert choices, by client, for what this host sends its views. */
  private shellPolicies = new Map<string, ShellNotificationPolicy>();

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

  /** The worktree a view has selected; `null` when it has none. */
  setSelectedWorktree(ownerWebContentsId: NotificationOwnerId, worktreeId: string | null): void {
    this.selectedWorktreeByOwner.set(ownerWebContentsId, worktreeId);
  }

  /**
   * Drop everything owned by a renderer that no longer exists. Idempotent — the
   * webContents "destroyed" listener and its window's cleanup can both fire.
   *
   * Deliberately does not touch `waitingTerminalIds` or escalation timers: those
   * track main-process terminal state, which outlives any renderer watching it.
   */
  removeOwner(ownerWebContentsId: NotificationOwnerId): void {
    this.selectedWorktreeByOwner.delete(ownerWebContentsId);
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

  /** With a `clientId`, the mute of that remote Shell only. */
  setSessionMuteUntil(timestampMs: number, clientId?: string): void {
    const until = Number.isFinite(timestampMs) ? timestampMs : 0;
    if (clientId === undefined) {
      this.sessionMuteUntil = until;
      return;
    }
    const now = Date.now();
    for (const [id, expiry] of this.remoteSessionMuteUntil) {
      if (expiry <= now) this.remoteSessionMuteUntil.delete(id);
    }
    if (until > now) this.remoteSessionMuteUntil.set(clientId, until);
    else this.remoteSessionMuteUntil.delete(clientId);
  }

  /** This machine's own mute: its screen, its speakers. */
  isSessionMuted(): boolean {
    return Date.now() < this.sessionMuteUntil;
  }

  /**
   * The mute that governs a notification for `ownerId`: the owning Shell's for
   * a remote view, this machine's otherwise.
   */
  private isSessionMutedFor(ownerId: NotificationOwnerId | undefined): boolean {
    if (!isRemoteNotificationOwner(ownerId)) return this.isSessionMuted();
    if (this.remoteSessionMuteUntil.size === 0) return false;
    const clientId = this.shellClientOf(ownerId);
    if (clientId === undefined) return false;
    return Date.now() < (this.remoteSessionMuteUntil.get(clientId) ?? 0);
  }

  /** A Shell's alert choices, which decide what this host sends that Shell's views. */
  setShellPolicy(clientId: string, policy: ShellNotificationPolicy): void {
    this.shellPolicies.set(clientId, { ...policy });
  }

  /** Whether a Shell sent its own alert choices, rather than leaving them to this host's settings. */
  hasShellPolicy(clientId: string): boolean {
    return this.shellPolicies.has(clientId);
  }

  private shellClientOf(ownerId: NotificationOwnerId | undefined): string | undefined {
    if (!isRemoteNotificationOwner(ownerId)) return undefined;
    return getEndpointRegistry().getByHandle(ownerId)?.clientId;
  }

  /**
   * The project an agent belongs to, whose overrides decide its alerts
   * (#15635): its live terminal's, else the last one that terminal named,
   * else the one whose save last listed its panel. `null` when none knows,
   * and then the globals decide alone, never the overrides of whichever
   * project is current.
   */
  private projectOf(terminalId: string | undefined): string | null {
    if (!terminalId) return null;
    const live = getPtyClient()?.getTerminalProjectId(terminalId);
    if (live) {
      this.projectByTerminal.set(terminalId, live);
      return live;
    }
    return this.projectByTerminal.get(terminalId) ?? this.panels.workspaceOf(terminalId) ?? null;
  }

  /**
   * The settings that decide a notification about an agent of `projectId`
   * for `ownerId`. A remote view's Shell chooses which events alert it and
   * when (#14701): its choices stand in for this host's global ones, the
   * agent's project's own overrides still apply over them, and its quiet
   * hours are left to it, since they follow its own clock. This machine's
   * windows, and a Shell that never sent its choices, go by this host's own.
   */
  private settingsFor(
    ownerId: NotificationOwnerId | undefined,
    projectId: string | null
  ): NotificationSettings {
    const clientId = this.shellClientOf(ownerId);
    const policy = clientId === undefined ? undefined : this.shellPolicies.get(clientId);
    if (!policy) return projectStore.getEffectiveNotificationSettings(projectId);
    return {
      ...projectStore.getEffectiveNotificationSettings(projectId, policy),
      quietHoursEnabled: false,
    };
  }

  /** The machine a notification is decided for: this one, or one Shell. */
  private recipientOf(ownerId: NotificationOwnerId | undefined): string {
    if (!isRemoteNotificationOwner(ownerId)) return "local";
    return `shell:${this.shellClientOf(ownerId) ?? ownerId}`;
  }

  /**
   * A burst split by the machine each item goes to and the project its agent
   * belongs to, in arrival order: grouped under another machine's view, an
   * item would be shown, or held back, by that machine's choices and never
   * reach its own, and grouped under another project's agent it would sound
   * and navigate by that project's.
   */
  private byDestination<T extends { projectId: string | null }>(
    items: readonly T[],
    ownerOf: (item: T) => NotificationOwnerId | undefined
  ): T[][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const key = `${this.recipientOf(ownerOf(item))}\0${item.projectId ?? ""}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    return [...groups.values()];
  }

  initialize(): void {
    // Idempotent — repeat calls are a no-op so a deferred-task race during
    // window close + reopen can't double-subscribe event listeners.
    if (this.unsubscribers.length > 0) return;

    this.initializedAt = Date.now();

    const unsubPersisted = projectStore.onProjectStatePersisted((workspaceId, state) =>
      this.panels.noteSaved(workspaceId, state)
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
      // Its project's overrides, read now, are in by its first transition.
      if (payload.terminalId) this.loadPanelProject(payload.terminalId);
      const settings = projectStore.getEffectiveNotificationSettings(
        this.projectOf(payload.terminalId)
      );
      // isInformationalAudioSuppressed covers quiet hours, session mute, and
      // OS DND — the same chain the sound and the all-clear flash use.
      // Boot grace is a separate, spawn-specific condition (avoids a flood
      // of sounds when many terminals restore at once) that chain doesn't
      // cover, so it stays a standalone check.
      if (
        shouldPlayUiFeedbackSound(settings) &&
        !this.isWithinBootGrace() &&
        !this.isInformationalAudioSuppressed(settings)
      ) {
        soundService.play("agent-spawned");
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
      this.loadPanelProject(payload.terminalId);
    });

    // Prune spawn-grace tracking when an agent exits — otherwise an agent that
    // goes spawn→working→completed without ever hitting "waiting" leaks its
    // timestamp entry (the lazy delete only fires on a "waiting" lookup).
    const unsubExited = events.on("agent:exited", (payload) => {
      if (payload.terminalId) {
        this.agentSpawnTimestamps.delete(payload.terminalId);
        this.activeTerminalIds.delete(payload.terminalId);
        this.activeSeedTouched?.add(payload.terminalId);
        // Bound the routing hint's lifetime to the agent's. A re-watch of the
        // same panel repopulates it; notifications already in flight captured
        // their owner when the event fired.
        this.forgetPanelOwnership(payload.terminalId);
        this.dismissWaitingAlerts(payload.terminalId);
      }
    });

    // A killed terminal never emits agent:exited (TerminalExitHandler suppresses
    // it for `wasKilled`), so without this the routing hint for every killed
    // agent would sit in the map for the rest of the session.
    const unsubKilled = events.on("agent:killed", (payload) => {
      if (payload.terminalId) {
        this.agentSpawnTimestamps.delete(payload.terminalId);
        this.activeTerminalIds.delete(payload.terminalId);
        this.activeSeedTouched?.add(payload.terminalId);
        this.forgetPanelOwnership(payload.terminalId);
        this.projectByTerminal.delete(payload.terminalId);
        this.dismissWaitingAlerts(payload.terminalId);
      }
    });

    this.unsubscribers.push(
      unsubPersisted,
      unsubStateChanged,
      unsubSpawned,
      unsubDetected,
      unsubExited,
      unsubKilled
    );

    this.seedActiveAgents();
  }

  /**
   * Agents already working when this service starts: their transitions came
   * before it was listening, and without them a fleet finishing around one
   * would sound the all-clear early. Asked of the PTY host, which knows what is
   * running now. Anything an event spoke for since the question went out is
   * newer than the answer.
   */
  private seedActiveAgents(): void {
    const ptyClient = getPtyClient();
    if (!ptyClient) return;
    const touched = new Set<string>();
    this.activeSeedTouched = touched;
    void ptyClient.getAllTerminalsWithCompletenessAsync().then(
      ({ terminals, degraded }) => {
        if (this.activeSeedTouched !== touched) return;
        this.activeSeedTouched = null;
        let seeded = false;
        for (const terminal of terminals) {
          if (isHostThrowawayTerminalId(terminal.id)) continue;
          // Read each live terminal's project now, while the host still names
          // it: a natural exit drops that attribution before its last event.
          const projectId = ptyClient.getTerminalProjectId(terminal.id) ?? terminal.projectId;
          if (projectId) this.loadProject(projectId);
          if (touched.has(terminal.id) || terminal.isExited) continue;
          // An agent running since before this service: its next transition
          // may be a natural exit, by which time only this answer names its project.
          if (projectId && terminal.agentState && terminal.agentState !== "exited") {
            this.projectByTerminal.set(terminal.id, projectId);
          }
          if (terminal.agentState && ACTIVE_AGENT_STATES.has(terminal.agentState)) {
            this.activeTerminalIds.add(terminal.id);
            seeded = true;
          }
        }
        if (seeded) {
          this.hasEverGoneWorking = true;
          this.peakConcurrentWorking = Math.max(
            this.peakConcurrentWorking,
            this.activeTerminalIds.size
          );
        }
        // A host that didn't fully answer can't vouch that nothing is working.
        this.settleAllClearForSeed(!degraded);
      },
      () => {
        if (this.activeSeedTouched !== touched) return;
        this.activeSeedTouched = null;
        this.settleAllClearForSeed(false);
      }
    );
  }

  private settleAllClearForSeed(seedIsComplete: boolean): void {
    const held = this.allClearHeldForSeed;
    this.allClearHeldForSeed = false;
    if (seedIsComplete) {
      if (held && this.activeTerminalIds.size === 0) this.fireAllClear();
      return;
    }
    // A host that didn't fully answer can't vouch that nothing is working, so
    // an all-clear already in the making is abandoned, along with the session
    // it closed when nothing is left working to carry it on.
    if (this.allClearTimer) {
      clearTimeout(this.allClearTimer);
      this.allClearTimer = null;
    }
    if (this.activeTerminalIds.size === 0) {
      this.peakConcurrentWorking = 0;
      this.hasEverGoneWorking = false;
    }
  }

  private readSavedPanels = (projectId: string) => projectStore.getProjectState(projectId);

  /** Read once the project a terminal belongs to, if nothing has reached it yet. */
  private loadPanelProject(terminalId: string): void {
    const projectId = getPtyClient()?.getTerminalProjectId(terminalId);
    if (projectId) this.loadProject(projectId);
  }

  /**
   * A project's saved panels, and its alert overrides, which on a cold cache
   * would leave the globals deciding for its agents. Asked on every sighting,
   * one read at a time: the store answers at once while it holds them, and
   * reads again once something has dropped them.
   */
  private loadProject(projectId: string): void {
    this.panels.load(projectId, this.readSavedPanels);
    if (this.overridesLoading.has(projectId)) return;
    this.overridesLoading.add(projectId);
    const done = () => this.overridesLoading.delete(projectId);
    projectStore.loadNotificationOverrides(projectId).then(done, done);
  }

  /** Where a panel is now, by its saved record; what the event said only when there is none. */
  private worktreeOf(terminalId: string | undefined, reported?: string): string | undefined {
    const panel = this.panels.get(terminalId);
    return panel ? panel.worktreeId : reported;
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
    // The agent's own project decides its alerts (#15635), frozen now for
    // every timer this event starts.
    const projectId = this.projectOf(terminalId);
    // An agent's last transition: nothing later needs its terminal's project.
    if (state === "exited" && terminalId) this.projectByTerminal.delete(terminalId);
    this.checkAllClear(state, previousState, terminalId, projectId);
    if (state === previousState) return;
    if (terminalId) this.loadPanelProject(terminalId);

    // Capture the owner now: the renderer unwatches one-shot on this very
    // transition, so the live index is empty by the time a notification
    // fires. Whichever machine it belongs to decides what it may raise.
    const ownerWebContentsId = this.resolveOwner(terminalId);
    const settings = this.settingsFor(ownerWebContentsId, projectId);
    // Backend no longer emits worktreeId on agent events (#5139): the panel's
    // saved record says where it is.
    const worktreeId = this.worktreeOf(terminalId, payload.worktreeId);

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
      this.announcedWaitingIds.delete(terminalId);
      this.clearWaitingEscalation(terminalId);
      notificationService.closeNotificationsForPanel(terminalId);
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
      this.dropBufferedWaiting(terminalId);
    }

    // Back at work: a buffered ask is answered, and the next one is new.
    if (ACTIVE_AGENT_STATES.has(state) && !ACTIVE_AGENT_STATES.has(previousState) && terminalId) {
      this.canopyAnnouncedIds.delete(terminalId);
      this.canopyAskBuffer = this.canopyAskBuffer.filter((ask) => ask.terminalId !== terminalId);
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
        projectId,
        settings,
        agentId,
        coerceWaitingReason(payload.waitingReason)
      );
    }

    // Schedule working pulse for watched/docked agents entering working state
    if (state === "working" && previousState !== "working" && terminalId) {
      this.scheduleWorkingPulse(terminalId, projectId, settings);
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

    if ((state === "completed" || state === "exited") && settings.completedEnabled) {
      this.scheduleCompletionNotification(key, projectId, {
        worktreeId,
        terminalId,
        agentId,
        ownerWebContentsId,
      });
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
        projectId,
      });
      if (this.waitingBurstTimer === null) {
        this.waitingBurstTimer = setTimeout(() => this.flushWaitingBurst(), BURST_WINDOW_MS);
      }
    }
  }

  /**
   * The count is the agents events (and the startup seed) say are active now,
   * never the legacy `appState.terminals`: an entry there still marked active
   * from an old session would hold the all-clear back for good.
   */
  private checkAllClear(
    state: string,
    previousState: string,
    terminalId: string | undefined,
    projectId: string | null
  ): void {
    const wasActive = ACTIVE_AGENT_STATES.has(previousState);
    const isActive = ACTIVE_AGENT_STATES.has(state);

    if (terminalId) {
      this.activeSeedTouched?.add(terminalId);
      if (isActive) this.activeTerminalIds.add(terminalId);
      else this.activeTerminalIds.delete(terminalId);
    }

    const activeCount = this.activeTerminalIds.size;

    // Track when agents start working
    if (!wasActive && isActive) {
      this.hasEverGoneWorking = true;
      this.peakConcurrentWorking = Math.max(this.peakConcurrentWorking, activeCount);

      // Cancel any pending all-clear — a new agent just started
      if (this.allClearTimer) {
        clearTimeout(this.allClearTimer);
        this.allClearTimer = null;
      }
      this.allClearHeldForSeed = false;
      return;
    }

    // Only consider transitions OUT of active states
    if (!wasActive || isActive) return;

    // All conditions must hold to schedule the all-clear
    if (!this.hasEverGoneWorking || this.peakConcurrentWorking < 2 || activeCount > 0) return;

    // Cancel any existing timer (rapid succession of completions), and any
    // all-clear held for the seed: this timer decides afresh.
    if (this.allClearTimer) {
      clearTimeout(this.allClearTimer);
    }
    this.allClearHeldForSeed = false;
    this.allClearProjectId = projectId;

    this.allClearTimer = setTimeout(() => {
      this.allClearTimer = null;

      // Re-check after debounce — an agent may have started during the window
      if (this.activeTerminalIds.size > 0) return;
      // An agent working since before startup isn't counted until the seed
      // answers, so the all-clear waits for it.
      if (this.activeSeedTouched) {
        this.allClearHeldForSeed = true;
        return;
      }
      this.fireAllClear();
    }, ALL_CLEAR_DEBOUNCE_MS);
  }

  private fireAllClear(): void {
    // Fire the all-clear. The event itself is unconditional — it drives
    // renderer state (the all-clear overlay), which must still settle even
    // when silent — but it carries a `shouldFlash` verdict computed here,
    // from the single freshest copy of settings, rather than leaving each
    // renderer to recompute it from its own (possibly stale, per-view)
    // settings mirror: a second project view left open across a settings
    // change would otherwise flash on stale eligibility.
    const settings = projectStore.getEffectiveNotificationSettings(this.allClearProjectId);
    const isSuppressed = this.isInformationalAudioSuppressed(settings);
    if (settings.enabled !== false && settings.soundEnabled && !isSuppressed) {
      soundService.play("all-clear");
    }
    const shouldFlash = settings.enabled !== false && settings.flashEnabled && !isSuppressed;
    events.emit("agent:all-clear", { timestamp: Date.now(), shouldFlash });

    // Reset for next multi-agent session
    this.peakConcurrentWorking = 0;
    this.hasEverGoneWorking = false;
    this.allClearProjectId = null;
  }

  private scheduleCompletionNotification(
    key: string,
    projectId: string | null,
    target: {
      worktreeId?: string;
      terminalId?: string;
      agentId?: string;
      ownerWebContentsId?: NotificationOwnerId;
    }
  ): void {
    if (this.completionTimers.has(key)) {
      clearTimeout(this.completionTimers.get(key)!);
    }

    const { worktreeId, terminalId, agentId, ownerWebContentsId } = target;
    const timer = setTimeout(() => {
      this.completionTimers.delete(key);
      const settings = this.settingsFor(this.emitOwner(terminalId, ownerWebContentsId), projectId);
      if (settings.enabled === false || !settings.completedEnabled) return;
      const label = this.getLabel(agentId, this.panels.get(terminalId));
      this.completionBurstBuffer.push({
        title: "Agent finished",
        body: `${label} finished its task`,
        worktreeId,
        terminalId,
        agentId,
        triggerSound: settings.soundEnabled,
        soundFile: settings.completedSoundFile,
        ownerWebContentsId,
        projectId,
        category: "completed",
      });
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
    // Someone at the desk looking at the worktree already sees the agent
    // waiting. Every part of that has to be proven — the owning view showing
    // in a focused window, that worktree selected, the user present — and
    // anything unresolved, including unknown presence, still pages. Presence
    // is read at most once per flush. The worktree is where the panel is now,
    // not where it was when the wait began.
    let presence: UserPresence | undefined;
    const current = Array.from(dedupedByKey.values(), (item) => ({
      ...item,
      worktreeId: this.worktreeOf(item.terminalId, item.worktreeId),
    }));
    const dedupedItems = current.filter((item) => {
      // A pane that went back to work inside the burst window has nothing to
      // announce. Checked here rather than purged on the transition, so a
      // quick waiting → working → waiting flap still delivers once the
      // renderer's one-shot unwatch has stopped a second entry being buffered.
      if (item.terminalId && !this.waitingTerminalIds.has(item.terminalId)) return false;
      // Canopy already paged for this wait.
      if (item.terminalId && this.canopyAnnouncedIds.has(item.terminalId)) return false;
      // The view it goes to now may be another machine's, with its own choices.
      const owner = this.emitOwner(item.terminalId, item.ownerWebContentsId);
      const settings = this.settingsFor(owner, item.projectId);
      if (settings.enabled === false || !settings.waitingEnabled) return false;
      if (!item.worktreeId) return true;
      if (!this.isWorktreeInFront(owner, item.worktreeId)) return true;
      presence ??= notificationService.getUserPresence();
      return presence !== "present";
    });
    for (const group of this.byDestination(dedupedItems, (item) =>
      this.emitOwner(item.terminalId, item.ownerWebContentsId)
    )) {
      this.announceWaiting(group);
    }
  }

  /**
   * Whether a focused view is showing this worktree: the view that owns the
   * panel, by its own selection. For a panel with no known owner, any focused
   * view that has the worktree selected, since that is the view in front of
   * the user. Worktree ids are absolute paths, so a match is that worktree.
   */
  private isWorktreeInFront(owner: NotificationOwnerId | undefined, worktreeId: string): boolean {
    if (owner !== undefined) {
      return (
        this.selectedWorktreeByOwner.get(owner) === worktreeId &&
        notificationService.isOwnerViewFocused(owner)
      );
    }
    for (const [viewId, selected] of this.selectedWorktreeByOwner) {
      if (selected === worktreeId && notificationService.isOwnerViewFocused(viewId)) return true;
    }
    return false;
  }

  private announceWaiting(dedupedItems: BurstWaitingEntry[]): void {
    const first = dedupedItems[0];
    const closeWithPanels = dedupedItems.flatMap((item) =>
      item.terminalId ? [item.terminalId] : []
    );
    for (const id of closeWithPanels) this.announcedWaitingIds.add(id);

    const ownerWebContentsId = this.emitOwner(first.terminalId, first.ownerWebContentsId);
    // A remote view's Shell plays its own sound for the category.
    if (!isRemoteNotificationOwner(ownerWebContentsId)) {
      this.playNotificationSound(first.soundEnabled, first.soundFile);
    }

    if (dedupedItems.length === 1) {
      const label = this.getLabel(first.agentId, this.panels.get(first.terminalId));
      const context = this.makeContext(first.terminalId, first.agentId, first.worktreeId);
      notificationService.showWatchNotification(
        "Agent waiting",
        describeWaiting(label, first.waitingReason),
        context,
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        { silent: true, ownerWebContentsId, closeWithPanels, category: "waiting" }
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
        { silent: true, ownerWebContentsId, closeWithPanels, category: "waiting" }
      );
    }
  }

  private flushCompletionBurst(): void {
    this.completionBurstTimer = null;
    const items = this.completionBurstBuffer.splice(0);

    for (const group of this.byDestination(items, (item) =>
      this.emitOwner(item.terminalId, item.ownerWebContentsId)
    )) {
      if (group.length === 1) {
        this.enqueue(group[0]);
        continue;
      }
      const first = group[0];
      this.enqueue({
        title: "Agents finished",
        body: `${group.length} agents finished their tasks`,
        worktreeId: first.worktreeId,
        terminalId: first.terminalId,
        agentId: first.agentId,
        triggerSound: first.triggerSound,
        soundFile: first.soundFile,
        ownerWebContentsId: first.ownerWebContentsId,
        projectId: first.projectId,
        category: first.category,
      });
    }
  }

  private scheduleWaitingEscalation(
    terminalId: string,
    projectId: string | null,
    settings: NotificationSettings,
    agentId?: string,
    waitingReason?: WaitingReason
  ): void {
    if (this.waitingEscalationTimers.has(terminalId)) {
      clearTimeout(this.waitingEscalationTimers.get(terminalId)!);
    }

    if (!settings.waitingEscalationEnabled || !settings.waitingEnabled) return;

    // Only docked panels escalate, judged when the timer fires: a panel docked
    // during the wait counts, and one moved out of the dock or closed doesn't.
    const timer = setTimeout(() => {
      this.waitingEscalationTimers.delete(terminalId);
      const ownerWebContentsId = this.resolveOwner(terminalId);
      const currentSettings = this.settingsFor(ownerWebContentsId, projectId);
      if (currentSettings.enabled === false) return;
      if (!currentSettings.waitingEscalationEnabled || !currentSettings.waitingEnabled) return;

      const panel = this.panels.get(terminalId);
      if (panel?.location !== "dock") return;

      // Count the dock terminals currently waiting for the same machine and
      // project (for grouped escalation): another machine's, or another
      // project's, keep their own reminders, on their own delay and choices.
      const recipient = this.recipientOf(ownerWebContentsId);
      const waitingDockTerminalIds = [...this.waitingTerminalIds].filter(
        (id) =>
          this.panels.get(id)?.location === "dock" &&
          this.recipientOf(this.resolveOwner(id)) === recipient &&
          this.projectOf(id) === projectId
      );

      if (!isRemoteNotificationOwner(ownerWebContentsId)) {
        this.playNotificationSound(
          currentSettings.soundEnabled,
          currentSettings.escalationSoundFile
        );
      }

      // Escalation is the most urgent notification and was the only one with no
      // click handler at all, so it could never navigate anywhere. Attach panel
      // context and resolve the owner now rather than at schedule time: minutes
      // have passed, and the renderer that watched this panel may have been
      // destroyed since. A docked terminal that was never watched has no known
      // owner — the click then falls back to the primary window, which is
      // explicit and no worse than today's dead click.
      // The context takes the worktree from the panel as it is NOW, not as it
      // was when the timer was armed: a panel dragged to another worktree during
      // the wait would otherwise navigate to the worktree it used to live in.
      const navigation = {
        channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        context: this.makeContext(terminalId, agentId),
      };

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
          {
            ownerWebContentsId,
            navigation,
            closeWithPanels: waitingDockTerminalIds,
            category: "escalation",
          }
        );
      } else {
        const label = this.getLabel(agentId, panel);
        // Reason captured at the waiting transition — repeated waiting events
        // while already waiting don't reschedule this timer, so the closure
        // value is the reason for this wait episode. The duration-flavored
        // fallback stays for the weak `prompt` classification.
        const reason = actionableWaitingReason(waitingReason);
        notificationService.showNativeNotification(
          "Agent still waiting",
          reason ? describeWaiting(label, reason) : `${label} has been waiting for input`,
          { ownerWebContentsId, navigation, closeWithPanels: [terminalId], category: "escalation" }
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

  /**
   * Canopy's classifier read an agent asking the user something on its screen.
   * Canopy is turned on by the user to be told exactly this, so it pages
   * without the per-panel watch the waiting banner needs — including for a
   * prompt Daintree's own state never saw. It stays quiet with notifications
   * off, in the grace after boot or spawn, when Daintree's banner already went
   * out for this wait, while Canopy is open in front of the user, and when
   * the user is looking at the agent's worktree.
   */
  notifyCanopyAsk(ask: CanopyAskNotice, canopyOpenIn: () => readonly NotificationOwnerId[]): void {
    const projectId = this.projectOf(ask.terminalId);
    if (this.settingsFor(this.resolveOwner(ask.terminalId), projectId).enabled === false) return;
    if (this.isWithinBootGrace() || this.isWithinSpawnGrace(ask.agentId, ask.terminalId)) return;
    if (this.announcedWaitingIds.has(ask.terminalId)) return;
    if (this.isCanopyInFront(canopyOpenIn)) return;
    this.loadPanelProject(ask.terminalId);
    this.canopyAskBuffer = this.canopyAskBuffer.filter(
      (entry) => entry.terminalId !== ask.terminalId
    );
    this.canopyAskBuffer.push({ ...ask, canopyOpenIn, projectId });
    this.canopyAskTimer ??= setTimeout(() => this.flushCanopyAsks(), BURST_WINDOW_MS);
  }

  /** A panel listing the ask is open in a focused view: the user is looking at it already. */
  private isCanopyInFront(canopyOpenIn: () => readonly NotificationOwnerId[]): boolean {
    return canopyOpenIn().some((owner) => notificationService.isOwnerViewFocused(owner));
  }

  private flushCanopyAsks(): void {
    this.canopyAskTimer = null;
    let presence: UserPresence | undefined;
    // The fleet row's worktree is the one the terminal launched in; the saved
    // panel says where it is now.
    const current = this.canopyAskBuffer.splice(0).map((ask) => ({
      ...ask,
      worktreeId: this.worktreeOf(ask.terminalId, ask.worktreeId),
    }));
    const asks = current.filter((ask) => {
      const owner = this.resolveOwner(ask.terminalId);
      if (this.settingsFor(owner, ask.projectId).enabled === false) return false;
      if (this.announcedWaitingIds.has(ask.terminalId)) return false;
      // Each ask by the panels that list it, read again now the burst is out.
      if (this.isCanopyInFront(ask.canopyOpenIn)) return false;
      if (!ask.worktreeId) return true;
      if (!this.isWorktreeInFront(owner, ask.worktreeId)) return true;
      presence ??= notificationService.getUserPresence();
      return presence !== "present";
    });
    for (const ask of asks) this.canopyAnnouncedIds.add(ask.terminalId);
    for (const group of this.byDestination(asks, (ask) => this.resolveOwner(ask.terminalId))) {
      this.announceCanopyAsks(group);
    }
  }

  private announceCanopyAsks(asks: Array<CanopyAskNotice & { projectId: string | null }>): void {
    const first = asks[0];
    const ownerWebContentsId = this.resolveOwner(first.terminalId);
    // A remote view's Shell plays its own sound for the category.
    if (!isRemoteNotificationOwner(ownerWebContentsId)) {
      const settings = projectStore.getEffectiveNotificationSettings(first.projectId);
      this.playNotificationSound(settings.soundEnabled, settings.waitingSoundFile);
    }
    const navigation = {
      channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      context: this.makeContext(first.terminalId, first.agentId, first.worktreeId),
    };
    const options = {
      ownerWebContentsId,
      navigation,
      closeWithPanels: asks.map((ask) => ask.terminalId),
      category: "waiting" as const,
    };
    if (asks.length === 1) {
      notificationService.showNativeNotification(
        "Agent waiting",
        describeWaiting(
          this.getLabel(first.agentId, this.panels.get(first.terminalId)),
          first.kind
        ),
        options
      );
      return;
    }
    const uniform = asks.every((ask) => ask.kind === first.kind) ? first.kind : undefined;
    notificationService.showNativeNotification(
      "Agents waiting",
      describeWaitingMany(asks.length, uniform),
      options
    );
  }

  acknowledgeWaiting(terminalId: string): void {
    this.dismissWaitingAlerts(terminalId);
  }

  /**
   * The pane has been dealt with: cancel its reminder, drop any banner still in
   * the burst window and take down the ones already delivered. Grouped banners only go once
   * every pane they name has been dealt with.
   */
  private dismissWaitingAlerts(terminalId: string): void {
    // Out of the escalation group too, or a sibling's grouped reminder would
    // name this pane again. Its next waiting transition puts it back.
    this.waitingTerminalIds.delete(terminalId);
    this.announcedWaitingIds.delete(terminalId);
    this.canopyAnnouncedIds.delete(terminalId);
    this.clearWaitingEscalation(terminalId);
    this.dropBufferedWaiting(terminalId);
    this.canopyAskBuffer = this.canopyAskBuffer.filter((ask) => ask.terminalId !== terminalId);
    notificationService.closeNotificationsForPanel(terminalId);
  }

  private dropBufferedWaiting(terminalId: string): void {
    this.waitingBurstBuffer = this.waitingBurstBuffer.filter(
      (entry) => entry.terminalId !== terminalId
    );
    // Other terminals' entries keep the running timer; only an emptied buffer
    // cancels it.
    if (this.waitingBurstBuffer.length === 0 && this.waitingBurstTimer !== null) {
      clearTimeout(this.waitingBurstTimer);
      this.waitingBurstTimer = null;
    }
  }

  acknowledgeWorkingPulse(terminalId: string): void {
    this.clearWorkingPulse(terminalId);
  }

  private scheduleWorkingPulse(
    terminalId: string,
    projectId: string | null,
    settings: NotificationSettings
  ): void {
    this.clearWorkingPulse(terminalId);

    if (!settings.workingPulseEnabled || !settings.soundEnabled) return;

    // Eligibility: watched, or docked with escalation enabled. The dock is
    // judged on every tick, so a panel moved into or out of it while it works
    // pulses by where it is now.
    const isWatched = this.isWatched(terminalId);
    if (!isWatched && !settings.waitingEscalationEnabled) return;

    const delayTimer = setTimeout(() => {
      this.workingPulseDelayTimers.delete(terminalId);
      this.startPulseInterval(terminalId, projectId, isWatched);
    }, WORKING_PULSE_INITIAL_DELAY_MS);

    this.workingPulseDelayTimers.set(terminalId, delayTimer);
  }

  private startPulseInterval(
    terminalId: string,
    projectId: string | null,
    isWatched: boolean
  ): void {
    const tick = () => {
      // The agent's own project's choices on every beat: a switch to another
      // project changes nothing about this one's pulse.
      const currentSettings = projectStore.getEffectiveNotificationSettings(projectId);
      if (!currentSettings.workingPulseEnabled || !currentSettings.soundEnabled) {
        this.clearWorkingPulse(terminalId);
        return;
      }
      const eligible =
        isWatched ||
        (currentSettings.waitingEscalationEnabled &&
          this.panels.get(terminalId)?.location === "dock");
      // Skip this tick's sound but keep the loop alive so pulses resume
      // automatically once the suppression lifts or the panel is docked again.
      if (
        !eligible ||
        this.isInformationalAudioSuppressed(currentSettings) ||
        isRemoteNotificationOwner(this.resolveOwner(terminalId))
      ) {
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

  /**
   * Whether a non-urgent audio cue should stay silent right now: scheduled
   * quiet hours, an active session mute, or OS-level Do-Not-Disturb / Focus.
   * An `undefined` OS state (Windows/Linux, where no detection exists) means
   * "do not gate" — only an explicit `true` suppresses.
   *
   * Audio only. OS DND must never suppress a native notification — the OS
   * already silences its own banners — so `drainQueue` keeps its own gate.
   */
  private isInformationalAudioSuppressed(settings: NotificationSettings): boolean {
    return (
      isScheduledQuietNow(settings) ||
      this.isSessionMuted() ||
      getOsDndService().getState() === true
    );
  }

  private enqueue(notification: PendingNotification): void {
    this.notificationQueue.push(notification);

    if (!this.staggerTimer) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    const item = this.notificationQueue.shift();
    if (!item) return;

    const ownerWebContentsId = this.emitOwner(item.terminalId, item.ownerWebContentsId);
    const settings = this.settingsFor(ownerWebContentsId, item.projectId);

    // Quiet hours schedule and renderer-driven session mute both suppress
    // completion/pulse alerts but not waiting alerts — waiting agents block
    // user work and should page through. Each gate is the owning machine's:
    // notifications off there hold back only its own, and a Shell applies
    // its quiet hours itself as they arrive.
    if (
      settings.enabled === false ||
      isScheduledQuietNow(settings) ||
      this.isSessionMutedFor(ownerWebContentsId)
    ) {
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

    if (item.soundFile && !isRemoteNotificationOwner(ownerWebContentsId)) {
      this.playNotificationSound(item.triggerSound, item.soundFile);
    }

    const context = this.makeContext(item.terminalId, item.agentId, item.worktreeId);
    notificationService.showWatchNotification(
      item.title,
      item.body,
      context,
      CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      { silent: true, ownerWebContentsId, category: item.category }
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

  /**
   * The subject a banner names (#15233): the pane's own title when someone
   * named it, else the agent's display name, else plain "Agent". Never an id:
   * an agent id is a slug, and a worktree id is an absolute path.
   */
  private getLabel(agentId: string | undefined, terminal?: PanelRecord): string {
    const title = terminal?.title?.trim();
    if (title && (terminal?.titleMode === "user" || terminal?.titleMode === "custom")) {
      return title;
    }
    return (agentId ? getEffectiveRegistry()[agentId]?.name?.trim() : undefined) || "Agent";
  }

  /** A banner's click target, with the panel's worktree and title as it is saved now. */
  private makeContext(
    terminalId?: string,
    agentId?: string,
    worktreeId?: string
  ): WatchNotificationContext {
    const panel = this.panels.get(terminalId);
    return {
      panelId: terminalId ?? agentId ?? "unknown",
      panelTitle: this.getLabel(agentId, panel),
      worktreeId: panel ? panel.worktreeId : worktreeId,
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
    this.allClearProjectId = null;

    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }

    if (this.waitingBurstTimer) {
      clearTimeout(this.waitingBurstTimer);
      this.waitingBurstTimer = null;
    }
    this.waitingBurstBuffer = [];

    if (this.canopyAskTimer) {
      clearTimeout(this.canopyAskTimer);
      this.canopyAskTimer = null;
    }
    this.canopyAskBuffer = [];
    this.announcedWaitingIds.clear();
    this.canopyAnnouncedIds.clear();

    if (this.completionBurstTimer) {
      clearTimeout(this.completionBurstTimer);
      this.completionBurstTimer = null;
    }
    this.completionBurstBuffer = [];

    this.waitingTerminalIds.clear();
    this.agentSpawnTimestamps.clear();
    this.watchedPanelsByOwner.clear();
    this.ownersByPanel.clear();
    this.lastOwnerByPanel.clear();
    this.selectedWorktreeByOwner.clear();
    this.panels.clear();
    this.overridesLoading.clear();
    this.projectByTerminal.clear();
    this.activeSeedTouched = null;
    this.allClearHeldForSeed = false;
    this.notificationQueue = [];
    this.hasEverGoneWorking = false;
    this.peakConcurrentWorking = 0;
    this.activeTerminalIds.clear();
    this.sessionMuteUntil = 0;
    this.remoteSessionMuteUntil.clear();
    this.shellPolicies.clear();

    soundService.cancel();
    soundService.cancelPulse();
  }
}

export const agentNotificationService = new AgentNotificationService();
