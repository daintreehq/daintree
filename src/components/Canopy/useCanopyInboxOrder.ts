import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCanopyStore, type CanopyScope } from "@/store/canopyStore";
import { CANOPY_URGENT_PRIORITY, type CanopySnapshot } from "@shared/types/ipc/canopy";
import { itemPriority, splitInbox, type CanopyItem } from "./canopyModel";
import { CANOPY_REVEAL_MS, nextCanopyOrder } from "./canopyOrder";
import type { HostId } from "@shared/types/remoteHosts";

/** An ask that pages the user: placed in the list at once, whatever is held. */
function isUrgentItem(item: CanopyItem): boolean {
  const card = item.card;
  return (
    card !== null &&
    card.priority >= CANOPY_URGENT_PRIORITY &&
    card.handledAt === null &&
    item.disposition === null
  );
}

/**
 * The inbox in the order the user sees it: revealed as the open's readings
 * land, then moved only at moments they can expect (`nextCanopyOrder`). Owns
 * what holds the list still — a press in the panel, the pointer over the list,
 * a row's open menu — and takes the panel's requests to rank it now.
 */
export function useCanopyInboxOrder({
  isOpen,
  hostId,
  otherHost,
  scope,
  canopy,
  baseItems,
  nowMs,
}: {
  isOpen: boolean;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  otherHost: boolean;
  scope: CanopyScope;
  canopy: CanopySnapshot | null;
  baseItems: CanopyItem[];
  nowMs: number;
}) {
  // Every run shows the moment the panel opens, in the order it was left — or,
  // the first time, by what Daintree observes of each — and moves to its place
  // as the readings the open set off land. Once they have, or after
  // CANOPY_REVEAL_MS, the list holds still between pauses like always. Only
  // words not yet written show as skeletons.
  const owedOnOpen = useMemo(() => {
    // Main hasn't answered the open yet: the snapshot in hand is from before
    // it, and says nothing about what the open will read.
    if (canopy?.active !== true) return true;
    const due = new Set(canopy.wordsDue ?? []);
    const reading = canopy.busy;
    return baseItems.some(
      (item) =>
        due.has(item.runId) ||
        item.card?.describing === true ||
        (reading && item.card === null && item.disposition === null)
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
  const refreshedAt = canopy?.refreshedAt ?? null;
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
  useLayoutEffect(() => {
    if (!isOpen) {
      openedRef.current = false;
      return;
    }
    if (baseItems.length === 0) return;
    const now = Date.now();
    const opening = !openedRef.current || orderKeyRef.current !== orderKey;
    if (opening) {
      openedRef.current = true;
      orderKeyRef.current = orderKey;
      // What the user sees on opening counts as just ranked.
      lastRankRef.current = now;
    }
    const step = nextCanopyOrder(order, {
      fresh: baseItems.map((item) => item.runId),
      priorities: new Map(baseItems.map((item) => [item.runId, itemPriority(item, nowMs)])),
      urgent: baseItems.filter(isUrgentItem).map((item) => item.runId),
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
  const bodyRef = useRef<HTMLDivElement>(null);
  // Anything the user does in the panel holds the list still for a while, and
  // a press holds it until it is let go.
  useEffect(() => {
    const body = bodyRef.current;
    if (!isOpen || !body) return;
    const note = () => {
      lastInteractionRef.current = Date.now();
    };
    const press = () => {
      pressingRef.current = true;
    };
    const release = () => {
      if (!pressingRef.current) return;
      pressingRef.current = false;
      note();
      setRankWake((n) => n + 1);
    };
    const events = ["pointerdown", "keydown", "wheel", "input"] as const;
    for (const type of events) body.addEventListener(type, note, { capture: true, passive: true });
    body.addEventListener("pointerdown", press, { capture: true, passive: true });
    window.addEventListener("pointerup", release, { capture: true, passive: true });
    window.addEventListener("pointercancel", release, { capture: true, passive: true });
    return () => {
      for (const type of events) body.removeEventListener(type, note, { capture: true });
      body.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointerup", release, { capture: true });
      window.removeEventListener("pointercancel", release, { capture: true });
      pressingRef.current = false;
    };
  }, [isOpen]);

  // A mouse or pen resting over a row; a touch has no hover to hold for.
  const enterList = useCallback((pointerType: string) => {
    if (pointerType !== "touch") setPointerInList(true);
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
    owedOnOpen,
    revealed,
    refreshedAt,
    bodyRef,
    enterList,
    leaveList,
    listHidden,
    menuOpenChanged,
    requestRank,
  };
}
