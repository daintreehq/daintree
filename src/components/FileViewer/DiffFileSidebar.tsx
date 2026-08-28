import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Folder, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename, dirname, join } from "@shared/utils/path";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  stopFileRowMenuPropagation,
  useFileRowMenuItems,
} from "@/hooks/useFileRowMenuItems";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { DIFF_STATUS_CONFIG, summarizeChangeSet } from "./diffChangeSet";
import type { DiffChangeSetEntry } from "./diffChangeSet";

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

function formatDir(dir: string, maxSegments = 3): string {
  if (!dir || dir === ".") return "(root)";
  const segments = dir.split("/");
  if (segments.length <= maxSegments) return dir;
  return "…/" + segments.slice(-maxSegments).join("/");
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

  // Keep the open file's row in view while stepping with the keyboard.
  // `groups` is a dependency so the row is re-revealed when a filter that hid
  // it is cleared.
  useEffect(() => {
    if (currentIndex < 0 || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-file-index="${currentIndex}"]`);
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "instant", block: "nearest" });
    }
  }, [currentIndex, groups]);

  // self-stretch (not h-full): a percentage height against the dialog's
  // content-sized row collapses to content height and lets the dialog
  // surface show beneath the list — flex stretch always fills the row.
  return (
    <div
      className="flex min-h-0 w-60 shrink-0 select-none flex-col self-stretch border-r border-border-default bg-surface-sidebar"
      data-testid="diff-file-sidebar"
    >
      <div className="shrink-0 border-b border-border-default px-3 py-2">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium text-text-primary">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-2xs">
            {summary.insertions > 0 && (
              <span className="text-status-success">+{summary.insertions}</span>
            )}
            {summary.deletions > 0 && (
              <span className="text-status-error">-{summary.deletions}</span>
            )}
          </span>
        </div>
        <div className="mt-1" data-testid="diff-sidebar-progress">
          <span className="text-2xs text-text-muted">
            {viewedCount} of {files.length} viewed
          </span>
          {/* The track only appears once review has started — an empty
              full-width strip at zero progress reads as stray chrome. */}
          {viewedCount > 0 && (
            <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-tint/10">
              <div
                className="h-full rounded-full bg-text-secondary transition-[width] duration-150 ease-out"
                style={{ width: `${files.length ? (viewedCount / files.length) * 100 : 0}%` }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded border border-border-default bg-surface-canvas px-2 py-1 focus-within:border-daintree-accent/40 focus-within:ring-1 focus-within:ring-daintree-accent/20">
          <Search className="h-3 w-3 shrink-0 text-text-muted" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears an active filter instead of bubbling to the
              // dialog's escape stack and closing the whole workspace.
              if (event.key === "Escape" && filter) {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-placeholder focus:outline-hidden"
            data-testid="diff-sidebar-filter"
          />
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {visibleCount === 0 && (
          <EmptyState
            variant="filtered-empty"
            scale="sidebar"
            title="No files match the filter"
            action={
              <button
                type="button"
                onClick={() => setFilter("")}
                className="text-xs text-daintree-text/60 hover:text-text-primary transition-colors underline underline-offset-2"
              >
                Clear filter
              </button>
            }
          />
        )}
        {groups.map((group) => (
          <div key={group.dir || "(root)"} className="mb-1.5">
            <div className="flex items-center gap-1.5 px-1.5 py-1 text-2xs text-text-secondary">
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{formatDir(group.dir)}</span>
            </div>
            <div className="flex flex-col gap-px">
              {group.files.map((file) => {
                const config = DIFF_STATUS_CONFIG[file.status] ?? DIFF_STATUS_CONFIG.untracked;
                const viewed = viewedSet.has(file.viewedKey);
                const isCurrent = file.index === currentIndex;
                const row = (
                  <div
                    key={`${file.viewedKey}-${file.index}`}
                    data-file-index={file.index}
                    // Stands the global Shift+F10 / Menu-key handler down so
                    // the row's own menu opens instead of the focused panel's
                    // (`useGlobalKeybindings` matches on the attribute's
                    // presence). Absent without a menu to open, so the key
                    // falls through to that handler as it did before.
                    data-row-menu={hasRowMenu ? "" : undefined}
                    className={cn(
                      "group/diffrow flex items-center rounded px-1.5 py-1 text-xs font-mono transition-colors",
                      isCurrent ? "bg-overlay-subtle" : "hover:bg-tint/5",
                      // The row whose menu is open lifts a tier above the open
                      // file's own subtle fill, so the two never read as one.
                      "data-[state=open]:bg-overlay-raised"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(file.index)}
                      onKeyDown={(event) => {
                        if (!hasRowMenu || !isFileRowMenuKey(event)) return;
                        // Anchored to the whole row, not this button: the menu
                        // targets the file, and the row is what lifts to show
                        // which one.
                        event.preventDefault();
                        event.stopPropagation();
                        openFileRowMenuFromKeyboard(event.currentTarget.parentElement);
                      }}
                      aria-current={isCurrent || undefined}
                      aria-label={`Open ${file.path}`}
                      className="flex min-w-0 flex-1 items-center text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent-primary"
                      data-testid="diff-sidebar-file"
                    >
                      <span className={cn("w-4 shrink-0 font-bold", config.color)}>
                        {config.label}
                      </span>
                      <span
                        className={cn(
                          "truncate font-medium",
                          viewed ? "text-daintree-text/50" : "text-text-primary"
                        )}
                      >
                        {basename(file.path)}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-2xs">
                        {(file.insertions ?? 0) > 0 && (
                          <span className="text-status-success/80">+{file.insertions}</span>
                        )}
                        {(file.deletions ?? 0) > 0 && (
                          <span className="text-status-error/80">-{file.deletions}</span>
                        )}
                      </span>
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => toggleViewed(worktreePath, file.viewedKey)}
                          aria-pressed={viewed}
                          aria-label={`Mark ${file.path} as viewed`}
                          className={cn(
                            "ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
                            viewed
                              ? "border-status-success/60 bg-status-success/20 text-status-success"
                              : "border-border-default text-transparent opacity-0 hover:border-border-strong group-hover/diffrow:opacity-100 focus-visible:opacity-100"
                          )}
                          data-testid="diff-sidebar-viewed-toggle"
                        >
                          <Check className="h-3 w-3" />
                        </button>
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
                if (!hasRowMenu) return row;

                return (
                  <ContextMenu key={`${file.viewedKey}-${file.index}`}>
                    <ContextMenuTrigger asChild onContextMenu={stopFileRowMenuPropagation}>
                      {row}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {renderFileRowMenuItems(
                        {
                          absolutePath: join(worktreePath, file.path),
                          relativePath: file.path,
                          name: basename(file.path),
                          isDirectory: false,
                          status: file.status,
                        },
                        {
                          // Steps this sidebar's own viewer rather than opening
                          // a second diff dialog over it.
                          onOpenDiff: () => onSelect(file.index),
                          hasChanges: true,
                        }
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
