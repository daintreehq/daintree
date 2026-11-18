import type {
  CloudHostCreatedFor,
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudResourceSummary,
  CloudWorktreeCleanupOutcome,
} from "../../../shared/types/cloudHosts.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore } from "./CloudHostStore.js";
import type { CloudHostLifecycle } from "./CloudHostLifecycle.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";

declare module "../runtime.js" {
  interface RemoteServices {
    cloudHosts: CloudHosts;
  }
}

export interface CloudHostsDeps {
  accounts: CloudAccountService;
  store: CloudHostStore;
  /** Tells every view the cloud picture changed. */
  emit(snapshot: CloudHostsSnapshot): void;
  now?: () => number;
}

/**
 * The cloud side of Remote Hosts, as IPC and the rest of main reach it: the
 * connected accounts and, through the lifecycle coordinator, each cloud
 * host's machine. Every answer is free of credentials.
 */
export class CloudHosts {
  private readonly stopWatching: () => void;
  private emitQueued = false;
  private disposed = false;
  private lifecycleRef: CloudHostLifecycle | null = null;

  constructor(private readonly deps: CloudHostsDeps) {
    this.stopWatching = deps.store.onChange(() => this.changed());
  }

  get accounts(): CloudAccountService {
    return this.deps.accounts;
  }

  /** The machine lifecycle, once Remote Hosts has the host list it needs. */
  attachLifecycle(lifecycle: CloudHostLifecycle): void {
    this.lifecycleRef = lifecycle;
    this.changed();
  }

  get lifecycle(): CloudHostLifecycle {
    if (!this.lifecycleRef) {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "Cloud host lifecycle isn't running",
        userMessage: "Cloud hosts aren't ready yet. Try again in a moment.",
      });
    }
    return this.lifecycleRef;
  }

  createHost(request: CloudHostCreateRequest): Promise<{ hostId: HostId }> {
    return this.lifecycle.create(request);
  }

  /**
   * Creates a machine for a worktree on this device, marked for it in the
   * create's first write, with the worktree waiting to open on the new host
   * from the host's own first write. The mark names this device: a window on
   * another host has no worktree here to make a machine for. `projectName` is
   * main's own record of the project, never the asker's.
   */
  async createHostForWorktree(
    machine: unknown,
    worktree: unknown,
    projectName: string
  ): Promise<{ hostId: HostId; requestedAt: number }> {
    const target = (worktree && typeof worktree === "object" ? worktree : {}) as Record<
      string,
      unknown
    >;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const projectId = text(target.projectId);
    const worktreeId = text(target.worktreeId);
    const worktreeName = text(target.worktreeName).trim();
    const createdFor: CloudHostCreatedFor = {
      hostId: null,
      projectId,
      worktreeId,
      projectName,
      worktreeName,
      hostName: null,
    };
    const requestedAt = (this.deps.now ?? Date.now)();
    const { hostId } = await this.lifecycle.create(machine as CloudHostCreateRequest, createdFor, {
      projectId,
      worktreeId,
      worktreePath: worktreeId,
      label: worktreeName,
      requestedAt,
      createdMachine: true,
    });
    return { hostId, requestedAt };
  }

  importHost(request: CloudHostImportRequest): Promise<{ hostId: HostId }> {
    return this.lifecycle.importMachine(request);
  }

  startHost(hostId: unknown): Promise<void> {
    return this.lifecycle.startMachine(hostId);
  }

  stopHost(hostId: unknown): Promise<void> {
    return this.lifecycle.stopMachine(hostId);
  }

  retryCreate(hostId: unknown): Promise<void> {
    return this.lifecycle.retryCreate(hostId);
  }

  refreshHost(hostId: unknown): Promise<void> {
    return this.lifecycle.refresh(hostId);
  }

  deleteMachine(hostId: unknown, resourceId: unknown): Promise<void> {
    return this.lifecycle.deleteMachine(hostId, resourceId);
  }

  setLifetime(hostId: unknown, lifetimeHours: unknown): Promise<void> {
    return this.lifecycle.setLifetime(hostId, lifetimeHours);
  }

  trustHostKey(hostId: unknown, fingerprint: unknown): Promise<void> {
    return this.lifecycle.trustHostKey(hostId, fingerprint);
  }

  prepareWorktreeCleanup(worktree: unknown, machines: unknown, mutationId: unknown): void {
    this.lifecycle.prepareWorktreeCleanup(worktree, machines, mutationId);
  }

  settleWorktreeCleanup(
    worktree: unknown,
    deleted: unknown,
    mutationId: unknown
  ): Promise<CloudWorktreeCleanupOutcome[]> {
    return this.lifecycle.settleWorktreeCleanup(worktree, deleted, mutationId);
  }

  retryWorktreeCleanup(hostId: unknown): Promise<void> {
    return this.lifecycle.retryWorktreeCleanup(hostId);
  }

  dismissWorktreeCleanup(hostId: unknown): void {
    this.lifecycle.dismissWorktreeCleanup(hostId);
  }

  snapshot(): CloudHostsSnapshot {
    return {
      providers: this.deps.accounts.providerInfos(),
      accounts: this.deps.accounts.summaries(),
      hosts: this.lifecycleRef?.statuses() ?? ([] as CloudHostStatus[]),
    };
  }

  /** Coalesces a burst of store writes into one event. */
  changed(): void {
    if (this.emitQueued || this.disposed) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      if (!this.disposed) this.deps.emit(this.snapshot());
    });
  }

  /** A provider registered or left: what its accounts and hosts can do changed with it. */
  providersChanged(): void {
    this.lifecycleRef?.providersChanged();
    this.changed();
  }

  checkAccountCredentials(providerId: unknown, values: unknown): Promise<CloudAccountCheckResult> {
    return this.deps.accounts.checkCredentials(providerId, values);
  }

  addAccount(request: CloudAccountAddRequest): Promise<CloudAccountSummary> {
    return this.deps.accounts.addAccount(request);
  }

  replaceAccountCredentials(accountId: unknown, values: unknown): Promise<CloudAccountSummary> {
    return this.deps.accounts.replaceCredentials(accountId, values);
  }

  renameAccount(accountId: unknown, displayName: unknown): CloudAccountSummary {
    return this.deps.accounts.rename(accountId, displayName);
  }

  removeAccount(accountId: unknown): Promise<void> {
    return this.deps.accounts.removeAccount(accountId);
  }

  validateAccount(accountId: unknown): Promise<CloudAccountSummary> {
    return this.deps.accounts.validate(accountId);
  }

  catalog(accountId: unknown, refresh: boolean): Promise<CloudCatalog> {
    return this.deps.accounts.catalog(accountId, { refresh });
  }

  listResources(accountId: unknown): Promise<CloudResourceSummary[]> {
    return this.deps.accounts.listResources(accountId);
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
  }
}
