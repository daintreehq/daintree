import type {
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudCredentialValues,
  CloudHostsSnapshot,
  CloudResourceSummary,
} from "@shared/types/cloudHosts";

/** Cloud accounts and cloud hosts. Credentials go in once and never come back. */
export const cloudHostsClient = {
  getSnapshot: (): Promise<CloudHostsSnapshot> => window.electron.cloudHosts.getSnapshot(),
  checkAccountCredentials: (
    providerId: string,
    credentials: CloudCredentialValues
  ): Promise<CloudAccountCheckResult> =>
    window.electron.cloudHosts.checkAccountKey({ providerId, credentials }),
  addAccount: (request: CloudAccountAddRequest): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.addAccount(request),
  replaceAccountCredentials: (
    accountId: string,
    credentials: CloudCredentialValues
  ): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.replaceAccountKey({ accountId, credentials }),
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
  createHost: (request: CloudHostCreateRequest): Promise<{ hostId: string }> =>
    window.electron.cloudHosts.createHost(request),
  importHost: (request: CloudHostImportRequest): Promise<{ hostId: string }> =>
    window.electron.cloudHosts.importHost(request),
  /** A person's Start: the one call that resumes a stopped machine. */
  startHost: (hostId: string): Promise<void> => window.electron.cloudHosts.startHost({ hostId }),
  stopHost: (hostId: string): Promise<void> => window.electron.cloudHosts.stopHost({ hostId }),
  retryCreate: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.retryCreate({ hostId }),
  refreshHost: (hostId: string): Promise<void> =>
    window.electron.cloudHosts.refreshHost({ hostId }),
  deleteMachine: (hostId: string, resourceId: string | null): Promise<void> =>
    window.electron.cloudHosts.deleteMachine({ hostId, resourceId }),
  setLifetime: (hostId: string, lifetimeHours: number | null): Promise<void> =>
    window.electron.cloudHosts.setLifetime({ hostId, lifetimeHours }),
  trustHostKey: (hostId: string, fingerprint: string): Promise<void> =>
    window.electron.cloudHosts.trustHostKey({ hostId, fingerprint }),
};
