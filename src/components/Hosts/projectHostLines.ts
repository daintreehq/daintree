import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { bandLabel } from "@/lib/fleetAttention";
import { pluralize } from "@/lib/pluralize";
import { describeHostMenuState, liveSummary } from "./hostModel";
import { describeRtt } from "./Overview/overviewModel";
import type { ProjectHost } from "./projectHosts";
import { describeObserved, type HostAsk, type HostProjectSummary } from "./projectHostSummary";

/**
 * What a host row shows right of its name: the counts, or the one phrase that
 * stands in for them. "away" is the link's own words while what the host says
 * isn't current; "note" is what the host said of this project instead of counts.
 */
export type HostRowStatus =
  | { kind: "counts" }
  | { kind: "away"; text: string }
  | { kind: "note"; text: string }
  | { kind: "none" };

export function hostRowStatus(
  host: ProjectHost,
  summary: HostProjectSummary | null
): HostRowStatus {
  if (host.away) return { kind: "away", text: host.away };
  switch (host.presence) {
    case "none":
      return { kind: "note", text: "Not added" };
    case "unknown":
      return { kind: "note", text: "Couldn't check" };
    case "pending":
      return { kind: "none" };
    case "has":
      break;
  }
  // Not read yet: nothing rather than a guess.
  if (!summary) return { kind: "none" };
  // What the host listed, said as listed: a host also lists nothing for a
  // project it couldn't read, so an empty list is not "closed there".
  if (summary.worktreeCount === 0) return { kind: "note", text: "No worktrees" };
  if (summary.observed.size === 0) return { kind: "note", text: "No agents" };
  const counted = summary.counts.quiet + summary.counts.review + summary.counts.running;
  if (counted === 0 && summary.asks.length === 0) {
    // Every agent in a band the row doesn't count (finished, parked, idle…):
    // how many there are, never a verdict on what they are doing.
    let agents = 0;
    for (const n of summary.observed.values()) agents += n;
    return { kind: "note", text: pluralize(agents, "agent") };
  }
  return { kind: "counts" };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "Connected · 9 ms", "Not connected · last seen 3 hours ago"; null for this machine. */
export function describeHostLink(host: ProjectHost, now: number = Date.now()): string | null {
  const row = host.row;
  if (row.isLocal) return null;
  const { state, note } = describeHostMenuState(row, now);
  const parts = [state ?? "Connecting…"];
  const rtt = describeRtt(row);
  if (rtt && !host.away) parts.push(rtt);
  if (note) parts.push(lowerFirst(note));
  else if (row.connection?.status === "disconnected" && row.lastSeenAt !== null) {
    parts.push(`last seen ${formatRelativeTime(row.lastSeenAt, now)}`);
  }
  return parts.join(" · ");
}

/** What the host said of this project, or why it said nothing. */
function describeProjectThere(host: ProjectHost, summary: HostProjectSummary | null): string {
  if (host.presence === "none") return "No project here shares this repository";
  if (host.presence === "unknown") {
    return host.away ? "Not checked while not connected" : "Couldn't check this host";
  }
  if (host.presence === "pending") return "Checking for this project…";
  if (host.away) return "Agents not shown while not connected";
  if (!summary) return "Reading worktrees…";
  if (summary.worktreeCount === 0) return `No worktrees listed on ${host.hostName}`;
  const checkouts = host.projectIds.length > 1 ? ` in ${host.projectIds.length} checkouts` : "";
  return `${pluralize(summary.worktreeCount, "worktree")}${checkouts}`;
}

/** CPU and memory as the host last measured them, labelled as the whole machine's. */
function describeHostWide(host: ProjectHost): string | null {
  if (host.away) return null;
  const summary = liveSummary(host.row);
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.cpuPercent !== null) parts.push(`CPU ${Math.round(summary.cpuPercent)}%`);
  if (summary.memoryPressure !== null) parts.push(`memory ${summary.memoryPressure}`);
  return parts.length > 0 ? `Host-wide: ${parts.join(" · ")}` : null;
}

/** What a click on the row does, as the tooltip's last line. */
export function describeHostRowClick(host: ProjectHost, newWindowKey: string): string {
  if (host.isCurrent) return "Showing in this window";
  if (!host.away && (host.presence === "none" || host.presence === "unknown")) {
    return `Click to open this project there · ${newWindowKey}-click for a new window`;
  }
  return `Click to switch · ${newWindowKey}-click for a new window`;
}

/** The host row's tooltip: project first, machine second, then what a click does. */
export function hostRowTooltip(
  host: ProjectHost,
  summary: HostProjectSummary | null,
  newWindowKey: string,
  now: number = Date.now()
): string[] {
  const lines = [host.isCurrent ? `${host.hostName} · this window` : host.hostName];
  const link = describeHostLink(host, now);
  if (link) lines.push(link);
  lines.push(describeProjectThere(host, summary));
  if (!host.away && summary && summary.worktreeCount > 0) {
    lines.push(
      summary.observed.size === 0
        ? "No agents observed"
        : `${describeObserved(summary.observed)} (observed)`
    );
    if (summary.latestActivityAt !== null) {
      lines.push(`Latest worktree activity ${formatRelativeTime(summary.latestActivityAt, now)}`);
    }
  }
  const hostWide = describeHostWide(host);
  if (hostWide) lines.push(hostWide);
  lines.push(describeHostRowClick(host, newWindowKey));
  return lines;
}

/** The host row's spoken name: the same facts as its tooltip's first lines, in one sentence. */
export function hostRowLabel(host: ProjectHost, summary: HostProjectSummary | null): string {
  const name = host.isCurrent ? `${host.hostName}, this window` : host.hostName;
  const status = hostRowStatus(host, summary);
  if (status.kind === "none") return name;
  // Whatever the row shows for its agents, the spoken name gives every band observed.
  if (status.kind !== "away" && summary && summary.worktreeCount > 0) {
    return summary.observed.size === 0
      ? `${name}, no agents observed`
      : `${name}: ${describeObserved(summary.observed)} (observed)`;
  }
  return status.kind === "counts" ? name : `${name}, ${status.text.toLowerCase()}`;
}

export function askLabel(ask: HostAsk): string {
  return bandLabel(ask.band, { agentState: ask.agentState ?? undefined });
}

export function askRowLabel(ask: HostAsk, hostName: string): string {
  return `${ask.branch} on ${hostName}, ${askLabel(ask).toLowerCase()} (observed)`;
}

export function askTooltip(
  ask: HostAsk,
  host: ProjectHost,
  newWindowKey: string,
  now: number = Date.now()
): string[] {
  const lines = [ask.branch, `${askLabel(ask)} on ${host.hostName} (observed)`];
  const detail: string[] = [];
  if (ask.modifiedCount !== null && ask.modifiedCount > 0) {
    detail.push(`${pluralize(ask.modifiedCount, "file")} changed`);
  }
  if (ask.lastActivityAt !== null) {
    detail.push(`active ${formatRelativeTime(ask.lastActivityAt, now)}`);
  }
  if (detail.length > 0) lines.push(detail.join(" · "));
  lines.push(
    host.isCurrent
      ? "Click to go to this agent"
      : `Click to go to this agent · ${newWindowKey}-click for a new window`
  );
  return lines;
}
