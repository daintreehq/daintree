import type { HostId, HostMetricsSummary } from "../remoteHosts.js";

export interface HostMetricsSnapshot {
  hostId: HostId;
  /** Newest first, ~15 minutes at the sample interval. */
  history: HostMetricsSummary[];
}

export type HostMetricsEvent = { type: "summary"; summary: HostMetricsSummary };
