import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
  RefreshCw,
  WifiOff,
  X,
} from "lucide-react";
import {
  GroupedVirtuoso,
  type GroupedVirtuosoHandle,
  type GroupProps,
  type ItemProps,
  type ListProps,
  type ScrollerProps,
  type TopItemListProps,
} from "react-virtuoso";
import type {
  PluginBulkAction,
  PluginBulkActionBarProps,
  PluginDrawerProps,
  PluginDrawerToggleProps,
  PluginGroupedVirtualListProps,
  PluginInspectorProps,
  PluginInspectorSectionProps,
  PluginListGroup,
  PluginLoadMoreFooterProps,
  PluginMasterDetailProps,
  PluginOverflowToolbarItem,
  PluginPropertyRowProps,
  PluginRefreshOverlayProps,
  PluginSplitGroupProps,
  PluginSplitLayout,
  PluginStaleIndicatorProps,
  PluginTask,
  PluginTaskListProps,
  PluginTaskStatus,
} from "@shared/types/plugin-sdk-react";
import { CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { OVERLAY_SHEET_SHADOW_CLASS } from "@/components/ui/floatingSurface";
import { ScrollShadow, useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { LIST_LABEL_CLASS, SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Spinner } from "@/components/ui/Spinner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resolveSplitterKey, type SplitterGrowKey } from "@/hooks/useSplitterKeys";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { pluralNoun } from "@/lib/pluralize";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { usePersistentViewState } from "@/pluginUi/viewState";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import { pluginKitDates } from "./PluginKitDates";
import { isShrinkKey, pluginKitLayout } from "./PluginKitLayout";
import { pluginKitLayoutCore } from "./PluginKitLayoutCore";
import { sizedIcon } from "./PluginKitPatterns";
import { useKitOverlayZClass } from "./kitScope";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  str,
} from "./kitProps";

const LIMIT_PX = 100_000;
const ErrorGlyph = SEVERITY_GLYPH.error;
const SIDES = ["left", "right", "top", "bottom"] as const;
type Side = (typeof SIDES)[number];

/** Kit view-state keys this file writes, kept apart from a view's own. */
function viewStateKey(kind: string, key: string | undefined): string {
  return `kit:${kind}:${key ?? ""}`;
}

/**
 * An element's border-box size, read before the first paint and then on
 * every resize, so a narrow pane never flashes its wide layout.
 */
function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** A plugin's noun for `count`: a word to pluralise, or its own `{ one, other }`. */
function nounFor(noun: unknown, count: number, fallback: string): string {
  if (typeof noun === "object" && noun !== null) {
    const one = nonEmpty(field(noun, "one"));
    const other = nonEmpty(field(noun, "other"));
    if (one && other) return pluralNoun(count, one, other);
  }
  return pluralNoun(count, nonEmpty(noun) ?? fallback);
}

function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// A container the kit moves focus to (a pane, a drawer, a footer) rings
// inside its own edge, where its clip cannot cut the ring away.
const PROGRAMMATIC_FOCUS_RING =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

function toTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value !== "") return new Date(value).getTime();
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// MasterDetail

const MD_COLLAPSE_BELOW = 560;
const MD_DEFAULT_LIST = 320;
const MD_MIN_LIST = 220;
const MD_MAX_LIST = 560;

// Narrow, the split's own frame stays mounted so neither pane loses its
// state (a scrolled list, a half-typed comment) crossing the breakpoint: the
// handle hides, and the one pane on show takes the whole width over the size
// the split pinned on it.
const MD_NARROW_CLASS =
  "[&>[role=separator]]:hidden [&>[data-split-pane=sized]]:w-full! [&>[data-split-pane=sized]]:max-w-none!";

