import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { hostAgentCliNames, type HostMenuRow } from "../hostModel";
import type { ProjectHost } from "../projectHosts";
import { describeProjectDriver } from "./overviewModel";

/** What a fact reads while the host's answer is still out. */
export const CHECKING = "Checking…";

export interface PlacementProjectFacts {
  /** Whether the host has a copy, worded as what that means for the worktree. */
  project: string;
  /** The installed agent CLIs, one per entry; empty when there are none, null when not reported. */
  agentClis: string[] | null;
  /** Who has control of the project there; null when the host has no copy to control. */
  control: string | null;
}

/**
 * What a host reports about this project: whether it has a copy (and so
 * whether the worktree waits on a clone), which agent CLIs it has installed
 * and who has control of the project there. Anything the host didn't say
 * reads "not reported", never as none; a host that is away, or hasn't been
 * asked yet, says nothing about its agents or drivers.
 */
export function describePlacementProjectFacts(
  host: ProjectHost,
  row: HostMenuRow,
  summary: HostMetricsSummary | null
): PlacementProjectFacts {
  const live = host.away === null && summary !== null;
  return {
    project: describePresence(host),
    agentClis: live ? hostAgentCliNames({ ...row, summary }) : null,
    control:
      host.presence === "pending"
        ? CHECKING
        : host.presence !== "has"
          ? null
          : describeControl(live ? describeProjectDriver(summary, host.projectIds) : null),
  };
}

function describePresence(host: ProjectHost): string {
  switch (host.presence) {
    case "has":
      return host.isCurrent ? "Has this project" : "Has a copy";
    case "none":
      return "No copy yet, so it's cloned there first";
    case "pending":
      return CHECKING;
    default:
      return "Not reported";
  }
}

function describeControl(driver: string | null): string {
  if (driver === null) return "Not reported";
  return driver === "" ? "Nobody has control" : driver;
}
