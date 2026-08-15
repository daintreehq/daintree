import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileChangeDetail } from "../../types";
import { cn } from "../../lib/utils";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { Folder } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename, dirname, isAbsolute, join } from "@shared/utils/path";
import {
  buildWorkingTreeDiffModel,
  getWorkingTreeChangeKey,
  type WorkingTreeFileChange,
} from "@/lib/workingTreeDiff";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  stopFileRowMenuPropagation,
  useFileRowMenuItems,
} from "@/hooks/useFileRowMenuItems";
import { useFileTreeDecorations } from "@/hooks/useFileTreeDecorations";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeIdForPath } from "@/panels/diff/useWorktreeIdForPath";
import { FileDecorationBadge } from "@/components/Plugin/FileDecorationBadge";

interface FileChangeListProps {
  changes: FileChangeDetail[];
  maxVisible?: number;
  rootPath: string;
  groupByFolder?: boolean;
  isStale?: boolean;
  /** Extra classes for the scroll container (surface, radius, padding). */
  className?: string;
}

export interface FileChangeListHandle {
  /** Open the diff viewer on the first (highest-churn) changed file. */
  openFirstFile(triggerEl: HTMLElement | null): void;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const dir = dirname(filePath);
  const base = basename(filePath);
  return { dir: dir === "." ? "" : dir, base };
}

function formatDirForDisplay(dir: string, maxSegments = 2): string {
  if (!dir) return "";
  const segments = dir.split("/");
  if (segments.length <= maxSegments) return dir;
  return "…/" + segments.slice(-maxSegments).join("/");
}

interface FolderGroup {
  dir: string;
  displayDir: string;
  files: WorkingTreeFileChange[];
}

interface FileChangeRowProps {
  change: WorkingTreeFileChange;
  showDir: boolean;
  rootPath: string;
  isNew: boolean;
  index: number;
  decoration: Parameters<typeof FileDecorationBadge>[0]["decoration"];
  openFileAt: (index: number, triggerEl: HTMLElement | null) => void;
  renderItems: ReturnType<typeof useFileRowMenuItems>["renderItems"];
  rememberMenuTrigger: (rowEl: HTMLElement) => void;
}

