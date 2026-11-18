import type {
  CloudAccountCheckResult,
  CloudCredentialField,
  CloudCredentialValues,
  CloudMachineState,
  CloudMachineType,
  CloudProviderCapabilities,
  CloudProvisioningDimension,
  CloudProvisioningOptions,
  CloudProvisioningSelection,
} from "./cloudHosts.js";

/**
 * The cloud provider contract as a plugin implements it (#17351): the same
 * calls Daintree makes of a built-in provider, minus the two it answers
 * itself (what the provider is, from the manifest, and how its failures read).
 */

/** A machine as a provider reports it, normalised. */
export interface CloudProviderResource {
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
export interface CloudProviderSshAccess {
  user: string;
  /** A DNS name, an IPv4 address, or an IPv6 address without brackets, and its port. */
  endpoint: { host: string; port: number };
  /**
   * The server's public key, `type base64`. Null when the provider doesn't
   * vouch for one: its tunnel does (`sshTrust: "provider-tunnel"`), or the
   * person confirms the key the machine presents (`"confirm-on-first-connect"`).
   * Under `"api-or-confirm"` it is the key the API reports when it has one yet,
   * and null when it doesn't, leaving the first key to the person.
   */
  hostKey: string | null;
}

export interface CloudProviderCatalog {
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

export interface CloudProviderCreateRequest {
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

/** What one call needs to act for one account. Never kept past the call. */
export interface CloudProviderCallCredentials {
  /** The account's whole credential set, keyed by the declared field ids. */
  values: Readonly<CloudCredentialValues>;
  /** The billing scope every request names. */
  scopeId: string;
  /** The API origin the account was connected against: the manifest's `apiUrl`. */
  apiUrl: string;
  /** Aborted when Daintree stops waiting: its deadline passed, or the person cancelled. */
  signal: AbortSignal;
}

type Answer<T> = Promise<T> | T;

/**
 * A cloud provider bound with `host.registerCloudProvider` (#17351). Every
 * method may be asked at any time, with no state kept between calls, and each
 * has 30 seconds, the plugin's activation included.
 *
 * A failure the provider can name throws an `Error` whose `code` is a
 * `CloudHostErrorCode`: `credential-invalid`, `permission`, `billing`,
 * `rate-limited`, `capacity`, `ssh-authorization`, `unsupported` and
 * `refused` tell Daintree that nothing was done, so a refused create is
 * retried with a fresh key. Any other throw reads as `failed`.
 */
export interface CloudProviderImpl {
  /**
   * Checks credentials the person entered, already normalised against the
   * declared fields, and lists the scopes they may bill.
   */
  checkCredentials(
    values: Readonly<CloudCredentialValues>,
    apiUrl: string,
    signal: AbortSignal
  ): Answer<CloudAccountCheckResult>;
  validate(credentials: CloudProviderCallCredentials): Answer<{ identity: string | null }>;
  catalog(credentials: CloudProviderCallCredentials): Answer<CloudProviderCatalog>;
  /**
   * Every machine in the scope; with `label`, only those carrying that
   * `key=value`; with `location`, only those in that location, for a provider
   * whose create takes one (where a create was sent, when one is looked for).
   */
  list(
    credentials: CloudProviderCallCredentials,
    options: { label?: string; location?: string }
  ): Answer<CloudProviderResource[]>;
  inspect(
    credentials: CloudProviderCallCredentials,
    resourceId: string
  ): Answer<CloudProviderResource>;
  /**
   * Must be idempotent on `request.idempotencyKey`: a lost answer is retried
   * with the same key, unless the manifest declares `createReplay:
   * "lookup-only"`, when it is only ever looked for again.
   */
  create(
    credentials: CloudProviderCallCredentials,
    request: CloudProviderCreateRequest
  ): Answer<CloudProviderResource>;
  /** Starts a stopped machine; `lifetimeSeconds` is absent when it keeps the limit it has. */
  start(
    credentials: CloudProviderCallCredentials,
    resourceId: string,
    options: { lifetimeSeconds?: number | null }
  ): Answer<CloudProviderResource | null>;
  /** A normal, saving stop. Never forced. */
  stop(
    credentials: CloudProviderCallCredentials,
    resourceId: string
  ): Answer<CloudProviderResource | null>;
  /** Required, and only called, when `capabilities.lifetime.kind` is "renewable". */
  renewLifetime?(
    credentials: CloudProviderCallCredentials,
    resourceId: string,
    lifetimeSeconds: number | null
  ): Answer<CloudProviderResource>;
  rename(credentials: CloudProviderCallCredentials, resourceId: string, name: string): Answer<void>;
  /** Called only while `capabilities.deletion` is true. */
  delete(credentials: CloudProviderCallCredentials, resourceId: string): Answer<void>;
  /** Required, and only called, when `capabilities.provisioning.sshKey` is "after-create". */
  authorizeSsh?(
    credentials: CloudProviderCallCredentials,
    resourceId: string,
    publicKey: string
  ): Answer<CloudProviderSshAccess>;
  /** Required, and only called, when `capabilities.provisioning.sshKey` is "at-create". */
  sshAccess?(
    credentials: CloudProviderCallCredentials,
    resourceId: string
  ): Answer<CloudProviderSshAccess>;
}

/** Passed to `host.registerCloudProvider` alongside the impl; `id` names the manifest entry. */
export interface CloudProviderDescriptor {
  id: string;
}

export type CloudProviderMethod = keyof CloudProviderImpl;

/** Every method a provider has, in the order the contract lists them. */
export const CLOUD_PROVIDER_METHODS = [
  "checkCredentials",
  "validate",
  "catalog",
  "list",
  "inspect",
  "create",
  "start",
  "stop",
  "renewLifetime",
  "rename",
  "delete",
  "authorizeSsh",
  "sshAccess",
] as const satisfies readonly CloudProviderMethod[];

/** The methods every provider has, whatever it declares. */
export const CLOUD_PROVIDER_REQUIRED_METHODS = [
  "checkCredentials",
  "validate",
  "catalog",
  "list",
  "inspect",
  "create",
  "start",
  "stop",
  "rename",
  "delete",
] as const satisfies readonly CloudProviderMethod[];

/**
 * `contributes.cloudProviders` entry (#17351). Everything Daintree shows about
 * the provider comes from here, so it is listed, and its accounts and machines
 * are named, before any of the plugin's code runs.
 */
export interface CloudProviderContribution {
  /** The provider's name inside the plugin: registered as `{pluginId}.{id}`. */
  id: string;
  name: string;
  description: string;
  /** The https origin the plugin's API calls go to; an account is tied to the one it connected with. */
  apiUrl: string;
  /** Where to create an account or an API key; opened in the system browser. */
  apiKeyUrl: string;
  dashboardUrl: string;
  docsUrl: string;
  /** What connecting an account asks for, in order. */
  credentialFields: CloudCredentialField[];
  capabilities: CloudProviderCapabilities;
  /**
   * What a create whose answer was lost may do once a lookup by its labels
   * finds nothing: send it again with the same idempotency key (`same-key`,
   * the default when left out), or, for a provider with no such key, where a
   * second send could make a second machine, only look again (`lookup-only`).
   */
  createReplay?: "same-key" | "lookup-only";
}
