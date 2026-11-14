import type {
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudHostsSnapshot,
  CloudResourceSummary,
} from "@shared/types/cloudHosts";

/** Cloud accounts and cloud hosts. A key goes in once and never comes back. */
export const cloudHostsClient = {
  getSnapshot: (): Promise<CloudHostsSnapshot> => window.electron.cloudHosts.getSnapshot(),
  checkAccountKey: (providerId: string, apiKey: string): Promise<CloudAccountCheckResult> =>
    window.electron.cloudHosts.checkAccountKey({ providerId, apiKey }),
  addAccount: (request: CloudAccountAddRequest): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.addAccount(request),
  replaceAccountKey: (accountId: string, apiKey: string): Promise<CloudAccountSummary> =>
    window.electron.cloudHosts.replaceAccountKey({ accountId, apiKey }),
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
};
