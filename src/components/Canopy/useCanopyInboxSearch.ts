import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CanopyItem } from "./canopyModel";
import { canopyScreenSearchPlan, canopySearchNotes, parseCanopySearch } from "./canopySearch";
import type { CanopyScreenSearch } from "./canopyHostSource";
import type { HostId } from "@shared/types/remoteHosts";

/** How long the search waits on the typing before reading terminals for it. */
const SCREEN_SEARCH_DEBOUNCE_MS = 150;

const NO_HITS: ReadonlySet<string> = new Set();
const NO_HOSTS: readonly HostId[] = [];

/** One ask's answer, host by host, and the hosts that couldn't search for it. */
interface ScreenHits {
  ask: string;
  hosts: ReadonlyMap<HostId, ReadonlySet<string>>;
  unsearched: readonly HostId[];
}

/**
 * The search over the inbox: the typed query, its alternatives, and the runs
 * whose terminals hold the words their names and readings leave unfound of
 * any one alternative, asked of the host each run is on.
 */
export function useCanopyInboxSearch({
  isOpen,
  hostId,
  items,
  searchScreens,
  refreshedAt,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  items: CanopyItem[];
  searchScreens: CanopyScreenSearch;
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
  const [screenHits, setScreenHits] = useState<ScreenHits | null>(null);
  // Asked again on Retry, the query and its targets as they stand.
  const [retries, setRetries] = useState(0);
  // Asked again as screens are read anew, since a terminal's words move on.
  useEffect(() => {
    if (!isOpen || screenAsk === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void searchScreens(screenTargetsRef.current).then((outcomes) => {
        if (!live) return;
        setScreenHits((prior) => {
          const earlier = prior?.ask === screenAsk ? prior.hosts : null;
          const hosts = new Map<HostId, ReadonlySet<string>>();
          const unsearched: HostId[] = [];
          for (const outcome of outcomes) {
            if ("runIds" in outcome) {
              hosts.set(outcome.hostId, new Set(outcome.runIds));
              continue;
            }
            // A host that couldn't search this time keeps what it found for the
            // very same ask, and is named for what it may be missing.
            unsearched.push(outcome.hostId);
            hosts.set(outcome.hostId, earlier?.get(outcome.hostId) ?? NO_HITS);
          }
          return { ask: screenAsk, hosts, unsearched };
        });
      });
    }, SCREEN_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [isOpen, screenAsk, searchScreens, refreshedAt, retries]);
  const current = screenHits !== null && screenHits.ask === screenAsk ? screenHits : null;
  const onScreen = useMemo(
    () =>
      current === null ? null : new Set([...current.hosts.values()].flatMap((ids) => [...ids])),
    [current]
  );
  const screenUnsearched = current?.unsearched ?? NO_HOSTS;
  const retryScreenSearch = () => setRetries((count) => count + 1);

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
    /** The hosts whose terminals the settled search couldn't read: its terminal matches are only the rest's. */
    screenUnsearched,
    retryScreenSearch,
  };
}
