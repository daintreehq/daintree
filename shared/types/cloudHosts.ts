import type { HostId } from "./remoteHosts.js";

/**
 * Cloud hosts: a remote host whose machine a cloud provider runs and Daintree
 * can create, start and stop through that provider's API. The host itself is
 * still an ordinary Remote Host (same id, projects, link and Host runtime);
 * this vocabulary covers only the machine's lifecycle and the account that
 * pays for it. Nothing here ever carries a credential.
 */

/**
 * A cloud provider's id. A provider built into Daintree has a bare id
 * ("boat"); one an installed plugin contributes is named inside that plugin's
 * namespace, `{publisher}.{name}.{provider}`. The two shapes can't overlap, so
 * no plugin can take a built-in's id or another plugin's. Any id of either
 * shape is an id, registered right now or not: an account or host stored
 * under a provider that isn't registered is kept, and reported unavailable.
 */
export type CloudProviderId = BuiltInCloudProviderId | (string & {});

/** The providers compiled into this build; the open union keeps their names autocompleting. */
export type BuiltInCloudProviderId = "boat" | "agent37" | "digitalocean" | "gce" | "aws";

/** Where a provider's id lives: Daintree's own bare names, or one plugin's namespace. */
export type CloudProviderNamespace = { kind: "built-in" } | { kind: "plugin"; pluginId: string };

const ID_SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const BUILT_IN_PROVIDER_ID = new RegExp(`^${ID_SEGMENT}$`);
const PLUGIN_PROVIDER_ID = new RegExp(`^(${ID_SEGMENT}\\.${ID_SEGMENT})\\.(${ID_SEGMENT})$`);
const MAX_PROVIDER_NAME_LENGTH = 32;
const MAX_PLUGIN_ID_LENGTH = 64;

/** The namespace an id belongs to, or null when it isn't a provider id of either shape. */
export function cloudProviderNamespace(value: unknown): CloudProviderNamespace | null {
  if (typeof value !== "string") return null;
  if (value.length <= MAX_PROVIDER_NAME_LENGTH && BUILT_IN_PROVIDER_ID.test(value)) {
    return { kind: "built-in" };
  }
  if (value.length > MAX_PLUGIN_ID_LENGTH + 1 + MAX_PROVIDER_NAME_LENGTH) return null;
  const match = PLUGIN_PROVIDER_ID.exec(value);
  if (!match || match[1]!.length > MAX_PLUGIN_ID_LENGTH) return null;
  if (match[2]!.length > MAX_PROVIDER_NAME_LENGTH) return null;
  return { kind: "plugin", pluginId: match[1]! };
}

export function isCloudProviderId(value: unknown): value is CloudProviderId {
  return cloudProviderNamespace(value) !== null;
}

/** The id a plugin's provider is registered under, or null when either part isn't valid. */
export function pluginCloudProviderId(
  pluginId: string,
  providerName: string
): CloudProviderId | null {
  const id = `${pluginId}.${providerName}`;
  const namespace = cloudProviderNamespace(id);
  return namespace?.kind === "plugin" && namespace.pluginId === pluginId ? id : null;
}

export { isValidCloudBindingId } from "./remoteHosts.js";

const CLOUD_ACCOUNT_ID = /^ca_[a-z0-9]{8,32}$/;

export function isValidCloudAccountId(id: unknown): id is string {
  return typeof id === "string" && CLOUD_ACCOUNT_ID.test(id);
}

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
  /** Whether a stopped machine still bills for compute, not only for its disk. */
  stoppedComputeBilled: boolean;
  /**
   * Whether a stopped machine's disk keeps billing on its own, so stopping
   * cuts the bill to storage rather than ending it.
   */
  stoppedStorageBilled: boolean;
  /**
   * For one that bills a stopped machine for compute, what a stopped machine
   * bills, as one sentence in the provider's own terms; the general wording
   * when absent.
   */
  stoppedBilling?: string;
}

