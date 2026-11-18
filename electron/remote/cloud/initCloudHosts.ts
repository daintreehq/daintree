import { app } from "electron";
import path from "node:path";
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import { registerRemoteService } from "../runtime.js";
import { Agent37Client, resolveAgent37ApiUrl } from "./agent37/Agent37Client.js";
import { Agent37Provider } from "./agent37/Agent37Provider.js";
import { AwsClient, resolveAwsApiUrl } from "./aws/AwsClient.js";
import { AwsProvider } from "./aws/AwsProvider.js";
import { BoatClient, resolveBoatApiUrl } from "./boat/BoatClient.js";
import { BoatProvider } from "./boat/BoatProvider.js";
import { GceTokenSource, gceTokenUrlFor } from "./gce/gceAuth.js";
import { GceClient, resolveGceApiUrl } from "./gce/GceClient.js";
import { GceProvider, type GceEndpoints } from "./gce/GceProvider.js";
import { CloudAccountService } from "./CloudAccountService.js";
import {
  DigitalOceanClient,
  resolveDigitalOceanApiUrl,
} from "./digitalocean/DigitalOceanClient.js";
import { DigitalOceanProvider } from "./digitalocean/DigitalOceanProvider.js";
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

/** One client per API origin, made the first time an account there is used. */
function clientCache<C>(make: (baseUrl: string) => C): (apiUrl: string) => C {
  const clients = new Map<string, C>();
  return (apiUrl) => {
    let client = clients.get(apiUrl);
    if (!client) {
      client = make(apiUrl);
      clients.set(apiUrl, client);
    }
    return client;
  };
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
  const providers = new CloudProviderRegistry();
  providers.register(new BoatProvider(clientCache((baseUrl) => new BoatClient({ baseUrl }))), {
    owner: { kind: "built-in" },
    apiUrl: boatUrl,
  });
  providers.register(
    new Agent37Provider(clientCache((baseUrl) => new Agent37Client({ baseUrl }))),
    { owner: { kind: "built-in" }, apiUrl: resolveAgent37ApiUrl(app.isPackaged) }
  );
  providers.register(
    new DigitalOceanProvider(clientCache((baseUrl) => new DigitalOceanClient({ baseUrl }))),
    { owner: { kind: "built-in" }, apiUrl: resolveDigitalOceanApiUrl(app.isPackaged) }
  );
  const gceEndpoints = new Map<string, GceEndpoints>();
  const gce = new GceProvider((apiUrl) => {
    let endpoints = gceEndpoints.get(apiUrl);
    if (!endpoints) {
      endpoints = {
        client: new GceClient({ baseUrl: apiUrl }),
        tokens: new GceTokenSource(gceTokenUrlFor(apiUrl)),
      };
      gceEndpoints.set(apiUrl, endpoints);
    }
    return endpoints;
  });
  providers.register(gce, {
    owner: { kind: "built-in" },
    apiUrl: resolveGceApiUrl(app.isPackaged),
  });
  providers.register(new AwsProvider({ client: new AwsClient() }), {
    owner: { kind: "built-in" },
    apiUrl: resolveAwsApiUrl(app.isPackaged),
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
      gce.dispose();
      for (const endpoints of gceEndpoints.values()) endpoints.tokens.dispose();
    },
  };
}
