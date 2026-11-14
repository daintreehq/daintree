import { defineIpcNamespace, op } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { CLOUD_HOSTS_METHOD_CHANNELS } from "./cloudHosts.preload.js";
import type {
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
  },
});

export function registerCloudHostsHandlers(): () => void {
  return cloudHostsNamespace.register();
}
