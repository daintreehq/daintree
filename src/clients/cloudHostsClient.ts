import type {
  CloudHostCreateForWorktreeRequest,
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudCredentialValues,
  CloudHostsSnapshot,
  CloudResourceSummary,
  CloudTunnelLookup,
  CloudWorktreeCleanupOutcome,
  CloudWorktreeCleanupRequest,
  CloudWorktreeRef,
} from "@shared/types/cloudHosts";

/** Cloud accounts and cloud hosts. Credentials go in once and never come back. */
export const cloudHostsClient = {
  getSnapshot: (): Promise<CloudHostsSnapshot> => window.electron.cloudHosts.getSnapshot(),
  /** `consent`: for a plugin's provider, the fingerprint of what the person agreed to. */
  checkAccountCredentials: (
    providerId: string,
    credentials: CloudCredentialValues,
    consent?: string
  ): Promise<CloudAccountCheckResult> =>
    window.electron.cloudHosts.checkAccountKey({
      providerId,
      credentials,
      ...(consent !== undefined ? { consent } : {}),
    }),
  addAccount: (request: CloudAccountAddRequest): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.addAccount(request),
  replaceAccountCredentials: (
    accountId: string,
    credentials: CloudCredentialValues,
    consent?: string
  ): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.replaceAccountKey({
      accountId,
      credentials,
      ...(consent !== undefined ? { consent } : {}),
    }),
  /** The person reviewed the plugin behind an account's provider and allowed it. */
  allowAccountProvider: (accountId: string, consent: string): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.allowAccountProvider({ accountId, consent }),
  renameAccount: (accountId: string, displayName: string): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.renameAccount({ accountId, displayName }),
  removeAccount: (accountId: string): Promise<void> =>
    window.electron.cloudHosts.removeAccount({ accountId }),
  validateAccount: (accountId: string): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.validateAccount({ accountId }),
  getCatalog: (accountId: string, refresh = false): Promise<CloudCatalog> =>
    window.electron.cloudHosts.getCatalog({ accountId, refresh }),
  listResources: (accountId: string): Promise<CloudResourceSummary[]> =>
    window.electron.cloudHosts.listResources({ accountId }),
  /** Whether the provider's tunnel command is on this device's PATH; null when it needs none. */
  findTunnel: (providerId: string): Promise<CloudTunnelLookup | null> =>
    window.electron.cloudHosts.findTunnel({ providerId }),
  createHost: (request: CloudHostCreateRequest): Promise<{ hostId: string }> =>
    window.electron.cloudHosts.createHost(request),
  /** A machine marked as created for a worktree on this device. */
  createHostForWorktree: (
    request: CloudHostCreateForWorktreeRequest
  ): Promise<{ hostId: string; requestedAt: number }> =>
    window.electron.cloudHosts.createHostForWorktree(request),
  importHost: (request: CloudHostImportRequest): Promise<{ hostId: string }> =>
    window.electron.cloudHosts.importHost(request),
  /** A person's Start: the one call that resumes a stopped machine. */
  startHost: (hostId: string): Promise<void> => window.electron.cloudHosts.startHost({ hostId }),
  stopHost: (hostId: string): Promise<void> => window.electron.cloudHosts.stopHost({ hostId }),
  retryCreate: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.retryCreate({ hostId }),
  /**
   * Lease one of the order's offers at the rate the person saw; the create then carries on
   * as any other. Refused, leaving the order open, when that offer has gone or been
   * requoted, or the order is no longer the one shown.
   */
  chooseOffer: (
    hostId: string,
    orderId: string,
    offerId: string,
    hourlyDollars: number
  ): Promise<void> =>
    window.electron.cloudHosts.chooseOffer({ hostId, orderId, offerId, hourlyDollars }),
  /** Close the order. One of its offers leased meanwhile is kept: the snapshot says which happened. */
  cancelOrder: (hostId: string, orderId: string): Promise<void> =>
    window.electron.cloudHosts.cancelOrder({ hostId, orderId }),
  /** Read the order's offers again now, rather than at the next refresh. */
  refreshOffers: (hostId: string, orderId: string): Promise<void> =>
    window.electron.cloudHosts.refreshOffers({ hostId, orderId }),
  refreshHost: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.refreshHost({ hostId }),
  deleteMachine: (hostId: string, resourceId: string | null): Promise<void> =>
    window.electron.cloudHosts.deleteMachine({ hostId, resourceId }),
  setLifetime: (hostId: string, lifetimeHours: number | null): Promise<void> =>
    window.electron.cloudHosts.setLifetime({ hostId, lifetimeHours }),
  trustHostKey: (hostId: string, fingerprint: string): Promise<void> =>
    window.electron.cloudHosts.trustHostKey({ hostId, fingerprint }),
  /** Before a worktree's delete is sent: what to do with each machine made for it. */
  prepareWorktreeCleanup: (
    worktree: CloudWorktreeRef,
    machines: CloudWorktreeCleanupRequest[],
    mutationId: string | null
  ): Promise<void> =>
    window.electron.cloudHosts.prepareWorktreeCleanup({ worktree, machines, mutationId }),
  /** Once an attempt ends (null: its answer was lost); resolves when the stops and deletes are done. */
  settleWorktreeCleanup: (
    worktree: CloudWorktreeRef,
    deleted: boolean | null,
    mutationId: string | null
  ): Promise<CloudWorktreeCleanupOutcome[]> =>
    window.electron.cloudHosts.settleWorktreeCleanup({ worktree, deleted, mutationId }),
  retryWorktreeCleanup: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.retryWorktreeCleanup({ hostId }),
  dismissWorktreeCleanup: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.dismissWorktreeCleanup({ hostId }),
};
