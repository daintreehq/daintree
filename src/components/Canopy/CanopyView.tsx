import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Keyboard, RefreshCw } from "lucide-react";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { Telescope } from "@/components/icons";
import { isCanopyRead, useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { isMac } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { CANOPY_URGENT_PRIORITY } from "@shared/types/ipc/canopy";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { useOverlayClaim } from "@/hooks/useOverlayState";
import { AppDialog } from "@/components/ui/AppDialog";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { systemClient } from "@/clients/systemClient";
import { useFrozenBackdrop } from "./useFrozenBackdrop";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Callout } from "@/components/ui/Callout";
import { buildPilotGroups, type PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import {
  buildCanopyInbox,
  itemArchived,
  itemNeedsAttention,
  itemSubject,
  repliedAt,
  splitInbox,
  type CanopyItem,
} from "./canopyModel";
import {
  CanopyCard,
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import { CanopyRow } from "./CanopyRow";
import { SectionBar } from "./CanopySectionBar";
import { CanopyPlace } from "./CanopyPlace";
import { CanopyPitch } from "./CanopyPitch";
import { CANOPY_BETA_TERMS } from "./canopyTerms";
import { useListReorderMotion } from "./useListReorderMotion";

/** Ages are minute-grained, as in Pilot. */
const AGE_TICK_MS = 30_000;
/** How long the user must leave the panel alone before the list may re-rank. */
const CANOPY_RANK_IDLE_MS = 5_000;
/** The least time between two re-ranks the user didn't ask for. */
const CANOPY_RANK_SPACING_MS = 10_000;

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

/** An error toast whose one recovery is the place the action can be done by hand. */
function failToast(
  title: string,
  error: unknown,
  recovery: { label: string; onClick: () => void }
) {
  notify({
    type: "error",
    title,
    message: formatErrorMessage(error, "Something went wrong."),
    context: { eventKind: "agent" },
    duration: 6000,
    actions: [recovery],
  });
}

/**
 * ⌘↑/⌘↓ on macOS, Alt+↑/↓ elsewhere (Slack's channel switch): the agent above
 * or below, from anywhere in the panel. Ctrl+↑/↓ is not used off the Mac
 * because terminals send it to the program as its own key.
 */
function agentStepOf(event: KeyboardEvent<HTMLElement>): -1 | 1 | null {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  if (event.shiftKey) return null;
  const chord = isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  return event.key === "ArrowUp" ? -1 : 1;
}

/** Where the keyboard is inside the pane: the reply composer, the live terminal, or neither. */
function paneFocusOf(element: Element | null): CanopyPaneFocus {
  if (!element) return null;
  if (element.closest("[data-canopy-detail] .cm-editor")) return "composer";
  if (element.closest("[data-canopy-detail] [data-canopy-terminal]")) return "terminal";
  return null;
}

const FEEDBACK_MAILTO = "mailto:greg@daintree.org?subject=Canopy%20beta%20feedback";

/** Where the waitlist for Canopy's paid tier lives. */
export const CANOPY_WAITLIST_URL = "https://daintree.org/canopy";

/** The beta's standing terms, said every time the inbox is open. */
function BetaNotice() {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border-default px-4 py-2">
      <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-text-secondary">
        <Badge tone="warning" size="sm">
          Beta
        </Badge>
        <span className="min-w-0">{CANOPY_BETA_TERMS}</span>
      </p>
      <Button
        variant="link"
        size="xs"
        className="shrink-0"
        onClick={() => void systemClient.openExternal(FEEDBACK_MAILTO)}
      >
        Send feedback
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => void systemClient.openExternal(CANOPY_WAITLIST_URL)}
      >
        Join waitlist
      </Button>
    </div>
  );
}

/**
 * Every agent across every project, read off its screen and ranked in one list
 * by what it needs from you: menus to answer, questions to reply to, finished
 * work to look at, and working agents gone a while without a look. Pilot's
 * population, with the words and the controls to act without leaving the panel.
 */
