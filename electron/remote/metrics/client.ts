import type {
  HostAttentionEvent,
  HostFleetSubmitPayload,
  HostFleetTargetList,
  HostMetricsEvent,
  HostMetricsSnapshot,
  HostWorktreeEntry,
} from "../../../shared/types/ipc/hostMetrics.js";
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
import { ControlKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import type { FleetCaller } from "./hostOps.js";
import {
  AttentionPayloadSchema,
  FleetTargetListSchema,
  MetricsLinkMethod,
  WorktreeListSchema,
  normalizeFleetOpId,
} from "./linkMethods.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";
import { connectionKey } from "../client/connection.js";

/** ~15 minutes of summaries at the sample cadence. */
export const HOST_METRICS_RING_SIZE = Math.ceil((15 * 60_000) / HOST_METRICS_INTERVAL_MS);

export interface MetricsConnection {
  callHost(method: string, payload: unknown): Promise<unknown>;
}

export interface HostMetricsClientOptions {
  manager: {
    connect(hostId: HostId): unknown;
    get(hostId: HostId): MetricsConnection | undefined;
    connectionState(hostId: HostId): HostConnectionState;
    onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
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
  };
  ringSize?: number;
  /** How long a fleet submit whose answer was lost waits for its host to come back and say. */
  fleetReconcileMs?: number;
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
 * The Shell's view of every host's load: a summary-only link to each known
 * host (dialled whether or not a window shows it), a short ring of what each
 * reported, this machine's own summary beside them, and the cross-host reads
 * the overview and fleet features make.
 */
export class HostMetricsClient {
  private readonly rings = new Map<HostId, HostMetricsSummary[]>();
  /** Each dialled host's address: a new address is another machine, whose history starts empty. */
  private readonly dialled = new Map<HostId, string>();
  private readonly disposers: Array<() => void> = [];
  private stopLocal: (() => void) | null = null;
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
  }

  getSnapshots(): HostMetricsSnapshot[] {
    return [...this.rings].map(([hostId, history]) => ({ hostId, history: [...history] }));
  }

  latest(hostId: HostId): HostMetricsSummary | null {
    return this.rings.get(hostId)?.[0] ?? null;
  }

  /** Working agents a connected host last reported; unknown while it isn't connected. */
  workingAgents(hostId: HostId): number | null {
    if (this.options.manager.connectionState(hostId).status !== "connected") return null;
    return this.latest(hostId)?.agentsObserved?.working ?? null;
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

  /** Record a summary: the host's own id in it is replaced by the id this Shell knows it by. */
  record(hostId: HostId, summary: HostMetricsSummary): void {
    const stamped: HostMetricsSummary = { ...summary, hostId };
    let ring = this.rings.get(hostId);
    if (!ring) {
      ring = [];
      this.rings.set(hostId, ring);
    }
    ring.unshift(stamped);
    if (ring.length > this.ringSize) ring.length = this.ringSize;
    this.options.emit({ type: "summary", summary: stamped });
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
    session.on(Lane.CONTROL, ControlKind.HOST_SUMMARY, (summary) => this.record(hostId, summary));
    session.registerCallHandler(MetricsLinkMethod.ATTENTION, AttentionPayloadSchema, (payload) => {
      const descriptor = this.options.registry.get(hostId);
      // Opt-in per host, and off until the user turns it on.
      if (descriptor?.notificationsEnabled !== true) return null;
      this.options.deliverAttention({
        type: "attention",
        hostId,
        hostName: descriptor.name,
        kind: payload.kind,
        terminalId: payload.terminalId,
        projectName: payload.projectName,
        agentName: payload.agentName,
        quiet: payload.quiet,
      });
      return null;
    });
  }

  /** Dial each host once as it appears; a host the user disconnects stays disconnected. */
  private syncHosts(): void {
    const hosts = this.options.registry.list().filter((host) => !isLocalHostId(host.id));
    const known = new Set(hosts.map((host) => host.id));
    for (const hostId of [...this.dialled.keys()]) {
      if (known.has(hostId)) continue;
      this.dialled.delete(hostId);
      this.rings.delete(hostId);
    }
    for (const host of hosts) {
      const dialledAs = this.dialled.get(host.id);
      const address = connectionKey(host.connection);
      if (dialledAs !== undefined) {
        // The host list's own update re-dials a changed address; only the history is ours to drop.
        if (dialledAs !== address) {
          this.dialled.set(host.id, address);
          this.rings.delete(host.id);
        }
        continue;
      }
      this.dialled.set(host.id, address);
      try {
        this.options.manager.connect(host.id);
      } catch (error) {
        console.warn(`[HostMetrics] Couldn't dial ${host.id} for summaries:`, error);
      }
    }
    if (hosts.length > 0 && !this.stopLocal && this.options.localLoop) {
      this.stopLocal = this.options.localLoop.subscribe((summary) =>
        this.record(LOCAL_HOST_ID, summary)
      );
    } else if (hosts.length === 0 && this.stopLocal) {
      this.stopLocal();
      this.stopLocal = null;
      this.rings.delete(LOCAL_HOST_ID);
    }
  }
}
