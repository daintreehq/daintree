import type { AgentState } from "../agent.js";
import type { HostDriverObservation, HostId, HostMetricsSummary } from "../remoteHosts.js";
import type { FleetBand } from "../../utils/fleetBands.js";
import type { ProcessInventorySnapshot } from "../processes.js";

export interface HostMetricsSnapshot {
  hostId: HostId;
  /** Newest first, ~15 minutes at the sample interval. */
  history: HostMetricsSummary[];
}

/**
 * A host this Shell has opted in to reports an agent that needs someone. The
 * host decided it; the view it is sent to only presents it.
 */
export interface HostAttentionEvent {
  type: "attention";
  hostId: HostId;
  hostName: string;
  kind: "waiting";
  terminalId: string;
  /** The host's own id for the terminal's project, or null when the host couldn't tell. */
  projectId: string | null;
  projectName: string | null;
  agentName: string | null;
  /**
   * The source host's quiet hours are in effect. The host applied its own
   * notification policy before sending; this Shell adds only focus and its
   * session mute.
   */
  quiet: boolean;
  /**
   * Main already paged for it with a banner, finding no window here focused:
   * the view records it as a blurred window would, so a window focused while
   * it was on its way doesn't toast it as well.
   */
  pagedNatively?: true;
}

/**
 * Something a host's worktree list shows changed there (a worktree came or
 * went, a branch moved, an agent's band changed). It carries nothing: a view
 * showing that host's worktrees reads them again.
 */
export interface HostWorktreesChangedEvent {
  type: "worktrees";
  hostId: HostId;
}

/**
 * The projects registered on a host changed: one was added, removed, moved or
 * renamed there. It carries nothing: a view matching its project against that
 * host asks it again. Agent activity never sends it.
 */
export interface HostProjectsChangedEvent {
  type: "projects";
  hostId: HostId;
}

export type HostMetricsEvent =
  | { type: "summary"; summary: HostMetricsSummary }
  | HostAttentionEvent
  | HostWorktreesChangedEvent
  | HostProjectsChangedEvent;

/** An agent terminal on some host that a fleet broadcast can target. */
export interface HostFleetTarget {
  hostId: HostId;
  terminalId: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  /** What the host's FSM last observed. */
  agentState: AgentState | null;
}

/**
 * A host's fleet targets as it could read them. `complete` is false when the
 * read missed some terminals (a pty-host shard that didn't answer) or the list
 * was cut at its cap: a target absent from an incomplete list may still exist.
 */
export interface HostFleetTargetList {
  targets: HostFleetTarget[];
  complete: boolean;
}

export interface HostFleetSubmitPayload {
  hostId: HostId;
  terminalId: string;
  text: string;
  /**
   * Minted once per target submit and reused by its retry, so a host that did
   * run a submit whose answer was lost answers the retry instead of running it again.
   */
  opId?: string;
}

/** One worktree of one of a host's open projects, for the read-only all-hosts dashboard. */
export interface HostWorktreeEntry {
  hostId: HostId;
  projectId: string;
  projectName: string;
  worktreeId: string;
  name: string;
  branch: string | null;
  path: string;
  isMainWorktree: boolean;
  modifiedCount: number | null;
  lastActivityAt: number | null;
  /**
   * The most urgent band among the worktree's agents as the host's own fleet
   * observed them, with that agent's state. Null when the host saw no agent
   * there, or (a host from before this was sent) didn't say.
   */
  observed: HostWorktreeObservation | null;
  /**
   * Every agent the host's fleet placed in this worktree, most urgent first,
   * so another machine can count agents rather than worktrees and land on the
   * one it names. Absent from a host from before this was sent.
   */
  runs?: HostWorktreeRun[];
}

export interface HostWorktreeObservation {
  band: FleetBand;
  agentState: AgentState | null;
}

export interface HostWorktreeRun extends HostWorktreeObservation {
  /** The agent's terminal on that host, which a switch there can focus. */
  terminalId: string;
}

/** Why a Shell that asked to resume its session got a fresh one instead. */
export type HostLinkResumeRefusal = "session-unknown" | "secret-mismatch" | "client-mismatch";

/** What a host told a Shell it turned away at the handshake. */
export type HostLinkRefusalReason =
  "unauthorized" | "version-mismatch" | "protocol" | "busy" | "shutting-down";

/** Why a host ended a session for good: nothing can resume it after this. */
export type HostLinkEndCause =
  | "goodbye"
  | "protocol-error"
  | "grace-expired"
  | "session-cap"
  | "session-replaced"
  | "host-shutdown";

interface HostLinkEventBase {
  /** By the host's clock. */
  at: number;
  /** The Shell's launch: a relaunch of the same machine has a new one. */
  clientId: string;
  clientName: string;
}

/**
 * One thing a host's listener saw happen to a link, in its own terms: what
 * was said or observed, never a guess at why.
 */
export type HostLinkEvent =
  | (HostLinkEventBase & {
      kind: "session-started";
      sessionId: string;
      /** The Shell asked to resume a session and got this one instead. */
      previousNotResumed: HostLinkResumeRefusal | null;
    })
  | (HostLinkEventBase & {
      kind: "session-resumed";
      sessionId: string;
      /** The old link hadn't been seen to drop yet; this one replaced it. */
      overLiveLink: boolean;
    })
  | (HostLinkEventBase & {
      kind: "link-dropped";
      sessionId: string;
      /** The link's own close reason, such as "socket closed" or "idle timeout". */
      reason: string;
      by: "local" | "remote" | "transport";
    })
  | (HostLinkEventBase & {
      kind: "session-ended";
      sessionId: string;
      cause: HostLinkEndCause;
      /** The close reason, when the link closing is what ended it. */
      reason: string | null;
    })
  | (HostLinkEventBase & {
      kind: "refused";
      reason: HostLinkRefusalReason;
      detail: string | null;
      /** The same refusal to the same launch, retried with nothing admitted between. */
      count: number;
      lastAt: number;
    });

/** A Shell launch attached to a host right now, one per session. */
export interface HostAttachedShell {
  sessionId: string;
  clientId: string;
  clientName: string;
  platform: "darwin" | "linux" | "win32";
  /** When this session first connected, by the host's clock; a resume keeps it. */
  connectedAt: number;
  /** Projects this launch holds the lease for. */
  drivingProjectIds: string[];
}

/** What a host reports about its links: recent events, who drives what, and who is attached. */
export interface HostLinkActivity {
  /** The host's clock when it answered. */
  observedAt: number;
  /** When this host's listener started taking connections; null when it isn't. */
  listeningSince: number | null;
  /** The build that listener runs. */
  version: string;
  commit: string;
  /** Newest first. */
  events: HostLinkEvent[];
  /** Older events were let go to keep the list bounded. */
  eventsTruncated: boolean;
  drivers: HostDriverObservation[];
  attached: HostAttachedShell[];
}

export type HostLinkActivityResult =
  | {
      supported: true;
      activity: HostLinkActivity;
      /** This Shell's own launch, so its rows can say so. */
      self: { clientId: string; clientName: string } | null;
    }
  /** A host from before it could report this. */
  | { supported: false };

/** A host's process inventory, as its Processes view lists it, bounded for the link. */
export interface RemoteProcessInventory extends ProcessInventorySnapshot {
  /** Some rows were let go to keep the answer bounded. */
  truncated: boolean;
}

export type HostProcessInventoryResult =
  | { supported: true; inventory: RemoteProcessInventory }
  /** A host from before it could report this. */
  | { supported: false };
