import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudMachineState,
  CloudMachineType,
  CloudProviderId,
  CloudProviderInfo,
  CloudProvisioning,
  CloudProvisioningDimension,
  CloudProvisioningOptions,
  CloudProvisioningSelection,
} from "../../../shared/types/cloudHosts.js";
import type { SshEndpoint } from "./sshEndpoint.js";

/** What a provider call needs to act for one account. Lives in main only. */
export interface ProviderCredentials {
  /** The account's whole credential set, keyed by the provider's declared field ids. */
  values: Readonly<CloudCredentialValues>;
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
  /** Stopped because the provider slept it on idle; a request to it would wake it. Absent: not asleep. */
  asleep?: boolean;
  /**
   * Whether this machine sleeps by itself when idle, and after how long, as
   * the provider reports it for this machine; absent when it doesn't say per
   * machine, and the provider's declared lifetime holds.
   */
  idleSleep?: { enabled: boolean; idleSeconds: number | null };
}

/** How to reach the machine's sshd right now, as the provider's authenticated API said. */
export interface ProviderSshAccess {
  user: string;
  endpoint: SshEndpoint;
  /**
   * The server's public key, `type base64`. Null when the provider doesn't
   * vouch for one: its tunnel does (`sshTrust: "provider-tunnel"`), or the
   * person confirms the key the machine presents (`"confirm-on-first-connect"`).
   * Under `"api-or-confirm"` it is the key the API reports when it has one yet,
   * and null when it doesn't, leaving the first key to the person.
   */
  hostKey: string | null;
}

export interface ProviderCatalog {
  machineTypes: CloudMachineType[];
  canStart: boolean;
  includedHoursRemaining: number | null;
  startsRemaining: number | null;
  savedSnapshotDayDollars: number | null;
  /**
   * The regions, images and networks this account may create with, for each
   * dimension the provider's capabilities say a create takes. One left out
   * reads as offering nothing; one the provider doesn't take is ignored.
   */
  provisioning?: Partial<Record<CloudProvisioningDimension, CloudProvisioningOptions>>;
}

export interface ProviderCreateRequest {
  name: string;
  machineType: string;
  /** The runtime limit, for a provider whose create takes one; always null for the rest. */
  lifetimeSeconds: number | null;
  /** What the person chose, checked against the catalog; the same on every retry of this create. */
  provisioning: CloudProvisioningSelection;
  /** Non-secret identifiers that let a lost create be found again. */
  labels: Record<string, string>;
  idempotencyKey: string;
  /**
   * The account's SSH public key, `type base64 comment`, for a provider whose
   * `provisioning.sshKey` is "at-create"; null for one that authorizes it after.
   * A retried create carries the same key.
   */
  publicKey: string | null;
}

/** A key that lets one machine act on itself, as the provider issued it. */
export interface IssuedMachineKey {
  keyId: string;
  /** Shown once; Daintree hands it to the machine and never stores it here. */
  secret: string;
  /** When the provider turns it off by itself (epoch ms). */
  expiresAt: number;
}

/** A key the provider issued but not as asked: never delivered, and revoked by its id. */
export class UnusableMachineKeyError extends Error {
  constructor(
    readonly keyId: string,
    /** When the provider said it expires; null when it vouched for none, so it works until revoked. */
    readonly expiresAt: number | null,
    message: string
  ) {
    super(message);
    this.name = "UnusableMachineKeyError";
  }
}

/**
 * Keys a machine uses to keep itself running while its host sees work and to
 * stop itself once idle: limited to that one machine, to reading it, moving
 * its lifetime and a normal stop, and revocable from the account.
 */
export interface MachineKeyIssuer {
  issue(
    credentials: ProviderCredentials,
    resourceId: string,
    request: { name: string; ttlDays: number }
  ): Promise<IssuedMachineKey>;
  /** Resolves once the key is off, including when it was already gone. */
  revoke(credentials: ProviderCredentials, keyId: string): Promise<void>;
  /** The ids of the account's keys with this exact name, to find one whose create lost its answer. */
  findByName(credentials: ProviderCredentials, name: string): Promise<string[]>;
}

/**
 * One cloud provider: authentication, catalog, machine lifecycle and SSH
 * access, translated into Daintree's types. It holds no state and decides
 * nothing about whether a host is idle; the coordinator does.
 */