/**
 * Whether and how a machine stops by itself, without Daintree asking.
 * - `none`: it runs until someone stops it.
 * - `fixed-at-create`: a runtime limit chosen at create, which can't be moved while it runs;
 *   some providers let it change while the machine is stopped.
 * - `renewable`: a deadline that can be moved forward while the machine is in use.
 * - `idle-sleep`: the provider sleeps it once it has been idle for a while.
 */
export type CloudLifetimeModel =
  | { kind: "none" }
  | { kind: "fixed-at-create"; canChangeWhileStopped: boolean }
  | { kind: "renewable" }
  | {
      kind: "idle-sleep";
      /** How long the machine is idle before the provider sleeps it; null when the provider doesn't say. */
      idleSeconds: number | null;
    };

/**
 * Whether a create names how long the machine may run. Only a provider that
 * holds a machine to a deadline takes one; for the rest a create sends none.
 */
export function cloudLifetimeIsChosen(model: CloudLifetimeModel): boolean {
  return model.kind === "renewable" || model.kind === "fixed-at-create";
}

/**
 * Where the trust in a machine's SSH server key comes from.
 * - `pinned-from-api`: the provider's authenticated API returns it, so it is pinned before any dial.
 * - `confirm-on-first-connect`: nothing vouches for it; the person confirms its fingerprint once.
 * - `api-or-confirm`: the provider's authenticated API reports the key when it can (EC2's console
 *   output, which can lag boot); that report is trusted for a first connect when the machine
 *   presents exactly it, and otherwise the person confirms the fingerprint once. Direct only.
 * - `provider-tunnel`: the provider's own tunnel authenticates the machine, whose key may change
 *   when it is rebuilt or moved.
 */
export type CloudSshTrust =
  "pinned-from-api" | "confirm-on-first-connect" | "api-or-confirm" | "provider-tunnel";

/**
 * How the desktop reaches the machine's sshd: straight to an address, or
 * through a command the provider supplies (an ssh `ProxyCommand`).
 */
export type CloudSshTransport = "direct" | "provider-command";

/**
 * The command a `provider-command` transport runs as ssh's `ProxyCommand`:
 * the provider's own CLI, which the person installs and signs in to.
 */
export interface CloudSshTunnelCommand {
  /** The executable's bare name, looked up on this device's PATH: "agent37". */
  command: string;
  /** Its arguments: plain words, or exactly one of ssh's tokens %h, %p, %r or %n. */
  args: string[];
  /** Where the person gets the command; https only. */
  installUrl: string;
  /**
   * The line that installs the command, for the person to run on this device
   * themselves: "npm install -g agent37". One line, typed into a terminal but
   * never run by Daintree.
   */
  installCommand?: string;
  /** The line that signs the command in on this device, run the same way: "agent37 ssh setup". */
  signInCommand?: string;
}

/** Whether a create takes a value: never, when the person chooses to, or always. */
export type CloudProvisioningInput = "none" | "optional" | "required";

/** What a create names beyond the machine's name and type. */
export interface CloudProvisioning {
  /** The region or zone it runs in. */
  location: CloudProvisioningInput;
  /** The disk image it boots. */
  image: CloudProvisioningInput;
  /** The network, subnet or firewall it joins. */
  network: CloudProvisioningInput;
  /**
   * When Daintree's SSH public key reaches the machine: with the create
   * itself, or through the provider's API once the machine exists.
   */
  sshKey: "at-create" | "after-create";
}

/** What a provider can do, as semantics rather than a bare "supports start". */
export interface CloudProviderCapabilities {
  persistence: CloudProviderPersistence;
  /** About how long a start or create takes to running, for progress copy; null when unknown. */
  typicalStartSeconds: number | null;
  lifetime: CloudLifetimeModel;
  sshTrust: CloudSshTrust;
  transport: CloudSshTransport;
  /** The tunnel a `provider-command` transport runs; null for a direct one. */
  tunnel: CloudSshTunnelCommand | null;
  provisioning: CloudProvisioning;
  /** Machines can be deleted from Daintree. */
  deletion: boolean;
}

/**
 * One value an account's credentials are made of, as the provider declares
 * it: an API key, an access key id and its secret, a service-account key file.
 */
