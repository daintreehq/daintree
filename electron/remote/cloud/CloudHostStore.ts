import {
  isCloudProviderId,
  isValidCloudBindingId,
  type CloudAccountValidation,
  type CloudBillingScope,
  type CloudHostError,
  type CloudProviderId,
} from "../../../shared/types/cloudHosts.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";

/**
 * Cloud accounts and the bindings that tie a Remote Host to a provider's
 * machine, in the device-owned `cloudHosts` store key. Like `remoteHosts`, the
 * key is absent from the store defaults, so a settings file is untouched until
 * someone connects an account.
 *
 * An account's key is never here: CloudCredentialVault holds it. A binding keeps
 * the machine's identity (its provider id), never its address: the address is
 * resolved again on every start and kept only as a diagnostic.
 */

export interface StoredCloudAccount {
  id: string;
  providerId: CloudProviderId;
  displayName: string;
  identity: string | null;
  scope: CloudBillingScope;
  /** The API base URL the key was checked against; it is never sent anywhere else. */
  apiUrl: string;
  keyHint: string | null;
  addedAt: number;
  validation: CloudAccountValidation;
}

/** A create that may have reached the provider: kept until its outcome is known. */
export interface StoredCreationIntent {
  operationId: string;
  idempotencyKey: string;
  sentAt: number | null;
  name: string;
  machineType: string;
}

/** How the machine's sshd answered the last time access was resolved. Diagnostic and pinning only. */
export interface StoredSshAccess {
  user: string;
  host: string;
  port: number;
  hostKey: string;
  obtainedAt: number;
}

export interface StoredCloudObservation {
  machine: string;
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
  creation: StoredCreationIntent | null;
  /** The lifetime a start and every renewal sets, in seconds; null for none. */
  lifetimeSeconds: number | null;
  /** What the person last asked of the machine: a stop they chose is never undone by a reconnect. */
  intent: "run" | "stop" | null;
  observation: StoredCloudObservation | null;
  access: StoredSshAccess | null;
  lastError: CloudHostError | null;
  createdAt: number;
}

export interface CloudHostsValue {
  version: 1;
  accounts: StoredCloudAccount[];
  bindings: StoredCloudBinding[];
}

export interface CloudHostsStoreBackend {
  get(key: "cloudHosts"): unknown;
  set(key: "cloudHosts", value: CloudHostsValue): void;
}

const ACCOUNT_ID = /^ca_[a-z0-9]{8,32}$/;

export function isValidCloudAccountId(id: unknown): id is string {
  return typeof id === "string" && ACCOUNT_ID.test(id);
}

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
  if (!value || (value.kind !== "personal" && value.kind !== "organization")) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  return { kind: value.kind, id: value.id, name: str(value.name) ?? value.id };
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
    addedAt: num(value.addedAt) ?? 0,
    validation: readValidation(value.validation),
  };
}

function readAccess(raw: unknown): StoredSshAccess | null {
  const value = raw as Record<string, unknown> | null;
  if (!value) return null;
  const user = str(value.user);
  const host = str(value.host);
  const port = num(value.port);
  const hostKey = str(value.hostKey);
  if (!user || !host || port === null || !hostKey) return null;
  return { user, host, port, hostKey, obtainedAt: num(value.obtainedAt) ?? 0 };
}

function readObservation(raw: unknown): StoredCloudObservation | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value.machine !== "string") return null;
  const stop = value.stop as { status?: unknown; error?: unknown } | null | undefined;
  return {
    machine: value.machine,
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
    observedAt: num(value.observedAt) ?? 0,
  };
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
    name: str(value.name) ?? "",
    machineType: str(value.machineType) ?? "default",
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

function readBinding(raw: unknown): StoredCloudBinding | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || !isValidCloudBindingId(value.id) || !isCloudProviderId(value.providerId))
    return null;
  if (!isValidCloudAccountId(value.accountId)) return null;
  const hostId =
    typeof value.hostId === "string" && isValidRemoteHostId(value.hostId) ? value.hostId : null;
  return {
    id: value.id,
    hostId,
    accountId: value.accountId,
    providerId: value.providerId,
    resourceId: str(value.resourceId),
    ownership: value.ownership === "imported" ? "imported" : "created-by-daintree",
    creation: readCreation(value.creation),
    lifetimeSeconds: value.lifetimeSeconds === null ? null : (num(value.lifetimeSeconds) ?? null),
    intent: value.intent === "run" || value.intent === "stop" ? value.intent : null,
    observation: readObservation(value.observation),
    access: readAccess(value.access),
    lastError: readError(value.lastError),
    createdAt: num(value.createdAt) ?? 0,
  };
}

/**
 * Reads tolerate anything a hand edit or another build left; a record that
 * doesn't read is skipped here but kept on disk until the next write, so a
 * downgrade never deletes what it can't understand by reading it.
 */
export class CloudHostStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly backend: CloudHostsStoreBackend) {}

  private raw(): { accounts: unknown[]; bindings: unknown[] } {
    const value = this.backend.get("cloudHosts") as
      { accounts?: unknown; bindings?: unknown } | undefined;
    return {
      accounts: Array.isArray(value?.accounts) ? value.accounts : [],
      bindings: Array.isArray(value?.bindings) ? value.bindings : [],
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

  putAccount(account: StoredCloudAccount): void {
    this.mutate((raw) => {
      const index = raw.accounts.findIndex(
        (entry) => (entry as { id?: unknown })?.id === account.id
      );
      if (index >= 0) raw.accounts[index] = account;
      else raw.accounts.push(account);
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

  removeBinding(id: string): void {
    this.mutate((raw) => {
      raw.bindings = raw.bindings.filter((entry) => (entry as { id?: unknown })?.id !== id);
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mutate(change: (raw: { accounts: unknown[]; bindings: unknown[] }) => void): void {
    const raw = this.raw();
    change(raw);
    this.backend.set("cloudHosts", {
      version: 1,
      accounts: raw.accounts as StoredCloudAccount[],
      bindings: raw.bindings as StoredCloudBinding[],
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[CloudHostStore] change listener failed:", error);
      }
    }
  }
}