// Extracted as a genuine component (rather than a plain helper invoked via
// `.map()`) so the React Compiler can correctly scope the trigger-element
// writes to their owning event handlers. A helper function called directly
// during render — even one whose ref access is nested inside further handler
// closures — reads as a render-time ref access to the compiler's static
// analysis; a component boundary resolves that ambiguity.
function FileChangeRow({
  change,
  showDir,
  rootPath,
  isNew,
  index,
  decoration,
  openFileAt,
  renderItems,
  rememberMenuTrigger,
}: FileChangeRowProps) {
  const presentation = getGitStatusPresentation(change.status);
  const { dir, base } = splitPath(change.relativePath);
  const displayDir = formatDirForDisplay(dir);

  const absolutePath = isAbsolute(change.path) ? change.path : join(rootPath, change.relativePath);

  // Passes `null` rather than reading the stored trigger element here: the ref
  // access has to stay out of any value that flows into `renderItems(...)`
  // below, since that call runs synchronously during render and the compiler
  // flags a ref-derived value reaching it regardless of a `useCallback`
  // wrapper. `openFileAt` (owned by the parent) already treats `null` as
  // "keep whatever the row's `onContextMenu` handler just stamped in" — see
  // its definition for why that is equivalent.
  const handleOpenDiffFromMenu = useCallback(() => {
    openFileAt(index, null);
  }, [index, openFileAt]);

  // `ContextMenuTrigger` wraps `TooltipTrigger`, not the other way round and
  // never `<Tooltip>` itself. Both Radix triggers write `data-state` and
  // both spread consumer props *after* their own, so the outer one wins on
  // the merged row node — which has to be the context menu's, since that is
  // what the open-state lift reads. Wrapping `<Tooltip>` (the Root) instead
  // drops the trigger's props entirely: the Root renders no DOM.
  return (
    <ContextMenu>
      <Tooltip autoDismiss={false}>
        <ContextMenuTrigger
          asChild
          onContextMenu={(event) => {
            stopFileRowMenuPropagation(event);
            // The row that opened the menu is the element a diff opened
            // from it should hand focus back to. Recorded here rather than
            // in the item's onSelect, which fires after Radix has already
            // begun closing the menu. Routed through the parent's callback
            // because the compiler only types a ref created by `useRef` in
            // its own component — one arriving as a prop reads as an
            // ordinary object, and writing it from a JSX handler is a
            // "mutating a value used in JSX" bailout.
            rememberMenuTrigger(event.currentTarget);
          }}
        >
          <TooltipTrigger asChild>
            <div
              data-recency-new={isNew ? "true" : undefined}
              // Stands the global Shift+F10 / Menu-key handler down so the
              // row's own handler below can open this menu instead of the
              // focused panel's (`useGlobalKeybindings`).
              data-row-menu=""
              role="button"
              tabIndex={0}
              aria-label={`Open ${change.relativePath}`}
              className={cn(
                "group/filerow flex items-center text-xs font-mono hover:bg-tint/5 rounded px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-daintree-accent",
                // The row whose menu is open lifts to a neutral raised tier
                // so it reads as "the menu targets this row" — these rows
                // are ~20px and densely stacked, and the menu otherwise
                // names no file at all.
                "data-[state=open]:bg-overlay-raised",
                isNew && "file-change-row-new"
              )}
              onClick={(e) => openFileAt(index, e.currentTarget)}
              onKeyDown={(e) => {
                if (isFileRowMenuKey(e)) {
                  // preventDefault also suppresses the browser's own
                  // contextmenu for the keypress, so it can't double-fire.
                  e.preventDefault();
                  e.stopPropagation();
                  openFileRowMenuFromKeyboard(e.currentTarget);
                  return;
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFileAt(index, e.currentTarget);
                }
              }}
            >
              <span className={cn("w-4 font-bold shrink-0", presentation.colorClass)}>
                {presentation.marker}
              </span>

              <div className="flex-1 min-w-0 flex items-center mr-2">
                {showDir && displayDir && (
                  <span className="truncate min-w-0 text-daintree-text/60 opacity-60 group-hover/filerow:opacity-80">
                    {displayDir}/
                  </span>
                )}
                <span className="text-daintree-text group-hover/filerow:text-daintree-text font-medium truncate min-w-0">
                  {base}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0 text-[11px]">
                {(change.insertions ?? 0) > 0 && (
                  <span className="text-status-success/80">+{change.insertions}</span>
                )}
                {(change.deletions ?? 0) > 0 && (
                  <span className="text-status-error/80">-{change.deletions}</span>
                )}
                <FileDecorationBadge decoration={decoration} />
              </div>
            </div>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom">{change.relativePath}</TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        {renderItems(
          {
            absolutePath,
            relativePath: change.relativePath,
            name: base,
            isDirectory: false,
            status: change.status,
          },
          {
            // Routed through the list's own opener so the menu and a plain
            // click land on the same panel with the same `changeSet` —
            // `file.openDiff` would open a second, changeset-less diff.
            onOpenDiff: handleOpenDiffFromMenu,
            hasChanges: true,
          }
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const FileChangeList = forwardRef<FileChangeListHandle, FileChangeListProps>(
  function FileChangeList(
    { changes, maxVisible = 8, rootPath, groupByFolder = false, isStale = false, className },
    ref
  ) {
    const [diffPanelId, setDiffPanelId] = useState<string | null>(null);
    const worktreeId = useWorktreeIdForPath(rootPath);
    // The shared file-row menu, built once for the list and rendered per row.
    // Every row owns a trigger unconditionally now: making it conditional on a
    // plugin contributing `file` items is what left the rows trigger-less and
    // let the right-click bubble to the worktree card (#11757).
    const { renderItems } = useFileRowMenuItems({
      worktreePath: rootPath,
      worktreeId: worktreeId ?? null,
      copyTreeRunSource: "worktree-card",
    });
    // Holds the row element that opened the modal so focus can return to it on
    // close. Identity-stable across renders so AppDialog's restore logic doesn't
    // spuriously re-fire (the ref is the fallback for an unmounted trigger).
    const triggerElementRef = useRef<HTMLElement | null>(null);
    // Rows hand their opening element back through this rather than receiving
    // the ref itself, so the only `.current` writes live in the component that
    // owns the ref.
    const rememberMenuTrigger = useCallback((rowEl: HTMLElement) => {
      triggerElementRef.current = rowEl;
    }, []);

    // Shared with `worktree.openChanges` (src/lib/workingTreeDiff.ts) so a diff
    // opened from the context menu or a keybinding lands on the same first file,
    // in the same order, as one opened from this list.
    const { sortedChanges, diffChangeSet, indexByKey } = useMemo(
      () => buildWorkingTreeDiffModel(changes, rootPath),
      [changes, rootPath]
    );

    // Plugin-contributed file decorations for the local worktree file list. Pulled
    // once for the whole list under a `worktree-files:<root>` scope — distinct from
    // the Review Hub's `worktree-diff:` scope so a PR-review provider's badges don't
    // leak onto the local change list. Keyed by the same `change.path` strings that
    // were sent to the host, so `decorations[change.path]` resolves per row. The
    // hook early-outs (stable empty map) when no plugin registers the scope, so this
    // costs nothing on a zero-plugin file list.
    const decorationPaths = useMemo(() => sortedChanges.map((c) => c.path), [sortedChanges]);
    const decorations = useFileTreeDecorations(`worktree-files:${rootPath}`, decorationPaths);

    const visibleChanges = useMemo(
      () => sortedChanges.slice(0, maxVisible),
      [sortedChanges, maxVisible]
    );
    const remainingCount = Math.max(0, sortedChanges.length - maxVisible);

    // Track which row keys arrived since the previous render. Empty on mount because
    // prevKeysRef is seeded with the initial keys — the first paint must NOT flash
    // every existing row. The decay IS the recency signal (semantic exception, ~2s).
    const prevKeysRef = useRef<Set<string> | null>(null);
    const [newRowKeys, setNewRowKeys] = useState<Set<string>>(() => new Set());

    useLayoutEffect(() => {
      const currentKeys = sortedChanges.map(getWorkingTreeChangeKey);
      if (prevKeysRef.current === null) {
        prevKeysRef.current = new Set(currentKeys);
        return;
      }
      const added = new Set<string>();
      for (const key of currentKeys) {
        if (!prevKeysRef.current.has(key)) {
          added.add(key);
        }
      }
      prevKeysRef.current = new Set(currentKeys);
      setNewRowKeys((prev) => (added.size === 0 && prev.size === 0 ? prev : added));
    }, [sortedChanges]);
    const remainingFiles = useMemo(
      () => sortedChanges.slice(maxVisible, maxVisible + 2),
      [sortedChanges, maxVisible]
    );

    // The diff panel steps through files itself, so this list only has to open
    // it and keep its change set current. `openPanelDialog` supersedes any
    // panel already showing, which is why re-opening needs no explicit close.
    const openDiffPanel = useCallback(
      (change: WorkingTreeFileChange) => {
        void usePanelDialogStore
          .getState()
          .openPanelDialog({
            kind: "diff",
            filePath: change.relativePath,
            fileStatus: change.status,
            diffSource: "working-tree",
            changeSet: diffChangeSet,
            viewedKey: `${change.status}:${change.relativePath}`,
            title: basename(change.relativePath),
            ...(worktreeId && { worktreeId }),
          })
          // Only adopt a panel that was actually created: a refused or
          // superseded open resolves null, and this list has no selection to
          // retry from — the next open is a user activation, not an effect.
          .then((panelId) => {
            if (panelId) setDiffPanelId(panelId);
          });
      },
      [diffChangeSet, worktreeId]
    );

    // Keep the open panel's change set in step with the live worktree poll.
    // The store bails on a value-equal set, so a quiet poll costs nothing.
    useEffect(() => {
      if (!diffPanelId) return;
      usePanelStore.getState().setDiffPanelChangeSet(diffPanelId, diffChangeSet);
    }, [diffPanelId, diffChangeSet]);

    // Drop the pointer once the panel is gone (closed, or superseded by another
    // surface opening its own diff) so a later poll can't resurrect its set —
    // or push this list's set into a panel another surface now owns. Dropping
    // it must never reopen anything: the list opens diffs on user activation
    // only, so there is no "we want a panel" state to confuse this with.
    // Membership, not top-of-stack: another dialog layered above this diff
    // leaves it presented and still ours, so equality would read that as the
    // panel being gone and abandon a live diff.
    const dialogStack = usePanelDialogStore((state) => state.dialogStack);
    useEffect(() => {
      if (diffPanelId && !dialogStack.includes(diffPanelId)) setDiffPanelId(null);
    }, [dialogStack, diffPanelId]);

    const groupedChanges = useMemo((): FolderGroup[] => {
      if (!groupByFolder) return [];

      const groups = new Map<string, WorkingTreeFileChange[]>();

      visibleChanges.forEach((change) => {
        const { dir } = splitPath(change.relativePath);
        const groupKey = dir || "(root)";
        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey)!.push(change);
      });

      return Array.from(groups.entries())
        .map(([dir, files]) => ({
          dir,
          displayDir: dir === "(root)" ? "(root)" : formatDirForDisplay(dir, 3),
          files,
        }))
        .sort((a, b) => {
          if (a.dir === "(root)") return -1;
          if (b.dir === "(root)") return 1;
          return a.dir.localeCompare(b.dir);
        });
    }, [visibleChanges, groupByFolder]);

    // `triggerEl: null` means "opened via the context menu, not a direct
    // click/keypress" — the row's `onContextMenu` handler already stamped
    // `triggerElementRef` with the row that opened the menu, so this leaves
    // it untouched rather than clobbering it. Keeping that read on this side
    // of the prop boundary (never passed down as a plain value into
    // `FileChangeRow`'s render-time `renderItems()` call) is what keeps the
    // ref access out of the compiler's per-component analysis there.
    const openFileAt = useCallback(
      (index: number, triggerEl: HTMLElement | null) => {
        const change = sortedChanges[index];
        if (!change) return;
        if (triggerEl) triggerElementRef.current = triggerEl;
        openDiffPanel(change);
      },
      [sortedChanges, openDiffPanel]
    );

    // Imperative entry point for the "Open changes" button in WorktreeDetails.
    // Registered before the empty-list early return so the handle stays stable
    // even with no files present (a safe no-op then, via openFileAt's bounds check).
    useImperativeHandle(
      ref,
      () => ({
        openFirstFile: (triggerEl: HTMLElement | null) => openFileAt(0, triggerEl),
      }),
      [openFileAt]
    );

    if (changes.length === 0) {
      return null;
    }

    if (groupByFolder && groupedChanges.length > 0) {
      return (
        <>
          <div
            className={cn(
              "space-y-3 w-full max-h-64 overscroll-contain",
              className,
              // After `className` so no caller can undo it: the rows' -mx-1.5
              // hover bleed overflows the container, and with overflow-y set,
              // `visible` on x computes to `auto` — a horizontal scrollbar. The
              // container's padding absorbs the bleed; anything longer truncates.
              "overflow-y-auto overflow-x-hidden",
              isStale && "surface-stale"
            )}
            aria-busy={isStale || undefined}
          >
            {groupedChanges.map((group) => (
              <div key={group.dir}>
                <div className="flex items-center gap-1.5 text-[11px] text-daintree-text/40 mb-1">
                  <Folder className="w-3 h-3 shrink-0" />
                  <span className="min-w-0 truncate font-mono">{group.displayDir}</span>
                  <span className="shrink-0 text-daintree-text/30">({group.files.length})</span>
                </div>
                <div className="pl-4 flex flex-col gap-0.5">
                  {group.files.map((file) => {
                    const key = getWorkingTreeChangeKey(file);
                    return (
                      <FileChangeRow
                        key={key}
                        change={file}
                        showDir={false}
                        rootPath={rootPath}
                        isNew={newRowKeys.has(key)}
                        index={indexByKey.get(key) ?? 0}
                        decoration={decorations[file.path]}
                        openFileAt={openFileAt}
                        renderItems={renderItems}
                        rememberMenuTrigger={rememberMenuTrigger}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            {remainingCount > 0 && (
              <div className="text-[11px] text-daintree-text/60 pl-4 pt-1">
                ...and {remainingCount} more
                {remainingFiles.length > 0 && (
                  <span className="ml-1 opacity-75">
                    ({remainingFiles.map((f) => basename(f.relativePath)).join(", ")}
                    {sortedChanges.length > maxVisible + 2 && ", ..."})
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      );
    }

    return (
      <>
        <div
          className={cn(
            "flex flex-col gap-0.5 w-full max-h-64 overscroll-contain",
            className,
            // Same post-className overflow guarantee as the grouped container.
            "overflow-y-auto overflow-x-hidden",
            isStale && "surface-stale"
          )}
          aria-busy={isStale || undefined}
        >
          {visibleChanges.map((change) => {
            const key = getWorkingTreeChangeKey(change);
            return (
              <FileChangeRow
                key={key}
                change={change}
                showDir={true}
                rootPath={rootPath}
                isNew={newRowKeys.has(key)}
                index={indexByKey.get(key) ?? 0}
                decoration={decorations[change.path]}
                openFileAt={openFileAt}
                renderItems={renderItems}
                rememberMenuTrigger={rememberMenuTrigger}
              />
            );
          })}

          {remainingCount > 0 && (
            <div className="text-[11px] text-daintree-text/60 pl-5 pt-1">
              ...and {remainingCount} more
              {remainingFiles.length > 0 && (
                <span className="ml-1 opacity-75">
                  ({remainingFiles.map((f) => basename(f.path)).join(", ")}
                  {sortedChanges.length > maxVisible + 2 && ", ..."})
                </span>
              )}
            </div>
          )}
        </div>
      </>
    );
  }
);
