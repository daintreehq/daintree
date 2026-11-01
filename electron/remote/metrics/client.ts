import type {
  HostAttentionEvent,
  HostFleetSubmitPayload,
  HostFleetTargetList,
  HostLinkActivity,
  HostLinkActivityResult,
  HostMetricsEvent,
  HostMetricsSnapshot,
  HostProcessInventoryResult,
  HostWorktreeEntry,
  RemoteProcessInventory,
} from "../../../shared/types/ipc/hostMetrics.js";
import type {
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  type HostConnectionState,
  type HostDescriptor,
  type HostId,
  type HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { Lane } from "../link/frames.js";
import { ControlKind, type HostSummaryFrame } from "../link/messages.js";
import { stampNow, type ElapsedStamp } from "../link/elapsed.js";
import type { LinkSession } from "../link/session.js";
import type { FleetCaller } from "./hostOps.js";
import {
  AttentionPayloadSchema,
  FleetTargetListSchema,
  LinkActivitySchema,
  MetricsLinkMethod,
  ProcessInventorySchema,
  WorktreeListSchema,
  normalizeFleetOpId,
} from "./linkMethods.js";
import { boundProcessInventory } from "./processInventoryWire.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";
import { receiveSummary, type SummaryReceipt } from "./summaryReceipt.js";
import { WorktreeChangeWatch } from "./worktreeChanges.js";
import { EmptyPayloadSchema } from "../host/linkMethods.js";
import { connectionKey } from "../client/connection.js";
import { admitHostNotice } from "../hybrid/hostNoticeBudget.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";

const logger = createLogger("main:client");
const logLimiter = createKeyedLogLimiter();

/** ~15 minutes of summaries at the sample cadence. */
export const HOST_METRICS_RING_SIZE = Math.ceil((15 * 60_000) / HOST_METRICS_INTERVAL_MS);

export interface MetricsConnection {
  callHost(method: string, payload: unknown): Promise<unknown>;
}

export interface HostMetricsClientOptions {
  manager: {
    connect(hostId: HostId): unknown;
    /** Mark the host's connection used, so it isn't released as idle. */
    touch?(hostId: HostId): void;
    get(hostId: HostId): MetricsConnection | undefined;
    connectionState(hostId: HostId): HostConnectionState;
    onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
    /** This Shell launch, as every host it dials knows it. */
    readonly localClient?: { clientId: string; clientName: string };
  };
  registry: {
    list(): HostDescriptor[];
    get(hostId: HostId): HostDescriptor | null;
    onChange(listener: () => void): () => void;
  };
  /** This machine's own sampler; subscribed only while some other host exists. */
  localLoop: {
    subscribe(listener: (summary: HostMetricsSummary) => void): () => void;
  } | null;
  /** Push to every local view. */
  emit(event: HostMetricsEvent): void;
  /** Present an opted-in host's attention event in one view; false when no view took it. */
  deliverAttention(event: HostAttentionEvent): boolean;
  /**
   * This machine's own verdict on a host's waiting agent (#14701): dropped,
   * inbox only, or announced. Announced when absent.
   */
  waitingPolicy?(): "silent" | "quiet" | "announce";
  /** This machine's fleet and worktree reads, for the "local" host. */
  local: {
    listFleetTargets(): Promise<HostFleetTargetList>;
    submitFleet(
      terminalId: string,
      text: string,
      caller: FleetCaller,
      opId: string | null
    ): Promise<void>;
    listWorktrees(): Promise<HostWorktreeEntry[]>;
    /** This machine's processes, as its own Processes view lists them. */
    processInventory(): Promise<ProcessInventorySnapshot>;
    /** Told when this machine's worktree list may show something else. */
    onWorktreesMaybeChanged?(listener: () => void): () => void;
    /** Told when which projects are registered on this machine changed. */
    onProjectsChanged?(listener: () => void): () => void;
  };
  ringSize?: number;
  /** How long a burst of this machine's worktree changes is gathered; the default outside tests. */
  worktreesChangedDelayMs?: number;
  /** How long a fleet submit whose answer was lost waits for its host to come back and say. */
  fleetReconcileMs?: number;
  /** This machine's clocks, for when a summary arrived; real ones by default. */
  clock?: () => ElapsedStamp;
}

/** Long enough for a dropped link's automatic reconnect; short enough not to hold a broadcast. */
export const FLEET_RECONCILE_MS = 10_000;

/**
 * Refusals the host's fleet handler answers with. For a resent opId the host
 * answers from its record when the first send ran, so one of these means it didn't.
 */
const HOST_FLEET_REFUSALS = new Set(["NOT_FOUND", "VALIDATION", "DRIVEN_ELSEWHERE"]);

function isHostFleetRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && HOST_FLEET_REFUSALS.has(code);
}

