import type {
  CloudAccountCheckResult,
  CloudHostError,
  CloudMachineState,
  CloudMachineType,
  CloudProviderId,
  CloudProviderInfo,
} from "../../../shared/types/cloudHosts.js";
import type { SshEndpoint } from "./sshEndpoint.js";

/** What a provider call needs to act for one account. Lives in main only. */
export interface ProviderCredentials {
  apiKey: string;
  /** The billing scope every request names. */
  scopeId: string;
  /** The API origin the account was connected against. */
  apiUrl: string;
  signal?: AbortSignal;
}

/** A machine as a provider reports it, normalised. */
export interface ProviderResource {
  resourceId: string;
  name: string;
  machine: CloudMachineState;
  rawState: string;
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  autoStopAt: string | null;
  lifetimeSeconds: number | null;
  stoppedAt: string | null;
  createdAt: string | null;
  stop: {
    id: string;
    status: "pending" | "failing" | "completed" | "superseded" | "unknown";
    error: string | null;
  } | null;
  lastSnapshotAt: string | null;
  dataExpired: boolean;
  /** Snapshots were turned off at create: a stop erases the disk. */
  snapshotsDisabled: boolean;
  labels: Record<string, string>;
  /** This account may see the machine but not start or reach it. */
  restricted: boolean;
  /** The provider's word on why it is stopped or failed. */
  error: string | null;
}

/** How to reach the machine's sshd right now, as the provider's authenticated API said. */
export interface ProviderSshAccess {
  user: string;
  endpoint: SshEndpoint;
  /** The server's public key, `type base64`. */
  hostKey: string;
}

export interface ProviderCatalog {
  machineTypes: CloudMachineType[];
  canStart: boolean;
  includedHoursRemaining: number | null;
  startsRemaining: number | null;
  savedSnapshotDayDollars: number | null;
}

export interface ProviderCreateRequest {
  name: string;
  machineType: string;
  lifetimeSeconds: number | null;
  /** Non-secret identifiers that let a lost create be found again. */
  labels: Record<string, string>;
  idempotencyKey: string;
}

/**
 * One cloud provider: authentication, catalog, machine lifecycle and SSH
 * access, translated into Daintree's types. It holds no state and decides
 * nothing about whether a host is idle; the coordinator does.
 */
export interface CloudProvider {
  readonly id: CloudProviderId;
  info(platform: NodeJS.Platform): CloudProviderInfo;
  /** Checks a key the person pasted and lists the scopes it may bill. */
  checkKey(apiKey: string, apiUrl: string, signal?: AbortSignal): Promise<CloudAccountCheckResult>;
  validate(credentials: ProviderCredentials): Promise<{ identity: string | null }>;
  catalog(credentials: ProviderCredentials): Promise<ProviderCatalog>;
  /** Every machine in the scope; with `label`, only those carrying that `key=value`. */
  list(credentials: ProviderCredentials, options?: { label?: string }): Promise<ProviderResource[]>;
  inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource>;
  create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource>;
  /** Starts a stopped machine; resolves with what the provider said, which may still be starting. */
  start(
    credentials: ProviderCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null>;
  /** A normal, saving stop. Never forced. */
  stop(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource | null>;
  /** Moves the machine's automatic stop to `lifetimeSeconds` from now. */
  renewLifetime(
    credentials: ProviderCredentials,
    resourceId: string,
    lifetimeSeconds: number | null
  ): Promise<ProviderResource>;
  rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void>;
  delete(credentials: ProviderCredentials, resourceId: string): Promise<void>;
  authorizeSsh(
    credentials: ProviderCredentials,
    resourceId: string,
    publicKey: string
  ): Promise<ProviderSshAccess>;
  /** A provider failure as a typed, user-facing error. */
  describeError(error: unknown): CloudHostError;
}
