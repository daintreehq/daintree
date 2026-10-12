import {
  LOCAL_HOST_ID,
  type HandshakeMismatch,
  type HostConnectionState,
  type HostId,
  type HostListEntry,
  type HostMetricsSummary,
  type HostPlatform,
} from "@shared/types/remoteHosts";
import { getAgentConfig } from "@shared/config/agentRegistry";
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
 * A host name short enough for the chip, keeping its end: "build-east-01" and
 * "build-east-02" differ only there. The full name stays in the tooltip and
 * accessible name.
 */
export function shortHostName(name: string, max = 24): string {
  if (name.length <= max) return name;
  const tail = 8;
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
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
      platform: entry.summary?.platform ?? entry.descriptor.platform,
      connection: entry.connection,
      lastSeenAt: lastSeenOf(entry),
      summary: entry.summary,
      isCurrent: options.currentHostId === entry.descriptor.id,
    }))
    .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.hostId, b.hostId));
  return [local, ...remote];
}

function lastSeenOf(entry: HostListEntry): number | null {
  if (entry.connection.status === "unreachable" && entry.connection.lastSeenAt !== null) {
    return entry.connection.lastSeenAt;
  }
  return entry.descriptor.lastSeenAt;
}

/** A row's metrics only count while the link is up: a disconnected host has told us nothing new. */
function liveSummary(row: HostMenuRow): HostMetricsSummary | null {
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
        return "Connecting…";
      case "disconnected":
        return `Not connected${lastSeenSuffix(row.lastSeenAt, now)}`;
      case "unreachable":
        return connection.hostModeOff
          ? "Host mode off"
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
  if (observed && observed.working > 0) agents.push(`${observed.working} working`);
  if (observed && observed.waiting > 0) agents.push(`${observed.waiting} waiting`);
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
      return { state: "Connecting…", note: null };
    case "disconnected":
      return { state: "Not connected", note: null };
    case "unreachable":
      // The machine answered; Daintree there isn't hosting, which setting up fixes.
      if (connection.hostModeOff) return { state: "Host mode off", note: null };
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

/** CPU and memory pressure as last reported; null when the host measured neither. */
export function describeHostRowMetrics(row: HostMenuRow): string | null {
  const summary = liveSummary(row);
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.cpuPercent !== null) parts.push(`CPU ${Math.round(summary.cpuPercent)}%`);
  if (summary.memoryPressure !== null) parts.push(`Memory ${summary.memoryPressure}`);
  return parts.length > 0 ? parts.join("  ") : null;
}

/** The host's installed agent CLIs, as its own detection reported them. */
export function describeHostAgentClis(row: HostMenuRow): string | null {
  const clis = liveSummary(row)?.agentClis ?? [];
  if (clis.length === 0) return null;
  return clis
    .map(({ agentId, version }) => {
      const name = getAgentConfig(agentId)?.name ?? agentId;
      return version ? `${name} ${version}` : name;
    })
    .join(" · ");
}

export type HostChipStatus =
  | "local"
  | "connected"
  | "quiet"
  | "connecting"
  | "unreachable"
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

function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined || r === undefined || Number.isNaN(l) || Number.isNaN(r)) return 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/**
 * Which side a mismatch asks to update: the one that is behind. Builds that
 * can't be ordered (same version, different commit) update the host, since
 * hosts follow the client.
 */
export function updateTargetFor(mismatch: HandshakeMismatch): "host" | "local" {
  const order =
    mismatch.kind === "protocol"
      ? mismatch.remote - mismatch.local
      : mismatch.kind === "version"
        ? compareVersions(mismatch.remote, mismatch.local)
        : 0;
  return order > 0 ? "local" : "host";
}

export function updateActionLabel(mismatch: HandshakeMismatch, hostName: string): string {
  return updateTargetFor(mismatch) === "host" ? `Update ${hostName}` : "Update this machine";
}
