import crypto from "node:crypto";
import {
  CLOUD_LIFETIME_CHOICES,
  CLOUD_PROVISIONING_DIMENSIONS,
  cloudChoiceFitsLocation,
  cloudLifetimeIsChosen,
  cloudProvisioningArticleNoun,
  cloudProvisioningNoun,
  type CloudCatalog,
  type CloudHostCreatedFor,
  type CloudHostCreateRequest,
  type CloudHostProvisioning,
  type CloudHostError,
  type CloudHostErrorCode,
  type CloudHostImportRequest,
  type CloudHostKeyReview,
  type CloudHostStatus,
  type CloudLifetimeModel,
  type CloudMachineState,
  type CloudOperation,
  type CloudOperationKind,
  type CloudProviderId,
  type CloudProvisioningSelection,
  type CloudSshTrust,
} from "../../../shared/types/cloudHosts.js";
import {
  cloudConnection,
  isLocalHostId,
  type HostConnection,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { TransportError, UnusableConnectionError } from "../client/transport.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import {
  readCreatedFor,
  type CloudHostStore,
  type StoredCloudBinding,
  type StoredCloudObservation,
} from "./CloudHostStore.js";
import { findOnPath } from "../../utils/findOnPath.js";
import type {
  CloudSshAccessRecord,
  CloudSshFiles,
  CloudSshResolvedTunnel,
  CloudSshRoute,
} from "./CloudSshFiles.js";
import {
  formatSshEndpoint,
  hostKeyFingerprint,
  hostKeyTypeLabel,
  isSafeSshUser,
  isValidSshEndpoint,
  keyscanTypeOf,
  normalizeHostKey,
  type SshEndpoint,
} from "./sshEndpoint.js";
import { sshDeclarationProblem } from "./sshTunnel.js";
import {
  canRenewLifetime,
  sshKeyContractProblem,
  sshKeyTiming,
  type CloudProvider,
  type ProviderCredentials,
  type ProviderResource,
  type ProviderSshAccess,
} from "./provider.js";

/** How often a machine is asked about while Daintree changes it. */
const TRANSITION_POLL_MS = 3_000;
/** Background cadence by what was last seen: running machines often, stopped ones rarely. */
const RUNNING_POLL_MS = 30_000;
const STOPPED_POLL_MS = 5 * 60_000;
const UNKNOWN_POLL_MS = 60_000;
const START_DEADLINE_MS = 10 * 60_000;
const STOP_DEADLINE_MS = 15 * 60_000;
/** An observation this fresh is good enough to decide whether a dial can go ahead. */
const DIAL_OBSERVATION_MS = 15_000;
/** SSH access is resolved again after this long, or after any start. */
const ACCESS_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 64;
/** How often the keeper looks for a lifetime to renew. */
const KEEPER_INTERVAL_MS = 60_000;

/** The provider's own name, for messages: this layer never assumes which provider it is. */
function nameOf(provider: CloudProvider): string {
  return provider.info(process.platform).name;
}

/** The provider can't vouch for a machine's host key, so the person confirms it. */
function confirmsHostKeys(provider: CloudProvider): boolean {
  return provider.info(process.platform).capabilities.sshTrust === "confirm-on-first-connect";
}

/** A presented key nobody has confirmed, as the person reviews it. */
function hostKeyReviewOf(binding: StoredCloudBinding): CloudHostKeyReview | null {
  const offered = binding.offeredHostKey;
  if (!offered) return null;
  const trusted = binding.trustedHostKey;
  return {
    reason: trusted ? "changed" : "first-connect",
    fingerprint: hostKeyFingerprint(offered.key),
    keyType: hostKeyTypeLabel(offered.key),
    seenAt: offered.at,
    previousFingerprint: trusted ? hostKeyFingerprint(trusted.key) : null,
    previousTrustedAt: trusted?.at ?? null,
  };
}

function lifetimeModelOf(provider: CloudProvider): CloudLifetimeModel {
  return provider.info(process.platform).capabilities.lifetime;
}

/**
 * What a start tells the provider about the machine's runtime limit: the one
 * kept here, where the provider takes one at start; nothing where it would
 * keep its own (a limit fixed at create, an idle sleep, or none at all).
 */
function startOptions(
  model: CloudLifetimeModel,
  lifetimeSeconds: number | null
): { lifetimeSeconds?: number | null } {
  const takesLimit =
    model.kind === "renewable" || (model.kind === "fixed-at-create" && model.canChangeWhileStopped);
  return takesLimit ? { lifetimeSeconds } : {};
}
/**
 * What a failed read records (see inspectInto), which the next good answer
 * makes obsolete. Codes a refused start or stop also uses (a start limit is
 * "rate-limited") stay until that operation succeeds.
 */
const INSPECTION_ERRORS: ReadonlySet<CloudHostErrorCode> = new Set(["not-found"]);
/** A lifetime is renewed once this little of it is left (or half of it, for a short one). */
const RENEW_MARGIN_MS = 30 * 60_000;
/** After a failed renewal, the next try waits this long. */
const RENEW_RETRY_MS = 2 * 60_000;

const LABEL_MARKER = "daintree";
/** Failures that are the provider refusing the request: nothing was created. */
const DEFINITE_REFUSALS = new Set<CloudHostError["code"]>([
  "credential-invalid",
  "permission",
  "billing",
  "rate-limited",
  "capacity",
]);
const LABEL_BINDING = "daintree-binding";

export interface CloudHostLifecycleDeps {
  store: CloudHostStore;
  accounts: CloudAccountService;
  files: CloudSshFiles;
  clientDir: string;
  hosts: {
    add(name: string, connection: HostConnection): HostDescriptor;
    get(hostId: HostId): HostDescriptor | null;
    list(): HostDescriptor[];
    /** Removes the host from this device as Settings → Remove host does. */
    forget(hostId: HostId): Promise<void>;
    /** Lets go of the host's link without touching the machine. */
    disconnect(hostId: HostId): Promise<void>;
    onChange(listener: () => void): () => void;
  };
  /** The cloud picture changed outside the store (an operation's stage). */
  changed(): void;
  /**
   * What this device sees of a host's use right now: its link, whether its
   * agents are working or waiting there, and whether a window shows it. Only
   * Daintree's own observations; passive polling never counts as use.
   */
  activity?(hostId: HostId): { connected: boolean; busy: boolean; shown: boolean } | null;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Where a tunnel's command is on this device's PATH; null when it isn't there. */
  findCommand?: (command: string) => Promise<string | null>;
}

const PATH_LOOKUP_MS = 5_000;

/**
 * Where a tunnel's command is on PATH, or null when it isn't there. A lookup
 * that ran out of time (a hung mount on PATH) proves nothing, so it fails as
 * something to retry rather than as a command to install.
 */
async function findTunnelCommand(command: string): Promise<string | null> {
  let timedOut = false;
  const found = await findOnPath(command, {
    timeoutMs: PATH_LOOKUP_MS,
    onTimeout: () => {
      timedOut = true;
    },
  });
  if (found === null && timedOut) {
    throw new TransportError(
      `Looking for ${command} on this device took too long`,
      `Daintree couldn't finish looking for ${command} on this device's PATH.`
    );
  }
  return found;
}

/** One way of reaching a machine: a new one closes the master the old one opened. */
function routeGeneration(access: CloudSshAccessRecord): string {
  return JSON.stringify([
    access.user,
    access.endpoint.host,
    access.endpoint.port,
    access.hostKey,
    access.tunnel?.commandPath ?? null,
    access.tunnel?.args ?? [],
  ]);
}

/**
 * The key to pin from what the provider returned, or why it can't be used.
 * A provider that vouches with its API returns a key, and one that vouches
 * through its tunnel returns none; anything else is a provider bug, never a
 * quiet change of what is trusted.
 */
function checkedAccess(
  resolved: ProviderSshAccess,
  trust: CloudSshTrust,
  providerName: string
): { hostKey: string | null } | { problem: string } {
  if (
    typeof resolved?.user !== "string" ||
    !isSafeSshUser(resolved.user) ||
    !isValidSshEndpoint(resolved.endpoint)
  ) {
    return { problem: `${providerName} didn't return a usable SSH address for the machine` };
  }
  if (trust === "provider-tunnel") {
    return resolved.hostKey === null
      ? { hostKey: null }
      : {
          problem: `${providerName} returned a host key to pin for a machine it vouches for through its tunnel`,
        };
  }
  // The person's confirmation supplies the key; the API's is never taken for it.
  if (trust === "confirm-on-first-connect") return { hostKey: null };
  const hostKey = normalizeHostKey(resolved.hostKey);
  return hostKey === null
    ? { problem: `${providerName} didn't say which host key the machine has` }
    : { hostKey };
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Checks what a create names against the catalog just read and the
 * provider's own word on what it takes. Nothing is filled in: a required
 * dimension left out is refused, and only an optional one may be left to the
 * provider. Returns the ids to send and, for the host's details, the words
 * they were chosen by; null words when the provider takes none of them.
 */
function checkProvisioning(
  provider: CloudProvider,
  catalog: CloudCatalog,
  raw: unknown
): { selection: CloudProvisioningSelection; picks: CloudHostProvisioning | null } {
  if (raw !== undefined && raw !== null && typeof raw !== "object") {
    throw invalid("Choose where the machine runs and what it boots.");
  }
  const requested = (raw ?? {}) as Record<string, unknown>;
  const name = nameOf(provider);
  const takes = provider.info(process.platform).capabilities.provisioning;
  const selection: CloudProvisioningSelection = { location: null, image: null, network: null };
  const picks: CloudHostProvisioning = { location: null, image: null, network: null };
  let named = false;
  for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
    const value = requested[dimension];
    const options = catalog.provisioning[dimension];
    if (takes[dimension] === "none" || options === null) {
      if (value !== undefined && value !== null) {
        throw invalid(`${name} doesn't take a ${dimension} for a new machine.`);
      }
      continue;
    }
    named = true;
    const noun = cloudProvisioningNoun(options.label);
    if (value === undefined || value === null) {
      if (takes[dimension] === "required") {
        throw invalid(`Choose ${cloudProvisioningArticleNoun(options.label)}.`);
      }
      picks[dimension] = { label: options.label, id: null, value: `Chosen by ${name}` };
      continue;
    }
    const choice =
      typeof value === "string" ? options.choices.find((entry) => entry.id === value) : undefined;
    if (!choice)
      throw invalid(`${name} doesn't offer that ${noun} to this account. Choose another.`);
    if (!choice.available) {
      throw invalid(
        choice.reason
          ? `${choice.label} isn't available: ${choice.reason}`
          : `${choice.label} isn't available on this account.`
      );
    }
    if (!cloudChoiceFitsLocation(choice, selection.location)) {
      const where = catalog.provisioning.location;
      throw invalid(
        `${choice.label} isn't offered in ${where ? `that ${cloudProvisioningNoun(where.label)}` : "every location"}. Choose another.`
      );
    }
    selection[dimension] = choice.id;
    picks[dimension] = { label: options.label, id: choice.id, value: choice.label };
  }
  return { selection, picks: named ? picks : null };
}

