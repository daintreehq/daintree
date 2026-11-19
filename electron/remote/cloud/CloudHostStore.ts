import {
  CLOUD_PROVISIONING_DIMENSIONS,
  isCloudProviderId,
  isValidCloudAccountId,
  isValidCloudBindingId,
  type CloudAccountValidation,
  type CloudBillingScope,
  type CloudHostCreatedFor,
  type CloudHostError,
  type CloudHostProvisioning,
  type CloudPluginProviderLabel,
  type CloudWorktreeRef,
  type CloudProviderId,
  type CloudProvisioningPick,
  type CloudProvisioningSelection,
} from "../../../shared/types/cloudHosts.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";
import { isPrivateOrLoopbackHostname } from "../../schemas/pluginIdentifiers.js";
import { normalizeHostKey } from "./sshEndpoint.js";

/**
 * Cloud accounts and the bindings that tie a Remote Host to a provider's
 * machine, in the device-owned `cloudHosts` store key. Like `remoteHosts`, the
 * key is absent from the store defaults, so a settings file is untouched until
 * someone connects an account.
 *
 * An account's credentials are never here: CloudCredentialVault holds them. A binding keeps
 * the machine's identity (its provider id), never its address: the address is
 * resolved again on every start and kept only as a diagnostic.
 */

export interface StoredCloudAccount {
  id: string;
  providerId: CloudProviderId;
  displayName: string;
  identity: string | null;
  scope: CloudBillingScope;
  /** The API base URL the credentials were checked against; they are never sent anywhere else. */
  apiUrl: string;
  keyHint: string | null;
  /**
   * Changes every time the credentials are connected or replaced, so an answer
   * about an earlier set is never taken for one about these. Null on accounts
   * connected before it was kept, until their credentials are next replaced.
   */
  credentialRevision: string | null;
  addedAt: number;
  validation: CloudAccountValidation;
  /** What this account's last create named, offered first next time; null before its first. */
  lastProvisioning: CloudProvisioningSelection | null;
  /**
   * What its plugin's provider was called, and where its console was, when it
   * was last registered (#17353); null for a built-in's account, or one whose
   * provider hasn't been seen since this was kept.
   */
  pluginProvider: CloudPluginProviderLabel | null;
}

/** A create that may have reached the provider: kept until its outcome is known. */
export interface StoredCreationIntent {
  operationId: string;
  idempotencyKey: string;
  /** The first send; null until one went out. */
  sentAt: number | null;
  /** The latest send, which with a same-key replay may be the one that made the machine. */
  lastSentAt: number | null;
  name: string;
  machineType: string;
}

/**
 * A stop or delete the person chose when deleting the worktree a machine was
 * made for, written before that delete is sent and kept until it is done, so a
 * restart at any point carries it on. It names the machine and worktree as
 * confirmed: a binding whose machine or mark has changed since never acts on it.
 * `waiting`: the worktree isn't known to be gone. `due`: it is, so the stop or
 * delete runs (again, after a restart). `failed`: it didn't finish and waits
 * for Retry; a restart never retries it by itself. `unconfirmed`: Daintree
 * quit before hearing whether a worktree on another host went, so nothing is
 * done until the person settles it. Each attempt at the delete writes a new
 * `attemptId`, so an answer about an earlier attempt never changes a later one.
 */
export interface StoredWorktreeCleanup {
  attemptId: string;
  /** The worktree delete it came with, as its view named it; only that delete's answer settles it. */
  mutationId: string | null;
  choice: "stop" | "delete";
  resourceId: string;
  worktree: CloudWorktreeRef;
  phase: "waiting" | "due" | "failed" | "unconfirmed";
  error: CloudHostError | null;
  requestedAt: number;
}

/** How the machine's sshd answered the last time access was resolved. Diagnostic and pinning only. */
export interface StoredSshAccess {
  user: string;
  host: string;
  port: number;
  /** Null when the provider's tunnel vouched for the machine and nothing was pinned. */
  hostKey: string | null;
  obtainedAt: number;
}

/** A server key, `type base64`, and when it was trusted or seen. */
export interface StoredHostKey {
  key: string;
  at: number;
}

