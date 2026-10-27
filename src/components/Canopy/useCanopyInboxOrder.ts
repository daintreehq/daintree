import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCanopyStore, type CanopyScope } from "@/store/canopyStore";
import { CANOPY_URGENT_PRIORITY, type CanopySnapshot } from "@shared/types/ipc/canopy";
import {
  itemNeedsAttention,
  itemPriority,
  itemPutAside,
  splitInbox,
  type CanopyItem,
} from "./canopyModel";
import { CANOPY_REVEAL_MS, canopyReorderWaiting, nextCanopyOrder } from "./canopyOrder";
import type { HostId } from "@shared/types/remoteHosts";

/** An ask that pages the user: placed in the list at once, whatever is held. */
function isUrgentItem(item: CanopyItem): boolean {
  const card = item.card;
  // Observed alone, an approval dialog is the ask that pages.
  if (card === null) {
    const run = item.row.run;
    return (
      run.agentState === "waiting" && run.waitingReason === "approval" && item.disposition === null
    );
  }
  return (
    card !== null &&
    !itemPutAside(item) &&
    card.priority >= CANOPY_URGENT_PRIORITY &&
    card.handledAt === null &&
    item.disposition === null
  );
}

/**
 * The inbox in the order the user sees it: revealed as the open's readings
 * land, then moved only at moments they can expect (`nextCanopyOrder`). Owns
 * what holds the list still — a press in the panel, the pointer over the list,
 * a row's open menu — and takes the panel's requests to rank it now. The Needs
 * you band is held with it, and never loses the run the panel has selected.
 */
