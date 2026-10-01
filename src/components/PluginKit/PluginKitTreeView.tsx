import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import type { PluginTreeViewProps } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { CheckboxGlyph } from "@/components/ui/checkbox";
import { MOUSE_SENSOR_OPTIONS, TOUCH_SENSOR_OPTIONS } from "@/components/DragDrop/dragActivation";
import { DROP_INDICATOR_LINE, DROP_TARGET_FRAME } from "@/components/DragDrop/dropIndicator";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  resolveTreeKey,
  resolveTypeahead,
  TYPEAHEAD_RESET_MS,
} from "@/panels/file-browser/fileBrowserTree";
import { useSelection } from "@/pluginUi/selection";
import { field, fn, hasContent, node, pickRootProps, str } from "./kitProps";
import { renderIconSource } from "./PluginKitIcons";
import { KitDragOverlay, KitMouseSensor, KitTouchSensor, LIFTED_SURFACE } from "./PluginKitDnd";
import { severityGlyph } from "./PluginKitPatterns";
import {
  createLazyScope,
  forgetLazyChildren,
  lazyChildrenVersion,
  peekLazyChildren,
  readLazyChildren,
  subscribeLazyChildren,
} from "./kitLazyChildren";
import {
  ancestorsOf,
  buildTreeRows,
  createCheckReader,
  dropPositionAt,
  isTreeId,
  MAX_TREE_DEPTH,
  resolveDrop,
  resolveKeyMove,
  toggleChecked,
  treeKey,
  type DropPosition,
  type KnownChildren,
  type TreeId,
  type TreeMoveResult,
  type TreeRow,
  type TreeStatusRow,
  type TreeViewRow,
} from "./kitTreeModel";
import {
  GatedLoading,
  idPart,
  TREE_INDENT_PX,
  TREE_ROW_CLASS,
  TREE_ROW_HEIGHT_PX,
  TreeChevron,
  TreeGutter,
  treeRowPadding,
} from "./kitTreeRow";

function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    console.warn("[PluginKit] TreeView callback threw", error);
    return fallback;
  }
}

function idList(value: unknown): TreeId[] | undefined {
  return Array.isArray(value) ? value.filter(isTreeId) : undefined;
}

function useControllable<T>(
  controlled: T | undefined,
  initial: () => T,
  onChange: ((value: T) => void) | undefined
): [T, (value: T) => void] {
  const [own, setOwn] = useState<T>(initial);
  const value = controlled ?? own;
  const set = (next: T) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  };
  return [value, set];
}

interface DropTarget {
  path: string;
  position: DropPosition;
  move: TreeMoveResult | null;
}

interface TreeContext {
  cursorPath: string | null;
  hasParents: boolean;
  checkable: boolean;
  draggable: boolean;
  dragPath: string | null;
  drop: DropTarget | null;
  rowId: (path: string) => string;
  isSelected: (id: TreeId) => boolean;
  checkState: (node: unknown) => boolean | "mixed";
  canDrag: (node: unknown) => boolean;
  content: (row: TreeRow, state: RowState) => ReactNode;
  onRowClick: (row: TreeRow, event: MouseEvent<HTMLElement>) => void;
  onRowDoubleClick: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  onCheck: (row: TreeRow) => void;
  onRetry: (parentNode: unknown) => void;
}

interface RowState {
  depth: number;
  expanded: boolean;
  expandable: boolean;
  selected: boolean;
  checked: boolean | "mixed";
  loading: boolean;
}

// dnd-kit would speak in row keys; the tree announces the move itself on drop.
const DRAG_ACCESSIBILITY = {
  announcements: {
    onDragStart: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => undefined,
  },
  screenReaderInstructions: { draggable: "" },
};

