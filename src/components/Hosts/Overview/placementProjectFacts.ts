import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { describeHostAgentClis, type HostMenuRow } from "../hostModel";
import type { ProjectHost } from "../projectHosts";
import { describeProjectDriver } from "./overviewModel";

/**
 * What a host reports about this project, one clause each: whether it has a
 * copy, which agent CLIs it has installed and who drives the project there.
 * Anything the host didn't say reads "not reported", never as none; a host
 * that is away, or hasn't been asked yet, says nothing about its agents or
 * drivers.
 */
export function describePlacementProjectFacts(
  host: ProjectHost,
  row: HostMenuRow,
  summary: HostMetricsSummary | null
): string[] {
  const lines: string[] = [];
  switch (host.presence) {
    case "has":
      lines.push(host.isCurrent ? "Has this project" : "Has a copy of this project");
      break;
    case "none":
      lines.push("No copy of this project, would clone it");
      break;
    case "pending":
      lines.push("Checking for this project…");
      break;
    default:
      lines.push("Copy of this project not reported");
  }
  const live = host.away === null && summary !== null;
  if (!live) {
    lines.push("Agent CLIs not reported");
  } else {
    const clis = describeHostAgentClis({ ...row, summary });
    lines.push(clis ? `Agent CLIs: ${clis}` : "No agent CLIs reported");
  }
  if (host.presence === "has") {
    const driver = live ? describeProjectDriver(summary, host.projectIds) : null;
    if (driver === null) lines.push("Who drives it not reported");
    else lines.push(driver === "" ? "Nobody drives it" : driver);
  }
  return lines;
}
