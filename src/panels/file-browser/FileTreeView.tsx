import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ChevronDown,
  ChevronRight,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderSymlink,
} from "lucide-react";
import { join } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { FILE_DRAG_MIME, encodeFileDragPaths } from "@/lib/fileDragPayload";
import { Spinner } from "@/components/ui/Spinner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { stopFileRowMenuPropagation } from "@/hooks/useFileRowMenuItems";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { resolveTreeKey, type FileEntryLike, type FlatTreeRow } from "./fileBrowserTree";
import { getFileBrowserRowGitStatus, type FileBrowserGitStatusIndex } from "./fileBrowserGitStatus";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { FILE_TREE_ICON_CLASS, FILE_TREE_ICON_COLOR_CLASS, getFileTypeIcon } from "./fileTypeIcons";
import { INSERT_FILE_REFERENCE_COMBO, matchesInsertFileReferenceCombo } from "./fileReference";

export interface FileTreeViewProps {
  // Mutable rather than `readonly`: this is exactly what the tree hook returns,
  // and widening it here would force a cast at the Virtuoso boundary.
  rows: FlatTreeRow[];
  /**
   * The row the tree itself is on — its highlight, its `aria-activedescendant`
   * and what its row-scoped commands target. Deliberately NOT "what the viewer
   * shows": moving through the tree is navigation, and navigation must not
   * re-target the viewer column behind the user (#11620 follow-up).
   */
  cursorPath: string | null;
  /**
   * What the viewer column is currently showing, when it is one of these rows.
   * Marked `aria-current` and given full-strength text — NOT a second selection
   * highlight. Once the cursor can sit somewhere else, this is the only thing
   * saying which row the other column belongs to, and without it a screen
   * reader has no way to perceive that at all.
   *
   * Two channels on purpose: the cursor owns the surface lift, the open row
   * owns text weight. Painting both as fills would just move the confusion the
   * split was meant to remove — and the accent is spoken for elsewhere.
   */
  openPath?: string | null;
  /**
   * The cursor landed on `path`. `isDirectory` travels with it because the
   * caller decides from the row's kind whether this also re-targets the viewer
   * — files do, folders never do.
   */
  onSelect: (path: string, isDirectory: boolean) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  /**
   * Fired by Enter and by double-click, on rows of either kind — the tree's one
   * "act on this" gesture, and the only way a folder reaches the viewer column.
   *
   * The two gestures are deliberately the same command. Every platform that
   * says anything about it (WinUI, GNOME HIG, the ARIA APG's treeitem pattern)
   * treats Enter and double-click as dual triggers for a row's default action,
   * and double-click is what people reach for as a faster Enter. Folders used
   * to re-root the tree here instead (#11496); re-rooting now lives only in the
   * row menu's "Set as root", which is where Visual Studio ("Scope to This")
   * and Eclipse ("Go Into") both keep the same command.
   */
  onActivate?: (path: string) => void;
  /**
   * Menu items for a row's right-click menu; return null for no menu. The
   * view owns the Radix wiring (and lifts the row while its menu is open so
   * the menu visibly targets it, without moving the selection); the pane owns
   * what the items do.
   */
  rowContextMenu?: (row: FileEntryLike) => React.ReactNode;
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
  /**
   * Git status for the rows, keyed by the same worktree-relative paths
   * `row.path` uses. Absent or null when nothing git-shaped backs this tree (a
   * workspace root, or a worktree whose snapshot hasn't arrived), which is the
   * signal to render no markers at all rather than markers meaning "unchanged".
   *
   * Deliberately a separate channel from `rows`: a directory listing doesn't
   * change when a file's status does, and threading status through the flat
   * rows would tie the two update cadences together.
   */
  gitStatusIndex?: FileBrowserGitStatusIndex | null;
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
  cursorPath,
  openPath = null,
  onSelect,
  onToggleExpanded,
  onActivate,
  rowContextMenu,
  onInsertFileReference,
  canInsertFileReference = false,
  basePath,
  label,
  gitStatusIndex = null,
}: FileTreeViewProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Two browsers can be open on the same worktree, and both would otherwise
  // mint `file-browser-row-src/index.ts` — duplicate DOM ids that make
  // `aria-activedescendant` ambiguous.
  const instanceId = useId();

  const cursorIndex = useMemo(
    () => (cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath)),
    [rows, cursorPath]
  );

  // The rows array changes identity on every listing update, so the handler is
  // rebuilt with it. Reading through a ref instead would let a keypress act on
  // a tree the user is no longer looking at.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // A row's context menu portals out of this container but still bubbles
      // its keys through the React tree, so every branch below would otherwise
      // act on the *cursor* row while the user is driving a menu opened on a
      // different one — Enter activating the wrong file, arrows moving the
      // cursor behind the open menu. Radix owns those keys while its menu
      // is up; the tree only handles what actually happened inside it.
      if (!isEventInsideTree(event, containerRef.current)) return;

      // Shift+F10 / the ContextMenu key open the cursor row's menu — the
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
      if (isMenuKey && rowContextMenu && cursorPath !== null) {
        const rowElement = document.getElementById(rowDomId(instanceId, cursorPath));
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
      // Gated on the cursor resolving to a *rendered* row, not merely on a
      // non-null path: re-rooting the tree leaves the cursor naming the old
      // root, which no longer appears in `rows`. Firing then would reference a
      // row the user cannot see and that `aria-activedescendant` has already
      // disowned.
      //
      // Auto-repeat is dropped: holding the combo would append the same token
      // over and over. It also keeps a user-rebound global Cmd+I from turning
      // into this command — the global handler ignores repeats, so every
      // repeat after its first press would otherwise fall through to here.
      if (
        onInsertFileReference &&
        canInsertFileReference &&
        cursorPath !== null &&
        cursorIndex >= 0 &&
        !event.repeat &&
        matchesInsertFileReferenceCombo(event.nativeEvent, isMac())
      ) {
        event.preventDefault();
        event.stopPropagation();
        onInsertFileReference(cursorPath);
        return;
      }

      const intent = resolveTreeKey(event.key, rows, cursorPath);
      if (!intent) return;
      event.preventDefault();

      switch (intent.type) {
        // Arrowing is navigation, so it moves the cursor and nothing else for a
        // folder. Landing on a *file* still opens it in the viewer — that is
        // selection-follows-focus for leaves only, the same asymmetry a click
        // has, and it is what keeps arrow-browsing a set of files useful.
        case "select": {
          const target = rows.find((candidate) => candidate.path === intent.path);
          onSelect(intent.path, target?.isDirectory === true);
          break;
        }
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
      cursorPath,
      cursorIndex,
      onSelect,
      onToggleExpanded,
      onActivate,
      rowContextMenu,
      onInsertFileReference,
      canInsertFileReference,
      instanceId,
    ]
  );

  // Keep the cursor on screen when it moves. Runs after commit, never during
  // render: an abandoned concurrent render would otherwise scroll for state
  // that never committed, and suppress the scroll on the render that did.
  // `scrollIntoView` leaves an already-visible row alone, so clicking a visible
  // row never yanks the list; `auto` only picks an instant jump over a smooth
  // one.
  //
  // Only two changes are worth revealing: the cursor moving to another row, and
  // a cursor that had no row acquiring one — a restored cursor on mount, or a
  // reveal whose ancestors expand a beat after `cursorPath` lands on the target.
  // A bare `cursorIndex` change is neither. Expanding a folder resplices `rows`,
  // so every row below it — including a stationary cursor — takes a new index,
  // and scrolling for that drags the view off the folder the user just opened
  // (#11684). Live refreshes and re-sorts shift indices the same way.
  const previousCursorRef = useRef<{ path: string | null; found: boolean }>({
    // Starts unfound so a cursor that already resolves on the first commit
    // still reads as newly appearing and gets revealed.
    path: null,
    found: false,
  });
  useEffect(() => {
    const previous = previousCursorRef.current;
    const found = cursorIndex >= 0;
    // Recorded before the early return, and in the effect rather than in render:
    // an unreachable cursor is still the baseline the next commit compares
    // against, and only a committed write makes "appeared" mean what it says.
    previousCursorRef.current = { path: cursorPath, found };
    if (!found) return;

    const moved = previous.path !== cursorPath;
    const appeared = !previous.found;
    if (!moved && !appeared) return;

    virtuosoRef.current?.scrollIntoView({ index: cursorIndex, behavior: "auto" });
  }, [cursorIndex, cursorPath]);

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
      cursorPath,
      openPath,
      onSelect,
      onToggleExpanded,
      onActivate,
      rowContextMenu,
      hasDirectories,
      instanceId,
      basePath,
      gitStatusIndex,
    }),
    [
      cursorPath,
      openPath,
      onSelect,
      onToggleExpanded,
      onActivate,
      rowContextMenu,
      hasDirectories,
      instanceId,
      basePath,
      gitStatusIndex,
    ]
  );

  // Only advertise an active descendant that is actually rendered. A cursor
  // scrolled out of the virtualized window — or deleted by a live update — has
  // no DOM node, and pointing at a missing id is worse than pointing at none.
  const activeDescendant =
    cursorPath !== null && cursorIndex >= 0 ? rowDomId(instanceId, cursorPath) : undefined;

  // Only advertised while the shortcut would actually do something — announcing
  // Cmd+I with no reachable agent, or with a cursor that no longer resolves
  // to a row, would be promising a no-op. Matches the handler's own gate.
  const insertKeyshortcuts =
    onInsertFileReference && canInsertFileReference && cursorIndex >= 0
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
  cursorPath: string | null;
  openPath: string | null;
  onSelect: (path: string, isDirectory: boolean) => void;
  onToggleExpanded: (path: string, expand: boolean) => void;
  onActivate?: ((path: string) => void) | undefined;
  rowContextMenu?: ((row: FileEntryLike) => React.ReactNode) | undefined;
  hasDirectories: boolean;
  instanceId: string;
  basePath: string;
  gitStatusIndex: FileBrowserGitStatusIndex | null;
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
  const isSelected = context.cursorPath === row.path;
  const isOpen = context.openPath === row.path;
  return <FileTreeRow row={row} isSelected={isSelected} isOpen={isOpen} context={context} />;
}

