import { useEffect, useState } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { logError } from "@/utils/logger";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

/**
 * One plugin's quick switcher search providers (#13792), each with its "Show
 * in quick switcher" switch. An installed plugin's choice holds in every
 * project; a project plugin's only in this one. A provider another plugin's
 * keyword shadows is listed with why it never appears.
 */
export function SearchProvidersSection({
  pluginId,
  scope,
  refreshKey,
}: {
  pluginId: string | undefined;
  scope: "installed" | "project";
  /** Changes when the plugin starts, stops or is shown or hidden here, so the list is read again. */
  refreshKey: string;
}) {
  const [providers, setProviders] = useState<readonly PluginSearchProviderInfo[]>([]);
  // The write main refused, kept as asked so Retry repeats it rather than the
  // value the list rolled back to.
  const [saveError, setSaveError] = useState<{ key: string; shown: boolean } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (!pluginId || typeof bridge?.getSearchProviders !== "function") return undefined;
    let live = true;
    bridge
      .getSearchProviders()
      .then((list) => {
        if (!live) return;
        setProviders(list.filter((provider) => provider.pluginId === pluginId));
        setLoadFailed(false);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoadFailed(true);
        logError("Failed to read search providers", error);
      });
    return () => {
      live = false;
    };
  }, [pluginId, loadSeq, refreshKey]);

  if (!pluginId || (providers.length === 0 && !loadFailed)) return null;

  // Optimistic, so the switch responds in the same render; main's answer then
  // replaces the list, and a refused write is undone by reading it back.
  const setShown = (key: string, shown: boolean) => {
    setProviders((prev) => prev.map((p) => (p.key === key ? { ...p, shown } : p)));
    const bridge = window.electron?.plugin;
    if (typeof bridge?.setSearchProviderShown !== "function") return;
    bridge
      .setSearchProviderShown(key, shown)
      .then((list) => {
        setProviders(list.filter((provider) => provider.pluginId === pluginId));
        setSaveError(null);
      })
      .catch((error: unknown) => {
        logError("Failed to save a search provider choice", error);
        setSaveError({ key, shown });
        setLoadSeq((seq) => seq + 1);
      });
  };

  return (
    <SettingsSection
      title="Quick switcher"
      description={
        scope === "installed"
          ? "Search providers it adds to the quick switcher. Turning one off applies in every project."
          : "Search providers it adds to the quick switcher in this project"
      }
    >
      <SettingsGroup>
        {loadFailed && providers.length === 0 ? (
          <SettingsRow
            label="Search providers"
            error={
              <RowFailure
                summary="Couldn't read this plugin's search providers"
                onRetry={() => setLoadSeq((seq) => seq + 1)}
              />
            }
          />
        ) : (
          providers.map((provider) => (
            <SettingsRow
              key={provider.key}
              label={provider.title}
              description={
                provider.keywordTakenBy
                  ? `Its keyword "${provider.keyword}" is taken by ${provider.keywordTakenBy}, so the quick switcher leaves it out`
                  : provider.blend
                    ? `Type "${provider.keyword}" then Tab to search it. Also adds a few results to every search.`
                    : `Type "${provider.keyword}" then Tab to search it`
              }
              rootAttributes={{ "data-testid": `search-provider-${provider.key}` }}
              isModified={!provider.shown}
              onReset={() => setShown(provider.key, true)}
              resetAriaLabel={`Reset ${provider.title}`}
              error={
                saveError?.key === provider.key ? (
                  <RowFailure
                    summary={`Couldn't save whether ${provider.title} shows in the quick switcher`}
                    onRetry={() => setShown(provider.key, saveError.shown)}
                  />
                ) : undefined
              }
              control={({ descriptionId }) => (
                <SettingsSwitch
                  checked={provider.shown}
                  onCheckedChange={(next) => setShown(provider.key, next)}
                  aria-label={`Show ${provider.title} in quick switcher`}
                  aria-describedby={descriptionId}
                  data-testid={`search-provider-switch-${provider.key}`}
                />
              )}
            />
          ))
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