export interface CloudProvider {
  readonly id: CloudProviderId;
  /**
   * What a create whose answer was lost may do once a lookup by its labels
   * finds nothing: send it again with the same idempotency key, which the
   * provider answers with the machine it made, if any (`same-key`, the
   * default); or only look again (`lookup-only`), for a provider with no such
   * key, where a second send could make a second machine.
   */
  readonly createReplay?: "same-key" | "lookup-only";
  info(platform: NodeJS.Platform): CloudProviderInfo;
  /**
   * Checks credentials the person entered, already normalised against the
   * declared fields, and lists the scopes they may bill. Runs before anything
   * is kept, for a new account and for a replacement alike.
   */
  checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal?: AbortSignal
  ): Promise<CloudAccountCheckResult>;
  validate(credentials: ProviderCredentials): Promise<{ identity: string | null }>;
  catalog(credentials: ProviderCredentials): Promise<ProviderCatalog>;
  /** Every machine in the scope; with `label`, only those carrying that `key=value`. */
  list(credentials: ProviderCredentials, options?: { label?: string }): Promise<ProviderResource[]>;
  inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource>;
  create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource>;
  /**
   * Starts a stopped machine; resolves with what the provider said, which may
   * still be starting. `lifetimeSeconds` is the runtime limit to start it with,
   * absent when it keeps whatever it has (and null for none).
   */
  start(
    credentials: ProviderCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Promise<ProviderResource | null>;
  /** A normal, saving stop. Never forced. */
  stop(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource | null>;
  /**
   * Moves the machine's automatic stop to `lifetimeSeconds` from now. Only a
   * provider whose lifetime is `renewable` has it, and that one must.
   */
  renewLifetime?(
    credentials: ProviderCredentials,
    resourceId: string,
    lifetimeSeconds: number | null
  ): Promise<ProviderResource>;
  rename(credentials: ProviderCredentials, resourceId: string, name: string): Promise<void>;
  /** Called only while the provider's capabilities declare `deletion`. */
  delete(credentials: ProviderCredentials, resourceId: string): Promise<void>;
  /**
   * Puts `publicKey` on the machine and says how to reach its sshd. Required
   * when `provisioning.sshKey` is "after-create". A provider that takes the
   * key at create may have it too, for a machine it didn't create with the
   * key (an imported one); it is then called for those alone.
   */
  authorizeSsh?(
    credentials: ProviderCredentials,
    resourceId: string,
    publicKey: string
  ): Promise<ProviderSshAccess>;
  /**
   * Says how to reach the sshd of a machine that took the key with its create,
   * changing nothing on it. Required when `provisioning.sshKey` is "at-create",
   * and only called then.
   */
  sshAccess?(credentials: ProviderCredentials, resourceId: string): Promise<ProviderSshAccess>;
  /** A provider failure as a typed, user-facing error. */
  describeError(error: unknown): CloudHostError;
  /** Present only for a provider whose machines can renew and stop themselves (#17361). */
  readonly machineKeys?: MachineKeyIssuer;
}

/** A provider that can move a running machine's automatic stop. */
export type RenewingCloudProvider = CloudProvider & Required<Pick<CloudProvider, "renewLifetime">>;

/**
 * Whether the provider can move a running machine's deadline: it says its
 * lifetime is renewable, and it has the method. Neither alone is enough.
 */
export function canRenewLifetime(provider: CloudProvider): provider is RenewingCloudProvider {
  return (
    provider.info(process.platform).capabilities.lifetime.kind === "renewable" &&
    typeof provider.renewLifetime === "function"
  );
}

/** When the provider takes Daintree's SSH key, as it declares. */
export function sshKeyTiming(provider: CloudProvider): CloudProvisioning["sshKey"] {
  return provider.info(process.platform).capabilities.provisioning.sshKey;
}

/** Why a provider can't take Daintree's SSH key the way its info declares; null when it can. */
export function sshKeyContractProblem(
  provider: CloudProvider,
  timing: CloudProvisioning["sshKey"]
): string | null {
  switch (timing) {
    case "at-create":
      return typeof provider.sshAccess === "function"
        ? null
        : "takes the SSH key at create but has no sshAccess";
    case "after-create":
      return typeof provider.authorizeSsh === "function"
        ? null
        : "authorizes the SSH key after create but has no authorizeSsh";
    default:
      return `declares an unknown SSH key timing ${JSON.stringify(timing)}`;
  }
}