export interface CloudCredentialField {
  /** The key the value is kept and handed to the provider under: "apiKey", "secretAccessKey". */
  id: string;
  label: string;
  /** Masked as it's typed, kept only in the OS keychain, and never shown again. */
  secret: boolean;
  /** One line of text, text over several lines, or the contents of a file chosen from disk. */
  input: "single-line" | "multi-line" | "key-file";
  required: boolean;
  /** A short hint shown with the field; null for none. */
  help: string | null;
}

/**
 * What a person entered for an account's credentials, keyed by the provider's
 * declared field ids. It travels to main once, when credentials are checked,
 * connected or replaced, and never comes back.
 */
export type CloudCredentialValues = Record<string, string>;

/** The most one entered value may hold, in UTF-8 bytes: one line, then text over several lines or a key file. */
export const MAX_CLOUD_CREDENTIAL_LINE_BYTES = 4096;
export const MAX_CLOUD_CREDENTIAL_TEXT_BYTES = 64 * 1024;

export interface CloudProviderInfo {
  id: CloudProviderId;
  name: string;
  description: string;
  /**
   * The runtime limit a new machine's form starts at, in hours, for a
   * provider whose create chooses one; null for none. Absent:
   * {@link DEFAULT_CLOUD_LIFETIME_HOURS}.
   */
  defaultLifetimeHours?: number | null;
  /** Where to create an account or an API key; opened in the system browser. */
  apiKeyUrl: string;
  dashboardUrl: string;
  docsUrl: string;
  /** What connecting an account asks for, in order. */
  credentialFields: CloudCredentialField[];
  capabilities: CloudProviderCapabilities;
  /**
   * `delete-only`: its machines can't stop and start again, so Delete is the
   * only way one ends (closing an Akash lease destroys the container and its
   * disk). Absent: a stop keeps what `capabilities.persistence` says, and the
   * machine starts again. Only a built-in declares it; the field lives here
   * rather than in `capabilities` because a plugin's manifest declares those.
   */
  stopMode?: "delete-only";
  /**
   * `offers`: a create places an order, bidders answer it with offers, and
   * the machine is leased from the one the person chooses, so its price is
   * known only then. Absent: a create is one request, priced from the
   * catalog. Only a built-in declares it.
   */
  createMode?: "offers";
  /** Null when this platform's Shell can use the provider; otherwise why not. */
  unsupportedReason: string | null;
  /** Present for a plugin's provider: the plugin behind it, and whether the person has agreed to it. */
  plugin?: CloudProviderPluginConsent;
  /**
   * A machine's host can stop it once the host's idle time ends: Boat's
   * machine keys (#17361), EC2's and Compute Engine's guest power-off
   * (#17362). Set by this device for every registered provider, from what the
   * provider implements, never from a declaration, so a plugin's is false.
   */
  hostIdleStop?: boolean;
}

/**
 * Who stands behind a plugin's cloud provider (#17352). The plugin receives
 * the credentials entered, chooses the machines Daintree connects to and
 * vouches for their identity, and creates machines that bill the person's
 * own account, so it gets an account only once the person has agreed.
 */
export interface CloudProviderPluginConsent {
  pluginId: string;
  /** The plugin's display name, or its id when it has none. */
  pluginName: string;
  /**
   * What the person agrees to: every cloud provider the plugin declares now.
   * Sent back as `consent` with a check, connect, replace or review of an
   * account, so agreement to one version of the plugin never answers for another.
   */
  fingerprint: string;
  /** The person has agreed to exactly these declarations; false asks before any credentials go to it. */
  granted: boolean;
  /** The names of the providers one agreement covers. */
  providerNames: string[];
}

/**
 * What an account bills: the person's own wallet, an organization they belong
 * to, the one workspace a provider binds each key to, a cloud project (Google
 * Cloud's unit of billing and access), or the provider's account itself (an
 * AWS account), with no wallet to choose.
 */
export interface CloudBillingScope {
  kind: "personal" | "organization" | "workspace" | "project" | "account";
  /** The provider's id for it: what every request names. */
  id: string;
  name: string;
}

