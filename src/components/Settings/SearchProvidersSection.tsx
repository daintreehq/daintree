import { useEffect, useRef, useState } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { logError } from "@/utils/logger";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

const nameList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** A switch position the user asked for, and the request that carries it. */
interface PendingSwitch {
  shown: boolean;
  request: number;
}

const NO_PENDING: ReadonlyMap<string, PendingSwitch> = new Map();

/** `pending` without `key`'s entry, when that entry is still `request`'s. */
function settlePending(
  pending: ReadonlyMap<string, PendingSwitch>,
  key: string,
  request: number
): ReadonlyMap<string, PendingSwitch> {
  if (pending.get(key)?.request !== request) return pending;
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
  if (provider.keywordTakenBy !== undefined) {
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
  if (provider.shown) {
    const yieldedBy = [
      ...new Set(
        peers.filter((p) => !p.shown && p.keywordTakenBy === undefined).map((p) => p.pluginName)
      ),
    ];
    if (yieldedBy.length > 0) {
      sentences.push(
        `It has the keyword only while the ${nameList.format(yieldedBy)} ${yieldedBy.length === 1 ? "provider is" : "providers are"} switched off`
      );
    }
  }
  // One sentence goes without a period, several each take one (Settings copy).
  return sentences.join(". ") + (sentences.length > 1 ? "." : "");
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
  const [pending, setPending] = useState<ReadonlyMap<string, PendingSwitch>>(NO_PENDING);
  // The write main refused, kept as asked so Retry repeats it rather than the
  // value the list rolled back to.
  const [saveError, setSaveError] = useState<{ key: string; shown: boolean } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadSeq, setLoadSeq] = useState(0);
  // Every read and write is numbered as it is sent. Each answer is the whole
  // catalog as main saw it no earlier than the request arrived, so an answer
  // to an earlier request never replaces a later one's.
  const sentRef = useRef(0);
  const appliedRef = useRef(0);
  // Each row's latest write: only it may raise or clear the row's save error,
  // so an earlier write's late failure can't offer a Retry that undoes a later
  // choice.
  const latestWriteRef = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (!pluginId || typeof bridge?.getSearchProviders !== "function") return undefined;
    let live = true;
    const request = ++sentRef.current;
    bridge
      .getSearchProviders()
      .then((list) => {
        if (!live) return;
        setLoadFailed(false);
        if (request < appliedRef.current) return;
        appliedRef.current = request;
        setCatalog(list);
      })
      .catch((error: unknown) => {
        if (!live) return;
        logError("Failed to read search providers", error);
        // A later answer already stands; this read failing changes nothing.
        if (request < appliedRef.current) return;
        setLoadFailed(true);
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
    const bridge = window.electron?.plugin;
    if (typeof bridge?.setSearchProviderShown !== "function") return;
    const request = ++sentRef.current;
    latestWriteRef.current ??= new Map();
    const latestWrite = latestWriteRef.current;
    latestWrite.set(key, request);
    setPending((prev) => new Map(prev).set(key, { shown, request }));
    // A different choice supersedes the failed one, so its Retry goes; asking
    // again for the same one (Retry itself) keeps the button and its focus.
    setSaveError((prev) => (prev?.key === key && prev.shown !== shown ? null : prev));
    bridge
      .setSearchProviderShown(key, shown)
      .then((list) => {
        if (request > appliedRef.current) {
          appliedRef.current = request;
          setCatalog(list);
          setLoadFailed(false);
        }
        setPending((prev) => settlePending(prev, key, request));
        if (latestWrite.get(key) === request) {
          setSaveError((prev) => (prev?.key === key ? null : prev));
        }
      })
      .catch((error: unknown) => {
        logError("Failed to save a search provider choice", error);
        setPending((prev) => settlePending(prev, key, request));
        if (latestWrite.get(key) !== request) return;
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
            const shown = pending.get(provider.key)?.shown ?? provider.shown;
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
