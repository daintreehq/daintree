import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PluginSearchProviderInfo,
  PluginSearchQueryResponse,
  PluginSearchResultRow,
} from "@shared/types/plugin";
import { SEARCH_PROVIDER_DEBOUNCE_MS } from "@shared/config/pluginSearchProviders";
import { logWarn } from "@/utils/logger";

/** One plugin search result, carrying the provider it came from. */
export interface PluginSearchHit {
  /** `plugin:{provider key}:{result id}` — unique across providers. */
  id: string;
  providerKey: string;
  providerTitle: string;
  pluginId: string;
  pluginName: string;
  row: PluginSearchResultRow;
}

/** What the last scoped query came back as, for the switcher's empty states. */
export type PluginSearchStatus = "idle" | "loading" | "done" | "timeout" | "error";

/**
 * The hits for one `(scopeKey, query)` pair. A consumer shows them only while
 * that pair is still what the user is looking at, so a row from an earlier
 * query can never be the one Enter opens.
 */
export interface PluginSearchState {
  scopeKey: string | null;
  query: string;
  hits: readonly PluginSearchHit[];
  status: PluginSearchStatus;
}

export interface UsePluginSearchReturn {
  /** Providers the switcher may use: shown, and holding their keyword in this project. */
  providers: readonly PluginSearchProviderInfo[];
  state: PluginSearchState;
  /**
   * Ask for `(scopeKey, query)`. Invalidates whatever was showing at once,
   * cancels what is in flight, and asks the providers after the debounce:
   * the scoped provider alone, or every blending provider for a non-blank
   * unscoped query. A closed switcher asks nothing.
   */
  request: (
    open: boolean,
    scopeKey: string | null,
    query: string,
    providers: readonly PluginSearchProviderInfo[]
  ) => void;
}

const EMPTY_PROVIDERS: readonly PluginSearchProviderInfo[] = [];
const IDLE: PluginSearchState = { scopeKey: null, query: "", hits: [], status: "idle" };

function sameCatalog(
  a: readonly PluginSearchProviderInfo[],
  b: readonly PluginSearchProviderInfo[]
): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

function statusOf(response: PluginSearchQueryResponse): PluginSearchStatus {
  if (response.status === "ok") return "done";
  if (response.status === "timeout") return "timeout";
  return "error";
}

/**
 * Plugin search providers for the quick switcher (#13792). The catalog is
 * read each time the switcher opens — nothing is held or pushed while it is
 * closed — and queries go to main one provider per call, so a fast provider's
 * rows land without waiting for a slow one. Main enforces the deadline and
 * caps; this side owns the debounce and the staleness stamp.
 */
export function usePluginSearch(isOpen: boolean): UsePluginSearchReturn {
  const [providers, setProviders] = useState<readonly PluginSearchProviderInfo[]>(EMPTY_PROVIDERS);
  const [state, setState] = useState<PluginSearchState>(IDLE);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getSearchProviders !== "function") return undefined;
    let live = true;
    bridge
      .getSearchProviders()
      .then((list) => {
        if (!live) return;
        const usable = list.filter((p) => p.shown && p.keywordTakenBy === undefined);
        // The same catalog keeps its identity: a new array would restart the
        // query and wipe rows that already answered it.
        setProviders((prev) =>
          usable.length === 0 ? EMPTY_PROVIDERS : sameCatalog(prev, usable) ? prev : usable
        );
      })
      .catch((error: unknown) =>
        logWarn("[PluginSearch] Failed to read search providers", { error })
      );
    return () => {
      live = false;
    };
  }, [isOpen]);

  const cancelInFlight = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!inFlightRef.current) return;
    inFlightRef.current = false;
    void window.electron?.plugin?.cancelSearchProviders?.().catch(() => {});
  }, []);

  const request = useCallback<UsePluginSearchReturn["request"]>(
    (open, scopeKey, query, catalog) => {
      const seq = ++seqRef.current;
      cancelInFlight();
      // Whatever was showing answered another query, another scope or an
      // earlier opening; it goes now rather than when the next answer lands.
      setState((prev) => (prev === IDLE ? prev : IDLE));
      if (!open) return;
      const bridge = window.electron?.plugin;
      if (typeof bridge?.querySearchProvider !== "function") return;
      const targets = scopeKey
        ? catalog.filter((p) => p.key === scopeKey)
        : query.trim().length > 0
          ? catalog.filter((p) => p.blend)
          : [];
      if (targets.length === 0) return;
      const mode = scopeKey ? "scoped" : "blended";
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (seq !== seqRef.current) return;
        inFlightRef.current = true;
        setState({ scopeKey, query, hits: [], status: "loading" });
        let pending = targets.length;
        for (const provider of targets) {
          const settle = (response: PluginSearchQueryResponse) => {
            if (seq !== seqRef.current) return;
            pending -= 1;
            if (pending === 0) inFlightRef.current = false;
            const hits =
              response.status === "ok"
                ? response.results.map((row): PluginSearchHit => ({
                    id: `plugin:${provider.key}:${row.id}`,
                    providerKey: provider.key,
                    providerTitle: provider.title,
                    pluginId: provider.pluginId,
                    pluginName: provider.pluginName,
                    row,
                  }))
                : [];
            setState((prev) => {
              if (prev.scopeKey !== scopeKey || prev.query !== query) return prev;
              return {
                scopeKey,
                query,
                hits: hits.length > 0 ? [...prev.hits, ...hits] : prev.hits,
                // Only the scoped provider's outcome is reported; a blended
                // provider that failed just contributes nothing.
                status: pending > 0 ? "loading" : scopeKey ? statusOf(response) : "done",
              };
            });
          };
          bridge
            .querySearchProvider({ providerKey: provider.key, query, mode })
            .then(settle, (error: unknown) => {
              logWarn("[PluginSearch] Search provider query failed", { error });
              settle({ status: "error" });
            });
        }
      }, SEARCH_PROVIDER_DEBOUNCE_MS);
    },
    [cancelInFlight]
  );

  useEffect(() => cancelInFlight, [cancelInFlight]);

  return { providers, state, request };
}
