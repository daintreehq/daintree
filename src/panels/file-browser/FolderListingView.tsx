import { useCallback, useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import { FileSymlink, Folder, FolderSymlink } from "lucide-react";
import { join } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { FILE_DRAG_MIME, encodeFileDragPaths } from "@/lib/fileDragPayload";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { stopFileRowMenuPropagation } from "@/hooks/useFileRowMenuItems";
import type { FileEntryLike, FolderListingRow } from "./fileBrowserTree";
import { FILE_TREE_ICON_CLASS, FILE_TREE_ICON_COLOR_CLASS, getFileTypeIcon } from "./fileTypeIcons";

const ROW_HEIGHT_PX = 28;

/**
 * Stands in for a column with nothing to show. A folder has no byte size and a
 * snapshot-restored row has neither size nor modified time (#11367 stores
 * structure only), so both columns need a rendering for "unknown" that isn't a
 * misleading zero.
 */
const UNKNOWN = "—";

export interface FolderListingViewProps {
  rows: FolderListingRow[];
  /**
   * Selecting an entry, which is this surface's whole click contract: a folder
   * re-points the listing at itself, a file opens in the viewer.
   *
   * Unlike the tree's callback, a folder here DOES re-target the viewer, and
   * that asymmetry is the point: this surface is already inside the viewer, so
   * drilling into a folder is what the user came here to do. The tree's job is
   * to navigate without disturbing the viewer; this one's job is to drive it.
   * `isDirectory` still travels so the caller never has to re-derive the kind.
   *
   * Deliberately no double-click counterpart to the tree's (#11496). Selecting
   * is what replaces the listing's contents, so the first click of any
   * double-click unmounts the row before the second arrives — a dblclick
   * handler here could never fire. Re-rooting a folder from this surface lives
   * in the row's context menu ("Set as root"), which is reachable.
   */
  onSelect: (path: string, isDirectory: boolean) => void;
  /** Same callback the tree uses, so both surfaces offer the identical menu. */
  rowContextMenu?: (row: FileEntryLike) => React.ReactNode;
  /**
   * Absolute path the rows are relative to. Empty when no source resolves,
   * which is the signal that rows can't be dragged anywhere useful (#11576).
   */
  basePath: string;
  /** Accessible name; the column headers are decorative and can't supply one. */
  label: string;
}

/**
 * Virtualized listing of one folder's contents (#11620) — the viewer-column
 * counterpart to `FileTreeView`, showing what a folder holds rather than
 * leaving a selected folder looking the same as no selection at all.
 *
 * Rendered as flex rows through `react-virtuoso` rather than a table: the tree
 * beside it is already virtualized the same way, and a real `<table>` can't be
 * windowed without either fixing every column width or giving up on the
 * semantics that made it a table.
 *
 * The header is a plain sticky sibling of the list, not part of it. That is
 * partly forced — `fixedHeaderContent` exists only on `TableVirtuoso` — and
 * partly the point: the labels are decorative (sorting lives in the toolbar
 * menu, the single home for that control), so keeping them outside the
 * virtualized DOM lets them be `aria-hidden` without hiding any row.
 */
export function FolderListingView({
  rows,
  onSelect,
  rowContextMenu,
  basePath,
  label,
}: FolderListingViewProps) {
  const context: ListingContext = useMemo(
    () => ({ onSelect, rowContextMenu, basePath }),
    [onSelect, rowContextMenu, basePath]
  );

  return (
    // A labelled group rather than a `listbox`: Virtuoso renders an element
    // between its scroller and the rows, so `option` children would not be
    // owned by the list that claimed them — and this surface has no roving
    // focus or arrow-key navigation to back the role up either. The tree next
    // to it is the keyboard-navigable view of the same data; this one states
    // what it is and marks the current row, and promises nothing more.
    <div
      role="group"
      aria-label={label}
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
    >
      {/*
        Decorative, and deliberately not a sortable header: sorting has exactly
        one home (the toolbar menu), and a header that looks clickable but isn't
        is worse than one that never invited the click. `aria-hidden` rather
        than `role="columnheader"` for the same reason — with no `aria-sort` to
        carry and no table to head, announcing them would promise a structure
        the list doesn't have.
      */}
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center gap-3 border-b border-overlay px-3 py-1 text-[11px] font-medium text-daintree-text/40"
      >
        <span className="min-w-0 flex-1">Name</span>
        <span className="w-20 shrink-0 text-right">Size</span>
        <span className="w-24 shrink-0 text-right">Modified</span>
      </div>
      <div className="min-h-0 flex-1">
        <Virtuoso<FolderListingRow, ListingContext>
          data={rows}
          context={context}
          computeItemKey={computeRowKey}
          itemContent={renderRow}
          fixedItemHeight={ROW_HEIGHT_PX}
          skipAnimationFrameInResizeObserver
          className="h-full w-full overflow-y-auto"
        />
      </div>
    </div>
  );
}

interface ListingContext {
  onSelect: (path: string, isDirectory: boolean) => void;
  rowContextMenu?: ((row: FileEntryLike) => React.ReactNode) | undefined;
  basePath: string;
}

/**
 * Keyed by path, never by index: re-sorting from the toolbar menu reorders
 * every row at once, and an index key would have Virtuoso reuse a row's DOM for
 * a different entry rather than move it.
 */
function computeRowKey(_index: number, row: FolderListingRow): string {
  return row.path;
}

function renderRow(_index: number, row: FolderListingRow, context: ListingContext) {
  return <FolderListingRowView row={row} context={context} />;
}

interface FolderListingRowViewProps {
  row: FolderListingRow;
  context: ListingContext;
}

function FolderListingRowView({ row, context }: FolderListingRowViewProps) {
  const { onSelect } = context;

  // Single click selects, and selecting is the whole gesture here: a folder
  // re-points this listing at itself (the flat equivalent of the tree's
  // expand-on-click "look inside"), and a file opens in the viewer. Either way
  // the listing's contents change, which is why there is no double-click
  // counterpart — see the note on `onSelect` in the props above.
  const handleClick = useCallback(() => {
    onSelect(row.path, row.isDirectory);
  }, [onSelect, row.path, row.isDirectory]);

  // Byte-for-byte the tree's drag contract (#11576), down to the single MIME
  // type and the absent `text/plain`: a row dragged from either column has to
  // arrive at an agent as the same reference, or the two would be different
  // affordances that merely look alike.
  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const { dataTransfer } = event;
    if (context.basePath === "") {
      event.preventDefault();
      return;
    }
    dataTransfer.setData(FILE_DRAG_MIME, encodeFileDragPaths([join(context.basePath, row.path)]));
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setDragImage(event.currentTarget, 12, ROW_HEIGHT_PX / 2);
  };

  // Same rule as the tree: a link's glyph says "link" (#11939), and the
  // description carries where it points and why it may be inert.
  const RowIcon = row.symlink
    ? row.isDirectory
      ? FolderSymlink
      : FileSymlink
    : row.isDirectory
      ? Folder
      : getFileTypeIcon(row.name).Icon;
  // Wording keys off the resolved kind, never off a bare "not inside" bit: a
  // link we could not read at all must not be announced as pointing outside
  // the workspace, which would be a claim we never verified.
  const symlinkDescription = row.symlink
    ? row.symlink.targetKind === "broken"
      ? `Broken symlink to ${row.symlink.target}`
      : row.symlink.targetKind === "external"
        ? `Symlink to ${row.symlink.target}, outside this folder`
        : row.symlink.targetKind === "unknown"
          ? `Symlink to ${row.symlink.target}, unreadable`
          : `Symlink to ${row.symlink.target}`
    : null;

  const menuItems = context.rowContextMenu?.(row);
  const rowSurface = (
    <div
      aria-label={row.name}
      draggable={context.basePath !== ""}
      onDragStart={handleDragStart}
      onClick={handleClick}
      className={cn(
        "flex h-7 w-full cursor-default select-none items-center gap-3 rounded px-2 font-mono text-xs",
        // Neutral hover, no selected state: clicking a row always replaces what
        // this listing is showing, so no row is ever the standing selection —
        // a highlight would only ever paint for the frame before it unmounts.
        "text-daintree-text/70 transition-colors duration-150 ease-out hover:bg-tint/5",
        "data-[state=open]:bg-overlay-raised data-[state=open]:text-daintree-text"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <RowIcon
          className={cn(FILE_TREE_ICON_CLASS, "h-3.5 w-3.5 shrink-0", FILE_TREE_ICON_COLOR_CLASS)}
          aria-hidden="true"
        />
        <span className="truncate" title={symlinkDescription ?? undefined}>
          {row.name}
        </span>
        {symlinkDescription && <span className="sr-only">{symlinkDescription}</span>}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums text-daintree-text/50">
        {formatSize(row)}
      </span>
      <span className="w-24 shrink-0 truncate text-right text-daintree-text/50">
        {row.mtimeMs == null ? UNKNOWN : formatRelativeTime(row.mtimeMs)}
      </span>
    </div>
  );

  if (!menuItems) {
    return <div className="h-7 w-full px-1">{rowSurface}</div>;
  }

  return (
    <div className="h-7 w-full px-1">
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

/**
 * A folder reports how many entries it holds, never a byte total: summing a
 * directory means walking it, and this listing is built entirely from what is
 * already cached. A count is only known when that folder happens to have been
 * listed too — otherwise the column says nothing rather than claiming zero.
 */
function formatSize(row: FolderListingRow): string {
  if (row.isDirectory) {
    if (row.itemCount == null) return UNKNOWN;
    return row.itemCount === 1 ? "1 item" : `${row.itemCount} items`;
  }
  return row.size == null ? UNKNOWN : formatBytes(row.size);
}
