/**
 * Remote Hosts: shared vocabulary for the Shell (the machine you sit at) and
 * the Host runtime (where projects, terminals, agents and plugins run).
 *
 * Every Daintree is both. "local" is this machine's own Host; every other
 * host id is an opaque, client-minted identifier for a machine reached over
 * SSH. A window is bound to exactly one host.
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
 * v1 rule: same app version, same source commit, same wire protocol. Platform
 * and arch may differ (a Mac client and a Linux host run different binaries
 * built from one commit). Returns null when compatible.
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

/** How a host was found. Discovery only proves reachability. */
export type HostDiscoverySource = "tailscale" | "bonjour" | "manual";

/** A host the user has added on this client. Device-owned; never synced. */
export interface HostDescriptor {
  id: HostId;
  /** Display name, e.g. "studio-01". */
  name: string;
  /** What `ssh` is given: `user@host`, an alias from ~/.ssh/config, or a tailnet name. */
  sshTarget: string;
  platform: HostPlatform | null;
  arch: HostArch | null;
  /** Last build seen in a handshake. */
  lastHandshake: HostHandshakeInfo | null;
  /** Epoch ms of the last successful handshake or summary frame. */
  lastSeenAt: number | null;
  addedAt: number;
  /** Cross-host notifications are opt-in per host. */
  notificationsEnabled: boolean;
}

export type HostConnectionState =
  | { status: "local" }
  | { status: "disconnected" }
  | { status: "connecting"; attempt: number }
  | { status: "connected"; rttMs: number | null; handshake: HostHandshakeInfo }
  /** Never a guessed cause: we say what we saw. */
  | { status: "unreachable"; lastSeenAt: number | null; detail: string | null }
  | { status: "version-mismatch"; mismatch: HandshakeMismatch; remote: HostHandshakeInfo }
  | { status: "driven-elsewhere"; driver: DriveLeaseHolder };

/** One entry in the host menu / hosts overview. */
export interface HostListEntry {
  descriptor: HostDescriptor;
  connection: HostConnectionState;
  summary: HostMetricsSummary | null;
}

/**
 * The drive lease: one frontend drives a host project at a time. The Host
 * arbitrates it, and the terminal resize lease follows it.
 */
export interface DriveLeaseHolder {
  /** Increases on every grant; work stamped with an older lease is stale after a takeover. */
  leaseId: number;
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

/** Summary frame each host streams every few seconds to every connected client. */
export interface HostMetricsSummary {
  hostId: HostId;
  sampledAt: number;
  platform: HostPlatform;
  /** Busy CPU as a percentage of all cores over the last interval; null when unmeasured. */
  cpuPercent: number | null;
  /** macOS memorystatus level or Linux PSI mapped to three bands; null when unavailable. */
  memoryPressure: "normal" | "warn" | "critical" | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
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
  driver: DriveLeaseHolder | null;
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