function isUnknownOutcome(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "OUTCOME_UNKNOWN" || code === "HOST_DISCONNECTED";
}

function isUnsupported(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "UNSUPPORTED";
}

/** Names and reasons another machine wrote, made safe to show as one line here. */
function displaySafeActivity(activity: HostLinkActivity): HostLinkActivity {
  const name = (text: string | null) => (text === null ? null : displaySafeText(text));
  return {
    ...activity,
    events: activity.events.map((event) => {
      const safe = { ...event, clientName: displaySafeText(event.clientName) };
      switch (safe.kind) {
        case "link-dropped":
          return { ...safe, reason: displaySafeText(safe.reason) };
        case "session-ended":
          return { ...safe, reason: name(safe.reason) };
        case "refused":
          return { ...safe, detail: name(safe.detail) };
        default:
          return safe;
      }
    }),
    drivers: activity.drivers.map((driver) => ({
      ...driver,
      projectName: name(driver.projectName),
      holder: { ...driver.holder, clientName: displaySafeText(driver.holder.clientName) },
    })),
    attached: activity.attached.map((shell) => ({
      ...shell,
      clientName: displaySafeText(shell.clientName),
    })),
  };
}

/** Titles, names and labels another machine wrote, made safe to show here. */
function displaySafeInventory(inventory: RemoteProcessInventory): RemoteProcessInventory {
  const text = (value: string | undefined) =>
    value === undefined ? undefined : displaySafeText(value);
  const name = (value: string | null) => (value === null ? null : displaySafeText(value));
  const sample = (tree: ProcessTreeSample | null): ProcessTreeSample | null =>
    tree && {
      ...tree,
      members: tree.members.map((member) => ({ ...member, comm: displaySafeText(member.comm) })),
    };
  return {
    ...inventory,
    terminals: inventory.terminals.map((terminal) => ({
      ...terminal,
      title: text(terminal.title),
      projectName: name(terminal.projectName),
      sample: sample(terminal.sample),
    })),
    closedTerminalProcesses: inventory.closedTerminalProcesses.map((closed) => ({
      ...closed,
      comm: displaySafeText(closed.comm),
      projectName: name(closed.projectName),
      origin: closed.origin && { ...closed.origin, title: text(closed.origin.title) },
    })),
    plugins: inventory.plugins.map((plugin) => ({
      ...plugin,
      label: name(plugin.label),
      sample: sample(plugin.sample),
    })),
  };
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The Shell's view of every host's load: the summaries each connected host
 * sends, a short ring of what each reported, this machine's own summary beside
 * them, and the cross-host reads the overview and fleet features make. Only a
 * host whose notifications are on is dialled for this (a light connection the
 * Shell keeps); any other reports while something else has it connected.
 */
export class HostMetricsClient {
  private readonly rings = new Map<HostId, HostMetricsSummary[]>();
  /** When each held summary arrived and how old it could be then, kept beside it rather than in it. */
  private readonly receipts = new WeakMap<HostMetricsSummary, SummaryReceipt>();
  /** The link each held summary came on, as a token per session so its summaries never keep a closed one alive. */
  private readonly arrivedOn = new WeakMap<HostMetricsSummary, object>();
  private readonly linkTokens = new WeakMap<LinkSession, object>();
  /** Each known host's address: a new address is another machine, whose history starts empty. */
  private readonly known = new Map<HostId, string>();
  /** Hosts dialled for their notifications, so turning them on dials once, not on every change. */
  private readonly dialledForNotifications = new Set<HostId>();
  private readonly disposers: Array<() => void> = [];
  /** Told of every recorded summary; empty unless something in main asked (#14463). */
  private readonly summaryListeners = new Set<(hostId: HostId) => void>();
  private stopLocal: (() => void) | null = null;
  private stopLocalWorktrees: (() => void) | null = null;
  private localWorktrees: WorktreeChangeWatch | null = null;
  private stopLocalProjects: (() => void) | null = null;
  private readonly ringSize: number;

  constructor(private readonly options: HostMetricsClientOptions) {
    this.ringSize = options.ringSize ?? HOST_METRICS_RING_SIZE;
  }

  start(): void {
    this.disposers.push(
      this.options.manager.onSessionOpened((hostId, session) => this.wire(hostId, session)),
      this.options.registry.onChange(() => this.syncHosts())
    );
    this.syncHosts();
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.stopLocal?.();
    this.stopLocal = null;
    this.stopLocalWorktrees?.();
    this.stopLocalWorktrees = null;
    this.stopLocalProjects?.();
    this.stopLocalProjects = null;
    this.summaryListeners.clear();
  }

  /** Hears each summary as it is recorded; it never asks a host for one. */
  onSummary(listener: (hostId: HostId) => void): () => void {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  getSnapshots(): HostMetricsSnapshot[] {
    return [...this.rings].map(([hostId, history]) => ({ hostId, history: [...history] }));
  }

  latest(hostId: HostId): HostMetricsSummary | null {
    return this.rings.get(hostId)?.[0] ?? null;
  }

  /** When a summary this client holds arrived, and what its frame proved about its age (#14462). */
  receiptOf(summary: HostMetricsSummary): SummaryReceipt | null {
    return this.receipts.get(summary) ?? null;
  }

  /**
   * Whether a held summary came on `session` (#15736). The history outlives a
   * reconnect, so one from an earlier link, or any while no link is open, is
   * false; null for one that came on no link at all, as this machine's own do.
   */
  cameOn(summary: HostMetricsSummary, session: LinkSession | null): boolean | null {
    const token = this.arrivedOn.get(summary);
    if (token === undefined) return null;
    return session !== null && this.linkTokens.get(session) === token;
  }

  /** Agents a connected host last reported working and waiting; unknown while it isn't connected. */
  observedAgents(hostId: HostId): { working: number; waiting: number } | null {
    if (this.options.manager.connectionState(hostId).status !== "connected") return null;
    const observed = this.latest(hostId)?.agentsObserved;
    return observed ? { working: observed.working, waiting: observed.waiting } : null;
  }

  async listFleetTargets(payload: unknown): Promise<HostFleetTargetList> {
    const hostId = this.hostIdOf(payload);
    if (isLocalHostId(hostId)) return this.options.local.listFleetTargets();
    const answer = await this.connection(hostId).callHost(
      MetricsLinkMethod.LIST_FLEET_TARGETS,
      null
    );
    const parsed = FleetTargetListSchema.safeParse(answer);
    if (!parsed.success)
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${hostId} sent invalid fleet targets`,
        // The id is opaque to the person; the overview names hosts by name.
        userMessage: `${this.options.registry.get(hostId)?.name ?? "The host"} sent an agent list this machine couldn't read`,
      });
    return {
      targets: parsed.data.targets.map((target) => ({ ...target, hostId })),
      complete: parsed.data.complete,
    };
  }

  /**
   * Submit one fleet prompt. A remote submit carries the renderer's opId; when
   * its answer is lost the host may or may not have typed it, so this asks
   * again with the same opId once the host is back, and the host answers from
   * its record rather than typing it twice. Still unanswered, the outcome is
   * reported unknown. The host keeps that record for a limited time
   * (`FLEET_SUBMIT_RETENTION_MS`), so a retry reusing the opId is safe only
   * within the renderer's `FLEET_SAFE_RETRY_MS` of the first send; the
   * renderer owns that window, so this message makes no promise about retries.
   */
  async submitFleet(payload: unknown): Promise<void> {
    const hostId = this.hostIdOf(payload);
    const { terminalId, text, opId } = (payload ?? {}) as Partial<HostFleetSubmitPayload>;
    const id = requireString(terminalId, "terminalId", 256);
    const body = requireString(text, "text", 1024 * 1024);
    const op = normalizeFleetOpId(opId);
    if (isLocalHostId(hostId)) {
      await this.options.local.submitFleet(id, body, { kind: "local" }, op);
      return;
    }
    const request = { terminalId: id, text: body, opId: op };
    // No link at all means nothing was sent: that is a plain failure, not an unknown outcome.
    const first = this.connection(hostId);
    try {
      await first.callHost(MetricsLinkMethod.SUBMIT_FLEET, request);
    } catch (error) {
      if (op === null || !isUnknownOutcome(error)) throw error;
      const connection = await this.waitForConnection(hostId);
      const name = this.options.registry.get(hostId)?.name ?? hostId;
      const unknown = new AppError({
        code: "OUTCOME_UNKNOWN",
        message: `Couldn't confirm fleet submit ${op} on host ${hostId}`,
        userMessage: `Couldn't confirm whether ${name} received the prompt.`,
      });
      if (!connection) throw unknown;
      try {
        await connection.callHost(MetricsLinkMethod.SUBMIT_FLEET, request);
      } catch (again) {
        // Only the host's own refusal of this opId proves the first send typed nothing;
        // anything else (a full link queue, a dropped link) leaves the outcome unknown.
        throw isHostFleetRefusal(again) ? again : unknown;
      }
    }
  }

  /** The host's link once it is back, or null when it isn't within the reconcile window. */
  private waitForConnection(hostId: HostId): Promise<MetricsConnection | null> {
    const now = this.options.manager.get(hostId);
    if (now && this.options.manager.connectionState(hostId).status === "connected") {
      return Promise.resolve(now);
    }
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      const done = (connection: MetricsConnection | null): void => {
        clearTimeout(timer);
        off?.();
        resolve(connection);
      };
      const timer = setTimeout(
        () => done(null),
        this.options.fleetReconcileMs ?? FLEET_RECONCILE_MS
      );
      off = this.options.manager.onSessionOpened((opened) => {
        if (opened !== hostId) return;
        const connection = this.options.manager.get(hostId);
        if (connection) done(connection);
      });
    });
  }

  async listWorktrees(payload: unknown): Promise<HostWorktreeEntry[]> {
    const hostId = this.hostIdOf(payload);
    if (isLocalHostId(hostId)) return this.options.local.listWorktrees();
    const answer = await this.connection(hostId).callHost(MetricsLinkMethod.LIST_WORKTREES, null);
    const parsed = WorktreeListSchema.safeParse(answer);
    if (!parsed.success)
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${hostId} sent an invalid worktree list`,
      });
    return parsed.data.map((entry) => ({ ...entry, hostId }));
  }

  /**
   * What a host saw happen to its links, who drives each of its projects and
   * which Shells are attached to it. A host from before it could say answers
   * `supported: false`.
   */
  async linkActivity(payload: unknown): Promise<HostLinkActivityResult> {
    const hostId = this.hostIdOf(payload);
    if (isLocalHostId(hostId)) throw invalid("Link activity is read from a remote host");
    let answer: unknown;
    try {
      answer = await this.connection(hostId).callHost(MetricsLinkMethod.LINK_ACTIVITY, null);
    } catch (error) {
      if (isUnsupported(error)) return { supported: false };
      throw error;
    }
    const parsed = LinkActivitySchema.safeParse(answer);
    if (!parsed.success)
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${hostId} sent invalid link activity`,
      });
    const self = this.options.manager.localClient;
    return {
      supported: true,
      activity: displaySafeActivity(parsed.data),
      self: self ? { clientId: self.clientId, clientName: self.clientName } : null,
    };
  }

  /**
   * The processes a host runs, as its Processes view lists them, read over a
   * session that needs no view bound. This machine answers from its own
   * inventory. A host from before it could say answers `supported: false`.
   */
  async processInventory(payload: unknown): Promise<HostProcessInventoryResult> {
    const hostId = this.hostIdOf(payload);
    if (isLocalHostId(hostId)) {
      return {
        supported: true,
        inventory: boundProcessInventory(await this.options.local.processInventory()),
      };
    }
    let answer: unknown;
    try {
      answer = await this.connection(hostId).callHost(MetricsLinkMethod.PROCESS_INVENTORY, null);
    } catch (error) {
      if (isUnsupported(error)) return { supported: false };
      throw error;
    }
    const parsed = ProcessInventorySchema.safeParse(answer);
    if (!parsed.success)
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${hostId} sent an invalid process inventory`,
      });
    return { supported: true, inventory: displaySafeInventory(parsed.data) };
  }

  /**
   * Record a summary: the host's own id in it is replaced by the id this Shell
   * knows it by, and the frame's timing is kept beside it, never shown.
   */
  record(hostId: HostId, frame: HostSummaryFrame, session?: LinkSession): void {
    const at = (this.options.clock ?? stampNow)();
    const { timing, ...summary } = frame;
    const stamped: HostMetricsSummary = { ...summary, hostId };
    this.receipts.set(
      stamped,
      receiveSummary(timing, (nonce) => session?.pingSentAt(nonce) ?? null, at)
    );
    if (session) this.arrivedOn.set(stamped, this.linkToken(session));
    let ring = this.rings.get(hostId);
    if (!ring) {
      ring = [];
      this.rings.set(hostId, ring);
    }
    ring.unshift(stamped);
    if (ring.length > this.ringSize) ring.length = this.ringSize;
    this.options.emit({ type: "summary", summary: stamped });
    for (const listener of [...this.summaryListeners]) {
      try {
        listener(hostId);
      } catch (error) {
        logger.warn("A summary listener threw", { error });
      }
    }
  }

  private linkToken(session: LinkSession): object {
    let token = this.linkTokens.get(session);
    if (token === undefined) {
      token = {};
      this.linkTokens.set(session, token);
    }
    return token;
  }

  private hostIdOf(payload: unknown): HostId {
    const hostId = (payload as { hostId?: unknown } | null)?.hostId;
    const id = requireString(hostId, "hostId", 64);
    if (!isLocalHostId(id) && !this.options.registry.get(id)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${id}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    return id;
  }

  private connection(hostId: HostId): MetricsConnection {
    this.options.manager.touch?.(hostId);
    const connection = this.options.manager.get(hostId);
    if (!connection) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    return connection;
  }

  private wire(hostId: HostId, session: LinkSession): void {
    session.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (frame) =>
      this.record(hostId, frame, session)
    );
    session.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (payload) => {
      const descriptor = this.options.registry.get(hostId);
      // Opt-in per host, and off until the user turns it on.
      if (descriptor?.notificationsEnabled !== true) return null;
      // This screen's choices decide, before the notice counts against the host's share.
      const policy = this.options.waitingPolicy?.() ?? "announce";
      if (policy === "silent") return null;
      // The host's one notice budget, and its names shown as text, never as layout.
      if (!admitHostNotice(hostId)) return null;
      this.options.deliverAttention({
        type: "attention",
        hostId,
        hostName: descriptor.name,
        kind: payload.kind,
        terminalId: payload.terminalId,
        projectId: payload.projectId ?? null,
        projectName: payload.projectName === null ? null : displaySafeText(payload.projectName),
        agentName: payload.agentName === null ? null : displaySafeText(payload.agentName),
        // A host from before #14701 may still have judged it quiet by its own hours.
        quiet: policy === "quiet" || payload.quiet,
      });
      return null;
    });
    session.registerCallHandler(MetricsLinkMethod.WORKTREES_CHANGED, EmptyPayloadSchema, () => {
      this.options.emit({ type: "worktrees", hostId });
      return null;
    });
    session.registerCallHandler(MetricsLinkMethod.PROJECTS_CHANGED, EmptyPayloadSchema, () => {
      this.options.emit({ type: "projects", hostId });
      return null;
    });
  }

  /**
   * Dial a host whose notifications are on, once as it appears or as they're
   * turned on: those need a light connection to be heard. A host the user
   * then disconnects stays disconnected, and nothing else is dialled here.
   */
  private syncHosts(): void {
    const hosts = this.options.registry.list().filter((host) => !isLocalHostId(host.id));
    const present = new Set(hosts.map((host) => host.id));
    for (const hostId of [...this.known.keys()]) {
      if (present.has(hostId)) continue;
      this.known.delete(hostId);
      this.dialledForNotifications.delete(hostId);
      this.rings.delete(hostId);
    }
    for (const host of hosts) {
      const address = connectionKey(host.connection);
      const knownAs = this.known.get(host.id);
      // The host list's own update re-dials a changed address; only the history is ours to drop.
      if (knownAs !== undefined && knownAs !== address) this.rings.delete(host.id);
      this.known.set(host.id, address);
      if (host.notificationsEnabled !== true) {
        this.dialledForNotifications.delete(host.id);
        continue;
      }
      if (this.dialledForNotifications.has(host.id)) continue;
      this.dialledForNotifications.add(host.id);
      try {
        this.options.manager.connect(host.id);
      } catch (error) {
        const suppressedCount = logLimiter.take("dial-notifications");
        if (suppressedCount !== null) {
          logger.warn("Couldn't dial a host for notifications", {
            hostId: host.id,
            error,
            suppressedCount,
          });
        }
      }
    }
    if (hosts.length > 0 && !this.stopLocal && this.options.localLoop) {
      this.stopLocal = this.options.localLoop.subscribe((summary) => {
        this.record(LOCAL_HOST_ID, summary);
        // A project closed here fires no worktree event; the sample tick catches it.
        this.localWorktrees?.poke();
      });
    } else if (hosts.length === 0 && this.stopLocal) {
      this.stopLocal();
      this.stopLocal = null;
      this.rings.delete(LOCAL_HOST_ID);
    }
    // A window showing another host lists this machine's worktrees too.
    const follow = this.options.local.onWorktreesMaybeChanged;
    if (hosts.length > 0 && !this.stopLocalWorktrees && follow) {
      const watch = new WorktreeChangeWatch({
        list: () => this.options.local.listWorktrees(),
        delayMs: this.options.worktreesChangedDelayMs,
        active: () => true,
        changed: () => this.options.emit({ type: "worktrees", hostId: LOCAL_HOST_ID }),
      });
      const off = follow(() => watch.poke());
      this.localWorktrees = watch;
      this.stopLocalWorktrees = () => {
        off();
        watch.dispose();
        this.localWorktrees = null;
      };
    } else if (hosts.length === 0 && this.stopLocalWorktrees) {
      this.stopLocalWorktrees();
      this.stopLocalWorktrees = null;
    }
    // A window showing another host matches its project against this machine too.
    const followProjects = this.options.local.onProjectsChanged;
    if (hosts.length > 0 && !this.stopLocalProjects && followProjects) {
      this.stopLocalProjects = followProjects(() =>
        this.options.emit({ type: "projects", hostId: LOCAL_HOST_ID })
      );
    } else if (hosts.length === 0 && this.stopLocalProjects) {
      this.stopLocalProjects();
      this.stopLocalProjects = null;
    }
  }
}