export interface StoredCloudObservation {
  machine: string;
  /** The machine's name in the provider's account. */
  name: string | null;
  rawState: string;
  machineType: string | null;
  vcpu: number | null;
  memoryGB: number | null;
  autoStopAt: string | null;
  lifetimeSeconds: number | null;
  stoppedAt: string | null;
  stop: { status: string; error: string | null } | null;
  lastSnapshotAt: string | null;
  dataExpired: boolean;
  /** Stopped because the provider slept it on idle. */
  asleep: boolean;
  /** Whether it sleeps when idle, as the provider reported for this machine; null when it didn't say. */
  idleSleep: { enabled: boolean; idleSeconds: number | null } | null;
  observedAt: number;
}

export interface StoredCloudBinding {
  id: string;
  /** The Remote Host this machine is; null only for a moment while the host is added. */
  hostId: HostId | null;
  accountId: string;
  providerId: CloudProviderId;
  resourceId: string | null;
  ownership: "created-by-daintree" | "imported";
  /** The worktree this machine was created for; kept after its create is settled. */
  createdFor: CloudHostCreatedFor | null;
  /** What to do with the machine now that worktree is being deleted; null for nothing. */
  worktreeCleanup: StoredWorktreeCleanup | null;
  /**
   * The region, image and network its create named, kept after the create
   * is settled: every retry sends these, and the host's details show them.
   * "unreadable" when a record holds one that doesn't read (see readHostProvisioning).
   */
  provisioning: CloudHostProvisioning | "unreadable" | null;
  creation: StoredCreationIntent | null;
  /** The lifetime a start and every renewal sets, in seconds; null for none. */
  lifetimeSeconds: number | null;
  /** What the person last asked of the machine: a stop they chose is never undone by a reconnect. */
  intent: "run" | "stop" | null;
  observation: StoredCloudObservation | null;
  access: StoredSshAccess | null;
  /**
   * The server key the person confirmed, for a provider whose API can't vouch
   * for one. Unlike `access` it outlives every stop and start: it is the
   * machine's identity, and only the person replaces it.
   */
  trustedHostKey: StoredHostKey | null;
  /** A key the machine presented that nobody has confirmed: its first, or one unlike the trusted key. */
  offeredHostKey: StoredHostKey | null;
  lastError: CloudHostError | null;
  createdAt: number;
}

/** Put on every machine a create asks for, naming its binding, so a lost answer is found again. */
export const CLOUD_BINDING_LABEL = "daintree-binding";

/**
 * Where a create's machine may have been made, by the provider's clock against
 * this one: from shortly before its send (a clock behind), to the slowest
 * create request (Agent 37's five minutes) plus a machine minted after it and
 * a clock ahead.
 */
const CREATED_BEFORE_SEND_MS = 5 * 60_000;
const CREATED_AFTER_SEND_MS = 15 * 60_000;

/**
 * Whether a machine was made while a send at `sentAt` could have made it;
 * null when its create time is unknown, false when nothing was sent. A copy of
 * a machine (a fork) carries its labels, but never its create time.
 */
export function madeInSendWindow(sentAt: number | null, createdAt: string | null): boolean | null {
  if (sentAt === null) return false;
  const at = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return at >= sentAt - CREATED_BEFORE_SEND_MS && at <= sentAt + CREATED_AFTER_SEND_MS;
}

/**
 * Whether any of a create's sends could have made a machine: its create time
 * is unknown, or falls from the first send's window to the latest's.
 */
export function mayHaveMade(
  creation: Pick<StoredCreationIntent, "sentAt" | "lastSentAt">,
  createdAt: string | null
): boolean {
  if (creation.sentAt === null) return false;
  const at = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(at)) return true;
  // Either send may read earlier: a clock set back between them.
  const sends = [creation.sentAt, creation.lastSentAt ?? creation.sentAt];
  return (
    at >= Math.min(...sends) - CREATED_BEFORE_SEND_MS &&
    at <= Math.max(...sends) + CREATED_AFTER_SEND_MS
  );
}

/**
 * Which binding has a claim on a machine: the one that holds it or, failing
 * that, one whose unanswered create may have made it (it carries the create's
 * label, and `mayHaveMade`). A pending claim is a "may", never proof.
 * Bindings of other providers, and `except`, don't count.
 */
