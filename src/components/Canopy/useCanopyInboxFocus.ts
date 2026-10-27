import { useCallback, useEffect, useRef, useState } from "react";
import type { HostId } from "@shared/types/remoteHosts";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import type { CanopyItem } from "./canopyModel";
import { nextAfterEntry, type CanopyWorkerEntry } from "./canopyInboxProjection";
import { canopyCardDomId, type CanopyCardHandle, type CanopyPaneFocus } from "./CanopyCard";
import type { CanopyAssistantItem, CanopyRoleFilter } from "./canopyAssistants";
import { canopyAssistantDomId, openAssistantItem } from "./openAssistantItem";
import { placeOf } from "./canopyInboxPlace";
import { canopyResumeTarget, type CanopyResume } from "./canopyResume";
import { useCanopyStore } from "@/store/canopyStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatTypingLocatorMessage, useTypingLocatorStore } from "@/store/typingLocatorStore";

/** How long a row asked for waits on its host's runs before it is taken as not there. */
const REPLY_REVEAL_WAIT_MS = 10_000;

/** The dictation keeps writing to the reply's draft: only going there failed. */
function reportReplyHidden(why: string): void {
  const message = { kind: "draft-refused" as const, lead: `The reply you're dictating ${why}` };
  useTypingLocatorStore.getState().showLocator(message);
  useAnnouncerStore.getState().announce(formatTypingLocatorMessage(message), "polite");
}

/**
 * Where the keyboard and the pane are: the run or assistant selected, the
 * landing on open, the recovery when a selected run leaves, the search's top
 * match, and the look the pane's run gets while it shows. Each host's list
 * starts afresh. What an answer settling later needs to know — whether this
 * panel still shows its host and run — is asked here, not read off its refs.
 */