interface FileTreeRowProps {
  row: FlatTreeRow;
  isSelected: boolean;
  isOpen: boolean;
  context: TreeContext;
}

function FileTreeRow({ row, isSelected, isOpen, context }: FileTreeRowProps) {
  const { onSelect, onToggleExpanded, onActivate } = context;

  // Defer the folder-load spinner past the anti-flicker gate so a fast
  // expansion flashes nothing. Drives only the indicator — the tree's content
  // and children stay wired to the raw `row.isLoading`/listings state. Virtuoso
  // unmounts off-screen rows, so this cosmetic timer restarts if a still-loading
  // row scrolls out of view and back; harmless (the fetch itself keeps running).
  const showLoadingSpinner = useDeferredLoading(row.isLoading, UI_INLINE_LOADING_GATE_MS);

  // A folder click is navigation and only navigation: it moves the cursor here
  // and opens the branch. It deliberately does NOT re-target the viewer column,
  // because expanding a folder to look for something else is the single most
  // common gesture in this tree, and having it replace whatever file the user
  // was reading made the viewer unusable as a place to keep something open.
  //
  // That rule already existed one handler down — the chevron has always refused
  // to move the selection — and the row click was the odd one out. Files still
  // re-target the viewer on a single click: a leaf has nothing to navigate into,
  // so opening it is the only thing the gesture could mean.
  const handleClick = () => {
    onSelect(row.path, row.isDirectory);
    if (row.isDirectory) onToggleExpanded(row.path, !row.isExpanded);
  };

  // One command for both kinds, and the same one Enter runs: show a folder in
  // the viewer, open a file as its own panel (#11496). A folder used to re-root
  // the tree from here, which spent the one gesture everyone reads as "activate
  // this" on a structural jump nobody else binds to it — Eclipse is the only
  // IDE that offers re-root-on-double-click at all, and ships it off by default.
  //
  // The two single clicks a double-click contains toggle expansion twice (a net
  // no-op) and leave the viewer alone; on a file they only re-select the row. So
  // the double-click's own effect is the only observable one either way.
  const handleDoubleClick = onActivate
    ? () => {
        onActivate(row.path);
      }
    : undefined;

  const handleChevronClick = (event: React.MouseEvent) => {
    // Toggling from the chevron must not move the cursor either: it is the
    // "peek inside without leaving where I am" affordance. Now that the row
    // click has stopped re-targeting the viewer, this is the only thing still
    // separating the two — the chevron leaves the tree's own highlight where it
    // was, which is what keeps a row-scoped command (Cmd+I, the menu key)
    // pointed at the file the user picked while they open folders around it.
    event.stopPropagation();
    onToggleExpanded(row.path, !row.isExpanded);
  };

  // The chevron is the double-click's near-miss zone; activating from it would
  // punish a fast expand-collapse with a viewer the user never asked to move.
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
  // A symlink says so in the glyph itself rather than through a badge layered
  // over the type icon: the row's icon slot is a single bare element by
  // contract (see below), and "this is a link" outranks the file's extension
  // for a row that used to be invisible entirely (#11939).
  const RowIcon = row.symlink
    ? row.isDirectory
      ? FolderSymlink
      : FileSymlink
    : row.isDirectory
      ? FolderIcon
      : getFileTypeIcon(row.name).Icon;
  // What the link points at, and why it is inert when it is. Out-of-root
  // targets are deliberately never dereferenced, so "unknown" is the honest
  // word for what is on the other side rather than a failure to look.
  const symlinkDescription = row.symlink
    ? row.symlink.targetKind === "broken"
      ? `Broken symlink to ${row.symlink.target}`
      : !row.symlink.insideRoot
        ? `Symlink to ${row.symlink.target}, outside this folder`
        : `Symlink to ${row.symlink.target}`
    : null;

  // A file's own status; a folder's is the worst thing anywhere beneath it, so a
  // collapsed branch still says that something inside it changed.
  const gitStatus = getFileBrowserRowGitStatus(context.gitStatusIndex, row.path, row.isDirectory);
  const gitPresentation = gitStatus ? getGitStatusPresentation(gitStatus) : null;
  const gitDescription = gitPresentation
    ? row.isDirectory
      ? `Contains ${gitPresentation.name.toLowerCase()} changes`
      : gitPresentation.name
    : null;
  const rowId = rowDomId(context.instanceId, row.path);
  const gitMarkerId = gitPresentation ? `${rowId}-git` : undefined;
  const symlinkMarkerId = symlinkDescription ? `${rowId}-symlink` : undefined;
  // Space-separated id list: a row can be both a link and changed, and the two
  // descriptions are owned by different concerns.
  const describedBy = [gitMarkerId, symlinkMarkerId].filter(Boolean).join(" ") || undefined;

  const menuItems = context.rowContextMenu?.(row);
  const rowSurface = (
    <div
      id={rowId}
      role="treeitem"
      // Pin the accessible name to the row name so the nested loading
      // `role="status"` (below) can't fold "Loading folder contents" into it.
      aria-label={row.name}
      // The status rides a description, not the name: the name is pinned to the
      // filename above, and rows are virtualized — folding status into the name
      // would rewrite every accessible row query and re-announce the row as a
      // different thing whenever an agent touched the file.
      {...(describedBy && { "aria-describedby": describedBy })}
      aria-level={row.depth + 1}
      aria-selected={isSelected}
      // "The viewer is showing this one" — a different question from which row
      // the tree's cursor is on, and the only channel that answers it once the
      // two diverge. `true` rather than `page`: the viewer is a companion
      // column, not a navigation destination.
      {...(isOpen && { "aria-current": true })}
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
        isSelected
          ? "bg-overlay-subtle text-daintree-text"
          : // Full-strength text, no fill: enough to find the open row at a
            // glance without reading as a second selection.
            isOpen
            ? "text-daintree-text"
            : "text-daintree-text/70",
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

        Solid neutral rather than the old `/30`–`/40` alpha — at 14px an
        alpha-reduced stroke is barely a shape cue, let alone a type cue. The
        FILE_TREE_ICON_CLASS marker is what `prefers-contrast: more` lifts to
        the solid text token; see `src/index.css`.
      */}
      <RowIcon
        className={cn(FILE_TREE_ICON_CLASS, "h-3.5 w-3.5 shrink-0", FILE_TREE_ICON_COLOR_CLASS)}
        aria-hidden="true"
      />
      {/* `min-w-0` is what lets `truncate` actually shrink here: a flex item
          defaults to `min-width: auto` and would otherwise push the trailing
          status marker out of the row instead of ellipsing the name. */}
      <span
        className={cn("min-w-0 truncate", isSelected && "font-medium")}
        title={symlinkDescription ?? undefined}
      >
        {row.name}
      </span>
      {symlinkMarkerId && (
        // Screen-reader only, and layout-neutral (`sr-only` is absolutely
        // positioned) so it can sit between the name and the `ml-auto` git
        // marker without disturbing either. The title above is the mouse's
        // half of the same answer.
        <span id={symlinkMarkerId} className="sr-only">
          {symlinkDescription}
        </span>
      )}
      {gitPresentation && (
        // `ml-auto` parks the marker at the trailing edge so a column of them
        // scans vertically, rather than tracking each name's ragged end.
        <span
          id={gitMarkerId}
          title={gitDescription ?? undefined}
          className={cn("ml-auto w-3 shrink-0 text-center font-bold", gitPresentation.colorClass)}
        >
          <span className="sr-only">{gitDescription}</span>
          <span aria-hidden="true">{gitPresentation.marker}</span>
        </span>
      )}
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
        {/* The innermost object owns the menu (#11757). Radix's trigger only
            prevents the default; without this the event keeps bubbling and any
            enclosing trigger opens its own menu over this one. */}
        <ContextMenuTrigger asChild onContextMenu={stopFileRowMenuPropagation}>
          {rowSurface}
        </ContextMenuTrigger>
        <ContextMenuContent>{menuItems}</ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
