import type {
  HostAttentionEvent,
  HostFleetSubmitPayload,
  HostFleetTarget,
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
} from "./linkMethods.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";

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
    listFleetTargets(): Promise<HostFleetTarget[]>;
    submitFleet(terminalId: string, text: string, caller: FleetCaller): Promise<void>;
    listWorktrees(): Promise<HostWorktreeEntry[]>;
  };
  ringSize?: number;
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
  /** Each dialled host's SSH target: a new target is another machine, whose history starts empty. */
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
    return this.latest(hostId)?.agentsObserved.working ?? null;
  }

  async listFleetTargets(payload: unknown): Promise<HostFleetTarget[]> {
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
    return parsed.data.map((target) => ({ ...target, hostId }));
  }

  async submitFleet(payload: unknown): Promise<void> {
    const hostId = this.hostIdOf(payload);
    const { terminalId, text } = (payload ?? {}) as Partial<HostFleetSubmitPayload>;
    const id = requireString(terminalId, "terminalId", 256);
    const body = requireString(text, "text", 1024 * 1024);
    if (isLocalHostId(hostId)) {
      await this.options.local.submitFleet(id, body, { kind: "local" });
      return;
    }
    await this.connection(hostId).callHost(MetricsLinkMethod.SUBMIT_FLEET, {
      terminalId: id,
      text: body,
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
      const target = this.dialled.get(host.id);
      if (target !== undefined) {
        // The host list's own update re-dials a changed target; only the history is ours to drop.
        if (target !== host.sshTarget) {
          this.dialled.set(host.id, host.sshTarget);
          this.rings.delete(host.id);
        }
        continue;
      }
      this.dialled.set(host.id, host.sshTarget);
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