export function useCanopyInboxFocus({
  isOpen,
  close,
  hostId,
  ownHostId,
  otherHost,
  everyHost,
  items,
  loaded,
  listed,
  visible,
  workerNavigation,
  workersShown,
  shownAssistants,
  firstAssistant,
  inWork,
  searching,
  query,
  appliedQuery,
  setQuery,
  roleFilter,
  seeAssistantHandback,
}: {
  isOpen: boolean;
  close: () => void;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  ownHostId: HostId;
  otherHost: boolean;
  everyHost: boolean;
  items: CanopyItem[];
  /** The host's runs have arrived: a run not among them now isn't there. */
  loaded: boolean;
  listed: CanopyItem[];
  visible: CanopyItem[];
  /** The workers the keyboard walks, as the inbox projection orders them. */
  workerNavigation: CanopyWorkerEntry[];
  workersShown: boolean;
  shownAssistants: CanopyAssistantItem[];
  /** The assistant at the very top of the keyboard's order, when no worker is above it. */
  firstAssistant: CanopyAssistantItem | null;
  inWork: (item: CanopyItem) => boolean;
  searching: boolean;
  query: string;
  appliedQuery: string;
  setQuery: (query: string) => void;
  roleFilter: CanopyRoleFilter;
  seeAssistantHandback: (assistantId: string, observedAt: number) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [assistantRefusal, setAssistantRefusal] = useState<{ id: string; text: string } | null>(
    null
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Where the keyboard goes in the next agent's pane, for the run it was meant for.
  const [paneFocus, setPaneFocus] = useState<{ runId: string; focus: CanopyPaneFocus } | null>(
    null
  );
  const focusedIndex = visible.findIndex((item) => item.runId === focusedId);
  const activeIndex = focusedIndex === -1 ? 0 : focusedIndex;
  // Nothing is open until a run is chosen or landed on; before that the pane
  // shows the list's first run. A chosen run stays open when it moves into the
  // folded Archived group, so the pane never vanishes under the user's typing.
  // While searching, only a match is ever open.
  // An assistant chosen in the list, or the top one when it leads the list (an
  // ask in the band, or no worker listed): the pane shows it in place of a worker's.
  // A worker chosen and only folded away (Archived shut) keeps the pane.
  const workerChosen =
    workersShown &&
    focusedId !== null &&
    items.some((item) => item.runId === focusedId && inWork(item));
  const selectedAssistant: CanopyAssistantItem | null =
    shownAssistants.find((item) => item.id === assistantId) ??
    (!workerChosen && (visible.length === 0 || focusedIndex === -1) ? firstAssistant : null);
  const focusedItem =
    selectedAssistant !== null || !workersShown
      ? null
      : focusedIndex !== -1
        ? visible[focusedIndex]!
        : searching
          ? (visible[0] ?? null)
          : (items.find((item) => item.runId === focusedId && inWork(item)) ?? listed[0] ?? null);
  const visibleRef = useRef<CanopyItem[]>([]);
  const workerNavigationRef = useRef<CanopyWorkerEntry[]>([]);
  const selectedRef = useRef<string | null>(null);
  // An answer or a reply settles after the panel may have closed, and a new
  // one opened over the same ids: only this one's own may move the keyboard.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The host the list shows: two hosts can each have a run under the same id.
  const listHostRef = useRef(hostId);
  useEffect(() => {
    visibleRef.current = visible;
    workerNavigationRef.current = workerNavigation;
    selectedRef.current = focusedItem?.runId ?? null;
    listHostRef.current = hostId;
  });
  const detailRef = useRef<CanopyCardHandle>(null);

  // Where the keyboard goes when the panel closes: the terminal "Go to
  // terminal" just focused, rather than whatever opened the panel.
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  // The run selected, its row brought into view, the keyboard left where it is.
  const selectNow = useCallback((runId: string) => {
    setPaneFocus(null);
    setAssistantId(null);
    setFocusedId(runId);
    document.getElementById(canopyCardDomId(runId))?.scrollIntoView({ block: "nearest" });
  }, []);

  const focusCardNow = useCallback((runId: string) => {
    setPaneFocus(null);
    setAssistantId(null);
    setFocusedId(runId);
    const element = document.getElementById(canopyCardDomId(runId));
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  }, []);

  // The run the pane shows is one the user has in front of them: it counts as
  // looked at when it opens there, each minute it stays, and as it stops
  // showing — while anyone can see the panel at all. Another host's run shows
  // only its reading here, not its terminal: no look is told of it.
  const shownPlace = focusedItem ? placeOf(focusedItem, hostId, ownHostId) : null;
  const shownRunId =
    isOpen && (!otherHost || (everyHost && shownPlace?.hostId === null))
      ? (shownPlace?.runId ?? null)
      : null;
  useEffect(() => {
    if (shownRunId === null) return;
    // One look, reconciled whenever it could stop or start being true — the
    // window behind another app, the view cached — so it always ends.
    let looking = false;
    const sync = () => {
      const next = canopyViewIsWatched();
      if (next === looking) return;
      looking = next;
      reportCanopySeen(shownRunId, next, "panel");
    };
    sync();
    const heartbeat = window.setInterval(() => {
      sync();
      if (looking) reportCanopySeen(shownRunId, true, "panel");
    }, CANOPY_SEEN_HEARTBEAT_MS);
    const offObservable = subscribeProjectViewObservability(sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.clearInterval(heartbeat);
      offObservable();
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      if (looking) reportCanopySeen(shownRunId, false, "panel");
    };
  }, [shownRunId]);

  // Land the keyboard in the search on open, with the top of the list selected —
  // at once when the search is there, so nothing typed goes astray. Otherwise
  // two frames, so it lands after the palette's own first-tabbable focus rather
  // than racing it, and cancelled on cleanup so a StrictMode replay schedules it afresh.
  const landedRef = useRef(false);
  // Where "Go to terminal" left the panel, held until the opening that returns
  // there has landed on it.
  const restoreRef = useRef<CanopyResume | null>(null);
  const searchedRef = useRef(appliedQuery);
  // The restored search, until the deferred query has caught up to it: that
  // arrival is the search being put back, not a new search to select the top of.
  const restoredQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      restoreRef.current = null;
      restoredQueryRef.current = null;
      return;
    }
    const { resume } = useCanopyStore.getState();
    if (resume === null) return;
    useCanopyStore.setState({ resume: null });
    restoreRef.current = resume;
    restoredQueryRef.current = resume.query;
    setQuery(resume.query);
  }, [isOpen, setQuery]);
  // The user pressed something in the panel since it opened, header included:
  // where they put the keyboard stands, and the landing gives way to it.
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    touchedRef.current = false;
    const touch = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-testid="canopy-dialog"]')) {
        touchedRef.current = true;
      }
    };
    window.addEventListener("pointerdown", touch, { capture: true, passive: true });
    window.addEventListener("keydown", touch, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", touch, { capture: true });
      window.removeEventListener("keydown", touch, { capture: true });
    };
  }, [isOpen]);
  // A dictated reply asked for is where this opening lands, once it is found;
  // only one that can't be shown leaves the opening to land as it would.
  const replyReveal = useCanopyStore((s) => s.replyReveal);
  useEffect(() => {
    if (!isOpen) {
      landedRef.current = false;
      setFocusedId(null);
      setQuery("");
      return;
    }
    focusAfterCloseRef.current = null;
    if (landedRef.current || items.length === 0 || replyReveal !== null) return;
    // The search it was left with is in force before the run is picked from it.
    const restore = restoreRef.current;
    if (restore !== null && appliedQuery !== restore.query) return;
    const target = restore
      ? canopyResumeTarget(
          restore,
          visible.map((item) => item.runId)
        )
      : // An assistant leading the list is the default pane: no worker is picked over it.
        firstAssistant !== null
        ? null
        : (visible[0]?.runId ?? null);
    const land = () => {
      landedRef.current = true;
      restoreRef.current = null;
      // The user got there first — clicked a row, a control or into a
      // terminal while the frames were held back: their place stands.
      if (touchedRef.current) return;
      const search = searchRef.current;
      if (search) {
        if (target !== null) {
          setFocusedId(target);
          if (restore) {
            document.getElementById(canopyCardDomId(target))?.scrollIntoView({ block: "nearest" });
          }
        }
        search.focus();
      } else if (target !== null) {
        focusCardNow(target);
      }
    };
    if (searchRef.current) {
      land();
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(land);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [isOpen, items, visible, focusCardNow, setQuery, appliedQuery, firstAssistant, replyReveal]);

  // The focused card left (trashed, answered into another section, exited):
  // put the keyboard on the card that took its place instead of dropping it on
  // the page. Only when focus really was lost — a composer the user is typing
  // in elsewhere keeps it.
  const lastIndexRef = useRef(0);
  const refreshRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusedIndex !== -1) lastIndexRef.current = focusedIndex;
    if (!landedRef.current || focusedId === null) return;
    // The keyboard is on its way into the new run's pane (⌘↑/⌘↓, or Send):
    // the old pane unmounting drops it on the page for a moment, which is not
    // a run leaving.
    if (paneFocus?.runId === focusedId && items.some((item) => item.runId === focusedId)) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    if (visible.length === 0) {
      // The last run left: the one control still in reach is Refresh.
      refreshRef.current?.focus();
      return;
    }
    // Either the card left, or it moved section and its node was replaced.
    const target =
      focusedIndex !== -1
        ? visible[focusedIndex]!
        : visible[Math.min(lastIndexRef.current, visible.length - 1)]!;
    focusCardNow(target.runId);
  }, [focusedIndex, focusedId, visible, focusCardNow, paneFocus, items]);

  // A new search selects its top match, as opening selects the top run; a
  // match leaving under the same search gives its place to the next.
  // A search with no match yet still owes its top match, should a terminal find one.
  const topOwedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      searchedRef.current = "";
      topOwedRef.current = false;
      return;
    }
    if (restoredQueryRef.current !== null) {
      if (appliedQuery !== restoredQueryRef.current) return;
      restoredQueryRef.current = null;
      searchedRef.current = appliedQuery;
      return;
    }
    if (searchedRef.current !== appliedQuery) {
      searchedRef.current = appliedQuery;
      const top = firstAssistant !== null ? undefined : visible[0];
      topOwedRef.current = top === undefined && firstAssistant === null;
      if (top) selectNow(top.runId);
      else setFocusedId(null);
      return;
    }
    // An assistant the person chose keeps the pane; the worker list's own
    // recovery waits until they come back to it.
    const assistantChosen =
      assistantId !== null && shownAssistants.some((item) => item.id === assistantId);
    if (
      !searching ||
      focusedIndex !== -1 ||
      visible.length === 0 ||
      assistantChosen ||
      firstAssistant !== null
    ) {
      return;
    }
    const index = topOwedRef.current ? 0 : Math.min(lastIndexRef.current, visible.length - 1);
    topOwedRef.current = false;
    selectNow(visible[index]!.runId);
  }, [
    isOpen,
    appliedQuery,
    searching,
    focusedIndex,
    visible,
    selectNow,
    assistantId,
    shownAssistants,
    firstAssistant,
  ]);

  // Select a run and take the keyboard into its pane — its composer or its
  // terminal — rather than onto its row.
  const openPaneNow = useCallback((runId: string, focus: CanopyPaneFocus) => {
    setPaneFocus({ runId, focus });
    setFocusedId(runId);
    document.getElementById(canopyCardDomId(runId))?.scrollIntoView({ block: "nearest" });
  }, []);

  // Another host's list starts afresh: no run open from the last one.
  // An opening that returns to another host starts there, not from a switch.
  const shownHostRef = useRef(hostId);
  const hostOpenRef = useRef(isOpen);
  useEffect(() => {
    const wasOpen = hostOpenRef.current;
    hostOpenRef.current = isOpen;
    if (shownHostRef.current === hostId) return;
    shownHostRef.current = hostId;
    if (!wasOpen) return;
    setFocusedId(null);
    setPaneFocus(null);
  }, [hostId, isOpen]);

  // The recording indicator asked for the row a dictation writes its reply
  // into (#14778). After the host reset above, which the same request may
  // have caused. The filters stand: a row they hide is said to be hidden, and
  // the dictation goes on into its draft either way.
  useEffect(() => {
    if (!isOpen || replyReveal === null) return;
    const settle = () => useCanopyStore.getState().settleReplyReveal(replyReveal.id);
    // Another host picked since: that list has no such row.
    if (replyReveal.hostScope !== hostId) {
      settle();
      return;
    }
    if (!loaded) {
      // A host that never answers doesn't hold the opening forever.
      const timer = setTimeout(() => {
        settle();
        reportReplyHidden("isn't in Canopy");
      }, REPLY_REVEAL_WAIT_MS);
      return () => clearTimeout(timer);
    }
    settle();
    const item = items.find((entry) => entry.runId === replyReveal.runId);
    if (item === undefined) {
      reportReplyHidden("isn't in Canopy");
      return;
    }
    const shown =
      workersShown && inWork(item) && (!searching || visible.some((v) => v.runId === item.runId));
    if (!shown) {
      reportReplyHidden("is hidden by Canopy's filters");
      return;
    }
    landedRef.current = true;
    restoreRef.current = null;
    setAssistantId(null);
    setPaneFocus({ runId: item.runId, focus: "dictation" });
    setFocusedId(item.runId);
    document.getElementById(canopyCardDomId(item.runId))?.scrollIntoView({ block: "nearest" });
  }, [isOpen, replyReveal, hostId, loaded, items, workersShown, inWork, searching, visible]);

  /**
   * Where the cursor goes once a run is dealt with — archived, answered,
   * replied to: the next run after it that needs you or has something unread,
   * else the one before it that does, else simply its neighbour.
   */
  const nextAfter = useCallback((runId: string): CanopyItem | undefined => {
    const order = workerNavigationRef.current;
    const key = order.find((entry) => entry.item.runId === runId)?.key ?? null;
    return nextAfterEntry(order, key)?.item;
  }, []);
  // Escape from the pane lands on the run's row; a run folded away in
  // Archived has no row to land on, so the keyboard takes the fold instead
  // — still in the list, where the next Escape closes the panel.
  // With no row to land on (folded into Archived, or hidden by Unread),
  // the fold takes it, else the list's first row, else Refresh: always
  // somewhere in the list, where the next Escape closes the panel.
  const leavePane = useCallback(
    (item: CanopyItem) => {
      if (document.getElementById(canopyCardDomId(item.runId))) {
        focusCardNow(item.runId);
        return;
      }
      const fold = document.querySelector<HTMLElement>('[aria-controls="canopy-archived"]');
      if (fold) {
        fold.focus();
        return;
      }
      const first = visibleRef.current[0];
      if (first) focusCardNow(first.runId);
      else refreshRef.current?.focus();
    },
    [focusCardNow]
  );
  // A row took focus (click, Tab, pointer): it is the selection, with the
  // keyboard on the row rather than carried into the pane.
  const selectRow = (runId: string) => {
    setPaneFocus(null);
    setAssistantId(null);
    setFocusedId(runId);
  };
  const focusAssistantNow = (id: string) => {
    setAssistantId(id);
    const element = document.getElementById(canopyAssistantDomId(id));
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  };
  // Into the assistant's own lane; nothing is launched or resumed, and a
  // refusal is said in its pane.
  const openAssistant = (item: CanopyAssistantItem) => {
    if (item.handbackAt !== null) seeAssistantHandback(item.id, item.handbackAt);
    setAssistantId(item.id);
    setAssistantRefusal(null);
    void openAssistantItem(item).then((refused) => {
      if (!mountedRef.current) return;
      if (refused === null) close();
      else setAssistantRefusal({ id: item.id, text: refused });
    });
  };
  const selectAssistant = useCallback((id: string) => setAssistantId(id), []);
  const settlePaneFocus = useCallback(
    (runId: string) => setPaneFocus((current) => (current?.runId === runId ? null : current)),
    []
  );
  // Still mounted and showing that host: an answer or a switch that settles
  // later acts only for the panel it was made in.
  const showsHost = useCallback(
    (shownHostId: HostId | null) => mountedRef.current && listHostRef.current === shownHostId,
    []
  );
  const isSelected = useCallback((runId: string) => selectedRef.current === runId, []);
  // The terminal "Go to terminal" just focused takes the keyboard back on close.
  const captureFocusAfterClose = useCallback(() => {
    focusAfterCloseRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  // Closing for the terminal remembers the panel's place for the next opening.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });
  const closeForTerminal = useCallback(
    (runId: string) =>
      useCanopyStore.getState().closeForTerminal({
        at: Date.now(),
        hostId: listHostRef.current,
        query: queryRef.current,
        runId,
        order: visibleRef.current.map((item) => item.runId),
      }),
    []
  );
  const focusAfterClose = useCallback(() => focusAfterCloseRef.current, []);
  // The assistant in the pane has had its handback in front of the person.
  // An assistant the person chose has had its handback in front of them. One
  // shown only because nothing else is listed hasn't: seeing it there would
  // re-sort the list and hand the pane, and a "seen", to each in turn.
  const chosenAssistantId =
    isOpen && selectedAssistant !== null && selectedAssistant.id === assistantId
      ? assistantId
      : null;
  const chosenHandbackAt = chosenAssistantId !== null ? selectedAssistant!.handbackAt : null;
  useEffect(() => {
    if (chosenAssistantId !== null && chosenHandbackAt !== null) {
      const domId = canopyAssistantDomId(chosenAssistantId);
      const wasFocused = document.activeElement?.id === domId;
      seeAssistantHandback(chosenAssistantId, chosenHandbackAt);
      // Seen, the handback stops asking and the row moves out of the band: the
      // keyboard follows it rather than dropping to the page.
      if (wasFocused) {
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) document.getElementById(domId)?.focus();
        });
      }
    }
  }, [chosenAssistantId, chosenHandbackAt, seeAssistantHandback]);
  // Each opening, and each change of role, starts from the list's own default,
  // as the worker selection does.
  useEffect(() => {
    setAssistantId(null);
    setAssistantRefusal(null);
  }, [isOpen, roleFilter]);

  return {
    searchRef,
    refreshRef,
    detailRef,
    focusedIndex,
    activeIndex,
    focusedItem,
    paneFocus,
    assistantRefusal,
    selectedAssistant,
    selectNow,
    focusCardNow,
    openPaneNow,
    selectRow,
    selectAssistant,
    focusAssistantNow,
    openAssistant,
    settlePaneFocus,
    nextAfter,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    closeForTerminal,
    focusAfterClose,
  };
}
