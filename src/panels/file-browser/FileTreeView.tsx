import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveTreeKey, type FlatTreeRow } from "./fileBrowserTree";

export interface FileTreeViewProps {
  rows: readonly FlatTreeRow[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  /** Fired by Enter on a file row — the viewer already follows selection. */
  onActivate?: (path: string) => void;
  /** Accessible name for the tree, since the panel header isn't part of it. */
  label: string;
}

const INDENT_PER_DEPTH_PX = 12;
const BASE_PADDING_PX = 6;
const ROW_HEIGHT_PX = 24;

/**
 * Virtualized directory tree.
 *
 * Rendered as one flat list through `react-virtuoso` (the virtualizer already
 * used by the sidebar, logs and console) rather than nested `<ul>`s: only the
 * visible slice is ever in the DOM, which is what lets the browser open on a
 * worktree with tens of thousands of files without a first-render stall.
 *
 * Keyboard handling lives on the container, not on rows. A virtualized list
 * unmounts the focused row the moment it scrolls out of view, which would drop
 * focus to `<body>` mid-navigation; keeping one roving focus target on the
 * container avoids that entirely and matches the `aria-activedescendant`
 * pattern for trees.
 */
export function FileTreeView({
  rows,
  selectedPath,
  onSelect,
  onToggleExpanded,
  onActivate,
  label,
}: FileTreeViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Two browsers can be open on the same worktree, and both would otherwise
  // mint `file-browser-row-src/index.ts` — duplicate DOM ids that make
  // `aria-activedescendant` ambiguous.
  const instanceId = useId();

  // The rows array changes identity on every listing update, so the handler is
  // rebuilt with it. Reading through a ref instead would let a keypress act on
  // a tree the user is no longer looking at.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const intent = resolveTreeKey(event.key, rows, selectedPath);
      if (!intent) return;
      event.preventDefault();

      switch (intent.type) {
        case "select":
          onSelect(intent.path);
          break;
        case "expand":
          onToggleExpanded(intent.path, true);
          break;
        case "collapse":
          onToggleExpanded(intent.path, false);
          break;
        case "activate":
          onActivate?.(intent.path);
          break;
      }
    },
    [rows, selectedPath, onSelect, onToggleExpanded, onActivate]
  );

  const selectedIndex = useMemo(
    () => (selectedPath === null ? -1 : rows.findIndex((row) => row.path === selectedPath)),
    [rows, selectedPath]
  );

  // Keep the selection on screen when it moves by keyboard. Runs after commit,
  // never during render: an abandoned concurrent render would otherwise scroll
  // for state that never committed, and suppress the scroll on the render that
  // did. `auto` only scrolls when the row is actually outside the viewport, so
  // clicking a visible row never yanks the list.
  //
  // Keyed on the path as well as the index so a restored selection scrolls on
  // mount, and so a live update that shifts a row's index re-reveals it.
  useEffect(() => {
    if (selectedIndex < 0) return;
    virtuosoRef.current?.scrollIntoView({ index: selectedIndex, behavior: "auto" });
  }, [selectedIndex, selectedPath]);

  // Clicking a row selects it but can't focus it — rows are not focusable, by
  // design, because virtualization unmounts them. Pull focus to the container
  // so the arrow keys keep working after a click.
  const handlePointerDown = useCallback(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const context: TreeContext = useMemo(
    () => ({ selectedPath, onSelect, onToggleExpanded, instanceId }),
    [selectedPath, onSelect, onToggleExpanded, instanceId]
  );

  // Only advertise an active descendant that is actually rendered. A selection
  // scrolled out of the virtualized window — or deleted by a live update — has
  // no DOM node, and pointing at a missing id is worse than pointing at none.
  const activeDescendant =
    selectedPath !== null && selectedIndex >= 0 ? rowDomId(instanceId, selectedPath) : undefined;

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={label}
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      // No `outline-none`: the global `*:focus-visible` ring is the only focus
      // indicator this container gets, and the rows themselves never take focus.
      className="h-full min-h-0 w-full overflow-hidden"
    >
      <Virtuoso<FlatTreeRow, TreeContext>
        ref={virtuosoRef}
        data={rows as FlatTreeRow[]}
        context={context}
        computeItemKey={computeRowKey}
        itemContent={renderRow}
        fixedItemHeight={ROW_HEIGHT_PX}
        skipAnimationFrameInResizeObserver
        className="h-full w-full overflow-y-auto"
      />
    </div>
  );
}

interface TreeContext {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  instanceId: string;
}

/**
 * Keyed by path, never by index: an index key makes Virtuoso reuse a row's DOM
 * for a different file when a listing changes length, which is exactly what a
 * live-updating tree does.
 */
function computeRowKey(_index: number, row: FlatTreeRow): string {
  return row.path;
}

/**
 * Scoped by instance and encoded: a path can contain spaces, quotes and other
 * characters that are not valid in an HTML id.
 */
function rowDomId(instanceId: string, path: string): string {
  return `fb${instanceId}-${encodeURIComponent(path)}`;
}

function renderRow(_index: number, row: FlatTreeRow, context: TreeContext) {
  const isSelected = context.selectedPath === row.path;
  return <FileTreeRow row={row} isSelected={isSelected} context={context} />;
}

interface FileTreeRowProps {
  row: FlatTreeRow;
  isSelected: boolean;
  context: TreeContext;
}

function FileTreeRow({ row, isSelected, context }: FileTreeRowProps) {
  const { onSelect, onToggleExpanded } = context;

  const handleClick = () => {
    onSelect(row.path);
    if (row.isDirectory) onToggleExpanded(row.path, !row.isExpanded);
  };

  const handleChevronClick = (event: React.MouseEvent) => {
    // Toggling from the chevron must not move the selection: it is the
    // "peek inside without leaving where I am" affordance.
    event.stopPropagation();
    onToggleExpanded(row.path, !row.isExpanded);
  };

  const Chevron = row.isExpanded ? ChevronDown : ChevronRight;
  const FolderIcon = row.isExpanded ? FolderOpen : Folder;

  return (
    <div
      id={rowDomId(context.instanceId, row.path)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      onClick={handleClick}
      style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PER_DEPTH_PX }}
      className={cn(
        "flex h-6 w-full cursor-default select-none items-center gap-1 pr-2 text-xs",
        // Selection is a neutral surface lift, not an accent fill: the tree has
        // hover, selection and container focus all live at once, and the accent
        // is reserved for a single load-bearing signal per focus region.
        "transition-colors duration-150 ease-out",
        isSelected ? "bg-overlay-subtle text-daintree-text" : "text-muted-foreground",
        !isSelected && "hover:bg-overlay-subtle/50",
        row.isIgnored && "opacity-55"
      )}
    >
      {row.isDirectory ? (
        // A span, not a button: the row already exposes expansion through
        // `aria-expanded`, and a focusable control marked `aria-hidden` is a
        // node the keyboard can reach but a screen reader cannot describe.
        <span
          onClick={handleChevronClick}
          aria-hidden="true"
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          <Chevron className="h-3 w-3" />
        </span>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      {row.isDirectory ? (
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-category-cyan" aria-hidden="true" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
      )}
      <span className="truncate">{row.name}</span>
      {row.isLoading && (
        <span className="ml-1 shrink-0 text-[10px] opacity-60">Loading…</span>
      )}
    </div>
  );
}
