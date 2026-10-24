import { useEffect } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { usePluginContextProvidersStore } from "@/store/pluginContextProvidersStore";
import type { ContextProviderEntry } from "@shared/types/pluginContextProvider";

/** One plugin's `@` context providers in this project, as its settings row shows them. */
interface ContextProviderPlugin {
  pluginId: string;
  pluginName: string;
  scope: ContextProviderEntry["scope"];
  providers: ContextProviderEntry[];
}

function groupContextProviders(entries: readonly ContextProviderEntry[]): ContextProviderPlugin[] {
  const plugins = new Map<string, ContextProviderPlugin>();
  for (const entry of entries) {
    const plugin = plugins.get(entry.pluginId);
    if (plugin) plugin.providers.push(entry);
    else {
      plugins.set(entry.pluginId, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
        scope: entry.scope,
        providers: [entry],
      });
    }
  }
  return [...plugins.values()];
}

/**
 * The plugins offering `@` context in this project's agent composer (#13795),
 * one switch each for all of a plugin's providers. An installed plugin's
 * switch is the same in every project; a project plugin's is this project's.
 * A prefix another plugin already holds is named here, since this is where
 * turning that plugin off hands it over.
 */
export function ContextProvidersSection() {
  const entries = usePluginContextProvidersStore((s) => s.entries);
  const saveError = usePluginContextProvidersStore((s) => s.saveError);
  const setEnabled = usePluginContextProvidersStore((s) => s.setEnabled);

  useEffect(() => {
    const store = usePluginContextProvidersStore.getState();
    store.init();
    store.refresh();
  }, []);

  const plugins = groupContextProviders(entries);
  if (plugins.length === 0) return null;

  return (
    <div data-testid="project-plugins-context-providers">
      <SettingsSection
        title="Context providers"
        description="What plugins offer in the agent input bar's @ menu, attached when you send"
      >
        <SettingsGroup>
          {plugins.map(({ pluginId, pluginName, scope, providers }) => {
            const on = providers.some((p) => p.status !== "off");
            const offered = providers.map((p) => `@${p.prefix}: ${p.label}`).join(", ");
            return (
              <SettingsRow
                key={pluginId}
                label={pluginName}
                rootAttributes={{ "data-testid": `context-provider-row-${pluginId}` }}
                description={
                  <>
                    <span className="block">
                      {`${offered} · ${scope === "global" ? "Applies to every project" : "Applies to this project"}`}
                    </span>
                    {providers.map((p) =>
                      p.status === "refused" && p.heldBy ? (
                        <span key={p.providerId} className="block">
                          {`@${p.prefix}: isn't offered: ${p.heldBy.pluginName} already provides it`}
                        </span>
                      ) : null
                    )}
                  </>
                }
                isModified={!on}
                onReset={() => void setEnabled(pluginId, true)}
                resetAriaLabel={`Reset ${pluginName}'s context providers`}
                resetTestId={`context-provider-reset-${pluginId}`}
                error={
                  saveError?.pluginId === pluginId ? (
                    <RowFailure
                      summary={`Couldn't save whether ${pluginName} offers context`}
                      onRetry={() => void setEnabled(pluginId, saveError.enabled)}
                    />
                  ) : undefined
                }
                control={({ descriptionId }) => (
                  <SettingsSwitch
                    checked={on}
                    onCheckedChange={(next) => void setEnabled(pluginId, next)}
                    aria-label={`Offer ${pluginName}'s context in the input bar`}
                    aria-describedby={descriptionId}
                    data-testid={`context-provider-switch-${pluginId}`}
                  />
                )}
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
