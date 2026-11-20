import type {
  CloudAccountCheckResult,
  CloudCredentialValues,
  CloudHostError,
  CloudProviderId,
  CloudProviderInfo,
  CloudProvisioning,
} from "../../../shared/types/cloudHosts.js";
import type {
  CloudProviderCatalog,
  CloudProviderCreateRequest,
  CloudProviderResource,
  CloudProviderSshAccess,
} from "../../../shared/types/pluginCloudProvider.js";
import type { GuestPowerOffTarget } from "./machineKeeperLink.js";

/** Why a cloud host can't run here: the Shell reaches hosts on Windows through WSL only. */
export const CLOUD_HOSTS_UNSUPPORTED_ON_WINDOWS =
  "Cloud hosts need Daintree for macOS or Linux. Daintree for Windows reaches hosts through WSL only.";

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

export type ProviderResource = CloudProviderResource;
export type ProviderSshAccess = CloudProviderSshAccess;
export type ProviderCatalog = CloudProviderCatalog;
export type ProviderCreateRequest = CloudProviderCreateRequest;

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
 * Whether the machine powering its own OS off would be a normal stop that
 * keeps its disk, as the provider reports the machine now, and how its host
 * names itself (its cloud metadata server's identity for it).
 */
export type GuestPowerOffCheck =
  | { eligible: true; target: GuestPowerOffTarget }
  | {
      eligible: false;
      /** Null when the machine can't be named at all. */
      target: GuestPowerOffTarget | null;
      /** Why not, in a sentence for the host's details. */
      problem: string;
    };

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
  /**
   * Every machine in the scope; with `label`, only those carrying that
   * `key=value`; with `location`, only those in that location, for a provider
   * whose create takes one (where a create was sent, when one is looked for).
   */
  list(
    credentials: ProviderCredentials,
    options?: { label?: string; location?: string }
  ): Promise<ProviderResource[]>;
  inspect(credentials: ProviderCredentials, resourceId: string): Promise<ProviderResource>;
  create(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<ProviderResource>;
  /**
   * For a provider with work to do before it asks for the machine (Agent 37
   * registers the key): does that work, asking for nothing, and answers with
   * the send that does ask. The create is marked sent between the two, so one
   * interrupted while it is readied is known never to have reached the
   * provider. Without it, `create` is the send and is marked before it starts.
   */
  prepareCreate?(
    credentials: ProviderCredentials,
    request: ProviderCreateRequest
  ): Promise<() => Promise<ProviderResource>>;
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
  /**
   * A normal, saving stop. Never forced. `once` sends it a single time, for a
   * stop whose reason has to be checked again before any second try: an idle
   * stop, whose idle time new work may have ended by the time a resend went.
   */
  stop(
    credentials: ProviderCredentials,
    resourceId: string,
    options?: { once?: boolean }
  ): Promise<ProviderResource | null>;
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
   * key at create may have it too, for a machine that may not hold the
   * account's key: an imported one, or a created one whose key was made again
   * since (#17929). It is then called for those alone.
   */
  authorizeSsh?(
    credentials: ProviderCredentials,
    resourceId: string,
    publicKey: string
  ): Promise<ProviderSshAccess>;
  /**
   * Says how to reach the sshd of a machine that took the key with its create,
   * changing nothing on it. Required when `provisioning.sshKey` is "at-create",
   * and only called then. Without `authorizeSsh`, a created machine whose key
   * is missing from this device is refused instead.
   */
  sshAccess?(credentials: ProviderCredentials, resourceId: string): Promise<ProviderSshAccess>;
  /** A provider failure as a typed, user-facing error. */
  describeError(error: unknown): CloudHostError;
  /** Present only for a provider whose machines can renew and stop themselves (#17361). */
  readonly machineKeys?: MachineKeyIssuer;
  /**
   * Present only for a provider where a machine powering its own OS off is a
   * normal stop that keeps its disk, so its host can stop it once idle with
   * no credential on the machine (#17362). Throws when the provider couldn't
   * be asked; answers why not when it was, and the machine isn't one.
   */
  checkGuestPowerOff?(
    credentials: ProviderCredentials,
    resourceId: string
  ): Promise<GuestPowerOffCheck>;
  /**
   * Present only for a provider whose `idle-sleep` lifetime this device can
   * drive (#17916): puts a running machine to sleep now, keeping its memory.
   * Sends one request and never repeats it, since whoever calls it acts on its
   * host's idleness once; a machine already asleep is the same outcome.
   */
  sleepIdle?(credentials: ProviderCredentials, resourceId: string): Promise<void>;
  /**
   * Present with {@link sleepIdle}: sets how long the machine may go without
   * activity before its provider sleeps it, and turns that sleep on when
   * `enable`. Applies at once, whatever the machine is doing.
   */
  setIdleSleep?(
    credentials: ProviderCredentials,
    resourceId: string,
    idleSeconds: number,
    enable: boolean
  ): Promise<ProviderResource>;
  /**
   * Present only for a provider whose idle timer counts traffic on the
   * machine's own URLs, Agent 37's (#17918): a URL reaching `port` of the
   * machine alone, with no account key, that its host sends requests to
   * itself through while it sees work. `expiresAt` is epoch milliseconds.
   */
  keepAwakeUrl?(
    credentials: ProviderCredentials,
    resourceId: string,
    port: number
  ): Promise<{ url: string; expiresAt: number }>;
}

/** A provider that can put its idle machines to sleep for this device, and set when they would by themselves. */
export type IdleSleepingCloudProvider = CloudProvider &
  Required<Pick<CloudProvider, "sleepIdle" | "setIdleSleep">>;

export function canSleepIdle(provider: CloudProvider): provider is IdleSleepingCloudProvider {
  return (
    provider.info(process.platform).capabilities.lifetime.kind === "idle-sleep" &&
    typeof provider.sleepIdle === "function" &&
    typeof provider.setIdleSleep === "function"
  );
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