export function cloudMachineClaim(
  bindings: readonly StoredCloudBinding[],
  providerId: CloudProviderId,
  machine: {
    resourceId: string;
    labels?: Readonly<Record<string, string>>;
    createdAt?: string | null;
  },
  except?: string
): { binding: StoredCloudBinding; pending: boolean } | null {
  const others = bindings.filter(
    (binding) => binding.providerId === providerId && binding.id !== except
  );
  const holder = others.find((binding) => binding.resourceId === machine.resourceId);
  if (holder) return { binding: holder, pending: false };
  const named = machine.labels?.[CLOUD_BINDING_LABEL];
  const creating = named
    ? others.find(
        (binding) =>
          binding.id === named &&
          !binding.resourceId &&
          binding.creation !== null &&
          mayHaveMade(binding.creation, machine.createdAt ?? null)
      )
    : undefined;
  return creating ? { binding: creating, pending: true } : null;
}

/**
 * A key Daintree issued so one machine can renew and stop itself (#17361):
 * never its secret, which only the machine holds, but enough to revoke it.
 * Written before the provider is asked, so a key whose answer was lost is
 * still found by its name.
 */
export interface StoredMachineKey {
  id: string;
  bindingId: string;
  accountId: string;
  providerId: CloudProviderId;
  resourceId: string;
  /** Unique to this issue, so a create whose answer was lost can be found. */
  name: string;
  keyId: string | null;
  expiresAt: number | null;
  /**
   * `issuing` until the provider answers, `delivering` until the machine
   * confirms it holds it, `active` while it does, and `revoke` once nothing
   * should: replaced, refused, or its host removed.
   */
  state: "issuing" | "delivering" | "active" | "revoke";
  createdAt: number;
}

/**
 * The person agreed to hand a plugin's cloud providers credentials (#17352),
 * for the declarations they had then. One per plugin; it outlives an update
 * that leaves the declarations as they were, and goes when the plugin is
 * uninstalled.
 */
export interface StoredProviderConsent {
  pluginId: string;
  /** `PluginCloudProviderDeclaration.consentFingerprint` as agreed to. */
  fingerprint: string;
  approvedAt: number;
}

export interface CloudHostsValue {
  version: 1;
  accounts: StoredCloudAccount[];
  bindings: StoredCloudBinding[];
  machineKeys?: StoredMachineKey[];
  providerConsents?: StoredProviderConsent[];
}

export interface CloudHostsStoreBackend {
  get(key: "cloudHosts"): unknown;
  set(key: "cloudHosts", value: CloudHostsValue): void;
}

export { isValidCloudAccountId };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readValidation(raw: unknown): CloudAccountValidation {
  const value = raw as { status?: unknown; checkedAt?: unknown; detail?: unknown } | null;
  if (value?.status === "valid" && num(value.checkedAt) !== null) {
    return { status: "valid", checkedAt: num(value.checkedAt)! };
  }
  if (value?.status === "invalid" && num(value.checkedAt) !== null) {
    return { status: "invalid", checkedAt: num(value.checkedAt)!, detail: str(value.detail) ?? "" };
  }
  return { status: "unknown", checkedAt: num(value?.checkedAt), detail: str(value?.detail) };
}

function readScope(raw: unknown): CloudBillingScope | null {
  const value = raw as { kind?: unknown; id?: unknown; name?: unknown } | null;
  if (
    !value ||
    (value.kind !== "personal" &&
      value.kind !== "organization" &&
      value.kind !== "workspace" &&
      value.kind !== "project" &&
      value.kind !== "account")
  ) {
    return null;
  }
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  return { kind: value.kind, id: value.id, name: str(value.name) ?? value.id };
}

const MAX_LABEL_LENGTH = 128;
const MAX_URL_LENGTH = 2048;

/** One plain line, cut short rather than refused: a long name still names the provider. */
function labelText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const points = [...displaySafeText(value).trim()];
  if (points.length === 0) return null;
  return points.length > MAX_LABEL_LENGTH
    ? `${points
        .slice(0, MAX_LABEL_LENGTH - 1)
        .join("")
        .trimEnd()}…`
    : points.join("");
}

/** A link this device opens in the browser: public https with no sign-in in it, as the manifest rules require. */
export function readConsoleUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || value.includes("*")) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!url.hostname.includes(".") || isPrivateOrLoopbackHostname(url.hostname)) return null;
    return value;
  } catch {
    return null;
  }
}

/** Kept text from a manifest no one may be able to read again: shown as one plain line, and never a bad link. */
export function readPluginProviderLabel(raw: unknown): CloudPluginProviderLabel | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const pluginName = labelText(value.pluginName);
  const providerName = labelText(value.providerName);
  if (!pluginName || !providerName) return null;
  return { pluginName, providerName, dashboardUrl: readConsoleUrl(value.dashboardUrl) };
}

