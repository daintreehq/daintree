import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { pluralize } from "@/lib/pluralize";
import { describeHostMenuState } from "./hostModel";
import type { ProjectHost } from "./projectHosts";
import { describeObserved, ROW_BANDS, type HostProjectSummary } from "./projectHostSummary";

/**
 * What a host row shows right of its name: the counts, or the one phrase that
 * stands in for them. "away" is the link's own words while what the host says
 * isn't current; "note" is what the host said of this project instead of
 * counts; "checking" is a lookup or a read still out.
 */
export type HostRowStatus =
  | { kind: "counts" }
  | { kind: "away"; text: string }
  | { kind: "note"; text: string }
  | { kind: "checking" };

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
      return { kind: "checking" };
    case "has":
      break;
  }
  if (!summary) return { kind: "checking" };
  // What the host listed, said as listed: a host also lists nothing for a
  // project it couldn't read, so an empty list is not "closed there".
  if (summary.worktreeCount === 0) return { kind: "note", text: "No worktrees" };
  if (summary.observed.size === 0) return { kind: "note", text: "No agents" };
  if (ROW_BANDS.every((band) => summary.counts[band] === 0)) {
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

/**
 * The link, only when it is the story: "Not connected · last seen 3 hours
 * ago", "No reply · last heard 2 minutes ago". Null while it is up and
 * answering, and for this machine, which has no link.
 */
export function describeLinkTrouble(host: ProjectHost, now: number = Date.now()): string | null {
  const row = host.row;
  if (row.isLocal || !host.away) return null;
  const { state, note } = describeHostMenuState(row, now);
  const parts = [state ?? host.away];
  if (note) parts.push(lowerFirst(note));
  else if (row.connection?.status === "disconnected" && row.lastSeenAt !== null) {
    parts.push(`last seen ${formatRelativeTime(row.lastSeenAt, now)}`);
  }
  return parts.join(" · ");
}

/** A host row's tooltip, in the order it is read: who, what is going on there, how to act. */
export interface HostTooltip {
  /** The full host name, which the row may have clipped. */
  title: string;
  /** "This window" beside the title, for the window's own host. */
  note: string | null;
  /** At most two short lines: the agents observed, then where they are. */
  lines: string[];
  /** What a click does; null for the window's own host, where a click does nothing. */
  hint: string | null;
}

/** "4 worktrees · active 2 minutes ago", or "in 2 checkouts" when the project is checked out twice there. */
function describeWhere(host: ProjectHost, summary: HostProjectSummary, now: number): string {
  const parts = [pluralize(summary.worktreeCount, "worktree")];
  if (host.projectIds.length > 1) parts[0] += ` in ${host.projectIds.length} checkouts`;
  if (summary.latestActivityAt !== null) {
    parts.push(`active ${formatRelativeTime(summary.latestActivityAt, now)}`);
  }
  return parts.join(" · ");
}

export function hostRowTooltip(
  host: ProjectHost,
  summary: HostProjectSummary | null,
  newWindowKey: string,
  now: number = Date.now()
): HostTooltip {
  const lines: string[] = [];
  const trouble = describeLinkTrouble(host, now);
  const opensSetup = !host.away && (host.presence === "none" || host.presence === "unknown");
  if (trouble) lines.push(trouble);
  else if (host.presence === "none") lines.push("No project here shares this repository");
  else if (host.presence === "unknown") lines.push("Couldn't check for this project");
  else if (host.presence === "pending" || !summary) lines.push("Checking for this project…");
  else if (summary.worktreeCount === 0) lines.push("No worktrees listed");
  else {
    lines.push(
      summary.observed.size === 0
        ? "No agents observed"
        : `${describeObserved(summary.observed, " · ")} (observed)`
    );
    lines.push(describeWhere(host, summary, now));
  }
  const action = opensSetup ? "Click to open it there" : "Click to switch";
  return {
    title: host.hostName,
    note: host.isCurrent ? "This window" : null,
    lines,
    hint: host.isCurrent ? null : `${action} · ${newWindowKey}-click: new window`,
  };
}

/** The host row's spoken name: the same facts as its tooltip's first lines, in one sentence. */
export function hostRowLabel(host: ProjectHost, summary: HostProjectSummary | null): string {
  const name = host.isCurrent ? `${host.hostName}, this window` : host.hostName;
  const status = hostRowStatus(host, summary);
  if (status.kind === "checking") return `${name}, checking`;
  // Whatever the row shows for its agents, the spoken name gives every band observed.
  if (status.kind !== "away" && summary && summary.worktreeCount > 0) {
    return summary.observed.size === 0
      ? `${name}, no agents observed`
      : `${name}: ${describeObserved(summary.observed)} (observed)`;
  }
  return status.kind === "counts" ? name : `${name}, ${status.text.toLowerCase()}`;
}
