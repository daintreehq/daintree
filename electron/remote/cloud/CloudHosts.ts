import {
  cloudProviderNamespace,
  type CloudHostCreatedFor,
  type CloudHostCreateRequest,
  type CloudHostImportRequest,
  type CloudAccountAddRequest,
  type CloudAccountCheckResult,
  type CloudAccountSummary,
  type CloudCatalog,
  type CloudHostStatus,
  type CloudHostsSnapshot,
  type CloudResourceSummary,
  type CloudWorktreeCleanupOutcome,
  type PluginCloudAccountInfo,
} from "../../../shared/types/cloudHosts.js";
import type { CloudAccountService } from "./CloudAccountService.js";
import type { CloudHostStore, StoredCloudAccount } from "./CloudHostStore.js";
import type { CloudHostLifecycle } from "./CloudHostLifecycle.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError, isAppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

declare module "../runtime.js" {
  interface RemoteServices {
    cloudHosts: CloudHosts;
  }
}

function ownedBy(account: StoredCloudAccount, pluginId: string): boolean {
  const namespace = cloudProviderNamespace(account.providerId);
  return namespace?.kind === "plugin" && namespace.pluginId === pluginId;
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

  checkAccountCredentials(
    providerId: unknown,
    values: unknown,
    consent?: unknown
  ): Promise<CloudAccountCheckResult> {
    return this.deps.accounts.checkCredentials(providerId, values, consent);
  }

  addAccount(request: CloudAccountAddRequest): Promise<CloudAccountSummary> {
    return this.deps.accounts.addAccount(request);
  }

  replaceAccountCredentials(
    accountId: unknown,
    values: unknown,
    consent?: unknown
  ): Promise<CloudAccountSummary> {
    return this.deps.accounts.replaceCredentials(accountId, values, consent);
  }

  allowAccountProvider(accountId: unknown, consent: unknown): CloudAccountSummary {
    return this.deps.accounts.allowAccountProvider(accountId, consent);
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

  /**
   * The cloud accounts here whose provider comes from a plugin, by plugin id,
   * each with the hosts bound to it (#17353): what the plugin's uninstall asks
   * to keep or remove. Read from what is stored, so a plugin that no longer
   * declares the provider still owns its accounts. Empty when there are none.
   */
  pluginCloudAccounts(): Map<string, PluginCloudAccountInfo[]> {
    const byPlugin = new Map<string, PluginCloudAccountInfo[]>();
    const owned = this.deps.store.accounts().flatMap((account) => {
      const namespace = cloudProviderNamespace(account.providerId);
      return namespace?.kind === "plugin" ? [{ account, pluginId: namespace.pluginId }] : [];
    });
    if (owned.length === 0) return byPlugin;
    const bindings = this.deps.store.bindings();
    for (const { account, pluginId } of owned) {
      const hosts = bindings.flatMap((binding) =>
        binding.accountId === account.id && binding.hostId !== null
          ? [
              {
                hostId: binding.hostId,
                name:
                  this.lifecycleRef?.hostName(binding.hostId) ??
                  binding.observation?.name ??
                  binding.creation?.name ??
                  binding.hostId,
              },
            ]
          : []
      );
      const list = byPlugin.get(pluginId) ?? [];
      list.push({
        id: account.id,
        name: account.displayName,
        providerName: account.pluginProvider?.providerName ?? account.providerId,
        hosts,
      });
      byPlugin.set(pluginId, list);
    }
    return byPlugin;
  }

  /**
   * Refused unless every listed account that is still here belongs to a
   * provider in `pluginId`'s namespace: checked before the plugin goes, so a
   * removal its uninstall asked for never stops halfway on a stray id.
   */
  requirePluginAccounts(pluginId: string, accountIds: readonly string[]): void {
    for (const accountId of accountIds) {
      const account = this.deps.store.account(accountId);
      if (account && !ownedBy(account, pluginId)) {
        throw new AppError({
          code: "VALIDATION",
          message: `Cloud account ${accountId} isn't one of ${pluginId}'s`,
          userMessage: `${account.displayName} doesn't belong to that plugin's cloud provider.`,
        });
      }
    }
  }

  /**
   * Removes the listed accounts of `pluginId`'s providers from this device
   * after the plugin was uninstalled (#17353): each account's hosts leave the
   * list as Settings → Remove host takes them, then the account goes with its
   * sealed credentials. Nothing is asked of the provider, so every machine
   * keeps running in its account. One account that can't be removed doesn't
   * stop the rest; the error names each one left, to remove in Settings → Hosts.
   */
  async removePluginAccounts(pluginId: string, accountIds: readonly string[]): Promise<void> {
    const left: string[] = [];
    for (const accountId of accountIds) {
      const account = this.deps.store.account(accountId);
      if (!account || !ownedBy(account, pluginId)) continue;
      try {
        await this.lifecycleRef?.forgetAccountHosts(account.id);
        await this.deps.accounts.removeAccount(account.id);
      } catch (error) {
        const why =
          isAppError(error) && error.userMessage
            ? error.userMessage
            : formatErrorMessage(error, "it couldn't be removed");
        left.push(`${account.displayName} (${why})`);
      }
    }
    if (left.length === 0) return;
    const message = `The plugin was uninstalled, but ${left.length === 1 ? "this cloud account is" : "these cloud accounts are"} still on this device: ${left.join("; ")}. Remove ${left.length === 1 ? "it" : "them"} in Settings → Hosts.`;
    throw new AppError({ code: "PERSIST_FAILED", message, userMessage: message });
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
  }
}
