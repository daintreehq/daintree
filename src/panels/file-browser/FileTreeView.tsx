import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { join } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { FILE_DRAG_MIME, encodeFileDragPaths } from "@/lib/fileDragPayload";
import { Spinner } from "@/components/ui/Spinner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { resolveTreeKey, type FlatTreeRow } from "./fileBrowserTree";
import { FILE_TREE_ICON_CLASS, UNKNOWN_FILE_COLOR_CLASS, getFileTypeIcon } from "./fileTypeIcons";
import { INSERT_FILE_REFERENCE_COMBO, matchesInsertFileReferenceCombo } from "./fileReference";

export interface FileTreeViewProps {
  // Mutable rather than `readonly`: this is exactly what the tree hook returns,
  // and widening it here would force a cast at the Virtuoso boundary.
  rows: FlatTreeRow[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  /**
   * Fired by Enter or a double-click on a file row. Directory rows also reach
   * this on Enter (the key resolver is row-kind agnostic), so the handler owns
   * the file check.
   */
  onActivate?: (path: string) => void;
  /** Fired by double-clicking a directory row: re-root the tree there. */
  onRootFolder?: (path: string) => void;
  /**
   * Menu items for a row's right-click menu; return null for no menu. The
   * view owns the Radix wiring (and lifts the row while its menu is open so
   * the menu visibly targets it, without moving the selection); the pane owns
   * what the items do.
   */
  rowContextMenu?: (row: FlatTreeRow) => React.ReactNode;
  /**
   * Send the selected row to the last agent the user typed to (#11577). Fired
   * by the tree-local Cmd+I, which only exists while a row is selected and a
   * target actually resolves — `canInsertFileReference` is what the tree knows
   * about the latter.
   */
  onInsertFileReference?: (path: string) => void;
  canInsertFileReference?: boolean;
  /**
   * Absolute path the rows are relative to — the worktree or workspace root,
   * NOT the folder the tree is currently rooted at. `row.path` stays relative
   * to this even after a re-root, which is what lets a dragged row name an
   * absolute file (#11576). Empty when no source resolves, which is the tree's
   * signal that rows cannot be dragged anywhere useful.
   */
  basePath: string;
  /** Accessible name for the tree, since the panel header isn't part of it. */
  label: string;
}

/**
 * Did this key actually happen in the tree, rather than in a portalled
 * descendant? React bubbles a portal's events through the component tree, so a
 * Radix row menu's keystrokes reach the container's handler even though its DOM
 * lives under `document.body`.
 */
function isEventInsideTree(event: React.KeyboardEvent, container: HTMLElement | null): boolean {
  if (container === null) return false;
  const target = event.target;
  return target instanceof Node && container.contains(target);
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
  onRootFolder,
  rowContextMenu,
  onInsertFileReference,
  canInsertFileReference = false,
  basePath,
  label,
}: FileTreeViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Two browsers can be open on the same worktree, and both would otherwise
  // mint `file-browser-row-src/index.ts` — duplicate DOM ids that make
  // `aria-activedescendant` ambiguous.
  const instanceId = useId();

  const selectedIndex = useMemo(
    () => (selectedPath === null ? -1 : rows.findIndex((row) => row.path === selectedPath)),
    [rows, selectedPath]
  );

  // The rows array changes identity on every listing update, so the handler is
  // rebuilt with it. Reading through a ref instead would let a keypress act on
  // a tree the user is no longer looking at.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A row's context menu portals out of this container but still bubbles
      // its keys through the React tree, so every branch below would otherwise
      // act on the *selected* row while the user is driving a menu opened on a
      // different one — Enter activating the wrong file, arrows moving the
      // selection behind the open menu. Radix owns those keys while its menu
      // is up; the tree only handles what actually happened inside it.
      if (!isEventInsideTree(event, containerRef.current)) return;

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

