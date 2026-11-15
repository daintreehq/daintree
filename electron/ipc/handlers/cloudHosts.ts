import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { CLOUD_HOSTS_METHOD_CHANNELS } from "./cloudHosts.preload.js";
import type {
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudHostsSnapshot,
  CloudResourceSummary,
} from "../../../shared/types/cloudHosts.js";

const EMPTY_SNAPSHOT: CloudHostsSnapshot = { providers: [], accounts: [], hosts: [] };

function field(payload: unknown, name: string): unknown {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Cloud accounts and cloud hosts. Keys come in once (check, add, replace) and
 * never go back out; every answer is the credential-free picture.
 */
export const cloudHostsNamespace = defineIpcNamespace({
  name: "cloudHosts",
  ops: {
    getSnapshot: op(
      CLOUD_HOSTS_METHOD_CHANNELS.getSnapshot,
      async (): Promise<CloudHostsSnapshot> =>
        getRemoteService("cloudHosts")?.snapshot() ?? EMPTY_SNAPSHOT
    ),
    checkAccountKey: op(
      CLOUD_HOSTS_METHOD_CHANNELS.checkAccountKey,
      async (payload: { providerId: string; apiKey: string }): Promise<CloudAccountCheckResult> =>
        requireRemoteService("cloudHosts").checkAccountKey(
          field(payload, "providerId"),
          field(payload, "apiKey")
        )
    ),
    addAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.addAccount,
      async (payload: CloudAccountAddRequest): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").addAccount(payload)
    ),
    replaceAccountKey: op(
      CLOUD_HOSTS_METHOD_CHANNELS.replaceAccountKey,
      async (payload: { accountId: string; apiKey: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").replaceAccountKey(
          field(payload, "accountId"),
          field(payload, "apiKey")
        )
    ),
    renameAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.renameAccount,
      async (payload: { accountId: string; displayName: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").renameAccount(
          field(payload, "accountId"),
          field(payload, "displayName")
        )
    ),
    removeAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.removeAccount,
      async (payload: { accountId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").removeAccount(field(payload, "accountId"))
    ),
    validateAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.validateAccount,
      async (payload: { accountId: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").validateAccount(field(payload, "accountId"))
    ),
    getCatalog: op(
      CLOUD_HOSTS_METHOD_CHANNELS.getCatalog,
      async (payload: { accountId: string; refresh?: boolean }): Promise<CloudCatalog> =>
        requireRemoteService("cloudHosts").catalog(
          field(payload, "accountId"),
          field(payload, "refresh") === true
        )
    ),
    listResources: op(
      CLOUD_HOSTS_METHOD_CHANNELS.listResources,
      async (payload: { accountId: string }): Promise<CloudResourceSummary[]> =>
        requireRemoteService("cloudHosts").listResources(field(payload, "accountId"))
    ),
    createHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.createHost,
      async (payload: CloudHostCreateRequest): Promise<{ hostId: string }> =>
        requireRemoteService("cloudHosts").createHost(payload)
    ),
    importHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.importHost,
      async (payload: CloudHostImportRequest): Promise<{ hostId: string }> =>
        requireRemoteService("cloudHosts").importHost(payload)
    ),
    // A person's Start: the only path that resumes a stopped machine.
    startHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.startHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").startHost(field(payload, "hostId"))
    ),
    stopHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.stopHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").stopHost(field(payload, "hostId"))
    ),
    retryCreate: op(
      CLOUD_HOSTS_METHOD_CHANNELS.retryCreate,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").retryCreate(field(payload, "hostId"))
    ),
    refreshHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.refreshHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").refreshHost(field(payload, "hostId"))
    ),
    // Names the machine the person confirmed, so a rebind meanwhile deletes nothing.
    deleteMachine: op(
      CLOUD_HOSTS_METHOD_CHANNELS.deleteMachine,
      async (payload: { hostId: string; resourceId: string | null }): Promise<void> =>
        requireRemoteService("cloudHosts").deleteMachine(
          field(payload, "hostId"),
          field(payload, "resourceId")
        )
    ),
    setLifetime: op(
      CLOUD_HOSTS_METHOD_CHANNELS.setLifetime,
      async (payload: { hostId: string; lifetimeHours: number | null }): Promise<void> =>
        requireRemoteService("cloudHosts").setLifetime(
          field(payload, "hostId"),
          field(payload, "lifetimeHours")
        )
    ),
  },
});

export function registerCloudHostsHandlers(): () => void {
  return cloudHostsNamespace.register();
}
