import type {
  HostFleetTargetList,
  HostLinkActivity,
  HostWorktreeEntry,
  RemoteProcessInventory,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { ProcessInventorySnapshot } from "../../../shared/types/processes.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import type { HostRestartImpact } from "../../../shared/types/ipc/remoteHosts.js";
import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import { Lane } from "../link/frames.js";
import { ControlKind, type LinkClientInfo } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { EmptyPayloadSchema } from "../host/linkMethods.js";
import type { FleetCaller } from "./hostOps.js";
import { WorktreeChangeWatch } from "./worktreeChanges.js";
import { boundProcessInventory } from "./processInventoryWire.js";
import {
  MAX_RESTART_SHELLS,
  MetricsLinkMethod,
  SubmitFleetPayloadSchema,
  type AttentionPayload,
} from "./linkMethods.js";
import { createLogger } from "../../utils/logger.js";
import { createKeyedLogLimiter } from "../../utils/keyedLogLimiter.js";

const logger = createLogger("main:hostMetricsHost");
const logLimiter = createKeyedLogLimiter();

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
    /** How old a summary is by this host's own clocks; null when it can't say. */
    ageOf?(summary: HostMetricsSummary): number | null;
  };
  listFleetTargets(): Promise<HostFleetTargetList>;
  submitFleet(
    terminalId: string,
    text: string,
    caller: FleetCaller,
    opId: string | null
  ): Promise<void>;
  listWorktrees(): Promise<HostWorktreeEntry[]>;
  /** This host's terminals and running operations: what a restart would end here. */
  restartTerminals(): Promise<LocalRestartTerminals>;
  /**
   * Told when something the worktree list shows may have changed: a worktree
   * came, went or moved branch, or an agent's state did. Called freely; the
   * list is read again and compared before any Shell hears about it.
   */
  onWorktreesMaybeChanged(listener: () => void): () => void;
  /** How long a burst of those is gathered; the default outside tests. */
  worktreesChangedDelayMs?: number;
  /**
   * Told when which projects are registered here changed (added, removed,
   * moved, renamed): what a Shell's match of its project against this host
   * depends on. Agent activity never calls it.
   */
  onProjectsChanged(listener: () => void): () => void;
  /** Told when one of this host's agents goes from working to waiting. */
  onAgentWaiting(listener: (payload: WaitingEvent) => void): () => void;
  /**
   * This host's own notification settings under `projectId`'s overrides,
   * which decide only for a Shell that never sent its own choices (one from
   * before #14701).
   */
  notificationSettings(
    projectId: string | null
  ): Pick<
    NotificationSettings,
    | "enabled"
    | "waitingEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartMin"
    | "quietHoursEndMin"
    | "quietHoursWeekdays"
  >;
  /** Whether the Shell decides which of this host's agents alert it, by its own settings. */
  shellDecides(clientId: string): boolean;
  now(): number;
}

/** What a restart ends on this machine, before the attached Shells are added. */
export type LocalRestartTerminals = Omit<
  NonNullable<HostRestartImpact["detail"]>,
  "otherShells" | "shellIds"
>;

/** A waiting agent before this host's policy has been applied. */
export type WaitingEvent = Omit<AttentionPayload, "quiet" | "projectId"> & {
  projectId: string | null;
};

/**
 * One machine's verdict on a waiting agent from its own settings: not
 * announced at all with waiting notifications off, quiet (inbox only) during
 * its quiet hours. A Shell judges each host's agents by its own (#14701); a
 * host judges for a Shell from before that, which can't.
 */
export function waitingPolicy(
  settings: ReturnType<MetricsHostDeps["notificationSettings"]>,
  now: Date
): "silent" | "quiet" | "announce" {
  if (settings.enabled === false || settings.waitingEnabled === false) return "silent";
  return isScheduledQuietNow(settings, now) ? "quiet" : "announce";
}