      // Handed to the agent the user was last talking to, without a drag. Sits
      // ahead of `resolveTreeKey` only for ordering clarity — that resolver is
      // a bare switch over the navigation keys and never claims a letter, so
      // plain `I` (and any future typeahead) stays untouched.
      //
      // Gated on the selection resolving to a *rendered* row, not merely on a
      // non-null path: re-rooting the tree leaves `browserSelectedPath` naming
      // the old root, which no longer appears in `rows`. Firing then would
      // reference a row the user cannot see and that `aria-activedescendant`
      // has already disowned.
      //
      // Auto-repeat is dropped: holding the combo would append the same token
      // over and over. It also keeps a user-rebound global Cmd+I from turning
      // into this command — the global handler ignores repeats, so every
      // repeat after its first press would otherwise fall through to here.
      if (
        onInsertFileReference &&
        canInsertFileReference &&
        selectedPath !== null &&
        selectedIndex >= 0 &&
        !event.repeat &&
        matchesInsertFileReferenceCombo(event.nativeEvent, isMac())
      ) {
        event.preventDefault();
        event.stopPropagation();
        onInsertFileReference(selectedPath);
        return;
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
    [
      rows,
      selectedPath,
      selectedIndex,
      onSelect,
      onToggleExpanded,
      onActivate,
      rowContextMenu,
      onInsertFileReference,
      canInsertFileReference,
      instanceId,
    ]
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

  // A listing with no folders at all doesn't need the chevron gutter — in a
  // flat directory of files the empty slots read as wasted indentation.
  const hasDirectories = useMemo(() => rows.some((row) => row.isDirectory), [rows]);

  const context: TreeContext = useMemo(
    () => ({
      selectedPath,
      onSelect,
      onToggleExpanded,
      onActivate,
      onRootFolder,
      rowContextMenu,
      hasDirectories,
      instanceId,
      basePath,
    }),
    [
      selectedPath,
      onSelect,
      onToggleExpanded,
      onActivate,
      onRootFolder,
      rowContextMenu,
      hasDirectories,
      instanceId,
      basePath,
    ]
  );

  // Only advertise an active descendant that is actually rendered. A selection
  // scrolled out of the virtualized window — or deleted by a live update — has
  // no DOM node, and pointing at a missing id is worse than pointing at none.
  const activeDescendant =
    selectedPath !== null && selectedIndex >= 0 ? rowDomId(instanceId, selectedPath) : undefined;

  // Only advertised while the shortcut would actually do something — announcing
  // Cmd+I with no reachable agent, or with a selection that no longer resolves
  // to a row, would be promising a no-op. Matches the handler's own gate.
  const insertKeyshortcuts =
    onInsertFileReference && canInsertFileReference && selectedIndex >= 0
      ? comboToAriaKeyshortcuts(INSERT_FILE_REFERENCE_COMBO, isMac())
      : undefined;

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={label}
      aria-activedescendant={activeDescendant}
      {...(insertKeyshortcuts ? { "aria-keyshortcuts": insertKeyshortcuts } : {})}
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
  onActivate?: ((path: string) => void) | undefined;
  onRootFolder?: ((path: string) => void) | undefined;
  rowContextMenu?: ((row: FlatTreeRow) => React.ReactNode) | undefined;
  hasDirectories: boolean;
  instanceId: string;
  basePath: string;
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
  const { onSelect, onToggleExpanded, onActivate, onRootFolder } = context;

  // Defer the folder-load spinner past the anti-flicker gate so a fast
  // expansion flashes nothing. Drives only the indicator — the tree's content
  // and children stay wired to the raw `row.isLoading`/listings state. Virtuoso
  // unmounts off-screen rows, so this cosmetic timer restarts if a still-loading
  // row scrolls out of view and back; harmless (the fetch itself keeps running).
  const showLoadingSpinner = useDeferredLoading(row.isLoading, UI_INLINE_LOADING_GATE_MS);

  const handleClick = () => {
    onSelect(row.path);
    if (row.isDirectory) onToggleExpanded(row.path, !row.isExpanded);
  };

  // Double-click re-roots a folder and opens a file in its own panel (#11496) —
  // the gesture keeps its "go deeper into this" meaning either way. On a folder
  // the two single clicks it contains toggle expansion twice (a net no-op), and
  // on a file they only re-select the row, so in both cases the double-click's
  // own effect is the only observable one.
  const handleDoubleClick = row.isDirectory
    ? onRootFolder
      ? () => {
          onRootFolder(row.path);
        }
      : undefined
    : onActivate
      ? () => {
          onActivate(row.path);
        }
      : undefined;

  const handleChevronClick = (event: React.MouseEvent) => {
    // Toggling from the chevron must not move the selection: it is the
    // "peek inside without leaving where I am" affordance.
    event.stopPropagation();
    onToggleExpanded(row.path, !row.isExpanded);
  };

  // The chevron is the double-click's near-miss zone; rooting from it would
  // punish a fast expand-collapse.
  const handleChevronDoubleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  // Hand this row to an agent by dragging it (#11576). Folders drag exactly
  // like files: a directory reference is meaningful to every agent that takes
  // `@path`, and the destination decides what to do with it.
  //
  // Everything the drop needs is written here, synchronously. Virtuoso unmounts
  // this row the moment it scrolls out of the window, but the browser owns the
  // drag session once `dragstart` returns — it has already snapshotted both the
  // payload and the drag image, and neither destination looks at the source
  // node again.
  //
  // Carries one type and no `text/plain`: see `FILE_DRAG_MIME`.
  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const { dataTransfer } = event;
    // A drag with no data is a drag Chromium starts and no target can accept,
    // which reads as a broken affordance rather than an absent one.
    if (context.basePath === "") {
      event.preventDefault();
      return;
    }
    // A list of one: the tree is single-select today, but the transport is
    // already shaped for the multi-select follow-up.
    dataTransfer.setData(FILE_DRAG_MIME, encodeFileDragPaths([join(context.basePath, row.path)]));
    // Referencing a file never moves or removes it.
    dataTransfer.effectAllowed = "copy";
    // The row itself is the preview — it already reads as this file (icon,
    // name, indentation) and costs no throwaway DOM node to build or clean up.
    // Grabbed near the icon so the cursor sits on the thing being dragged.
    dataTransfer.setDragImage(event.currentTarget, 12, ROW_HEIGHT_PX / 2);
  };