export function useCanopyInboxOrder({
  isOpen,
  hostId,
  otherHost,
  scope,
  canopy,
  baseItems,
  nowMs,
  observedAt = null,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  otherHost: boolean;
  scope: CanopyScope;
  canopy: CanopySnapshot | null;
  baseItems: CanopyItem[];
  nowMs: number;
  /** With the reader off, no scan marks a re-rank: when Daintree's own view of the fleet last moved. */
  observedAt?: number | null;
}) {
  // Every run shows the moment the panel opens, in the order it was left — or,
  // the first time, by what Daintree observes of each — and moves to its place
  // as the readings the open set off land. Once they have, after
  // CANOPY_REVEAL_MS, or the moment the user starts working in the list, it
  // holds still between pauses like always. Only words not yet written show
  // as skeletons.
  const owedOnOpen = useMemo(() => {
    // Main hasn't answered the open yet: the snapshot in hand is from before
    // it, and says nothing about what the open will read.
    if (canopy?.activated === false) return false;
    if (canopy?.active !== true) return true;
    const reading = canopy.busy;
    return baseItems.some(
      (item) =>
        item.card?.describing === true ||
        (reading && item.pending && item.card === null && item.disposition === null)
    );
  }, [baseItems, canopy]);
  const openedAtRef = useRef<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [revealWake, setRevealWake] = useState(0);
  // Showing another host is an opening of its own list.
  const revealHostRef = useRef(hostId);
  useLayoutEffect(() => {
    if (!isOpen) {
      openedAtRef.current = null;
      setRevealed(false);
      return;
    }
    if (revealHostRef.current !== hostId) {
      revealHostRef.current = hostId;
      openedAtRef.current = null;
      if (revealed) {
        setRevealed(false);
        return;
      }
    }
    if (revealed) return;
    if (openedAtRef.current === null) openedAtRef.current = Date.now();
    const left = openedAtRef.current + CANOPY_REVEAL_MS - Date.now();
    if (!owedOnOpen || left <= 0) {
      setRevealed(true);
      return;
    }
    const timer = setTimeout(() => setRevealWake((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [isOpen, revealed, owedOnOpen, revealWake, hostId]);

  // The list moves only at moments the user can expect it to; see `nextCanopyOrder`.
  // Each host keeps its own order: the same run ids mean other runs elsewhere.
  const refreshedAt = observedAt ?? canopy?.refreshedAt ?? null;
  const ownOrder = useCanopyStore((s) => s.orders[scope]);
  const hostOrder = useCanopyStore((s) => (hostId === null ? undefined : s.hostOrders[hostId]));
  const order = (otherHost ? hostOrder : ownOrder) ?? null;
  const setOrder = useCanopyStore((s) => s.setOrder);
  const setHostOrder = useCanopyStore((s) => s.setHostOrder);
  const orderKey = `${hostId ?? ""}|${scope}`;
  const [pointerInList, setPointerInList] = useState(false);
  const lastInteractionRef = useRef(0);
  const pressingRef = useRef(false);
  // A row's context menu is open: the list holds still under it.
  const menuOpenRef = useRef(false);
  const lastRankRef = useRef(0);
  const openedRef = useRef(false);
  const orderKeyRef = useRef(orderKey);
  const [rankWake, setRankWake] = useState(0);
  const [rankRequest, setRankRequest] = useState(0);
  const rankRequestSeenRef = useRef(0);
  // A reorder the list is holding back, which the user can apply now.
  const [reorderWaiting, setReorderWaiting] = useState(false);
  // The run the panel has selected, told by the panel: the selection is
  // worked out from the list this orders.
  const [selected, setSelected] = useState<string | null>(null);
  const needsYou = useMemo(
    () => baseItems.filter(itemNeedsAttention).map((item) => item.runId),
    [baseItems]
  );
  useLayoutEffect(() => {
    if (!isOpen) {
      openedRef.current = false;
      setReorderWaiting(false);
      return;
    }
    if (baseItems.length === 0) {
      setReorderWaiting(false);
      return;
    }
    const now = Date.now();
    const opening = !openedRef.current || orderKeyRef.current !== orderKey;
    if (opening) {
      openedRef.current = true;
      orderKeyRef.current = orderKey;
      // What the user sees on opening counts as just ranked.
      lastRankRef.current = now;
    }
    const fresh = baseItems.map((item) => item.runId);
    const priorities = new Map(baseItems.map((item) => [item.runId, itemPriority(item, nowMs)]));
    const step = nextCanopyOrder(order, {
      fresh,
      priorities,
      urgent: baseItems.filter(isUrgentItem).map((item) => item.runId),
      needsYou,
      selected,
      refreshedAt,
      now,
      opening,
      revealing: !revealed,
      requested: rankRequest !== rankRequestSeenRef.current,
      pressing: pressingRef.current || menuOpenRef.current,
      pointerInList,
      lastInteractionAt: lastInteractionRef.current,
      lastRankAt: lastRankRef.current,
    });
    // A run arriving or an ask promoted leaves the held reorder held: still waiting.
    const shown = step.kind !== "set" ? order : step.ranked ? null : step.order;
    setReorderWaiting(
      canopyReorderWaiting(shown, { fresh, priorities, refreshedAt, needsYou, selected })
    );
    if (step.kind === "set") {
      if (step.ranked) {
        lastRankRef.current = now;
        rankRequestSeenRef.current = rankRequest;
      }
      if (hostId === null) setOrder(scope, step.order);
      else setHostOrder(hostId, step.order);
      return;
    }
    if (step.kind === "hold") return;
    const timer = setTimeout(() => setRankWake((n) => n + 1), step.ms);
    return () => clearTimeout(timer);
  }, [
    isOpen,
    scope,
    hostId,
    orderKey,
    baseItems,
    needsYou,
    selected,
    order,
    setOrder,
    setHostOrder,
    refreshedAt,
    pointerInList,
    rankWake,
    rankRequest,
    revealed,
    nowMs,
  ]);
  const items = useMemo(() => {
    const ranks = new Map((order?.ids ?? []).map((id, index) => [id, index]));
    const rankOf = (item: CanopyItem, index: number) => ranks.get(item.runId) ?? ranks.size + index;
    return baseItems
      .map((item, index) => ({ item, rank: rankOf(item, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ item }) => item);
  }, [baseItems, order]);
  const inbox = useMemo(() => splitInbox(items), [items]);
  // Who sits in the Needs you band: as held with the order, or before there is
  // one, who needs the user now.
  const heldBand = order?.band ?? null;
  const band = useMemo<ReadonlySet<string>>(
    () => new Set(heldBand ?? needsYou),
    [heldBand, needsYou]
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // Anything the user does in the panel holds the list still for a while, and
  // a press holds it until it is let go.
  useEffect(() => {
    const body = bodyRef.current;
    if (!isOpen || !body) return;
    // Selecting, typing, scrolling or pressing: the user is reading where
    // things are, and the reveal is over.
    const note = () => {
      lastInteractionRef.current = Date.now();
      setRevealed(true);
    };
    // Heard on the window, ahead of React's own capture: a panel shortcut that
    // stops its keydown still moved the selection.
    const inBody = (event: Event) => event.target instanceof Node && body.contains(event.target);
    const noteInBody = (event: Event) => {
      if (inBody(event)) note();
    };
    const press = (event: Event) => {
      if (inBody(event)) pressingRef.current = true;
    };
    const release = () => {
      if (!pressingRef.current) return;
      pressingRef.current = false;
      note();
      setRankWake((n) => n + 1);
    };
    const events = ["pointerdown", "keydown", "wheel", "input"] as const;
    for (const type of events) {
      window.addEventListener(type, noteInBody, { capture: true, passive: true });
    }
    window.addEventListener("pointerdown", press, { capture: true, passive: true });
    window.addEventListener("pointerup", release, { capture: true, passive: true });
    window.addEventListener("pointercancel", release, { capture: true, passive: true });
    return () => {
      for (const type of events) window.removeEventListener(type, noteInBody, { capture: true });
      window.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointerup", release, { capture: true });
      window.removeEventListener("pointercancel", release, { capture: true });
      pressingRef.current = false;
    };
  }, [isOpen]);

  // A mouse or pen resting over a row; a touch has no hover to hold for.
  const enterList = useCallback((pointerType: string) => {
    if (pointerType === "touch") return;
    setPointerInList(true);
    setRevealed(true);
  }, []);
  const leaveList = useCallback(() => {
    // Leaving releases the hold, it doesn't move the list:
    // the idle wait starts from here.
    lastInteractionRef.current = Date.now();
    setPointerInList(false);
  }, []);
  const listHidden = useCallback(() => setPointerInList(false), []);
  const menuOpenChanged = useCallback((open: boolean) => {
    menuOpenRef.current = open;
    if (open) return;
    // Closing releases the hold, it doesn't move the list: the idle wait starts from here.
    lastInteractionRef.current = Date.now();
    setRankWake((n) => n + 1);
  }, []);
  const requestRank = useCallback(() => setRankRequest((n) => n + 1), []);

  return {
    items,
    inbox,
    band,
    owedOnOpen,
    revealed,
    reorderWaiting,
    refreshedAt,
    bodyRef,
    enterList,
    leaveList,
    listHidden,
    menuOpenChanged,
    requestRank,
    selectionChanged: setSelected,
  };
}
