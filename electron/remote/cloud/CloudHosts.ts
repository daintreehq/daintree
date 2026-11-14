import type {
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudResourceSummary,
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
}

/**
 * The cloud side of Remote Hosts, as IPC and the rest of main reach it: the
 * connected accounts and, through the lifecycle coordinator, each cloud
 * host's machine. Every answer is free of credentials.
 */
export class CloudHosts {
  private readonly stopWatching: () => void;
  private emitQueued = false;
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

  snapshot(): CloudHostsSnapshot {
    return {
      providers: this.deps.accounts.providerInfos(),
      accounts: this.deps.accounts.summaries(),
      hosts: this.lifecycleRef?.statuses() ?? ([] as CloudHostStatus[]),
    };
  }

  /** Coalesces a burst of store writes into one event. */
  changed(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.deps.emit(this.snapshot());
    });
  }

  checkAccountKey(providerId: unknown, apiKey: unknown): Promise<CloudAccountCheckResult> {
    return this.deps.accounts.checkKey(providerId, apiKey);
  }

  addAccount(request: CloudAccountAddRequest): Promise<CloudAccountSummary> {
    return this.deps.accounts.addAccount(request);
  }

  replaceAccountKey(accountId: unknown, apiKey: unknown): Promise<CloudAccountSummary> {
    return this.deps.accounts.replaceKey(accountId, apiKey);
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
    this.stopWatching();
  }
}
