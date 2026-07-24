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
import type { FileChangeDetail, GitStatus } from "../../types";
import { cn } from "../../lib/utils";
import { Folder } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basename, dirname, isAbsolute, join } from "@shared/utils/path";
import {
  buildWorkingTreeDiffModel,
  getWorkingTreeChangeKey,
  type WorkingTreeFileChange,
} from "@/lib/workingTreeDiff";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import { useFileTreeDecorations } from "@/hooks/useFileTreeDecorations";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeIdForPath } from "@/panels/diff/useWorktreeIdForPath";
import { FileDecorationBadge } from "@/components/Plugin/FileDecorationBadge";

const STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-status-warning" },
  added: { label: "A", color: "text-status-success" },
  deleted: { label: "D", color: "text-status-error" },
  untracked: { label: "?", color: "text-status-success" },
  renamed: { label: "R", color: "text-status-info" },
  copied: { label: "C", color: "text-status-info" },
  ignored: { label: "I", color: "text-daintree-text/40" },
  conflicted: { label: "!", color: "text-status-error" },
};

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

export const FileChangeList = forwardRef<FileChangeListHandle, FileChangeListProps>(
  function FileChangeList(
    { changes, maxVisible = 8, rootPath, groupByFolder = false, isStale = false, className },
    ref
  ) {
    const [diffPanelId, setDiffPanelId] = useState<string | null>(null);
    const worktreeId = useWorktreeIdForPath(rootPath);
    // Plugin-contributed `file` context-menu items. Pulled once for the list; a
    // row is only wrapped in a ContextMenu when there are items, so a zero-plugin
    // file list keeps its existing flat-row DOM (no per-row trigger overhead).
    const filePluginItems = usePluginContextMenuItems("file");
    // Holds the row element that opened the modal so focus can return to it on
    // close. Identity-stable across renders so AppDialog's restore logic doesn't
    // spuriously re-fire (the ref is the fallback for an unmounted trigger).
    const triggerElementRef = useRef<HTMLElement | null>(null);

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

    const openFileAt = useCallback(
      (index: number, triggerEl: HTMLElement | null) => {
        const change = sortedChanges[index];
        if (!change) return;
        triggerElementRef.current = triggerEl;
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

    const renderFileItem = (change: WorkingTreeFileChange, showDir: boolean) => {
      const config = STATUS_CONFIG[change.status] || STATUS_CONFIG.untracked;
      const { dir, base } = splitPath(change.relativePath);
      const displayDir = formatDirForDisplay(dir);
      const key = getWorkingTreeChangeKey(change);
      const isNew = newRowKeys.has(key);
      const index = indexByKey.get(key) ?? 0;

      const row = (
        <Tooltip key={key} autoDismiss={false}>
          <TooltipTrigger asChild>
            <div
              data-recency-new={isNew ? "true" : undefined}
              role="button"
              tabIndex={0}
              aria-label={`Open ${change.relativePath}`}
              className={cn(
                "group/filerow flex items-center text-xs font-mono hover:bg-tint/5 rounded px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-daintree-accent",
                isNew && "file-change-row-new"
              )}
              onClick={(e) => openFileAt(index, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openFileAt(index, e.currentTarget);
                }
              }}
            >
              <span className={cn("w-4 font-bold shrink-0", config.color)}>{config.label}</span>

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
                <FileDecorationBadge decoration={decorations[change.path]} />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{change.relativePath}</TooltipContent>
        </Tooltip>
      );

      // Wrap in a `file` context menu only when a plugin contributes file items —
      // a zero-plugin list keeps its plain-row DOM. The dispatched args carry the
      // real clicked file (absolute path, worktree root, status) so a plugin's
      // item — or a built-in like `file.openDiff` — receives the subject instead
      // of `undefined`.
      if (filePluginItems.length === 0) return row;

      const absolutePath = isAbsolute(change.path)
        ? change.path
        : join(rootPath, change.relativePath);
      return (
        <ContextMenu key={key}>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <PluginContextMenuSection
              items={filePluginItems}
              leadingSeparator={false}
              dispatchArgs={{
                path: absolutePath,
                worktreePath: rootPath,
                status: change.status,
              }}
            />
          </ContextMenuContent>
        </ContextMenu>
      );
    };

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
                  {group.files.map((file) => renderFileItem(file, false))}
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
          {visibleChanges.map((change) => renderFileItem(change, true))}

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