export function CanopyView() {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const close = useCanopyStore((s) => s.close);
  const activated = useCanopyStore((s) => s.snapshot?.activated ?? null);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  useOverlayClaim("canopy", isOpen);
  const still = useFrozenBackdrop(isOpen);

  // Main watches screens closely, and writes words, only while some view says a panel is open.
  useEffect(() => {
    if (!isOpen) return;
    const unsubscribe = window.electron.canopy.onSnapshotUpdated(applySnapshot);
    safeFireAndForget(window.electron.canopy.setActive(true).then(applySnapshot));
    return () => {
      unsubscribe();
      safeFireAndForget(window.electron.canopy.setActive(false));
    };
  }, [isOpen, applySnapshot]);

  const backdrop =
    still === null ? undefined : (
      <img src={still} alt="" draggable={false} className="h-screen w-screen max-w-none" />
    );

  // Until the user turns it on, Canopy is offered, not run: no list, no
  // terminals, and nothing read.
  if (activated === false) {
    return (
      <CanopyPitch
        isOpen={isOpen}
        onClose={close}
        backdrop={backdrop}
        onTurnOn={() => window.electron.canopy.activate(true).then(applySnapshot)}
      />
    );
  }
  return <CanopyInbox backdrop={backdrop} />;
}

interface ShortcutRow {
  keys: string[];
  /** The keys are the two ends of a range, not alternatives. */
  range?: boolean;
  label: string;
}

/**
 * Every key the panel answers to, one press away instead of always on screen,
 * grouped by where the keyboard is: the pane's keys are the agent's.
 */
