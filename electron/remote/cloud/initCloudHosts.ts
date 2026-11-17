import { app } from "electron";
import path from "node:path";
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import { registerRemoteService } from "../runtime.js";
import { BoatClient, resolveBoatApiUrl } from "./boat/BoatClient.js";
import { BoatProvider } from "./boat/BoatProvider.js";
import { CloudAccountService } from "./CloudAccountService.js";
import { KeychainCloudCredentialVault } from "./CloudCredentialVault.js";
import { CloudHostStore, type CloudHostsStoreBackend } from "./CloudHostStore.js";
import { CloudHosts } from "./CloudHosts.js";
import { CloudProviderRegistry } from "./CloudProviderRegistry.js";

export interface CloudHostsRuntime {
  cloudHosts: CloudHosts;
  store: CloudHostStore;
  accounts: CloudAccountService;
  /** Providers register and leave at runtime; a stored account outlives its provider. */
  providers: CloudProviderRegistry;
  dispose(): void;
}

/**
 * Builds the cloud side of Remote Hosts. Costs nothing until an account is
 * connected: no request is made and no file is written before then.
 */
export function initCloudHosts(params: {
  backend: CloudHostsStoreBackend;
  emit(event: RemoteHostsEvent): void;
  onAccountRemoved?(accountId: string): Promise<void>;
  beforeAccountRemoved?(accountId: string): Promise<void>;
}): CloudHostsRuntime {
  const store = new CloudHostStore(params.backend);
  const boatUrl = resolveBoatApiUrl(app.isPackaged);
  const clients = new Map<string, BoatClient>();
  const boatClientFor = (apiUrl: string): BoatClient => {
    let client = clients.get(apiUrl);
    if (!client) {
      client = new BoatClient({ baseUrl: apiUrl });
      clients.set(apiUrl, client);
    }
    return client;
  };
  const providers = new CloudProviderRegistry();
  providers.register(new BoatProvider(boatClientFor), {
    owner: { kind: "built-in" },
    apiUrl: boatUrl,
  });
  const accounts = new CloudAccountService({
    store,
    vault: new KeychainCloudCredentialVault(
      path.join(app.getPath("userData"), "cloud-credentials.json")
    ),
    providers,
    apiUrlFor: (providerId) => providers.apiUrlFor(providerId),
    onAccountRemoved: params.onAccountRemoved,
    beforeAccountRemoved: params.beforeAccountRemoved,
  });
  const cloudHosts = new CloudHosts({
    accounts,
    store,
    emit: (snapshot) => params.emit({ type: "cloud-changed", snapshot }),
  });
  const stopWatchingProviders = providers.onChange(() => cloudHosts.providersChanged());
  const unregister = registerRemoteService("cloudHosts", cloudHosts);
  // Views that read before this started got the empty answer; tell them what there is.
  cloudHosts.changed();
  return {
    cloudHosts,
    store,
    accounts,
    providers,
    dispose() {
      stopWatchingProviders();
      unregister();
      cloudHosts.dispose();
    },
  };
}