/** This host's own verdict; one it can't read announces nothing. */
function hostWaitingPolicy(
  deps: Pick<MetricsHostDeps, "notificationSettings">,
  projectId: string | null,
  now: number
): ReturnType<typeof waitingPolicy> {
  try {
    return waitingPolicy(deps.notificationSettings(projectId), new Date(now));
  } catch (error) {
    const suppressedCount = logLimiter.take("read-notification-settings");
    if (suppressedCount !== null) {
      logger.warn("Couldn't read notification settings", { error, suppressedCount });
    }
    return "silent";
  }
}

/** One reminder per agent per window and Shell: a flapping FSM must not page a Shell repeatedly. */
export const ATTENTION_COOLDOWN_MS = 60_000;

function postSummary(
  session: LinkSession,
  summary: HostMetricsSummary,
  loop: MetricsHostDeps["loop"]
): void {
  if (!session.isOpen) return;
  // Stamped as it is posted, so a cached sample handed to a new Shell carries its real age (#14462).
  const timing = { sampleAgeMs: loop.ageOf?.(summary) ?? null, afterPing: session.peerPingNonce };
  try {
    // A full queue drops this frame; the next one follows in a few seconds.
    session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.HOST_SUMMARY,
      body: { ...summary, timing },
    });
  } catch (error) {
    const suppressedCount = logLimiter.take("post-summary");
    if (suppressedCount !== null) {
      logger.warn("Couldn't post a summary", { error, suppressedCount });
    }
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

  const wire = ({ session, sessionId, client }: MetricsSessionContext): void => {
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
    session.registerCallHandler(
      MetricsLinkMethod.RESTART_IMPACT,
      EmptyPayloadSchema,
      async (): Promise<HostRestartImpact> => {
        const local = await deps.restartTerminals();
        // Every other Shell attached now loses its session with the restart.
        const others = new Map<string, string>();
        for (const other of server.sessions) {
          if (!other.session.isOpen || other.client.clientId === client.clientId) continue;
          if (others.size >= MAX_RESTART_SHELLS) break;
          others.set(other.client.clientId, other.client.clientName);
        }
        return {
          detail: { ...local, otherShells: [...others.values()], shellIds: [...others.keys()] },
          agents: null,
        };
      }
    );
    const latest = deps.loop.latest();
    if (latest) postSummary(session, latest, deps.loop);
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession((ctx) => {
    wire(ctx);
    ensureLoop();
  });

  // Read only while some Shell is attached, and told only when what it shows moved.
  const worktrees = new WorktreeChangeWatch({
    list: deps.listWorktrees,
    delayMs: deps.worktreesChangedDelayMs,
    active: () => server.sessions.some((ctx) => ctx.session.isOpen),
    changed: () => {
      for (const ctx of server.sessions) {
        if (!ctx.session.isOpen) continue;
        ctx.session.call(MetricsLinkMethod.WORKTREES_CHANGED, null).catch(() => {
          // A Shell that can't take it now reads the list when it next shows it.
        });
      }
    },
  });
  const offWorktrees = deps.onWorktreesMaybeChanged(() => worktrees.poke());
  const offProjects = deps.onProjectsChanged(() => {
    for (const ctx of server.sessions) {
      if (!ctx.session.isOpen) continue;
      ctx.session.call(MetricsLinkMethod.PROJECTS_CHANGED, null).catch(() => {
        // A Shell that can't take it now asks again when it next matches a project here.
      });
    }
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
      for (const ctx of sessions) postSummary(ctx.session, summary, deps.loop);
      // A project closed or removed fires none of the worktree events; the
      // sample tick catches it, and the signature keeps it from saying more.
      worktrees.poke();
    });
  };
  if (server.sessions.length > 0) ensureLoop();

  const offWaiting = deps.onAgentWaiting((event) => {
    const now = deps.now();
    // Read once, and only for a Shell that leaves the verdict to this host.
    let hostPolicy: ReturnType<typeof waitingPolicy> | undefined;
    for (const ctx of server.sessions) {
      if (!ctx.session.isOpen) continue;
      // Per Shell: one this host held an agent back from isn't then held
      // back by the reminder another Shell was sent.
      const key = `${ctx.client.clientId}\0${event.terminalId}`;
      const last = lastAttention.get(key);
      if (last !== undefined && now - last < ATTENTION_COOLDOWN_MS) continue;
      let quiet = false;
      if (!deps.shellDecides(ctx.client.clientId)) {
        hostPolicy ??= hostWaitingPolicy(deps, event.projectId, now);
        if (hostPolicy === "silent") continue;
        quiet = hostPolicy === "quiet";
      }
      lastAttention.set(key, now);
      const payload: AttentionPayload = { ...event, quiet };
      ctx.session.call(MetricsLinkMethod.ATTENTION, payload).catch(() => {
        // A Shell that can't take it now has nothing to retry: the agent's state is on screen.
      });
    }
    if (lastAttention.size > 1000) {
      for (const [key, at] of lastAttention) {
        if (now - at >= ATTENTION_COOLDOWN_MS) lastAttention.delete(key);
      }
    }
  });

  return () => {
    offSession();
    stopLoop();
    offWaiting();
    offWorktrees();
    offProjects();
    worktrees.dispose();
  };
}

