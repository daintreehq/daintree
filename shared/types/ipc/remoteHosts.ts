import type {
  HostArch,
  HostConnectionState,
  HostDescriptor,
  HostDiscoverySource,
  HostHandshakeInfo,
  HostId,
  HostListEntry,
  HostPlatform,
} from "../remoteHosts.js";

export interface AddHostPayload {
  name: string;
  sshTarget: string;
}

export interface UpdateHostPayload {
  hostId: HostId;
  name?: string;
  sshTarget?: string;
  notificationsEnabled?: boolean;
}

export interface WindowHostInfo {
  hostId: HostId;
  /** Null for the local host. */
  descriptor: HostDescriptor | null;
  connection: HostConnectionState;
  /** The platform commands and paths are built for: the host's, not this client's. */
  hostPlatform: HostPlatform | "win32";
  hostHomeDir: string | null;
  hostTmpDir: string | null;
}

export interface SwitchWindowHostPayload {
  hostId: HostId;
  /** Cmd/Ctrl-click: open the host in a new window instead of switching this one. */
  newWindow: boolean;
  /** Project to open on the target host once attached. */
  projectId?: string;
}

/** A machine discovery saw. Reachability only; whether Daintree runs there is learned by connecting. */
export interface DiscoveredHost {
  name: string;
  sshTarget: string;
  source: HostDiscoverySource;
  platform: HostPlatform | null;
  online: boolean;
  /** True when this sshTarget is already in the host list. */
  alreadyAdded: boolean;
}

export interface HostInstallInfo {
  path: string;
  version: string | null;
  commit: string | null;
  packaging: "app-bundle" | "deb" | "appimage" | "unknown";
}

export interface HostProbeResult {
  sshTarget: string;
  reachable: boolean;
  /** ssh's own error text when unreachable. */
  sshError: string | null;
  platform: HostPlatform | null;
  arch: HostArch | null;
  install: HostInstallInfo | null;
  hostModeListening: boolean;
  /** Commands the user runs themselves (sudo, linger, pmset). Daintree never runs sudo. */
  suggestedCommands: Array<{ label: string; command: string }>;
}

export type RemoteHostsEvent =
  | { type: "hosts-changed"; hosts: HostListEntry[] }
  | { type: "connection-changed"; hostId: HostId; connection: HostConnectionState }
  | { type: "local-handshake"; handshake: HostHandshakeInfo }
  /**
   * Sent to one remote view: the host dropped events on their way to it (the
   * link fell behind, or it was away), so what it shows may be stale. Refetch
   * state rather than trusting what has been applied.
   */
  | { type: "resync-required"; hostId: HostId; reason: "overflow" | "reattached" };