export type CloudAccountValidation =
  | { status: "valid"; checkedAt: number }
  | { status: "invalid"; checkedAt: number; detail: string }
  | { status: "unknown"; checkedAt: number | null; detail: string | null };

/**
 * What a plugin's cloud provider was last known as (#17353), kept with each of
 * its accounts so they still name it, and link its console, once the plugin is
 * turned off, blocked or uninstalled and its manifest can't be read.
 */
export interface CloudPluginProviderLabel {
  /** The plugin's display name. */
  pluginName: string;
  /** The provider's own name, as its manifest declared it. */
  providerName: string;
  /** The provider's console; null when what was kept doesn't read as a public https URL. */
  dashboardUrl: string | null;
}

/** A connected provider account, as the renderer sees it: never its key. */
export interface CloudAccountSummary {
  id: string;
  providerId: CloudProviderId;
  /** Null while its provider is registered; otherwise why it can't be used now. The account is kept either way. */
  providerUnavailable: string | null;
  /** What its plugin's provider was last known as; absent or null for a built-in, or before it was ever seen. */
  pluginProvider?: CloudPluginProviderLabel | null;
  displayName: string;
  /** Who the key signs in as, as the provider reports it. */
  identity: string | null;
  billingScope: CloudBillingScope;
  validation: CloudAccountValidation;
  /** Cloud hosts bound to this account. */
  hostCount: number;
  addedAt: number;
  /**
   * The last four characters of the first one-line secret, so two sets can be
   * told apart; null when the set has none long enough to hint at.
   */
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
  /**
   * The location ids it can be created in, as an image's are: absent or null
   * for every location, [] for none. A list needs a location named.
   */
  locations?: string[] | null;
}

/** The three things a create may name beyond its size, in the order a person picks them. */
export type CloudProvisioningDimension = "location" | "image" | "network";

export const CLOUD_PROVISIONING_DIMENSIONS: readonly CloudProvisioningDimension[] = [
  "location",
  "image",
  "network",
];

/** One region, image or network an account may create a machine with. */
export interface CloudProvisioningChoice {
  /** The provider's own id for it, opaque to Daintree. */
  id: string;
  label: string;
  /** A short line about it ("Ubuntu 24.04 LTS, x86-64"); null for none. */
  description: string | null;
  available: boolean;
  /** Why it isn't available, in the provider's words. */
  reason: string | null;
  /**
   * The location ids an image or network is offered in: null for every
   * location, [] for none. Always null on a location.
   */
  locations: string[] | null;
}

/** What a provider offers for one dimension of a create. */
export interface CloudProvisioningOptions {
  /** What the provider calls it: "Region", "Zone", "AMI", "Subnet". */
  label: string;
  choices: CloudProvisioningChoice[];
  /**
   * The provider's suggestion. For an optional dimension null means the
   * provider decides; for a required one, that it suggests nothing.
   */
  defaultId: string | null;
}

/**
 * The ids a create names. Null is "not named": the provider decides, which
 * only an optional dimension (or one the provider doesn't take) allows.
 */
export interface CloudProvisioningSelection {
  location: string | null;
  image: string | null;
  network: string | null;
}

/** One dimension as it was chosen at create, with the words to show it by afterwards. */
export interface CloudProvisioningPick {
  /** The provider's name for the dimension then: "Region". */
  label: string;
  /** Null when the provider was left to decide. */
  id: string | null;
  /** The choice's label then, or who decides when nobody chose. */
  value: string;
}

/** What a machine was created with; a dimension the provider didn't take is null. */
export type CloudHostProvisioning = Record<
  CloudProvisioningDimension,
  CloudProvisioningPick | null
>;

/** Whether a size, image or network can be used in a location; a location-bound one needs a location. */
export function cloudChoiceFitsLocation(
  choice: { readonly locations?: readonly string[] | null },
  location: string | null
): boolean {
  if (choice.locations === null || choice.locations === undefined) return true;
  return location !== null && choice.locations.includes(location);
}

/**
 * A location list as it arrives as data. A constraint that doesn't read
 * narrows, never widens: anything but a list, null or nothing ties it to none.
 */