/**
 * Answer every attached Shell's `LINK_ACTIVITY`: what this host saw happen to
 * its links, who drives each project, and who is attached. Installed apart
 * from the summaries because what it reads exists only once the listener has
 * its leases and sessions wired.
 */
export function installLinkActivityHost(
  server: MetricsSessionSource,
  read: () => HostLinkActivity
): () => void {
  const wired = new WeakSet<LinkSession>();
  const wire = ({ session }: MetricsSessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    session.registerCallHandler(MetricsLinkMethod.LINK_ACTIVITY, EmptyPayloadSchema, read);
  };
  for (const ctx of server.sessions) wire(ctx);
  return server.onSession(wire);
}

/**
 * Answer every attached Shell's `PROCESS_INVENTORY` with this host's
 * processes, read afresh for each call and bounded for the link. A summary-only
 * session gets it too: no view needs to be bound. Nothing here ends a process.
 */
export function installProcessInventoryHost(
  server: MetricsSessionSource,
  read: () => Promise<ProcessInventorySnapshot>
): () => void {
  const wired = new WeakSet<LinkSession>();
  const wire = ({ session }: MetricsSessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    session.registerCallHandler(
      MetricsLinkMethod.PROCESS_INVENTORY,
      EmptyPayloadSchema,
      async (): Promise<RemoteProcessInventory> => boundProcessInventory(await read())
    );
  };
  for (const ctx of server.sessions) wire(ctx);
  return server.onSession(wire);
}

/** Wire the real sampler, fleet and worktree reads and agent-state events into a host server. */
export async function installHostMetricsHost(server: MetricsSessionSource): Promise<() => void> {
  const [
    { getLocalSummaryLoop },
    ops,
    { events },
    { projectStore },
    { getPtyClient },
    registry,
    { agentNotificationService },
  ] = await Promise.all([
    import("./localLoop.js"),
    import("./hostOps.js"),
    import("../../services/events.js"),
    import("../../services/ProjectStore.js"),
    import("../../window/serviceRefs.js"),
    import("../../../shared/config/agentRegistry.js"),
    import("../../services/AgentNotificationService.js"),
  ]);
  return installHostMetricsHostWith(server, {
    loop: getLocalSummaryLoop(),
    listFleetTargets: ops.listLocalFleetTargets,
    submitFleet: ops.submitLocalFleet,
    listWorktrees: ops.listLocalWorktrees,
    restartTerminals: ops.listLocalRestartTerminals,
    onWorktreesMaybeChanged: ops.onLocalWorktreesMaybeChanged,
    onProjectsChanged: ops.onLocalProjectsChanged,
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
        listener({
          kind: "waiting",
          terminalId,
          projectId,
          projectName: project?.name ?? null,
          agentName,
        });
      });
    },
    notificationSettings: (projectId) => projectStore.getEffectiveNotificationSettings(projectId),
    shellDecides: (clientId) => agentNotificationService.hasShellPolicy(clientId),
    now: Date.now,
  });
}
