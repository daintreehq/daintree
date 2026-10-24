import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CanopyScreenSearchTarget } from "@shared/types/ipc/canopy";
import { searchTerms, unmatchedTerms, type CanopyItem } from "./canopyModel";
import type { CanopyApi } from "./canopyHostSource";
import type { HostId } from "@shared/types/remoteHosts";

/** How long the search waits on the typing before reading terminals for it. */
const SCREEN_SEARCH_DEBOUNCE_MS = 150;
/** The most runs, words and word length one search asks of the terminals: main's own caps. */
const SCREEN_SEARCH_MAX_RUNS = 500;
const SCREEN_SEARCH_MAX_TERMS = 16;
const SCREEN_SEARCH_MAX_TERM_LENGTH = 200;

/**
 * The search over the inbox: the typed query, its words, and the runs whose
 * terminals hold the words their names and readings leave unfound, asked of
 * the host each run is on.
 */
export function useCanopyInboxSearch({
  isOpen,
  hostId,
  items,
  api,
  refreshedAt,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  items: CanopyItem[];
  api: CanopyApi;
  refreshedAt: number | null;
}) {
  // The search the panel opens on: the runs whose names, words or terminal
  // hold every word of it. Typed straight into, it never reaches a row's keys.
  const [query, setQuery] = useState("");
  const appliedQuery = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(appliedQuery), [appliedQuery]);
  const searching = terms.length > 0;
  const searchKey = `${hostId ?? ""}|${terms.join(" ")}`;
  // The words each run's names and words leave unfound, asked of its terminal
  // on the host it runs on: only ids come back. A run with more words left
  // than main takes is not asked, rather than the whole ask refused.
  const screenTargets = useMemo(() => {
    const targets: CanopyScreenSearchTarget[] = [];
    if (terms.length === 0) return targets;
    for (const item of items) {
      const left = unmatchedTerms(item, terms);
      if (
        left.length === 0 ||
        left.length > SCREEN_SEARCH_MAX_TERMS ||
        left.some((term) => term.length > SCREEN_SEARCH_MAX_TERM_LENGTH)
      ) {
        continue;
      }
      targets.push({ runId: item.runId, spawnedAt: item.row.run.spawnedAt, terms: left });
      if (targets.length === SCREEN_SEARCH_MAX_RUNS) break;
    }
    return targets;
  }, [items, terms]);
  // The ask as a value: a terminal's matches stand only for the very runs,
  // incarnations and words they were found for, on the host that found them.
  const screenAsk = useMemo(
    () => (screenTargets.length === 0 ? null : `${hostId ?? ""}|${JSON.stringify(screenTargets)}`),
    [screenTargets, hostId]
  );
  const screenTargetsRef = useRef(screenTargets);
  useEffect(() => {
    screenTargetsRef.current = screenTargets;
  });
  const [screenHits, setScreenHits] = useState<{
    ask: string;
    runIds: ReadonlySet<string>;
  } | null>(null);
  // Asked again as screens are read anew, since a terminal's words move on.
  useEffect(() => {
    if (!isOpen || screenAsk === null) return;
    let live = true;
    const timer = setTimeout(() => {
      api.searchScreens(screenTargetsRef.current).then(
        (runIds) => {
          if (live) setScreenHits({ ask: screenAsk, runIds: new Set(runIds) });
        },
        // A host that can't search its screens still matches what the panel
        // holds, and its search has still settled.
        () => {
          if (!live) return;
          setScreenHits((hits) =>
            hits?.ask === screenAsk ? hits : { ask: screenAsk, runIds: new Set() }
          );
        }
      );
    }, SCREEN_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, screenAsk, api, refreshedAt]);
  const onScreen = screenHits !== null && screenHits.ask === screenAsk ? screenHits.runIds : null;

  return { query, setQuery, appliedQuery, terms, searching, searchKey, screenAsk, onScreen };
}