export function cloudLocationsFrom(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return value.filter((location): location is string => typeof location === "string");
}

/**
 * Why a size can't be created in the location chosen, in words for its row
 * and for a create's refusal; null when it can. `options` is the catalog's
 * location dimension, for the words.
 */
export function cloudMachineTypeLocationReason(
  type: Pick<CloudMachineType, "locations">,
  options: CloudProvisioningOptions | null,
  location: string | null
): string | null {
  if (cloudChoiceFitsLocation(type, location)) return null;
  const noun = cloudProvisioningNoun(options?.label ?? "Location");
  const labelOf = (id: string) => options?.choices.find((choice) => choice.id === id)?.label ?? id;
  const offered = type.locations ?? [];
  if (offered.length === 0) return `not offered in any ${noun}`;
  if (location !== null) return `not offered in ${labelOf(location)}`;
  // Only what the account can pick: a location it can't would be no way out.
  const usable = options
    ? offered.filter((id) => options.choices.some((choice) => choice.id === id && choice.available))
    : offered;
  return usable.length > 0
    ? `choose ${usable.map(labelOf).join(" or ")} to use it`
    : `not offered in any ${noun} this account can use`;
}

/** A dimension's name inside a sentence: "region", "AMI". */
export function cloudProvisioningNoun(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label[0]!.toLowerCase()}${label.slice(1)}` : label;
}

/** The same, with its article: "a region", "an AMI". */
export function cloudProvisioningArticleNoun(label: string): string {
  const noun = cloudProvisioningNoun(label);
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

export interface CloudCatalog {
  accountId: string;
  machineTypes: CloudMachineType[];
  /**
   * What a create may name, per dimension the provider takes; null for a
   * dimension it doesn't. Boat takes none; DigitalOcean a region and an image.
   */
  provisioning: Record<CloudProvisioningDimension, CloudProvisioningOptions | null>;
  /** What this account's last create named on this device; null before its first. */
  lastChoice: CloudProvisioningSelection | null;
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
  /** Stopped because the provider slept it on idle. */
  asleep: boolean;
}

/**
 * An order an offer-based create placed (`createMode: "offers"`), by the
 * provider's own id for it, opaque to Daintree.
 */
export interface CloudCreateOrder {
  id: string;
}

/** Who made an offer on an order, as the provider reports them. */
export interface CloudOfferBidder {
  /** The provider's own id for the bidder (an Akash provider address), opaque to Daintree; stable across orders. */
  id: string;
  name: string;
  /** Where it runs, in the provider's words; null when it declares none. */
  region: string | null;
  /** Its share of recent time online, 0 to 100; absent when the provider doesn't say. */
  uptimePercent?: number;
  /** Whether an auditor the provider recognises vouches for it; absent when the provider doesn't say. */
  audited?: boolean;
}

/** One offer on an order: a bidder's quote to run the machine, and whether it can be chosen. */
export type CloudCreateOffer = {
  /** The provider's own id for it, opaque to Daintree and meaningful only with its order. */
  id: string;
  /** The rate it quotes, in dollars per running hour. */
  hourlyDollars: number;
  bidder: CloudOfferBidder;
} & (
  | { choosable: true; reason: null }
  | {
      choosable: false;
      /** Why not, in words for its row: a bidder outside the account's trusted list, say. */
      reason: string;
    }
);

/**
 * A create waiting on the person to choose one of its order's offers. Offers
 * arrive while it waits, so an empty list read early isn't the last word.
 */
export interface CloudCreateOfferChoice {
  kind: "awaiting-offer";
  order: CloudCreateOrder;
  /** When the order was placed. */
  placedAt: number;
  /** Its offers as last read, those that can't be chosen too; [] before any arrived. */
  offers: CloudCreateOffer[];
  /** When the offers were last read; null before the first read. */
  offersReadAt: number | null;
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
  | "ssh-tunnel-command-missing"
  | "provider-unreachable"
  | "outcome-unknown"
  | "unsupported"
  | "lifetime-renewal"
  /** The provider turned the request down as it was made (a size its region lacks, a limit reached); nothing changed. */
  | "refused"
  | "failed";

/** Every code, so a code that arrives as data (from a plugin) can be checked. */
const CLOUD_HOST_ERROR_CODES = {
  "credential-invalid": true,
  permission: true,
  billing: true,
  "rate-limited": true,
  capacity: true,
  "not-found": true,
  "data-expired": true,
  "stop-failing": true,
  "ssh-authorization": true,
  "ssh-tunnel-command-missing": true,
  "provider-unreachable": true,
  "outcome-unknown": true,
  unsupported: true,
  "lifetime-renewal": true,
  refused: true,
  failed: true,
} as const satisfies Record<CloudHostErrorCode, true>;

export function isCloudHostErrorCode(value: unknown): value is CloudHostErrorCode {
  return typeof value === "string" && Object.hasOwn(CLOUD_HOST_ERROR_CODES, value);
}

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

/** A worktree as a mark names it: where it lives, its project there, and its root path. */
export type CloudWorktreeRef = Pick<CloudHostCreatedFor, "hostId" | "projectId" | "worktreeId">;

/** Whether a machine's mark names this worktree. Names never count: only where it lives. */
export function cloudMarkNamesWorktree(
  mark: CloudHostCreatedFor | null,
  worktree: CloudWorktreeRef
): boolean {
  return (
    mark !== null &&
    mark.hostId === worktree.hostId &&
    mark.projectId === worktree.projectId &&
    mark.worktreeId === worktree.worktreeId
  );
}

/** What becomes of a machine made for a worktree when that worktree is deleted. */
export type CloudWorktreeCleanupChoice = "keep" | "stop" | "delete";

/** One machine to stop or delete once its worktree is gone, naming the machine the person confirmed. */
export interface CloudWorktreeCleanupRequest {
  hostId: HostId;
  resourceId: string;
  choice: Exclude<CloudWorktreeCleanupChoice, "keep">;
}

/**
 * A stop or delete the person chose with a worktree's delete, until it is
 * done. `waiting`: the worktree isn't known to be gone yet. `running`: it is,
 * and the stop or delete is under way or will resume (with `error` saying why
 * it can't yet, when its provider isn't available). `failed`: it didn't
 * finish, and waits for Retry. `unconfirmed`: Daintree never heard whether a
 * worktree on another host went, so nothing is done until the person decides.
 */
export interface CloudWorktreeCleanupStatus {
  choice: Exclude<CloudWorktreeCleanupChoice, "keep">;
  phase: "waiting" | "running" | "failed" | "unconfirmed";
  /** Where the worktree lives: null for this device, whose worktree Daintree can look at itself. */
  worktreeHostId: HostId | null;
  error: CloudHostError | null;
}

/** How one machine's stop or delete ended, for whoever is waiting on the worktree's delete. */
export interface CloudWorktreeCleanupOutcome {
  hostId: HostId;
  machineName: string;
  choice: Exclude<CloudWorktreeCleanupChoice, "keep">;
  /** Null when it was carried out, or wasn't due because the worktree is still there. */
  error: string | null;
}

/**
 * A server key the machine presented that nobody has confirmed, for a
 * provider that can't vouch for one. The machine isn't dialled until the
 * person trusts it; nothing ever trusts it for them.
 */
export interface CloudHostKeyReview {
  /** `first-connect`: no key is trusted yet. `changed`: it differs from the trusted key. */
  reason: "first-connect" | "changed";
  /** SHA256 fingerprint of the key it presents now, as ssh-keygen -l prints it. */
  fingerprint: string;
  /** Its algorithm as ssh-keygen -l names it: ED25519, ECDSA, RSA. */
  keyType: string;
  /** When the machine presented it. */
  seenAt: number;
  /** The trusted key's fingerprint, when the key changed. */
  previousFingerprint: string | null;
  /** When the person trusted that key, when the key changed. */
  previousTrustedAt: number | null;
}

/**
 * One cloud host's lifecycle, joined to its Remote Host by `hostId`.
 * Observations, with the time they were made: a stale one says so rather
 * than passing for current.
 */
export interface CloudHostStatus {
  hostId: HostId;
  providerId: CloudProviderId;
  /** Null while its provider is registered; otherwise why the machine can't be reached now. The host is kept either way. */
  providerUnavailable: string | null;
  /** Its account's {@link CloudAccountSummary.pluginProvider}. */
  pluginProvider?: CloudPluginProviderLabel | null;
  accountId: string;
  accountName: string;
  /** Null before the machine exists (a saved draft or a create still under way). */
  resourceId: string | null;
  /** The machine's name in the provider's account, as last reported or as asked for. */
  machineName: string | null;
  ownership: "created-by-daintree" | "imported";
  /** The worktree it was created for; null for every other machine. */
  createdFor: CloudHostCreatedFor | null;
  /** A stop or delete chosen with that worktree's delete and not yet done; null for none. */
  worktreeCleanup: CloudWorktreeCleanupStatus | null;
  /** The region, image and network it was created with; null when none was named (imported, or a provider that takes none). */
  provisioning: CloudHostProvisioning | null;
  machine: CloudMachineState;
  rawState: string | null;
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  hourlyDollars: number | null;
  /** Whether and how its provider stops a machine by itself; null while its provider isn't registered. */
  lifetime: CloudLifetimeModel | null;
  /** When the provider last said it stops the machine by itself; null when it reported no deadline. */
  autoStopAt: string | null;
  /**
   * The runtime limit asked for at create or start, in seconds; null for none.
   * Meaningful only for a lifetime model a create chooses (`cloudLifetimeIsChosen`).
   */
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
  /**
   * A create waiting on the person's choice, with or without an operation
   * under way (a restart mid-choice leaves none). Absent or null when there
   * is none; optional for snapshots from before it.
   */
  pendingCreate?: CloudCreateOfferChoice | null;
  lastError: CloudHostError | null;
  /** When the provider was last asked; null when it never answered. */
  observedAt: number | null;
  /** Diagnostic only: the address the last access resolution returned. Never identity. */
  lastEndpoint: string | null;
  /** SHA256 fingerprint of the pinned server key. */
  hostKeyFingerprint: string | null;
  /** A presented key waiting for the person to trust it; null when there is none. */
  hostKeyReview: CloudHostKeyReview | null;
  /** When this device last moved the machine's auto-stop forward because it was in use here. */
  keptRunningAt: number | null;
  /**
   * Why the machine can't renew and stop itself by its host's idle time, as
   * this device last found (#17361); null when nothing stands in the way, or
   * its provider has no such keys. Optional for snapshots from before it.
   */
  selfStopProblem?: string | null;
  /**
   * What this device does once the host's idle time ends, while it is linked
   * to the host, for a plugin provider's machine that can't stop itself
   * (#17923). Absent or null for a machine this device never stops.
   */
  linkedIdleStop?: CloudLinkedIdleStop | null;
  /**
   * The provider put the stopped machine to sleep on idle rather than being
   * asked to stop it: a request to it would wake it, and it bills as stopped.
   */
  asleep: boolean;
  /**
   * The machine's own idle timeout follows its host's idle time: Daintree
   * created it, or the person picked an idle time for it here (#17916). An
   * imported machine keeps its own until then. Optional for snapshots from before it.
   */
  idleTimeFollowsHost?: boolean;
  /**
   * Whether the host holds the machine awake while it sees work with no
   * device connected, as this device last heard from it (#17918). Absent or
   * null for a provider with no such hold.
   */
  keepAwake?: CloudKeepAwake | null;
}

/**
 * `held`: the host said it holds a link that keeps the machine awake while
 * it sees work until `expiresAt`, when this device last asked at
 * `confirmedAt`; `reached` once it said a request through that link reached
 * it. `expired`: the last one it said it held has run out. `none`: it holds
 * none, with why when the host or this device found out; a null problem is
 * nothing handed over yet.
 */
export type CloudKeepAwake =
  | { kind: "held"; expiresAt: number; confirmedAt: number; reached: boolean }
  | { kind: "expired"; expiredAt: number }
  | { kind: "none"; problem: string | null };

/**
 * `stops`: this device stops the machine with the provider's normal stop once
 * the host grants it the ended idle time. `sleeps`: it puts the machine to
 * sleep the same way, for a provider whose own idle timer a link keeps from
 * running, which is in charge with no device linked (#17916). `unknown`: the
 * provider hasn't said yet whether a stop would keep this machine's disk.
 * `blocked`: why it doesn't.
 */
export type CloudLinkedIdleStop =
  | { kind: "stops" }
  | { kind: "sleeps" }
  | { kind: "unknown" }
  | { kind: "blocked"; problem: string };

/** The machine as it would be created. */
export interface CloudHostCreateRequest {
  accountId: string;
  name: string;
  machineType: string;
  /**
   * Hours the machine may run before the provider stops it (unless renewed,
   * where the provider allows it); null for never. Always null for a provider
   * whose lifetime a create doesn't choose.
   */
  lifetimeHours: number | null;
  /**
   * The region, image and network, for a provider that takes any. Checked
   * against the account's catalog as sent, never filled in.
   */
  provisioning?: CloudProvisioningSelection;
  /**
   * Turn on the host's MCP server on its first connection, so the person's
   * assistant can run tools there (#18187). Asked once, never again after.
   */
  mcpServerOnConnect?: boolean;
}

/**
 * Whether a provider's tunnel command is on this device's PATH, looked for
 * before a create. Found says only that it is installed there, never that it
 * is signed in.
 */
export interface CloudTunnelLookup {
  command: string;
  found: boolean;
}

/**
 * A machine created for a worktree on this device, from the New Worktree
 * dialog. Main writes the mark from `worktree` and its own record of the
 * project, and the worktree waits on the new host to open there once it is
 * set up; the machine is created exactly as `machine` asks, as Settings →
 * Hosts' create would.
 */
export interface CloudHostCreateForWorktreeRequest {
  machine: CloudHostCreateRequest;
  worktree: {
    /** The local project's id: the asking window's own. */
    projectId: string;
    /** The worktree's root path on this device. */
    worktreeId: string;
    /** Its branch, or its name when it has none. */
    worktreeName: string;
  };
}

export interface CloudHostImportRequest {
  accountId: string;
  resourceId: string;
  name: string;
  /** As {@link CloudHostCreateRequest.mcpServerOnConnect}. */
  mcpServerOnConnect?: boolean;
}

export interface CloudAccountAddRequest {
  providerId: CloudProviderId;
  /** Read once in main, sealed in the keychain as one set, and never returned. */
  credentials: CloudCredentialValues;
  scopeId: string;
  displayName?: string;
  /** For a plugin's provider: `CloudProviderPluginConsent.fingerprint` as shown to the person. */
  consent?: string;
}

export interface CloudHostsSnapshot {
  providers: CloudProviderInfo[];
  accounts: CloudAccountSummary[];
  hosts: CloudHostStatus[];
}

/**
 * A cloud account whose provider comes from a plugin, as that plugin's
 * uninstall asks about it (#17353): the account, and the hosts that would
 * leave this device with it. Their machines are never touched either way.
 */
export interface PluginCloudAccountInfo {
  id: string;
  name: string;
  providerName: string;
  hosts: Array<{ hostId: string; name: string }>;
}

export type CloudHostsEvent = { type: "changed"; snapshot: CloudHostsSnapshot };

/** Lifetimes offered when a machine is created (or a fixed limit changed), in hours; null is "never stops by itself". */
export const CLOUD_LIFETIME_CHOICES: readonly (number | null)[] = [1, 2, 4, 8, 24, null];

export const DEFAULT_CLOUD_LIFETIME_HOURS = 2;

/**
 * Whether the machine is billing compute right now, as far as was observed. A
 * stopped one bills when its provider declares that it does.
 */
export function cloudMachineIsBilling(
  machine: CloudMachineState,
  persistence: Pick<CloudProviderPersistence, "stoppedComputeBilled">
): boolean | null {
  switch (machine) {
    case "starting":
    case "running":
    case "stopping":
      return true;
    case "stopped":
      return persistence.stoppedComputeBilled;
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