function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A remembered choice only reads whole: one unreadable id drops it, and the dialog starts afresh. */
export function readProvisioningSelection(raw: unknown): CloudProvisioningSelection | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const location = optionalId(value.location);
  const image = optionalId(value.image);
  const network = optionalId(value.network);
  if (location === undefined || image === undefined || network === undefined) return null;
  return { location, image, network };
}

function readPick(raw: unknown): CloudProvisioningPick | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = optionalId(value.id);
  const label = nonEmpty(value.label);
  const shown = nonEmpty(value.value);
  if (id === undefined || !label || !shown) return undefined;
  return { label, id, value: shown };
}

/**
 * What a create named. Unlike a mark, an unreadable one isn't dropped to
 * nothing: a retry would then send the provider's defaults. It reads as
 * "unreadable", and the create refuses to go out until the host is made again.
 */
export function readHostProvisioning(raw: unknown): CloudHostProvisioning | "unreadable" | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "unreadable";
  const value = raw as Record<string, unknown>;
  const read = {} as CloudHostProvisioning;
  for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
    // Every create writes all three; one gone missing isn't "the provider decides".
    if (!(dimension in value)) return "unreadable";
    const pick = readPick(value[dimension]);
    if (pick === undefined) return "unreadable";
    read[dimension] = pick;
  }
  return read;
}

function readAccount(raw: unknown): StoredCloudAccount | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || !isValidCloudAccountId(value.id) || !isCloudProviderId(value.providerId))
    return null;
  const scope = readScope(value.scope);
  const apiUrl = str(value.apiUrl);
  if (!scope || !apiUrl) return null;
  return {
    id: value.id,
    providerId: value.providerId,
    displayName: str(value.displayName) ?? scope.name,
    identity: str(value.identity),
    scope,
    apiUrl,
    keyHint: str(value.keyHint),
    credentialRevision: str(value.credentialRevision),
    addedAt: num(value.addedAt) ?? 0,
    validation: readValidation(value.validation),
    lastProvisioning: readProvisioningSelection(value.lastProvisioning),
    pluginProvider: readPluginProviderLabel(value.pluginProvider),
  };
}

function readAccess(raw: unknown): StoredSshAccess | null {
  const value = raw as Record<string, unknown> | null;
  if (!value) return null;
  const user = str(value.user);
  const host = str(value.host);
  const port = num(value.port);
  // Only an explicit null is a tunnel's access; a missing or empty key is a broken record.
  const hostKey = value.hostKey === null ? null : str(value.hostKey);
  if (!user || !host || port === null || (value.hostKey !== null && !hostKey)) return null;
  return { user, host, port, hostKey, obtainedAt: num(value.obtainedAt) ?? 0 };
}

function readHostKey(raw: unknown): StoredHostKey | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const key = normalizeHostKey(str(value.key));
  return key ? { key, at: num(value.at) ?? 0 } : null;
}

function readObservation(raw: unknown): StoredCloudObservation | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value.machine !== "string") return null;
  const stop = value.stop as { status?: unknown; error?: unknown } | null | undefined;
  return {
    machine: value.machine,
    name: str(value.name),
    rawState: str(value.rawState) ?? "",
    machineType: str(value.machineType),
    vcpu: num(value.vcpu),
    memoryGB: num(value.memoryGB),
    autoStopAt: str(value.autoStopAt),
    lifetimeSeconds: num(value.lifetimeSeconds),
    stoppedAt: str(value.stoppedAt),
    stop:
      stop && typeof stop.status === "string"
        ? { status: stop.status, error: str(stop.error) }
        : null,
    lastSnapshotAt: str(value.lastSnapshotAt),
    dataExpired: value.dataExpired === true,
    asleep: value.asleep === true,
    idleSleep: readIdleSleep(value.idleSleep),
    observedAt: num(value.observedAt) ?? 0,
  };
}

function readIdleSleep(raw: unknown): StoredCloudObservation["idleSleep"] {
  const value = raw as { enabled?: unknown; idleSeconds?: unknown } | null;
  if (!value || typeof value.enabled !== "boolean") return null;
  const seconds = num(value.idleSeconds);
  return { enabled: value.enabled, idleSeconds: seconds !== null && seconds > 0 ? seconds : null };
}