function CanopyShortcuts() {
  const step = isMac() ? "Cmd" : "Alt";
  const groups: Array<{ heading: string; rows: ShortcutRow[] }> = [
    {
      heading: "In the list",
      rows: [
        { keys: ["ArrowUp", "ArrowDown"], label: "Move" },
        { keys: ["Enter"], label: "Go to terminal" },
        { keys: ["1", "9"], range: true, label: "Answer with that choice" },
        { keys: ["Y"], label: "Take the first choice, unless it's risky" },
        { keys: ["R"], label: "Reply" },
        { keys: ["E"], label: "Archive, or move back to the inbox" },
        { keys: ["Cmd+Backspace"], label: "Trash, pressed twice" },
        { keys: ["Escape"], label: "Close" },
      ],
    },
    {
      heading: "In a reply or the terminal",
      rows: [
        { keys: [`${step}+ArrowUp`, `${step}+ArrowDown`], label: "Next agent" },
        { keys: ["Enter"], label: "Send to the agent" },
        { keys: ["Shift+Enter"], label: "New line in a reply" },
      ],
    },
  ];
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Keyboard shortcuts">
              <Keyboard />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Keyboard shortcuts</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="flex w-auto flex-col gap-3 p-3">
        {groups.map((group) => (
          <section key={group.heading} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-text-primary">{group.heading}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs text-text-secondary">
              {group.rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="inline-flex items-center gap-1">
                    {row.keys.map((key, index) => (
                      <span key={key} className="inline-flex items-center gap-1">
                        {index > 0 && row.range && (
                          <>
                            <span aria-hidden="true">–</span>
                            <span className="sr-only">to</span>
                          </>
                        )}
                        <KbdChord shortcut={key} />
                      </span>
                    ))}
                  </dt>
                  <dd>{row.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="text-xs text-text-secondary">
          Every other key in the terminal, Esc included, goes to the agent.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function CanopyInbox({ backdrop }: { backdrop: React.ReactNode }) {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const close = useCanopyStore((s) => s.close);
  const canopy = useCanopyStore((s) => s.snapshot);
  const fleet = useFleetSnapshotStore((s) => s.snapshot);
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);
  const scope = useCanopyStore((s) => s.scope);
  const setScope = useCanopyStore((s) => s.setScope);

  // Main reads only the screens in scope, so the agents a project view hides
  // cost nothing.
  useEffect(() => {
    if (!isOpen) return;
    safeFireAndForget(
      window.electron.canopy.setScope(scope === "project" ? getViewWorkspaceId() : null)
    );
  }, [isOpen, scope]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    const handle = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(handle);
  }, [isOpen]);

  const workspaces = useMemo(() => {
    const map = new Map<string, PilotWorkspaceMeta>();
    for (const project of projects) {
      map.set(project.id, {
        kind: "project",
        name: project.name,
        lastOpened: project.lastOpened,
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.color ? { color: project.color } : {}),
        ...(project.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: project.lastCompletionSeenAt }
          : {}),
      });
    }
    for (const scratch of scratches) {
      map.set(scratch.id, {
        kind: "scratch",
        name: scratch.name,
        lastOpened: scratch.lastOpened,
        ...(scratch.lastCompletionSeenAt !== undefined
          ? { lastCompletionSeenAt: scratch.lastCompletionSeenAt }
          : {}),
      });
    }
    return map;
  }, [projects, scratches]);

  const baseItems = useMemo(() => {
    if (!fleet) return [];
    const here = getViewWorkspaceId();
    const runs =
      scope === "project" ? fleet.runs.filter((run) => run.workspaceId === here) : fleet.runs;
    const groups = buildPilotGroups(runs, {
      workspaces,
      currentWorkspaceId: getViewWorkspaceId(),
      nowMs,
    });
    const cards = new Map((canopy?.cards ?? []).map((card) => [card.runId, card]));
    return buildCanopyInbox(
      groups,
      cards,
      {
        failed: (canopy?.lastError ?? null) !== null,
        failedRuns: new Set(canopy?.failedRuns ?? []),
      },
      new Map((canopy?.dispositions ?? []).map((entry) => [entry.runId, entry])),
      new Map((canopy?.seen ?? []).map((entry) => [entry.runId, entry])),
      nowMs,
      new Map((canopy?.glances ?? []).map((entry) => [entry.runId, entry]))
    );
  }, [fleet, workspaces, nowMs, canopy, scope]);

  // The list moves only at moments the user can expect it to. It opens in the
  // order it was left, ranked afresh before its first paint only when
  // something was read while it was closed. While open it re-ranks after a scan
  // that read something new, once the user has been idle a while and not more
  // often than every few seconds, never under the pointer, and at once when
  // they press Refresh. The clock never moves it. A run new since the last
  // rank goes after the ranked ones, in the order it arrived.
  const refreshedAt = canopy?.refreshedAt ?? null;
  const order = useCanopyStore((s) => s.orders[scope]) ?? null;
  const setOrder = useCanopyStore((s) => s.setOrder);
  const [pointerInList, setPointerInList] = useState(false);
  const lastInteractionRef = useRef(0);
  const pressingRef = useRef(false);
  const lastRankRef = useRef(0);
  const openedRef = useRef(false);
  const scopeRef = useRef(scope);
  const [rankWake, setRankWake] = useState(0);
  const [rankRequest, setRankRequest] = useState(0);
  const rankRequestSeenRef = useRef(0);
  useLayoutEffect(() => {
    if (!isOpen) {
      openedRef.current = false;
      return;
    }
    if (baseItems.length === 0) return;
    const fresh = baseItems.map((item) => item.runId);
    const urgent = baseItems.filter(isUrgentItem).map((item) => item.runId);
    const now = Date.now();
    const rank = () => {
      lastRankRef.current = now;
      rankRequestSeenRef.current = rankRequest;
      setOrder(scope, { ids: fresh, rankedFor: refreshedAt, urgent });
    };
    const stale = order === null || order.rankedFor !== refreshedAt;
    // Opening, or switching scope, is the user's own move: a list with
    // something new to show is ranked before it paints.
    if (!openedRef.current || scopeRef.current !== scope) {
      openedRef.current = true;
      scopeRef.current = scope;
      // What the user sees on opening counts as just ranked.
      lastRankRef.current = now;
      if (stale) rank();
      return;
    }
    if (order === null || rankRequest !== rankRequestSeenRef.current) return rank();
    // An ask newly urgent goes where it belongs at once, unless a press is
    // under way: the row under it must not move between down and up.
    const wasUrgent = new Set(order.urgent);
    if (!pressingRef.current && urgent.some((id) => !wasUrgent.has(id))) return rank();
    // Arrivals join the end in the order they came, whatever else is waiting.
    const placed = new Set(order.ids);
    const arrived = fresh.filter((id) => !placed.has(id));
    if (arrived.length > 0) {
      setOrder(scope, { ...order, ids: [...order.ids, ...arrived] });
      return;
    }
    if (!stale || pointerInList) return;
    const wait = Math.max(
      lastInteractionRef.current + CANOPY_RANK_IDLE_MS - now,
      lastRankRef.current + CANOPY_RANK_SPACING_MS - now
    );
    if (wait <= 0) return rank();
    const timer = setTimeout(() => setRankWake((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [
    isOpen,
    scope,
    baseItems,
    order,
    setOrder,
    refreshedAt,
    pointerInList,
    rankWake,
    rankRequest,
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
  // What a reply answers: the runs that need you, in the list's order.
  const queue = useMemo(() => inbox.inbox.filter(itemNeedsAttention), [inbox]);
  const archivedExpanded = useCanopyStore((s) => s.archivedExpanded);
  const setArchivedExpanded = useCanopyStore((s) => s.setArchivedExpanded);
  // What the keyboard walks: the list, then the archived runs once they are shown.
  const visible = useMemo(
    () => [...inbox.inbox, ...(archivedExpanded ? inbox.archived : [])],
    [inbox, archivedExpanded]
  );
  const listRef = useRef<HTMLDivElement>(null);
  useListReorderMotion(listRef, inbox.inbox.map((item) => item.runId).join(" "));
  // A list unmounted under the pointer never says the pointer left.
  const listShown = inbox.inbox.length > 0;
  useEffect(() => {
    if (!listShown) setPointerInList(false);
  }, [listShown]);

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
  const focusedItem =
    focusedIndex !== -1
      ? visible[focusedIndex]!
      : (items.find((item) => item.runId === focusedId) ?? inbox.inbox[0] ?? null);
  const queueRef = useRef(queue);
  const visibleRef = useRef<CanopyItem[]>([]);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    queueRef.current = queue;
    visibleRef.current = visible;
    selectedRef.current = focusedItem?.runId ?? null;
  });
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
  const detailRef = useRef<CanopyCardHandle>(null);

  // Where the keyboard goes when the panel closes: the terminal "Go to
  // terminal" just focused, rather than whatever opened the panel.
  const focusAfterCloseRef = useRef<HTMLElement | null>(null);
  const reads = useCanopyStore((s) => s.reads);
  const markRead = useCanopyStore((s) => s.markRead);
  const pruneReads = useCanopyStore((s) => s.pruneReads);
  useEffect(() => {
    // Only against a whole, current population: a degraded snapshot can leave
    // runs out that are still running.
    if (fleet && !fleet.degraded) pruneReads(new Set(fleet.runs.map((run) => run.runId)));
  }, [fleet, pruneReads]);
  const isUnread = useCallback(
    (item: CanopyItem) =>
      itemNeedsAttention(item) &&
      !isCanopyRead(reads[item.runId], item.row.run.spawnedAt, item.card),
    [reads]
  );
  // Opening a run — a click or the arrows onto it — reads it, as in a mail
  // inbox. Landing on the first run when the panel opens does not.
  const openedByUser = useCallback(
    (item: CanopyItem) => markRead(item.runId, item.row.run.spawnedAt),
    [markRead]
  );

  const focusCardNow = useCallback((runId: string) => {
    setPaneFocus(null);
    setFocusedId(runId);
    const element = document.getElementById(canopyCardDomId(runId));
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  }, []);

  // The run the pane shows is one the user has in front of them: it counts as
  // looked at when it opens there, each minute it stays, and as it stops
  // showing — while anyone can see the panel at all.
  const shownRunId = isOpen ? (focusedItem?.runId ?? null) : null;
  useEffect(() => {
    if (shownRunId === null) return;
    const look = () => {
      if (canopyViewIsWatched()) reportCanopySeen(shownRunId);
    };
    look();
    const heartbeat = window.setInterval(look, CANOPY_SEEN_HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      look();
    };
  }, [shownRunId]);

  // Land the keyboard on the top of the list on open. Two frames, so it lands
  // after the palette's own first-tabbable focus rather than racing it, and
  // cancelled on cleanup so a StrictMode replay schedules it afresh.
  const landedRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      landedRef.current = false;
      setFocusedId(null);
      return;
    }
    focusAfterCloseRef.current = null;
    if (landedRef.current || inbox.inbox.length === 0) return;
    const target = inbox.inbox[0]!.runId;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        landedRef.current = true;
        focusCardNow(target);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [isOpen, inbox, focusCardNow]);

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

  // Select a run and take the keyboard into its pane — its composer or its
  // terminal — rather than onto its row.
  const openPaneNow = useCallback((runId: string, focus: CanopyPaneFocus) => {
    setPaneFocus({ runId, focus });
    setFocusedId(runId);
    document.getElementById(canopyCardDomId(runId))?.scrollIntoView({ block: "nearest" });
  }, []);

  const handlers = useMemo<CanopyCardHandlers>(() => {
    const openRun = (item: CanopyItem) => {
      const args = { runId: item.runId, workspaceId: item.workspaceId };
      if (item.workspaceId !== getViewWorkspaceId()) {
        // The switch replaces this view, so the panel closes first.
        close();
        void actionService.dispatch("pilot.openRun", args, { source: "user" });
        return;
      }
      // Here already: focus the terminal while the panel is still open, and
      // close only once that worked. `pilot.openRun` arms the palette's
      // focus-restore suppression on success, so the close can't hand focus
      // back to whatever opened the panel.
      void actionService.dispatch("pilot.openRun", args, { source: "user" }).then((result) => {
        if (!result.ok) return;
        // `pilot.openRun` arms the palettes' one-shot restore suppression; this
        // is a dialog, which hands focus on by its own target instead, so the
        // flag is taken here rather than left for the next palette to close.
        consumePaletteFocusRestoreSuppression();
        focusAfterCloseRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        close();
      });
    };
    // The incarnation on screen, so main refuses a terminal respawned since.
    const target = (item: CanopyItem) => ({ spawnedAt: item.row.run.spawnedAt });
    const goTo = (item: CanopyItem) => ({ label: "Go to terminal", onClick: () => openRun(item) });
    return {
      onOpen: openRun,
      onSent: (item, via) => {
        openedByUser(item);
        // Typed straight into the terminal: the keys stay there, since a menu
        // or a prompt may have more to ask. The reply still moves the run out
        // of the queue, and its pane stays open where the user is typing.
        if (via === "terminal") return;
        // The user moved to another run while the reply was on its way: their
        // choice stands.
        if (selectedRef.current !== item.runId) return;
        // Replied from the composer: on to the next run that needs you, into
        // its composer, as Send moves on in a mail queue. The answered one
        // leaves the queue when main's handled reading lands.
        const pending = queueRef.current;
        const index = pending.findIndex((candidate) => candidate.runId === item.runId);
        const next = pending.slice(index + 1)[0] ?? pending.slice(0, Math.max(index, 0))[0];
        if (next && next.runId !== item.runId) {
          openPaneNow(next.runId, "composer");
          openedByUser(next);
        }
      },
      onArchive: (item) => {
        const runId = item.runId;
        if (itemArchived(item)) {
          safeFireAndForget(
            window.electron.canopy
              .unarchive(runId, target(item))
              .catch((error: unknown) => failToast("Couldn't move to inbox", error, goTo(item)))
          );
          return;
        }
        // The cursor moves on before the run leaves, as archiving does in mail:
        // to the next run in the list, else the one before it.
        const order = visibleRef.current;
        const index = order.findIndex((candidate) => candidate.runId === runId);
        const next = index === -1 ? undefined : (order[index + 1] ?? order[index - 1]);
        if (next) {
          focusCardNow(next.runId);
          openedByUser(next);
        }
        safeFireAndForget(
          window.electron.canopy.archive(runId, target(item)).then(
            () => {
              notify({
                type: "success",
                transient: true,
                title: "Archived",
                message: itemSubject(item),
                context: { eventKind: "agent" },
                duration: 6000,
                actions: [
                  {
                    label: "Undo",
                    onClick: () =>
                      safeFireAndForget(window.electron.canopy.unarchive(runId, target(item))),
                  },
                ],
              });
            },
            (error: unknown) => failToast("Couldn't archive", error, goTo(item))
          )
        );
      },
      onSendFailed: (item, error) => failToast("Couldn't send to agent", error, goTo(item)),
      onAnswer: (item, label) => {
        openedByUser(item);
        // On to the next run that needs you, as a reply from the composer does —
        // on its row, where the next answer is one key away.
        const pending = queueRef.current;
        const index = pending.findIndex((candidate) => candidate.runId === item.runId);
        const next = pending.slice(index + 1)[0] ?? pending.slice(0, Math.max(index, 0))[0];
        safeFireAndForget(
          window.electron.canopy.answer(item.runId, target(item), label).then(
            () => {
              if (selectedRef.current !== item.runId) return;
              if (next && next.runId !== item.runId) {
                focusCardNow(next.runId);
                openedByUser(next);
              }
            },
            (error: unknown) => failToast("Couldn't answer", error, goTo(item))
          )
        );
      },
      onTrash: (item) => {
        const runId = item.runId;
        safeFireAndForget(
          window.electron.canopy.trash(runId, target(item)).then(
            () => {
              notify({
                type: "success",
                // One-shot: its only job is the Undo, which means nothing once it has gone.
                transient: true,
                title: "Terminal trashed",
                message: item.row.title,
                context: { eventKind: "agent" },
                duration: 5000,
                actions: [
                  {
                    label: "Undo",
                    onClick: () => safeFireAndForget(window.electron.terminal.restore(runId)),
                  },
                ],
              });
            },
            (error: unknown) => failToast("Couldn't trash terminal", error, goTo(item))
          )
        );
      },
    };
  }, [close, openedByUser, focusCardNow, openPaneNow]);

  // Each group is its own Tab stop: the selected row when it is in the group,
  // else the group's first.
  const tabStop = (group: readonly CanopyItem[], item: CanopyItem, index: number) =>
    focusedItem !== null && group.some((run) => run.runId === focusedItem.runId)
      ? focusedItem.runId === item.runId
      : index === 0;
  // A row took focus (click, Tab, pointer): it is the selection, with the
  // keyboard on the row rather than carried into the pane.
  const selectRow = (runId: string) => {
    setPaneFocus(null);
    setFocusedId(runId);
  };

  // ⌘↑/⌘↓ from anywhere in the panel, the live terminal and the composer
  // included: taken in the capture phase, before xterm or CodeMirror can, so
  // the user can work down the list — reply, next, reply — without leaving the
  // keyboard where it is. The keyboard lands in the same place on the next run.
  const onAgentStepKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const step = agentStepOf(event);
    if (step === null || visible.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    // From the open run, clamped at the ends rather than wrapping: the bottom
    // of the list is the end of it. An open run that is not in the list
    // (archived and folded away) steps onto the list's first or last row.
    const current = visible.findIndex((item) => item.runId === focusedItem?.runId);
    const next =
      current === -1
        ? visible[step > 0 ? 0 : visible.length - 1]!
        : visible[Math.min(visible.length - 1, Math.max(0, current + step))]!;
    if (next.runId === focusedItem?.runId) return;
    const focus = paneFocusOf(document.activeElement);
    if (focus === null) focusCardNow(next.runId);
    else openPaneNow(next.runId, focus);
    openedByUser(next);
  };

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (visible.length === 0) return;
    // Only from a row of the list: the pane holds a live terminal and a
    // composer whose keys belong to the agent, and the fold owns its own keys.
    if (!(event.target instanceof Element) || !event.target.closest("[data-canopy-card]")) return;
    // The selected run's own chords (Trash is ⌘⌫) go to it before the
    // modifier guard below, which keeps app shortcuts out of plain navigation.
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (detailRef.current?.handleKey(event)) return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      next = Math.min(visible.length - 1, activeIndex + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      next = Math.max(0, activeIndex - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = visible.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      focusCardNow(visible[next]!.runId);
      openedByUser(visible[next]!);
      return;
    }
    // Keys aimed at the list's selected row act on the selected agent.
    const selected = visible[activeIndex];
    if (!selected) return;
    if (event.key === "Enter") {
      event.preventDefault();
      handlers.onOpen(selected);
      return;
    }
    detailRef.current?.handleKey(event);
  };

  const needsYou = queue.length;

  // A press spins the button until the refresh it asked for is done, cards
  // included. The background polls never do: they are not news.
  const [refreshes, setRefreshes] = useState(0);
  const refresh = () => {
    setRefreshes((n) => n + 1);
    safeFireAndForget(
      window.electron.canopy
        .refresh()
        .catch((error: unknown) =>
          failToast("Couldn't refresh Canopy", error, { label: "Retry", onClick: refresh })
        )
        .finally(() => {
          setRefreshes((n) => n - 1);
          // What the user asked to see, in order now.
          setRankRequest((n) => n + 1);
        })
    );
  };
  const unreadCount = items.filter(isUnread).length;
  // A project's name on every row says nothing while every row is in it.
  const manyProjects = new Set(items.map((item) => item.workspaceId)).size > 1;

  const summaryLine =
    fleet === null
      ? "Reading agents…"
      : items.length === 0
        ? "No agents are running"
        : [
            unreadCount > 0 ? `${unreadCount.toLocaleString()} unread` : null,
            needsYou > 0 ? `${pluralize(needsYou, "needs", "need")} you` : null,
            pluralize(items.length, "agent"),
          ]
            .filter(Boolean)
            .join(" · ");

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="workspace"
      maxHeight="h-[min(90vh,1100px)]"
      // The panel lands on its first run itself, two frames in; the dialog's own
      // first-control focus would race it. With no rows to land on, the first
      // control takes focus instead of leaving it on whatever opened the panel.
      initialFocus={inbox.inbox.length > 0 ? "none" : "first"}
      restoreFocusTo={() => focusAfterCloseRef.current}
      preferRestoreFocusTo
      backdrop={backdrop}
      data-testid="canopy-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Telescope />}>Canopy</AppDialog.Title>
        <span className="mr-3 ml-3 min-w-0 flex-1 truncate text-sm text-text-secondary">
          {summaryLine}
        </span>
        <SegmentedRadioGroup<"all" | "project">
          aria-label="Agents to show"
          density="compact"
          className="mr-3"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All projects" },
            { value: "project", label: "This project" },
          ]}
        />
        <CanopyShortcuts />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={refreshRef}
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh"
              aria-busy={refreshes > 0 || undefined}
              disabled={canopy === null}
              onClick={refresh}
            >
              <SpinningIcon icon={RefreshCw} active={refreshes > 0} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh</TooltipContent>
        </Tooltip>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onAgentStepKeyDownCapture}
        onKeyDown={onNavigationKeyDown}
      >
        {canopy?.tier === "free" && <BetaNotice />}
        {canopy?.lastError && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3">
            {canopy?.lastError && (
              <Callout
                severity="warning"
                size="compact"
                title="Some screens couldn't be read"
                action={
                  <Button variant="outline" size="xs" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {canopy.lastError}. Rows marked Read failed show what was read before.
              </Callout>
            )}
          </div>
        )}
        {items.length > 0 && (
          // An inbox: what needs you down a sidebar, most urgent first, the rest
          // folded away beneath it, and the selected agent's own terminal beside
          // it, drawn as its pane.
          <div className="flex min-h-0 flex-1">
            <div
              className="canopy-inbox flex min-h-0 w-[28rem] shrink-0 flex-col self-stretch overflow-y-auto border-r border-border-default select-none"
              data-canopy-list=""
            >
              <SectionBar
                id="canopy-inbox-label"
                label="Inbox"
                count={inbox.inbox.length}
                // Where the numbers and words come from, said once for the list.
                trailing={
                  <span className="text-2xs text-text-secondary">AI reading · priority</span>
                }
              />
              {inbox.inbox.length > 0 ? (
                <div
                  ref={listRef}
                  role="listbox"
                  aria-labelledby="canopy-inbox-label"
                  // A mouse or pen resting over a row; a touch has no hover to hold for.
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") setPointerInList(true);
                  }}
                  onPointerLeave={() => {
                    // Leaving releases the hold, it doesn't move the list:
                    // the idle wait starts from here.
                    lastInteractionRef.current = Date.now();
                    setPointerInList(false);
                  }}
                >
                  {inbox.inbox.map((item, index) => {
                    const replied = repliedAt(item);
                    return (
                      <CanopyRow
                        key={item.runId}
                        item={item}
                        domId={canopyCardDomId(item.runId)}
                        isSelected={focusedItem?.runId === item.runId}
                        // Words are coming whenever screens are read, so the slot
                        // for them is held from the start.
                        reserveDetail
                        tabbable={tabStop(inbox.inbox, item, index)}
                        unread={isUnread(item)}
                        showProject={manyProjects}
                        nowMs={nowMs}
                        asideLabel={
                          replied !== null ? `Replied ${formatWaitAge(replied, nowMs)} ago` : null
                        }
                        onSelect={() => selectRow(item.runId)}
                        onClick={() => openedByUser(item)}
                        onOpen={() => handlers.onOpen(item)}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 pb-3 text-xs text-text-secondary">
                  Every agent is archived. Each comes back when it has something new to say.
                </p>
              )}
              {inbox.archived.length > 0 && (
                <>
                  <SectionBar
                    id="canopy-archived-label"
                    label="Archived"
                    count={inbox.archived.length}
                    fold={{
                      expanded: archivedExpanded,
                      controls: "canopy-archived",
                      onToggle: () => setArchivedExpanded(!archivedExpanded),
                      onEnter: () => {
                        focusCardNow(inbox.archived[0]!.runId);
                        openedByUser(inbox.archived[0]!);
                      },
                    }}
                  />
                  {archivedExpanded && (
                    <div
                      id="canopy-archived"
                      role="listbox"
                      aria-labelledby="canopy-archived-label"
                    >
                      {inbox.archived.map((item, index) => (
                        <CanopyRow
                          key={item.runId}
                          item={item}
                          domId={canopyCardDomId(item.runId)}
                          isSelected={focusedItem?.runId === item.runId}
                          reserveDetail={false}
                          tabbable={tabStop(inbox.archived, item, index)}
                          unread={false}
                          showProject={manyProjects}
                          compact
                          nowMs={nowMs}
                          asideLabel={
                            item.disposition
                              ? `Archived ${formatWaitAge(item.disposition.at, nowMs)} ago`
                              : null
                          }
                          onSelect={() => selectRow(item.runId)}
                          onClick={() => openedByUser(item)}
                          onOpen={() => handlers.onOpen(item)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas px-2 pb-2">
              {focusedItem && (
                <CanopyPlace item={focusedItem} id={`canopy-place-${focusedItem.runId}`} />
              )}
              {focusedItem ? (
                <CanopyCard
                  key={focusedItem.runId}
                  ref={detailRef}
                  item={focusedItem}
                  domId={`canopy-detail-${focusedItem.runId}`}
                  describedBy={`canopy-place-${focusedItem.runId}`}
                  initialFocus={paneFocus?.runId === focusedItem.runId ? paneFocus.focus : null}
                  onInitialFocusSettled={() =>
                    setPaneFocus((current) =>
                      current?.runId === focusedItem.runId ? null : current
                    )
                  }
                  {...handlers}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
                  <p className="text-sm text-text-primary">Nothing in the inbox</p>
                  <p className="text-xs text-text-secondary">
                    Open an archived agent to see its terminal here.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        {fleet !== null && items.length === 0 && (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-text-secondary">Launch an agent and it shows up here.</p>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
