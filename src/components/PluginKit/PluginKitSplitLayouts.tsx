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
} from "react";
import { ArrowLeft } from "lucide-react";
import type {
  PluginMasterDetailProps,
  PluginSplitGroupProps,
  PluginSplitLayout,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { resolveSplitterKey, type SplitterGrowKey } from "@/hooks/useSplitterKeys";
import { cn } from "@/lib/utils";
import { usePersistentViewState } from "@/pluginUi/viewState";
import { isShrinkKey, pluginKitLayout } from "./PluginKitLayout";
import {
  LIMIT_PX,
  PROGRAMMATIC_FOCUS_RING,
  readIds,
  useElementSize,
  viewStateKey,
} from "./kitPaneShared";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  positive,
  str,
} from "./kitProps";

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

export function KitMasterDetail({
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
export function KitSplitGroup({
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

  const paneElementId = (index: number) => `${baseId}pane-${index}`;

  const commit = (pane: SplitPaneEntry, next: { size: number; collapsed: boolean }) => {
    const wasCollapsed = isCollapsed(pane);
    const sizes = next.collapsed ? layout.sizes : { ...layout.sizes, [pane.id]: next.size };
    // In a group too small for every size the siblings are squeezed; they are
    // saved at what they are drawn at, or their larger sizes would take the
    // step back as the flexbox shares the shortfall out again.
    if (!next.collapsed) {
      entries.forEach((other, otherIndex) => {
        if (other.id === pane.id || other.fill || isCollapsed(other)) return;
        const rect = document.getElementById(paneElementId(otherIndex))?.getBoundingClientRect();
        const drawn = rect ? Math.round(horizontal ? rect.width : rect.height) : 0;
        if (drawn > 0 && drawn < sizeOf(other)) sizes[other.id] = Math.max(other.min, drawn);
      });
    }
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
