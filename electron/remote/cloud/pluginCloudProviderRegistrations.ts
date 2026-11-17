import type { CloudProviderId } from "../../../shared/types/cloudHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  getPluginCloudProviderRuntime,
  listPluginCloudProviders,
  onPluginCloudProvidersChanged,
  pluginCloudProviderBinding,
  pluginCloudProviderUnavailableReason,
  type PluginCloudProviderDeclaration,
} from "../../services/plugin/pluginCloudProviders.js";
import type { CloudProviderRegistry } from "./CloudProviderRegistry.js";
import { PluginCloudProvider, type PluginCloudProviderHost } from "./PluginCloudProvider.js";

export interface PluginCloudProviderRegistrations {
  /** Why a plugin's provider isn't registered, or null for an id that isn't a plugin's. */
  unavailableReason(providerId: CloudProviderId): string | null;
  dispose(): void;
}

const LIVE_HOST: PluginCloudProviderHost = {
  runtime: getPluginCloudProviderRuntime,
  binding: pluginCloudProviderBinding,
};

/**
 * Keeps `providers` holding one provider per cloud provider a loaded plugin
 * declares (#17351): registered when the plugin loads, gone when it unloads,
 * and replaced when a reload changes the declaration. Accounts and hosts of a
 * provider that isn't registered stay, read as unavailable with the plugin
 * service's reason. `statusChanged` hears a change that registered nothing
 * but may have changed a reason.
 */
export function watchPluginCloudProviders(params: {
  providers: CloudProviderRegistry;
  statusChanged(): void;
  host?: PluginCloudProviderHost;
}): PluginCloudProviderRegistrations {
  const host = params.host ?? LIVE_HOST;
  const registered = new Map<
    CloudProviderId,
    { declaration: PluginCloudProviderDeclaration; dispose: () => void }
  >();
  /** Declarations the registry refused, with why; kept until the plugin's next load. */
  const refused = new Map<
    CloudProviderId,
    { declaration: PluginCloudProviderDeclaration; reason: string }
  >();
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const current = new Map(
      listPluginCloudProviders().map((declaration) => [declaration.providerId, declaration])
    );
    let changed = false;
    for (const [providerId, entry] of [...registered]) {
      if (current.get(providerId) === entry.declaration) continue;
      registered.delete(providerId);
      entry.dispose();
      changed = true;
    }
    for (const [providerId, entry] of [...refused]) {
      if (current.get(providerId) !== entry.declaration) refused.delete(providerId);
    }
    for (const declaration of current.values()) {
      const { providerId } = declaration;
      if (registered.has(providerId) || refused.has(providerId)) continue;
      try {
        const dispose = params.providers.register(new PluginCloudProvider(declaration, host), {
          owner: { kind: "plugin", pluginId: declaration.pluginId },
          apiUrl: declaration.contribution.apiUrl,
        });
        registered.set(providerId, { declaration, dispose });
        changed = true;
      } catch (error) {
        const why = formatErrorMessage(error, "it was refused");
        console.warn(`[CloudHosts] Cloud provider ${providerId} wasn't registered: ${why}`);
        refused.set(providerId, {
          declaration,
          reason: `Its cloud provider comes from the ${declaration.pluginId} plugin, which declares it in a way Daintree can't use.`,
        });
      }
    }
    if (!changed) params.statusChanged();
  };

  const stopWatching = onPluginCloudProvidersChanged(sync);
  sync();
  return {
    unavailableReason: (providerId) =>
      refused.get(providerId)?.reason ?? pluginCloudProviderUnavailableReason(providerId),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      for (const entry of registered.values()) entry.dispose();
      registered.clear();
      refused.clear();
    },
  };
}
