import type { CrashCause, WatchdogKillReason } from "./ipc/crashRecovery.js";

/**
 * Remote Hosts: shared vocabulary for the Shell (the machine you sit at) and
 * the Host runtime (where projects, terminals, agents and plugins run).
 *
 * Every Daintree is both. "local" is this machine's own Host; every other
 * host id is an opaque, client-minted identifier for a machine reached over
 * SSH, or a WSL distro on this Windows machine. A window is bound to exactly
 * one host.
 */

export type HostId = string;

/** The Host running inside this process. Local projects keep bare ids. */
export const LOCAL_HOST_ID: HostId = "local";

const REMOTE_HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A remote host id: short, colon-free, and never the reserved "local". */
export function isValidRemoteHostId(hostId: string): boolean {
  return hostId !== LOCAL_HOST_ID && REMOTE_HOST_ID.test(hostId);
}

export function isLocalHostId(hostId: HostId | null | undefined): boolean {
  return hostId == null || hostId === LOCAL_HOST_ID;
}

export type HostPlatform = "darwin" | "linux";
export type HostArch = "x64" | "arm64";

/**
 * Client-side key for anything scoped to a project on a host: view maps,
 * persisted renderer keys, caches. Project ids are opaque and can collide
 * across hosts, so remote entries are prefixed. The local host maps to the
 * bare project id so nothing keyed today changes for a single-machine user.
 */
export type HostScopedKey = string;

const HOST_SCOPE_SEPARATOR = ":";

export function toHostScopedKey(
  hostId: HostId | null | undefined,
  projectId: string
): HostScopedKey {
  if (isLocalHostId(hostId)) return projectId;
  if (!isValidRemoteHostId(hostId!)) throw new Error(`Invalid host id: ${String(hostId)}`);
  return `${hostId}${HOST_SCOPE_SEPARATOR}${projectId}`;
}

/**
 * Inverse of {@link toHostScopedKey}. Local project ids never contain the
 * separator (they are 64-hex), so a key without one is local.
 */
export function parseHostScopedKey(key: HostScopedKey): { hostId: HostId; projectId: string } {
  const idx = key.indexOf(HOST_SCOPE_SEPARATOR);
  if (idx <= 0) return { hostId: LOCAL_HOST_ID, projectId: key };
  return { hostId: key.slice(0, idx), projectId: key.slice(idx + 1) };
}

/** Wire protocol version. Bump on any incompatible change to link messages. */
export const REMOTE_PROTOCOL_VERSION = 1;

/**
 * How a host's previous process ended, as the crash record the host consumed
 * at launch observed it (#14368). Every WELCOME of the process that followed
 * carries it. Absent when that process shut down, which a planned restart
 * does, or when nothing was recorded: absence is not proof of a clean end.
 * The record's own tokens, never a guess at why.
 */
export interface HostPreviousEnd {
  crashCause: CrashCause;
  /** The watchdog's own kill flag: it stopped the app after missed heartbeats. */
  cause?: "watchdog-deadlock";
  /** Which watchdog deadline ran out, when the watchdog said. */
  watchdogKillReason?: WatchdogKillReason;
  /** Heartbeats the watchdog missed before it killed the app. */
  missedBeats?: number;
  /** What earned the kill a longer deadline, in the watchdog's own words, when something did. */
  pressureEvidence?: string;
  /** When it ended, as the record dates it (epoch ms). */
  at: number;
}

/** Exchanged by both ends before anything else crosses the link. */
export interface HostHandshakeInfo {
  version: string;
  commit: string;
  protocolVersion: number;
  platform: HostPlatform;
  arch: HostArch;
}

export type HandshakeMismatch =
  | { kind: "protocol"; local: number; remote: number }
  | { kind: "version"; local: string; remote: string }
  | { kind: "commit"; local: string; remote: string };

/**
 * How two builds differ, protocol first, then app version, then source commit;
 * null when they match. Platform and arch may differ (a Mac client and a Linux
 * host run different binaries built from one commit). Whether a difference
 * stops the link is {@link isBlockingMismatch}.
 */
