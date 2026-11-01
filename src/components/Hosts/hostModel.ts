import {
  LOCAL_HOST_ID,
  type HandshakeMismatch,
  type HostConnectionState,
  type HostId,
  type HostListEntry,
  type HostMetricsSummary,
  type HostPlatform,
  type HostRecentUse,
} from "@shared/types/remoteHosts";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { compareReleaseVersions } from "@shared/utils/hostBuildOrder";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { isMac, isWindows } from "@/lib/platform";
import { pluralize } from "@/lib/pluralize";
import { describeBuildMismatch } from "@/components/Settings/Hosts/hostLabels";

/** Action the host menu's "Hosts overview…" entry dispatches, once something registers it. */
export const HOSTS_OVERVIEW_ACTION_ID = "host.overview.open";

/** Settings tab the "Add host…" action opens. */
export const HOSTS_SETTINGS_TAB = "hosts";

export type ClientPlatform = HostPlatform | "win32";

/** This machine's own platform, which names it — never the window's host's. */
export function clientPlatform(): ClientPlatform {
  if (isMac()) return "darwin";
  return isWindows() ? "win32" : "linux";
}

/** What this machine is called in the host menu: never its hostname, which the user didn't choose. */
export function localHostLabel(platform: ClientPlatform): string {
  return platform === "darwin" ? "This Mac" : "This machine";
}

/**
 * A host name in the chip's three truncation parts. The machine's own label is
 * what tells two hosts apart, so with a domain after it the label's last eight
 * characters are kept and the domain goes first. An IP address has no label.
 */
export function splitHostName(name: string): {
  nameHead: string;
  nameTail: string;
  nameDomain: string;
} {
  const dot = name.indexOf(".");
  const isAddress = /^[\d.:]+$/.test(name) || name.includes(":");
  const label = dot > 0 && !isAddress ? name.slice(0, dot) : name;
  return {
    nameHead: label.slice(0, -8),
    nameTail: label.slice(-8),
    nameDomain: name.slice(label.length),
  };
}

export interface HostMenuRow {
  hostId: HostId;
  name: string;
  isLocal: boolean;
  /** Null until a handshake has reported it. */
  platform: HostPlatform | null;
  /** Null for this machine, whose own backend is always there. */
  connection: HostConnectionState | null;
  lastSeenAt: number | null;
  summary: HostMetricsSummary | null;
  isCurrent: boolean;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** What a host's summary says it runs on; only this Shell's own summary can say Windows, and it is not a host. */
function reportedPlatform(summary: HostMetricsSummary | null): HostPlatform | null {
  const platform = summary?.platform;
  return platform === undefined || platform === "win32" ? null : platform;
}

/** This machine first, then every other host alphabetically by name. */
export function buildHostMenuRows(
  entries: readonly HostListEntry[],
  options: {
    localPlatform: ClientPlatform;
    currentHostId: HostId;
    localSummary: HostMetricsSummary | null;
  }
): HostMenuRow[] {
  const local: HostMenuRow = {
    hostId: LOCAL_HOST_ID,
    name: localHostLabel(options.localPlatform),
    isLocal: true,
    platform: options.localPlatform === "win32" ? null : options.localPlatform,
    connection: null,
    lastSeenAt: null,
    summary: options.localSummary,
    isCurrent: options.currentHostId === LOCAL_HOST_ID,
  };
  const remote = entries
    .filter((entry) => entry.descriptor.id !== LOCAL_HOST_ID)
    .map<HostMenuRow>((entry) => ({
      hostId: entry.descriptor.id,
      name: entry.descriptor.name,
      isLocal: false,
      platform: reportedPlatform(entry.summary) ?? entry.descriptor.platform,
      connection: entry.connection,
      lastSeenAt: lastSeenOf(entry),
      summary: entry.summary,
      isCurrent: options.currentHostId === entry.descriptor.id,
    }))
    .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.hostId, b.hostId));
  return [local, ...remote];
}

