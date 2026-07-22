import { useCallback, useMemo, useState } from "react";
import { EyeOff, FolderTree, RefreshCw } from "lucide-react";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { cn } from "@/lib/utils";
import { FileTreeView } from "./FileTreeView";
import { FileBrowserViewer } from "./FileBrowserViewer";
import { useFileBrowserTree } from "./useFileBrowserTree";
import { ancestorDirectories } from "./fileBrowserTree";

export type FileBrowserPaneProps = BasePanelProps;

const TREE_WIDTH_CLASS = "w-64";

/**
 * Read-only file browser: a lazily-expanded tree over one worktree beside a
 * viewer for the selected file.
 *
 * Expansion and selection live on the panel record rather than in component
 * state. That is what makes the dialog and the pinned panel the same surface:
 * `promoteDialogPanelToGrid` reuses the panel id, so promoting a peek into a
 * pinned panel carries the user's place with it, and the same fields are what
 * the serializer persists across restarts.
 */
export function FileBrowserPane({
  id,
  title,
  worktreeId,
  isFocused,
  isMaximized,
  location = "grid",
  isMultiPanelGrid,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
}: FileBrowserPaneProps) {
  const setFileBrowserView = usePanelStore((state) => state.setFileBrowserView);

  const selectedPath = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? (panel.browserSelectedPath ?? null) : null;
      },
      [id]
    )
  );
  const expandedPaths = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserExpandedPaths : undefined;
      },
      [id]
    )
  );
  const showIgnored = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserShowIgnored === true : false;
      },
      [id]
    )
  );

  // Resolved fresh from the worktree store rather than persisted, so a rename
  // or move is reflected without restarting the panel.
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );
  // The worktree's own change tick — already coalesced by the watcher's
  // adaptive burst debounce, so a bulk write lands as one tick.
  const changeTick = useWorktreeStore(
    useCallback(
      (state) =>
        worktreeId ? state.worktrees.get(worktreeId)?.worktreeChanges?.lastUpdated : undefined,
      [worktreeId]
    )
  );

  const stableExpandedPaths = useMemo(() => expandedPaths ?? EMPTY_PATHS, [expandedPaths]);

  const { rows, isInitialLoading, rootError, ensureLoaded, refresh } = useFileBrowserTree({
    worktreeId,
    expandedPaths: stableExpandedPaths,
    showIgnored,
    changeTick,
  });

  const handleToggleExpanded = useCallback(
    (path: string, expand: boolean) => {
      const current = new Set(stableExpandedPaths);
      if (expand) {
        current.add(path);
        // Fire the fetch here rather than waiting for the store round-trip so
        // the listing is already in flight by the time the row re-renders.
        ensureLoaded(path);
      } else {
        current.delete(path);
        // Collapsing a branch also collapses everything inside it, so
        // re-expanding the parent doesn't restore a subtree the user closed.
        const prefix = `${path}/`;
        for (const candidate of current) {
          if (candidate.startsWith(prefix)) current.delete(candidate);
        }
      }
      setFileBrowserView(id, { browserExpandedPaths: [...current].sort() });
    },
    [id, stableExpandedPaths, setFileBrowserView, ensureLoaded]
  );

  const handleSelect = useCallback(
    (path: string) => {
      setFileBrowserView(id, { browserSelectedPath: path });
    },
    [id, setFileBrowserView]
  );

  // Counted separately from the change tick so the toolbar's Refresh also
  // re-reads the open file, not just the tree.
  const [manualRefreshNonce, setManualRefreshNonce] = useState(0);
  const handleRefresh = useCallback(() => {
    setManualRefreshNonce((nonce) => nonce + 1);
    refresh();
  }, [refresh]);

  // One value per refresh *cycle*, not per directory listed. Deriving it from
  // the tree's per-listing commits would make a 500-directory refresh re-read
  // the open file 500 times.
  const viewerRevision = `${changeTick ?? 0}:${manualRefreshNonce}`;

  const handleToggleIgnored = useCallback(() => {
    setFileBrowserView(id, { browserShowIgnored: !showIgnored });
  }, [id, showIgnored, setFileBrowserView]);

  // A restored panel remembers a selection whose ancestors may be collapsed.
  // Expanding them on demand is what makes the row appear; doing it here rather
  // than in an effect keeps it a response to the user opening the panel.
  const selectedIsReachable = useMemo(
    () => selectedPath === null || rows.some((row) => row.path === selectedPath),
    [rows, selectedPath]
  );
  const revealSelection = useCallback(() => {
    if (selectedPath === null) return;
    const current = new Set(stableExpandedPaths);
    for (const ancestor of ancestorDirectories(selectedPath)) current.add(ancestor);
    setFileBrowserView(id, { browserExpandedPaths: [...current].sort() });
  }, [id, selectedPath, stableExpandedPaths, setFileBrowserView]);

  const selectedNode = useMemo(
    () => rows.find((row) => row.path === selectedPath),
    [rows, selectedPath]
  );
  // Positively a file, not merely "not known to be a directory": collapsing a
  // parent hides the selected row without clearing the selection, and treating
  // that unknown node as a file makes the viewer try to read a directory.
  const selectedFilePath =
    selectedPath && worktreePath && selectedNode?.isDirectory === false
      ? `${worktreePath}/${selectedPath}`
      : null;
  const selectedFileName = selectedPath ? (selectedPath.split("/").pop() ?? selectedPath) : "";

  const toolbar = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleToggleIgnored}
        aria-pressed={showIgnored}
        className={cn(
          "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors duration-150 ease-out",
          "hover:bg-overlay-subtle",
          showIgnored ? "text-daintree-text" : "text-muted-foreground"
        )}
      >
        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        {/* Label never changes with state — the pressed state carries it. */}
        Show ignored
      </button>
      <button
        type="button"
        onClick={handleRefresh}
        aria-label="Refresh"
        className="flex items-center rounded px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 ease-out hover:bg-overlay-subtle"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <ContentPanel
      id={id}
      title={title}
      kind="file-browser"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      showRestoreControl={showRestoreControl}
      toolbar={toolbar}
    >
      <div className="flex min-h-0 w-full flex-1 bg-daintree-bg">
        <div
          className={cn(
            "flex min-h-0 shrink-0 flex-col border-r border-daintree-border",
            TREE_WIDTH_CLASS
          )}
        >
          {renderTree()}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <FileBrowserViewer
            filePath={selectedFilePath}
            rootPath={worktreePath}
            fileName={selectedFileName}
            revision={viewerRevision}
          />
        </div>
      </div>
    </ContentPanel>
  );

  function renderTree() {
    if (!worktreeId || !worktreePath) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <EmptyState
            variant="zero-data"
            scale="sidebar"
            icon={<FolderTree className="h-5 w-5" />}
            title="Open a worktree to browse its files"
          />
        </div>
      );
    }

    if (rootError !== null) {
      return (
        <div className="p-2">
          <InlineStatusBanner
            severity="error"
            icon={FolderTree}
            title="Couldn't read this worktree"
            description={rootError}
            action={{ id: "retry", label: "Retry", onClick: handleRefresh }}
          />
        </div>
      );
    }

    if (isInitialLoading) {
      return (
        // Predictable shape (a column of rows), so a skeleton rather than a
        // spinner. `Skeleton` carries the 400ms anti-flicker gate.
        <div className="p-2">
          <Skeleton label="Loading files">
            <SkeletonText lines={12} />
          </Skeleton>
        </div>
      );
    }

    if (rows.length === 0) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <EmptyState
            variant={showIgnored ? "zero-data" : "filtered-empty"}
            scale="sidebar"
            {...(showIgnored ? { icon: <FolderTree className="h-5 w-5" /> } : {})}
            title={showIgnored ? "This worktree is empty" : "Everything here is ignored"}
            action={
              showIgnored ? undefined : (
                <button
                  type="button"
                  onClick={handleToggleIgnored}
                  className="text-xs underline underline-offset-2"
                >
                  Show ignored files
                </button>
              )
            }
          />
        </div>
      );
    }

    return (
      <>
        {selectedPath !== null && !selectedIsReachable && (
          <button
            type="button"
            onClick={revealSelection}
            className="shrink-0 truncate border-b border-daintree-border px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors duration-150 ease-out hover:bg-overlay-subtle"
          >
            Reveal {selectedFileName}
          </button>
        )}
        <FileTreeView
          rows={rows}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onToggleExpanded={handleToggleExpanded}
          label={`Files in ${title}`}
        />
      </>
    );
  }
}

const EMPTY_PATHS: readonly string[] = [];