function readCreation(raw: unknown): StoredCreationIntent | null {
  const value = raw as Record<string, unknown> | null;
  if (!value) return null;
  const operationId = str(value.operationId);
  const idempotencyKey = str(value.idempotencyKey);
  if (!operationId || !idempotencyKey) return null;
  return {
    operationId,
    idempotencyKey,
    sentAt: num(value.sentAt),
    // Written before it existed: the first send is the only one known.
    lastSentAt: num(value.lastSentAt) ?? num(value.sentAt),
    name: str(value.name) ?? "",
    machineType: str(value.machineType) ?? "default",
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A mark missing any part of the worktree's identity is no mark at all. */
export function readCreatedFor(raw: unknown): CloudHostCreatedFor | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const projectId = nonEmpty(value.projectId);
  const worktreeId = nonEmpty(value.worktreeId);
  const projectName = nonEmpty(value.projectName);
  const worktreeName = nonEmpty(value.worktreeName);
  if (!projectId || !worktreeId || !projectName || !worktreeName) return null;
  let hostId: HostId | null;
  if (value.hostId === null) hostId = null;
  else if (typeof value.hostId === "string" && isValidRemoteHostId(value.hostId))
    hostId = value.hostId;
  else return null;
  return {
    hostId,
    projectId,
    worktreeId,
    projectName,
    worktreeName,
    hostName: hostId === null ? null : (nonEmpty(value.hostName) ?? hostId),
  };
}

function readError(raw: unknown): CloudHostError | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value.code !== "string" || typeof value.message !== "string") return null;
  return {
    code: value.code as CloudHostError["code"],
    message: value.message,
    at: num(value.at) ?? 0,
  };
}

/**
 * A cleanup reads only whole, and only for the machine and mark it was
 * confirmed for: anything less never authorizes a call to the provider.
 */
function readWorktreeCleanup(
  raw: unknown,
  createdFor: CloudHostCreatedFor | null,
  resourceId: string | null
): StoredWorktreeCleanup | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || !createdFor) return null;
  const choice = value.choice === "stop" || value.choice === "delete" ? value.choice : null;
  const phase =
    value.phase === "waiting" ||
    value.phase === "due" ||
    value.phase === "failed" ||
    value.phase === "unconfirmed"
      ? value.phase
      : null;
  const attemptId = nonEmpty(value.attemptId);
  const cleanupResourceId = nonEmpty(value.resourceId);
  const worktree = value.worktree as Record<string, unknown> | null;
  if (!attemptId || !choice || !phase) return null;
  if (!cleanupResourceId || cleanupResourceId !== resourceId) return null;
  if (!worktree || typeof worktree !== "object") return null;
  if (
    worktree.hostId !== createdFor.hostId ||
    worktree.projectId !== createdFor.projectId ||
    worktree.worktreeId !== createdFor.worktreeId
  ) {
    return null;
  }
  return {
    attemptId,
    mutationId: nonEmpty(value.mutationId),
    choice,
    resourceId: cleanupResourceId,
    worktree: {
      hostId: createdFor.hostId,
      projectId: createdFor.projectId,
      worktreeId: createdFor.worktreeId,
    },
    phase,
    error: readError(value.error),
    requestedAt: num(value.requestedAt) ?? 0,
  };
}

function readBinding(raw: unknown): StoredCloudBinding | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || !isValidCloudBindingId(value.id) || !isCloudProviderId(value.providerId))
    return null;
  if (!isValidCloudAccountId(value.accountId)) return null;
  const hostId =
    typeof value.hostId === "string" && isValidRemoteHostId(value.hostId) ? value.hostId : null;
  const ownership = value.ownership === "imported" ? "imported" : "created-by-daintree";
  // An imported machine was never created for anything, whatever a hand edit says.
  const createdFor = ownership === "imported" ? null : readCreatedFor(value.createdFor);
  const resourceId = str(value.resourceId);
  return {
    id: value.id,
    hostId,
    accountId: value.accountId,
    providerId: value.providerId,
    resourceId,
    ownership,
    createdFor,
    worktreeCleanup: readWorktreeCleanup(value.worktreeCleanup, createdFor, resourceId),
    provisioning: ownership === "imported" ? null : readHostProvisioning(value.provisioning),
    creation: readCreation(value.creation),
    lifetimeSeconds: value.lifetimeSeconds === null ? null : (num(value.lifetimeSeconds) ?? null),
    intent: value.intent === "run" || value.intent === "stop" ? value.intent : null,
    observation: readObservation(value.observation),
    access: readAccess(value.access),
    trustedHostKey: readHostKey(value.trustedHostKey),
    offeredHostKey: readHostKey(value.offeredHostKey),
    lastError: readError(value.lastError),
    createdAt: num(value.createdAt) ?? 0,
  };
}

