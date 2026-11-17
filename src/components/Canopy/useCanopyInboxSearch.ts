import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CanopyItem } from "./canopyModel";
import { canopyScreenSearchPlan, canopySearchNotes, parseCanopySearch } from "./canopySearch";
import type { CanopyScreenSearch } from "./canopyHostSource";
import type { HostId } from "@shared/types/remoteHosts";

/** How long the search waits on the typing before reading terminals for it. */
const SCREEN_SEARCH_DEBOUNCE_MS = 150;

const NO_HITS: ReadonlySet<string> = new Set();
const NO_HOSTS: readonly HostId[] = [];

/**
 * What one host has said to an ask. Its newest answer says whether it could
 * search; its newest hits stand until a newer search finds others, so a host
 * that couldn't search this time keeps what it found, and an older answer
 * landing late never undoes a newer one.
 */
interface HostAnswer {
  hits: ReadonlySet<string>;
  /** When the search that found the hits was sent. */
  hitsAt: number;
  /** When the search behind its newest answer, hits or failure, was sent. */
  heardAt: number;
  failed: boolean;
}

/** One ask's answers, host by host. */
interface ScreenHits {
  ask: string;
  hosts: ReadonlyMap<HostId, HostAnswer>;
  heardAt: number;
  /** The Retry the newest answer was asked under: a Retry answered is said, even as it was before. */
  retry: number;
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
  // The rows' order is no part of it: a re-rank asks nothing new.
  const screenAsk = useMemo(
    () =>
      screenTargets.length === 0
        ? null
        : `${hostId ?? ""}|${JSON.stringify(
            [...screenTargets].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
          )}`,
    [screenTargets, hostId]
  );
  const screenTargetsRef = useRef(screenTargets);
  useEffect(() => {
    screenTargetsRef.current = screenTargets;
  });
  const [screenHits, setScreenHits] = useState<ScreenHits | null>(null);
  // Asked again on Retry, the query and its targets as they stand.
  const [retries, setRetries] = useState(0);
  // One ask on one host while the panel is open: a refresh of it lets the
  // search already in flight land, so a slow host's answer is never lost to a
  // busy one. A new query, host or close ends it, and what it was sent says nothing.
  const sessionRef = useRef<{ live: boolean } | null>(null);
  useEffect(() => {
    if (!isOpen || screenAsk === null) return;
    const session = { live: true };
    sessionRef.current = session;
    return () => {
      session.live = false;
    };
  }, [isOpen, screenAsk, searchScreens]);
  const sentRef = useRef(0);
  // Asked again as screens are read anew, since a terminal's words move on.
  useEffect(() => {
    if (!isOpen || screenAsk === null) return;
    const session = sessionRef.current;
    const retry = retries;
    const timer = setTimeout(() => {
      const sent = ++sentRef.current;
      void searchScreens(screenTargetsRef.current).then((outcomes) => {
        if (!session?.live) return;
        setScreenHits((prior) => {
          const same = prior?.ask === screenAsk ? prior : null;
          const hosts = new Map(same?.hosts ?? []);
          for (const outcome of outcomes) {
            const was = hosts.get(outcome.hostId);
            const newest = was === undefined || sent > was.heardAt;
            const found = "runIds" in outcome && (was === undefined || sent > was.hitsAt);
            hosts.set(outcome.hostId, {
              hits: found ? new Set(outcome.runIds) : (was?.hits ?? NO_HITS),
              hitsAt: found ? sent : (was?.hitsAt ?? 0),
              heardAt: newest ? sent : was.heardAt,
              failed: newest ? !("runIds" in outcome) : was.failed,
            });
          }
          const newest = same === null || sent > same.heardAt;
          return {
            ask: screenAsk,
            hosts,
            heardAt: newest ? sent : same.heardAt,
            retry: newest ? retry : same.retry,
          };
        });
      });
    }, SCREEN_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isOpen, screenAsk, searchScreens, refreshedAt, retries]);
  const current = screenHits !== null && screenHits.ask === screenAsk ? screenHits : null;
  const onScreen = useMemo(
    () =>
      current === null
        ? null
        : new Set([...current.hosts.values()].flatMap((answer) => [...answer.hits])),
    [current]
  );
  const screenUnsearched = useMemo(
    () =>
      current === null
        ? NO_HOSTS
        : [...current.hosts].filter(([, answer]) => answer.failed).map(([id]) => id),
    [current]
  );
  const screenRetry = current?.retry ?? 0;
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
    screenRetry,
    retryScreenSearch,
  };
}