  const Chevron = row.isExpanded ? ChevronDown : ChevronRight;
  const FolderIcon = row.isExpanded ? FolderOpen : Folder;
  // Files carry their type; folders keep the folder shape (#11596). Resolved
  // per render rather than memoized: it is an object lookup, and Virtuoso only
  // ever renders the visible window.
  //
  // Folders stay neutral deliberately — they are one shape for the whole tree,
  // so a hue on them would sort nothing.
  const fileIcon = row.isDirectory ? null : getFileTypeIcon(row.name);
  const RowIcon = fileIcon?.Icon ?? FolderIcon;
  const rowIconColor = fileIcon?.colorClass ?? UNKNOWN_FILE_COLOR_CLASS;

  const menuItems = context.rowContextMenu?.(row);
  const rowSurface = (
    <div
      id={rowDomId(context.instanceId, row.path)}
      role="treeitem"
      // Pin the accessible name to the row name so the nested loading
      // `role="status"` (below) can't fold "Loading folder contents" into it.
      aria-label={row.name}
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      // Deliberately no `cursor-grab`: clicking to select or expand is what
      // nearly every row interaction is, and advertising the drag on all of
      // them would misdescribe the surface. Chromium supplies its own cursor
      // once the gesture actually starts.
      draggable={context.basePath !== ""}
      onDragStart={handleDragStart}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PER_DEPTH_PX }}
      className={cn(
        "flex h-6 w-full cursor-default select-none items-center gap-1 rounded pr-2 font-mono text-xs",
        // Selection is a neutral surface lift, not an accent fill: the tree has
        // hover, selection and container focus all live at once, and the accent
        // is reserved for a single load-bearing signal per focus region.
        "transition-colors duration-150 ease-out",
        isSelected ? "bg-overlay-subtle text-daintree-text" : "text-daintree-text/70",
        !isSelected && "hover:bg-tint/5",
        // The row whose context menu is open lifts to a distinct neutral tier
        // (raised, not the selection's subtle) so it reads as "the menu targets
        // this row" without masquerading as the selection. Radix forwards
        // data-state onto this surface through the asChild trigger below.
        "data-[state=open]:bg-overlay-raised data-[state=open]:text-daintree-text"
      )}
    >
      {row.isDirectory ? (
        // A span, not a button: the row already exposes expansion through
        // `aria-expanded`, and a focusable control marked `aria-hidden` is a
        // node the keyboard can reach but a screen reader cannot describe.
        <span
          onClick={handleChevronClick}
          onDoubleClick={handleChevronDoubleClick}
          aria-hidden="true"
          className="flex h-4 w-4 shrink-0 items-center justify-center text-daintree-text/40"
        >
          <Chevron className="h-3 w-3" />
        </span>
      ) : (
        context.hasDirectories && <span className="h-4 w-4 shrink-0" />
      )}
      {/*
        Rendered bare, never wrapped: the row's first element child is the
        chevron gutter when folders are present and this icon when they are
        not, and the tree's layout contract is asserted on exactly that.

        Solid color rather than the old `/30`–`/40` alpha — at 14px an
        alpha-reduced stroke is barely a shape cue, let alone a type cue. The
        FILE_TREE_ICON_CLASS marker is what `prefers-contrast: more` repaints
        to monochrome; see `src/index.css`.
      */}
      <RowIcon
        className={cn(FILE_TREE_ICON_CLASS, "h-3.5 w-3.5 shrink-0", rowIconColor)}
        aria-hidden="true"
      />
      <span className={cn("truncate", isSelected && "font-medium")}>{row.name}</span>
      {showLoadingSpinner && (
        // Subdued via `text-daintree-text/40` (Spinner strokes currentColor) so
        // it stays quiet even on a selected row, per accent restraint.
        <span
          role="status"
          aria-label={`Loading contents of ${row.name}`}
          className="ml-1 inline-flex shrink-0 text-daintree-text/40"
        >
          <Spinner size="xs" />
        </span>
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
    <div className="h-6 w-full px-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowSurface}</ContextMenuTrigger>
        <ContextMenuContent>{menuItems}</ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