const DIMENSION_WORDS = { location: "Location", image: "Image", network: "Network" } as const;

/** The ids a create sends, from what its binding keeps. */
function selectionOf(picks: CloudHostProvisioning | null): CloudProvisioningSelection {
  return {
    location: picks?.location?.id ?? null,
    image: picks?.image?.id ?? null,
    network: picks?.network?.id ?? null,
  };
}

function observationOf(resource: ProviderResource, at: number): StoredCloudObservation {
  return {
    machine: resource.machine,
    name: resource.name || null,
    rawState: resource.rawState,
    machineType: resource.machineType,
    vcpu: resource.vcpu,
    memoryGB: resource.memoryGB,
    autoStopAt: resource.autoStopAt,
    lifetimeSeconds: resource.lifetimeSeconds,
    stoppedAt: resource.stoppedAt,
    stop: resource.stop ? { status: resource.stop.status, error: resource.stop.error } : null,
    lastSnapshotAt: resource.lastSnapshotAt,
    dataExpired: resource.dataExpired,
    observedAt: at,
  };
}

/** A mark given by main code, checked as strictly as one read back from disk. */
function checkedCreatedFor(raw: CloudHostCreatedFor): CloudHostCreatedFor {
  const local = raw && typeof raw === "object" && isLocalHostId(raw.hostId);
  const mark = readCreatedFor(local ? { ...raw, hostId: null } : raw);
  if (!mark) throw invalid("The worktree this machine is for is missing its project or path.");
  return mark;
}

function machineOf(binding: StoredCloudBinding): CloudMachineState {
  if (!binding.resourceId) return "not-created";
  return (binding.observation?.machine as CloudMachineState | undefined) ?? "unknown";
}