const MACHINE_KEY_STATES = new Set(["issuing", "delivering", "active", "revoke"]);

function readMachineKey(raw: unknown): StoredMachineKey | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const id = nonEmpty(value.id);
  const bindingId = nonEmpty(value.bindingId);
  const accountId = nonEmpty(value.accountId);
  const providerId = nonEmpty(value.providerId);
  const resourceId = nonEmpty(value.resourceId);
  const name = nonEmpty(value.name);
  if (!id || !bindingId || !accountId || !providerId || !resourceId || !name) return null;
  if (!isCloudProviderId(providerId) || !MACHINE_KEY_STATES.has(value.state as string)) return null;
  return {
    id,
    bindingId,
    accountId,
    providerId,
    resourceId,
    name,
    keyId: nonEmpty(value.keyId),
    expiresAt: num(value.expiresAt),
    state: value.state as StoredMachineKey["state"],
    createdAt: num(value.createdAt) ?? 0,
  };
}

function readProviderConsent(raw: unknown): StoredProviderConsent | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const pluginId = nonEmpty(value.pluginId);
  const fingerprint = nonEmpty(value.fingerprint);
  // Consent that doesn't read is no consent: the plugin asks again.
  if (!pluginId || !fingerprint) return null;
  return { pluginId, fingerprint, approvedAt: num(value.approvedAt) ?? 0 };
}

/**
 * Reads tolerate anything a hand edit or another build left; a record that
 * doesn't read is skipped here but kept on disk, through every write, so a
 * downgrade never deletes what it can't understand by reading it. A record
 * whose provider isn't registered now still reads: its provider id is valid.
 */
interface RawCloudHosts {
  accounts: unknown[];
  bindings: unknown[];
  machineKeys: unknown[];
  providerConsents: unknown[];
}