function DropMarks({ drop, depth }: { drop: DropTarget | null; depth: number }) {
  if (!drop || !drop.move) return null;
  if (drop.position === "inside") {
    return (
      <span
        aria-hidden="true"
        data-tree-drop="inside"
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[var(--radius-md)]",
          DROP_TARGET_FRAME
        )}
      />
    );
  }
  // The line starts where the dropped node's content would: the target's depth.
  return (
    <span
      aria-hidden="true"
      data-tree-drop={drop.position}
      style={{
        left: treeRowPadding(depth),
        ...(drop.position === "before" ? { top: -1 } : { bottom: -1 }),
      }}
      className={cn(DROP_INDICATOR_LINE, "right-0 h-0.5")}
    />
  );
}

function NodeRow({ row, context }: { row: TreeRow; context: TreeContext }) {
  const selected = context.isSelected(row.id);
  const cursor = context.cursorPath === row.path;
  const checked = context.checkable ? context.checkState(row.node) : false;
  const dragDisabled = !context.draggable || !context.canDrag(row.node);
  const { setNodeRef, listeners } = useDraggable({ id: row.path, disabled: dragDisabled });
  const state: RowState = {
    depth: row.depth,
    expanded: row.isExpanded,
    expandable: row.isDirectory,
    selected,
    checked,
    loading: row.isLoading,
  };
  const drop = context.drop?.path === row.path ? context.drop : null;
  return (
    <div
      ref={setNodeRef}
      {...(dragDisabled ? null : listeners)}
      id={context.rowId(row.path)}
      role="treeitem"
      aria-label={row.name}
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      aria-checked={context.checkable ? (checked === "mixed" ? "mixed" : checked) : undefined}
      aria-busy={row.isLoading || undefined}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      data-tree-path={row.path}
      data-cursor={cursor ? "true" : undefined}
      data-dragging={context.dragPath === row.path ? "true" : undefined}
      onClick={(event) => context.onRowClick(row, event)}
      onDoubleClick={() => context.onRowDoubleClick(row)}
      style={{ paddingLeft: treeRowPadding(row.depth) }}
      className={cn(
        TREE_ROW_CLASS,
        "relative",
        selected ? "text-text-primary" : "text-text-secondary",
        context.dragPath === row.path && "opacity-40"
      )}
    >
      {row.isDirectory ? (
        <TreeChevron expanded={row.isExpanded} onToggle={() => context.onToggle(row)} />
      ) : context.hasParents ? (
        <TreeGutter />
      ) : null}
      {context.checkable ? (
        <span
          aria-hidden="true"
          data-tree-check=""
          onClick={(event) => {
            event.stopPropagation();
            context.onCheck(row);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          // A 24px target over the 16px slot the glyph is drawn in.
          className="-mx-1 flex h-6 w-6 shrink-0 items-center justify-center"
        >
          <CheckboxGlyph size="sm" checked={checked === "mixed" ? "indeterminate" : checked} />
        </span>
      ) : null}
      {context.content(row, state)}
      <DropMarks drop={drop} depth={drop?.position === "inside" ? row.depth + 1 : row.depth} />
    </div>
  );
}

function StatusRow({ row, context }: { row: TreeStatusRow; context: TreeContext }) {
  return (
    <div
      id={context.rowId(row.path)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={1}
      aria-setsize={1}
      aria-selected={false}
      aria-label={row.status === "loading" ? "Loading" : `Couldn't load: ${row.message}`}
      data-tree-path={row.path}
      data-cursor={context.cursorPath === row.path ? "true" : undefined}
      style={{ paddingLeft: treeRowPadding(row.depth) + 20 }}
      className={cn(TREE_ROW_CLASS, "gap-1.5 text-text-secondary")}
    >
      {row.status === "loading" ? (
        <GatedLoading />
      ) : (
        <>
          {severityGlyph("error", "h-3 w-3")}
          <span className="min-w-0 truncate">{row.message || "Couldn't load"}</span>
          <Button
            variant="ghost"
            size="xs"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              context.onRetry(row.parentNode);
            }}
          >
            Retry
          </Button>
        </>
      )}
    </div>
  );
}

function renderRow(_index: number, row: TreeViewRow, context: TreeContext): ReactNode {
  return row.kind === "node" ? (
    <NodeRow row={row} context={context} />
  ) : (
    <StatusRow row={row} context={context} />
  );
}

function rowKeyOf(_index: number, row: TreeViewRow): string {
  return row.path;
}

function defaultLabel(node: unknown, id: TreeId | undefined): string {
  if (typeof node === "string") return node;
  if (typeof node === "object" && node !== null) {
    for (const name of ["label", "name", "title"]) {
      const value = field(node, name);
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return id === undefined ? "" : String(id);
}

function KitTreeView(props: PluginTreeViewProps) {
  const {
    nodes,
    getId,
    getLabel,
    getChildren,
    hasChildren,
    renderNode,
    getIcon,
    selectionMode,
    selected: selectedProp,
    defaultSelected,
    onSelectedChange,
    expanded: expandedProp,
    defaultExpanded,
    onExpandedChange,
    checkable,
    checked: checkedProp,
    defaultChecked,
    onCheckedChange,
    onActivate,
    onMove,
    canDrop,
    canDrag,
    empty,
    "aria-label": ariaLabel,
    className,
  } = props;
  const roots: readonly unknown[] = Array.isArray(nodes) ? nodes : [];
  const idFn = fn(getId);
  const idOf = (value: unknown): TreeId | undefined => {
    const id: unknown = idFn
      ? attempt(() => idFn(value), undefined)
      : typeof value === "object" && value !== null
        ? field(value, "id")
        : typeof value === "string" || typeof value === "number"
          ? value
          : undefined;
    return isTreeId(id) ? id : undefined;
  };
  const labelFn = fn(getLabel);
  const labelOf = (value: unknown): string => {
    const given = labelFn ? attempt(() => labelFn(value), undefined) : undefined;
    return typeof given === "string" ? given : defaultLabel(value, idOf(value));
  };
  const childFn = fn(getChildren);
  const hasFn = fn(hasChildren);
  const load = (value: unknown): unknown =>
    childFn
      ? childFn(value)
      : typeof value === "object" && value !== null
        ? field(value, "children")
        : undefined;
  const [lazyScope] = useState(createLazyScope);
  // Re-reads the lazy cache when a load settles anywhere.
  const lazyRevision = useSyncExternalStore(
    subscribeLazyChildren,
    lazyChildrenVersion,
    lazyChildrenVersion
  );
  const childrenOf = (value: unknown, open: boolean): KnownChildren => {
    const declared = hasFn ? attempt(() => hasFn(value) === true, false) : undefined;
    if (declared === false) return { kind: "leaf" };
    const entry =
      declared === true && !open
        ? peekLazyChildren<unknown>(lazyScope, value)
        : readLazyChildren<unknown>(lazyScope, value, () => load(value));
    if (entry === undefined) return { kind: "unknown" };
    if (entry === null) return { kind: "leaf" };
    if (entry.status === "done") {
      return entry.items.length > 0 ? { kind: "nodes", nodes: entry.items } : { kind: "leaf" };
    }
    return entry.status === "error"
      ? { kind: "error", message: entry.message }
      : { kind: "loading" };
  };

  const [expanded, setExpanded] = useControllable<TreeId[]>(
    idList(expandedProp),
    () => idList(defaultExpanded) ?? [],
    fn(onExpandedChange)
  );
  const expandedSet = new Set(expanded);
  const rows = buildTreeRows({
    nodes: roots,
    idOf,
    labelOf,
    childrenOf,
    expanded: expandedSet,
    revision: lazyRevision,
  });
  const nodeRows = rows.filter((row): row is TreeRow => row.kind === "node");
  const hasParents = nodeRows.some((row) => row.isDirectory);
  const byPath = new Map(rows.map((row) => [row.path, row]));

  // Selection: the visible nodes, in drawn order.
  const multiple = selectionMode === "multiple";
  const controlledSelected = idList(selectedProp);
  const selection = useSelection<TreeId>({
    ids: nodeRows.map((row) => row.id),
    mode: multiple ? "multiple" : "single",
    ...(controlledSelected
      ? { selected: controlledSelected }
      : { defaultSelected: idList(defaultSelected) ?? [] }),
    onSelectedChange: fn(onSelectedChange),
  });

  // The cursor starts on the selection, so a tree opened on a chosen node shows it.
  const [ownCursor, setCursor] = useState<string | null>(null);
  const firstSelected = selection.selected[0];
  const cursorPath =
    ownCursor !== null && byPath.has(ownCursor)
      ? ownCursor
      : firstSelected !== undefined
        ? treeKey(firstSelected)
        : null;
  const cursorIndex = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);

  // Checks.
  const isCheckable = checkable === true;
  const [checked, setChecked] = useControllable<TreeId[]>(
    idList(checkedProp),
    () => idList(defaultChecked) ?? [],
    fn(onCheckedChange)
  );
  const checkedSet = new Set(checked);
  // Children known without loading: drawn ones, settled loads, and sync
  // lists when the plugin gave no `hasChildren` (which already reads them).
  const loadedChildren = (value: unknown): readonly unknown[] | null => {
    const peeked = peekLazyChildren<unknown>(lazyScope, value);
    if (peeked?.status === "done") return peeked.items;
    if (hasFn) {
      if (!attempt(() => hasFn(value) === true, false)) return null;
      const id = idOf(value);
      if (id === undefined || !expandedSet.has(id)) return null;
    }
    const entry = readLazyChildren<unknown>(lazyScope, value, () => load(value));
    return entry?.status === "done" ? entry.items : null;
  };
  const checkInput = { idOf, loadedChildren };
  // A node checked before its children were known passes the check down to
  // them once they are, rather than reading as off because none of them is.
  // Through every known level, not just the drawn ones, so collapsing a
  // branch does not change what it reads as.
  const inheritedSet = new Set(checkedSet);
  const inherited = new Set<unknown>();
  const inherit = (value: unknown, depth: number) => {
    if (inherited.has(value) || depth > MAX_TREE_DEPTH) return;
    inherited.add(value);
    for (const child of loadedChildren(value) ?? []) {
      const id = idOf(child);
      if (id !== undefined) inheritedSet.add(id);
      inherit(child, depth + 1);
    }
  };
  const walkChecked = (list: readonly unknown[], depth: number, seen: Set<unknown>) => {
    for (const value of list) {
      if (seen.has(value) || depth > MAX_TREE_DEPTH) continue;
      seen.add(value);
      const id = idOf(value);
      if (id !== undefined && inheritedSet.has(id)) inherit(value, depth);
      else walkChecked(loadedChildren(value) ?? [], depth + 1, seen);
    }
  };
  if (isCheckable) walkChecked(roots, 0, new Set());
  const checkState = createCheckReader(checkInput, inheritedSet);
  const toggleCheck = (row: TreeRow) => {
    const chain = ancestorsOf(rows, row.id).map((ancestor) => ancestor.node);
    setChecked(toggleChecked(checkInput, inheritedSet, row.node, chain));
  };

  const handleActivate = fn(onActivate);
  const moveFn = fn(onMove);
  const canDropFn = fn(canDrop);
  const canDragFn = fn(canDrag);
  const draggable = moveFn !== undefined;
  const allowDrag = (value: unknown) =>
    !canDragFn || attempt(() => canDragFn(value) !== false, false);
  const allowMove = (move: TreeMoveResult | null): TreeMoveResult | null => {
    if (!move) return null;
    if (!canDropFn) return move;
    return attempt(() => canDropFn(move) !== false, false) ? move : null;
  };

  const baseId = useId();
  const rowId = (path: string) => `${baseId}tv-${idPart(path)}`;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });
  const [range, setRange] = useState<ListRange | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const previous = useRef<{ path: string | null; found: boolean }>({ path: null, found: false });
  useEffect(() => {
    const before = previous.current;
    const found = cursorIndex >= 0;
    previous.current = { path: cursorPath, found };
    if (!found || (before.path === cursorPath && before.found)) return;
    virtuoso.current?.scrollIntoView({ index: cursorIndex, behavior: "auto" });
  }, [cursorIndex, cursorPath]);

  const toggle = (row: TreeRow, open: boolean) => {
    if (!row.isDirectory || expandedSet.has(row.id) === open) return;
    setExpanded(open ? [...expanded, row.id] : expanded.filter((id) => id !== row.id));
  };
  const goTo = (path: string, gesture?: { shiftKey?: boolean; primary?: boolean }) => {
    setCursor(path);
    const row = byPath.get(path);
    if (row?.kind !== "node") return;
    if (!multiple) {
      selection.select(row.id);
      return;
    }
    if (gesture?.shiftKey) {
      const from = cursorPath === null ? undefined : byPath.get(cursorPath);
      if (selection.anchor === null && from?.kind === "node") selection.select(from.id);
      selection.selectRange(row.id);
    } else if (!gesture?.primary) {
      selection.select(row.id);
    }
  };

  const childCount = (id: TreeId): number => {
    const row = nodeRows.find((candidate) => candidate.id === id);
    if (!row) return 0;
    // Called from key and drag handlers only, so asking a collapsed parent
    // for its children here is not a render-time load.
    const known = readLazyChildren<unknown>(lazyScope, row.node, () => load(row.node));
    return (
      nodeRows.filter((candidate) => candidate.parentId === id).length ||
      (known?.status === "done" ? known.items.length : 0)
    );
  };
  const describeMove = (move: TreeMoveResult) => {
    const moved = nodeRows.find((row) => row.id === move.id);
    const parent = move.parentId === null ? null : nodeRows.find((row) => row.id === move.parentId);
    const where = parent ? `into ${parent.name}` : "to the top level";
    return `Moved ${moved?.name ?? String(move.id)} ${where}, position ${move.index + 1}.`;
  };
  const commitMove = (move: TreeMoveResult | null) => {
    const allowed = allowMove(move);
    if (!allowed || !moveFn) return false;
    attempt(() => moveFn(allowed), undefined);
    setAnnouncement(describeMove(allowed));
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Node) || !container.current?.contains(target)) return;
    const current = cursorPath === null ? undefined : byPath.get(cursorPath);
    if (event.altKey && draggable && current?.kind === "node") {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight"
      ) {
        event.preventDefault();
        if (!allowDrag(current.node)) return;
        commitMove(resolveKeyMove(rows, current.id, event.key, childCount));
        return;
      }
    }
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (primary && !event.altKey && event.key.toLowerCase() === "a" && multiple) {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    // In a multi-select tree Cmd/Ctrl moves the cursor without touching the
    // selection, and Cmd/Ctrl+Space toggles the cursor node, so a
    // discontiguous selection can be built from the keyboard.
    if (primary && !event.altKey && multiple) {
      if (event.key === " " && current?.kind === "node") {
        event.preventDefault();
        selection.toggle(current.id);
        return;
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        const moved = resolveTreeKey(event.key, rows, cursorPath);
        if (moved?.type === "select") {
          event.preventDefault();
          setCursor(moved.path);
        }
        return;
      }
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " ") {
      event.preventDefault();
      if (current?.kind === "status") {
        if (current.status === "error") forgetLazyChildren(lazyScope, current.parentNode);
        return;
      }
      if (current?.kind !== "node") return;
      if (isCheckable) toggleCheck(current);
      else if (multiple) selection.toggle(current.id);
      else selection.select(current.id);
      return;
    }
    if (event.key.length === 1) {
      const now = Date.now();
      const state = typeahead.current;
      const buffer = now - state.at > TYPEAHEAD_RESET_MS ? event.key : state.buffer + event.key;
      typeahead.current = { buffer, at: now };
      const match = resolveTypeahead(buffer, nodeRows, cursorPath);
      if (match !== null) {
        event.preventDefault();
        goTo(match);
      }
      return;
    }
    if (event.key === "Enter" && current?.kind === "status") {
      event.preventDefault();
      if (current.status === "error") forgetLazyChildren(lazyScope, current.parentNode);
      return;
    }
    const intent = resolveTreeKey(event.key, rows, cursorPath);
    if (!intent) return;
    event.preventDefault();
    const row = byPath.get(intent.path);
    if (!row) return;
    if (intent.type === "select") goTo(row.path, { shiftKey: event.shiftKey });
    else if (row.kind !== "node") return;
    else if (intent.type === "expand") toggle(row, true);
    else if (intent.type === "collapse") toggle(row, false);
    else if (handleActivate) attempt(() => handleActivate(row.node), undefined);
    else if (row.isDirectory) toggle(row, !row.isExpanded);
  };

  // Drags.
  const sensors = useSensors(
    useSensor(KitMouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(KitTouchSensor, TOUCH_SENSOR_OPTIONS)
  );
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const dragRow = dragPath === null ? undefined : byPath.get(dragPath);
  // Where the pointer really is: dnd-kit's delta folds in the scroll of the
  // ancestors, which would aim the hit test above or below it.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (dragPath === null) return;
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    // Capture on the window, ahead of dnd-kit's own mouse and touch moves.
    window.addEventListener("pointermove", track, true);
    return () => {
      window.removeEventListener("pointermove", track, true);
      pointer.current = null;
    };
  }, [dragPath]);
  const pointerOf = (event: DragMoveEvent): { x: number; y: number } | null => {
    if (pointer.current) return pointer.current;
    const start = event.activatorEvent;
    if (start instanceof globalThis.MouseEvent) {
      return { x: start.clientX + event.delta.x, y: start.clientY + event.delta.y };
    }
    if (typeof TouchEvent !== "undefined" && start instanceof TouchEvent) {
      const touch = start.touches[0];
      return touch ? { x: touch.clientX + event.delta.x, y: touch.clientY + event.delta.y } : null;
    }
    return null;
  };
  const onDragMove = (event: DragMoveEvent) => {
    if (dragRow?.kind !== "node") return;
    const point = pointerOf(event);
    const element =
      point === null
        ? null
        : document
            .elementsFromPoint(point.x, point.y)
            .find(
              (candidate) =>
                container.current?.contains(candidate) && candidate.closest("[data-tree-path]")
            )
            ?.closest<HTMLElement>("[data-tree-path]");
    const path = element?.getAttribute("data-tree-path") ?? null;
    const targetRow = path === null ? undefined : byPath.get(path);
    if (!element || !point || path === null || targetRow?.kind !== "node") {
      if (drop !== null) setDrop(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const position = dropPositionAt(point.y - rect.top, rect.height, true);
    const move = allowMove(
      resolveDrop(rows, dragRow.id, targetRow.id, position, childCount(targetRow.id))
    );
    if (
      drop?.path === path &&
      drop.position === position &&
      drop.move?.parentId === move?.parentId &&
      drop.move?.index === move?.index
    ) {
      return;
    }
    setDrop({ path, position, move });
  };
  const endDrag = (event: DragEndEvent | null) => {
    const move = event && drop ? drop.move : null;
    setDragPath(null);
    setDrop(null);
    if (move) commitMove(move);
  };

  const content = fn(renderNode);
  const iconFn = fn(getIcon);
  const renderContent = (row: TreeRow, state: RowState): ReactNode => {
    if (content) return node(attempt(() => content(row.node, state), null));
    const icon = iconFn ? attempt(() => iconFn(row.node, state), null) : null;
    const glyph = icon === null || icon === undefined ? null : renderIconSource(icon);
    return (
      <>
        {glyph ? (
          <span
            aria-hidden="true"
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            {glyph}
          </span>
        ) : null}
        <span className={cn("min-w-0 truncate", state.selected && "font-medium")}>{row.name}</span>
      </>
    );
  };

  const label = str(ariaLabel) ?? "";
  if (rows.length === 0 && hasContent(empty)) {
    return (
      <div {...pickRootProps(props)} className={cn("h-full", str(className))}>
        {node(empty)}
      </div>
    );
  }
  const mounted =
    cursorIndex >= 0 &&
    range !== null &&
    cursorIndex >= range.startIndex &&
    cursorIndex <= range.endIndex;
  const context: TreeContext = {
    cursorPath,
    hasParents,
    checkable: isCheckable,
    draggable,
    dragPath,
    drop,
    rowId,
    isSelected: (id) => selection.isSelected(id),
    checkState,
    canDrag: allowDrag,
    content: renderContent,
    onRowClick: (row, event) => {
      const primary = isMac() ? event.metaKey : event.ctrlKey;
      setCursor(row.path);
      if (multiple && (event.shiftKey || primary)) {
        selection.handleSelect(row.id, event);
        return;
      }
      selection.select(row.id);
      if (row.isDirectory) toggle(row, !row.isExpanded);
    },
    onRowDoubleClick: (row) => {
      if (handleActivate) attempt(() => handleActivate(row.node), undefined);
    },
    onToggle: (row) => toggle(row, !row.isExpanded),
    onRetry: (parentNode) => forgetLazyChildren(lazyScope, parentNode),
    onCheck: (row) => {
      setCursor(row.path);
      toggleCheck(row);
    },
  };

  const tree = (
    <div
      {...pickRootProps(props, { aria: true })}
      ref={container}
      role="tree"
      aria-label={label}
      aria-multiselectable={multiple || undefined}
      aria-activedescendant={mounted && cursorPath !== null ? rowId(cursorPath) : undefined}
      tabIndex={0}
      data-no-dnd={draggable ? "" : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={() => container.current?.focus({ preventScroll: true })}
      // Focus arriving finds a cursor on screen: the first row when there is
      // none yet, else the cursor scrolled back into view.
      onFocus={(event) => {
        if (event.target !== event.currentTarget || rows.length === 0) return;
        if (cursorPath === null) {
          const first = rows[0];
          if (first) setCursor(first.path);
          return;
        }
        if (!mounted && cursorIndex >= 0) virtuoso.current?.scrollIntoView({ index: cursorIndex });
      }}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden focus-visible:-outline-offset-2",
        // The cursor row carries the focus outline; the tree's own ring
        // stands down so there is one, not two.
        cursorPath !== null && "outline-hidden",
        // The cursor row is outlined while the tree holds keyboard focus.
        "focus-visible:[&_[data-cursor=true]]:outline focus-visible:[&_[data-cursor=true]]:outline-2 focus-visible:[&_[data-cursor=true]]:-outline-offset-2 focus-visible:[&_[data-cursor=true]]:outline-accent-primary",
        str(className)
      )}
    >
      <Virtuoso<TreeViewRow, TreeContext>
        ref={virtuoso}
        data={rows}
        context={context}
        computeItemKey={rowKeyOf}
        itemContent={renderRow}
        fixedItemHeight={TREE_ROW_HEIGHT_PX}
        rangeChanged={(next) =>
          setRange((current) =>
            current?.startIndex === next.startIndex && current.endIndex === next.endIndex
              ? current
              : next
          )
        }
        className="h-full w-full overflow-y-auto"
      />
    </div>
  );
  const announced = (
    <>
      {tree}
      <span className="sr-only" role="status" aria-live="polite" data-tree-announcer="">
        {announcement}
      </span>
    </>
  );
  if (!draggable) return announced;
  return (
    <DndContext
      sensors={sensors}
      accessibility={DRAG_ACCESSIBILITY}
      onDragStart={(event: DragStartEvent) => {
        setDragPath(String(event.active.id));
        setDrop(null);
      }}
      onDragMove={onDragMove}
      onDragEnd={endDrag}
      onDragCancel={() => endDrag(null)}
    >
      {announced}
      <KitDragOverlay modifiers={[]}>
        {dragRow?.kind === "node" ? (
          <div
            className={cn(
              "flex h-6 items-center gap-1 rounded-[var(--radius-md)] px-2 text-xs text-text-primary",
              LIFTED_SURFACE
            )}
            style={{ paddingInlineStart: TREE_INDENT_PX / 2 + 2 }}
          >
            {renderContent(dragRow, {
              depth: dragRow.depth,
              expanded: dragRow.isExpanded,
              expandable: dragRow.isDirectory,
              selected: true,
              checked: false,
              loading: false,
            })}
          </div>
        ) : null}
      </KitDragOverlay>
    </DndContext>
  );
}

export const pluginKitTreeView = { TreeView: KitTreeView };
