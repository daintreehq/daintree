import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { resolveTreeKey, type FlatTreeRow } from "./fileBrowserTree";

export interface FileTreeViewProps {
  // Mutable rather than `readonly`: this is exactly what the tree hook returns,
  // and widening it here would force a cast at the Virtuoso boundary.
  rows: FlatTreeRow[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  /** Fired by Enter on a file row — the viewer already follows selection. */
  onActivate?: (path: string) => void;
  /**
   * Menu items for a row's right-click menu; return null for no menu. The
   * view owns the Radix wiring (and selects the row on right-click so the
   * menu visibly targets it); the pane owns what the items do.
   */
  rowContextMenu?: (row: FlatTreeRow) => React.ReactNode;
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
  rowContextMenu,
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
      // Shift+F10 / the ContextMenu key open the selected row's menu — the
      // rows never take focus, so without this the row menu would be
      // mouse-only. Replayed as a synthetic contextmenu on the row's DOM node
      // because Radix's ContextMenu has no imperative open. preventDefault
      // also suppresses the browser's own contextmenu for the keypress, so
      // the menu can't double-fire.
      const isMenuKey =
        event.key === "ContextMenu" ||
        (event.key === "F10" &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey);
      if (isMenuKey && rowContextMenu && selectedPath !== null) {
        const rowElement = document.getElementById(rowDomId(instanceId, selectedPath));
        if (rowElement) {
          event.preventDefault();
          event.stopPropagation();
          const rect = rowElement.getBoundingClientRect();
          rowElement.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + 8,
              clientY: rect.top + rect.height / 2,
            })
          );
          return;
        }
      }

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
    [rows, selectedPath, onSelect, onToggleExpanded, onActivate, rowContextMenu, instanceId]
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
    () => ({ selectedPath, onSelect, onToggleExpanded, rowContextMenu, instanceId }),
    [selectedPath, onSelect, onToggleExpanded, rowContextMenu, instanceId]
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
      // Tells the global Shift+F10/ContextMenu-key handler to stand down: this
      // surface routes those keys to the selected row's own menu.
      {...(rowContextMenu ? { "data-row-menu": "" } : {})}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      // Focus styling is deliberately left to the global `*:focus-visible`
      // ring: this container is the tree's only focus target (rows are
      // virtualized and never take focus), so suppressing its outline would
      // leave keyboard navigation with no visible anchor at all.
      className="h-full min-h-0 w-full overflow-hidden"
    >
      <Virtuoso<FlatTreeRow, TreeContext>
        ref={virtuosoRef}
        data={rows}
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
  rowContextMenu?: ((row: FlatTreeRow) => React.ReactNode) | undefined;
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

  // Select on right-click, without toggling expansion: the menu acts on this
  // row, and the selection highlight is what shows the user which one.
  const handleContextMenu = () => {
    onSelect(row.path);
  };

  const handleChevronClick = (event: React.MouseEvent) => {
    // Toggling from the chevron must not move the selection: it is the
    // "peek inside without leaving where I am" affordance.
    event.stopPropagation();
    onToggleExpanded(row.path, !row.isExpanded);
  };

  const Chevron = row.isExpanded ? ChevronDown : ChevronRight;
  const FolderIcon = row.isExpanded ? FolderOpen : Folder;

  const menuItems = context.rowContextMenu?.(row);
  const rowSurface = (
    <div
      id={rowDomId(context.instanceId, row.path)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      onClick={handleClick}
      style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PER_DEPTH_PX }}
      className={cn(
        "flex h-6 w-full cursor-default select-none items-center gap-1 rounded pr-2 font-mono text-xs",
        // Selection is a neutral surface lift, not an accent fill: the tree has
        // hover, selection and container focus all live at once, and the accent
        // is reserved for a single load-bearing signal per focus region.
        "transition-colors duration-150 ease-out",
        isSelected ? "bg-overlay-subtle text-daintree-text" : "text-daintree-text/70",
        !isSelected && "hover:bg-tint/5",
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
          className="flex h-4 w-4 shrink-0 items-center justify-center text-daintree-text/40"
        >
          <Chevron className="h-3 w-3" />
        </span>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      {row.isDirectory ? (
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-daintree-text/40" aria-hidden="true" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-daintree-text/30" aria-hidden="true" />
      )}
      <span className={cn("truncate", isSelected && "font-medium")}>{row.name}</span>
      {row.isLoading && (
        <span className="ml-1 shrink-0 text-[10px] text-daintree-text/40">Loading…</span>
      )}
    </div>
  );

  // Outer div stays full-bleed for Virtuoso's fixed row height; the inner
  // surface is inset and rounded to match the diff sidebar's file rows, so
  // the two file lists read as the same component family.
  if (!menuItems) {
    return <div className="h-6 w-full px-1">{rowSurface}</div>;
  }

  return (
    <div className="h-6 w-full px-1" onContextMenu={handleContextMenu}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowSurface}</ContextMenuTrigger>
        <ContextMenuContent>{menuItems}</ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