/**
 * The switcher's order: the window's own host first, then every other host by
 * when a window here last landed on it. Hosts never switched to follow, this
 * machine first (it needs no link), then by name. Nothing in it changes while
 * the switcher is open, so no row moves under the cursor.
 */
export function orderHostRowsByRecency(
  rows: readonly HostMenuRow[],
  recents: readonly HostRecentUse[]
): HostMenuRow[] {
  const usedAt = new Map(recents.map((entry) => [entry.hostId, entry.lastUsedAt]));
  return [...rows].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aUsed = usedAt.get(a.hostId);
    const bUsed = usedAt.get(b.hostId);
    if (aUsed !== undefined || bUsed !== undefined) {
      if (aUsed === undefined) return 1;
      if (bUsed === undefined) return -1;
      if (aUsed !== bUsed) return bUsed - aUsed;
    }
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return collator.compare(a.name, b.name) || collator.compare(a.hostId, b.hostId);
  });
}

/**
 * The row's link at a glance: live (its numbers are current), connecting,
 * attention (linked but silent, or a link that can't work as things stand),
 * or offline: nothing flowing, and nothing to do but connect.
 */
export type HostLinkTone = "live" | "connecting" | "attention" | "offline";

export function hostLinkTone(row: HostMenuRow): HostLinkTone {
  if (row.isLocal) return "live";
  const connection = row.connection;
  if (!connection) return "connecting";
  switch (connection.status) {
    case "connected":
      // Silent: what it last reported is no longer the host now.
      return connection.quietSince !== undefined ? "attention" : "live";
    case "local":
    case "driven-elsewhere":
      return "live";
    case "connecting":
      return "connecting";
    case "version-mismatch":
      return "attention";
    case "unreachable":
      // Tried and stopped: ssh couldn't log in, or Host mode is off there.
      return connection.stoppedRetrying ? "attention" : "offline";
    case "disconnected":
      return "offline";
  }
}

function lastSeenOf(entry: HostListEntry): number | null {
  if (entry.connection.status === "unreachable" && entry.connection.lastSeenAt !== null) {
    return entry.connection.lastSeenAt;
  }
  return entry.descriptor.lastSeenAt;
}

/** A row's metrics only count while the link is up: a disconnected host has told us nothing new. */
export function liveSummary(row: HostMenuRow): HostMetricsSummary | null {
  if (row.isLocal) return row.summary;
  return row.connection?.status === "connected" ? row.summary : null;
}

function lastSeenSuffix(lastSeenAt: number | null, now: number): string {
  return lastSeenAt === null ? "" : ` · last seen ${formatRelativeTime(lastSeenAt, now)}`;
}

/**
 * The row's status line: what the link says, and while it is up, what the
 * host last reported. Missing numbers are left out rather than shown as zero.
 */
export function describeHostRowStatus(row: HostMenuRow, now: number = Date.now()): string | null {
  const connection = row.connection;
  if (connection && connection.status !== "connected" && connection.status !== "local") {
    switch (connection.status) {
      case "connecting":
        return connection.restarting ? "Restarting…" : "Connecting…";
      case "disconnected":
        return `Not connected${lastSeenSuffix(row.lastSeenAt, now)}`;
      case "unreachable":
        if (connection.restarting) return "Restarting…";
        return connection.hostModeOff
          ? `Not listening${lastSeenSuffix(row.lastSeenAt, now)}`
          : `Unreachable${lastSeenSuffix(row.lastSeenAt, now)}`;
      case "version-mismatch":
        return `Runs a different build (${connection.remote.version})`;
      case "driven-elsewhere":
        return `${connection.driver.clientName} has control`;
    }
  }
  // Connected anyway to a different build: said on every line the row shows.
  const differs =
    connection?.status === "connected" && connection.buildMismatch
      ? ` · ${describeBuildMismatch(connection.buildMismatch)}`
      : "";
  const summary = liveSummary(row);
  if (!summary) return row.isLocal ? null : `Connected${differs}`;
  const agents: string[] = [];
  const observed = summary.agentsObserved;
  // Waiting and blocked are the host's own fleet bands, never the raw waits.
  const attention = observed ? summary.agentAttention : undefined;
  if (observed && observed.working > 0) agents.push(`${observed.working} working`);
  if (attention && attention.waiting > 0) agents.push(`${attention.waiting} waiting`);
  if (attention && attention.blocked > 0) agents.push(`${attention.blocked} blocked`);
  // A failed read is unknown, not zero.
  const projects =
    summary.projectCount === null ? "Projects unknown" : pluralize(summary.projectCount, "project");
  // Agent states are what the host's output heuristics saw, and say so.
  return agents.length > 0
    ? `${projects} · ${agents.join(" · ")} (observed)${differs}`
    : `${projects}${differs}`;
}

