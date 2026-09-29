import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffStat } from "@/components/ui/DiffStat";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from "react-virtuoso";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { shouldVirtualizeFileList } from "@/lib/fileListWindowing";
import { basename, dirname, join } from "@shared/utils/path";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  stopFileRowMenuPropagation,
  useFileRowMenuItems,
} from "@/hooks/useFileRowMenuItems";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { useRovingRows, type UseRovingRowsResult } from "@/hooks/useRovingRows";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { DIFF_STATUS_CONFIG, formatDiffDir, summarizeChangeSet } from "./diffChangeSet";
import type { DiffChangeSetEntry } from "./diffChangeSet";
import { pluralize } from "@/lib/pluralize";

export interface DiffFileSidebarProps {
  files: DiffChangeSetEntry[];
  /** Index of the open file within `files`; -1 when nothing matches. */
  currentIndex: number;
  worktreePath: string;
  /**
   * Worktree the files belong to, resolved by the pane. `null` drops
   * `Copy context` from the row menu — CopyTree is worktree-scoped (#11482).
   */
  worktreeId?: string | null;
  onSelect: (index: number) => void;
}

interface IndexedEntry extends DiffChangeSetEntry {
  index: number;
}

interface DirGroup {
  dir: string;
  files: IndexedEntry[];
}

/** Per-row inputs, shared by the static and windowed paths so they cannot drift. */
interface ShelfRowContext {
  currentIndex: number;
  viewedSet: ReadonlySet<string>;
  worktreePath: string;
  hasRowMenu: boolean;
  onSelect: (index: number) => void;
  toggleViewed: (worktreePath: string, viewedKey: string) => void;
  renderFileRowMenuItems: ReturnType<typeof useFileRowMenuItems>["renderItems"];
  tabStopKey: string | null;
  onRowFocus: UseRovingRowsResult["onRowFocus"];
  rowRef: UseRovingRowsResult["rowRef"];
  reportTabStopMounted: UseRovingRowsResult["reportTabStopMounted"];
}

/**
 * One file line in the shelf.
 *
 * `file.index` is the entry's position in the ORIGINAL changeset, not in the
 * filtered, grouped display order — `onSelect` and `aria-current` both speak
 * that coordinate system, and windowing must not quietly swap it for the
 * display index.
 */
