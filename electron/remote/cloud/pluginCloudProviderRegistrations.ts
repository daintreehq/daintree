import type {
  CloudPluginProviderLabel,
  CloudProviderId,
} from "../../../shared/types/cloudHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  getPluginCloudProviderRuntime,
  listPluginCloudProviders,
  onPluginCloudProvidersChanged,
  pluginCloudProviderBinding,
  pluginCloudProviderUnavailableReason,
  type PluginCloudProviderDeclaration,
} from "../../services/plugin/pluginCloudProviders.js";
import { canonicalCloudOrigin } from "../../services/plugin/pluginCloudProviderConsent.js";
import type { PluginConsentSubject } from "./CloudAccountService.js";
import type { CloudProviderRegistry } from "./CloudProviderRegistry.js";
import { PluginCloudProvider, type PluginCloudProviderHost } from "./PluginCloudProvider.js";

export interface PluginCloudProviderRegistrations {
  /** Why a plugin's provider isn't registered, or null for an id that isn't a plugin's. */
  unavailableReason(providerId: CloudProviderId): string | null;
  /** What the person agrees to before a registered plugin provider gets credentials; null when it isn't registered. */
  consentSubject(providerId: CloudProviderId): PluginConsentSubject | null;
  /** What a registered plugin provider is called and where its console is; null when it isn't registered. */
  label(providerId: CloudProviderId): CloudPluginProviderLabel | null;
  dispose(): void;
}

const LIVE_HOST: PluginCloudProviderHost = {
  runtime: getPluginCloudProviderRuntime,
  binding: pluginCloudProviderBinding,
};

/**
 * Keeps `providers` holding one provider per cloud provider a loaded plugin
 * declares (#17351): registered when the plugin loads, gone when it unloads
 * or its worker fails to start, and replaced when a reload changes the
 * declaration. Accounts and hosts of a provider that isn't registered stay,
 * read as unavailable with the reason. `statusChanged` hears a change that
 * registered nothing but may have changed a reason.
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
  /** Declarations whose plugin failed to start this session, with why; gone when it starts. */
  const failing = new Map<CloudProviderId, string>();
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const current = new Map(
      listPluginCloudProviders().map((declaration) => [declaration.providerId, declaration])
    );
    const runtime = host.runtime();
    failing.clear();
    for (const declaration of current.values()) {
      const failure = runtime?.startFailure(declaration.pluginId) ?? null;
      if (failure !== null) {
        failing.set(
          declaration.providerId,
          `Its cloud provider comes from the ${declaration.pluginId} plugin, which failed to start: ${failure}`
        );
      }
    }
    let changed = false;
    for (const [providerId, entry] of [...registered]) {
      if (current.get(providerId) === entry.declaration && !failing.has(providerId)) continue;
      registered.delete(providerId);
      entry.dispose();
      changed = true;
    }
    for (const [providerId, entry] of [...refused]) {
      if (current.get(providerId) !== entry.declaration) refused.delete(providerId);
    }
    for (const declaration of current.values()) {
      const { providerId } = declaration;
      if (registered.has(providerId) || refused.has(providerId) || failing.has(providerId))
        continue;
      // Recorded first: the registry tells its listeners from inside register(), and they ask for the label.
      const entry = { declaration, dispose: () => {} };
      registered.set(providerId, entry);
      try {
        entry.dispose = params.providers.register(new PluginCloudProvider(declaration, host), {
          owner: { kind: "plugin", pluginId: declaration.pluginId },
          apiUrl: canonicalCloudOrigin(declaration.contribution.apiUrl),
        });
        changed = true;
      } catch (error) {
        registered.delete(providerId);
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
      refused.get(providerId)?.reason ??
      failing.get(providerId) ??
      pluginCloudProviderUnavailableReason(providerId),
    // From the published declarations, never `registered`: registering wakes the lifecycle
    // before `registered` holds the entry, and that wake must already see the consent.
    consentSubject: (providerId) => {
      const declaration = listPluginCloudProviders().find(
        (entry) => entry.providerId === providerId
      );
      if (!declaration) return null;
      return {
        pluginId: declaration.pluginId,
        pluginName: declaration.pluginName,
        fingerprint: declaration.consentFingerprint,
        // Every provider the agreement covers, registered or not: the fingerprint hashes them all.
        providerNames: listPluginCloudProviders()
          .filter(
            (entry) =>
              entry.pluginId === declaration.pluginId &&
              entry.consentFingerprint === declaration.consentFingerprint
          )
          .map((entry) => entry.contribution.name),
      };
    },
    label(providerId) {
      const entry = registered.get(providerId);
      if (!entry) return null;
      const { pluginName, contribution } = entry.declaration;
      return {
        pluginName,
        providerName: contribution.name,
        dashboardUrl: contribution.dashboardUrl,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      for (const entry of registered.values()) entry.dispose();
      registered.clear();
      refused.clear();
      failing.clear();
    },
  };
}
