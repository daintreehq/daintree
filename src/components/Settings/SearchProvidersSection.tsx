import { useEffect, useState } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { logError } from "@/utils/logger";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

const nameList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const NO_PENDING: ReadonlyMap<string, boolean> = new Map();

function withoutPending(
  pending: ReadonlyMap<string, boolean>,
  key: string,
  shown: boolean
): ReadonlyMap<string, boolean> {
  if (pending.get(key) !== shown) return pending;
  const next = new Map(pending);
  next.delete(key);
  return next;
}

/**
 * What a provider's row says, from main's confirmed catalog of the project's
 * providers: how to use it, or who answers its keyword instead. Main gives a
 * keyword to the earliest provider the user left shown (#17510), so a
 * switched-off peer with no `keywordTakenBy` is one that takes it back once on.
 */
function describeProvider(
  provider: PluginSearchProviderInfo,
  catalog: readonly PluginSearchProviderInfo[]
): string {
  const keyword = provider.keyword;
  if (provider.keywordTakenBy) {
    return `Its keyword "${keyword}" is taken by ${provider.keywordTakenBy}, so the quick switcher leaves it out`;
  }
  const peers = catalog.filter((p) => p.key !== provider.key && p.keyword === keyword);
  if (!provider.shown) {
    const owner = peers.find((p) => p.shown && p.keywordTakenBy === undefined);
    if (owner) {
      return `While it's off, its keyword "${keyword}" goes to ${owner.pluginName}. Turning it on takes it back.`;
    }
  }
  const sentences = [`Type "${keyword}" then Tab to search it`];
  if (provider.blend) sentences.push("Also adds a few results to every search");
  const yieldedBy = [
    ...new Set(
      peers.filter((p) => !p.shown && p.keywordTakenBy === undefined).map((p) => p.pluginName)
    ),
  ];
  if (provider.shown && yieldedBy.length > 0) {
    sentences.push(
      `It has the keyword only while ${nameList.format(yieldedBy)} ${yieldedBy.length === 1 ? "is" : "are"} switched off`
    );
  }
  // One sentence goes without a period, several each take one (Settings copy).
  return sentences.length === 1 ? sentences[0] : `${sentences.join(". ")}.`;
}

/**
 * One plugin's quick switcher search providers (#13792), each with its "Show
 * in quick switcher" switch. An installed plugin's choice holds in every
 * project; a project plugin's only in this one. A provider that shares its
 * keyword with another plugin's says which of them answers it and why.
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
  // Every provider the project sees, as main last said: rows sharing a keyword
  // explain each other.
  const [catalog, setCatalog] = useState<readonly PluginSearchProviderInfo[]>([]);
  // Switch positions main hasn't answered yet. The switch moves at once; what
  // the rows say waits for main, which decides who holds each keyword.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(NO_PENDING);
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
        setCatalog(list);
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

  const providers = catalog.filter((provider) => provider.pluginId === pluginId);
  if (!pluginId || (providers.length === 0 && !loadFailed)) return null;

  // Optimistic, so the switch responds in the same render; main's answer then
  // replaces the catalog, and a refused write puts the switch back and reads
  // the catalog again.
  const setShown = (key: string, shown: boolean) => {
    setPending((prev) => new Map(prev).set(key, shown));
    const bridge = window.electron?.plugin;
    if (typeof bridge?.setSearchProviderShown !== "function") return;
    bridge
      .setSearchProviderShown(key, shown)
      .then((list) => {
        setCatalog(list);
        setPending((prev) => withoutPending(prev, key, shown));
        setSaveError(null);
      })
      .catch((error: unknown) => {
        logError("Failed to save a search provider choice", error);
        setPending((prev) => withoutPending(prev, key, shown));
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
          providers.map((provider) => {
            const shown = pending.get(provider.key) ?? provider.shown;
            return (
              <SettingsRow
                key={provider.key}
                label={provider.title}
                description={describeProvider(provider, catalog)}
                rootAttributes={{ "data-testid": `search-provider-${provider.key}` }}
                isModified={!shown}
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
                    checked={shown}
                    onCheckedChange={(next) => setShown(provider.key, next)}
                    aria-label={`Show ${provider.title} in quick switcher`}
                    aria-describedby={descriptionId}
                    data-testid={`search-provider-switch-${provider.key}`}
                  />
                )}
              />
            );
          })
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
