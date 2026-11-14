import type {
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
  /** Each cloud host's status, from the lifecycle coordinator once it runs. */
  hostStatuses?: () => CloudHostStatus[];
}

/**
 * The cloud side of Remote Hosts, as IPC and the rest of main reach it: the
 * connected accounts and, through the lifecycle coordinator, each cloud
 * host's machine. Every answer is free of credentials.
 */
export class CloudHosts {
  private readonly stopWatching: () => void;
  private emitQueued = false;

  constructor(private readonly deps: CloudHostsDeps) {
    this.stopWatching = deps.store.onChange(() => this.changed());
  }

  get accounts(): CloudAccountService {
    return this.deps.accounts;
  }

  snapshot(): CloudHostsSnapshot {
    return {
      providers: this.deps.accounts.providerInfos(),
      accounts: this.deps.accounts.summaries(),
      hosts: this.deps.hostStatuses?.() ?? [],
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
