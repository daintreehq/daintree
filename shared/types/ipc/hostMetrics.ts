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

export interface HostFleetSubmitPayload {
  hostId: HostId;
  terminalId: string;
  text: string;
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