function DiffShelfRow({ file, ctx }: { file: IndexedEntry; ctx: ShelfRowContext }) {
  const config = DIFF_STATUS_CONFIG[file.status] ?? DIFF_STATUS_CONFIG.untracked;
  const viewed = ctx.viewedSet.has(file.viewedKey);
  const isCurrent = file.index === ctx.currentIndex;
  const rowKey = String(file.index);
  const isTabStop = ctx.tabStopKey === rowKey;
  const { reportTabStopMounted } = ctx;
  // The shelf windows its rows; the list has to know when the one row that
  // holds the tab stop has been scrolled out of the DOM.
  useEffect(() => {
    if (!isTabStop) return;
    reportTabStopMounted(true);
    return () => reportTabStopMounted(false);
  }, [isTabStop, reportTabStopMounted]);
  const row = (
    <div
      data-file-index={file.index}
      data-roving-row=""
      // The shared selected-row fill; `aria-current` on the button is what AT hears.
      data-selected={isCurrent ? "true" : undefined}
      // On the row, not the button: a click on the viewed box moves the cursor
      // too, so the next arrow press starts from the row the user touched.
      onFocus={() => ctx.onRowFocus(rowKey)}
      // Stands the global Shift+F10 / Menu-key handler down so
      // the row's own menu opens instead of the focused panel's
      // (`useGlobalKeybindings` matches on the attribute's
      // presence). Absent without a menu to open, so the key
      // falls through to that handler as it did before.
      data-row-menu={ctx.hasRowMenu ? "" : undefined}
      className={cn(
        LIST_DETAIL_ROW_CLASS,
        "group/diffrow flex items-center rounded-[var(--radius-md)] px-1.5 py-1 text-xs font-mono"
      )}
    >
      <button
        type="button"
        onClick={() => ctx.onSelect(file.index)}
        ref={ctx.rowRef(rowKey)}
        // One tab stop for the whole shelf; the arrow keys move it.
        tabIndex={isTabStop ? 0 : -1}
        aria-keyshortcuts="V"
        // The viewed box is out of the tab order, so its state rides here.
        aria-description={viewed ? "Viewed" : undefined}
        onKeyDown={(event) => {
          // The viewed box is out of the tab order with every other control in
          // the row, so its key lives on the row's own button.
          if (
            event.key.toLowerCase() === "v" &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            ctx.toggleViewed(ctx.worktreePath, file.viewedKey);
            return;
          }
          if (!ctx.hasRowMenu || !isFileRowMenuKey(event)) return;
          // Anchored to the whole row, not this button: the menu
          // targets the file, and the row is what lifts to show
          // which one.
          event.preventDefault();
          event.stopPropagation();
          openFileRowMenuFromKeyboard(event.currentTarget.parentElement);
        }}
        aria-current={isCurrent || undefined}
        aria-label={`Open ${file.path}`}
        className="-my-1 -ml-1.5 flex min-w-0 flex-1 items-center rounded-[var(--radius-md)] py-1 pr-1 pl-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        data-testid="diff-sidebar-file"
      >
        <span className={cn("w-4 shrink-0 font-bold", config.color)}>{config.label}</span>
        <span
          className={cn(
            "truncate font-medium",
            viewed ? "text-text-secondary" : "text-text-primary"
          )}
        >
          {basename(file.path)}
        </span>
        <DiffStat
          insertions={file.insertions}
          deletions={file.deletions}
          className="ml-auto shrink-0 pl-2 text-2xs"
        />
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Checkbox
            size="sm"
            checked={viewed}
            onCheckedChange={() => ctx.toggleViewed(ctx.worktreePath, file.viewedKey)}
            aria-label={`Mark ${file.path} as viewed`}
            tabIndex={-1}
            className={cn(
              // A 14px box with a 24px hit area (WCAG 2.5.8); the pseudo-element
              // stays inside the row's own padding.
              "ml-1.5 before:absolute before:-inset-[5px] before:content-['']",
              // Unviewed boxes only show on the row that is being pointed at or
              // tabbed through, so a long list is not a column of empty squares.
              !viewed &&
                "opacity-0 group-hover/diffrow:opacity-100 group-focus-within/diffrow:opacity-100 focus-visible:opacity-100"
            )}
            data-testid="diff-sidebar-viewed-toggle"
          />
        </TooltipTrigger>
        <TooltipContent side="right">Viewed</TooltipContent>
      </Tooltip>
    </div>
  );

  // Every item in the row menu names a path on disk, and the
  // entries here are worktree-relative. A pane whose worktree
  // hasn't resolved reports an empty root (`DiffPane` does this
  // deliberately rather than guessing), and joining against it
  // would hand `file.view` a relative path it resolves against
  // the *current project* — a different repo, a different file.
  // No root, no row menu: the same state this surface shipped in
  // before it had one.
  if (!ctx.hasRowMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={stopFileRowMenuPropagation}>
        {row}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {ctx.renderFileRowMenuItems(
          {
            absolutePath: join(ctx.worktreePath, file.path),
            relativePath: file.path,
            name: basename(file.path),
            isDirectory: false,
            status: file.status,
          },
          {
            // Steps this sidebar's own viewer rather than opening
            // a second diff dialog over it.
            onOpenDiff: () => ctx.onSelect(file.index),
            hasChanges: true,
          }
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The directory band above each run of files. Sticky on the windowed path. */
function DiffShelfGroupHeader({ dir }: { dir: string }) {
  return (
    <div className="flex items-center gap-1.5 bg-surface-sidebar px-1.5 py-1 text-2xs text-text-secondary">
      <Folder className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{formatDiffDir(dir)}</span>
    </div>
  );
}

/**
 * Changed-files shelf for the diff workspace: changeset summary, review
 * progress, filter, and a directory-grouped file list with per-file viewed
 * markers. Selection is a neutral surface lift — the diff canvas owns the
 * focus accent.
 */
export function DiffFileSidebar({
  files,
  currentIndex,
  worktreePath,
  worktreeId = null,
  onSelect,
}: DiffFileSidebarProps) {
  const [filter, setFilter] = useState("");
  // The one file-row menu, shared with the worktree card, the file browser and
  // the Review Hub (#11757). Built once for the list, rendered per row.
  const { renderItems: renderFileRowMenuItems } = useFileRowMenuItems({
    worktreePath,
    worktreeId,
  });
  // Whether rows get a menu at all — see the comment at the row's return below.
  // Everything that stands the global menu key down hangs off this, so a row
  // without a trigger never claims a key it can't answer.
  const hasRowMenu = worktreePath !== "";
  const listRef = useRef<HTMLDivElement | null>(null);
  const viewedSet = useDiffViewedStore(
    useCallback((state) => selectViewedSet(state, worktreePath), [worktreePath])
  );
  const toggleViewed = useDiffViewedStore((state) => state.toggleViewed);

  const summary = useMemo(() => summarizeChangeSet(files), [files]);
  const viewedCount = useMemo(
    () => files.reduce((count, file) => (viewedSet.has(file.viewedKey) ? count + 1 : count), 0),
    [files, viewedSet]
  );

  const groups = useMemo((): DirGroup[] => {
    const query = filter.trim().toLowerCase();
    const grouped = new Map<string, IndexedEntry[]>();
    files.forEach((file, index) => {
      if (query && !file.path.toLowerCase().includes(query)) return;
      const dir = dirname(file.path);
      const key = !dir || dir === "." ? "" : dir;
      const bucket = grouped.get(key);
      if (bucket) bucket.push({ ...file, index });
      else grouped.set(key, [{ ...file, index }]);
    });
    return Array.from(grouped.entries())
      .map(([dir, groupFiles]) => ({ dir, files: groupFiles }))
      .sort((a, b) => {
        if (a.dir === "") return -1;
        if (b.dir === "") return 1;
        return a.dir.localeCompare(b.dir);
      });
  }, [files, filter]);

  const visibleCount = useMemo(
    () => groups.reduce((count, group) => count + group.files.length, 0),
    [groups]
  );

  // The grouped virtualizer wants the same list twice over: the files flat, and
  // how many of them fall under each directory header. `slotIndexByFileIndex`
  // is the bridge back — reveal speaks slot order, everything else (the open
  // file, `onSelect`, `aria-current`) speaks the original changeset's order.
  const flat = useMemo(() => {
    const entries: IndexedEntry[] = [];
    const counts: number[] = [];
    const dirs: string[] = [];
    // `itemContent` is the odd one out: it is called with the file-only index,
    // while `computeItemKey` and the imperative handle's `scrollIntoView` /
    // `scrollToIndex` all speak the raw SLOT index, which COUNTS GROUP HEADERS.
    // Indexing the file array with a slot hands the first file the second
    // file's key — and a key that names the wrong row is how React moves one
    // file's open menu onto another file. Handing a file-only index to the
    // reveal scrolls short by every header ahead of it. So the keys are built
    // once, in slot order, and `keysBySlot.length` IS the slot the next file
    // lands on, headers already counted.
    const keysBySlot: string[] = [];
    const slotIndexByFileIndex = new Map<number, number>();
    for (const group of groups) {
      counts.push(group.files.length);
      dirs.push(group.dir);
      keysBySlot.push(`group:${group.dir || "(root)"}`);
      for (const file of group.files) {
        slotIndexByFileIndex.set(file.index, keysBySlot.length);
        entries.push(file);
        keysBySlot.push(`file:${file.viewedKey}-${file.index}`);
      }
    }
    return { entries, counts, dirs, slotIndexByFileIndex, keysBySlot };
  }, [groups]);

  const virtuosoRef = useRef<GroupedVirtuosoHandle | null>(null);
  // Unlike the Review Hub's sections, this shelf's list area is a scroller of
  // its own with nothing else in it — so the virtualizer OWNS that scroller
  // rather than windowing against an ancestor. That buys two things the hub
  // cannot have: the reveal is Virtuoso's own scroll, with no parent-offset
  // arithmetic to get wrong, and windowing starts on the first commit instead
  // of after a full static render.
  const windowed = shouldVirtualizeFileList(visibleCount);

  const rovingKeys = useMemo(() => flat.entries.map((file) => String(file.index)), [flat]);
  const revealRovingRow = useCallback(
    (position: number) => {
      const file = flat.entries[position];
      const slotIndex = file ? flat.slotIndexByFileIndex.get(file.index) : undefined;
      if (slotIndex === undefined) return;
      virtuosoRef.current?.scrollIntoView({ index: slotIndex, behavior: "auto" });
    },
    [flat]
  );
  const roving = useRovingRows({
    keys: rovingKeys,
    preferredKey: currentIndex >= 0 ? String(currentIndex) : null,
    reveal: revealRovingRow,
    windowed,
    containerRef: listRef,
  });
  const { tabStopKey, onRowFocus, rowRef, reportTabStopMounted } = roving;

  const rowContext: ShelfRowContext = useMemo(
    () => ({
      currentIndex,
      viewedSet,
      worktreePath,
      hasRowMenu,
      onSelect,
      toggleViewed,
      renderFileRowMenuItems,
      tabStopKey,
      onRowFocus,
      rowRef,
      reportTabStopMounted,
    }),
    [
      currentIndex,
      viewedSet,
      worktreePath,
      hasRowMenu,
      onSelect,
      toggleViewed,
      renderFileRowMenuItems,
      tabStopKey,
      onRowFocus,
      rowRef,
      reportTabStopMounted,
    ]
  );

  // Bumped the first time the virtualizer reports a rendered range, which is
  // the first moment it has measured anything. The reveal below needs it: on
  // the mount commit Virtuoso knows no item sizes, so its scroll is a no-op —
  // and measurement, on its own, re-runs no effect. Without this a diff opened
  // on the four-hundredth file comes up at the top of the shelf.
  const [measuredGeneration, setMeasuredGeneration] = useState(0);
  const handleRangeChanged = useCallback(() => {
    setMeasuredGeneration((current) => (current === 0 ? 1 : current));
  }, []);

  // Keep the open file's row in view while stepping with the keyboard.
  // `groups` is a dependency so the row is re-revealed when a filter that hid
  // it is cleared. Windowed, the row may not exist to be queried, so the
  // virtualizer is asked for it by SLOT index instead — the handle counts group
  // headers; `scrollIntoView` leaves an already-visible row alone either way.
  useEffect(() => {
    if (currentIndex < 0) return;
    if (windowed) {
      const slotIndex = flat.slotIndexByFileIndex.get(currentIndex);
      if (slotIndex === undefined) return;
      virtuosoRef.current?.scrollIntoView({ index: slotIndex, behavior: "auto" });
      return;
    }
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-file-index="${currentIndex}"]`);
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "instant", block: "nearest" });
    }
  }, [currentIndex, groups, windowed, flat, measuredGeneration]);

  // self-stretch (not h-full): a percentage height against the dialog's
  // content-sized row collapses to content height and lets the dialog
  // surface show beneath the list — flex stretch always fills the row.
  return (
    <div
      className="flex min-h-0 w-60 shrink-0 select-none flex-col self-stretch border-r border-border-default bg-surface-sidebar"
      data-testid="diff-file-sidebar"
    >
      <div className="shrink-0 border-b border-border-default px-3.5 py-2">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium text-text-primary">{pluralize(files.length, "file")}</span>
          <DiffStat
            insertions={summary.insertions}
            deletions={summary.deletions}
            className="text-2xs"
          />
        </div>
        <div className="mt-1" data-testid="diff-sidebar-progress">
          <span className="text-2xs text-text-muted">
            {viewedCount} of {files.length} viewed
          </span>
          {/* The track only appears once review has started — an empty
              full-width strip at zero progress reads as stray chrome. */}
          {viewedCount > 0 && (
            <ProgressBar
              label="Files viewed"
              value={viewedCount}
              max={files.length}
              size="thin"
              className="mt-1"
            />
          )}
        </div>
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <SearchField
          size="compact"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onClear={() => setFilter("")}
          clearLabel="Clear file filter"
          placeholder="Filter files"
          aria-label="Filter files"
          data-testid="diff-sidebar-filter"
        />
      </div>

      <div
        onKeyDown={roving.onKeyDown}
        {...roving.containerProps}
        ref={listRef}
        className={cn(
          "min-h-0 flex-1 overscroll-contain px-2 pb-2",
          // The virtualizer brings its own scroller; two nested ones would give
          // the shelf two scrollbars.
          windowed ? "overflow-hidden" : "overflow-y-auto"
        )}
      >
        {visibleCount === 0 && (
          <EmptyState
            variant="filtered-empty"
            scale="sidebar"
            title="No files match the filter"
            action={
              <Button variant="subtle" size="sm" onClick={() => setFilter("")}>
                Clear filter
              </Button>
            }
          />
        )}
        {windowed ? (
          <GroupedVirtuoso
            ref={virtuosoRef}
            groupCounts={flat.counts}
            style={{ height: "100%" }}
            rangeChanged={handleRangeChanged}
            groupContent={(groupIndex) => (
              <DiffShelfGroupHeader dir={flat.dirs[groupIndex] ?? ""} />
            )}
            itemContent={(index) => {
              const file = flat.entries[index];
              if (!file) return null;
              // The static path spaces rows with `gap-px` and groups with
              // `mb-1.5`; a virtualizer places items itself and never sees a
              // gap, so the same space rides inside the measured item.
              return (
                <div className="pb-px">
                  <DiffShelfRow file={file} ctx={rowContext} />
                </div>
              );
            }}
            computeItemKey={(slot) => flat.keysBySlot[slot] ?? slot}
            increaseViewportBy={200}
            skipAnimationFrameInResizeObserver
          />
        ) : (
          groups.map((group) => (
            <div key={group.dir || "(root)"} className="mb-1.5">
              <DiffShelfGroupHeader dir={group.dir} />
              <div className="flex flex-col gap-px">
                {group.files.map((file) => (
                  <DiffShelfRow
                    key={`${file.viewedKey}-${file.index}`}
                    file={file}
                    ctx={rowContext}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
