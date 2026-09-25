import type {
  HostFleetTargetList,
  HostWorktreeEntry,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import { Lane } from "../link/frames.js";
import { ControlKind, type LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { EmptyPayloadSchema } from "../host/linkMethods.js";
import type { FleetCaller } from "./hostOps.js";
import {
  MetricsLinkMethod,
  SubmitFleetPayloadSchema,
  type AttentionPayload,
} from "./linkMethods.js";

/** The slice of the host server this needs: every attached session, now and later. */
export interface MetricsSessionContext {
  session: LinkSession;
  client: LinkClientInfo;
  /** This host's own id for the session; fleet submits are authorized by it. */
  sessionId: string;
}

export interface MetricsSessionSource {
  readonly sessions: ReadonlyArray<MetricsSessionContext>;
  onSession(listener: (ctx: MetricsSessionContext) => void): () => void;
}

export interface MetricsHostDeps {
  loop: {
    subscribe(listener: (summary: HostMetricsSummary) => void): () => void;
    latest(): HostMetricsSummary | null;
  };
  listFleetTargets(): Promise<HostFleetTargetList>;
  submitFleet(
    terminalId: string,
    text: string,
    caller: FleetCaller,
    opId: string | null
  ): Promise<void>;
  listWorktrees(): Promise<HostWorktreeEntry[]>;
  /** Told when one of this host's agents goes from working to waiting. */
  onAgentWaiting(listener: (payload: WaitingEvent) => void): () => void;
  /** This host's own notification settings: its policy decides, not the Shell's window. */
  notificationSettings(): Pick<
    NotificationSettings,
    | "enabled"
    | "waitingEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartMin"
    | "quietHoursEndMin"
    | "quietHoursWeekdays"
  >;
  now(): number;
}

/** A waiting agent before this host's policy has been applied. */
export type WaitingEvent = Omit<AttentionPayload, "quiet">;

/**
 * This host's verdict on a waiting agent: not announced at all when its user
 * turned waiting notifications off, quiet (inbox only) during its quiet hours.
 * A Shell showing another host must not decide this from that host's settings.
 */
export function waitingPolicy(
  settings: ReturnType<MetricsHostDeps["notificationSettings"]>,
  now: Date
): "silent" | "quiet" | "announce" {
  if (settings.enabled === false || settings.waitingEnabled === false) return "silent";
  return isScheduledQuietNow(settings, now) ? "quiet" : "announce";
}

/** One reminder per agent per window: a flapping FSM must not page a Shell repeatedly. */
export const ATTENTION_COOLDOWN_MS = 60_000;

function postSummary(session: LinkSession, summary: HostMetricsSummary): void {
  if (!session.isOpen) return;
  try {
    // A full queue drops this frame; the next one follows in a few seconds.
    session.post({ lane: Lane.CONTROL, kind: ControlKind.HOST_SUMMARY, body: summary });
  } catch (error) {
    console.warn("[HostMetrics] Couldn't post a summary:", error);
  }
}

function stripHostId<T extends { hostId: string }>(entry: T): Omit<T, "hostId"> {
  const { hostId: _hostId, ...rest } = entry;
  return rest;
}

/**
 * Host side of the overview and fleet features. Every attached Shell gets
 * this host's summary each sample, whether or not it shows any of its
 * projects, and can list its agents and worktrees and submit fleet prompts.
 * Agents that start waiting are announced to every Shell; each Shell decides
 * whether its user opted in to hearing about this host.
 */
export function installHostMetricsHostWith(
  server: MetricsSessionSource,
  deps: MetricsHostDeps
): () => void {
  const wired = new WeakSet<LinkSession>();
  const lastAttention = new Map<string, number>();

  const wire = ({ session, sessionId }: MetricsSessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    session.registerCallHandler(
      MetricsLinkMethod.LIST_FLEET_TARGETS,
      EmptyPayloadSchema,
      async () => {
        const { targets, complete } = await deps.listFleetTargets();
        return { targets: targets.map(stripHostId), complete };
      }
    );
    session.registerCallHandler(
      MetricsLinkMethod.SUBMIT_FLEET,
      SubmitFleetPayloadSchema,
      async ({ terminalId, text, opId }) => {
        await deps.submitFleet(terminalId, text, { kind: "remote", sessionId }, opId ?? null);
        return null;
      }
    );
    session.registerCallHandler(MetricsLinkMethod.LIST_WORKTREES, EmptyPayloadSchema, async () =>
      (await deps.listWorktrees()).map(stripHostId)
    );
    const latest = deps.loop.latest();
    if (latest) postSummary(session, latest);
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession((ctx) => {
    wire(ctx);
    ensureLoop();
  });

  // Sample only while some Shell is attached; the loop stops itself when the last one leaves.
  let offLoop: (() => void) | null = null;
  const stopLoop = (): void => {
    offLoop?.();
    offLoop = null;
  };
  const ensureLoop = (): void => {
    if (offLoop) return;
    offLoop = deps.loop.subscribe((summary) => {
      const sessions = server.sessions.filter((ctx) => ctx.session.isOpen);
      if (sessions.length === 0) {
        stopLoop();
        return;
      }
      for (const ctx of sessions) postSummary(ctx.session, summary);
    });
  };
  if (server.sessions.length > 0) ensureLoop();

  const offWaiting = deps.onAgentWaiting((event) => {
    const now = deps.now();
    let policy: ReturnType<typeof waitingPolicy>;
    try {
      policy = waitingPolicy(deps.notificationSettings(), new Date(now));
    } catch (error) {
      console.warn("[HostMetrics] Couldn't read notification settings:", error);
      return;
    }
    if (policy === "silent") return;
    const payload: AttentionPayload = { ...event, quiet: policy === "quiet" };
    const last = lastAttention.get(payload.terminalId);
    if (last !== undefined && now - last < ATTENTION_COOLDOWN_MS) return;
    lastAttention.set(payload.terminalId, now);
    if (lastAttention.size > 1000) {
      for (const [terminalId, at] of lastAttention) {
        if (now - at >= ATTENTION_COOLDOWN_MS) lastAttention.delete(terminalId);
      }
    }
    for (const ctx of server.sessions) {
      if (!ctx.session.isOpen) continue;
      ctx.session.call(MetricsLinkMethod.ATTENTION, payload).catch(() => {
        // A Shell that can't take it now has nothing to retry: the agent's state is on screen.
      });
    }
  });

  return () => {
    offSession();
    stopLoop();
    offWaiting();
  };
}

/** Wire the real sampler, fleet and worktree reads and agent-state events into a host server. */
export async function installHostMetricsHost(server: MetricsSessionSource): Promise<() => void> {
  const [{ getLocalSummaryLoop }, ops, { events }, { projectStore }, { getPtyClient }, registry] =
    await Promise.all([
      import("./localLoop.js"),
      import("./hostOps.js"),
      import("../../services/events.js"),
      import("../../services/ProjectStore.js"),
      import("../../window/serviceRefs.js"),
      import("../../../shared/config/agentRegistry.js"),
    ]);
  return installHostMetricsHostWith(server, {
    loop: getLocalSummaryLoop(),
    listFleetTargets: ops.listLocalFleetTargets,
    submitFleet: ops.submitLocalFleet,
    listWorktrees: ops.listLocalWorktrees,
    onAgentWaiting(listener) {
      return events.on("agent:state-changed", (payload) => {
        if (payload.state !== "waiting") return;
        if (payload.previousState !== "working" && payload.previousState !== "directing") return;
        const terminalId = payload.terminalId;
        if (!terminalId) return;
        const projectId = getPtyClient()?.getTerminalProjectId(terminalId) ?? null;
        const project = projectId ? projectStore.getProjectById(projectId) : null;
        const agentName = payload.agentId
          ? (registry.getAgentConfig(payload.agentId)?.name ?? payload.agentId)
          : null;
        listener({ kind: "waiting", terminalId, projectName: project?.name ?? null, agentName });
      });
    },
    notificationSettings: () => projectStore.getEffectiveNotificationSettings(),
    now: Date.now,
  });
}