export function compareHandshake(
  local: HostHandshakeInfo,
  remote: HostHandshakeInfo
): HandshakeMismatch | null {
  if (local.protocolVersion !== remote.protocolVersion) {
    return { kind: "protocol", local: local.protocolVersion, remote: remote.protocolVersion };
  }
  if (local.version !== remote.version) {
    return { kind: "version", local: local.version, remote: remote.version };
  }
  if (local.commit !== remote.commit) {
    return { kind: "commit", local: local.commit, remote: remote.commit };
  }
  return null;
}

/**
 * Only a different wire protocol stops a link: neither side can read the
 * other. A different app version or commit connects best effort, with a
 * warning, since most of what crosses the link is unchanged between builds.
 */
export function isBlockingMismatch(mismatch: HandshakeMismatch): boolean {
  return mismatch.kind === "protocol";
}

/** How a host was found. Discovery only proves reachability; `wsl` is a distro installed on this PC. */
export type HostDiscoverySource = "tailscale" | "netbird" | "bonjour" | "manual" | "wsl";

/**
 * How this client reaches a host. Each kind names the one command that gets a
 * stream to the host's Daintree: `ssh <target>`, or `wsl.exe -d <distro>` for
 * a Linux Host inside a WSL distro on this Windows machine (#12830). Every
 * `switch (connection.kind)` has to say what it does for each.
 */
export type HostConnection =
  | {
      kind: "ssh";
      /** What `ssh` is given: `user@host`, an alias from ~/.ssh/config, or a tailnet name. */
      target: string;
    }
  | {
      kind: "wsl";
      /** The distro's name as `wsl.exe -l` lists it, e.g. `Ubuntu-24.04`. */
      distro: string;
    };

export type HostConnectionKind = HostConnection["kind"];

export function sshConnection(target: string): HostConnection {
  return { kind: "ssh", target };
}

export function wslConnection(distro: string): HostConnection {
  return { kind: "wsl", distro };
}

/**
 * A distro name as `wsl.exe -l` lists one: letters, digits, `.`, `_`, `-` and
 * inner spaces, starting with a letter or digit so it can never read as a
 * `wsl.exe` option. It travels as one argv element, never through a shell.
 */
const WSL_DISTRO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9._-])?$/;

export function isValidWslDistroName(distro: string): boolean {
  return WSL_DISTRO_NAME.test(distro);
}

/** The one way a host's address is shown: what the user typed for ssh, the distro for WSL. */
export function formatHostConnection(connection: HostConnection): string {
  switch (connection.kind) {
    case "ssh":
      return connection.target;
    case "wsl":
      return `${connection.distro} (WSL)`;
    default:
      // A kind this build doesn't know (a newer build's settings): name the kind.
      return (connection as { kind: string }).kind;
  }
}

/** The ssh target, or null for a connection that isn't ssh. */
export function sshTargetOf(connection: HostConnection): string | null {
  switch (connection.kind) {
    case "ssh":
      return connection.target;
    default:
      return null;
  }
}

/** The WSL distro, or null for a connection that isn't WSL. */
export function wslDistroOf(connection: HostConnection): string | null {
  return connection.kind === "wsl" ? connection.distro : null;
}

export function sameHostConnection(a: HostConnection, b: HostConnection): boolean {
  if (a.kind === "ssh" && b.kind === "ssh") return a.target === b.target;
  // WSL looks distro names up without regard to case.
  if (a.kind === "wsl" && b.kind === "wsl")
    return a.distro.toLowerCase() === b.distro.toLowerCase();
  return false;
}

/**
 * The machine an ssh target names: its host part, lower-cased and whole. An IP
 * address stays complete, and a name is never shortened to its first label,
 * since `studio.local` and `studio.tailnet.ts.net` may be different machines.
 */
