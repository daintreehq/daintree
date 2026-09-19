import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ActionErrorCode } from "../../../shared/types/actions.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
import type { TerminalSubmitGuard } from "../../../shared/types/pty-host.js";
import type { TerminalSubmissionRecord } from "../../../shared/types/terminalSubmission.js";
import {
  DEFAULT_WATCH_MAX_DELIVERIES,
  MAX_PENDING_WATCH_EVENTS,
  MAX_WATCHED_TERMINALS_PER_PANE,
  MAX_WATCHES_PER_PANE,
  MIN_WAKE_INTERVAL_MS,
  TERMINAL_WATCH_CONDITIONS,
  WAKE_COALESCE_MS,
  WAKE_SETTLE_GRACE_MS,
  type PaneWatchState,
  type TerminalCancelWatchResult,
  type TerminalGetWatchEventsArgs,
  type TerminalGetWatchEventsResult,
  type TerminalListWatchesResult,
  type TerminalWatchArgs,
  type TerminalWatchCondition,
  type TerminalWatchDelivery,
  type TerminalWatchDeliveryReason,
  type TerminalWatchEvent,
  type TerminalWatchResult,
  type TerminalWatchStopReason,
  TerminalCancelWatchArgsSchema,
  TerminalGetWatchEventsArgsSchema,
  TerminalListWatchesArgsSchema,
  TerminalWatchArgsSchema,
} from "../../../shared/types/terminalWatch.js";
import { evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";

/**
 * The caller's own pane, resolved from its credential and never from anything
 * it sent (#12491). `key` is the identity watches are held under: a pane
 * bearer's ownership principal, which survives reconnects, or the help
 * session id for a help lane.
 */
export interface OwnPane {
  key: string;
  terminalId: string;
}

// NUL-led so a pane principal and a help session id can never spell the same key.
export function paneWatchKey(principal: string): string {
  return `pane\u0000${principal}`;
}

export function helpWatchKey(helpSessionId: string): string {
  return `help\u0000${helpSessionId}`;
}

/** The slice of a pty-host terminal record the watch service reads. */
export interface WatchTerminalInfo {
  projectId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastTypedInputAt?: number;
  detectedAgentId?: string;
  hasPty?: boolean;
  isTrashed?: boolean;
  submission?: TerminalSubmissionRecord;
}

export interface TerminalWatchPtyClient {
  getTerminalAsync(id: string, submissionToken?: string): Promise<WatchTerminalInfo | null>;
  submit(
    id: string,
    text: string,
    submissionToken?: string,
    handbackCode?: string,
    guard?: TerminalSubmitGuard
  ): void;
  /** Take back a wake that has not reached its Enter; see `WriteQueue.withdrawGuardedSubmission`. */
  withdrawGuardedSubmission(id: string, submissionToken: string): void;
  on(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
  off(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
}

/** The fields of `agent:state-changed` a watch reports. */
export interface WatchStateChange {
  terminalId?: string;
  state: AgentState;
  previousState: AgentState;
  timestamp: number;
  trigger: string;
  confidence: number;
  waitingReason?: WaitingReason;
  lastHandback?: TerminalHandback;
}

export interface TerminalWatchServiceDeps {
  getPtyClient: () => TerminalWatchPtyClient | null;
  onStateChanged: (listener: (payload: WatchStateChange) => void) => () => void;
  onKilled: (listener: (terminalId: string) => void) => () => void;
  /**
   * A pane closed to the trash. Its PTY lives on for the undo window, but it
   * is closed as far as the user can see, so it is neither woken nor watched.
   */
  onTrashed: (listener: (terminalId: string) => void) => () => void;
  /** Whether the user has turned pane wakes on. Read on every decision. */
  isEnabled: () => boolean;
  /** Push a pane's chrome state to the views of its project. */
  publish: (projectId: string, state: PaneWatchState) => void;
  now?: () => number;
}

/** A refusal the session server returns as a tool error with this code. */
export class TerminalWatchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TerminalWatchError";
  }
}

export const WATCH_WAKE_DISABLED = "WATCH_WAKE_DISABLED";
export const WATCH_NOT_ELIGIBLE = "WATCH_NOT_ELIGIBLE";
export const WATCH_TARGET_UNAVAILABLE = "WATCH_TARGET_UNAVAILABLE";
export const WATCH_LIMIT_REACHED = "WATCH_LIMIT_REACHED";
export const WATCH_VALIDATION_ERROR = "VALIDATION_ERROR";

/**
 * The action-error code a watch refusal is audited under. The tool error the
 * caller receives keeps the precise code; `ActionErrorCode` is a public
 * contract and is not widened for one feature's refusals.
 */
export function auditCodeForWatchRefusal(code: string): ActionErrorCode {
  switch (code) {
    case WATCH_WAKE_DISABLED:
      return "DISABLED";
    case WATCH_NOT_ELIGIBLE:
      return "RESTRICTED";
    case WATCH_TARGET_UNAVAILABLE:
      return "NOT_FOUND";
    default:
      return "VALIDATION_ERROR";
  }
}

/**
 * How long a wake's outcome is followed after it is queued. Each step reads
 * the submission record once; anything short of `pty_written` by the last one
 * is a failure, never a retry.
 */
const DELIVERY_CONFIRM_DELAYS_MS = [500, 1_000, 1_500, 7_000, 20_000] as const;

/** Entries kept in each of the service's recency maps: exits, teardowns, wakes. */
const MAX_REMEMBERED_EXITS = 512;

/** The one line a wake submits. Fixed wording plus server-minted ids only. */
export function formatWakeLine(watchIds: readonly string[]): string {
  const noun = watchIds.length === 1 ? "watch" : "watches";
  return `Daintree: observations are available for ${noun} ${watchIds.join(", ")}. Read them with terminal.getWatchEvents.`;
}

interface Watch {
  id: string;
  terminalIds: Set<string>;
  conditions: ReadonlySet<TerminalWatchCondition>;
  maxDeliveries: number;
  deliveries: number;
  status: "active" | "stopped";
  stopReason?: TerminalWatchStopReason;
  createdAt: number;
}

interface HeldEvent {
  event: TerminalWatchEvent;
  /** Covered by a wake or already read, so it never causes another wake. */
  delivered: boolean;
}

interface DeliveryState {
  status: TerminalWatchDelivery["status"];
  reason?: TerminalWatchDeliveryReason;
  lastDeliveredAt?: number;
  /** The outstanding wake's submission token. */
  token?: string;
  /** The outstanding wake was seen written to the pty. */
  confirmed?: boolean;
  /** The pane finished a turn after the outstanding wake was queued. */
  settledSinceDelivery?: boolean;
}

interface PaneOwner {
  key: string;
  terminalId: string;
  projectId: string;
  watches: Map<string, Watch>;
  events: HeldEvent[];
  droppedEvents: number;
  nextSeq: number;
  delivery: DeliveryState;
  /**
   * The wake the host may still hold, and the watches it names, until its
   * outcome is known. Kept apart from `delivery`: a read acknowledges the wake
   * but says nothing about whether the host has finished with it.
   */
  inHost?: { token: string; watchIds: ReadonlySet<string> };
  timer?: ReturnType<typeof setTimeout>;
  timerDueAt?: number;
  attempting: boolean;
  disposed: boolean;
}

/**
 * Watches and the wakes they cause (#12491). One instance for the app, owned
 * by the MCP service; nothing here is persisted.
 *
 * Every event is matched by terminal id, never agent id: agent ids name the
 * agent type and collide across panes. A watched terminal that exits or is
 * closed is dropped from its watches for good, so an id reused by a new panel
 * is never followed into it.
 */
export class TerminalWatchService {
  private readonly ownersByKey = new Map<string, PaneOwner>();
  private readonly ownersByTerminal = new Map<string, PaneOwner>();
  /** Watched terminal → the panes watching it. */
  private readonly watchersByTarget = new Map<string, Set<PaneOwner>>();
  /** terminal id → exit epoch, for exits that land while a registration awaits. */
  private readonly exitEpochs = new Map<string, number>();
  /**
   * A user stop (by terminal) or a revocation (by key) → its epoch, so a
   * registration that was reading while its pane was torn down does not bring
   * the watches back.
   */
  private readonly teardownEpochs = new Map<string, number>();
  private globalTeardownEpoch = 0;
  private epoch = 0;
  private disposed = false;
  /**
   * Own terminal id → when it was last woken. Outlives the owner record, so
   * dropping the last watch and adding another cannot skip the interval.
   */
  private readonly lastWakeAt = new Map<string, number>();
  private revision = 0;
  /** Registrations between subscribing and recording their watch. */
  private pendingRegistrations = 0;
  private unsubscribers: Array<() => void> = [];
  private subscribedClient: TerminalWatchPtyClient | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TerminalWatchServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async register(pane: OwnPane, args: TerminalWatchArgs): Promise<TerminalWatchResult> {
    if (!this.deps.isEnabled()) throw disabledError();
    if (this.disposed) {
      throw new TerminalWatchError(WATCH_NOT_ELIGIBLE, "Terminal watches are shutting down.");
    }
    if (args.terminalIds.includes(pane.terminalId)) {
      throw new TerminalWatchError(WATCH_VALIDATION_ERROR, "A pane cannot watch its own terminal.");
    }
    const client = this.deps.getPtyClient();
    if (client === null) {
      throw new TerminalWatchError(WATCH_NOT_ELIGIBLE, "Terminals cannot be read right now.");
    }
    // Subscribed before anything is read, so an exit landing during the reads
    // below is recorded and caught by the epoch check after them.
    this.ensureSubscribed(client);
    const epochBefore = this.epoch;

    this.pendingRegistrations++;
    try {
      return await this.completeRegistration(pane, args, client, epochBefore);
    } finally {
      this.pendingRegistrations--;
      if (this.pendingRegistrations === 0 && this.ownersByKey.size === 0) this.unsubscribe();
    }
  }

  private async completeRegistration(
    pane: OwnPane,
    args: TerminalWatchArgs,
    client: TerminalWatchPtyClient,
    epochBefore: number
  ): Promise<TerminalWatchResult> {
    const [own, ...targets] = await Promise.all([
      client.getTerminalAsync(pane.terminalId).catch(() => null),
      ...args.terminalIds.map((id) => client.getTerminalAsync(id).catch(() => null)),
    ]);

    if (!this.deps.isEnabled()) throw disabledError();
    if (this.torndownSince(pane, epochBefore)) {
      throw new TerminalWatchError(
        WATCH_NOT_ELIGIBLE,
        "This pane's watches were stopped while this one was being set up."
      );
    }
    if (
      own === null ||
      own.hasPty === false ||
      own.isTrashed === true ||
      own.projectId === undefined ||
      this.exitedSince(pane.terminalId, epochBefore)
    ) {
      throw new TerminalWatchError(
        WATCH_NOT_ELIGIBLE,
        "This connection's own terminal is not running, so there is no pane to wake."
      );
    }
    const projectId = own.projectId;
    args.terminalIds.forEach((id, index) => {
      const target = targets[index];
      // One message for missing, exited, trashed and other-project ids:
      // watching must not become a way to learn which ids exist elsewhere.
      if (
        target === null ||
        target.hasPty === false ||
        target.isTrashed === true ||
        target.projectId !== projectId ||
        this.exitedSince(id, epochBefore)
      ) {
        throw new TerminalWatchError(
          WATCH_TARGET_UNAVAILABLE,
          `Terminal '${id}' is not a running terminal in this pane's project.`
        );
      }
    });

    // Limits are judged before an owner record exists, so a refusal leaves
    // nothing behind.
    const existing = this.existingOwner(pane);
    const heldWatches = existing === undefined ? [] : [...existing.watches.values()];
    if (heldWatches.length >= MAX_WATCHES_PER_PANE) {
      throw new TerminalWatchError(
        WATCH_LIMIT_REACHED,
        `This pane already holds ${MAX_WATCHES_PER_PANE} watches. Cancel one before adding another.`
      );
    }
    const distinct = new Set(args.terminalIds);
    for (const watch of heldWatches) {
      if (watch.status === "active") for (const id of watch.terminalIds) distinct.add(id);
    }
    if (distinct.size > MAX_WATCHED_TERMINALS_PER_PANE) {
      throw new TerminalWatchError(
        WATCH_LIMIT_REACHED,
        `A pane can watch at most ${MAX_WATCHED_TERMINALS_PER_PANE} distinct terminals across its watches.`
      );
    }

    const owner = this.ownerFor(pane, projectId);
    const conditions = args.conditions ?? [...TERMINAL_WATCH_CONDITIONS];
    const watch: Watch = {
      id: `w_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      terminalIds: new Set(args.terminalIds),
      conditions: new Set(conditions),
      maxDeliveries: args.maxDeliveries ?? DEFAULT_WATCH_MAX_DELIVERIES,
      deliveries: 0,
      status: "active",
      createdAt: this.now(),
    };
    owner.watches.set(watch.id, watch);
    for (const id of watch.terminalIds) this.addWatcher(id, owner);
    this.publish(owner);
    return {
      watchId: watch.id,
      terminalIds: [...watch.terminalIds],
      conditions: [...watch.conditions],
      maxDeliveries: watch.maxDeliveries,
    };
  }

  list(pane: OwnPane): TerminalListWatchesResult {
    const owner = this.existingOwner(pane);
    if (owner === undefined) {
      return { watches: [], pendingEvents: 0, delivery: { status: "idle" } };
    }
    return {
      watches: [...owner.watches.values()].map((watch) => ({
        watchId: watch.id,
        terminalIds: [...watch.terminalIds],
        conditions: [...watch.conditions],
        deliveries: watch.deliveries,
        maxDeliveries: watch.maxDeliveries,
        status: watch.status,
        ...(watch.stopReason !== undefined ? { stopReason: watch.stopReason } : {}),
        createdAt: watch.createdAt,
      })),
      pendingEvents: owner.events.length,
      delivery: publicDelivery(owner.delivery),
    };
  }

  /**
   * Read observations. Whatever is returned counts as seen, cleared or not, so
   * it can never cause a later wake; and a read acknowledges the outstanding
   * wake, which is what lets the next one go out. An empty read schedules
   * nothing.
   */
  readEvents(pane: OwnPane, args: TerminalGetWatchEventsArgs): TerminalGetWatchEventsResult {
    const owner = this.existingOwner(pane);
    if (owner === undefined) return { events: [], droppedEvents: 0, remainingEvents: 0 };
    const clear = args.clear !== false;
    const matches = (held: HeldEvent) =>
      args.watchId === undefined || held.event.watchId === args.watchId;
    const returned = owner.events.filter(matches);
    for (const held of returned) held.delivered = true;
    if (clear) owner.events = owner.events.filter((held) => !matches(held));
    const droppedEvents = owner.droppedEvents;
    owner.droppedEvents = 0;

    if (clear) {
      // A stopped watch whose last observations were just read has nothing
      // left to say.
      for (const watch of [...owner.watches.values()]) {
        if (watch.status !== "stopped") continue;
        if (owner.events.some((held) => held.event.watchId === watch.id)) continue;
        owner.watches.delete(watch.id);
      }
    }

    owner.delivery = {
      status: "idle",
      ...(owner.delivery.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: owner.delivery.lastDeliveredAt }
        : {}),
    };
    if (owner.watches.size === 0 && owner.events.length === 0) {
      this.disposeOwner(owner);
    } else {
      this.schedule(owner);
      this.publish(owner);
    }
    return {
      events: returned.map((held) => held.event),
      droppedEvents,
      remainingEvents: owner.events.length,
    };
  }

  cancel(pane: OwnPane, watchId: string): TerminalCancelWatchResult {
    const owner = this.existingOwner(pane);
    const watch = owner?.watches.get(watchId);
    if (owner === undefined || watch === undefined) return { watchId, cancelled: false };
    owner.watches.delete(watchId);
    owner.events = owner.events.filter((held) => held.event.watchId !== watchId);
    this.reindexTargets(owner);
    // A wake that names only cancelled watches points at nothing any more.
    const inHost = owner.inHost;
    if (inHost !== undefined && [...inHost.watchIds].every((id) => !owner.watches.has(id))) {
      this.withdraw(owner);
    }
    if (owner.watches.size === 0 && owner.events.length === 0) {
      this.disposeOwner(owner);
    } else {
      this.publish(owner);
    }
    return { watchId, cancelled: true };
  }

  /** The chrome state for a pane, or null when it holds no watches. */
  getPaneState(terminalId: string): PaneWatchState | null {
    const owner = this.ownersByTerminal.get(terminalId);
    return owner === undefined ? null : this.paneState(owner);
  }

  /** The user's "stop" on the pane: every watch the pane holds goes. */
  stopPane(terminalId: string): void {
    this.markTeardown(`terminal\u0000${terminalId}`);
    const owner = this.ownersByTerminal.get(terminalId);
    if (owner !== undefined) this.disposeOwner(owner);
  }

  /** A pane bearer was revoked: its watches go with its authority. */
  revokeOwner(key: string): void {
    this.markTeardown(`key\u0000${key}`);
    const owner = this.ownersByKey.get(key);
    if (owner !== undefined) this.disposeOwner(owner);
  }

  /** The setting was turned off, or the service is shutting down. */
  disposeAll(): void {
    this.globalTeardownEpoch = ++this.epoch;
    for (const owner of [...this.ownersByKey.values()]) this.disposeOwner(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
    this.unsubscribe();
  }

  private markTeardown(mark: string): void {
    // Never pruned under a registration still reading: evicting its pane's
    // mark would let it bring the watches back.
    remember(this.teardownEpochs, mark, ++this.epoch, this.pendingRegistrations === 0);
  }

  private torndownSince(pane: OwnPane, epoch: number): boolean {
    if (this.disposed || this.globalTeardownEpoch > epoch) return true;
    const byTerminal = this.teardownEpochs.get(`terminal\u0000${pane.terminalId}`);
    const byKey = this.teardownEpochs.get(`key\u0000${pane.key}`);
    return (byTerminal ?? 0) > epoch || (byKey ?? 0) > epoch;
  }

  /** Take back the wake the host may still hold, if any. */
  private withdraw(owner: PaneOwner): void {
    const inHost = owner.inHost;
    if (inHost === undefined) return;
    owner.inHost = undefined;
    try {
      this.deps.getPtyClient()?.withdrawGuardedSubmission(owner.terminalId, inHost.token);
    } catch (err) {
      console.error("[MCP] terminal watch: withdrawing a wake failed:", err);
    }
  }

  private existingOwner(pane: OwnPane): PaneOwner | undefined {
    const owner = this.ownersByKey.get(pane.key);
    return owner !== undefined && owner.terminalId === pane.terminalId ? owner : undefined;
  }

  /**
   * The pane's owner record, created on first registration. A record held
   * under the same key for another terminal, or for this terminal under
   * another key, is a previous incarnation and goes first.
   */
  private ownerFor(pane: OwnPane, projectId: string): PaneOwner {
    const existing = this.existingOwner(pane);
    if (existing !== undefined) return existing;
    const byKey = this.ownersByKey.get(pane.key);
    if (byKey !== undefined) this.disposeOwner(byKey);
    const byTerminal = this.ownersByTerminal.get(pane.terminalId);
    if (byTerminal !== undefined) this.disposeOwner(byTerminal);
    const owner: PaneOwner = {
      key: pane.key,
      terminalId: pane.terminalId,
      projectId,
      watches: new Map(),
      events: [],
      droppedEvents: 0,
      nextSeq: 1,
      delivery: { status: "idle" },
      attempting: false,
      disposed: false,
    };
    const lastWake = this.lastWakeAt.get(pane.terminalId);
    if (lastWake !== undefined && this.now() - lastWake < MIN_WAKE_INTERVAL_MS) {
      owner.delivery.lastDeliveredAt = lastWake;
    }
    this.ownersByKey.set(owner.key, owner);
    this.ownersByTerminal.set(owner.terminalId, owner);
    return owner;
  }

  private disposeOwner(owner: PaneOwner): void {
    if (owner.disposed) return;
    owner.disposed = true;
    // A wake still in the host's lane is taken back, so stopping or disabling
    // means nothing more is typed. One already written cannot be recalled.
    this.withdraw(owner);
    if (owner.timer !== undefined) clearTimeout(owner.timer);
    owner.timer = undefined;
    if (this.ownersByKey.get(owner.key) === owner) this.ownersByKey.delete(owner.key);
    if (this.ownersByTerminal.get(owner.terminalId) === owner) {
      this.ownersByTerminal.delete(owner.terminalId);
    }
    for (const [target, watchers] of this.watchersByTarget) {
      watchers.delete(owner);
      if (watchers.size === 0) this.watchersByTarget.delete(target);
    }
    this.deps.publish(owner.projectId, {
      terminalId: owner.terminalId,
      watchCount: 0,
      watchedTerminalCount: 0,
      pendingEvents: 0,
      delivery: { status: "idle" },
      revision: ++this.revision,
    });
    if (this.ownersByKey.size === 0 && this.pendingRegistrations === 0) this.unsubscribe();
  }

  private addWatcher(targetId: string, owner: PaneOwner): void {
    let watchers = this.watchersByTarget.get(targetId);
    if (watchers === undefined) {
      watchers = new Set();
      this.watchersByTarget.set(targetId, watchers);
    }
    watchers.add(owner);
  }

  /** Rebuild the reverse index entries for one owner from its active watches. */
  private reindexTargets(owner: PaneOwner): void {
    const live = new Set<string>();
    for (const watch of owner.watches.values()) {
      if (watch.status === "active") for (const id of watch.terminalIds) live.add(id);
    }
    for (const [target, watchers] of this.watchersByTarget) {
      if (!watchers.has(owner) || live.has(target)) continue;
      watchers.delete(owner);
      if (watchers.size === 0) this.watchersByTarget.delete(target);
    }
    for (const id of live) this.addWatcher(id, owner);
  }

  private ensureSubscribed(client: TerminalWatchPtyClient): void {
    if (this.unsubscribers.length > 0 && this.subscribedClient === client) return;
    this.unsubscribe();
    const onExit = (id: string, exitCode: number) => this.handleExit(id, "exit", exitCode);
    client.on("exit", onExit);
    this.subscribedClient = client;
    this.unsubscribers = [
      () => client.off("exit", onExit),
      this.deps.onStateChanged((payload) => this.handleStateChanged(payload)),
      this.deps.onKilled((terminalId) => this.handleExit(terminalId, "untracked")),
      this.deps.onTrashed((terminalId) => this.handleExit(terminalId, "untracked")),
    ];
  }

  private unsubscribe(): void {
    const unsubscribers = this.unsubscribers;
    this.unsubscribers = [];
    this.subscribedClient = null;
    for (const off of unsubscribers) {
      try {
        off();
      } catch (err) {
        console.error("[MCP] terminal watch: unsubscribe failed:", err);
      }
    }
  }

  private exitedSince(terminalId: string, epoch: number): boolean {
    const exitedAt = this.exitEpochs.get(terminalId);
    return exitedAt !== undefined && exitedAt > epoch;
  }

  private handleStateChanged(payload: WatchStateChange): void {
    const terminalId = payload.terminalId;
    if (terminalId === undefined) return;

    const own = this.ownersByTerminal.get(terminalId);
    if (own !== undefined) this.handleOwnStateChanged(own, payload);

    const watchers = this.watchersByTarget.get(terminalId);
    if (watchers === undefined) return;
    for (const owner of [...watchers]) {
      for (const watch of owner.watches.values()) {
        if (watch.status !== "active" || !watch.terminalIds.has(terminalId)) continue;
        if (watch.conditions.has("state")) {
          this.pushEvent(owner, {
            watchId: watch.id,
            kind: "state",
            at: payload.timestamp,
            terminalId,
            state: payload.state,
            previousState: payload.previousState,
            ...(payload.waitingReason !== undefined
              ? { waitingReason: payload.waitingReason }
              : {}),
            trigger: payload.trigger,
            confidence: payload.confidence,
          });
        }
        // The marker's text stays out: it is terminal output, and whoever
        // wants it reads it from the status capability as untrusted data.
        if (payload.lastHandback !== undefined && watch.conditions.has("handback")) {
          this.pushEvent(owner, {
            watchId: watch.id,
            kind: "handback",
            at: payload.lastHandback.observedAt,
            terminalId,
          });
        }
      }
      this.schedule(owner);
      this.publish(owner);
    }
  }

  private handleOwnStateChanged(owner: PaneOwner, payload: WatchStateChange): void {
    const delivery = owner.delivery;
    // The turn a wake started has ended. If that wake is confirmed written it
    // is no longer outstanding, whether or not the observations were read:
    // otherwise one ignored wake would silence the pane for good.
    if (
      delivery.status === "outstanding" &&
      payload.previousState === "working" &&
      payload.state !== "working" &&
      delivery.lastDeliveredAt !== undefined &&
      payload.timestamp >= delivery.lastDeliveredAt
    ) {
      if (delivery.confirmed === true) {
        this.settleOutstanding(owner);
      } else {
        delivery.settledSinceDelivery = true;
      }
      return;
    }
    // Any change can be what a held or blocked wake was waiting for.
    if (payload.state !== "working") this.armTimer(owner, WAKE_SETTLE_GRACE_MS);
  }

  private settleOutstanding(owner: PaneOwner): void {
    owner.delivery = {
      status: "idle",
      ...(owner.delivery.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: owner.delivery.lastDeliveredAt }
        : {}),
    };
    this.schedule(owner);
    this.publish(owner);
  }

  private handleExit(terminalId: string, kind: "exit" | "untracked", exitCode?: number): void {
    remember(this.exitEpochs, terminalId, ++this.epoch, this.pendingRegistrations === 0);
    // Only a process that ended frees the id for a new pane. A pane closed to
    // the trash can come back, still inside its interval.
    if (kind === "exit") this.lastWakeAt.delete(terminalId);

    const own = this.ownersByTerminal.get(terminalId);
    if (own !== undefined) this.disposeOwner(own);

    const watchers = this.watchersByTarget.get(terminalId);
    if (watchers === undefined) return;
    this.watchersByTarget.delete(terminalId);
    const at = this.now();
    for (const owner of [...watchers]) {
      for (const watch of owner.watches.values()) {
        if (watch.status !== "active" || !watch.terminalIds.has(terminalId)) continue;
        watch.terminalIds.delete(terminalId);
        if (watch.conditions.has(kind)) {
          this.pushEvent(owner, {
            watchId: watch.id,
            kind,
            at,
            terminalId,
            ...(kind === "exit" && exitCode !== undefined ? { exitCode } : {}),
          });
        }
        if (watch.terminalIds.size === 0) this.stopWatch(owner, watch, "targets-gone");
      }
      this.schedule(owner);
      this.publish(owner);
    }
  }

  private stopWatch(owner: PaneOwner, watch: Watch, reason: TerminalWatchStopReason): void {
    if (watch.status === "stopped") return;
    watch.status = "stopped";
    watch.stopReason = reason;
    this.pushEvent(owner, {
      watchId: watch.id,
      kind: "stopped",
      at: this.now(),
      stopReason: reason,
    });
    this.reindexTargets(owner);
  }

  private pushEvent(owner: PaneOwner, event: Omit<TerminalWatchEvent, "seq">): void {
    owner.events.push({ event: { seq: owner.nextSeq++, ...event }, delivered: false });
    while (owner.events.length > MAX_PENDING_WATCH_EVENTS) {
      owner.events.shift();
      owner.droppedEvents++;
    }
  }

  private hasUndelivered(owner: PaneOwner): boolean {
    return owner.events.some((held) => !held.delivered);
  }

  /**
   * Arrange a delivery attempt for new observations. The first observation of
   * a batch fixes the deadline and later ones never move it, so continuous
   * change across a fleet still produces a wake on time.
   */
  private schedule(owner: PaneOwner): void {
    if (owner.disposed) return;
    const status = owner.delivery.status;
    if (status === "outstanding" || status === "failed") return;
    if (!this.hasUndelivered(owner)) {
      if (status !== "idle") this.setDelivery(owner, { status: "idle" });
      return;
    }
    if (status === "idle") this.setDelivery(owner, { status: "scheduled" });
    this.armTimer(owner, WAKE_COALESCE_MS);
  }

  /** Set the attempt timer, moving an existing one earlier but never later. */
  private armTimer(owner: PaneOwner, delayMs: number): void {
    if (owner.disposed) return;
    const dueAt = this.now() + delayMs;
    if (owner.timer !== undefined) {
      if (owner.timerDueAt !== undefined && owner.timerDueAt <= dueAt) return;
      clearTimeout(owner.timer);
    }
    owner.timerDueAt = dueAt;
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      owner.timerDueAt = undefined;
      void this.attempt(owner);
    }, delayMs);
  }

  private async attempt(owner: PaneOwner): Promise<void> {
    if (owner.disposed || owner.attempting) return;
    const status = owner.delivery.status;
    if (status === "outstanding" || status === "failed") return;
    if (!this.deps.isEnabled()) return;
    if (!this.hasUndelivered(owner)) {
      this.setDelivery(owner, { status: "idle" });
      return;
    }

    const lastDeliveredAt = owner.delivery.lastDeliveredAt;
    if (lastDeliveredAt !== undefined) {
      const wait = lastDeliveredAt + MIN_WAKE_INTERVAL_MS - this.now();
      if (wait > 0) {
        this.setDelivery(owner, { status: "held", reason: "interval" });
        this.armTimer(owner, wait);
        return;
      }
    }

    const client = this.deps.getPtyClient();
    if (client === null) {
      this.setDelivery(owner, { status: "blocked", reason: "unreadable" });
      return;
    }

    owner.attempting = true;
    let info: WatchTerminalInfo | null;
    try {
      info = await client.getTerminalAsync(owner.terminalId);
    } catch {
      info = null;
    } finally {
      owner.attempting = false;
    }
    if (owner.disposed || !this.deps.isEnabled()) return;
    if (owner.delivery.status === "outstanding" || owner.delivery.status === "failed") return;
    if (!this.hasUndelivered(owner)) {
      this.setDelivery(owner, { status: "idle" });
      return;
    }
    // No reading is not a safe reading.
    if (info === null) {
      this.setDelivery(owner, { status: "blocked", reason: "unreadable" });
      return;
    }

    const verdict = evaluateWakeGate(info);
    if (verdict.kind === "hold") {
      this.setDelivery(owner, { status: "held", reason: verdict.reason });
      return;
    }
    if (verdict.kind === "blocked") {
      this.setDelivery(owner, { status: "blocked", reason: verdict.reason });
      return;
    }
    const settledFor = info.lastStateChange === undefined ? 0 : this.now() - info.lastStateChange;
    if (settledFor < WAKE_SETTLE_GRACE_MS) {
      this.setDelivery(owner, { status: "scheduled" });
      this.armTimer(owner, WAKE_SETTLE_GRACE_MS - settledFor);
      return;
    }

    this.deliver(owner, client);
  }

  private deliver(owner: PaneOwner, client: TerminalWatchPtyClient): void {
    const watchIds: string[] = [];
    for (const held of owner.events) {
      if (!held.delivered && !watchIds.includes(held.event.watchId)) {
        watchIds.push(held.event.watchId);
      }
    }
    for (const watchId of watchIds) {
      const watch = owner.watches.get(watchId);
      if (watch === undefined || watch.status !== "active") continue;
      watch.deliveries++;
      // Stopped as part of this wake, so the stop rides along with it.
      if (watch.deliveries >= watch.maxDeliveries) this.stopWatch(owner, watch, "max-deliveries");
    }
    for (const held of owner.events) held.delivered = true;

    // An earlier wake the host never finished with would land beside this one.
    this.withdraw(owner);
    const token = randomUUID();
    const deliveredAt = this.now();
    owner.inHost = { token, watchIds: new Set(watchIds) };
    remember(this.lastWakeAt, owner.terminalId, deliveredAt);
    owner.delivery = { status: "outstanding", lastDeliveredAt: deliveredAt, token };
    // The host re-checks the gate when the line reaches the lane, and drops
    // its Enter if anyone types before it lands.
    client.submit(owner.terminalId, formatWakeLine(watchIds), token, undefined, "settled-prompt");
    this.publish(owner);
    void this.confirmDelivery(owner, client, token);
  }

  /**
   * Follow a wake until the host is done with it. Keyed on the wake the host
   * holds rather than on `delivery`, so a read that acknowledges the wake does
   * not stop it being followed — or withdrawn.
   */
  private async confirmDelivery(
    owner: PaneOwner,
    client: TerminalWatchPtyClient,
    token: string
  ): Promise<void> {
    const stillHeld = () => !owner.disposed && owner.inHost?.token === token;
    let lastSeen: TerminalWatchDeliveryReason = "unknown";
    for (const delayMs of DELIVERY_CONFIRM_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!stillHeld()) return;
      let info: WatchTerminalInfo | null;
      try {
        info = await client.getTerminalAsync(owner.terminalId, token);
      } catch {
        info = null;
      }
      if (!stillHeld()) return;
      const phase = info?.submission?.phase;
      if (phase === "pty_written") {
        owner.inHost = undefined;
        if (owner.delivery.token === token) {
          owner.delivery.confirmed = true;
          if (owner.delivery.settledSinceDelivery === true) this.settleOutstanding(owner);
        }
        return;
      }
      if (phase === "failed" || phase === "cancelled" || phase === "unknown") {
        owner.inHost = undefined;
        // Part of the line may be sitting in the composer, and a guard refusal
        // looks the same from here. Neither makes sending again safe.
        if (owner.delivery.token === token) {
          this.failDelivery(owner, phase === "failed" ? "unknown" : phase);
        }
        return;
      }
      lastSeen = info === null ? "unreadable" : "unknown";
    }
    if (!stillHeld()) return;
    // Still queued, or unreadable, after the whole window: take it back rather
    // than let it land later under a delivery already reported as failed.
    this.withdraw(owner);
    if (owner.delivery.token === token) this.failDelivery(owner, lastSeen);
  }

  private failDelivery(owner: PaneOwner, reason: TerminalWatchDeliveryReason): void {
    owner.delivery = {
      status: "failed",
      reason,
      ...(owner.delivery.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: owner.delivery.lastDeliveredAt }
        : {}),
    };
    this.publish(owner);
  }

  private setDelivery(
    owner: PaneOwner,
    next: { status: TerminalWatchDelivery["status"]; reason?: TerminalWatchDeliveryReason }
  ): void {
    const current = owner.delivery;
    if (current.status === next.status && current.reason === next.reason) return;
    owner.delivery = {
      status: next.status,
      ...(next.reason !== undefined ? { reason: next.reason } : {}),
      ...(current.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: current.lastDeliveredAt }
        : {}),
    };
    this.publish(owner);
  }

  private paneState(owner: PaneOwner): PaneWatchState {
    const watched = new Set<string>();
    for (const watch of owner.watches.values()) {
      if (watch.status === "active") for (const id of watch.terminalIds) watched.add(id);
    }
    return {
      terminalId: owner.terminalId,
      watchCount: owner.watches.size,
      watchedTerminalCount: watched.size,
      pendingEvents: owner.events.length,
      delivery: publicDelivery(owner.delivery),
      revision: this.revision,
    };
  }

  private publish(owner: PaneOwner): void {
    if (owner.disposed) return;
    this.revision++;
    this.deps.publish(owner.projectId, this.paneState(owner));
  }
}

/** Insert as newest, dropping the oldest entry once the map holds too many. */
function remember<V>(map: Map<string, V>, key: string, value: V, prune = true): void {
  map.delete(key);
  map.set(key, value);
  while (prune && map.size > MAX_REMEMBERED_EXITS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function publicDelivery(delivery: DeliveryState): TerminalWatchDelivery {
  return {
    status: delivery.status,
    ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
    ...(delivery.lastDeliveredAt !== undefined
      ? { lastDeliveredAt: delivery.lastDeliveredAt }
      : {}),
  };
}

function disabledError(): TerminalWatchError {
  return new TerminalWatchError(
    WATCH_WAKE_DISABLED,
    "Waking panes from terminal watches is turned off. The user can turn it on in Settings > MCP Server."
  );
}

// Not `terminal.watch`: that id is the user's own watch-and-notify action.
export const TERMINAL_WATCH_TOOL = "terminal.registerWatch";
export const TERMINAL_LIST_WATCHES_TOOL = "terminal.listWatches";
export const TERMINAL_GET_WATCH_EVENTS_TOOL = "terminal.getWatchEvents";
export const TERMINAL_CANCEL_WATCH_TOOL = "terminal.cancelWatch";

export const TERMINAL_WATCH_TOOLS: ReadonlySet<string> = new Set([
  TERMINAL_WATCH_TOOL,
  TERMINAL_LIST_WATCHES_TOOL,
  TERMINAL_GET_WATCH_EVENTS_TOOL,
  TERMINAL_CANCEL_WATCH_TOOL,
]);

export type TerminalWatchHandlers = Pick<
  TerminalWatchService,
  "register" | "list" | "readEvents" | "cancel"
>;

function parseArgs<T>(schema: z.ZodType<T>, toolId: string, rawArgs: unknown): T {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at '${issue.path.map(String).join(".")}'` : "";
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolId}: ${issue?.message ?? "invalid arguments"}${where}.`
    );
  }
  return parsed.data;
}

/**
 * Run one watch tool for a caller whose own pane is already resolved. Throws
 * {@link McpError} for malformed arguments and {@link TerminalWatchError} for
 * a refusal.
 */
export async function runTerminalWatchTool(
  toolId: string,
  rawArgs: unknown,
  pane: OwnPane,
  handlers: TerminalWatchHandlers
): Promise<
  | TerminalWatchResult
  | TerminalListWatchesResult
  | TerminalGetWatchEventsResult
  | TerminalCancelWatchResult
> {
  switch (toolId) {
    case TERMINAL_WATCH_TOOL:
      return handlers.register(pane, parseArgs(TerminalWatchArgsSchema, toolId, rawArgs));
    case TERMINAL_LIST_WATCHES_TOOL:
      parseArgs(TerminalListWatchesArgsSchema, toolId, rawArgs);
      return handlers.list(pane);
    case TERMINAL_GET_WATCH_EVENTS_TOOL:
      return handlers.readEvents(
        pane,
        parseArgs(TerminalGetWatchEventsArgsSchema, toolId, rawArgs)
      );
    case TERMINAL_CANCEL_WATCH_TOOL:
      return handlers.cancel(
        pane,
        parseArgs(TerminalCancelWatchArgsSchema, toolId, rawArgs).watchId
      );
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown terminal watch tool '${toolId}'.`);
  }
}
