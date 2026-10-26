import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@shared/types";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { HostId } from "@shared/types/remoteHosts";
import { ALL_HOSTS_ID, useCanopyStore, type CanopyScope } from "@/store/canopyStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { pluralize } from "@/lib/pluralize";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { useAgentDirectory } from "@/hooks/useAgentDirectory";
import { useAssistantWork } from "@/hooks/useAssistantWork";
import type { HostMenuRow } from "@/components/Hosts/hostModel";
import { unmatchedTerms, type CanopyInbox, type CanopyItem } from "./canopyModel";
import {
  assistantMatches,
  buildAssistantItems,
  canopyAssistantId,
  type CanopyAssistantItem,
} from "./canopyAssistants";
import {
  hostsWithPartialWork,
  isWorkOf,
  workLinkLabel,
  workLinkOf,
  workLinksByRun,
} from "./canopyRelationships";
import { allHostsKey, parseAllHostsKey } from "./canopyAllHosts";
import type { CanopyApi } from "./canopyHostSource";
import { placeOf } from "./canopyInboxPlace";
import { isWorkerEntry, projectCanopyInbox } from "./canopyInboxProjection";
import { useListReorderMotion } from "./useListReorderMotion";
import { useCanopyRowsViewed } from "./useCanopyRowsViewed";
import { canopyCardDomId } from "./CanopyCard";

/**
 * What the inbox lists: the roles shown, the assistants and the work one of
 * them did, the Unread filter and the folded archive over the ordered runs,
 * and the search's matches among them. Says what is shown to main and to the
 * toolbar badge, and a search's outcome to the screen reader once it settles.
 */