export class CloudHostStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly backend: CloudHostsStoreBackend) {}

  private raw(): RawCloudHosts {
    const value = this.backend.get("cloudHosts") as
      | {
          accounts?: unknown;
          bindings?: unknown;
          machineKeys?: unknown;
          providerConsents?: unknown;
        }
      | undefined;
    return {
      accounts: Array.isArray(value?.accounts) ? value.accounts : [],
      bindings: Array.isArray(value?.bindings) ? value.bindings : [],
      machineKeys: Array.isArray(value?.machineKeys) ? value.machineKeys : [],
      providerConsents: Array.isArray(value?.providerConsents) ? value.providerConsents : [],
    };
  }

  accounts(): StoredCloudAccount[] {
    return this.raw()
      .accounts.map(readAccount)
      .filter((a): a is StoredCloudAccount => a !== null);
  }

  account(id: string): StoredCloudAccount | null {
    return this.accounts().find((account) => account.id === id) ?? null;
  }

  bindings(): StoredCloudBinding[] {
    return this.raw()
      .bindings.map(readBinding)
      .filter((b): b is StoredCloudBinding => b !== null);
  }

  binding(id: string): StoredCloudBinding | null {
    return this.bindings().find((binding) => binding.id === id) ?? null;
  }

  bindingForHost(hostId: HostId): StoredCloudBinding | null {
    return this.bindings().find((binding) => binding.hostId === hostId) ?? null;
  }

  /** Writes the account and, in the same write, the consent it was connected under. */
  putAccount(account: StoredCloudAccount, consent?: StoredProviderConsent): void {
    this.mutate((raw) => {
      const index = raw.accounts.findIndex(
        (entry) => (entry as { id?: unknown })?.id === account.id
      );
      if (index >= 0) raw.accounts[index] = account;
      else raw.accounts.push(account);
      if (consent) putConsent(raw, consent);
    });
  }

  /** The consent kept for a plugin's cloud providers, or null when there is none that reads. */
  providerConsent(pluginId: string): StoredProviderConsent | null {
    for (const entry of this.raw().providerConsents) {
      const consent = readProviderConsent(entry);
      if (consent?.pluginId === pluginId) return consent;
    }
    return null;
  }

  putProviderConsent(consent: StoredProviderConsent): void {
    this.mutate((raw) => putConsent(raw, consent));
  }

  /** Forgets a plugin's consent; writes nothing when there was none. */
  removeProviderConsent(pluginId: string): void {
    const raw = this.raw();
    const kept = raw.providerConsents.filter(
      (entry) => (entry as { pluginId?: unknown } | null)?.pluginId !== pluginId
    );
    if (kept.length === raw.providerConsents.length) return;
    this.mutate((next) => {
      next.providerConsents = next.providerConsents.filter(
        (entry) => (entry as { pluginId?: unknown } | null)?.pluginId !== pluginId
      );
    });
  }

  removeAccount(id: string): void {
    this.mutate((raw) => {
      raw.accounts = raw.accounts.filter((entry) => (entry as { id?: unknown })?.id !== id);
    });
  }

  putBinding(binding: StoredCloudBinding): void {
    this.mutate((raw) => {
      const index = raw.bindings.findIndex(
        (entry) => (entry as { id?: unknown })?.id === binding.id
      );
      if (index >= 0) raw.bindings[index] = binding;
      else raw.bindings.push(binding);
    });
  }

  /** Changes one binding in place; a binding that is gone stays gone. */
  updateBinding(
    id: string,
    change: (binding: StoredCloudBinding) => StoredCloudBinding
  ): StoredCloudBinding | null {
    const current = this.binding(id);
    if (!current) return null;
    const next = change(current);
    this.putBinding(next);
    return next;
  }

  /** Removes the binding and, in the same write, marks every key its machine was given for revoking. */
  removeBinding(id: string): void {
    this.mutate((raw) => {
      raw.bindings = raw.bindings.filter((entry) => (entry as { id?: unknown })?.id !== id);
      raw.machineKeys = raw.machineKeys.map((entry) => {
        const key = entry as { bindingId?: unknown } | null;
        return key?.bindingId === id ? { ...key, state: "revoke" } : entry;
      });
    });
  }

  machineKeys(): StoredMachineKey[] {
    return this.raw()
      .machineKeys.map(readMachineKey)
      .filter((key): key is StoredMachineKey => key !== null);
  }

  machineKey(id: string): StoredMachineKey | null {
    return this.machineKeys().find((key) => key.id === id) ?? null;
  }

  putMachineKey(key: StoredMachineKey): void {
    this.mutate((raw) => {
      const index = raw.machineKeys.findIndex(
        (entry) => (entry as { id?: unknown })?.id === key.id
      );
      if (index >= 0) raw.machineKeys[index] = key;
      else raw.machineKeys.push(key);
    });
  }

  /** Changes one key record in place; one that is gone stays gone. */
  updateMachineKey(
    id: string,
    change: (key: StoredMachineKey) => StoredMachineKey
  ): StoredMachineKey | null {
    const current = this.machineKey(id);
    if (!current) return null;
    const next = change(current);
    this.putMachineKey(next);
    return next;
  }

  removeMachineKey(id: string): void {
    this.mutate((raw) => {
      raw.machineKeys = raw.machineKeys.filter((entry) => (entry as { id?: unknown })?.id !== id);
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settings were read from disk again: what a listener keeps from them may have changed outside the app. */
  reloaded(): void {
    this.notify();
  }

  private mutate(change: (raw: RawCloudHosts) => void): void {
    const raw = this.raw();
    change(raw);
    this.backend.set("cloudHosts", {
      version: 1,
      accounts: raw.accounts as StoredCloudAccount[],
      bindings: raw.bindings as StoredCloudBinding[],
      machineKeys: raw.machineKeys as StoredMachineKey[],
      // Left out until there is one, so a store with none reads as it did before.
      ...(raw.providerConsents.length > 0
        ? { providerConsents: raw.providerConsents as StoredProviderConsent[] }
        : {}),
    });
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[CloudHostStore] change listener failed:", error);
      }
    }
  }
}

/** One consent per plugin: a newer one takes the place of whatever was kept for it. */
function putConsent(raw: RawCloudHosts, consent: StoredProviderConsent): void {
  raw.providerConsents = [
    ...raw.providerConsents.filter(
      (entry) => (entry as { pluginId?: unknown } | null)?.pluginId !== consent.pluginId
    ),
    consent,
  ];
}
