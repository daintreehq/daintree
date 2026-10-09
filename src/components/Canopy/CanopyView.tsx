import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Keyboard, RefreshCw } from "lucide-react";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { Telescope } from "@/components/icons";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { latestUndoOnly, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { pluralize } from "@/lib/pluralize";
import { isMac } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { CANOPY_URGENT_PRIORITY, type CanopyReadMark } from "@shared/types/ipc/canopy";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
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
  itemPriority,
  itemSubject,
  repliedAt,
  splitInbox,
  type CanopyItem,
} from "./canopyModel";
import { CANOPY_REVEAL_MS, nextCanopyOrder } from "./canopyOrder";
import {
  CanopyCard,
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import { CanopyRow } from "./CanopyRow";
import { CanopyRowMenu, type CanopyRowMenuActions } from "./CanopyRowMenu";
import { SectionBar } from "./CanopySectionBar";
import { CanopyPlace } from "./CanopyPlace";
import { CanopyPitch } from "./CanopyPitch";
import { CANOPY_BETA_TERMS } from "./canopyTerms";
import { useListReorderMotion } from "./useListReorderMotion";

/** Ages are minute-grained, as in Pilot. */
const AGE_TICK_MS = 30_000;
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
 * Hides Canopy from its offer. The panel closes as the hidden snapshot lands;
 * the toast says where it went and takes it back — unless Canopy was shown,
 * hidden again or turned on since, here or in another view, which stands.
 */
async function hideCanopy(): Promise<void> {
  const { applySnapshot } = useCanopyStore.getState();
  const hidden = await window.electron.canopy.setMode("hidden");
  applySnapshot(hidden);
  // The revision this hide left, as main counts them: an Undo applies only
  // while main still stands there.
  const revision = hidden.modeRevision ?? 0;
  notify({
    type: "success",
    title: "Canopy hidden",
    message: "Show it again from Settings > Canopy.",
    priority: "high",
    transient: true,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: latestUndoOnly("canopy-hide", () => {
        if (useCanopyStore.getState().mode !== "hidden") return;
        window.electron.canopy.setMode("unset", revision).then(applySnapshot, () =>
          notify({
            type: "error",
            title: "Couldn't show Canopy",
            message: "Show it again from Settings > Canopy.",
            action: {
              label: "Open settings",
              onClick: () =>
                void actionService.dispatch(
                  "app.settings.openTab",
                  { tab: "canopy" },
                  { source: "user" }
                ),
            },
          })
        );
      }),
    },
  });
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
        onTurnOn={() => window.electron.canopy.setMode("on").then(applySnapshot)}
        onHide={hideCanopy}
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
        { keys: ["U"], label: "Mark as read or unread" },
        { keys: ["Alt+U"], label: "Mark all as read" },
        { keys: ["Z"], label: "Undo" },
        { keys: ["Shift+F10"], label: "More actions" },
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
      new Map((canopy?.glances ?? []).map((entry) => [entry.runId, entry])),
      new Map((canopy?.reads ?? []).map((entry) => [entry.runId, entry]))
    );
  }, [fleet, workspaces, nowMs, canopy, scope]);

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
  useLayoutEffect(() => {
    if (!isOpen) {
      openedAtRef.current = null;
      setRevealed(false);
      return;
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
  }, [isOpen, revealed, owedOnOpen, revealWake]);

  // The list moves only at moments the user can expect it to; see `nextCanopyOrder`.
  const refreshedAt = canopy?.refreshedAt ?? null;
  const order = useCanopyStore((s) => s.orders[scope]) ?? null;
  const setOrder = useCanopyStore((s) => s.setOrder);
  const [pointerInList, setPointerInList] = useState(false);
  const lastInteractionRef = useRef(0);
  const pressingRef = useRef(false);
  // A row's context menu is open: the list holds still under it.
  const menuOpenRef = useRef(false);
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
    const now = Date.now();
    const opening = !openedRef.current || scopeRef.current !== scope;
    if (opening) {
      openedRef.current = true;
      scopeRef.current = scope;
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
      setOrder(scope, step.order);
      return;
    }
    if (step.kind === "hold") return;
    const timer = setTimeout(() => setRankWake((n) => n + 1), step.ms);
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
  const unreadOnly = useCanopyStore((s) => s.unreadOnly);
  const setUnreadOnly = useCanopyStore((s) => s.setUnreadOnly);
  // A run read while the Unread filter is on stays listed until the filter is
  // turned off: reading the row in front of you must not pull it out from
  // under you, nor shift every row beneath it.
  const [keptUnread, setKeptUnread] = useState<ReadonlySet<string>>(() => new Set());
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
        ? inbox.inbox.filter((item) => item.unread || keptUnread.has(item.runId))
        : inbox.inbox,
    [unreadOnly, inbox, keptUnread]
  );
  // What a reply answers: the runs that need you, in the list's order.
  const queue = useMemo(() => listed.filter(itemNeedsAttention), [listed]);
  const archivedExpanded = useCanopyStore((s) => s.archivedExpanded);
  const setArchivedExpanded = useCanopyStore((s) => s.setArchivedExpanded);
  // What the keyboard walks: the list, then the archived runs once they are shown.
  const visible = useMemo(
    () => [...listed, ...(archivedExpanded ? inbox.archived : [])],
    [listed, inbox, archivedExpanded]
  );
  const listRef = useRef<HTMLDivElement>(null);
  useListReorderMotion(listRef, listed.map((item) => item.runId).join(" "));
  // A list unmounted under the pointer never says the pointer left.
  const listShown = listed.length > 0;
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
      : (items.find((item) => item.runId === focusedId) ?? listed[0] ?? null);
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
  // A deliberate act on a run reads it at once — going to it, a click,
  // answering, replying — through the turn it showed. Merely arriving on it
  // reads it only once it has stayed in front of the user (main's dwell).
  const readNow = useCallback((item: CanopyItem) => {
    if (!item.unread) return;
    safeFireAndForget(
      window.electron.canopy.setRead(
        item.runId,
        { spawnedAt: item.row.run.spawnedAt },
        true,
        item.readMark?.turn
      )
    );
  }, []);

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

  // Land the keyboard on the top of the list on open. Two frames, so it lands
  // after the palette's own first-tabbable focus rather than racing it, and
  // cancelled on cleanup so a StrictMode replay schedules it afresh.
  const landedRef = useRef(false);
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
  useEffect(() => {
    if (!isOpen) {
      landedRef.current = false;
      setFocusedId(null);
      return;
    }
    focusAfterCloseRef.current = null;
    if (landedRef.current || listed.length === 0) return;
    const target = listed[0]!.runId;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        landedRef.current = true;
        // The user got there first — clicked a row, a control or into a
        // terminal while the frames were held back: their place stands.
        if (touchedRef.current) return;
        focusCardNow(target);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [isOpen, listed, focusCardNow]);

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

  // The last triage the user did here, to take back with Z or the toast's
  // Undo. One deep, as in mail: only the newest action can be undone.
  const undoRef = useRef<(() => void) | null>(null);
  const offerUndo = useCallback((undo: () => void, toast?: { title: string; message: string }) => {
    undoRef.current = undo;
    if (!toast) return;
    notify({
      type: "success",
      transient: true,
      title: toast.title,
      message: toast.message,
      context: { eventKind: "agent" },
      duration: 6000,
      actions: [
        {
          label: "Undo",
          onClick: () => {
            if (undoRef.current === undo) undoRef.current = null;
            undo();
          },
        },
      ],
    });
  }, []);
  /**
   * Undo of a read change: each run back to what it was (`before`), wherever
   * it is still as the change left it (`after`) — a new turn, or a change from
   * another view since, stands.
   */
  const undoReads = useCallback((before: CanopyReadMark[], after: CanopyReadMark[]) => {
    const was = new Map(before.map((mark) => [mark.runId, mark]));
    const restores = after.flatMap((left) => {
      const mark = was.get(left.runId);
      return mark !== undefined && mark.spawnedAt === left.spawnedAt
        ? [{ mark, expectVersion: left.version }]
        : [];
    });
    if (restores.length > 0) safeFireAndForget(window.electron.canopy.restoreReads(restores));
  }, []);

  /**
   * Where the cursor goes once a run is dealt with — archived, answered,
   * replied to: the next run after it that needs you or has something unread,
   * else the one before it that does, else simply its neighbour.
   */
  const nextAfter = useCallback((runId: string): CanopyItem | undefined => {
    const order = visibleRef.current;
    const index = order.findIndex((candidate) => candidate.runId === runId);
    const wanted = (candidate: CanopyItem) =>
      candidate.runId !== runId && (itemNeedsAttention(candidate) || candidate.unread);
    return (
      order.slice(index + 1).find(wanted) ??
      order.slice(0, Math.max(index, 0)).find(wanted) ??
      (index === -1 ? undefined : (order[index + 1] ?? order[index - 1]))
    );
  }, []);

  const handlers = useMemo<CanopyCardHandlers>(() => {
    const openRun = (item: CanopyItem) => {
      readNow(item);
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
    const archive = (item: CanopyItem, expectTurn?: number) =>
      expectTurn === undefined
        ? window.electron.canopy.archive(item.runId, target(item))
        : window.electron.canopy.archive(item.runId, target(item), expectTurn);
    const unarchive = (item: CanopyItem) =>
      window.electron.canopy.unarchive(item.runId, target(item));
    const archiveFailed = (item: CanopyItem) => (error: unknown) =>
      failToast("Couldn't archive", error, goTo(item));
    const unarchiveFailed = (item: CanopyItem) => (error: unknown) =>
      failToast("Couldn't move to inbox", error, goTo(item));
    return {
      onOpen: openRun,
      onSent: (item, via) => {
        readNow(item);
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
        const next = nextAfter(item.runId);
        if (next && next.runId !== item.runId) openPaneNow(next.runId, "composer");
      },
      onArchive: (item) => {
        if (itemArchived(item)) {
          const turn = item.readMark?.turn ?? 0;
          safeFireAndForget(
            unarchive(item).then(
              () =>
                offerUndo(() =>
                  // Main archives it again only while it has done nothing since
                  // it came back: otherwise that would hide what it did.
                  safeFireAndForget(archive(item, turn).catch(archiveFailed(item)))
                ),
              unarchiveFailed(item)
            )
          );
          return;
        }
        // The cursor moves on before the run leaves, as archiving does in mail.
        const next = nextAfter(item.runId);
        if (next) focusCardNow(next.runId);
        const before = item.readMark;
        safeFireAndForget(
          archive(item).then(
            (after) =>
              // Refused — the run left, or was respawned: nothing to announce or undo.
              after !== null &&
              offerUndo(
                () => {
                  safeFireAndForget(unarchive(item).catch(unarchiveFailed(item)));
                  // Archiving read it; taking it back puts back what was unread.
                  if (before && after) undoReads([before], [after]);
                },
                { title: "Archived", message: itemSubject(item) }
              ),
            archiveFailed(item)
          )
        );
      },
      onSendFailed: (item, error) => failToast("Couldn't send to agent", error, goTo(item)),
      onAnswer: (item, label) => {
        readNow(item);
        // On to the next run that needs you, as a reply from the composer does —
        // on its row, where the next answer is one key away.
        const next = nextAfter(item.runId);
        safeFireAndForget(
          window.electron.canopy.answer(item.runId, target(item), label).then(
            () => {
              if (selectedRef.current !== item.runId) return;
              if (next && next.runId !== item.runId) focusCardNow(next.runId);
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
  }, [close, readNow, focusCardNow, openPaneNow, nextAfter, offerUndo, undoReads]);

  /** U: read or unread, by hand. Z takes it back. */
  const toggleRead = useCallback(
    (item: CanopyItem) => {
      if (itemArchived(item)) return;
      const read = item.unread;
      const send = () =>
        window.electron.canopy.setRead(
          item.runId,
          { spawnedAt: item.row.run.spawnedAt },
          read,
          item.readMark?.turn
        );
      safeFireAndForget(
        send().then(
          (after) => {
            if (!after) return;
            // A run Canopy had no mark for had nothing unread.
            const before = item.readMark ?? {
              ...after,
              readTurn: after.turn,
              markedUnreadAt: null,
            };
            offerUndo(() => undoReads([before], [after]));
          },
          (error: unknown) =>
            failToast(read ? "Couldn't mark as read" : "Couldn't mark as unread", error, {
              label: "Retry",
              onClick: () => safeFireAndForget(send()),
            })
        )
      );
    },
    [offerUndo, undoReads]
  );

  /**
   * Every unread run in the inbox as listed, read through the turn the list
   * showed: anything that lands after the press stays unread. Undo puts back
   * what each was, unless it has done something since.
   */
  const markAllRead = () => {
    const unread = listed.filter((item) => item.unread);
    if (unread.length === 0) return;
    const before = unread.flatMap((item) => (item.readMark ? [item.readMark] : []));
    safeFireAndForget(
      window.electron.canopy
        .markAllRead(
          unread.map((item) => ({
            runId: item.runId,
            spawnedAt: item.row.run.spawnedAt,
            turn: item.readMark?.turn ?? 0,
          }))
        )
        .then(
          (after) =>
            offerUndo(() => undoReads(before, after), {
              title: "Marked as read",
              message: pluralize(unread.length, "agent"),
            }),
          (error: unknown) =>
            failToast("Couldn't mark as read", error, { label: "Retry", onClick: markAllRead })
        )
    );
  };

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
  };

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (visible.length === 0) return;
    // Only from a row of the list: the pane holds a live terminal and a
    // composer whose keys belong to the agent, and the fold owns its own keys.
    if (!(event.target instanceof Element) || !event.target.closest("[data-canopy-card]")) return;
    // Shift+F10 or the Menu key: the selected row's menu, as a right-click
    // opens it. Replayed as a contextmenu on the row, since the menu has no
    // way to be opened by hand, and macOS sends none for these keys itself.
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)
    ) {
      const row = visible[activeIndex]
        ? document.getElementById(canopyCardDomId(visible[activeIndex]!.runId))
        : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    // The selected run's own chords (Trash is ⌘⌫) go to it before the
    // modifier guard below, which keeps app shortcuts out of plain navigation.
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (detailRef.current?.handleKey(event)) return;
    }
    // ⌥U marks every unread run listed read. By the key's place, not its
    // character: on a Mac ⌥U is the umlaut dead key and types no "u".
    if (event.code === "KeyU" && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!event.repeat) markAllRead();
      return;
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
      return;
    }
    if ((event.key === "z" || event.key === "Z") && !event.shiftKey) {
      event.preventDefault();
      const undo = undoRef.current;
      undoRef.current = null;
      if (undo && !event.repeat) undo();
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
    if ((event.key === "u" || event.key === "U") && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) toggleRead(selected);
      return;
    }
    detailRef.current?.handleKey(event);
  };

  // Over the whole inbox, whatever the filter shows: a read approval still blocks its agent.
  const needsYou = inbox.inbox.filter(itemNeedsAttention).length;
  // Trash from a row's menu arms it as its first press does; the pane's
  // button or ⌘⌫ confirms. Bumped per request, for the run it names.
  const [trashArm, setTrashArm] = useState<{ runId: string; request: number } | null>(null);
  // A request is for the run it named while it stays open: coming back to it
  // later must not find Trash armed.
  const openRunId = focusedItem?.runId ?? null;
  useEffect(() => {
    if (trashArm !== null && openRunId !== trashArm.runId) setTrashArm(null);
  }, [trashArm, openRunId]);

  const rowMenu: CanopyRowMenuActions = {
    onOpen: handlers.onOpen,
    onReply: (item) => openPaneNow(item.runId, "composer"),
    onToggleRead: toggleRead,
    onArchive: handlers.onArchive,
    onTrash: (item) => {
      focusCardNow(item.runId);
      setTrashArm((arm) => ({ runId: item.runId, request: (arm?.request ?? 0) + 1 }));
    },
    onOpenChange: (open) => {
      menuOpenRef.current = open;
      if (open) return;
      // Closing releases the hold, it doesn't move the list: the idle wait starts from here.
      lastInteractionRef.current = Date.now();
      setRankWake((n) => n + 1);
    },
  };

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
  const unreadCount = inbox.inbox.filter((item) => item.unread).length;
  // Words being written for some run right now: said once for the list, only while it lasts.
  const updating = (canopy?.cards ?? []).some((card) => card.describing);
  // A project's name on every row says nothing while every row is in it.
  const manyProjects = new Set(items.map((item) => item.workspaceId)).size > 1;

  const summaryLine =
    fleet === null
      ? "Reading agents…"
      : items.length === 0
        ? "No agents are running"
        : // What needs you leads; what is new follows. The list's own heading
          // counts the agents.
          [
            needsYou > 0 ? `${pluralize(needsYou, "needs", "need")} you` : "Nothing needs you",
            unreadCount > 0 ? `${unreadCount.toLocaleString()} unread` : null,
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
      initialFocus={listed.length > 0 ? "none" : "first"}
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
              // Its rows have menus of their own: the app's Shift+F10 stands down here.
              data-row-menu=""
              // Still placing runs as the open's readings land.
              data-revealing={revealed ? undefined : "true"}
            >
              <SectionBar
                id="canopy-inbox-label"
                label="Inbox"
                count={listed.length}
                trailing={
                  <span className="flex items-center gap-1">
                    {/* Said only while it is so, never as a standing label. */}
                    {updating && (
                      <span role="status" className="mr-1 text-2xs text-text-secondary">
                        Updating summaries…
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      pressed={unreadOnly}
                      onClick={() => setUnreadOnly(!unreadOnly)}
                    >
                      Unread
                      {unreadCount > 0 && <span className="tabular-nums">{unreadCount}</span>}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={unreadCount === 0}
                          onClick={markAllRead}
                        >
                          Mark all read
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <KbdChord shortcut="Alt+U" />
                      </TooltipContent>
                    </Tooltip>
                  </span>
                }
              />
              {listed.length > 0 ? (
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
                  {listed.map((item, index) => {
                    const replied = repliedAt(item);
                    return (
                      <CanopyRowMenu key={item.runId} item={item} {...rowMenu}>
                        <CanopyRow
                          item={item}
                          domId={canopyCardDomId(item.runId)}
                          isSelected={focusedItem?.runId === item.runId}
                          // Words are coming whenever screens are read, so the slot
                          // for them is held from the start.
                          reserveDetail
                          tabbable={tabStop(listed, item, index)}
                          unread={item.unread}
                          showProject={manyProjects}
                          nowMs={nowMs}
                          asideLabel={
                            replied !== null ? `Replied ${formatWaitAge(replied, nowMs)} ago` : null
                          }
                          onSelect={() => selectRow(item.runId)}
                          onClick={() => readNow(item)}
                          onOpen={() => handlers.onOpen(item)}
                          onArchive={() => handlers.onArchive(item)}
                        />
                      </CanopyRowMenu>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 pb-3 text-xs text-text-secondary">
                  {unreadOnly && inbox.inbox.length > 0
                    ? "Nothing unread. Each agent shows here again when it does something new."
                    : "Every agent is archived. Each comes back when it has something new to say."}
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
                      onEnter: () => focusCardNow(inbox.archived[0]!.runId),
                    }}
                  />
                  {archivedExpanded && (
                    <div
                      id="canopy-archived"
                      role="listbox"
                      aria-labelledby="canopy-archived-label"
                    >
                      {inbox.archived.map((item, index) => (
                        <CanopyRowMenu key={item.runId} item={item} {...rowMenu}>
                          <CanopyRow
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
                            onClick={() => readNow(item)}
                            onOpen={() => handlers.onOpen(item)}
                            onArchive={() => handlers.onArchive(item)}
                          />
                        </CanopyRowMenu>
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
                  armTrash={trashArm?.runId === focusedItem.runId ? trashArm.request : undefined}
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