export function useCanopyInboxFilters({
  isOpen,
  hostId,
  otherHost,
  everyHost,
  ownHostId,
  hostRows,
  hasHostPicker,
  participants,
  projects,
  storedScope,
  scope,
  setScope,
  api,
  recoveries,
  fleet,
  inbox,
  query,
  appliedQuery,
  terms,
  searching,
  searchKey,
  screenAsk,
  onScreen,
  listHidden,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  otherHost: boolean;
  everyHost: boolean;
  ownHostId: HostId;
  /** The hosts read together when `hostId` is All hosts. */
  hostRows: readonly HostMenuRow[] | null;
  /** The panel can move to another host: the host picker is shown. */
  hasHostPicker: boolean;
  participants: readonly HostId[];
  projects: Project[];
  storedScope: CanopyScope;
  scope: CanopyScope;
  setScope: (scope: CanopyScope) => void;
  api: CanopyApi;
  recoveries: number;
  fleet: FleetSnapshot | null;
  inbox: CanopyInbox;
  query: string;
  appliedQuery: string;
  terms: string[];
  searching: boolean;
  searchKey: string;
  screenAsk: string | null;
  onScreen: ReadonlySet<string> | null;
  listHidden: () => void;
}) {
  // Workers, Daintree Assistants or both. A role the filter hides keeps its
  // asks: nothing hidden is marked seen, and the Assistants choice counts them.
  const roleFilter = useCanopyStore((s) => s.roleFilter);
  const setRoleFilter = useCanopyStore((s) => s.setRoleFilter);
  const workersShown = roleFilter !== "assistants";
  const assistantsShown = roleFilter !== "workers";
  // Assistants come from this machine's own directory, never from the reader:
  // another host's can't be listed from here yet, and All hosts lists this one's.
  const assistantsReadable = !otherHost || everyHost;
  const directory = useAgentDirectory(isOpen && assistantsReadable);
  const handbacksSeen = useCanopyStore((s) => s.assistantHandbacksSeen);
  const seeAssistantHandback = useCanopyStore((s) => s.seeAssistantHandback);
  const ownHostName = everyHost
    ? ((hostRows ?? []).find((row) => row.hostId === ownHostId)?.name ?? "This Mac")
    : null;
  const assistantItems = useMemo(() => {
    if (!assistantsReadable) return [];
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return buildAssistantItems(directory, {
      projectName: (id) => {
        const name = names.get(id) ?? null;
        return name !== null && ownHostName !== null ? `${name} · ${ownHostName}` : name;
      },
      seen: handbacksSeen,
      projectId: scope === "project" ? getViewWorkspaceId() : null,
    });
  }, [assistantsReadable, directory, projects, ownHostName, handbacksSeen, scope]);
  const assistantAsks = assistantItems.filter((item) => item.ask !== null).length;
  // "Show its work" (#14166): the workers one assistant made or was handed,
  // from each host's own records of it. Every host shown is read, since an
  // assistant here starts workers on others too.
  const workOf = useCanopyStore((s) => s.workOf);
  const showWorkOf = useCanopyStore((s) => s.showWorkOf);
  const workHosts = useMemo(
    () =>
      everyHost ? (participants.length > 0 ? participants : [ownHostId]) : [hostId ?? ownHostId],
    [everyHost, participants, ownHostId, hostId]
  );
  // Read only while it has something to show: worker rows' links, or the filter.
  const workReadings = useAssistantWork(
    workHosts,
    ownHostId,
    isOpen && (workersShown || workOf !== null)
  );
  const workLinks = useMemo(
    () =>
      workLinksByRun(workReadings, everyHost ? allHostsKey : (_hostId, terminalId) => terminalId),
    [workReadings, everyHost]
  );
  const workPartial = workOf !== null && hostsWithPartialWork(workReadings, workHosts).length > 0;
  const assistantNames = useMemo(
    () =>
      new Map(assistantItems.map((item) => [item.id, `Daintree Assistant · ${item.scopeLabel}`])),
    [assistantItems]
  );
  const workLabelOf = (item: CanopyItem): string | null =>
    workLinkLabel(
      workLinkOf(item, workLinks),
      (subject) => assistantNames.get(canopyAssistantId(subject)) ?? null
    );
  const shownAssistants = useMemo(
    () =>
      !assistantsShown
        ? []
        : workOf !== null
          ? assistantItems.filter((item) => item.id === workOf.assistantId)
          : searching
            ? assistantItems.filter((item) => assistantMatches(item, terms))
            : assistantItems,
    [assistantsShown, workOf, searching, assistantItems, terms]
  );
  const showWork = (item: CanopyAssistantItem) => {
    if (workOf?.assistantId === item.id) {
      showWorkOf(null);
      useAnnouncerStore.getState().announce("Showing the whole inbox", "polite");
      return;
    }
    const name = `Daintree Assistant · ${item.scopeLabel}`;
    showWorkOf({ assistantId: item.id, name });
    useAnnouncerStore.getState().announce(`Showing the work of ${name}`, "polite");
    // Its workers can be anywhere it reaches: every project, and every host when there are others.
    if (roleFilter === "assistants") setRoleFilter("all");
    if (storedScope === "project") setScope("all");
    if (!everyHost && hasHostPicker) useCanopyStore.getState().setHostId(ALL_HOSTS_ID);
  };
  const inWork = useCallback(
    (item: CanopyItem) =>
      workOf === null || isWorkOf(workLinkOf(item, workLinks), workOf.assistantId),
    [workOf, workLinks]
  );
  const shownInbox = useMemo(() => {
    if (!workersShown) return { inbox: [], archived: [] };
    if (!searching && workOf === null) return inbox;
    const matches = (item: CanopyItem) =>
      inWork(item) &&
      (!searching ||
        onScreen?.has(item.runId) === true ||
        unmatchedTerms(item, terms).length === 0);
    return { inbox: inbox.inbox.filter(matches), archived: inbox.archived.filter(matches) };
  }, [inbox, workersShown, searching, onScreen, terms, workOf, inWork]);
  const unreadOnly = useCanopyStore((s) => s.unreadOnly);
  const setUnreadOnly = useCanopyStore((s) => s.setUnreadOnly);
  // A run read while the Unread filter is on stays listed until the filter is
  // turned off — or the panel closes, or shows another scope: reading the row
  // in front of you must not pull it out from under you, nor shift every row
  // beneath it, but a fresh look starts from what is unread now.
  const [keptUnread, setKeptUnread] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setKeptUnread((kept) => (kept.size === 0 ? kept : new Set()));
  }, [isOpen, scope, hostId]);
  useEffect(() => {
    setKeptUnread((kept) => {
      if (!unreadOnly) return kept.size === 0 ? kept : new Set();
      const added = inbox.inbox.filter((item) => item.unread && !kept.has(item.runId));
      return added.length === 0 ? kept : new Set([...kept, ...added.map((item) => item.runId)]);
    });
  }, [unreadOnly, inbox]);
  // The inbox as listed: every run in it, or with the filter on, the unread.
  const listed = useMemo(
    () =>
      unreadOnly
        ? shownInbox.inbox.filter((item) => item.unread || keptUnread.has(item.runId))
        : shownInbox.inbox,
    [unreadOnly, shownInbox, keptUnread]
  );
  const archivedExpanded = useCanopyStore((s) => s.archivedExpanded);
  const setArchivedExpanded = useCanopyStore((s) => s.setArchivedExpanded);
  // A search finds archived runs too, shown under their bar without unfolding it for good.
  const archivedShown = archivedExpanded || searching;
  // What the keyboard walks: the list, then the archived runs once they are shown.
  const visible = useMemo(
    () => [...listed, ...(archivedShown ? shownInbox.archived : [])],
    [listed, shownInbox, archivedShown]
  );
  // Workers and assistants as one inbox: what needs the user, and the order
  // the keyboard walks.
  const projection = useMemo(
    () =>
      projectCanopyInbox({
        ownHostId,
        workers: inbox.inbox,
        assistants: assistantItems,
        listedWorkers: listed,
        shownAssistants,
        shownArchived: archivedShown ? shownInbox.archived : [],
        workerPlace: (item) => placeOf(item, hostId, ownHostId),
      }),
    [ownHostId, hostId, inbox, assistantItems, listed, shownAssistants, archivedShown, shownInbox]
  );
  // Moving on after an answer stays among the workers until assistants rank with them (#14519).
  const workerNavigation = useMemo(() => projection.navigation.filter(isWorkerEntry), [projection]);
  // An urgent prompt counts as seen once its row has been in view for a second
  // in the focused, open panel, or its pane is opened: a row below the fold
  // nobody scrolled to keeps its ask on the badge. Runs another scope or the
  // Unread filter hides stay on it too.
  const acknowledge = useCanopyStore((s) => s.acknowledge);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewable = isOpen && (everyHost || !otherHost) && !isProjectViewCached();
  const rowsKey = visible.map((item) => item.runId).join(" ");
  // Opening a run's pane is looking at its ask, whether or not the row was in view.
  const acknowledgeOpened = useCallback(
    (runId: string) => {
      if (!isOpen || isProjectViewCached()) return;
      if (everyHost) {
        const run = parseAllHostsKey(runId);
        if (run?.hostId === ownHostId) acknowledge([run.id]);
      } else if (!otherHost) acknowledge([runId]);
    },
    [isOpen, otherHost, everyHost, ownHostId, acknowledge]
  );
  const viewedRuns = useCanopyRowsViewed(
    scrollerRef,
    viewable,
    rowsKey,
    `${listed.length}`,
    canopyCardDomId,
    acknowledgeOpened
  );
  // Before paint, so a close in the same moment can't lose a look already taken.
  useLayoutEffect(() => {
    // A view nobody can see acknowledges nothing, for the moment before it
    // closes; and the badge counts the window's own host, never another's runs.
    if (!isOpen || isProjectViewCached()) return;
    const seen = visible.filter((item) => viewedRuns.has(item.runId));
    if (everyHost) {
      // Only the asks this host's rows show: another host's run is never one of them.
      const own = seen.flatMap((item) => {
        const run = parseAllHostsKey(item.runId);
        return run?.hostId === ownHostId ? [run.id] : [];
      });
      if (own.length > 0) acknowledge(own);
      return;
    }
    if (otherHost || seen.length === 0) return;
    acknowledge(seen.map((item) => item.runId));
  }, [isOpen, otherHost, everyHost, ownHostId, visible, viewedRuns, acknowledge]);
  // Main holds a native page back only for an ask the panel shows: told the
  // rows as listed, filters included, whenever they change — and told again
  // when another host's link comes back, having dropped what it was told.
  const shownKey = isOpen ? visible.map((item) => item.runId).join(" ") : null;
  useEffect(() => {
    if (shownKey === null) return;
    safeFireAndForget(api.setShown(shownKey === "" ? [] : shownKey.split(" ")));
  }, [shownKey, api, recoveries]);
  const listRef = useRef<HTMLDivElement>(null);
  // A search narrows the list, and a terminal's matches landing widen it: neither is a move.
  const filterKey = searching ? `${searchKey}|${[...(onScreen ?? [])].join(" ")}` : "";
  useListReorderMotion(listRef, listed.map((item) => item.runId).join(" "), filterKey);
  // A list unmounted under the pointer never says the pointer left.
  const listShown = listed.length > 0;
  useEffect(() => {
    if (!listShown) listHidden();
  }, [listShown, listHidden]);

  // The search found runs, but only read ones the Unread filter hides: every
  // place that says why the list is empty says that, not "no match".
  const onlyReadMatch = searching && visible.length === 0 && shownInbox.inbox.length > 0;
  // A search's outcome is said once, when it settles: the runs are in, the
  // terminals have answered and the typing has stopped. Never per keystroke,
  // and never again for a match a terminal adds later.
  const searchSettled = fleet !== null && (screenAsk === null || onScreen !== null);
  const outcome =
    !searching || !searchSettled
      ? null
      : visible.length > 0
        ? pluralize(visible.length, "match", "matches")
        : onlyReadMatch
          ? "No unread matches"
          : "No matches";
  const announceKey = `${searchKey}|${unreadOnly}`;
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searching) {
      announcedRef.current = null;
      return;
    }
    if (outcome === null || query !== appliedQuery || announcedRef.current === announceKey) return;
    const timer = window.setTimeout(() => {
      announcedRef.current = announceKey;
      useAnnouncerStore.getState().announce(outcome, "polite");
    }, UI_DOHERTY_THRESHOLD);
    return () => window.clearTimeout(timer);
  }, [searching, outcome, announceKey, query, appliedQuery]);

  return {
    roleFilter,
    setRoleFilter,
    workersShown,
    assistantsShown,
    assistantsReadable,
    directory,
    seeAssistantHandback,
    assistantItems,
    assistantAsks,
    workOf,
    showWorkOf,
    workPartial,
    workLabelOf,
    shownAssistants,
    showWork,
    inWork,
    shownInbox,
    unreadOnly,
    setUnreadOnly,
    listed,
    archivedExpanded,
    setArchivedExpanded,
    archivedShown,
    visible,
    projection,
    workerNavigation,
    listRef,
    scrollerRef,
    acknowledgeOpened,
    onlyReadMatch,
  };
}
