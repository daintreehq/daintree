import type { AgentState } from "../agent.js";
import type { HostId, HostMetricsSummary } from "../remoteHosts.js";

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
  projectName: string | null;
  agentName: string | null;
  /**
   * The source host's quiet hours are in effect. The host applied its own
   * notification policy before sending; this Shell adds only focus and its
   * session mute.
   */
  quiet: boolean;
}

export type HostMetricsEvent =
  { type: "summary"; summary: HostMetricsSummary } | HostAttentionEvent;

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
}