interface RunningOperation extends CloudOperation {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * The lifecycle of every cloud host's machine. Each machine has at most one
 * operation at a time (create, start, stop, delete), which every caller joins;
 * the operation's intent is written down before anything that costs money is
 * sent, so a lost answer or a restart is reconciled instead of repeated.
 *
 * Nothing here starts a machine unless a person asked: observing, listing,
 * a window restoring or a link redialling only ever reads. A dial to a
 * stopped machine fails with a reason and waits for Start.
 */
export class CloudHostLifecycle {
  private readonly operations = new Map<string, RunningOperation>();
  private readonly nextPollAt = new Map<string, number>();
  private readonly accessInFlight = new Map<string, Promise<CloudSshRoute>>();
  /** The route last written for each machine this run, so only a changed one retires its master. */
  private readonly writtenRoutes = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keeperTimer: ReturnType<typeof setInterval> | null = null;
  /** When each machine's lifetime was last renewed or tried, this run. */
  private readonly renewals = new Map<string, { at: number; ok: boolean }>();
  private readonly renewInFlight = new Map<string, Promise<void>>();
  /** Creates sent before a restart whose provider wasn't registered to look for them yet. */
  private readonly awaitingProvider = new Set<string>();
  /** Creates being looked for right now, so two passes never ask about one at once. */
  private readonly reconciling = new Set<string>();
  /** Lookups a provider change overtook: a failure may be the old provider's, not the machine's. */
  private readonly reconcileOvertaken = new Set<string>();
  private renewingAll = false;
  /**
   * Every request whose answer becomes an observation takes a ticket when it
   * is sent; an answer is written only if no request sent after it has been
   * written already. A poll or refresh that a start or stop overtook arrives
   * late, and its wall-clock arrival time says nothing about how old it is.
   */
  private lastTicket = 0;
  private readonly observedTicket = new Map<string, number>();
  private stopWatchingHosts: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: CloudHostLifecycleDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms, signal);
  }

  /** A provider registered or left: a create left unreconciled for want of its provider is looked for now. */
  providersChanged(): void {
    if (this.disposed) return;
    for (const bindingId of this.reconciling) this.reconcileOvertaken.add(bindingId);
    if (this.awaitingProvider.size === 0) return;
    void this.reconcileUnfinishedCreates(new Set(this.awaitingProvider));
  }

  /** Begins background observation and reconciles what a previous run left unfinished. */
  start(): void {
    this.stopWatchingHosts = this.deps.hosts.onChange(() => void this.dropOrphanBindings());
    void this.dropOrphanBindings();
    this.pollTimer = setInterval(() => void this.pollDue(), 5_000);
    this.pollTimer.unref?.();
    this.keeperTimer = setInterval(() => void this.renewDue(), KEEPER_INTERVAL_MS);
    this.keeperTimer.unref?.();
    this.markInterruptedCreates();
    void this.reconcileUnfinishedCreates();
  }

  /**
   * A create Daintree quit before sending (while it read the key or made the
   * SSH key) left nothing to look for, and no error to offer Retry with.
   */
  private markInterruptedCreates(): void {
    for (const binding of this.deps.store.bindings()) {
      if (binding.resourceId || !binding.hostId || binding.creation?.sentAt !== null) continue;
      if (binding.lastError || this.operations.has(binding.id)) continue;
      this.recordError(binding.id, {
        code: "failed",
        message:
          binding.provisioning === "unreadable"
            ? "Setup stopped before a machine was asked for, and where it was meant to run can't be read back. Remove the host and create it again."
            : "Setup stopped before a machine was asked for. Retry to create it.",
        at: this.now(),
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.keeperTimer) clearInterval(this.keeperTimer);
    this.stopWatchingHosts?.();
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  // --- Reading -------------------------------------------------------------

  statuses(): CloudHostStatus[] {
    const accounts = new Map(this.deps.store.accounts().map((account) => [account.id, account]));
    const lifetimes = new Map<string, CloudLifetimeModel | null>();
    const lifetimeFor = (providerId: string): CloudLifetimeModel | null => {
      if (!lifetimes.has(providerId)) {
        lifetimes.set(
          providerId,
          this.deps.accounts.providerUnavailable(providerId)
            ? null
            : lifetimeModelOf(this.deps.accounts.provider(providerId))
        );
      }
      return lifetimes.get(providerId)!;
    };
    return this.deps.store
      .bindings()
      .filter(
        (binding): binding is StoredCloudBinding & { hostId: HostId } => binding.hostId !== null
      )
      .map((binding) => {
        const account = accounts.get(binding.accountId);
        const observation = binding.observation;
        const operation = this.operations.get(binding.id);
        const machineType = observation?.machineType ?? binding.creation?.machineType ?? null;
        // A key the person trusted stays the machine's identity between the dials that pin it.
        // Access, once resolved, says what is pinned now: none, when the tunnel vouches.
        const pinnedKey = binding.access
          ? binding.access.hostKey
          : (binding.trustedHostKey?.key ?? null);
        return {
          hostId: binding.hostId,
          providerId: binding.providerId,
          providerUnavailable: this.deps.accounts.providerUnavailable(binding.providerId),
          accountId: binding.accountId,
          accountName: account?.displayName ?? "Disconnected account",
          resourceId: binding.resourceId,
          machineName: observation?.name ?? binding.creation?.name ?? null,
          ownership: binding.ownership,
          createdFor: binding.createdFor,
          provisioning: binding.provisioning === "unreadable" ? null : binding.provisioning,
          machine: machineOf(binding),
          rawState: observation?.rawState ?? null,
          machineType,
          vcpu: observation?.vcpu ?? null,
          memoryGB: observation?.memoryGB ?? null,
          hourlyDollars: this.deps.accounts.cachedHourly(binding.accountId, machineType),
          lifetime: lifetimeFor(binding.providerId),
          autoStopAt: observation?.autoStopAt ?? null,
          lifetimeSeconds: binding.lifetimeSeconds,
          stoppedAt: observation?.stoppedAt ?? null,
          stop: observation?.stop
            ? {
                status:
                  observation.stop.status === "pending" ||
                  observation.stop.status === "failing" ||
                  observation.stop.status === "completed" ||
                  observation.stop.status === "superseded"
                    ? observation.stop.status
                    : "unknown",
                error: observation.stop.error,
              }
            : null,
          lastSnapshotAt: observation?.lastSnapshotAt ?? null,
          dataExpired: observation?.dataExpired ?? false,
          operation: operation
            ? {
                id: operation.id,
                kind: operation.kind,
                startedAt: operation.startedAt,
                stage: operation.stage,
              }
            : null,
          lastError: binding.lastError,
          observedAt: observation?.observedAt ?? null,
          lastEndpoint: binding.access
            ? `${binding.access.user}@${formatSshEndpoint({ host: binding.access.host, port: binding.access.port })}`
            : null,
          hostKeyFingerprint: pinnedKey ? hostKeyFingerprint(pinnedKey) : null,
          hostKeyReview: hostKeyReviewOf(binding),
          keptRunningAt: this.renewals.get(binding.id)?.ok
            ? this.renewals.get(binding.id)!.at
            : null,
        };
      });
  }

  private requireBindingForHost(hostId: unknown): StoredCloudBinding & { hostId: HostId } {
    const binding = typeof hostId === "string" ? this.deps.store.bindingForHost(hostId) : null;
    if (!binding || binding.hostId === null) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No cloud machine for host ${String(hostId)}`,
        userMessage: "That host isn't a cloud host on this device.",
      });
    }
    return binding as StoredCloudBinding & { hostId: HostId };
  }

  private async context(
    binding: StoredCloudBinding,
    signal?: AbortSignal
  ): Promise<{ provider: CloudProvider; credentials: ProviderCredentials }> {
    const account = this.deps.accounts.requireAccount(binding.accountId);
    const provider = this.deps.accounts.requireSupported(account.providerId);
    const credentials = await this.deps.accounts.credentials(account, signal);
    return { provider, credentials };
  }

  // --- Creating and importing ---------------------------------------------

  /**
   * Adds a cloud host and creates its machine. The binding and the create's
   * idempotency key are saved before the request goes out; the host is in the
   * list at once (as "Creating"), and the machine comes up in the background.
   *
   * `createdFor` marks the machine as made for a worktree, in that first write
   * so the mark holds through the create and any restart. It is a parameter of
   * its own, never read off the request: Settings → Hosts sends the request
   * over IPC and must never mark a machine.
   */
  async create(
    request: CloudHostCreateRequest,
    createdFor: CloudHostCreatedFor | null = null
  ): Promise<{ hostId: HostId }> {
    if (!request || typeof request !== "object") throw invalid("Missing machine details.");
    const mark = createdFor === null ? null : checkedCreatedFor(createdFor);
    const account = this.deps.accounts.requireAccount(request.accountId);
    const provider = this.deps.accounts.requireSupported(account.providerId);
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw invalid("Give the host a name.");
    if (cloudLifetimeIsChosen(lifetimeModelOf(provider))) {
      if (!CLOUD_LIFETIME_CHOICES.includes(request.lifetimeHours)) {
        throw invalid("Choose how long the machine may run before it stops by itself.");
      }
    } else if (request.lifetimeHours !== null) {
      // Refused, never dropped: a lifetime sent here means the asker thought it would hold.
      throw invalid(`${nameOf(provider)} doesn't take a lifetime for its machines.`);
    }
    // A size is checked against the account's current catalog, never assumed.
    const catalog = await this.deps.accounts.catalog(account.id, { refresh: true });
    // The lifetime was checked against this provider; one registered in its place meanwhile wasn't asked.
    if (!this.stillRegistered(account.providerId, provider)) {
      throw invalid(`${nameOf(provider)} changed while the machine was being set up. Try again.`);
    }
    const size = catalog.machineTypes.find((type) => type.id === request.machineType);
    if (!size) throw invalid("Choose a machine size.");
    if (!size.available) {
      throw invalid(
        size.reason
          ? `${size.label} isn't available: ${size.reason}`
          : `${size.label} isn't available on this account.`
      );
    }
    const { selection, picks } = checkProvisioning(provider, catalog, request.provisioning);
    const bindingId = `cb_${crypto.randomBytes(6).toString("hex")}`;
    const binding: StoredCloudBinding = {
      id: bindingId,
      hostId: null,
      accountId: account.id,
      providerId: account.providerId,
      resourceId: null,
      ownership: "created-by-daintree",
      createdFor: mark,
      provisioning: picks,
      creation: {
        operationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        sentAt: null,
        name,
        machineType: size.id,
      },
      lifetimeSeconds: request.lifetimeHours === null ? null : request.lifetimeHours * 3600,
      intent: "run",
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: this.now(),
    };
    this.deps.store.putBinding(binding);
    let descriptor: HostDescriptor;
    try {
      descriptor = this.deps.hosts.add(name, cloudConnection(bindingId));
    } catch (error) {
      this.deps.store.removeBinding(bindingId);
      throw error;
    }
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, hostId: descriptor.id }));
    // What was asked for, whatever the provider makes of it: a retry never moves it.
    if (picks) this.deps.accounts.rememberProvisioning(account.id, selection);
    void this.operate(bindingId, "creating", (signal) => this.runCreate(bindingId, signal)).catch(
      () => {}
    );
    return { hostId: descriptor.id };
  }

  /** Sends the create again with the same key: the provider answers with the machine it made, if it made one. */
  async retryCreate(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    if (binding.resourceId) return;
    if (!binding.creation) throw invalid("This host has no machine to create.");
    await this.operate(binding.id, "creating", (signal) => this.runCreate(binding.id, signal));
  }

  private async runCreate(bindingId: string, signal: AbortSignal): Promise<void> {
    let binding = this.deps.store.binding(bindingId);
    if (!binding?.creation || !binding.hostId) return;
    const creation = binding.creation;
    const { provider, credentials } = await this.context(binding, signal);
    // A create already sent may have made the machine: look for it (a read) before asking again.
    if (creation.sentAt !== null) {
      this.stage(bindingId, `Looking for the machine ${nameOf(provider)} may already have made`);
      const found = await this.findCreated(bindingId, provider, { ...credentials, signal });
      if (found) {
        this.bindCreated(bindingId, found);
        await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
        return;
      }
    }
    // Asked only of the provider registered now, and only for what it still takes: a limit
    // asked for under a model it has since dropped is refused, never sent as none.
    const changed = !this.stillRegistered(binding.providerId, provider);
    if (
      changed ||
      (binding.lifetimeSeconds !== null && !cloudLifetimeIsChosen(lifetimeModelOf(provider)))
    ) {
      // An earlier send may still have made a machine: that stays "outcome unknown", so
      // removing the host goes the delete way, which looks for it first.
      const sent = creation.sentAt !== null;
      const reason = changed
        ? `${nameOf(provider)} changed while the machine was being asked for.`
        : `${nameOf(provider)} no longer takes a lifetime for its machines, so Daintree won't ask for one with it.`;
      const next = sent
        ? provider.info(process.platform).capabilities.deletion
          ? "An earlier request may still have made it; removing the host checks once and deletes any machine it finds."
          : `An earlier request may still have made it; check your ${nameOf(provider)} account for it.`
        : changed
          ? "Nothing was asked for; Retry asks again."
          : "Nothing was created; remove the host and add it again.";
      const message = `${reason} ${next}`;
      this.recordError(bindingId, {
        code: sent ? "outcome-unknown" : changed ? "failed" : "unsupported",
        message,
        at: this.now(),
      });
      throw invalid(message);
    }
    const provisioning = this.sendableProvisioning(binding, provider);
    // A provider that only takes the key at create gets this account's own key with every attempt.
    let publicKey: string | null = null;
    if (sshKeyTiming(provider) === "at-create") {
      try {
        publicKey = await this.deps.files.publicKey(binding.accountId);
      } catch (error) {
        const detail = formatErrorMessage(error, "ssh-keygen failed");
        this.recordUnsentCreate(bindingId, creation.sentAt !== null, {
          code: "ssh-authorization",
          reason: `This account's SSH key couldn't be made (${detail})`,
        });
        throw error;
      }
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      // The provider leaving, or another registering in its place, while the key was made: ask nobody.
      const registered = this.deps.accounts.providerUnavailable(binding.providerId)
        ? null
        : this.deps.accounts.provider(binding.providerId);
      if (registered !== provider) {
        const reason = `${nameOf(provider)} was ${registered ? "replaced" : "removed"} while the SSH key was made`;
        this.recordUnsentCreate(bindingId, creation.sentAt !== null, {
          code: "unsupported",
          reason,
        });
        throw new AppError({ code: "UNSUPPORTED", message: reason, userMessage: reason });
      }
    }
    this.stage(bindingId, `Asking ${nameOf(provider)} for a machine`);
    // Written before the request: a lost answer is then found again, never sent blind.
    binding = this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      creation: current.creation
        ? { ...current.creation, sentAt: current.creation.sentAt ?? this.now() }
        : null,
      lastError: null,
    }))!;
    let resource: ProviderResource;
    try {
      resource = await provider.create(credentials, {
        name: creation.name,
        machineType: creation.machineType,
        lifetimeSeconds: binding.lifetimeSeconds,
        provisioning,
        labels: {
          [LABEL_MARKER]: "1",
          [LABEL_BINDING]: bindingId,
        },
        idempotencyKey: creation.idempotencyKey,
        publicKey,
      });
    } catch (error) {
      const described = provider.describeError(error);
      // Only the provider's own refusal proves nothing was made; anything else (lost answer,
      // cancellation, an unreadable reply, a create still being minted) may have.
      const refused = !signal.aborted && DEFINITE_REFUSALS.has(described.code);
      this.recordError(bindingId, {
        ...described,
        code: refused ? described.code : "outcome-unknown",
        message: refused
          ? described.message
          : `${nameOf(provider)} didn't confirm the machine. Retry looks for it before creating another.`,
      });
      if (refused) {
        // Nothing was made: a retry needs a fresh key, or the provider replays this refusal.
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          creation: current.creation
            ? { ...current.creation, idempotencyKey: crypto.randomUUID(), sentAt: null }
            : null,
        }));
      }
      throw error;
    }
    this.bindCreated(bindingId, resource);
    await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
  }

  /**
   * What this create was asked to name, exactly as it was checked. Refused
   * when it can't be read back, or when the provider now needs a dimension it
   * never named: sending its defaults instead would make another machine
   * than the one asked for.
   */
  private sendableProvisioning(
    binding: StoredCloudBinding,
    provider: CloudProvider
  ): CloudProvisioningSelection {
    const refuse = (message: string): never => {
      this.recordError(binding.id, { code: "failed", message, at: this.now() });
      throw invalid(message);
    };
    if (binding.provisioning === "unreadable") {
      refuse(
        "Daintree can't read back where this machine was meant to run, so it won't guess. Remove the host and create it again."
      );
    }
    const picks = binding.provisioning === "unreadable" ? null : binding.provisioning;
    const takes = provider.info(process.platform).capabilities.provisioning;
    for (const dimension of CLOUD_PROVISIONING_DIMENSIONS) {
      if (takes[dimension] === "required" && !picks?.[dimension]?.id) {
        refuse(
          `${nameOf(provider)} needs ${cloudProvisioningArticleNoun(DIMENSION_WORDS[dimension])} for this machine that its create never named, so Daintree won't guess one. Remove the host and create it again.`
        );
      }
    }
    return selectionOf(picks);
  }

  /**
   * A create stopped before this attempt was sent. When an earlier attempt was
   * sent, that one may still have made the machine, so it stays a create whose
   * outcome is unknown.
   */
  private recordUnsentCreate(
    bindingId: string,
    sentBefore: boolean,
    { code, reason }: { code: CloudHostErrorCode; reason: string }
  ): void {
    this.recordError(bindingId, {
      code: sentBefore ? "outcome-unknown" : code,
      message: sentBefore
        ? `${reason}, so the create wasn't sent again. Retry looks for a machine from the earlier request first.`
        : `${reason}, so no machine was asked for. Retry to create it.`,
      at: this.now(),
    });
  }

  /** The machine a create for this binding made, found by its label; null when there is none. */
  private async findCreated(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<ProviderResource | null> {
    const found = await provider.list(credentials, { label: `${LABEL_BINDING}=${bindingId}` });
    return (
      found.find(
        (candidate) =>
          candidate.labels[LABEL_BINDING] === bindingId && candidate.machine !== "deleted"
      ) ?? null
    );
  }

  private bindCreated(bindingId: string, resource: ProviderResource): void {
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      resourceId: resource.resourceId,
      creation: null,
      observation: observationOf(resource, this.now()),
      lastError: null,
    }));
  }

  /**
   * After a restart, a create that was sent but never answered is looked for
   * by its label, which is a read. If it isn't found, the host shows that
   * setup didn't finish and offers Retry; nothing is created on its own.
   */
  private async reconcileUnfinishedCreates(only?: ReadonlySet<string>): Promise<void> {
    const again = new Set<string>();
    for (const binding of this.deps.store.bindings()) {
      if (only && !only.has(binding.id)) continue;
      if (binding.resourceId || !binding.creation?.sentAt || !binding.hostId) continue;
      if (this.operations.has(binding.id) || this.reconciling.has(binding.id)) continue;
      if (this.deps.accounts.providerUnavailable(binding.providerId)) {
        this.awaitingProvider.add(binding.id);
        continue;
      }
      this.awaitingProvider.delete(binding.id);
      this.reconciling.add(binding.id);
      const key = binding.creation.idempotencyKey;
      try {
        const { provider, credentials } = await this.context(binding);
        const resource = await this.findCreated(binding.id, provider, credentials);
        // A Retry, a delete or dispose while the provider was asked: its answer is about the past.
        const current = this.deps.store.binding(binding.id);
        if (
          this.disposed ||
          !current ||
          current.resourceId ||
          current.creation?.idempotencyKey !== key ||
          this.operations.has(binding.id)
        ) {
          continue;
        }
        if (resource) {
          this.bindCreated(binding.id, resource);
        } else {
          this.recordError(binding.id, {
            code: "outcome-unknown",
            message: `Setup didn't finish: ${nameOf(provider)} has no machine for this host yet. Retry to create it.`,
            at: this.now(),
          });
        }
      } catch {
        // The provider can't be asked now; the host keeps saying setup is incomplete.
        // One that left while it was asked looks again when it's back, and one
        // that came back meanwhile is asked again now.
        if (this.deps.accounts.providerUnavailable(binding.providerId)) {
          this.awaitingProvider.add(binding.id);
        } else if (this.reconcileOvertaken.has(binding.id)) {
          again.add(binding.id);
        }
      } finally {
        this.reconciling.delete(binding.id);
        this.reconcileOvertaken.delete(binding.id);
      }
    }
    if (again.size > 0 && !this.disposed) void this.reconcileUnfinishedCreates(again);
  }

  /** Adds an existing machine as a host. Importing never starts it, and never changes its lifetime. */
  async importMachine(request: CloudHostImportRequest): Promise<{ hostId: HostId }> {
    if (!request || typeof request !== "object") throw invalid("Missing machine details.");
    const account = this.deps.accounts.requireAccount(request.accountId);
    this.deps.accounts.requireSupported(account.providerId);
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw invalid("Give the host a name.");
    if (typeof request.resourceId !== "string") throw invalid("Choose a machine.");
    const bound = this.deps.store
      .bindings()
      .find(
        (binding) =>
          binding.providerId === account.providerId && binding.resourceId === request.resourceId
      );
    if (bound?.hostId) {
      const host = this.deps.hosts.get(bound.hostId);
      throw invalid(`That machine is already in your host list${host ? ` as ${host.name}` : ""}.`);
    }
    const binding: StoredCloudBinding = {
      id: `cb_${crypto.randomBytes(6).toString("hex")}`,
      hostId: null,
      accountId: account.id,
      providerId: account.providerId,
      resourceId: null,
      ownership: "imported",
      createdFor: null,
      provisioning: null,
      creation: null,
      lifetimeSeconds: null,
      intent: null,
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: this.now(),
    };
    const { provider, credentials } = await this.context(binding);
    let resource: ProviderResource;
    try {
      resource = await provider.inspect(credentials, request.resourceId);
    } catch (error) {
      throw this.deps.accounts.asAppError(provider, error);
    }
    if (resource.restricted) {
      throw invalid(
        "That machine belongs to a teammate and isn't shared with you, so Daintree can't reach it."
      );
    }
    if (resource.dataExpired)
      throw invalid("That machine's saved disk was deleted; it can't be started again.");
    if (resource.machine === "deleted") throw invalid("That machine was deleted.");
    if (resource.snapshotsDisabled) {
      throw invalid(
        "That machine was created with snapshots off, so stopping it erases its disk. Daintree only adds machines whose disk survives a stop."
      );
    }
    // Its own lifetime stays as it is; a start renews to it, where the provider takes one then.
    binding.resourceId = resource.resourceId;
    binding.lifetimeSeconds = resource.lifetimeSeconds;
    binding.observation = observationOf(resource, this.now());
    // Another import of the same machine may have finished while it was inspected.
    if (
      this.deps.store
        .bindings()
        .some(
          (other) =>
            other.providerId === account.providerId && other.resourceId === resource.resourceId
        )
    ) {
      throw invalid("That machine is already in your host list.");
    }
    this.deps.store.putBinding(binding);
    let descriptor: HostDescriptor;
    try {
      descriptor = this.deps.hosts.add(name, cloudConnection(binding.id));
    } catch (error) {
      this.deps.store.removeBinding(binding.id);
      throw error;
    }
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, hostId: descriptor.id }));
    return { hostId: descriptor.id };
  }

  // --- Starting and stopping ----------------------------------------------

  /** A person's Start: resumes a stopped machine and waits until it runs. Joins one under way. */
  async startMachine(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before the intent changes.
    this.deps.accounts.provider(binding.providerId);
    if (!binding.resourceId) {
      if (binding.creation) return this.retryCreate(hostId);
      throw invalid("This host has no machine yet.");
    }
    await this.operate(
      binding.id,
      "starting",
      (signal) => this.runStart(binding.id, signal),
      () => this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "run" }))
    );
  }

  private async runStart(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    this.stage(bindingId, "Checking the machine");
    let resource: ProviderResource | null;
    // A read overtaken by a newer one is asked again: a start acts on the newest word.
    while (!(resource = await this.inspectInto(bindingId, provider, credentials))) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    }
    if (resource.dataExpired) {
      const error: CloudHostError = {
        code: "data-expired",
        message: `${nameOf(provider)} deleted this machine's saved disk after its retention period, so it can't start. Nothing was created in its place.`,
        at: this.now(),
      };
      this.recordError(bindingId, error);
      throw new AppError({ code: "NOT_FOUND", message: error.message, userMessage: error.message });
    }
    if (resource.machine === "stopping") {
      resource = await this.waitFor(
        bindingId,
        "stopped",
        STOP_DEADLINE_MS,
        signal,
        "Waiting for the last stop to finish"
      );
    }
    if (resource.machine === "stopped" || resource.machine === "error") {
      this.stage(bindingId, "Starting the machine");
      try {
        const ticket = this.ticket();
        const started = await provider.start(
          credentials,
          binding.resourceId!,
          startOptions(lifetimeModelOf(provider), binding.lifetimeSeconds)
        );
        if (started) this.observe(bindingId, started, ticket);
      } catch (error) {
        this.recordError(bindingId, provider.describeError(error));
        throw this.deps.accounts.asAppError(provider, error);
      }
    }
    // A start is a new machine as far as ssh knows: resolve access again.
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      lastError: null,
    }));
    await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
  }

  /**
   * A person's Stop: lets go of the link, asks for a normal (saving) stop and
   * follows it until the provider says the machine stopped. Never forced.
   */
  async stopMachine(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before the intent changes.
    this.deps.accounts.provider(binding.providerId);
    if (!binding.resourceId) throw invalid("This host has no machine to stop.");
    const running = this.operations.get(binding.id);
    // A start, or a create whose machine exists and is still coming up, is
    // superseded by the stop the person asked for now.
    if (running && (running.kind === "starting" || running.kind === "creating")) {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    // The stop holds the machine before it waits on anything, so a Start meanwhile is refused.
    await this.operate(
      binding.id,
      "stopping",
      async (signal) => {
        await this.settleRenewal(binding.id);
        await this.deps.hosts.disconnect(binding.hostId).catch(() => {});
        if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
        await this.runStop(binding.id, signal);
      },
      () => this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "stop" }))
    );
  }

  private async runStop(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    // A delete or shutdown that took over meanwhile: the provider never hears of this stop.
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    this.stage(bindingId, "Saving the disk and stopping");
    try {
      const ticket = this.ticket();
      const stopping = await provider.stop(credentials, binding.resourceId);
      if (stopping) this.observe(bindingId, stopping, ticket);
    } catch (error) {
      this.recordError(bindingId, provider.describeError(error));
      throw this.deps.accounts.asAppError(provider, error);
    }
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      lastError: null,
    }));
    await this.waitFor(
      bindingId,
      "stopped",
      STOP_DEADLINE_MS,
      signal,
      "Saving the disk and stopping"
    );
  }

  /**
   * Deletes the machine at the provider, then removes the host here. The
   * person confirmed deleting this exact machine; saved snapshots stay.
   */
  async deleteMachine(hostId: unknown, confirmResourceId: unknown): Promise<void> {
    const confirmed = this.requireBindingForHost(hostId);
    // Before anything is aborted, looked up or forgotten: a provider that can't
    // delete from Daintree leaves its machine to its own console.
    this.requireDeletion(confirmed.providerId);
    if (confirmed.resourceId && confirmResourceId !== confirmed.resourceId) {
      throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
    }
    const running = this.operations.get(confirmed.id);
    if (running && running.kind !== "deleting") {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    let binding = this.deps.store.binding(confirmed.id) ?? confirmed;
    // A create that reached the provider may have made a machine nothing here has heard
    // of yet: find it (a read) before the host, and its label, are forgotten.
    if (!binding.resourceId && binding.creation?.sentAt) {
      const { provider, credentials } = await this.context(binding);
      let found: ProviderResource | null;
      try {
        found = await this.findCreated(binding.id, provider, credentials);
      } catch (error) {
        throw this.deps.accounts.asAppError(provider, error);
      }
      if (found) {
        this.bindCreated(binding.id, found);
        binding = this.deps.store.binding(binding.id) ?? binding;
      }
    }
    const resourceId = binding.resourceId;
    // Its own create made it for this host, so the confirmation covers it.
    if (resourceId && confirmResourceId !== resourceId && confirmed.resourceId !== null) {
      throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
    }
    if (resourceId) {
      await this.deps.hosts.disconnect(confirmed.hostId).catch(() => {});
      // A Stop or Start that claimed the machine while this waited gives way too.
      await this.operateOver(binding.id, "deleting", async (signal) => {
        const { provider, credentials } = await this.context(binding, signal);
        // The provider may have been replaced while the operation waited.
        this.requireDeletion(binding.providerId);
        this.stage(binding.id, "Deleting the machine");
        try {
          await provider.delete(credentials, resourceId);
        } catch (error) {
          const described = provider.describeError(error);
          if (described.code !== "not-found") {
            this.recordError(binding.id, described);
            throw this.deps.accounts.asAppError(provider, error);
          }
        }
      });
    }
    await this.deps.hosts.forget(confirmed.hostId);
  }

  /**
   * Runs `work` as the machine's operation once every other one on it is
   * aborted and finished, including any that claimed it while the last wound
   * down. It claims the machine in the same turn as its last look, so a caller
   * queued behind the aborted operation can't get in first.
   */
  private async operateOver(
    bindingId: string,
    kind: CloudOperationKind,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    let running = this.operations.get(bindingId);
    while (running && running.kind !== kind) {
      running.controller.abort();
      await running.promise.catch(() => {});
      running = this.operations.get(bindingId);
    }
    return this.operate(bindingId, kind, work);
  }

  /**
   * Refuses a delete through a registered provider that declares it can't.
   * An unregistered one is refused later, with the reason it's unavailable.
   */
  private requireDeletion(providerId: CloudProviderId): void {
    if (this.deps.accounts.providerUnavailable(providerId) !== null) return;
    const info = this.deps.accounts.provider(providerId).info(process.platform);
    if (info.capabilities.deletion) return;
    const message = `Daintree can't delete machines on ${info.name}. Delete it in ${info.name}'s console.`;
    throw new AppError({ code: "UNSUPPORTED", message, userMessage: message });
  }

  /** Reads the machine's state now, for a person's refresh. Never starts anything. */
  async refresh(hostId: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    if (!binding.resourceId) return;
    const { provider, credentials } = await this.context(binding);
    try {
      await this.inspectInto(binding.id, provider, credentials);
    } catch (error) {
      throw this.deps.accounts.asAppError(provider, error);
    }
  }

  /**
   * Sets how long the machine runs before it stops by itself. On a renewable
   * provider a running machine's own deadline moves too (to that long from
   * now, or none), so what Settings shows is what will happen to this run. A
   * limit fixed at create changes only while the machine is stopped, where the
   * provider allows it, and holds from its next start; a provider with no
   * lifetime, or one that sleeps machines when idle, has nothing to set.
   */
  async setLifetime(hostId: unknown, lifetimeHours: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    // Refused while its provider isn't registered, before anything here changes.
    const owner = this.deps.accounts.provider(binding.providerId);
    if (!CLOUD_LIFETIME_CHOICES.includes(lifetimeHours as number | null)) {
      throw invalid("Choose how long the machine may run before it stops by itself.");
    }
    const lifetimeSeconds = lifetimeHours === null ? null : (lifetimeHours as number) * 3600;
    const model = lifetimeModelOf(owner);
    if (model.kind === "fixed-at-create") {
      if (!model.canChangeWhileStopped) {
        throw invalid(`${nameOf(owner)} fixes a machine's runtime limit when it's created.`);
      }
      if (
        !binding.resourceId ||
        machineOf(binding) !== "stopped" ||
        this.operations.has(binding.id)
      ) {
        throw invalid(
          `${nameOf(owner)} changes a machine's runtime limit only while it's stopped.`
        );
      }
      this.deps.store.updateBinding(binding.id, (current) => ({ ...current, lifetimeSeconds }));
      return;
    }
    if (!canRenewLifetime(owner)) {
      throw invalid(`${nameOf(owner)} doesn't take a lifetime for its machines.`);
    }
    await this.settleRenewal(binding.id);
    // A provider that left or was replaced while the renewal settled may not take this at all.
    if (!this.stillRegistered(binding.providerId, owner)) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    this.renewals.delete(binding.id);
    const keep = () =>
      this.deps.store.updateBinding(binding.id, (current) => ({ ...current, lifetimeSeconds }));
    if (
      !binding.resourceId ||
      machineOf(binding) !== "running" ||
      this.operations.has(binding.id)
    ) {
      keep();
      return;
    }
    // A running machine's own deadline moves first: a refusal leaves both the
    // machine and the lifetime Settings shows as they were.
    const { provider, credentials } = await this.context(binding);
    // Sent only through the provider still registered, and its answer kept only while it still is.
    if (!this.stillRegistered(binding.providerId, provider) || provider !== owner) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    if (!canRenewLifetime(provider)) {
      throw invalid(`${nameOf(provider)} doesn't take a lifetime for its machines.`);
    }
    let resource: ProviderResource;
    const ticket = this.ticket();
    try {
      resource = await provider.renewLifetime(credentials, binding.resourceId, lifetimeSeconds);
    } catch (error) {
      // A replaced provider's failure says nothing about the account as it is now.
      if (!this.stillRegistered(binding.providerId, provider)) {
        throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
      }
      throw this.deps.accounts.asAppError(provider, error);
    }
    if (!this.stillRegistered(binding.providerId, provider)) {
      throw invalid(`${nameOf(owner)} changed while this was being saved. Try again.`);
    }
    keep();
    this.observe(binding.id, resource, ticket);
  }

  // --- SSH access ----------------------------------------------------------

  /**
   * How to reach the machine's sshd for a dial, setup or install. Only ever
   * reads the machine's state: a stopped machine is refused with a reason (the
   * link stops retrying until someone starts it), one still starting is a
   * transient failure the link retries.
   */
  async ensureAccess(
    bindingId: string,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {}
  ): Promise<CloudSshRoute> {
    // A person's Retry asks again from scratch: the last observation and access may be stale.
    if (options.fresh) {
      this.deps.store.updateBinding(bindingId, (current) => ({
        ...current,
        access: null,
        observation: current.observation ? { ...current.observation, observedAt: 0 } : null,
      }));
    }
    // One resolution per machine, shared, and not tied to any one caller's
    // signal: a dial that gives up must not fail the others waiting on it.
    let attempt = this.accessInFlight.get(bindingId);
    if (!attempt) {
      const started = this.resolveAccess(bindingId);
      attempt = started;
      this.accessInFlight.set(bindingId, started);
      void started
        .finally(() => {
          if (this.accessInFlight.get(bindingId) === started) this.accessInFlight.delete(bindingId);
        })
        .catch(() => {});
    }
    if (!signal) return attempt;
    return new Promise<CloudSshRoute>((resolve, reject) => {
      const onAbort = () => reject(new TransportError("Cancelled", null));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      attempt.then(
        (route) => {
          signal.removeEventListener("abort", onAbort);
          resolve(route);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private async resolveAccess(bindingId: string): Promise<CloudSshRoute> {
    let binding = this.deps.store.binding(bindingId);
    if (!binding) {
      throw new UnusableConnectionError("This cloud host isn't set up on this device", null);
    }
    if (!binding.resourceId) {
      throw new UnusableConnectionError(
        "The cloud machine hasn't been created yet",
        "Setup didn't finish. Open the host's details to retry."
      );
    }
    let context: { provider: CloudProvider; credentials: ProviderCredentials };
    try {
      context = await this.context(binding);
    } catch (error) {
      const said =
        error instanceof AppError
          ? (error.userMessage ?? error.message)
          : "The cloud account can't be used";
      throw new UnusableConnectionError(said, said);
    }
    const { provider, credentials } = context;
    const fresh =
      binding.observation && this.now() - binding.observation.observedAt < DIAL_OBSERVATION_MS;
    if (!fresh) {
      try {
        await this.inspectInto(bindingId, provider, credentials);
      } catch (error) {
        const described = provider.describeError(error);
        if (described.code === "provider-unreachable") {
          throw new TransportError(
            `Couldn't ask ${nameOf(provider)} about the machine`,
            described.message
          );
        }
        throw new UnusableConnectionError(described.message, described.message);
      }
      binding = this.deps.store.binding(bindingId)!;
    }
    const machine = machineOf(binding);
    if (machine === "starting") {
      throw new TransportError("The cloud machine is starting", "The machine is starting.");
    }
    if (machine !== "running") {
      const said =
        machine === "stopped" || machine === "stopping"
          ? "The cloud machine is stopped. Start it to connect."
          : machine === "deleted"
            ? "The cloud machine was deleted."
            : "The cloud machine isn't running.";
      throw new UnusableConnectionError(said, said);
    }
    const confirmed = confirmsHostKeys(provider);
    if (confirmed && provider.info(process.platform).capabilities.transport !== "direct") {
      const said = `Daintree can't reach ${nameOf(provider)} machines through the provider's own connection yet.`;
      throw new UnusableConnectionError(said, said);
    }
    // Before any reuse: a tunnel's command can be uninstalled or moved at any time.
    const policy = await this.sshPolicy(bindingId, provider);
    const access = binding.access;
    if (
      access &&
      this.now() - access.obtainedAt < ACCESS_TTL_MS &&
      // A key confirmed by the person is pinned only while it is still the trusted one.
      (!confirmed || access.hostKey === binding.trustedHostKey?.key) &&
      // Access resolved under another trust (a provider that changed what it vouches with) is asked for again.
      (access.hostKey === null) === (policy.trust === "provider-tunnel") &&
      (await this.deps.files.exists(bindingId))
    ) {
      const record: CloudSshAccessRecord = {
        user: access.user,
        endpoint: { host: access.host, port: access.port },
        hostKey: access.hostKey,
        tunnel: policy.tunnel,
      };
      const generation = routeGeneration(record);
      const written = this.writtenRoutes.get(bindingId);
      // Files an earlier run wrote are reused only when they are what this access writes now.
      if (
        written === generation ||
        (written === undefined &&
          (await this.deps.files.isCurrent(bindingId, binding.accountId, record)))
      ) {
        this.writtenRoutes.set(bindingId, generation);
        this.clearAccessErrors(bindingId);
        return this.deps.files.route(bindingId);
      }
    }
    let resolved: ProviderSshAccess;
    try {
      resolved = await this.sshAccessFor(provider, credentials, binding);
    } catch (error) {
      const described = provider.describeError(error);
      if (described.code === "provider-unreachable") {
        throw new TransportError(
          `Couldn't get SSH access from ${nameOf(provider)}`,
          described.message
        );
      }
      const said = `SSH access couldn't be set up: ${described.message}`;
      this.recordError(bindingId, { ...described, code: "ssh-authorization", message: said });
      throw new UnusableConnectionError(said, said);
    }
    const checked = checkedAccess(resolved, policy.trust, nameOf(provider));
    if ("problem" in checked) {
      const said = `SSH access couldn't be set up: ${checked.problem}`;
      this.recordError(bindingId, { code: "ssh-authorization", message: said, at: this.now() });
      throw new UnusableConnectionError(said, said);
    }
    const record: CloudSshAccessRecord = {
      user: resolved.user,
      endpoint: resolved.endpoint,
      // Whatever the API said about the key, only the person's confirmation vouches for it.
      hostKey: confirmed
        ? await this.confirmedHostKey(bindingId, resolved.endpoint)
        : checked.hostKey,
      tunnel: policy.tunnel,
    };
    // A master opened to the old address, key or tunnel must not carry a dial to
    // the new one; the same route written again leaves a live link's master alone.
    const generation = routeGeneration(record);
    const written = this.writtenRoutes.get(bindingId);
    if (written === undefined || written !== generation) {
      await this.deps.files.closeMaster(this.deps.clientDir, bindingId);
    }
    // A write cut short leaves nothing here vouching for whatever reached the disk.
    this.writtenRoutes.delete(bindingId);
    const route = await this.deps.files.write(bindingId, binding.accountId, record);
    this.writtenRoutes.set(bindingId, generation);
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: {
        user: record.user,
        host: record.endpoint.host,
        port: record.endpoint.port,
        hostKey: record.hostKey,
        obtainedAt: this.now(),
      },
    }));
    this.clearAccessErrors(bindingId);
    return route;
  }

  /**
   * The key to pin for a provider that can't vouch for one: the person's
   * trusted key, as long as the machine still presents it. A first key, or
   * one unlike the trusted key, is kept for the person to review and the dial
   * is refused; nothing here ever trusts a key by itself.
   */
  private async confirmedHostKey(bindingId: string, endpoint: SshEndpoint): Promise<string> {
    const scan = async (types?: string): Promise<string[]> => {
      try {
        return await this.deps.files.scanHostKeys(endpoint, { types });
      } catch (error) {
        const said = `Daintree couldn't read the machine's host key: ${formatErrorMessage(error, "ssh-keyscan failed")}`;
        throw new UnusableConnectionError(said, said);
      }
    };
    let scanned = await scan();
    const trustedBefore = this.deps.store.binding(bindingId)?.trustedHostKey?.key ?? null;
    if (trustedBefore && !scanned.includes(trustedBefore)) {
      // Each algorithm is its own connection, and one can drop while the others
      // answer: the trusted key's absence is checked on its own before it counts.
      const again = await scan(keyscanTypeOf(trustedBefore));
      if (again.includes(trustedBefore)) scanned = [...scanned, trustedBefore];
    }
    // Read after the scan: the person may have trusted a key while it ran.
    const binding = this.deps.store.binding(bindingId);
    if (!binding) {
      throw new UnusableConnectionError("This cloud host isn't set up on this device", null);
    }
    const trusted = binding.trustedHostKey?.key ?? null;
    if (trusted && scanned.includes(trusted)) {
      if (binding.offeredHostKey) {
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          offeredHostKey: null,
        }));
      }
      return trusted;
    }
    const candidate = scanned[0];
    if (!candidate) {
      // Most often an sshd still coming up: the link tries again.
      throw new TransportError(
        "The cloud machine didn't present a host key",
        "The machine's SSH server didn't answer with a host key."
      );
    }
    const type = candidate.split(" ")[0];
    if (scanned.some((key) => key !== candidate && key.split(" ")[0] === type)) {
      const said =
        "The machine presented two different host keys of the same kind, so Daintree can't tell which is its own.";
      throw new UnusableConnectionError(said, said);
    }
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: null,
      offeredHostKey:
        current.offeredHostKey?.key === candidate
          ? current.offeredHostKey
          : { key: candidate, at: this.now() },
    }));
    const said = trusted
      ? "This machine's identity changed: its host key isn't the one you trusted. Review the new key in the host's details before connecting."
      : "Confirm this machine's host key in the host's details to connect.";
    throw new UnusableConnectionError(said, said);
  }

  /**
   * After ssh refused the machine's key on a dial: the key changed since it
   * was last looked at. It is looked at again, so the refusal names the
   * change and offers the new key for review; when the machine still presents
   * the trusted key, ssh's own refusal stands.
   */
  async recheckHostKey(bindingId: string, signal?: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding) return;
    if (this.deps.accounts.providerUnavailable(binding.providerId) !== null) return;
    if (!confirmsHostKeys(this.deps.accounts.provider(binding.providerId))) return;
    // A resolution already under way may have chosen the old access before the
    // refusal; joining it would skip the look. It settles first.
    const cancelled = () => new TransportError("Cancelled", null);
    let pending: Promise<CloudSshRoute> | undefined;
    while ((pending = this.accessInFlight.get(bindingId))) {
      const settling = pending;
      // This dial may give up while it waits; the shared resolution carries on.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(cancelled());
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        void settling
          .catch(() => {})
          .then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
      });
    }
    if (signal?.aborted) throw cancelled();
    // No await from here into ensureAccess: the resolution it starts reads the cleared access.
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, access: null }));
    await this.ensureAccess(bindingId, signal);
  }

  /**
   * The person trusts the key a machine presented, by the fingerprint they
   * were shown: a key that changed again since then is refused, never pinned
   * unseen. The next dial pins it, on a fresh ssh master.
   */
  async trustHostKey(hostId: unknown, fingerprint: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    const provider = this.deps.accounts.provider(binding.providerId);
    if (!confirmsHostKeys(provider)) {
      throw invalid(
        `${nameOf(provider)} vouches for its machines' host keys; there's none to confirm.`
      );
    }
    const offered = binding.offeredHostKey;
    if (!offered) throw invalid("There's no new host key to trust. Connect again to look at it.");
    if (typeof fingerprint !== "string" || hostKeyFingerprint(offered.key) !== fingerprint) {
      throw invalid(
        "The machine's host key changed again since it was shown. Review the key it presents now."
      );
    }
    this.deps.store.updateBinding(binding.id, (current) =>
      current.offeredHostKey?.key === offered.key
        ? {
            ...current,
            trustedHostKey: { key: offered.key, at: this.now() },
            offeredHostKey: null,
            access: null,
          }
        : current
    );
  }

  /** Reaching the machine worked: what last stood in its way no longer does. */
  private clearAccessErrors(bindingId: string): void {
    const code = this.deps.store.binding(bindingId)?.lastError?.code;
    if (code !== "ssh-authorization" && code !== "ssh-tunnel-command-missing") return;
    this.deps.store.updateBinding(bindingId, (current) =>
      current.lastError?.code === code ? { ...current, lastError: null } : current
    );
  }

  /**
   * How the provider says its machines are reached and trusted, with its
   * tunnel's command found on this device. A missing command is the person's
   * to install, so the host names it and where to get it instead of letting
   * ssh fail without saying why.
   */
  private async sshPolicy(
    bindingId: string,
    provider: CloudProvider
  ): Promise<{ trust: CloudSshTrust; tunnel: CloudSshResolvedTunnel | null }> {
    const info = provider.info(process.platform);
    const { capabilities } = info;
    const problem = sshDeclarationProblem(capabilities);
    if (problem) {
      // Registration refuses these, so only a provider whose description changed since gets here.
      const said = `${info.name} machines can't be reached: ${problem}`;
      throw new UnusableConnectionError(said, said);
    }
    if (!capabilities.tunnel) return { trust: capabilities.sshTrust, tunnel: null };
    const { command, args, installUrl } = capabilities.tunnel;
    const missingCode: CloudHostErrorCode = "ssh-tunnel-command-missing";
    const lastError = this.deps.store.binding(bindingId)?.lastError ?? null;
    const commandPath = await (this.deps.findCommand ?? findTunnelCommand)(command);
    if (!commandPath) {
      const said = `${info.name} machines are reached through its ${command} command, which isn't installed on this device or isn't on Daintree's PATH. Install it from ${installUrl}, then connect again.`;
      if (lastError?.code !== missingCode || lastError.message !== said) {
        this.recordError(bindingId, { code: missingCode, message: said, at: this.now() });
      }
      throw new UnusableConnectionError(said, said);
    }
    return { trust: capabilities.sshTrust, tunnel: { commandPath, args: [...args] } };
  }

  /**
   * A machine that took the account's key at create is only asked how to reach
   * it; any other has the key authorized on it first.
   */
  private async sshAccessFor(
    provider: CloudProvider,
    credentials: ProviderCredentials,
    binding: StoredCloudBinding
  ): Promise<ProviderSshAccess> {
    const timing = sshKeyTiming(provider);
    const problem = sshKeyContractProblem(provider, timing);
    if (problem) throw new Error(`${nameOf(provider)} ${problem}`);
    if (timing === "at-create") return provider.sshAccess!(credentials, binding.resourceId!);
    const publicKey = await this.deps.files.publicKey(binding.accountId);
    return provider.authorizeSsh!(credentials, binding.resourceId!, publicKey);
  }

  /** A stable key for one resolution of access: a new one means a new transport. */
  accessGeneration(bindingId: string): string | null {
    const access = this.deps.store.binding(bindingId)?.access;
    if (!access) return null;
    return (
      this.writtenRoutes.get(bindingId) ??
      routeGeneration({
        user: access.user,
        endpoint: { host: access.host, port: access.port },
        hostKey: access.hostKey,
        tunnel: null,
      })
    );
  }

  // --- Operations and observation ----------------------------------------

  /**
   * Runs `work` as the machine's one operation, or joins the same kind under
   * way. `accepted` runs only when a new operation is admitted, before any of
   * its work: a refused or joining caller changes nothing it records.
   */
  private operate(
    bindingId: string,
    kind: CloudOperationKind,
    work: (signal: AbortSignal) => Promise<void>,
    accepted?: () => void
  ): Promise<void> {
    const running = this.operations.get(bindingId);
    if (running) {
      if (running.kind === kind) return running.promise;
      throw new AppError({
        code: "VALIDATION",
        message: `A ${running.kind} operation is under way`,
        userMessage: `The machine is ${running.kind === "creating" ? "being created" : running.kind} already. Wait for it to finish.`,
      });
    }
    if (this.disposed)
      return Promise.reject(new AppError({ code: "CANCELLED", message: "Stopping" }));
    accepted?.();
    const controller = new AbortController();
    const operation = {
      id: crypto.randomUUID(),
      kind,
      startedAt: this.now(),
      stage: "",
      controller,
    } as RunningOperation;
    operation.promise = (async () => {
      try {
        await work(controller.signal);
        // It worked: anything it recorded on the way (a save the provider retried) is history now.
        this.deps.store.updateBinding(bindingId, (current) =>
          current.lastError && current.lastError.at >= operation.startedAt
            ? { ...current, lastError: null }
            : current
        );
      } finally {
        if (this.operations.get(bindingId) === operation) this.operations.delete(bindingId);
        this.nextPollAt.delete(bindingId);
        this.deps.changed();
      }
    })();
    this.operations.set(bindingId, operation);
    this.deps.changed();
    return operation.promise;
  }

  private stage(bindingId: string, stage: string): void {
    const operation = this.operations.get(bindingId);
    if (!operation || operation.stage === stage) return;
    operation.stage = stage;
    this.deps.changed();
  }

  private recordError(bindingId: string, error: CloudHostError): void {
    this.deps.store.updateBinding(bindingId, (current) => ({ ...current, lastError: error }));
  }

  private ticket(): number {
    return ++this.lastTicket;
  }

  /** Whether a newer request's answer was written while the one with this ticket was out. */
  private overtaken(bindingId: string, ticket: number): boolean {
    return ticket <= (this.observedTicket.get(bindingId) ?? 0);
  }

  /** Writes the answer to the request sent with this ticket, unless a newer one was written; false then. */
  private observe(
    bindingId: string,
    resource: ProviderResource,
    ticket: number,
    extra?: (binding: StoredCloudBinding) => StoredCloudBinding
  ): boolean {
    if (this.overtaken(bindingId, ticket)) return false;
    this.observedTicket.set(bindingId, ticket);
    this.deps.store.updateBinding(bindingId, (current) => {
      const before = current.observation;
      // Any stop, or a start seen from outside, may bring a new address or
      // host key: access is resolved again for the next dial.
      const restarted =
        resource.machine !== "running" ||
        (before !== null && before.machine !== "running") ||
        (before?.stoppedAt ?? null) !== resource.stoppedAt;
      if (restarted) this.renewals.delete(bindingId);
      const next: StoredCloudBinding = {
        ...current,
        access: restarted ? null : current.access,
        observation: observationOf(resource, this.now()),
      };
      return extra ? extra(next) : next;
    });
    return true;
  }

  /**
   * Reads the machine into its binding. Null when a request sent after this
   * one was answered first: the binding already holds the newer word, and this
   * answer, or failure to get one, is left out.
   */
  private async inspectInto(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<ProviderResource | null> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) throw new Error("No machine");
    const ticket = this.ticket();
    let resource: ProviderResource;
    try {
      resource = await provider.inspect(credentials, binding.resourceId);
    } catch (error) {
      if (this.overtaken(bindingId, ticket)) return null;
      const described = provider.describeError(error);
      if (described.code === "not-found") {
        this.observedTicket.set(bindingId, ticket);
        // Not proof of deletion (a scope or key change looks the same): say what was seen.
        this.deps.store.updateBinding(bindingId, (current) => ({
          ...current,
          observation: current.observation
            ? { ...current.observation, machine: "unknown", observedAt: this.now() }
            : null,
          lastError: described,
        }));
      }
      throw error;
    }
    // An answer supersedes an earlier failure to get one; a refused start or stop stays.
    const written = this.observe(bindingId, resource, ticket, (current) =>
      current.lastError && INSPECTION_ERRORS.has(current.lastError.code)
        ? { ...current, lastError: null }
        : current
    );
    return written ? resource : null;
  }

  private async waitFor(
    bindingId: string,
    target: "running" | "stopped",
    deadlineMs: number,
    signal: AbortSignal,
    stage: string
  ): Promise<ProviderResource> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) throw new Error("No machine");
    const { provider, credentials } = await this.context(binding, signal);
    const deadline = this.now() + deadlineMs;
    this.stage(bindingId, stage);
    for (;;) {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      let resource: ProviderResource | null = null;
      const ticket = this.ticket();
      try {
        const answer = await provider.inspect({ ...credentials, signal }, binding.resourceId);
        // Overtaken by a newer read: this round saw nothing, and the next one asks again.
        if (this.observe(bindingId, answer, ticket)) resource = answer;
      } catch (error) {
        if (signal.aborted) throw error;
        const described = provider.describeError(error);
        if (described.code !== "provider-unreachable" && !this.overtaken(bindingId, ticket)) {
          this.recordError(bindingId, described);
          throw this.deps.accounts.asAppError(provider, error);
        }
      }
      if (resource) {
        if (resource.machine === target) return resource;
        if (resource.machine === "error" || resource.machine === "deleted") {
          const message =
            resource.error ??
            (resource.machine === "deleted" ? "The machine was removed." : "The machine failed.");
          this.recordError(bindingId, { code: "failed", message, at: this.now() });
          throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
        }
        if (target === "stopped" && resource.stop?.status === "failing") {
          this.stage(
            bindingId,
            `${nameOf(provider)} is retrying the save: ${resource.stop.error ?? "the disk couldn't be saved yet"}`
          );
          this.recordError(bindingId, {
            code: "stop-failing",
            message: `${nameOf(provider)} couldn't save the disk yet and keeps the machine running while it retries${resource.stop.error ? ` (${resource.stop.error})` : ""}. ${provider.info(process.platform).capabilities.persistence.saveRetryBilled ? "That time is billed." : "It isn't billed for that time."}`,
            at: this.now(),
          });
        }
      }
      if (this.now() > deadline) {
        const message =
          target === "running"
            ? "The machine didn't come up in time. It may still be starting; check again shortly."
            : `The machine hasn't finished stopping yet. ${nameOf(provider)} keeps working on it.`;
        this.recordError(bindingId, { code: "outcome-unknown", message, at: this.now() });
        throw new AppError({ code: "OUTCOME_UNKNOWN", message, userMessage: message });
      }
      await this.sleep(TRANSITION_POLL_MS, signal);
    }
  }

  /**
   * The lifetime keeper. A machine's provider-side lifetime is the guard
   * against one left running; while this device is using it (its link is up
   * and its agents are working or waiting there, or a window shows it), the
   * guard mustn't cut that work off, so the deadline is moved forward before
   * it comes. Nothing is renewed for a machine nobody here uses: with the
   * desktop gone, it stops by itself at the end of its lifetime, saving its
   * disk. Runs on a timer; exposed for tests.
   */
  async renewDue(): Promise<void> {
    if (this.disposed || !this.deps.activity || this.renewingAll) return;
    this.renewingAll = true;
    try {
      for (const binding of this.deps.store.bindings()) {
        if (this.disposed) return;
        if (!this.renewalDue(binding.id)) continue;
        const attempt = this.renew(binding.id);
        this.renewInFlight.set(binding.id, attempt);
        try {
          await attempt;
        } finally {
          if (this.renewInFlight.get(binding.id) === attempt) this.renewInFlight.delete(binding.id);
        }
      }
    } finally {
      this.renewingAll = false;
    }
  }

  /** Whether the machine is in use here, running, idle of operations, and near its deadline. */
  private renewalDue(bindingId: string): boolean {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId || !binding.hostId || binding.lifetimeSeconds === null) return false;
    if (binding.intent === "stop" || this.operations.has(binding.id)) return false;
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return false;
    // Only a deadline the provider can move: a fixed limit, an idle sleep or none has nothing to renew.
    if (!canRenewLifetime(this.deps.accounts.provider(binding.providerId))) return false;
    if (machineOf(binding) !== "running") return false;
    const activity = this.deps.activity?.(binding.hostId);
    if (!activity?.connected || !(activity.busy || activity.shown)) return false;
    const deadline = Date.parse(binding.observation?.autoStopAt ?? "");
    if (!Number.isFinite(deadline)) return false;
    const now = this.now();
    const margin = Math.min(RENEW_MARGIN_MS, (binding.lifetimeSeconds * 1000) / 2);
    if (deadline - now > margin) return false;
    const last = this.renewals.get(binding.id);
    return !(last && !last.ok && now - last.at < RENEW_RETRY_MS);
  }

  private async renew(bindingId: string): Promise<void> {
    const binding = this.deps.store.binding(bindingId)!;
    const lifetimeSeconds = binding.lifetimeSeconds;
    // renewalDue just found it registered; one that left since has nothing to renew and failed nothing.
    if (this.deps.accounts.providerUnavailable(binding.providerId)) return;
    const provider = this.deps.accounts.provider(binding.providerId);
    if (!canRenewLifetime(provider)) return;
    try {
      const { credentials } = await this.context(binding);
      // A stop, a start or a new lifetime while the key was read: that wins. So
      // does the provider leaving, or another registering in its place.
      if (!this.renewalDue(bindingId) || !this.stillRegistered(binding.providerId, provider)) {
        return;
      }
      const ticket = this.ticket();
      const renewed = await provider.renewLifetime(
        credentials,
        binding.resourceId!,
        lifetimeSeconds
      );
      // The answer of a provider that left or was replaced meanwhile is about a machine it no longer speaks for.
      if (!this.stillRegistered(binding.providerId, provider)) return;
      const current = this.deps.store.binding(bindingId);
      if (!current || current.intent === "stop" || this.operations.has(bindingId)) return;
      this.observe(bindingId, renewed, ticket);
      this.renewals.set(bindingId, { at: this.now(), ok: true });
      // A renewal that failed earlier and now went through is no longer news.
      this.deps.store.updateBinding(bindingId, (latest) =>
        latest.lastError?.code === "lifetime-renewal" ? { ...latest, lastError: null } : latest
      );
      this.deps.changed();
    } catch (error) {
      if (this.disposed || this.deps.store.binding(bindingId)?.intent === "stop") return;
      if (!this.stillRegistered(binding.providerId, provider)) return;
      this.renewals.set(bindingId, { at: this.now(), ok: false });
      const described = provider.describeError(error);
      this.recordError(bindingId, {
        code: "lifetime-renewal",
        message: `Couldn't keep the machine running past its lifetime: ${described.message} It stops by itself at the deadline unless this succeeds.`,
        at: described.at,
      });
    }
  }

  /** The provider is still the one registered under its id: not gone, and not replaced. */
  private stillRegistered(providerId: string, provider: CloudProvider): boolean {
    return (
      !this.deps.accounts.providerUnavailable(providerId) &&
      this.deps.accounts.provider(providerId) === provider
    );
  }

  /** Lets a renewal under way for the machine finish first, so it can't land after this. */
  private async settleRenewal(bindingId: string): Promise<void> {
    await this.renewInFlight.get(bindingId)?.catch(() => {});
  }

  /** Background observation: reads only, at a pace set by what was last seen. */
  private async pollDue(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    for (const binding of this.deps.store.bindings()) {
      if (!binding.resourceId || !binding.hostId || this.operations.has(binding.id)) continue;
      // Its provider isn't registered: the last observation stays, with its time.
      if (this.deps.accounts.providerUnavailable(binding.providerId)) continue;
      const due = this.nextPollAt.get(binding.id) ?? 0;
      if (now < due) continue;
      const machine = machineOf(binding);
      const interval =
        machine === "running"
          ? RUNNING_POLL_MS
          : machine === "starting" || machine === "stopping"
            ? TRANSITION_POLL_MS * 2
            : machine === "stopped"
              ? STOPPED_POLL_MS
              : UNKNOWN_POLL_MS;
      this.nextPollAt.set(binding.id, now + interval);
      // Not yet due by its own observation (written by a dial or an operation).
      if (binding.observation && now - binding.observation.observedAt < interval) continue;
      try {
        const { provider, credentials } = await this.context(binding);
        await this.inspectInto(binding.id, provider, credentials);
      } catch {
        // Kept as the last observation, with its time: stale says so itself.
      }
    }
  }

  /** A host removed from the list takes its binding and ssh files with it; its machine is untouched. */
  private async dropOrphanBindings(): Promise<void> {
    const listed = new Set(this.deps.hosts.list().map((host) => host.id));
    for (const binding of this.deps.store.bindings()) {
      // One whose host was never added (a crash between the two writes) and that never reached the provider.
      const stranded =
        binding.hostId === null &&
        !binding.resourceId &&
        !binding.creation?.sentAt &&
        this.now() - binding.createdAt > 60_000;
      if (!stranded && (binding.hostId === null || listed.has(binding.hostId))) continue;
      this.operations.get(binding.id)?.controller.abort();
      this.deps.store.removeBinding(binding.id);
      this.renewals.delete(binding.id);
      this.observedTicket.delete(binding.id);
      await this.deps.files.forget(this.deps.clientDir, binding.id).catch(() => {});
    }
  }
}
