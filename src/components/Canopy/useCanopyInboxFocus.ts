import { useCallback, useEffect, useRef, useState } from "react";
import type { HostId } from "@shared/types/remoteHosts";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { itemArchived, type CanopyItem } from "./canopyModel";
import {
  entryShelved,
  nextAfterEntry,
  nextBelowEntry,
  type CanopyWorkerEntry,
} from "./canopyInboxProjection";
import { canopyCardDomId, type CanopyCardHandle, type CanopyPaneFocus } from "./CanopyCard";
import type { CanopyAssistantItem, CanopyRoleFilter } from "./canopyAssistants";
import { canopyAssistantDomId } from "./openAssistantItem";
import { CANOPY_SURFACE, useCanopyFrame } from "./canopyFrame";
import { placeOf } from "./canopyInboxPlace";
import { mainViewFocusedAgentId } from "./canopyMainViewFocus";
import { canopyResumeTarget, type CanopyResume } from "./canopyResume";
import { useCanopyStore } from "@/store/canopyStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatTypingLocatorMessage, useTypingLocatorStore } from "@/store/typingLocatorStore";

/** How long a row asked for waits on its host's runs before it is taken as not there. */
const REPLY_REVEAL_WAIT_MS = 10_000;
/** How long a popped-out dialog's row waits on its host's rows here before the inbox lands as usual. */
const POP_OUT_LANDING_WAIT_MS = 10_000;

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
  pluginViewIds,
  assistantsLoaded,
}: {
  isOpen: boolean;
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
  /** The plugin views the window offers, by hosted id; none in the dialog. */
  pluginViewIds: readonly string[];
  /** The assistants have been listed, or can't be here: one not among them isn't there. */
  assistantsLoaded: boolean;
}) {
  const frame = useCanopyFrame();
  const searchRef = useRef<HTMLInputElement>(null);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [assistantRefusal, setAssistantRefusal] = useState<{ id: string; text: string } | null>(
    null
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A plugin view chosen in place of the pane. Only the person's own pick of a
  // run or an assistant puts it away; a recovery moving the selection beneath
  // it doesn't, and one whose plugin is gone gives the pane back on its own.
  const [pluginViewId, setPluginViewId] = useState<string | null>(null);
  const shownPluginViewId =
    pluginViewId !== null && pluginViewIds.includes(pluginViewId) ? pluginViewId : null;
  // Where the keyboard goes in the next agent's pane, for the run it was meant for.
  const [paneFocus, setPaneFocus] = useState<{ runId: string; focus: CanopyPaneFocus } | null>(
    null
  );
  // The reply a dictation writes into, its keyboard asked for by the recording
  // indicator: by request, since its pane may already be showing.
  const [replyFocus, setReplyFocus] = useState<{ runId: string; id: number } | null>(null);
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
  // Nothing of the inbox is in the pane while a plugin view is: no run counts
  // as looked at, and no row reads as the one shown.
  const selectedAssistant: CanopyAssistantItem | null =
    shownPluginViewId !== null
      ? null
      : (shownAssistants.find((item) => item.id === assistantId) ??
        (!workerChosen && (visible.length === 0 || focusedIndex === -1) ? firstAssistant : null));
  const focusedItem =
    shownPluginViewId !== null || selectedAssistant !== null || !workersShown
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
  const selectRun = useCallback((runId: string) => {
    setPaneFocus(null);
    setReplyFocus(null);
    setAssistantId(null);
    setFocusedId(runId);
    document.getElementById(canopyCardDomId(runId))?.scrollIntoView({ block: "nearest" });
  }, []);
  const selectNow = useCallback(
    (runId: string) => {
      setPluginViewId(null);
      selectRun(runId);
    },
    [selectRun]
  );

  const focusCardNow = useCallback((runId: string) => {
    setPluginViewId(null);
    setPaneFocus(null);
    setReplyFocus(null);
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

  // Land the keyboard in the search on open, with the agent the main view had
  // focused selected, else the top of the list — at once when the search is there, so nothing typed goes astray. Otherwise
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
  // The same, since a dialog popped out here last asked to land.
  const landingTouchedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    touchedRef.current = false;
    const touch = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(CANOPY_SURFACE)) {
        touchedRef.current = true;
        landingTouchedRef.current = true;
      }
    };
    window.addEventListener("pointerdown", touch, { capture: true, passive: true });
    window.addEventListener("keydown", touch, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", touch, { capture: true });
      window.removeEventListener("keydown", touch, { capture: true });
    };
  }, [isOpen]);
  // The agent the main view had focused as this opening began, read once: the
  // landing goes to it while the list shows it, ahead of "Go to terminal"'s run
  // and an assistant leading the list. Focus moving afterwards moves nothing.
  const mainViewAgentRef = useRef<string | null>(null);
  useEffect(() => {
    mainViewAgentRef.current = isOpen ? mainViewFocusedAgentId() : null;
  }, [isOpen]);
  // A dictated reply asked for is where this opening lands, once it is found;
  // only one that can't be shown leaves the opening to land as it would.
  const replyReveal = useCanopyStore((s) => s.replyReveal);
  // A dialog popped out into this window lands where it stood instead.
  const popOutLanding = useCanopyStore((s) => s.popOutLanding);
  useEffect(() => {
    if (!isOpen) {
      landedRef.current = false;
      setFocusedId(null);
      setPluginViewId(null);
      setReplyFocus(null);
      setQuery("");
      return;
    }
    focusAfterCloseRef.current = null;
    if (
      landedRef.current ||
      items.length === 0 ||
      replyReveal !== null ||
      popOutLanding !== null
    ) {
      return;
    }
    // The search it was left with is in force before the run is picked from it.
    const restore = restoreRef.current;
    if (restore !== null && appliedQuery !== restore.query) return;
    // Only a row of this window's own host is that terminal: another host's
    // runs can carry the same id.
    const mainViewAgent = mainViewAgentRef.current;
    const agentRow =
      mainViewAgent === null
        ? undefined
        : visible.find((item) => {
            const place = placeOf(item, hostId, ownHostId);
            return place.hostId === null && place.runId === mainViewAgent;
          });
    const target = agentRow
      ? agentRow.runId
      : restore
        ? canopyResumeTarget(
            restore,
            visible.map((item) => item.runId)
          )
        : // An assistant leading the list is the default pane: no worker is picked over it.
          firstAssistant !== null
          ? null
          : (visible[0]?.runId ?? null);
    // Anything but the top of the list may be scrolled out of view.
    const scrollTo = agentRow !== undefined || restore !== null;
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
          if (scrollTo) {
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
  }, [
    isOpen,
    items,
    visible,
    focusCardNow,
    setQuery,
    appliedQuery,
    firstAssistant,
    replyReveal,
    popOutLanding,
    hostId,
    ownHostId,
  ]);

  // The focused card left (trashed, answered into another section, exited):
  // put the keyboard on the card that took its place instead of dropping it on
  // the page. Only when focus really was lost — a composer the user is typing
  // in elsewhere keeps it.
  const lastIndexRef = useRef(0);
  const refreshRef = useRef<HTMLButtonElement>(null);
  // What last had the keyboard: a row it was taken from by its own remount,
  // rather than by anything else leaving, is still in the user's view.
  const lastFocusedRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const note = (event: FocusEvent) => {
      lastFocusedRef.current = event.target instanceof Element ? event.target : null;
    };
    document.addEventListener("focusin", note, true);
    return () => {
      document.removeEventListener("focusin", note, true);
      lastFocusedRef.current = null;
    };
  }, [isOpen]);
  useEffect(() => {
    if (focusedIndex !== -1) lastIndexRef.current = focusedIndex;
    if (!landedRef.current || focusedId === null) return;
    // A plugin's view in the pane loses the keyboard on its own terms, a
    // control of its own going away: that is no run leaving, and going to one
    // would take the pane from the view.
    if (shownPluginViewId !== null) return;
    // The keyboard is on its way into the new run's pane (⌘↑/⌘↓, or Send):
    // the old pane unmounting drops it on the page for a moment, which is not
    // a run leaving.
    const handingOff = paneFocus?.runId === focusedId || replyFocus?.runId === focusedId;
    if (handingOff && items.some((item) => item.runId === focusedId)) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    if (visible.length === 0) {
      // The last run left: the one control still in reach is Refresh.
      refreshRef.current?.focus();
      return;
    }
    // Its row moved section and was replaced: the keyboard comes back to it
    // where it now is, with the pane and the list's scroll left as they were.
    const lost = lastFocusedRef.current;
    const domId = canopyCardDomId(focusedId);
    if (focusedIndex !== -1 && lost !== null && !lost.isConnected && lost.id === domId) {
      document.getElementById(domId)?.focus({ preventScroll: true });
      return;
    }
    // Either the card left, or the keyboard was lost from somewhere else.
    const target =
      focusedIndex !== -1
        ? visible[focusedIndex]!
        : visible[Math.min(lastIndexRef.current, visible.length - 1)]!;
    focusCardNow(target.runId);
  }, [
    focusedIndex,
    focusedId,
    visible,
    focusCardNow,
    paneFocus,
    replyFocus,
    items,
    shownPluginViewId,
  ]);

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
    selectRun(visible[index]!.runId);
  }, [
    isOpen,
    appliedQuery,
    searching,
    focusedIndex,
    visible,
    selectNow,
    selectRun,
    assistantId,
    shownAssistants,
    firstAssistant,
  ]);

  // Select a run and take the keyboard into its pane — its composer or its
  // terminal — rather than onto its row.
  const openPaneNow = useCallback((runId: string, focus: CanopyPaneFocus) => {
    setPluginViewId(null);
    setPaneFocus({ runId, focus });
    setReplyFocus(null);
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
    setReplyFocus(null);
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
    if (!loaded) return;
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
    setPluginViewId(null);
    setAssistantId(null);
    setPaneFocus(null);
    setReplyFocus({ runId: item.runId, id: replyReveal.id });
    setFocusedId(item.runId);
    document.getElementById(canopyCardDomId(item.runId))?.scrollIntoView({ block: "nearest" });
  }, [isOpen, replyReveal, hostId, loaded, items, workersShown, inWork, searching, visible]);
  // A host that never answers doesn't hold the opening forever: each request
  // waits so long from when it is first kept waiting, whatever else updates.
  useEffect(() => {
    if (!isOpen || replyReveal === null || loaded) return;
    const timer = setTimeout(() => {
      useCanopyStore.getState().settleReplyReveal(replyReveal.id);
      reportReplyHidden("isn't in Canopy");
    }, REPLY_REVEAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [isOpen, replyReveal, loaded]);
  // A dialog popped out into this window (#16338): its search goes in at once,
  // and its row is selected once the host it was listed under shows here with
  // its rows in, after the host reset above. What the user does here first,
  // a host picked or a row clicked, stands instead.
  const landingSearchedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isOpen || popOutLanding === null || landingSearchedRef.current === popOutLanding.id) {
      return;
    }
    landingSearchedRef.current = popOutLanding.id;
    landingTouchedRef.current = false;
    restoreRef.current = null;
    // Its arrival is the search being put back, not a new one to select the top of.
    if (popOutLanding.query !== appliedQuery) restoredQueryRef.current = popOutLanding.query;
    if (popOutLanding.query !== query) setQuery(popOutLanding.query);
  }, [isOpen, popOutLanding, query, appliedQuery, setQuery]);
  const shownStoreHostId = useCanopyStore((s) => s.hostId);
  useEffect(() => {
    if (!isOpen || popOutLanding === null) return;
    const settle = () => useCanopyStore.getState().settlePopOutLanding(popOutLanding.id);
    if (shownStoreHostId !== popOutLanding.hostId || landingTouchedRef.current) {
      settle();
      return;
    }
    if (hostId !== popOutLanding.hostId || appliedQuery !== popOutLanding.query) return;
    const selection = popOutLanding.selection;
    // Nothing selected, or not found: the inbox lands as any opening does.
    if (selection === null) {
      settle();
      return;
    }
    let domId: string;
    if (selection.kind === "worker") {
      if (!loaded) return;
      settle();
      const shown =
        visible.some((item) => item.runId === selection.runId) ||
        (!searching && items.some((item) => item.runId === selection.runId && inWork(item)));
      if (!shown) return;
      setAssistantId(null);
      setFocusedId(selection.runId);
      domId = canopyCardDomId(selection.runId);
    } else {
      const shown = shownAssistants.some((item) => item.id === selection.assistantId);
      if (!shown && !assistantsLoaded) return;
      settle();
      if (!shown) return;
      setAssistantId(selection.assistantId);
      domId = canopyAssistantDomId(selection.assistantId);
    }
    landedRef.current = true;
    setPaneFocus(null);
    setReplyFocus(null);
    document.getElementById(domId)?.scrollIntoView({ block: "nearest" });
    searchRef.current?.focus({ preventScroll: true });
  }, [
    isOpen,
    popOutLanding,
    shownStoreHostId,
    hostId,
    appliedQuery,
    loaded,
    visible,
    searching,
    items,
    inWork,
    shownAssistants,
    assistantsLoaded,
  ]);
  // A host that never lists its rows here doesn't hold the landing forever.
  useEffect(() => {
    if (!isOpen || popOutLanding === null) return;
    const id = popOutLanding.id;
    const timer = setTimeout(
      () => useCanopyStore.getState().settlePopOutLanding(id),
      POP_OUT_LANDING_WAIT_MS
    );
    return () => clearTimeout(timer);
  }, [isOpen, popOutLanding]);
  const settleReplyFocus = useCallback(
    (id: number) => setReplyFocus((current) => (current?.id === id ? null : current)),
    []
  );

  /**
   * Where the cursor goes once an archived run leaves: the next run after it
   * that needs you or has something unread, else the one before it that does,
   * else simply its neighbour.
   */
  const nextAfter = useCallback((runId: string): CanopyItem | undefined => {
    const order = workerNavigationRef.current;
    const key = order.find((entry) => entry.item.runId === runId)?.key ?? null;
    return nextAfterEntry(order, key)?.item;
  }, []);
  // Where ⌘↩ from the pane's reply goes on to, down the list as it shows now:
  // the reply names it before it is pressed.
  const moveOnTo =
    focusedItem === null
      ? null
      : (nextBelowEntry(
          workerNavigation,
          workerNavigation.find((entry) => entry.item.runId === focusedItem.runId)?.key ?? null
        )?.item ?? null);
  // The run a ⌘↩ named, once its send lands: only while it is still listed and
  // the user hasn't put it aside or archived it since. Never a stand-in.
  const moveOnTarget = useCallback((runId: string): CanopyItem | undefined => {
    const entry = workerNavigationRef.current.find((candidate) => candidate.item.runId === runId);
    if (entry === undefined || entryShelved(entry) || itemArchived(entry.item)) return undefined;
    return entry.item;
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
    setPluginViewId(null);
    setPaneFocus(null);
    setReplyFocus(null);
    setAssistantId(null);
    setFocusedId(runId);
  };
  const focusAssistantNow = (id: string) => {
    setPluginViewId(null);
    setAssistantId(id);
    const element = document.getElementById(canopyAssistantDomId(id));
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  };
  // Into the assistant's own lane; nothing is launched or resumed, and a
  // refusal is said in its pane.
  // From the docked global assistant, the agent beside it stays selected.
  const openAssistant = (item: CanopyAssistantItem, keepSelection = false) => {
    if (item.handbackAt !== null) seeAssistantHandback(item.id, item.handbackAt);
    if (!keepSelection) {
      setPluginViewId(null);
      setAssistantId(item.id);
    }
    setAssistantRefusal(null);
    const mounted = () => mountedRef.current;
    void frame.openAssistant(item, mounted).then((refused) => {
      if (refused !== null && mounted()) setAssistantRefusal({ id: item.id, text: refused });
    });
  };
  const selectAssistant = useCallback((id: string) => {
    setPluginViewId(null);
    setAssistantId(id);
  }, []);
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
    shownPluginViewId,
    showPluginView: setPluginViewId,
    focusedIndex,
    activeIndex,
    focusedItem,
    paneFocus,
    replyFocus,
    settleReplyFocus,
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
    moveOnTo,
    moveOnTarget,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    closeForTerminal,
    focusAfterClose,
  };
}
