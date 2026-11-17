import type { HostId } from "./remoteHosts.js";

/**
 * Cloud hosts: a remote host whose machine a cloud provider runs and Daintree
 * can create, start and stop through that provider's API. The host itself is
 * still an ordinary Remote Host (same id, projects, link and Host runtime);
 * this vocabulary covers only the machine's lifecycle and the account that
 * pays for it. Nothing here ever carries a credential.
 */

export type CloudProviderId = "boat";

export const CLOUD_PROVIDER_IDS: readonly CloudProviderId[] = ["boat"];

export function isCloudProviderId(value: unknown): value is CloudProviderId {
  return typeof value === "string" && (CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}

export { isValidCloudBindingId } from "./remoteHosts.js";

/**
 * What a stop keeps and loses, in the provider's own terms. The UI words every
 * promise about a stopped machine from this, never from what one provider does.
 */
export interface CloudProviderPersistence {
  /** What a stop keeps, as a plural noun phrase: "Files in its home folder". */
  kept: string;
  /** What a stop loses, as a plural noun phrase: "/tmp, caches and memory". */
  lost: string;
  /** The least number of days a stopped machine's disk is kept; null when kept until deleted. */
  retentionDays: number | null;
  /** Whether the time a failed save is retried, with the machine still up, is billed. */
  saveRetryBilled: boolean;
}

/** What a provider can do, as semantics rather than a bare "supports start". */
export interface CloudProviderCapabilities {
  persistence: CloudProviderPersistence;
  /** About how long a start or create takes to running, for progress copy; null when unknown. */
  typicalStartSeconds: number | null;
  /** The provider can stop the machine by itself after a lifetime (an orphan guard). */
  lifetimeGuard: boolean;
  /** How the desktop reaches the machine's sshd. */
  route: "direct-ssh";
  /** The server key arrives through the authenticated API, so it can be pinned. */
  pinnedHostKey: boolean;
  /** Machines can be deleted from Daintree. */
  deletion: boolean;
}

export interface CloudProviderInfo {
  id: CloudProviderId;
  name: string;
  description: string;
  /** Where to create an account or an API key; opened in the system browser. */
  apiKeyUrl: string;
  dashboardUrl: string;
  docsUrl: string;
  capabilities: CloudProviderCapabilities;
  /** Null when this platform's Shell can use the provider; otherwise why not. */
  unsupportedReason: string | null;
}

/** A wallet an account may bill: the person's own, or an organization they belong to. */
export interface CloudBillingScope {
  kind: "personal" | "organization";
  /** The provider's id for it: what every request names. */
  id: string;
  name: string;
}

export type CloudAccountValidation =
  | { status: "valid"; checkedAt: number }
  | { status: "invalid"; checkedAt: number; detail: string }
  | { status: "unknown"; checkedAt: number | null; detail: string | null };

/** A connected provider account, as the renderer sees it: never its key. */
export interface CloudAccountSummary {
  id: string;
  providerId: CloudProviderId;
  displayName: string;
  /** Who the key signs in as, as the provider reports it. */
  identity: string | null;
  billingScope: CloudBillingScope;
  validation: CloudAccountValidation;
  /** Cloud hosts bound to this account. */
  hostCount: number;
  addedAt: number;
  /** The last four characters of the key, so two keys can be told apart. */
  keyHint: string | null;
}

/** The scopes a key can bill, offered when an account is connected. */
export interface CloudAccountScopeChoice {
  scope: CloudBillingScope;
  /** The provider marks this the account's active wallet. */
  active: boolean;
}

export interface CloudAccountCheckResult {
  identity: string | null;
  scopes: CloudAccountScopeChoice[];
}

/**
 * The machine as the provider reports it, normalised. Separate from the
 * link's state: a machine can run with nobody connected, and a link can be
 * down while the machine runs.
 */
export type CloudMachineState =
  "not-created" | "starting" | "running" | "stopping" | "stopped" | "error" | "deleted" | "unknown";

export interface CloudMachineType {
  id: string;
  label: string;
  vcpu: number | null;
  memoryGB: number | null;
  /** Price per running hour at list price; null when the provider didn't say. */
  hourlyDollars: number | null;
  available: boolean;
  /** Why it isn't available, in the provider's words. */
  reason: string | null;
}

export interface CloudCatalog {
  accountId: string;
  machineTypes: CloudMachineType[];
  /** The provider will accept a start now. */
  canStart: boolean;
  /** Included machine hours left this period, when the provider reports them. */
  includedHoursRemaining: number | null;
  /** Starts left in the tightest window the provider reports. */
  startsRemaining: number | null;
  savedSnapshotDayDollars: number | null;
  fetchedAt: number;
}

/** A machine in the account, as listed for import. */
export interface CloudResourceSummary {
  resourceId: string;
  name: string;
  machine: CloudMachineState;
  /** The provider's own word for the state, kept for diagnostics. */
  rawState: string;
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  createdAt: string | null;
  stoppedAt: string | null;
  /** Its data was deleted by retention: it can't start again. */
  dataExpired: boolean;
  /** The host already bound to it on this device, if any. */
  boundHostId: HostId | null;
  /** The account cannot start or connect to it (a teammate's private machine). */
  restricted: boolean;
}

/** What Daintree is doing to a machine right now, in the user's terms. */
export type CloudOperationKind = "creating" | "starting" | "stopping" | "deleting";

export interface CloudOperation {
  id: string;
  kind: CloudOperationKind;
  startedAt: number;
  /** The step under way, in words. */
  stage: string;
}

/** The last thing that went wrong with a machine operation, in words with a stable code. */
export interface CloudHostError {
  code: CloudHostErrorCode;
  message: string;
  at: number;
}

export type CloudHostErrorCode =
  | "credential-invalid"
  | "permission"
  | "billing"
  | "rate-limited"
  | "capacity"
  | "not-found"
  | "data-expired"
  | "stop-failing"
  | "ssh-authorization"
  | "provider-unreachable"
  | "outcome-unknown"
  | "unsupported"
  | "lifetime-renewal"
  | "failed";

/**
 * The worktree a machine was created for, written down with its create so it
 * holds while the machine is still coming up. `hostId`, `projectId` and
 * `worktreeId` name the worktree where it lives (a worktree id is its root
 * path, so only the host makes it unique); the names are labels as they were
 * then, for display only. Imported machines, and ones created from Settings →
 * Hosts, never carry one.
 */
export interface CloudHostCreatedFor {
  /** The host the worktree lives on; null for this device. */
  hostId: HostId | null;
  /** The project's id on that host, never a Shell's host-scoped key. */
  projectId: string;
  /** The worktree's root path on that host. */
  worktreeId: string;
  projectName: string;
  /** Its branch, or its name when it has none. */
  worktreeName: string;
  /** The host's name then; null for this device. */
  hostName: string | null;
}

/**
 * One cloud host's lifecycle, joined to its Remote Host by `hostId`.
 * Observations, with the time they were made: a stale one says so rather
 * than passing for current.
 */
export interface CloudHostStatus {
  hostId: HostId;
  providerId: CloudProviderId;
  accountId: string;
  accountName: string;
  /** Null before the machine exists (a saved draft or a create still under way). */
  resourceId: string | null;
  /** The machine's name in the provider's account, as last reported or as asked for. */
  machineName: string | null;
  ownership: "created-by-daintree" | "imported";
  /** The worktree it was created for; null for every other machine. */
  createdFor: CloudHostCreatedFor | null;
  machine: CloudMachineState;
  rawState: string | null;
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  hourlyDollars: number | null;
  /** When the provider stops the machine by itself; null when it never will. */
  autoStopAt: string | null;
  /** The lifetime the machine renews to, in seconds; null when it never stops by itself. */
  lifetimeSeconds: number | null;
  stoppedAt: string | null;
  /** The last stop Daintree or the provider recorded, while it is pending or failing. */
  stop: {
    status: "pending" | "failing" | "completed" | "superseded" | "unknown";
    error: string | null;
  } | null;
  lastSnapshotAt: string | null;
  dataExpired: boolean;
  operation: CloudOperation | null;
  lastError: CloudHostError | null;
  /** When the provider was last asked; null when it never answered. */
  observedAt: number | null;
  /** Diagnostic only: the address the last access resolution returned. Never identity. */
  lastEndpoint: string | null;
  /** SHA256 fingerprint of the pinned server key. */
  hostKeyFingerprint: string | null;
  /** When this device last moved the machine's auto-stop forward because it was in use here. */
  keptRunningAt: number | null;
}

/** The machine as it would be created. */
export interface CloudHostCreateRequest {
  accountId: string;
  name: string;
  machineType: string;
  /** Hours the machine may run before the provider stops it unless renewed; null for never. */
  lifetimeHours: number | null;
}

export interface CloudHostImportRequest {
  accountId: string;
  resourceId: string;
  name: string;
}

export interface CloudAccountAddRequest {
  providerId: CloudProviderId;
  /** Read once in main, encrypted, and never returned. */
  apiKey: string;
  scopeId: string;
  displayName?: string;
}

export interface CloudHostsSnapshot {
  providers: CloudProviderInfo[];
  accounts: CloudAccountSummary[];
  hosts: CloudHostStatus[];
}

export type CloudHostsEvent = { type: "changed"; snapshot: CloudHostsSnapshot };

/** Lifetimes offered when a machine is created, in hours; null is "never stops by itself". */
export const CLOUD_LIFETIME_CHOICES: readonly (number | null)[] = [1, 2, 4, 8, 24, null];

export const DEFAULT_CLOUD_LIFETIME_HOURS = 2;

/** Whether the machine is billing compute right now, as far as was observed. */
export function cloudMachineIsBilling(machine: CloudMachineState): boolean | null {
  switch (machine) {
    case "starting":
    case "running":
    case "stopping":
      return true;
    case "stopped":
    case "not-created":
    case "deleted":
      return false;
    default:
      return null;
  }
}

/** A short user-facing label for a machine state. */
export function cloudMachineLabel(machine: CloudMachineState): string {
  switch (machine) {
    case "not-created":
      return "Not created";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "error":
      return "Machine error";
    case "deleted":
      return "Deleted";
    default:
      return "Status unknown";
  }
}
