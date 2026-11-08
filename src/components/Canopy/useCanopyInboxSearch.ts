import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CanopyItem } from "./canopyModel";
import { canopyScreenSearchPlan, canopySearchNotes, parseCanopySearch } from "./canopySearch";
import type { CanopyApi } from "./canopyHostSource";
import type { HostId } from "@shared/types/remoteHosts";

/** How long the search waits on the typing before reading terminals for it. */
const SCREEN_SEARCH_DEBOUNCE_MS = 150;

/**
 * The search over the inbox: the typed query, its alternatives, and the runs
 * whose terminals hold the words their names and readings leave unfound of
 * any one alternative, asked of the host each run is on.
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
  // hold every word of any one of its alternatives. Typed straight into, it
  // never reaches a row's keys.
  const [query, setQuery] = useState("");
  const appliedQuery = useDeferredValue(query);
  const { alternatives, dropped } = useMemo(() => parseCanopySearch(appliedQuery), [appliedQuery]);
  const searching = alternatives.length > 0;
  // Neither a comma nor a space is ever inside a word, so no two searches share a key.
  const searchKey = `${hostId ?? ""}|${alternatives.map((words) => words.join(" ")).join(",")}`;
  // The words of each alternative a run's names and words leave unfound,
  // asked of its terminal on the host it runs on: only ids come back. What
  // the ask can't carry is said under the field rather than dropped unsaid.
  const plan = useMemo(() => canopyScreenSearchPlan(items, alternatives), [items, alternatives]);
  const screenTargets = plan.targets;
  const searchNotes = useMemo(
    () => canopySearchNotes(alternatives, dropped, plan),
    [alternatives, dropped, plan]
  );
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

  return {
    query,
    setQuery,
    appliedQuery,
    alternatives,
    searchNotes,
    searching,
    searchKey,
    screenAsk,
    onScreen,
  };
}
