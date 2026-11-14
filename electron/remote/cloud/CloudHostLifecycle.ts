import crypto from "node:crypto";
import {
  CLOUD_LIFETIME_CHOICES,
  type CloudHostCreateRequest,
  type CloudHostError,
  type CloudHostImportRequest,
  type CloudHostStatus,
  type CloudMachineState,
  type CloudOperation,
  type CloudOperationKind,
} from "../../../shared/types/cloudHosts.js";
import {
  cloudConnection,
  type HostConnection,
  type HostDescriptor,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { TransportError, UnusableConnectionError } from "../client/transport.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type {
  CloudHostStore,
  StoredCloudBinding,
  StoredCloudObservation,
} from "./CloudHostStore.js";
import type { CloudSshFiles, CloudSshRoute } from "./CloudSshFiles.js";
import { hostKeyFingerprint, formatSshEndpoint } from "./sshEndpoint.js";
import type { CloudProvider, ProviderCredentials, ProviderResource } from "./provider.js";

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

function observationOf(resource: ProviderResource, at: number): StoredCloudObservation {
  return {
    machine: resource.machine,
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
  private renewingAll = false;
  private stopWatchingHosts: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: CloudHostLifecycleDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms, signal);
  }

  /** Begins background observation and reconciles what a previous run left unfinished. */
  start(): void {
    this.stopWatchingHosts = this.deps.hosts.onChange(() => void this.dropOrphanBindings());
    void this.dropOrphanBindings();
    this.pollTimer = setInterval(() => void this.pollDue(), 5_000);
    this.pollTimer.unref?.();
    this.keeperTimer = setInterval(() => void this.renewDue(), KEEPER_INTERVAL_MS);
    this.keeperTimer.unref?.();
    void this.reconcileUnfinishedCreates();
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
        return {
          hostId: binding.hostId,
          providerId: binding.providerId,
          accountId: binding.accountId,
          accountName: account?.displayName ?? "Disconnected account",
          resourceId: binding.resourceId,
          ownership: binding.ownership,
          machine: machineOf(binding),
          rawState: observation?.rawState ?? null,
          machineType,
          vcpu: observation?.vcpu ?? null,
          memoryGB: observation?.memoryGB ?? null,
          hourlyDollars: this.deps.accounts.cachedHourly(binding.accountId, machineType),
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
          hostKeyFingerprint: binding.access ? hostKeyFingerprint(binding.access.hostKey) : null,
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
   */
  async create(request: CloudHostCreateRequest): Promise<{ hostId: HostId }> {
    if (!request || typeof request !== "object") throw invalid("Missing machine details.");
    const account = this.deps.accounts.requireAccount(request.accountId);
    this.deps.accounts.requireSupported(account.providerId);
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw invalid("Give the host a name.");
    if (!CLOUD_LIFETIME_CHOICES.includes(request.lifetimeHours)) {
      throw invalid("Choose how long the machine may run before it stops by itself.");
    }
    // A size is checked against the account's current catalog, never assumed.
    const catalog = await this.deps.accounts.catalog(account.id, { refresh: true });
    const size = catalog.machineTypes.find((type) => type.id === request.machineType);
    if (!size) throw invalid("Choose a machine size.");
    if (!size.available) {
      throw invalid(
        size.reason
          ? `${size.label} isn't available: ${size.reason}`
          : `${size.label} isn't available on this account.`
      );
    }
    const bindingId = `cb_${crypto.randomBytes(6).toString("hex")}`;
    const binding: StoredCloudBinding = {
      id: bindingId,
      hostId: null,
      accountId: account.id,
      providerId: account.providerId,
      resourceId: null,
      ownership: "created-by-daintree",
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
    void this.operate(bindingId, "creating", (signal) => this.runCreate(bindingId, signal)).catch(
      () => {}
    );
    return { hostId: descriptor.id };
  }

  /** Sends the create again with the same key: Boat answers with the machine it made, if it made one. */
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
      this.stage(bindingId, "Looking for the machine Boat may already have made");
      const found = await this.findCreated(bindingId, provider, { ...credentials, signal });
      if (found) {
        this.bindCreated(bindingId, found);
        await this.waitFor(bindingId, "running", START_DEADLINE_MS, signal, "Starting the machine");
        return;
      }
    }
    this.stage(bindingId, "Asking Boat for a machine");
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
        labels: {
          [LABEL_MARKER]: "1",
          [LABEL_BINDING]: bindingId,
        },
        idempotencyKey: creation.idempotencyKey,
      });
    } catch (error) {
      const described = provider.describeError(error);
      // Only Boat's own refusal proves nothing was made; anything else (lost answer,
      // cancellation, an unreadable reply, a create still being minted) may have.
      const refused = !signal.aborted && DEFINITE_REFUSALS.has(described.code);
      this.recordError(bindingId, {
        ...described,
        code: refused ? described.code : "outcome-unknown",
        message: refused
          ? described.message
          : "Boat didn't confirm the machine. Retry looks for it before creating another.",
      });
      if (refused) {
        // Nothing was made: a retry needs a fresh key, or Boat replays this refusal.
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
  private async reconcileUnfinishedCreates(): Promise<void> {
    for (const binding of this.deps.store.bindings()) {
      if (binding.resourceId || !binding.creation?.sentAt || !binding.hostId) continue;
      try {
        const { provider, credentials } = await this.context(binding);
        const resource = await this.findCreated(binding.id, provider, credentials);
        if (resource) {
          this.bindCreated(binding.id, resource);
        } else {
          this.recordError(binding.id, {
            code: "outcome-unknown",
            message:
              "Setup didn't finish: Boat has no machine for this host yet. Retry to create it.",
            at: this.now(),
          });
        }
      } catch {
        // The provider can't be asked now; the host keeps saying setup is incomplete.
      }
    }
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
      creation: null,
      lifetimeSeconds: null,
      intent: null,
      observation: null,
      access: null,
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
    // Its own lifetime stays as it is; a start renews to it.
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
    if (!binding.resourceId) {
      if (binding.creation) return this.retryCreate(hostId);
      throw invalid("This host has no machine yet.");
    }
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "run" }));
    await this.operate(binding.id, "starting", (signal) => this.runStart(binding.id, signal));
  }

  private async runStart(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    this.stage(bindingId, "Checking the machine");
    let resource = await this.inspectInto(bindingId, provider, credentials);
    if (resource.dataExpired) {
      const error: CloudHostError = {
        code: "data-expired",
        message:
          "Boat deleted this machine's saved disk after its retention period, so it can't start. Nothing was created in its place.",
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
        const started = await provider.start(credentials, binding.resourceId!, {
          lifetimeSeconds: binding.lifetimeSeconds,
        });
        if (started) this.observe(bindingId, started);
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
    if (!binding.resourceId) throw invalid("This host has no machine to stop.");
    const running = this.operations.get(binding.id);
    // A start, or a create whose machine exists and is still coming up, is
    // superseded by the stop the person asked for now.
    if (running && (running.kind === "starting" || running.kind === "creating")) {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, intent: "stop" }));
    await this.settleRenewal(binding.id);
    await this.deps.hosts.disconnect(binding.hostId).catch(() => {});
    await this.operate(binding.id, "stopping", (signal) => this.runStop(binding.id, signal));
  }

  private async runStop(bindingId: string, signal: AbortSignal): Promise<void> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) return;
    const { provider, credentials } = await this.context(binding, signal);
    this.stage(bindingId, "Saving the disk and stopping");
    try {
      const stopping = await provider.stop(credentials, binding.resourceId);
      if (stopping) this.observe(bindingId, stopping);
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
    if (confirmed.resourceId && confirmResourceId !== confirmed.resourceId) {
      throw invalid("The machine to delete changed since you confirmed. Check it and try again.");
    }
    const running = this.operations.get(confirmed.id);
    if (running && running.kind !== "deleting") {
      running.controller.abort();
      await running.promise.catch(() => {});
    }
    let binding = this.deps.store.binding(confirmed.id) ?? confirmed;
    // A create that reached Boat may have made a machine nothing here has heard
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
      await this.operate(binding.id, "deleting", async (signal) => {
        const { provider, credentials } = await this.context(binding, signal);
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
   * Sets how long the machine runs before it stops by itself. A running
   * machine's own deadline moves too (to that long from now, or none), so
   * what Settings shows is what will happen to this run.
   */
  async setLifetime(hostId: unknown, lifetimeHours: unknown): Promise<void> {
    const binding = this.requireBindingForHost(hostId);
    if (!CLOUD_LIFETIME_CHOICES.includes(lifetimeHours as number | null)) {
      throw invalid("Choose how long the machine may run before it stops by itself.");
    }
    const lifetimeSeconds = lifetimeHours === null ? null : (lifetimeHours as number) * 3600;
    await this.settleRenewal(binding.id);
    this.renewals.delete(binding.id);
    this.deps.store.updateBinding(binding.id, (current) => ({ ...current, lifetimeSeconds }));
    if (
      !binding.resourceId ||
      machineOf(binding) !== "running" ||
      this.operations.has(binding.id)
    ) {
      return;
    }
    const { provider, credentials } = await this.context(binding);
    try {
      this.observe(
        binding.id,
        await provider.renewLifetime(credentials, binding.resourceId, lifetimeSeconds)
      );
    } catch (error) {
      throw this.deps.accounts.asAppError(provider, error);
    }
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
          throw new TransportError("Couldn't ask Boat about the machine", described.message);
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
    const access = binding.access;
    if (
      access &&
      this.now() - access.obtainedAt < ACCESS_TTL_MS &&
      (await this.deps.files.exists(bindingId))
    ) {
      return this.deps.files.route(bindingId);
    }
    let resolved;
    try {
      const publicKey = await this.deps.files.publicKey(binding.accountId);
      resolved = await provider.authorizeSsh(credentials, binding.resourceId!, publicKey);
    } catch (error) {
      const described = provider.describeError(error);
      if (described.code === "provider-unreachable") {
        throw new TransportError("Couldn't get SSH access from Boat", described.message);
      }
      const said = `SSH access couldn't be set up: ${described.message}`;
      this.recordError(bindingId, { ...described, code: "ssh-authorization", message: said });
      throw new UnusableConnectionError(said, said);
    }
    // A master opened to the old address or key must not carry a dial to the new
    // one; the same route written again leaves a live link's master alone.
    const generation = `${resolved.endpoint.host}:${resolved.endpoint.port}:${resolved.hostKey}`;
    const written = this.writtenRoutes.get(bindingId);
    if (written === undefined || written !== generation) {
      await this.deps.files.closeMaster(this.deps.clientDir, bindingId);
    }
    const route = await this.deps.files.write(bindingId, binding.accountId, resolved);
    this.writtenRoutes.set(bindingId, generation);
    this.deps.store.updateBinding(bindingId, (current) => ({
      ...current,
      access: {
        user: resolved.user,
        host: resolved.endpoint.host,
        port: resolved.endpoint.port,
        hostKey: resolved.hostKey,
        obtainedAt: this.now(),
      },
    }));
    return route;
  }

  /** A stable key for one resolution of access: a new one means a new transport. */
  accessGeneration(bindingId: string): string | null {
    const access = this.deps.store.binding(bindingId)?.access;
    return access ? `${access.host}:${access.port}:${access.hostKey}` : null;
  }

  // --- Operations and observation ----------------------------------------

  private operate(
    bindingId: string,
    kind: CloudOperationKind,
    work: (signal: AbortSignal) => Promise<void>
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

  private observe(bindingId: string, resource: ProviderResource): void {
    this.deps.store.updateBinding(bindingId, (current) => {
      const before = current.observation;
      // Any stop, or a start seen from outside, may bring a new address or
      // host key: access is resolved again for the next dial.
      const restarted =
        resource.machine !== "running" ||
        (before !== null && before.machine !== "running") ||
        (before?.stoppedAt ?? null) !== resource.stoppedAt;
      if (restarted) this.renewals.delete(bindingId);
      return {
        ...current,
        access: restarted ? null : current.access,
        observation: observationOf(resource, this.now()),
      };
    });
  }

  private async inspectInto(
    bindingId: string,
    provider: CloudProvider,
    credentials: ProviderCredentials
  ): Promise<ProviderResource> {
    const binding = this.deps.store.binding(bindingId);
    if (!binding?.resourceId) throw new Error("No machine");
    try {
      const resource = await provider.inspect(credentials, binding.resourceId);
      this.observe(bindingId, resource);
      return resource;
    } catch (error) {
      const described = provider.describeError(error);
      if (described.code === "not-found") {
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
      try {
        resource = await provider.inspect({ ...credentials, signal }, binding.resourceId);
        this.observe(bindingId, resource);
      } catch (error) {
        if (signal.aborted) throw error;
        const described = provider.describeError(error);
        if (described.code !== "provider-unreachable") {
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
            `Boat is retrying the save: ${resource.stop.error ?? "the disk couldn't be saved yet"}`
          );
          this.recordError(bindingId, {
            code: "stop-failing",
            message: `Boat couldn't save the disk yet and keeps the machine running while it retries${resource.stop.error ? ` (${resource.stop.error})` : ""}. It isn't billed for that time.`,
            at: this.now(),
          });
        }
      }
      if (this.now() > deadline) {
        const message =
          target === "running"
            ? "The machine didn't come up in time. It may still be starting; check again shortly."
            : "The machine hasn't finished stopping yet. Boat keeps working on it.";
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
    const provider = this.deps.accounts.provider(binding.providerId);
    try {
      const { credentials } = await this.context(binding);
      // A stop, a start or a new lifetime while the key was read: that wins.
      if (!this.renewalDue(bindingId)) return;
      const renewed = await provider.renewLifetime(
        credentials,
        binding.resourceId!,
        lifetimeSeconds
      );
      const current = this.deps.store.binding(bindingId);
      if (!current || current.intent === "stop" || this.operations.has(bindingId)) return;
      this.observe(bindingId, renewed);
      this.renewals.set(bindingId, { at: this.now(), ok: true });
      // A renewal that failed earlier and now went through is no longer news.
      this.deps.store.updateBinding(bindingId, (latest) =>
        latest.lastError?.code === "lifetime-renewal" ? { ...latest, lastError: null } : latest
      );
      this.deps.changed();
    } catch (error) {
      if (this.disposed || this.deps.store.binding(bindingId)?.intent === "stop") return;
      this.renewals.set(bindingId, { at: this.now(), ok: false });
      const described = provider.describeError(error);
      this.recordError(bindingId, {
        code: "lifetime-renewal",
        message: `Couldn't keep the machine running past its lifetime: ${described.message} It stops by itself at the deadline unless this succeeds.`,
        at: described.at,
      });
    }
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
      await this.deps.files.forget(this.deps.clientDir, binding.id).catch(() => {});
    }
  }
}