function KitMasterDetail({
  list,
  detail,
  selectedId,
  onBack,
  listLabel,
  detailLabel,
  backLabel,
  detailTitle,
  collapseBelow,
  defaultListSize,
  minListSize,
  maxListSize,
  persistKey,
  className,
  ...rest
}: PluginMasterDetailProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(root);
  const measured = width > 0;
  const narrow = measured && width < (positive(collapseBelow, LIMIT_PX) ?? MD_COLLAPSE_BELOW);
  const key = nonEmpty(persistKey);
  const [storedSize, setStoredSize] = usePersistentViewState<number>(
    viewStateKey("masterDetail", key),
    0
  );
  const [ownSize, setOwnSize] = useState(0);
  const chosen = key ? storedSize : ownSize;
  const selected =
    typeof selectedId === "string" ||
    (typeof selectedId === "number" && Number.isFinite(selectedId));
  const showDetail = narrow && selected;
  const back = fn(onBack);

  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const lastListFocus = useRef<HTMLElement | null>(null);
  // Null until the first commit: mounting never moves focus.
  const shownBefore = useRef<"list" | "detail" | "both" | null>(null);

  // The pane that held focus is about to be hidden: hand focus to the pane
  // that replaces it, or it falls to the body and strands the keyboard.
  useLayoutEffect(() => {
    if (!measured) return;
    const shown = !narrow ? "both" : showDetail ? "detail" : "list";
    const previous = shownBefore.current;
    shownBefore.current = shown;
    if (previous === null || shown === previous) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (shown === "both") {
      // Widening takes the Back strip away; if it held focus, the detail does.
      if (previous === "detail" && lost) detailRef.current?.focus({ preventScroll: true });
      return;
    }
    if (shown === "detail") {
      if (lost || (active !== null && (listRef.current?.contains(active) ?? false))) {
        backRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (lost || (active !== null && (detailRef.current?.contains(active) ?? false))) {
      const target = lastListFocus.current;
      if (target?.isConnected && listRef.current?.contains(target)) {
        target.focus({ preventScroll: true });
      } else {
        listRef.current?.focus({ preventScroll: true });
      }
    }
  }, [measured, narrow, showDetail]);

  const rememberListFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement) lastListFocus.current = event.target;
  };

  const commitSize = (size: number) => {
    if (key) setStoredSize(size);
    else setOwnSize(size);
  };

  const listPane = (
    <div
      ref={listRef}
      role="region"
      aria-label={nonEmpty(listLabel) ?? "List"}
      tabIndex={-1}
      data-master-detail-pane="list"
      onFocus={rememberListFocus}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", PROGRAMMATIC_FOCUS_RING)}
    >
      {node(list)}
    </div>
  );
  const detailPane = (
    <div
      ref={detailRef}
      role="region"
      aria-label={nonEmpty(detailLabel) ?? "Details"}
      tabIndex={-1}
      data-master-detail-pane="detail"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", PROGRAMMATIC_FOCUS_RING)}
    >
      {showDetail ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-divider pr-3 pl-1.5">
          <Button
            ref={backRef}
            variant="ghost"
            size="xs"
            onClick={() => back?.()}
            className="shrink-0"
          >
            <ArrowLeft aria-hidden="true" />
            {nonEmpty(backLabel) ?? "Back"}
          </Button>
          {hasContent(detailTitle) ? (
            <span className="min-w-0 truncate text-xs font-medium text-text-primary">
              {node(detailTitle)}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{node(detail)}</div>
    </div>
  );

  const Split = pluginKitLayout.ResizableSplit;
  const min = positive(minListSize, LIMIT_PX) ?? MD_MIN_LIST;
  return (
    <div
      {...pickRootProps(rest)}
      ref={setRoot}
      data-master-detail={narrow ? (showDetail ? "detail" : "list") : "split"}
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-1 flex-col", str(className))}
    >
      <Split
        first={listPane}
        second={detailPane}
        aria-label={`Resize ${nonEmpty(listLabel)?.toLowerCase() ?? "list"}`}
        size={chosen > 0 ? chosen : undefined}
        defaultSize={positive(defaultListSize, LIMIT_PX) ?? MD_DEFAULT_LIST}
        minSize={min}
        maxSize={Math.max(min, positive(maxListSize, LIMIT_PX) ?? MD_MAX_LIST)}
        onSizeChange={commitSize}
        className={cn(
          narrow && MD_NARROW_CLASS,
          narrow &&
            (showDetail
              ? "[&>[data-split-pane=sized]]:hidden"
              : "[&>[data-split-pane=fill]]:hidden")
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SplitGroup

const SG_DEFAULT_PX = 240;
const SG_MIN_PX = 120;
const SG_STEP_PX = 10;
const SG_LARGE_STEP_PX = 50;
const SG_TRACK_PX = { horizontal: 6, vertical: 12 } as const;

interface SplitPaneEntry {
  id: string;
  content: unknown;
  defaultSize: number;
  sized: boolean;
  fill: boolean;
  min: number;
  max: number;
  collapsible: boolean;
  defaultCollapsed: boolean;
  handleLabel: string;
}

/** The panes a group can draw, with the one that fills resolved. Exported for tests. */
export function readSplitPanes(panes: unknown): SplitPaneEntry[] {
  if (!Array.isArray(panes)) return [];
  const seen = new Set<string>();
  const out: (SplitPaneEntry & { ownMin: number | undefined })[] = [];
  for (const entry of panes) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const size = positive(field(entry, "defaultSize"), LIMIT_PX);
    const rawMin = field(entry, "minSize");
    const ownMin =
      typeof rawMin === "number" && Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= LIMIT_PX
        ? rawMin
        : undefined;
    const min = ownMin ?? SG_MIN_PX;
    const max = Math.max(min, positive(field(entry, "maxSize"), LIMIT_PX) ?? LIMIT_PX);
    out.push({
      id,
      content: field(entry, "content"),
      defaultSize: Math.min(Math.max(size ?? SG_DEFAULT_PX, min), max),
      sized: size !== undefined,
      fill: field(entry, "fill") === true,
      min,
      ownMin,
      max,
      collapsible: field(entry, "collapsible") === true,
      defaultCollapsed: field(entry, "defaultCollapsed") === true,
      handleLabel: nonEmpty(field(entry, "handleLabel")) ?? "Resize pane",
    });
  }
  let fill = out.findIndex((pane) => pane.fill);
  if (fill < 0) fill = out.findIndex((pane) => !pane.sized);
  if (fill < 0) fill = out.length - 1;
  return out.map(({ ownMin, ...pane }, index) =>
    index === fill
      ? // A filling pane is held only by its own floor, which defaults to none.
        { ...pane, fill: true, collapsible: false, defaultCollapsed: false, min: ownMin ?? 0 }
      : { ...pane, fill: false }
  );
}

interface SplitDragState {
  id: string;
  size: number;
  collapsed: boolean;
}

function readLayout(value: unknown): PluginSplitLayout {
  const sizes: Record<string, number> = {};
  const collapsed: string[] = [];
  if (typeof value === "object" && value !== null) {
    const rawSizes = field(value, "sizes");
    if (typeof rawSizes === "object" && rawSizes !== null) {
      for (const [id, size] of Object.entries(rawSizes)) {
        // A folded-to-zero pane is a size too; the pane's limits clamp it.
        if (typeof size === "number" && Number.isFinite(size) && size >= 0 && size <= LIMIT_PX) {
          sizes[id] = size;
        }
      }
    }
    const rawCollapsed = field(value, "collapsed");
    if (Array.isArray(rawCollapsed)) {
      for (const id of rawCollapsed) if (typeof id === "string") collapsed.push(id);
    }
  }
  return { sizes, collapsed };
}

/**
 * A mouse drag along one axis from `origin`, reported at most once a frame as
 * travel in px and once more on release (`null` when the pointer never
 * moved). A release outside the window or a lost window ends it. Returns the
 * cancel.
 */
function trackSplitDrag(
  horizontal: boolean,
  origin: number,
  on: { frame: (travel: number) => void; end: (travel: number | null) => void }
): () => void {
  let latest: number | null = null;
  let frame = 0;
  let scheduled = false;
  const body = document.body.style;
  const previousCursor = body.cursor;
  const previousSelect = body.userSelect;
  body.cursor = horizontal ? "col-resize" : "row-resize";
  body.userSelect = "none";
  const move = (event: MouseEvent) => {
    if (event.buttons === 0) {
      finish();
      return;
    }
    latest = (horizontal ? event.clientX : event.clientY) - origin;
    if (scheduled) return;
    scheduled = true;
    frame = requestAnimationFrame(() => {
      scheduled = false;
      if (latest !== null) on.frame(latest);
    });
  };
  const cleanup = () => {
    if (scheduled) cancelAnimationFrame(frame);
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", finish);
    window.removeEventListener("blur", finish);
    body.cursor = previousCursor;
    body.userSelect = previousSelect;
  };
  function finish() {
    cleanup();
    on.end(latest);
  }
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", finish);
  window.addEventListener("blur", finish);
  return cleanup;
}

// A sized pane gives way (to its floor) when the group is too small for every
// pane's size; the filling pane takes what is left, down to its own floor.
function splitPaneStyle(pane: SplitPaneEntry, size: number, horizontal: boolean): CSSProperties {
  if (pane.fill) {
    return horizontal
      ? { flex: "1 1 0", minWidth: pane.min }
      : { flex: "1 1 0", minHeight: pane.min };
  }
  const floor = Math.min(pane.min, size);
  return horizontal
    ? { flex: `0 1 ${size}px`, width: size, minWidth: floor }
    : { flex: `0 1 ${size}px`, height: size, minHeight: floor };
}

function splitGrowKey(horizontal: boolean, beforeFill: boolean): SplitterGrowKey {
  if (horizontal) return beforeFill ? "ArrowRight" : "ArrowLeft";
  return beforeFill ? "ArrowDown" : "ArrowUp";
}

// Each sized pane owns the one handle on its side facing the filling pane, so
// every boundary has exactly one handle and dragging it moves only that pane.
function KitSplitGroup({
  panes,
  orientation,
  persistKey,
  collapsed,
  onCollapsedChange,
  onLayoutChange,
  className,
  ...rest
}: PluginSplitGroupProps) {
  const baseId = useId();
  const horizontal = oneOf(orientation, ["horizontal", "vertical"] as const) !== "vertical";
  const entries = readSplitPanes(panes);
  const fillIndex = entries.findIndex((pane) => pane.fill);
  const key = nonEmpty(persistKey);
  const initialLayout = (): PluginSplitLayout => ({
    sizes: {},
    collapsed: entries.filter((pane) => pane.defaultCollapsed).map((pane) => pane.id),
  });
  const [stored, setStored] = usePersistentViewState<PluginSplitLayout>(
    viewStateKey("splitGroup", key),
    initialLayout
  );
  const [own, setOwn] = useState<PluginSplitLayout>(initialLayout);
  const saved = key ? readLayout(stored) : own;
  const layout: PluginSplitLayout = {
    sizes: saved.sizes,
    collapsed: readIds(collapsed) ?? saved.collapsed,
  };
  const [drag, setDrag] = useState<SplitDragState | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const groupSize = useElementSize(root);
  const axis = horizontal ? "horizontal" : "vertical";
  const cleanupRef = useRef<(() => void) | null>(null);
  const handleCollapsedChange = fn(onCollapsedChange);
  const handleLayoutChange = fn(onLayoutChange);

  useEffect(() => () => cleanupRef.current?.(), []);

  // Own keys only: a pane id like "constructor" must not read the prototype.
  const sizeOf = (pane: SplitPaneEntry) => {
    const saved = Object.hasOwn(layout.sizes, pane.id) ? layout.sizes[pane.id] : undefined;
    const size = typeof saved === "number" && Number.isFinite(saved) ? saved : pane.defaultSize;
    return Math.min(Math.max(size, pane.min), pane.max);
  };
  const isCollapsed = (pane: SplitPaneEntry) =>
    pane.collapsible && layout.collapsed.includes(pane.id);

  const commit = (pane: SplitPaneEntry, next: { size: number; collapsed: boolean }) => {
    const wasCollapsed = isCollapsed(pane);
    const sizes = next.collapsed ? layout.sizes : { ...layout.sizes, [pane.id]: next.size };
    const collapsedIds =
      next.collapsed === wasCollapsed
        ? layout.collapsed
        : next.collapsed
          ? [...layout.collapsed, pane.id]
          : layout.collapsed.filter((id) => id !== pane.id);
    const nextLayout = { sizes, collapsed: collapsedIds };
    if (key) setStored(nextLayout);
    else setOwn(nextLayout);
    if (next.collapsed !== wasCollapsed) handleCollapsedChange?.(collapsedIds);
    handleLayoutChange?.(nextLayout);
  };

  const paneElementId = (index: number) => `${baseId}pane-${index}`;

  // The most a pane can take: its max, or what the group leaves once every
  // other pane has its size and the filling pane its floor.
  const roomFor = (index: number): number => {
    const pane = entries[index];
    if (!pane) return LIMIT_PX;
    const total = horizontal ? groupSize.width : groupSize.height;
    if (total <= 0) return pane.max;
    let others = 0;
    entries.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (other.fill) others += other.min;
      else others += SG_TRACK_PX[axis] + (isCollapsed(other) ? 0 : sizeOf(other));
    });
    return Math.max(pane.min, Math.min(pane.max, total - others - SG_TRACK_PX[axis]));
  };

  // A drag starts from what is drawn, so its limit is what the drawn panes
  // leave: siblings a small group squeezed below their size count as drawn.
  const drawnRoomFor = (index: number): number => {
    const pane = entries[index];
    if (!pane) return LIMIT_PX;
    const total = horizontal ? groupSize.width : groupSize.height;
    if (total <= 0) return pane.max;
    let others = SG_TRACK_PX[axis];
    entries.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (other.fill) {
        others += other.min;
        return;
      }
      others += SG_TRACK_PX[axis];
      if (isCollapsed(other)) return;
      const rect = document.getElementById(paneElementId(otherIndex))?.getBoundingClientRect();
      const drawn = rect ? (horizontal ? rect.width : rect.height) : 0;
      others += drawn > 0 ? drawn : sizeOf(other);
    });
    return Math.max(pane.min, Math.min(pane.max, total - others));
  };

  const startDrag = (index: number, event: ReactMouseEvent<HTMLDivElement>) => {
    const found = entries[index];
    if (!found || event.button !== 0 || event.detail > 1) return;
    const pane: SplitPaneEntry = found;
    event.preventDefault();
    const beforeFill = index < fillIndex;
    const el = document.getElementById(paneElementId(index));
    const rect = el?.getBoundingClientRect();
    const drawn = rect ? (horizontal ? rect.width : rect.height) : 0;
    const startSize = isCollapsed(pane) ? 0 : drawn > 0 ? drawn : sizeOf(pane);
    const room = drawnRoomFor(index);
    const settle = (travel: number) => {
      const raw = startSize + (beforeFill ? travel : -travel);
      return pane.collapsible && raw < pane.min / 2
        ? { size: sizeOf(pane), collapsed: true }
        : { size: Math.min(Math.max(raw, pane.min), room), collapsed: false };
    };
    cleanupRef.current?.();
    cleanupRef.current = trackSplitDrag(horizontal, horizontal ? event.clientX : event.clientY, {
      frame: (travel) => setDrag({ id: pane.id, ...settle(travel) }),
      end: (travel) => {
        cleanupRef.current = null;
        setDrag(null);
        if (travel !== null) commit(pane, settle(travel));
      },
    });
  };
  const handleKey = (index: number, event: KeyboardEvent<HTMLDivElement>) => {
    const pane = entries[index];
    if (!pane) return;
    const growKey = splitGrowKey(horizontal, index < fillIndex);
    const folded = isCollapsed(pane);
    // From what is drawn, as a drag is: in a squeezed group the saved size is
    // larger than the pane, and a step from it would move the wrong way.
    const rect = document.getElementById(paneElementId(index))?.getBoundingClientRect();
    const drawn = rect ? Math.round(horizontal ? rect.width : rect.height) : 0;
    const current = drawn > 0 ? Math.min(drawn, sizeOf(pane)) : sizeOf(pane);
    const room = Math.max(current, drawnRoomFor(index));
    const result = resolveSplitterKey(event, {
      growKey,
      value: folded ? 0 : current,
      min: pane.min,
      max: room,
      step: SG_STEP_PX,
      largeStep: SG_LARGE_STEP_PX,
    });
    if (!result) return;
    event.preventDefault();
    if (result.kind === "set") {
      // Shrinking a folded pane has nowhere to go; growing it brings it back
      // at the size it had.
      if (folded) {
        if (isShrinkKey(event.key, growKey)) return;
        const size = event.key === "End" ? result.value : Math.min(sizeOf(pane), room);
        commit(pane, { size, collapsed: false });
        return;
      }
      // Already at the limit the key asks for: nothing to commit.
      if (result.value === current) return;
      commit(pane, { size: result.value, collapsed: false });
    } else if (pane.collapsible) {
      commit(pane, { size: Math.min(sizeOf(pane), room), collapsed: !folded });
    } else {
      commit(pane, { size: Math.min(pane.defaultSize, room), collapsed: false });
    }
  };

  // What each pane is drawn at: a group too small for every size squeezes the
  // sized panes, and a handle must report the size the reader sees.
  const [drawnSizes, setDrawnSizes] = useState<Record<string, number>>({});
  const layoutKey = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!root) return;
    const next: Record<string, number> = {};
    // Own panes only: a nested SplitGroup's panes reuse the same ids.
    for (const el of root.querySelectorAll<HTMLElement>(":scope > [data-split-group-pane]")) {
      const id = el.dataset.splitGroupPane;
      const rect = el.getBoundingClientRect();
      const extent = Math.round(horizontal ? rect.width : rect.height);
      if (id && extent > 0) next[id] = extent;
    }
    setDrawnSizes((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    );
  }, [root, groupSize, horizontal, layoutKey]);

  // A pane folded from outside (a toolbar toggle, a narrow layout) while focus
  // was in it hands focus to its handle, the control that brings it back.
  const focusedPane = useRef<string | null>(null);
  const collapsedKey = layout.collapsed.join("|");
  useLayoutEffect(() => {
    const id = focusedPane.current;
    if (id === null || !root || !collapsedKey.split("|").includes(id)) return;
    // Hiding an element does not move focus off it until the browser's
    // focus fixup runs, so focus still inside the folded pane counts as lost.
    const active = document.activeElement;
    const pane = [...root.querySelectorAll<HTMLElement>(":scope > [data-split-group-pane]")].find(
      (candidate) => candidate.dataset.splitGroupPane === id
    );
    const lost = active === null || active === document.body || (pane?.contains(active) ?? false);
    if (!lost) return;
    focusedPane.current = null;
    const handle = [...root.querySelectorAll<HTMLElement>(":scope > [data-split-handle-for]")].find(
      (candidate) => candidate.dataset.splitHandleFor === id
    );
    handle?.focus({ preventScroll: true });
  }, [collapsedKey, root]);

  const children: ReactNode[] = [];
  entries.forEach((pane, index) => {
    const dragging = drag?.id === pane.id ? drag : null;
    const folded = dragging ? dragging.collapsed : isCollapsed(pane);
    const size = dragging ? dragging.size : sizeOf(pane);
    const drawnSize = Object.hasOwn(drawnSizes, pane.id) ? drawnSizes[pane.id] : undefined;
    const shown = dragging || drawnSize === undefined ? size : Math.min(size, drawnSize);
    const handle = pane.fill ? null : (
      <ResizeHandle
        key={`handle-${pane.id}`}
        growKey={splitGrowKey(horizontal, index < fillIndex)}
        edge="inline"
        label={pane.handleLabel}
        value={folded ? 0 : shown}
        min={pane.collapsible ? 0 : pane.min}
        max={Math.max(shown, roomFor(index))}
        isResizing={dragging !== null}
        aria-controls={paneElementId(index)}
        data-split-handle-for={pane.id}
        aria-valuetext={folded ? "Collapsed" : `${Math.round(shown)} pixels`}
        className="z-10"
        onMouseDown={(event) => startDrag(index, event)}
        onKeyDown={(event) => handleKey(index, event)}
        onReset={() =>
          commit(pane, { size: Math.min(pane.defaultSize, roomFor(index)), collapsed: false })
        }
      />
    );
    const style = splitPaneStyle(pane, size, horizontal);
    if (index > fillIndex && handle) children.push(handle);
    children.push(
      <div
        key={pane.id}
        id={paneElementId(index)}
        data-split-group-pane={pane.id}
        onFocus={() => {
          focusedPane.current = pane.id;
        }}
        data-collapsed={folded ? "true" : undefined}
        style={folded ? undefined : style}
        className={cn(
          "relative min-h-0 min-w-0 overflow-hidden",
          folded ? "hidden" : "flex flex-col"
        )}
      >
        {node(pane.content)}
      </div>
    );
    if (index < fillIndex && handle) children.push(handle);
  });

  return (
    <div
      {...pickRootProps(rest)}
      ref={setRoot}
      data-split-group={axis}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-1",
        horizontal ? "flex-row" : "flex-col",
        str(className)
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector

const INSPECTOR_LABEL_DEFAULT_PX = 88;

// The label column is a luxury of a wide inspector: below 240px it costs the
// control most of its room, so the label goes above its value instead.
function KitInspector({
  children,
  "aria-label": ariaLabel,
  labelWidth,
  className,
  ...rest
}: PluginInspectorProps) {
  const label = nonEmpty(ariaLabel);
  const labelPx = positive(labelWidth, 400) ?? INSPECTOR_LABEL_DEFAULT_PX;
  const style: CSSProperties & Record<`--${string}`, string> = {
    "--kit-inspector-label": `${labelPx}px`,
  };
  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      {...(label ? { role: "region", "aria-label": label } : {})}
      data-inspector=""
      style={style}
      className={cn("@container/inspector flex min-w-0 flex-col", str(className))}
    >
      {node(children)}
    </div>
  );
}

function KitInspectorSection({
  title,
  children,
  collapsible,
  open,
  defaultOpen,
  onOpenChange,
  actions,
  className,
  ...rest
}: PluginInspectorSectionProps) {
  const baseId = useId();
  const canFold = collapsible !== false;
  const [ownOpen, setOwnOpen] = useState(defaultOpen !== false);
  const isOpen = !canFold || (typeof open === "boolean" ? open : ownOpen);
  const change = fn(onOpenChange);
  const heading = str(title) ?? "";
  const bodyId = `${baseId}body`;
  const headingId = `${baseId}heading`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Folded from outside (a controlled `open`) while a field in it had focus:
  // the hidden field keeps focus until the browser's fixup, so move it to the
  // heading that brings the rows back.
  useLayoutEffect(() => {
    if (isOpen) return;
    const active = document.activeElement;
    if (active !== null && (bodyRef.current?.contains(active) ?? false)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen]);
  return (
    <section
      {...pickRootProps(rest)}
      aria-labelledby={headingId}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "flex min-w-0 flex-col border-t border-divider first:border-t-0",
        str(className)
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 pr-1.5 pl-3">
        <h3 id={headingId} className="m-0 flex min-w-0 flex-1">
          {canFold ? (
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={() => {
                setOwnOpen(!isOpen);
                change?.(!isOpen);
              }}
              className={cn(
                "-ml-1.5 flex h-6 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-sm)] pl-1.5 text-left",
                "transition-[background-color] duration-150 ease-out hover:bg-overlay-subtle",
                "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
                  isOpen && "rotate-90"
                )}
              />
              <span className={cn(SECTION_LABEL_CLASS, "min-w-0 truncate")}>{heading}</span>
            </button>
          ) : (
            <span className={cn(SECTION_LABEL_CLASS, "min-w-0 truncate")}>{heading}</span>
          )}
        </h3>
        {hasContent(actions) ? (
          <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
        ) : null}
      </div>
      {/* Folded, the rows stay mounted and hidden: the heading's control
          target always exists, and a half-edited field keeps its value. */}
      <div
        ref={bodyRef}
        id={bodyId}
        hidden={!isOpen}
        className={cn("min-w-0 flex-col px-3 pb-2", isOpen ? "flex" : "hidden")}
      >
        {node(children)}
      </div>
    </section>
  );
}

// Wide, the label sits in a fixed column beside the value at a 28px row the
// eye can count; narrow (or outside an Inspector), above it.
const PROPERTY_ROW_GRID =
  "grid min-h-7 grid-cols-1 gap-x-2 gap-y-0.5 py-0.5 @[240px]/inspector:grid-cols-[var(--kit-inspector-label,88px)_minmax(0,1fr)] @[240px]/inspector:gap-y-0";

function KitPropertyRow({
  label,
  children,
  htmlFor,
  hint,
  align,
  className,
  ...rest
}: PluginPropertyRowProps) {
  const top = oneOf(align, ["center", "start"] as const) === "start";
  const text = str(label) ?? "";
  const plain = typeof children === "string" || typeof children === "number";
  const note = hasContent(hint) ? (
    <span className="shrink-0 text-2xs text-text-secondary">{node(hint)}</span>
  ) : null;
  const valueClass = cn(
    "flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-text-primary",
    top && "@[240px]/inspector:items-start"
  );
  const rowClass = cn(PROPERTY_ROW_GRID, top ? "items-start" : "items-center", str(className));
  const labelCell = (labelNode: ReactNode) => (
    <div className={cn("flex min-w-0 items-center gap-1", top && "@[240px]/inspector:min-h-6")}>
      {labelNode}
      {note}
    </div>
  );
  // Read-only text has no control to label: the pair is a term and its value.
  if (plain || !hasContent(children)) {
    return (
      <div {...pickRootProps(rest)} data-property-row="" className={rowClass}>
        {labelCell(<span className="min-w-0 truncate text-xs text-text-secondary">{text}</span>)}
        <div className={cn(valueClass, "select-text")}>
          {hasContent(children) ? (
            <span className="min-w-0 break-words">{node(children)}</span>
          ) : (
            <>
              <span aria-hidden="true" className="text-text-secondary">
                —
              </span>
              <span className="sr-only">None</span>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <Field
      {...pickRootProps(rest)}
      data-property-row=""
      controlId={nonEmpty(htmlFor)}
      className={rowClass}
    >
      <FieldLabel accessory={note} className="min-w-0 truncate text-xs text-text-secondary">
        {text}
      </FieldLabel>
      <div data-field-control="" className={valueClass}>
        {node(children)}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Drawer

const DRAWER_DEFAULT_PX = 320;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

// Whether the user's last input was a pointer press rather than a key, read
// when a drawer moves focus: one listener pair for the whole document.
let pointerLast = false;
let tracking = false;
function lastInputWasPointer(): boolean {
  return pointerLast;
}
function trackLastInput(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("pointerdown", () => (pointerLast = true), true);
  document.addEventListener("keydown", () => (pointerLast = false), true);
}

/** What Tab can reach inside `root`: not inert, not hidden, not taken out of the order. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el instanceof HTMLInputElement && el.type === "hidden") &&
      !el.closest("[inert],[hidden],[aria-hidden='true']") &&
      // Unrendered (display: none up the tree); absent where the DOM has no layout.
      (typeof el.checkVisibility !== "function" || el.checkVisibility())
  );
}

const DRAWER_EDGE_CLASS: Record<Side, string> = {
  right: "inset-y-0 right-0 border-l",
  left: "inset-y-0 left-0 border-r",
  top: "inset-x-0 top-0 border-b",
  bottom: "inset-x-0 bottom-0 border-t",
};

const DRAWER_HIDDEN_CLASS: Record<Side, string> = {
  right: "translate-x-full",
  left: "-translate-x-full",
  top: "-translate-y-full",
  bottom: "translate-y-full",
};

// A push drawer sits beside the content, on its side of the row or column.
const DRAWER_FLOW_CLASS: Record<Side, string> = {
  right: "flex-row",
  left: "flex-row-reverse",
  top: "flex-col-reverse",
  bottom: "flex-col",
};

function KitDrawer({
  open,
  onOpenChange,
  children,
  panel,
  title,
  "aria-label": ariaLabel,
  actions,
  footer,
  side,
  mode,
  modal,
  size,
  panelId,
  className,
  ...rest
}: PluginDrawerProps) {
  const baseId = useId();
  const isOpen = open === true;
  const edge = oneOf(side, SIDES) ?? "right";
  const vertical = edge === "top" || edge === "bottom";
  const push = oneOf(mode, ["overlay", "push"] as const) === "push";
  const isModal = !push && modal !== false;
  const px = positive(size, 4096) ?? DRAWER_DEFAULT_PX;
  const id = nonEmpty(panelId) ?? `${baseId}drawer`;
  const titleId = `${baseId}title`;
  const change = fn(onOpenChange);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const pointerClose = useRef(false);
  const openedAtMount = useRef(isOpen);

  useEffect(() => trackLastInput(), []);
  const titleText = str(title);
  const name = nonEmpty(ariaLabel) ?? (titleText ? undefined : "Drawer");

  const close = (byPointer: boolean) => {
    pointerClose.current = byPointer;
    change?.(false);
  };

  // Opening takes focus into the drawer (its first control when modal, else
  // the drawer itself); closing hands it back to what had it, ringless after
  // a pointer close, as the host's overlays do.
  // Read before focus fixup can move focus off an opener the open drawer
  // has just made inert.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    returnTo.current =
      active instanceof HTMLElement && !(panelRef.current?.contains(active) ?? false)
        ? active
        : null;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      openedAtMount.current = false;
      return;
    }
    const panelEl = panelRef.current;
    // A drawer restored open with its view has nothing to answer: focus stays
    // where the view put it until the user opens a drawer themselves.
    const restored = openedAtMount.current;
    openedAtMount.current = false;
    if (!restored && panelEl && !panelEl.contains(document.activeElement)) {
      // The body's first control, not the header's Close: a drawer opens to
      // be used, and Escape already closes it.
      const body = panelEl.querySelector<HTMLElement>("[data-drawer-body]");
      const first = isModal
        ? ((body ? focusablesIn(body)[0] : undefined) ?? focusablesIn(panelEl)[0])
        : undefined;
      // Opened from a click, focus lands without a ring, as the host's
      // overlays do; opened from the keyboard, the ring shows where it went.
      (first ?? panelEl).focus({ preventScroll: true, focusVisible: !lastInputWasPointer() });
    }
    return () => {
      const now = document.activeElement;
      const inside = now === null || now === document.body || (panelEl?.contains(now) ?? false);
      const target = returnTo.current;
      if (inside && target?.isConnected) {
        // The opener's tooltip must not open on focus handed back to it.
        armTooltipFocusSuppression();
        target.focus({ preventScroll: true, focusVisible: !pointerClose.current });
      }
      pointerClose.current = false;
    };
  }, [isOpen, isModal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      return;
    }
    if (event.key !== "Tab" || !isModal) return;
    const items = focusablesIn(event.currentTarget);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const extent: CSSProperties = vertical
    ? { height: px, maxHeight: "90%" }
    : { width: px, maxWidth: "90%" };
  const header = hasContent(title) ? (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider pr-1.5 pl-3">
      <h2
        id={titleId}
        className="m-0 min-w-0 flex-1 truncate text-xs font-medium text-text-primary"
      >
        {node(title)}
      </h2>
      {hasContent(actions) ? (
        <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
      ) : null}
      <DismissButton
        aria-label={titleText ? `Close ${titleText}` : "Close drawer"}
        tooltip="Close"
        onClick={(event) => close(event.detail > 0)}
      />
    </div>
  ) : null;
  const drawer = (
    <div
      ref={panelRef}
      id={id}
      role={isModal ? "dialog" : "complementary"}
      aria-labelledby={name ? undefined : titleId}
      aria-label={name}
      tabIndex={-1}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      data-drawer-panel={edge}
      onKeyDown={handleKeyDown}
      style={extent}
      className={cn(
        "flex min-h-0 min-w-0 flex-col text-text-primary",
        PROGRAMMATIC_FOCUS_RING,
        push
          ? cn(
              "relative shrink-0 border-divider bg-surface-panel",
              { right: "border-l", left: "border-r", top: "border-b", bottom: "border-t" }[edge],
              !isOpen && "hidden"
            )
          : cn(
              "absolute z-20 border-border-default bg-surface-panel-elevated",
              isModal ? OVERLAY_SHEET_SHADOW_CLASS : "shadow-[var(--theme-shadow-floating)]",
              DRAWER_EDGE_CLASS[edge],
              // Visibility rides the slide, so a closing drawer stays painted
              // until it is off the edge and then leaves the tab order.
              "transition-[translate,visibility] ease-out motion-reduce:transition-none",
              isOpen
                ? "visible duration-200"
                : cn("invisible duration-[120ms]", DRAWER_HIDDEN_CLASS[edge])
            )
      )}
    >
      {header}
      <ScrollShadow
        data-drawer-body=""
        className="min-h-0 flex-1"
        scrollClassName="flex min-w-0 flex-col"
      >
        {node(panel)}
      </ScrollShadow>
      {hasContent(footer) ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-divider px-3 py-2">
          {node(footer)}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      {...pickRootProps(rest)}
      data-drawer-mode={push ? "push" : "overlay"}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden",
        push ? DRAWER_FLOW_CLASS[edge] : "flex-col",
        str(className)
      )}
    >
      <div
        data-drawer-content=""
        inert={isModal && isOpen}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {node(children)}
      </div>
      {isModal ? (
        <div
          aria-hidden="true"
          data-drawer-scrim=""
          onMouseDown={(event) => {
            if (event.button === 0) close(true);
          }}
          className={cn(
            // The dialog scrim on dark themes, where the soft step barely moves
            // the page; light themes read a layer from the soft step already.
            "absolute inset-0 z-10 bg-scrim-medium [.light_&]:bg-scrim-soft transition-opacity ease-out motion-reduce:transition-none",
            isOpen ? "opacity-100 duration-200" : "pointer-events-none opacity-0 duration-[120ms]"
          )}
        />
      ) : null}
      {drawer}
    </div>
  );
}

const DRAWER_GLYPHS = {
  right: [PanelRightOpen, PanelRightClose],
  left: [PanelLeftOpen, PanelLeftClose],
  top: [PanelTopOpen, PanelTopClose],
  bottom: [PanelBottomOpen, PanelBottomClose],
} as const;

// The name is the drawer, not the next action, so it holds still while the
// state travels on `aria-expanded`.
function KitDrawerToggle({
  open,
  onOpenChange,
  label,
  controls,
  icon,
  side,
  showLabel,
  badge,
  disabled,
  className,
  ...rest
}: PluginDrawerToggleProps) {
  const overlayZ = useKitOverlayZClass();
  const isOpen = open === true;
  const change = fn(onOpenChange);
  const name = str(label) ?? "";
  const count = wholeCount(badge);
  const [OpenGlyph, CloseGlyph] = DRAWER_GLYPHS[oneOf(side, SIDES) ?? "right"];
  const Glyph = isOpen ? CloseGlyph : OpenGlyph;
  const glyph =
    icon !== undefined ? (
      sizedIcon(icon, PANE_TOOLBAR_ICON_CLASS)
    ) : (
      <Glyph aria-hidden="true" className={PANE_TOOLBAR_ICON_CLASS} />
    );
  const withLabel = showLabel === true;
  const badgeNode =
    count !== undefined && count > 0 ? <CountBadge aria-hidden="true">{count}</CountBadge> : null;
  const button = (
    <button
      {...pickRootProps(rest)}
      type="button"
      aria-label={withLabel ? undefined : count ? `${name} (${count})` : name}
      aria-expanded={isOpen}
      aria-controls={nonEmpty(controls)}
      disabled={disabled === true}
      onClick={() => change?.(!isOpen)}
      className={cn(
        withLabel ? PANE_TOOLBAR_TEXT_BUTTON_CLASS : PANE_TOOLBAR_ICON_BUTTON_CLASS,
        !withLabel && badgeNode && "gap-1 pr-1",
        str(className)
      )}
    >
      {glyph}
      {withLabel ? <span>{name}</span> : null}
      {badgeNode}
    </button>
  );
  if (withLabel || name === "") return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// GroupedVirtualList

const GL_ROW_PX = 28;
const GL_OVERSCAN_ROWS = 8;
const SCROLLER_RING_INSET = "focus-visible:-outline-offset-2";

interface GroupEntry {
  id: string;
  label: string;
  items: readonly unknown[];
  count: number | null;
  source: PluginListGroup<unknown>;
}

function readGroups(groups: unknown): GroupEntry[] {
  if (!Array.isArray(groups)) return [];
  const seen = new Set<string>();
  const out: GroupEntry[] = [];
  for (const entry of groups) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const items = field(entry, "items");
    const list: readonly unknown[] = Array.isArray(items) ? items : [];
    const count = field(entry, "count");
    out.push({
      id,
      label: str(field(entry, "label")) ?? "",
      items: list,
      count: count === false ? null : (wholeCount(count) ?? list.length),
      source: {
        id,
        label: str(field(entry, "label")) ?? "",
        items: list,
        count: count === false ? false : (wholeCount(count) ?? list.length),
      },
    });
  }
  return out;
}

function readIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : undefined;
}

interface GroupedContext {
  listProps: Record<string, unknown>;
  listFocusable: boolean;
  itemRole: "listitem" | "none";
  identity: Record<string, string | number | boolean>;
  footer: ReactNode;
}

function GroupedScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: GroupedContext; ref?: Ref<HTMLDivElement> }) {
  if (!context.listFocusable) return <div {...props} ref={ref} tabIndex={0} />;
  return <div {...context.listProps} {...props} {...context.identity} ref={ref} />;
}

// Virtuoso draws this twice: the rows, and a copy holding the sticky header
// of the group at the top. Only the rows are the list.
function GroupedListElement({
  context,
  ref,
  style,
  children,
  ...props
}: ListProps & { context: GroupedContext; ref?: Ref<HTMLDivElement> }) {
  const top = Reflect.get(props, "data-testid") === "virtuoso-top-item-list";
  const listProps = context.listFocusable || top ? undefined : context.listProps;
  return (
    <div {...(top ? { role: "none" } : listProps)} ref={ref} style={style}>
      {children}
    </div>
  );
}

function GroupedItem({
  context,
  item: _item,
  ...props
}: ItemProps<unknown> & { context: GroupedContext }) {
  return <div {...props} role={context.itemRole} />;
}

// Virtuoso's group wrapper carries the sticky position; it is not a row.
function GroupedGroup({ context: _context, ...props }: GroupProps & { context: GroupedContext }) {
  return <div {...props} role="none" />;
}

// The sticky copy of the current group's header sits in its own layer above
// the rows; it is presentation, and the header in the flow is the one read.
function GroupedTopItemList({
  context: _context,
  ...props
}: TopItemListProps & { context: GroupedContext }) {
  return <div {...props} role="none" />;
}

function GroupedFooter({ context }: { context: GroupedContext }) {
  return hasContent(context.footer) ? <div role="none">{context.footer}</div> : null;
}

const GROUPED_COMPONENTS = {
  Scroller: GroupedScroller,
  List: GroupedListElement,
  Item: GroupedItem,
  Group: GroupedGroup,
  TopItemList: GroupedTopItemList,
  Footer: GroupedFooter,
};

/** Each group's first row index across the drawn list. Exported for tests. */
export function groupOffsets(counts: readonly number[]): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const count of counts) {
    offsets.push(running);
    running += count;
  }
  return offsets;
}

function KitGroupedVirtualList(props: PluginGroupedVirtualListProps) {
  const {
    groups,
    renderItem,
    itemKey,
    collapsible,
    collapsedGroups,
    defaultCollapsedGroups,
    onCollapsedGroupsChange,
    footer,
    empty,
    estimatedItemSize,
    overscan,
    onEndReached,
    activeIndex,
    shadows,
    className,
    ...rest
  } = props;
  const entries = readGroups(groups);
  const render = fn(renderItem);
  const keyOf = fn(itemKey);
  const endReached = fn(onEndReached);
  const canFold = collapsible === true;
  const [ownCollapsed, setOwnCollapsed] = useState<string[]>(
    () => readIds(defaultCollapsedGroups) ?? []
  );
  const folded = canFold ? (readIds(collapsedGroups) ?? ownCollapsed) : [];
  const change = fn(onCollapsedGroupsChange);
  const counts = entries.map((group) => (folded.includes(group.id) ? 0 : group.items.length));
  const offsets = groupOffsets(counts);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const rowPx = positive(estimatedItemSize, 10_000) ?? GL_ROW_PX;
  const overscanRows =
    typeof overscan === "number" && Number.isFinite(overscan)
      ? Math.max(0, Math.floor(overscan))
      : GL_OVERSCAN_ROWS;
  const { style: _style, ref: _ref, ...dom } = pickDomProps(rest);
  const role = str(dom.role);
  const handle = useRef<GroupedVirtuosoHandle>(null);
  const target =
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < total
      ? activeIndex
      : -1;
  useEffect(() => {
    if (target >= 0) handle.current?.scrollIntoView({ index: target });
  }, [target]);

  const toggle = (id: string) => {
    const next = folded.includes(id) ? folded.filter((entry) => entry !== id) : [...folded, id];
    setOwnCollapsed(next);
    change?.(next);
  };

  // Called either way (hooks), but only wired to the scroller when asked for.
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();
  const withShadows = shadows === true;

  const allEmpty = entries.every((group) => group.items.length === 0);
  if (allEmpty && hasContent(empty)) {
    return (
      <div {...pickRootProps(dom)} className={cn("flex h-full min-h-0 flex-col", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const context: GroupedContext = {
    listProps: { ...dom, role: role ?? "list" },
    listFocusable: typeof dom.tabIndex === "number" && dom.tabIndex >= 0,
    itemRole: role ? "none" : "listitem",
    identity: pickRootProps(dom),
    footer: node(footer),
  };

  const header = (groupIndex: number) => {
    const group = entries[groupIndex];
    if (!group) return null;
    const isFolded = folded.includes(group.id);
    const count =
      group.count === null ? null : (
        <span className="text-3xs font-medium text-text-secondary tabular-nums">{group.count}</span>
      );
    const label = <span className={cn(LIST_LABEL_CLASS, "min-w-0 truncate")}>{group.label}</span>;
    return (
      <div
        role="heading"
        aria-level={3}
        data-group-header={group.id}
        className="flex h-7 items-center border-b border-divider bg-surface px-3"
      >
        {canFold ? (
          <button
            type="button"
            aria-expanded={!isFolded}
            // A list's own Enter/Space (a keyboard listbox's select) must not
            // take the header's activation.
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            onClick={() => toggle(group.id)}
            className={cn(
              "-ml-1.5 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] pl-1.5 text-left",
              "transition-[background-color] duration-150 ease-out hover:bg-overlay-subtle",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
                !isFolded && "rotate-90"
              )}
            />
            {label}
            {count}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {label}
            {count}
          </span>
        )}
      </div>
    );
  };

  // Virtuoso keys headers and rows in one index space, a header before each
  // group's rows: find which one `position` is.
  const keyAt = (position: number): string | number => {
    let start = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const group = entries[i];
      const rows = counts[i] ?? 0;
      if (!group) break;
      // Headers and rows in separate namespaces, so no row key can equal a header's.
      if (position === start) return `header:${group.id}`;
      if (position <= start + rows) {
        const local = position - start - 1;
        const own = keyOf?.(group.items[local], group.source);
        return typeof own === "string" || (typeof own === "number" && Number.isFinite(own))
          ? `row:${own}`
          : `row:${group.id}:${local}`;
      }
      start += rows + 1;
    }
    return position;
  };

  const list = (
    <GroupedVirtuoso
      ref={handle}
      scrollerRef={
        withShadows ? (el) => shadowRef(el instanceof HTMLElement ? el : null) : undefined
      }
      className={cn(SCROLLER_RING_INSET, str(className))}
      style={{ height: "100%" }}
      context={context}
      components={GROUPED_COMPONENTS}
      groupCounts={counts}
      groupContent={header}
      defaultItemHeight={rowPx}
      increaseViewportBy={overscanRows * rowPx}
      computeItemKey={(position) => keyAt(position)}
      itemContent={(index, groupIndex) => {
        const group = entries[groupIndex];
        if (!group) return null;
        const item = group.items[index - (offsets[groupIndex] ?? 0)];
        return node(render?.(item, index, group.source));
      }}
      // Virtuoso counts the headers; the public index is the last drawn row's.
      endReached={endReached && total > 0 ? () => endReached(total - 1) : undefined}
    />
  );
  if (!withShadows) return list;
  return (
    <div className="relative h-full min-h-0">
      {topShadow}
      {bottomShadow}
      {list}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BulkActionBar

// It replaces a list's bottom band rather than stacking under it: same edge,
// same hairline, different contents.
function KitBulkActionBar({
  count,
  selection,
  noun,
  hiddenCount,
  actions,
  onClear,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginBulkActionBarProps) {
  const fromSelection = typeof selection === "object" && selection !== null ? selection : undefined;
  const selected = wholeCount(count) ?? wholeCount(fromSelection?.count) ?? 0;
  const clearSelection = fn(fromSelection?.clear);
  const clear = fn(onClear) ?? clearSelection;
  const hidden = wholeCount(hiddenCount) ?? 0;
  const visible = selected > 0;
  // Where focus came from when it entered the bar (the list, usually), and
  // whether it is inside the bar now: clearing takes the bar away, and focus
  // inside it would otherwise fall to the page.
  const cameFrom = useRef<HTMLElement | null>(null);
  const holdsFocus = useRef(false);

  useEffect(() => trackLastInput(), []);

  useLayoutEffect(() => {
    if (visible || !holdsFocus.current) return;
    holdsFocus.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = cameFrom.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true, focusVisible: !lastInputWasPointer() });
    }
  }, [visible]);

  if (!visible) return null;
  // The toolbar validates each action itself; the bar only asks for words.
  const items: PluginOverflowToolbarItem[] = Array.isArray(actions)
    ? actions.map((action: PluginBulkAction) => ({
        ...action,
        type: "action" as const,
        showLabel: true,
        tooltip: false as const,
      }))
    : [];
  const Toolbar = pluginKitLayoutCore.OverflowToolbar;
  const word = nounFor(noun, selected, "item");
  return (
    <div
      {...pickRootProps(rest)}
      role="group"
      aria-label={nonEmpty(ariaLabel) ?? "Bulk actions"}
      data-bulk-action-bar=""
      onFocus={(event) => {
        holdsFocus.current = true;
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) {
          cameFrom.current = from;
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) holdsFocus.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && clear) {
          event.preventDefault();
          clear();
        }
      }}
      className={cn(
        "flex h-9 min-w-0 shrink-0 items-center gap-2 border-t border-divider bg-surface pr-1.5 pl-3",
        str(className)
      )}
    >
      <span className="min-w-0 shrink truncate text-xs text-text-secondary tabular-nums">
        <span className="font-medium text-text-primary">{selected}</span> {word} selected
        {hidden > 0 ? ` · ${hidden} not shown` : ""}
      </span>
      {items.length > 0 ? (
        <Toolbar
          items={items}
          aria-label="Selection actions"
          className="min-w-0 flex-1 justify-end"
        />
      ) : (
        <span className="flex-1" />
      )}
      {clear ? (
        <DismissButton
          aria-label="Clear selection"
          tooltip="Clear selection"
          onClick={() => clear()}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoadMoreFooter

function KitLoadMoreFooter({
  status,
  onLoadMore,
  loadedCount,
  totalCount,
  noun,
  error,
  autoLoad,
  label,
  className,
  ...rest
}: PluginLoadMoreFooterProps) {
  const state = oneOf(status, ["idle", "loading", "error", "done"] as const) ?? "idle";
  const load = fn(onLoadMore);
  const loaded = wholeCount(loadedCount);
  const total = wholeCount(totalCount);
  const auto = autoLoad === true;
  const rootRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  const focusWasInside = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  });

  // A fresh observer each time the footer goes back to idle reports whether
  // it is still in view, so a page too short to push it out loads the next.
  useEffect(() => {
    const el = rootRef.current;
    if (!auto || state !== "idle" || !el || typeof IntersectionObserver === "undefined") return;
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired || !loadRef.current || !entries.some((entry) => entry.isIntersecting)) return;
        fired = true;
        loadRef.current?.();
      },
      { rootMargin: "0px 0px 160px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [auto, state]);

  // The button that had focus goes away when the list runs out or fails:
  // keep focus in the footer (on Retry, or the footer itself).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !focusWasInside.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && el.contains(active)) return;
    focusWasInside.current = false;
    const retry = el.querySelector<HTMLElement>("button");
    (retry ?? el).focus({ preventScroll: true });
  }, [state]);

  const word = (count: number) => nounFor(noun, count, "item");
  const progress =
    loaded !== undefined && total !== undefined && total > 0
      ? `${loaded.toLocaleString()} of ${total.toLocaleString()}`
      : undefined;
  let body: ReactNode;
  let spoken: string;
  if (state === "done") {
    const all = total ?? loaded;
    spoken =
      all !== undefined && all > 0
        ? `All ${all.toLocaleString()} ${word(all)} loaded`
        : "All loaded";
    body = <span>{spoken}</span>;
  } else if (state === "error") {
    const message = hasContent(error) ? node(error) : "Couldn't load more";
    spoken = typeof message === "string" ? message : "Couldn't load more";
    body = (
      <>
        <ErrorGlyph aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-status-error" />
        <span className="min-w-0 truncate">{message}</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={!load}
          onClick={() => load?.()}
          className="shrink-0"
        >
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </>
    );
  } else {
    spoken = state === "loading" ? "Loading more" : "";
    body = (
      <>
        <Button
          variant="ghost"
          size="xs"
          loading={state === "loading"}
          disabled={!load}
          onClick={() => load?.()}
        >
          {nonEmpty(label) ?? "Load more"}
        </Button>
        {progress ? <span className="tabular-nums">{progress}</span> : null}
      </>
    );
  }
  return (
    <div
      {...pickRootProps(rest)}
      ref={rootRef}
      tabIndex={-1}
      aria-busy={state === "loading" || undefined}
      data-load-more={state}
      onFocus={() => {
        focusWasInside.current = true;
      }}
      onBlur={(event) => {
        // A button that unmounts under focus blurs to nowhere; only focus
        // that moved somewhere else has left the footer.
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) focusWasInside.current = false;
      }}
      className={cn(
        "flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-1.5 text-xs text-text-secondary",
        PROGRAMMATIC_FOCUS_RING,
        str(className)
      )}
    >
      {body}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskList

const TASK_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;

const TASK_WORD: Record<PluginTaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Summary order: what is moving, what is waiting, what needs a look, then
// what has settled.
const TASK_SUMMARY_ORDER: PluginTaskStatus[] = [
  "running",
  "pending",
  "failed",
  "done",
  "cancelled",
];

interface TaskEntry {
  task: PluginTask;
  id: string;
  title: string;
  status: PluginTaskStatus;
  progress: number | null;
  started: number;
  finished: number;
  retryable: boolean;
  cancellable: boolean;
}

function readTasks(tasks: unknown, canRetry: boolean, canCancel: boolean): TaskEntry[] {
  if (!Array.isArray(tasks)) return [];
  const seen = new Set<string>();
  const out: TaskEntry[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const id = nonEmpty(field(task, "id"));
    const status = oneOf(field(task, "status"), TASK_STATUSES);
    if (id === undefined || status === undefined || seen.has(id)) continue;
    seen.add(id);
    const progress = field(task, "progress");
    const retryable = field(task, "retryable");
    const cancellable = field(task, "cancellable");
    out.push({
      task,
      id,
      title: str(field(task, "title")) ?? "",
      status,
      progress:
        typeof progress === "number" && Number.isFinite(progress)
          ? Math.min(1, Math.max(0, progress))
          : null,
      started: toTimestamp(field(task, "startedAt")),
      finished: toTimestamp(field(task, "finishedAt")),
      retryable:
        canRetry &&
        (status === "failed" || status === "cancelled") &&
        (typeof retryable === "boolean" ? retryable : true),
      cancellable:
        canCancel &&
        (status === "pending" || status === "running") &&
        (typeof cancellable === "boolean" ? cancellable : true),
    });
  }
  return out;
}

/** "2 running · 1 failed · 5 done", in the order a reader acts on. Exported for tests. */
export function taskSummary(statuses: readonly PluginTaskStatus[]): string {
  const counts = new Map<PluginTaskStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return TASK_SUMMARY_ORDER.filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${TASK_WORD[status].toLowerCase()}`)
    .join(" · ");
}

// Settled work is demoted to neutral (docs/themes/status-success-policy.md):
// only a failure keeps a status colour.
function TaskGlyph({ status }: { status: PluginTaskStatus }) {
  const glyph = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "running":
      return <Spinner size="sm" className="text-text-secondary" />;
    case "pending":
      return <CircleDashed aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
    case "done":
      return <CircleCheck aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
    case "failed":
      return <ErrorGlyph aria-hidden="true" className={cn(glyph, "text-status-error")} />;
    case "cancelled":
      return <CircleSlash aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
  }
}

function taskDuration(entry: TaskEntry, now: number): string | null {
  if (Number.isNaN(entry.started)) return null;
  if (entry.status === "running") return formatElapsedDuration(Math.max(0, now - entry.started));
  if (entry.status === "pending" || Number.isNaN(entry.finished)) return null;
  return formatElapsedDuration(Math.max(0, entry.finished - entry.started));
}

/** What a change of state says, for the list's live region; nothing while it moves. */
function taskOutcome(title: string, status: PluginTaskStatus): string | null {
  const name = title || "Task";
  if (status === "done") return `${name} finished`;
  if (status === "failed") return `${name} failed`;
  if (status === "cancelled") return `${name} cancelled`;
  return null;
}

/**
 * What changed between two renders of a task list, from the snapshot the
 * list serialises: each task's state now, and the outcomes worth saying.
 * Nothing is news on the first render. Exported for tests.
 */
export function taskNews(
  snapshot: string,
  previous: ReadonlyMap<string, PluginTaskStatus> | null
): { statuses: Map<string, PluginTaskStatus>; news: string; changed: boolean } {
  const statuses = new Map<string, PluginTaskStatus>();
  const messages: string[] = [];
  const rows: unknown = JSON.parse(snapshot);
  let changed = false;
  if (!Array.isArray(rows)) return { statuses, news: "", changed };
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id: unknown = row[0];
    const status = oneOf(row[1], TASK_STATUSES);
    const name: unknown = row[2];
    if (typeof id !== "string" || status === undefined) continue;
    statuses.set(id, status);
    const before = previous?.get(id);
    if (before === undefined || before === status) continue;
    changed = true;
    const message = taskOutcome(typeof name === "string" ? name : "", status);
    if (message) messages.push(message);
  }
  return { statuses, news: messages.join(". "), changed };
}

/** An icon-only row action: a 24px ghost button with its name as the tooltip. */
function TaskAction({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const overlayZ = useKitOverlayZClass();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="shrink-0 [&_svg]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function KitTaskList({
  tasks,
  "aria-label": ariaLabel,
  title,
  summary,
  actions,
  onRetry,
  onCancel,
  empty,
  className,
  ...rest
}: PluginTaskListProps) {
  const retry = fn(onRetry);
  const cancel = fn(onCancel);
  const entries = readTasks(tasks, retry !== undefined, cancel !== undefined);
  const ticking = entries.some(
    (entry) => entry.status === "running" && !Number.isNaN(entry.started)
  );
  // A second's clock only while something is running with a start time.
  const now = useNow({ intervalMs: ticking ? 1000 : 60_000 });
  const showSummary = summary !== false;
  const line = taskSummary(entries.map((entry) => entry.status));
  const hasHeader = hasContent(title) || (showSummary && line !== "") || hasContent(actions);
  // One action at most per row (Retry once settled, Cancel before), so one
  // reserved slot keeps every duration in a single column.
  const hasActions = entries.some((entry) => entry.retryable || entry.cancellable);
  const signature = entries.map((entry) => `${entry.id}:${entry.status}`).join("|");

  const listRef = useRef<HTMLUListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusedTask = useRef<string | null>(null);
  const seen = useRef<Map<string, PluginTaskStatus> | null>(null);
  const [spoken, setSpoken] = useState("");

  // A row's action goes away as its task moves on (Cancel once it finishes,
  // Retry once it restarts): focus it held stays on that task's row.
  useLayoutEffect(() => {
    const id = focusedTask.current;
    if (id === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const list = listRef.current;
    const row = list
      ? [...list.querySelectorAll<HTMLElement>("[data-task-id]")].find(
          (candidate) => candidate.dataset.taskId === id
        )
      : undefined;
    // The last task gone takes the list with it: the section is what is left.
    (row ?? list ?? sectionRef.current)?.focus({ preventScroll: true });
    if (!list) focusedTask.current = null;
  }, [signature]);

  // Outcomes only: a task settling is news, its ticking time and progress are
  // not. The snapshot changes exactly when a task's state does.
  const snapshot = JSON.stringify(entries.map((entry) => [entry.id, entry.status, entry.title]));
  useEffect(() => {
    const { statuses, news, changed } = taskNews(snapshot, seen.current);
    seen.current = statuses;
    // A task moving on without news (a retry starting) clears the last
    // outcome, so the same outcome a second time is spoken again.
    if (news !== "") setSpoken(news);
    else if (changed) setSpoken("");
  }, [snapshot]);

  return (
    <section
      {...pickRootProps(rest)}
      ref={sectionRef}
      tabIndex={-1}
      aria-label={nonEmpty(ariaLabel)}
      data-task-list=""
      className={cn("flex min-w-0 flex-col", PROGRAMMATIC_FOCUS_RING, str(className))}
    >
      {hasHeader ? (
        <div className="flex h-7 shrink-0 items-center gap-2 pr-1.5 pl-3">
          {hasContent(title) ? (
            <h3 className={cn(SECTION_LABEL_CLASS, "m-0 shrink-0")}>{node(title)}</h3>
          ) : null}
          {showSummary && line !== "" ? (
            <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary tabular-nums">
              {line}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {hasContent(actions) ? (
            <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
          ) : null}
        </div>
      ) : null}
      {entries.length === 0 ? (
        hasContent(empty) ? (
          <div className="px-3 py-2 text-xs text-text-secondary">{node(empty)}</div>
        ) : null
      ) : (
        <ul
          ref={listRef}
          tabIndex={-1}
          aria-label={nonEmpty(ariaLabel)}
          onFocus={(event) => {
            const row =
              event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>("[data-task-id]")
                : null;
            focusedTask.current = row?.dataset.taskId ?? null;
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next !== null && !event.currentTarget.contains(next)) focusedTask.current = null;
          }}
          className={cn("m-0 flex list-none flex-col p-0", PROGRAMMATIC_FOCUS_RING)}
        >
          {entries.map((entry) => {
            const duration = taskDuration(entry, now);
            const detail = field(entry.task, "detail");
            const showBar = entry.status === "running" && entry.progress !== null;
            const name = entry.title || "task";
            return (
              <li
                key={entry.id}
                tabIndex={-1}
                data-task-id={entry.id}
                data-task-status={entry.status}
                className={cn(
                  "flex min-h-8 min-w-0 items-start gap-2 py-1 pl-3",
                  hasActions ? "pr-1.5" : "pr-3",
                  PROGRAMMATIC_FOCUS_RING
                )}
              >
                <span className="flex h-6 w-3.5 shrink-0 items-center justify-center">
                  <TaskGlyph status={entry.status} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                  <span className="min-w-0 truncate text-xs leading-4 text-text-primary">
                    <span className="sr-only">{TASK_WORD[entry.status]}: </span>
                    {entry.title}
                  </span>
                  {hasContent(detail) ? (
                    <div className="min-w-0 truncate text-2xs text-text-secondary">
                      {node(detail)}
                    </div>
                  ) : null}
                  {showBar ? (
                    <ProgressBar
                      value={Math.round((entry.progress ?? 0) * 100)}
                      label={entry.title || "Progress"}
                      size="thin"
                      className="mt-1"
                    />
                  ) : null}
                </div>
                <span className="flex h-6 shrink-0 items-center text-2xs text-text-secondary tabular-nums">
                  {duration}
                </span>
                {hasActions ? (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                    {entry.retryable ? (
                      <TaskAction
                        label={`Retry ${name}`}
                        tooltip="Retry"
                        onClick={() => retry?.(entry.task)}
                      >
                        <RefreshCw aria-hidden="true" />
                      </TaskAction>
                    ) : entry.cancellable ? (
                      <TaskAction
                        label={`Cancel ${name}`}
                        tooltip="Cancel"
                        onClick={() => cancel?.(entry.task)}
                      >
                        <X aria-hidden="true" />
                      </TaskAction>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// RefreshOverlay and StaleIndicator

/** `value`, but only once it has held for `delayMs`; it drops at once. */
function useHeldFor(value: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!value) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value && held;
}

// The content stays where it is and stays usable: the only marks are a thin
// bar along the top edge and a small note in the corner, both past the
// Doherty gate so a quick refresh never flickers.
function KitRefreshOverlay({
  refreshing,
  children,
  label,
  className,
  ...rest
}: PluginRefreshOverlayProps) {
  const active = refreshing === true;
  const shown = useHeldFor(active, UI_DOHERTY_THRESHOLD);
  const words = nonEmpty(label) ?? "Updating…";
  return (
    <div
      {...pickRootProps(rest)}
      data-refreshing={active ? "true" : undefined}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", str(className))}
    >
      {/* Busy is the content alone: a live region inside a busy subtree may
          be held back until it clears, which is after the news is over. */}
      <div aria-busy={active || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {node(children)}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 transition-opacity duration-150 ease-out motion-reduce:transition-none",
          shown ? "opacity-100" : "opacity-0"
        )}
      >
        {shown ? <ProgressBar label={words} size="thin" className="rounded-none" /> : null}
        <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-border-default bg-surface-panel-elevated px-2 py-0.5 text-2xs text-text-secondary shadow-[var(--theme-shadow-floating)]">
          <Spinner size="xs" />
          {words}
        </div>
      </div>
      <span role="status" className="sr-only">
        {shown ? words : ""}
      </span>
    </div>
  );
}

const STALE_TICK_MIN_MS = 1000;
const STALE_TICK_MAX_MS = 60_000;

function KitStaleIndicator({
  updatedAt,
  staleAfterMs,
  stale,
  disconnected,
  refreshing,
  onRefresh,
  refreshLabel,
  className,
  ...rest
}: PluginStaleIndicatorProps) {
  const timestamp = toTimestamp(updatedAt);
  const valid = !Number.isNaN(timestamp);
  const threshold = positive(staleAfterMs, Number.MAX_SAFE_INTEGER);
  const tick = threshold
    ? Math.min(STALE_TICK_MAX_MS, Math.max(STALE_TICK_MIN_MS, Math.round(threshold / 4)))
    : STALE_TICK_MAX_MS;
  const now = useNow({ intervalMs: tick });
  const aged = threshold !== undefined && valid && now - timestamp > threshold;
  const state = disconnected === true ? "disconnected" : stale === true || aged ? "stale" : "fresh";
  const busy = refreshing === true;
  const refresh = fn(onRefresh);
  const refreshName = nonEmpty(refreshLabel) ?? "Refresh";
  const TimeAgo = pluginKitDates.TimeAgo;
  // Connectivity changes are news; the age ticking over is not.
  const offline = state === "disconnected";
  const wasOffline = useRef<boolean | null>(null);
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    const previous = wasOffline.current;
    wasOffline.current = offline;
    if (previous === null || previous === offline) return;
    setSpoken(offline ? "Disconnected" : "Reconnected");
  }, [offline]);
  return (
    <span
      {...pickRootProps(rest)}
      data-stale-state={state}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-text-secondary", str(className))}
    >
      {state === "disconnected" ? (
        <>
          <WifiOff aria-hidden="true" className="h-3 w-3 shrink-0 text-status-warning" />
          <span className="shrink-0 text-text-primary">Disconnected</span>
          <span aria-hidden="true" className="text-text-muted">
            ·
          </span>
        </>
      ) : state === "stale" ? (
        <>
          <Clock aria-hidden="true" className="h-3 w-3 shrink-0 text-status-warning" />
          <span className="sr-only">Out of date:</span>
        </>
      ) : null}
      <span className="min-w-0 truncate">
        {valid ? <TimeAgo value={timestamp} prefix="Updated " /> : "Not updated yet"}
      </span>
      {refresh ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={refreshName}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) refresh();
          }}
          className="-my-1 shrink-0 [&_svg]:size-3"
        >
          <SpinningIcon icon={RefreshCw} active={busy} aria-hidden="true" />
        </Button>
      ) : null}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </span>
  );
}

export const pluginKitLayoutPanes = {
  MasterDetail: KitMasterDetail,
  SplitGroup: KitSplitGroup,
  Inspector: KitInspector,
  InspectorSection: KitInspectorSection,
  PropertyRow: KitPropertyRow,
  Drawer: KitDrawer,
  DrawerToggle: KitDrawerToggle,
  GroupedVirtualList: KitGroupedVirtualList,
  BulkActionBar: KitBulkActionBar,
  LoadMoreFooter: KitLoadMoreFooter,
  TaskList: KitTaskList,
  RefreshOverlay: KitRefreshOverlay,
  StaleIndicator: KitStaleIndicator,
};