export function sshMachineKey(target: string): string {
  const host = target.slice(target.lastIndexOf("@") + 1).toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

/** The account a target logs in as, as typed; empty when it leaves that to ssh. */
function sshUserOf(target: string): string {
  const at = target.lastIndexOf("@");
  return at < 0 ? "" : target.slice(0, at);
}

/**
 * The same account on the same machine: what can't be added twice. Host names
 * compare case-insensitively, as DNS does; user names exactly, as logins do.
 */
export function sameHostAccount(a: HostConnection, b: HostConnection): boolean {
  if (a.kind !== b.kind) return false;
  const at = sshTargetOf(a);
  const bt = sshTargetOf(b);
  if (at === null || bt === null) return sameHostConnection(a, b);
  return sshMachineKey(at) === sshMachineKey(bt) && sshUserOf(at) === sshUserOf(bt);
}

/**
 * The same machine reached another way (another account, or the user left to
 * ssh): a legitimate second host, worth a warning but never refused.
 */
export function sameHostMachine(a: HostConnection, b: HostConnection): boolean {
  if (a.kind !== b.kind) return false;
  const at = sshTargetOf(a);
  const bt = sshTargetOf(b);
  if (at === null || bt === null) return sameHostConnection(a, b);
  return sshMachineKey(at) === sshMachineKey(bt);
}

/** What this machine is called in titles, chips and copy; a host can't take one of them. */
export const RESERVED_HOST_NAMES: readonly string[] = ["This Mac", "This machine", "This computer"];

const hostNameCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Two host names people would read as the same one. */
export function sameHostName(a: string, b: string): boolean {
  return hostNameCollator.compare(a.trim(), b.trim()) === 0;
}

export function isReservedHostName(name: string): boolean {
  return RESERVED_HOST_NAMES.some((reserved) => sameHostName(reserved, name));
}

/**
 * The connection an entry was saved with, from either shape: `connection`, or
 * the `sshTarget` string development builds of this feature wrote before it.
 * Null when neither is usable; the caller validates the target or distro itself.
 */
export function readStoredHostConnection(entry: {
  connection?: unknown;
  sshTarget?: unknown;
}): HostConnection | null {
  const connection = entry.connection as
    { kind?: unknown; target?: unknown; distro?: unknown } | null | undefined;
  if (connection && typeof connection === "object") {
    if (connection.kind === "ssh" && typeof connection.target === "string") {
      return sshConnection(connection.target);
    }
    if (connection.kind === "wsl" && typeof connection.distro === "string") {
      return wslConnection(connection.distro);
    }
    return null;
  }
  return typeof entry.sshTarget === "string" ? sshConnection(entry.sshTarget) : null;
}

/** A host the user has added on this client. Device-owned; never synced. */
export interface HostDescriptor {
  id: HostId;
  /** Display name, e.g. "studio-01". */
  name: string;
  /** How the host is reached; see {@link HostConnection}. Shown through {@link formatHostConnection}. */
  connection: HostConnection;
  platform: HostPlatform | null;
  arch: HostArch | null;
  /** Last build seen in a handshake. */
  lastHandshake: HostHandshakeInfo | null;
  /** Epoch ms of the last successful handshake or summary frame. */
  lastSeenAt: number | null;
  addedAt: number;
  /** Cross-host notifications are opt-in per host. */
  notificationsEnabled: boolean;
  /**
   * Whether this Shell's assistants may run the host's own Daintree tools
   * there through `host.call` (#13493): which is also how they find, start
   * and message the host's assistants (#13496). On for an SSH host, kept
   * across a change of target; the person can turn it off.
   */
  assistantControlEnabled: boolean;
  /**
   * The worktree (by path) whose resource environment named this host, when
   * it was added for that worktree's box: removed with the worktree, or when
   * its resource is torn down. Absent for every host the user added.
   */
  ownerWorktreeId?: string;
}

export type HostConnectionState =
  | { status: "local" }
  | { status: "disconnected" }
  | {
      status: "connecting";
      attempt: number;
      /**
       * The host said it was shutting down when the link closed, and was
       * heard from recently enough that it is plausibly coming back. Its own
       * word, never inferred from silence.
       */
      restarting?: true;
    }
  | {
      status: "connected";
      rttMs: number | null;
      /**
       * When the reply behind `rttMs` arrived. A state that changes for any
       * other reason carries the same stamp, so a reader can tell a fresh ping
       * from a repeat of the last one even when both took the same time.
       */
      rttSampledAt?: number;
      handshake: HostHandshakeInfo;
      /** Connected anyway with a different version or commit; absent when the builds match. */
      buildMismatch?: HandshakeMismatch;
      /**
       * When the host was last heard from, present only once nothing has
       * arrived for several seconds. Observed silence, never a cause: a slow
       * host stays connected until its transport closes or the idle ceiling
       * gives up on it.
       */
      quietSince?: number;
    }
  /** Never a guessed cause: we say what we saw. */
  | {
      status: "unreachable";
      lastSeenAt: number | null;
      detail: string | null;
      /** ssh reached the host and found no Daintree listening there in Host mode (no discovery file). */
      hostModeOff?: true;
      /** As on `connecting`: the host said it was shutting down, and is still retried. */
      restarting?: true;
      /**
       * Not retrying on its own: what was seen (ssh couldn't log in, Host mode
       * is off) doesn't change by trying again soon, so it waits for a
       * Connect. A host a window shows whose Daintree isn't listening is
       * still checked now and then, so the window comes back with it.
       */
      stoppedRetrying?: true;
    }
  | { status: "version-mismatch"; mismatch: HandshakeMismatch; remote: HostHandshakeInfo }
  | { status: "driven-elsewhere"; driver: DriveLeaseHolder };

/** One entry in the host menu / hosts overview. */
export interface HostListEntry {
  descriptor: HostDescriptor;
  connection: HostConnectionState;
  summary: HostMetricsSummary | null;
}

/**
 * When a window on this machine last landed on a host, "local" included: what
 * the host switcher orders by. Kept on this device only.
 */
export interface HostRecentUse {
  hostId: HostId;
  lastUsedAt: number;
}

/**
 * The drive lease: one frontend drives a host project at a time. The Host
 * arbitrates it, and the terminal resize lease follows it.
 */
export interface DriveLeaseHolder {
  /** Increases on every grant; work stamped with an older lease is stale after a takeover. */
  leaseId: number;
  /**
   * The same while one client holds the project, across its windows, its
   * reconnects and a restart of the Host, and across a spell when nobody held
   * it that no other client's window saw; new whenever someone else may have
   * driven it. A view back from a lost link compares it to tell a blip from a
   * project someone else may have driven meanwhile. Absent from Hosts that
   * predate it.
   */
  tenureId?: string;
  /** The one renderer that drives: MCP dispatch, plugin prompts and terminal resize target it. */
  endpointId: string;
  clientId: string;
  /** Machine name of the driving client, e.g. "greg-mbp". */
  clientName: string;
  /** True when the driver is the Host machine's own local window. */
  isHostLocal: boolean;
  acquiredAt: number;
}

export interface DriveLeaseState {
  projectId: string;
  holder: DriveLeaseHolder | null;
}

/**
 * One project's lease as its host sees it: who holds it, and whether that
 * holder is there (`live`) or away inside the reservation that keeps the
 * project for it until `awayUntil`, by the host's clock.
 */
export interface DriveLeaseObservation {
  projectId: string;
  holder: DriveLeaseHolder;
  state: "live" | "away";
  /** When the lease passes on unless its holder comes back; null while it is there. */
  awayUntil: number | null;
}

export interface HostDriverObservation extends DriveLeaseObservation {
  /** Null when the host has no project by that id, such as a reservation for one since removed. */
  projectName: string | null;
}

/** Projects a summary names drivers for: the overview's line, not an inventory. */
export const MAX_HOST_SUMMARY_DRIVERS = 32;

/** Summary frame each host streams every few seconds to every connected client. */
export interface HostMetricsSummary {
  hostId: HostId;
  sampledAt: number;
  /** "win32" only on a Windows Shell's own summary of itself: no Host runs there, so none crosses a link. */
  platform: HostPlatform | "win32";
  /** Busy CPU as a percentage of all cores over the last interval; null when unmeasured. */
  cpuPercent: number | null;
  /**
   * Logical cores the CPU reading covers: the scale `cpuPercent` is a share of.
   * Absent from a host that doesn't report it; null when unmeasured.
   */
  cpuLogicalCoreCount?: number | null;
  /** The 1 minute load average, as the OS reports it. Absent from older hosts; null when unmeasured. */
  cpuLoadAverage1m?: number | null;
  /** Apple Silicon performance cluster size. Absent from older hosts; null elsewhere or unknown. */
  cpuPerformanceCoreCount?: number | null;
  /** Apple Silicon efficiency cluster size. Absent from older hosts; null elsewhere or unknown. */
  cpuEfficiencyCoreCount?: number | null;
  /**
   * Busy share of the performance cluster's own cores over the last interval.
   * Absent from older hosts; null elsewhere, on the first reading, or when the
   * cores can't be matched to their cluster.
   */
  cpuPerformancePercent?: number | null;
  /** Busy share of the efficiency cluster's own cores; null under the same rules. */
  cpuEfficiencyPercent?: number | null;
  /**
   * What the figures below describe: the whole machine, or the cgroup the Host
   * runs in when that carries a limit. Absent from a host that doesn't report it.
   */
  metricsScope?: "host" | "cgroup" | null;
  /**
   * Cores the CPU reading is a share of, fractional under a CPU quota: the
   * scale `cpuPercent` is a share of. Absent from a host that doesn't report it.
   */
  cpuCapacityCores?: number | null;
  /** Linux PSI memory `some avg10`, as the kernel reports it. Absent from older hosts; null off Linux. */
  memoryPressureSomeAvg10?: number | null;
  /** Hottest CPU-like sensor in °C, as read. Machine-wide even when the rest is a cgroup's. */
  temperatureCelsius?: number | null;
  /** The sensor `temperatureCelsius` came from, such as "x86_pkg_temp (thermal_zone0)". */
  temperatureZone?: string | null;
  /** macOS memorystatus level; null elsewhere, where Linux reports `memoryPressureSomeAvg10`. */
  memoryPressure: "normal" | "warn" | "critical" | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  /**
   * Bytes swapped in per second over the last interval, in the same scope as
   * the swap figures. Absent from older hosts; null on the first reading, after
   * a counter reset or gap, or where the counter isn't exposed.
   */
  swapInBytesPerSec?: number | null;
  /** Bytes swapped out per second; null under the same rules. */
  swapOutBytesPerSec?: number | null;
  /** macOS thermal state; null elsewhere, where Linux reports `temperatureCelsius`. */
  thermal: "nominal" | "fair" | "serious" | "critical" | null;
  /** Linux PSI cpu `some avg10`; null elsewhere. */
  cpuPressure: number | null;
  /**
   * Observed agent states from the Host's FSM. Observations, not conclusions.
   * Null when the read failed or not every terminal shard answered: a partial
   * tally must never pass for "nothing working".
   */
  agentsObserved: { working: number; waiting: number; idle: number } | null;
  /** Open projects; null when the read failed. */
  projectCount: number | null;
  /** Worktrees across open projects; null when the read failed. */
  worktreeCount: number | null;
  /** The newest holder across the host's projects: what a Shell from before `drivers` reads. */
  driver: DriveLeaseHolder | null;
  /**
   * Every project someone drives, newest control first, up to
   * {@link MAX_HOST_SUMMARY_DRIVERS}. Absent from a host that doesn't report
   * it; null when the read failed.
   */
  drivers?: HostDriverObservation[] | null;
  /** Installed agent CLIs and their versions, as the Host's detection reports them. */
  agentClis: Array<{ agentId: string; version: string | null }>;
  /**
   * The Host's forge providers and what its own settings and providers report
   * about signing in. Absent from a host that doesn't report it; null when the
   * read failed.
   */
  forges?: HostForgeObservation[] | null;
}

/**
 * One forge provider on a host: whether a credential is saved there, and the
 * account its provider last said that credential signs in as. Credentials
 * never leave the host; only these observations do.
 */
export interface HostForgeObservation {
  /** Namespaced provider id, e.g. `github.github`. */
  providerId: string;
  /** Display name, e.g. "GitHub". */
  name: string;
  hasCredential: boolean;
  /** Null when the provider hasn't reported an account (no credential, or not asked yet). */
  account: string | null;
}

/** Operation ids let a client resolve a mutation whose link dropped mid-flight. */
export type OperationId = string;

export type OperationKind =
  | "git-push"
  | "git-clone"
  | "project-clone-and-open"
  | "project-worktree-place"
  | "copytree"
  | "worktree-create"
  | "file-upload"
  | "file-download"
  | "git-bundle-transfer"
  | "plugin-install"
  | "host-update";

export interface OperationProgress {
  opId: OperationId;
  kind: OperationKind;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  stage: string | null;
  message: string | null;
  at: number;
}

export type OperationOutcome =
  | { status: "running"; progress: OperationProgress | null }
  | { status: "succeeded"; result: unknown; settledAt: number }
  | { status: "failed"; error: { code: string | null; message: string }; settledAt: number }
  | { status: "cancelled"; settledAt: number }
  /** The Host has no record: it never arrived, or its retention window passed. */
  | { status: "unknown" };

export interface OperationRecord {
  opId: OperationId;
  kind: OperationKind;
  projectId: string | null;
  startedAt: number;
  outcome: OperationOutcome;
}

/** Where a file the user drops, pastes or attaches comes from. */
export type MaterializeSource =
  | { kind: "local-file"; path: string }
  /** Whatever image is on this machine's clipboard right now (Cmd+V / Ctrl+V). */
  | { kind: "clipboard-image" }
  | { kind: "local-bytes"; bytes: Uint8Array; name: string; mimeType: string | null }
  | { kind: "host-file"; path: string; hostId: HostId };

/**
 * The single primitive every drop, paste and attach goes through. Locally it
 * is the identity for files, and pasted images keep today's temp-file save.
 * For a remote window, local bytes are uploaded into the host inbox and the
 * host path comes back.
 */
export interface MaterializeResult {
  hostPath: string;
  displayName: string;
  bytes: number | null;
  /** data: URL thumbnail when the source was an image and one could be built locally. */
  thumbnail?: string;
}

export interface MaterializeOptions {
  /** Called with 0..1 while an upload is in flight (not called for local identity). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** "inbox" (default) keeps uploads outside the worktree; "worktree" is the explicit Add to project drop. */
  destination?: { kind: "inbox" } | { kind: "worktree"; directory: string };
}

export type MaterializeFn = (
  source: MaterializeSource,
  options?: MaterializeOptions
) => Promise<MaterializeResult>;

/** Upload limits, per the design defaults. */
export const UPLOAD_CONFIRM_BYTES = 50 * 1024 * 1024;
export const UPLOAD_REFUSE_BYTES = 500 * 1024 * 1024;
export const FOLDER_UPLOAD_MAX_FILES = 5_000;
export const FOLDER_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Typed plugin failures when a window is attached to a host whose plugin set
 * differs from this machine's. The renderer placeholder, toasts and MCP errors
 * all build from these.
 */
export interface PluginNotOnHostError {
  code: "PLUGIN_NOT_ON_HOST";
  pluginId: string;
  hostId: HostId;
}

export type PluginIncompatibleReason =
  | { kind: "engine"; required: string; hostVersion: string }
  | { kind: "platform"; hostPlatform: HostPlatform; supported: HostPlatform[] }
  | { kind: "remote-unsupported" }
  | { kind: "untrusted" }
  | { kind: "unconfigured"; missing: string[] };

export interface PluginIncompatibleError {
  code: "PLUGIN_INCOMPATIBLE";
  pluginId: string;
  hostId: HostId;
  reason: PluginIncompatibleReason;
}

export type PluginHostError = PluginNotOnHostError | PluginIncompatibleError;