/**
 * A host menu row's short state, right of its name, and the one note under it
 * when something about the link changes what picking it does. The menu is a
 * place switcher: load, activity and versions live in the overview and the
 * host's details, never here.
 */
export function describeHostMenuState(
  row: HostMenuRow,
  now: number = Date.now()
): { state: string | null; note: string | null } {
  if (row.isLocal) return { state: "Local", note: null };
  const connection = row.connection;
  if (!connection) return { state: null, note: null };
  switch (connection.status) {
    case "connected":
      if (connection.quietSince !== undefined) {
        return {
          state: "No reply",
          note: `Last heard ${formatRelativeTime(connection.quietSince, now)}`,
        };
      }
      return { state: "Connected", note: null };
    case "local":
      return { state: "Connected", note: null };
    case "connecting":
      return { state: connection.restarting ? "Restarting…" : "Connecting…", note: null };
    case "disconnected":
      return { state: "Not connected", note: null };
    case "unreachable":
      // The host said it was shutting down: one restart, not a failed dial each time.
      if (connection.restarting) return { state: "Restarting…", note: null };
      // The machine answered and no Daintree is listening there: quit, not
      // started since a reboot, or never set up all look the same from here.
      if (connection.hostModeOff) {
        return {
          state: "Not listening",
          note:
            row.lastSeenAt === null ? null : `Last seen ${formatRelativeTime(row.lastSeenAt, now)}`,
        };
      }
      // The same answer the chip gives: SSH reached it and refused the login.
      if (connection.stoppedRetrying) return { state: "Can't log in", note: null };
      return {
        state: "Unreachable",
        note:
          row.lastSeenAt === null ? null : `Last seen ${formatRelativeTime(row.lastSeenAt, now)}`,
      };
    case "version-mismatch":
      return { state: "Can't connect", note: "Needs a compatible build" };
    case "driven-elsewhere":
      return { state: "Connected", note: `${connection.driver.clientName} has control` };
  }
}

/**
 * When the row's note is an age ("Last seen 3 hours ago"), its words and the
 * moment, so the menu can draw it with its exact time one hover away. Mirrors
 * the notes {@link describeHostMenuState} writes; null for every other note.
 */
export function hostMenuNoteAge(row: HostMenuRow): { prefix: string; at: number } | null {
  const connection = row.connection;
  if (row.isLocal || !connection) return null;
  if (connection.status === "connected" && connection.quietSince !== undefined) {
    return { prefix: "Last heard ", at: connection.quietSince };
  }
  // The same rows describeHostMenuState gives a last-seen note: not one ssh refused.
  if (
    connection.status === "unreachable" &&
    !connection.restarting &&
    (connection.hostModeOff === true || !connection.stoppedRetrying) &&
    row.lastSeenAt !== null
  ) {
    return { prefix: "Last seen ", at: row.lastSeenAt };
  }
  return null;
}

/**
 * Whether the row's link is a problem worth its own mark: the same set the
 * chip marks for its own host. Connecting and not connected are not.
 */
export function hostMenuRowHasTrouble(row: HostMenuRow): boolean {
  const connection = row.connection;
  if (!connection) return false;
  if (connection.status === "connected") return connection.quietSince !== undefined;
  if (connection.status === "unreachable") return !connection.restarting;
  return connection.status === "version-mismatch";
}

