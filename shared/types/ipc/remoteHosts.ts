import type {
  HostArch,
  HostConnection,
  HostConnectionState,
  HostDescriptor,
  HostDiscoverySource,
  HostHandshakeInfo,
  HostId,
  HostListEntry,
  HostPlatform,
  OperationId,
  OperationOutcome,
  OperationProgress,
} from "../remoteHosts.js";

export interface AddHostPayload {
  name: string;
  connection: HostConnection;
}

export interface UpdateHostPayload {
  hostId: HostId;
  name?: string;
  connection?: HostConnection;
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

/**
 * Where a host switch left the window. `switched`: the window shows `projectId`
 * on `hostId` (the one asked for, or the last one this machine had open there).
 * `window-opened`: a new window is on the host, showing its project list.
 * `choose-project`: the host reported no project to return to, so nothing
 * moved; the caller shows that host's project list for the window to pick from.
 * `superseded`: a newer switch for the same window was asked for while this
 * one waited, so this one moved nothing.
 */
export type SwitchWindowHostResult =
  | { outcome: "switched"; hostId: HostId; projectId: string }
  | { outcome: "window-opened"; hostId: HostId }
  | { outcome: "choose-project"; hostId: HostId }
  | { outcome: "superseded"; hostId: HostId };

/** A project as the host that has it lists it. Its id means something only on that host. */
export interface HostProjectSummary {
  id: string;
  name: string;
  path: string;
  emoji?: string;
}

export interface ListHostProjectsPayload {
  hostId: HostId;
}

/** This machine's answer about one host plugin reaching its clipboard. */
export interface HostPluginClipboardGrant {
  /** The plugin's instance id on that host. */
  pluginId: string;
  read?: "allow" | "deny";
  write?: "allow" | "deny";
}

export interface ResetClipboardGrantsPayload {
  hostId: HostId;
  /** One plugin's answers; omitted, every plugin's on that host. */
  pluginId?: string;
}

/** A machine discovery saw. Reachability only; whether Daintree runs there is learned by connecting. */
export interface DiscoveredHost {
  name: string;
  connection: HostConnection;
  source: HostDiscoverySource;
  platform: HostPlatform | null;
  online: boolean;
  /** True when this machine is already in the host list. */
  alreadyAdded: boolean;
}

export interface HostInstallInfo {
  path: string;
  version: string | null;
  commit: string | null;
  packaging: "app-bundle" | "deb" | "appimage" | "unknown";
}

export interface HostProbeResult {
  connection: HostConnection;
  reachable: boolean;
  /** ssh's own error text when unreachable. */
  sshError: string | null;
  platform: HostPlatform | null;
  arch: HostArch | null;
  install: HostInstallInfo | null;
  hostModeListening: boolean;
  /** Commands the user runs themselves (sudo, linger, pmset). Daintree never runs sudo. */
  suggestedCommands: Array<{ label: string; command: string }>;
  /** A Daintree process is running there, in Host mode or not. */
  appRunning: boolean;
  /** AppImages found in ~/Applications on a Linux host. */
  appImages: string[];
  /**
   * curl or wget is there, so the host tries fetching its own build first. It
   * says nothing about internet access: when that fetch fails, this machine
   * downloads the build and copies it over.
   */
  canDownload: boolean;
  /** The installed build is this client's version and commit; null when that can't be read. */
  matchesClient: boolean | null;
  advice: HostAdvice;
  /** What Daintree on the host last wrote about its Host mode setting; null when it wrote nothing. */
  hostModeState: HostModeObservation | null;
}

/**
 * Host mode as the host's own Daintree last recorded it (`host-mode.json`
 * beside its socket): the saved setting, start at login, and its keychain
 * check. Written by the host process; read over SSH, so it needs no link.
 */
export interface HostModeObservation {
  /** The Daintree process that wrote it. */
  pid: number;
  enabled: boolean;
  startAtLogin: boolean;
  /** The Daintree-owned login item or unit was on disk when the host last looked; null when unread. */
  startAtLoginInstalled: boolean | null;
  /** Why start at login couldn't be installed, in the host's words. */
  startAtLoginError: string | null;
  keychain: {
    state: "ok" | "warning" | "unavailable" | "unknown";
    detail: string;
    /** The host ran its keychain check; false while it hasn't yet. */
    checked: boolean;
  };
}

/** What starting Host mode on a host from setup ended with. */
export interface StartHostModeResult {
  probe: HostProbeResult;
  /**
   * Linux: `loginctl enable-linger` was asked for and refused, in its own
   * words. Without lingering the Host mode service stops when the last login
   * session there ends.
   */
  lingerRefused: string | null;
}

/** What the probe saw that bears on running a host unattended. Observations only. */
export interface HostAdvice {
  /** macOS: pmset's `sleep` value. Linux: the state of sleep.target. */
  sleepObserved: string | null;
  /** True when the observed value means the machine does not sleep when idle. */
  sleepDisabled: boolean | null;
  /** Linux: whether a keyring daemon was running for this user. Null on macOS. */
  keyring: "running" | "not-running" | null;
  /** Linux: whether lingering is on, so user services run without a login. */
  linger: boolean | null;
  /** Linux: whether the Daintree-owned systemd user unit is there. */
  hostModeUnit: boolean | null;
  /**
   * The Daintree-owned start-at-login item is in place: the LaunchAgent on
   * macOS, the systemd user unit (file present and enabled) on Linux.
   */
  startAtLoginInstalled: boolean | null;
  /**
   * Linux: FUSE is usable for an AppImage (`/dev/fuse`, fusermount and
   * libfuse2). Without it an AppImage host runs extracted. Null on macOS.
   */
  fuse: boolean | null;
}

export type LinuxPackagePreference = "deb" | "appimage";

/**
 * How the build reaches the host: this client's own bundle copied over (same
 * platform and arch), the host downloading its artifact from the release
 * feed, or this client downloading that artifact and copying it over.
 */
export type InstallDelivery = "push-bundle" | "host-fetch" | "client-download-push";

export interface HostInstallPlan {
  kind: "up-to-date" | "install" | "unsupported";
  delivery: InstallDelivery | null;
  packaging: "app-bundle" | "deb" | "appimage" | null;
  /** The exact build the host gets: always this client's. */
  version: string;
  commit: string;
  /** This client's release channel, which the host follows. */
  channel: "stable" | "nightly";
  artifactName: string | null;
  artifactUrl: string | null;
  /** Installing restarts Daintree on the host, which ends its terminals. */
  restartsHost: boolean;
  /** A deb needs sudo, so the last step is a command the user runs. */
  userCommandNeeded: boolean;
  /** Why nothing can be installed, when kind is "unsupported". */
  reason: string | null;
}

/** Which machine a setup call (probe, install, Host mode) is about. */
export interface HostSetupTarget {
  connection: HostConnection;
}

export interface PlanInstallPayload {
  connection: HostConnection;
  linuxPackage?: LinuxPackagePreference;
}

export interface InstallHostPayload {
  opId: OperationId;
  connection: HostConnection;
  /** Set when the host is already in the list, so its link can be checked afterwards. */
  hostId?: HostId;
  linuxPackage?: LinuxPackagePreference;
  /**
   * When the host reports working agents: stop and say so (default), go ahead
   * because the user confirmed, or stage now and restart once none are working.
   */
  whileWorking?: "refuse" | "proceed" | "wait-for-idle";
}

export type InstallHostResult =
  | { status: "installed"; probe: HostProbeResult; reconnected: boolean | null }
  | { status: "up-to-date"; probe: HostProbeResult }
  /** Nothing was changed: the host reported agents working (null: it couldn't be seen). */
  | { status: "agents-working"; working: number | null }
  | {
      status: "needs-user-command";
      command: { label: string; command: string };
      probe: HostProbeResult;
    };

export type RemoteHostsEvent =
  | { type: "hosts-changed"; hosts: HostListEntry[] }
  | { type: "connection-changed"; hostId: HostId; connection: HostConnectionState }
  | { type: "local-handshake"; handshake: HostHandshakeInfo }
  /**
   * Sent to one remote view: the host dropped events on their way to it (the
   * link fell behind, or it was away), or the link came back on a fresh
   * session that knows nothing of the old one, so what it shows may be stale.
   * Refetch state rather than trusting what has been applied.
   */
  | {
      type: "resync-required";
      hostId: HostId;
      reason: "overflow" | "reattached" | "reconnected";
    }
  /** An install or update this client is running on a host. */
  | {
      type: "install-progress";
      opId: OperationId;
      connection: HostConnection;
      progress: OperationProgress;
    }
  | {
      type: "install-settled";
      opId: OperationId;
      connection: HostConnection;
      outcome: OperationOutcome;
    };