/** The host's installed agent CLIs, as its own detection reported them. */
export function describeHostAgentClis(row: HostMenuRow): string | null {
  const clis = hostAgentCliNames(row);
  return clis && clis.length > 0 ? clis.join(" · ") : null;
}

/**
 * Each installed agent CLI with its version, one per entry. Null when the
 * host didn't report its CLIs, which is not the same as reporting none.
 */
export function hostAgentCliNames(row: HostMenuRow): string[] | null {
  const clis = liveSummary(row)?.agentClis;
  if (!clis) return null;
  return clis.map(({ agentId, version }) => {
    const name = getAgentConfig(agentId)?.name ?? agentId;
    return version ? `${name} ${version}` : name;
  });
}

export type HostChipStatus =
  | "local"
  | "connected"
  | "quiet"
  | "connecting"
  | "unreachable"
  /** ssh reached the machine; Daintree there isn't running in Host mode. */
  | "host-mode-off"
  /** ssh reached the machine and couldn't log in (auth or host key). */
  | "access-denied"
  | "version-mismatch"
  | "build-differs"
  | "disconnected"
  | "driven-elsewhere";

/**
 * The chip's state for the window's host. A lease held elsewhere only matters
 * while the link is up; a link problem is what the user has to act on first.
 */
export function hostChipStatus(
  isLocalWindow: boolean,
  connection: HostConnectionState | null,
  drivenBy: string | null
): HostChipStatus {
  if (isLocalWindow) return drivenBy ? "driven-elsewhere" : "local";
  if (connection === null) return "connecting";
  switch (connection.status) {
    case "connected":
      // Silence on the link is what the person feels first: typing goes nowhere.
      if (connection.quietSince !== undefined) return "quiet";
      if (drivenBy) return "driven-elsewhere";
      return connection.buildMismatch ? "build-differs" : "connected";
    case "local":
      return drivenBy ? "driven-elsewhere" : "connected";
    case "unreachable":
      // Between dials of an announced restart: still on its way back.
      if (connection.restarting) return "connecting";
      // The machine answered in both; what it said is the state, not "unreachable".
      if (connection.hostModeOff) return "host-mode-off";
      if (connection.stoppedRetrying) return "access-denied";
      return "unreachable";
    default:
      return connection.status;
  }
}

/** The chip's short trailing state, or null when the name alone says it all. */
export function hostChipStatusText(status: HostChipStatus): string | null {
  switch (status) {
    case "quiet":
      return "no reply";
    case "connecting":
      return "connecting…";
    case "unreachable":
      return "unreachable";
    case "host-mode-off":
      return "not listening";
    case "access-denied":
      return "can't log in";
    case "version-mismatch":
      return "can't connect";
    case "disconnected":
      return "not connected";
    case "driven-elsewhere":
      return "viewing";
    default:
      return null;
  }
}

/** Which side runs the older build; null when the two have no order (a commit apart). */
export function olderBuildSide(mismatch: HandshakeMismatch): "host" | "local" | null {
  const order =
    mismatch.kind === "protocol"
      ? mismatch.remote - mismatch.local
      : mismatch.kind === "version"
        ? (compareReleaseVersions(mismatch.remote, mismatch.local) ?? 0)
        : 0;
  return order > 0 ? "local" : order < 0 ? "host" : null;
}

/**
 * Which side a mismatch asks to update: the one that is behind. Builds that
 * can't be ordered (same version, different commit) update the host, since
 * hosts follow the client.
 */
export function updateTargetFor(mismatch: HandshakeMismatch): "host" | "local" {
  return olderBuildSide(mismatch) === "local" ? "local" : "host";
}

export function updateActionLabel(mismatch: HandshakeMismatch, hostName: string): string {
  return updateTargetFor(mismatch) === "host" ? `Update ${hostName}` : "Update this machine";
}
