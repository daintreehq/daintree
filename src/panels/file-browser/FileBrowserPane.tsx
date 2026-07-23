import { useCallback, useMemo, useRef, useState } from "react";
import { CornerLeftUp, EyeOff, FolderRoot, FolderTree, RefreshCw } from "lucide-react";
import { basename, join } from "@shared/utils/path";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { folderIncludePattern } from "@/lib/copyTreeFormat";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { FileTreeView } from "./FileTreeView";
import { FileBrowserViewer } from "./FileBrowserViewer";
import { useFileBrowserTree } from "./useFileBrowserTree";
import { ancestorDirectories, parentRootPath, type FlatTreeRow } from "./fileBrowserTree";

export type FileBrowserPaneProps = BasePanelProps;

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
  const rootPath = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? (panel.browserRootPath ?? "") : "";
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

  const { rows, isInitialLoading, rootError, ensureLoaded, refresh, isRefreshing } =
    useFileBrowserTree({
      worktreeId,
      expandedPaths: stableExpandedPaths,
      showIgnored,
      rootPath,
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
    refresh({ manual: true });
  }, [refresh]);

  // One value per refresh *cycle*, not per directory listed. Deriving it from
  // the tree's per-listing commits would make a 500-directory refresh re-read
  // the open file 500 times.
  const viewerRevision = `${changeTick ?? 0}:${manualRefreshNonce}`;

  const handleToggleIgnored = useCallback(() => {
    setFileBrowserView(id, { browserShowIgnored: !showIgnored });
  }, [id, showIgnored, setFileBrowserView]);

  const handleSetRoot = useCallback(
    (path: string) => {
      setFileBrowserView(id, { browserRootPath: path });
    },
    [id, setFileBrowserView]
  );

  // Reaching the worktree root unmounts both header buttons, and keyboard
  // focus would fall to the document; hand it to the tree instead. rAF because
  // the tree for the new root renders on the commit after the state write.
  const treeColumnRef = useRef<HTMLDivElement>(null);
  const focusTree = useCallback(() => {
    requestAnimationFrame(() => {
      treeColumnRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus();
    });
  }, []);

  const handleResetRoot = useCallback(() => {
    setFileBrowserView(id, { browserRootPath: "" });
    focusTree();
  }, [id, setFileBrowserView, focusTree]);

  const handleUpOneLevel = useCallback(() => {
    setFileBrowserView(id, { browserRootPath: parentRootPath(rootPath) });
    focusTree();
  }, [id, rootPath, setFileBrowserView, focusTree]);

  const handleCopyFolderContext = useCallback(
    (path: string) => {
      if (!worktreeId) return;
      void copyContextWithFeedback(worktreeId, "context-menu", {
        includePaths: [folderIncludePattern(path)],
      });
    },
    [worktreeId]
  );

  const copyToClipboard = useCallback((text: string, errorTitle: string) => {
    const write = () =>
      navigator.clipboard.writeText(text).catch((error: unknown) => {
        // A silent failure leaves the previous clipboard contents in place,
        // and the user's next paste would be the wrong value.
        notify({
          type: "error",
          title: errorTitle,
          message:
            error instanceof Error && error.name === "NotAllowedError"
              ? "The clipboard is unavailable while another app holds it."
              : "The clipboard rejected the write.",
          action: { label: "Retry", onClick: () => void write() },
        });
      });
    void write();
  }, []);

  const handleCopyFullPath = useCallback(
    (path: string) => {
      if (!worktreePath) return;
      copyToClipboard(join(worktreePath, path), "Couldn't copy path");
    },
    [worktreePath, copyToClipboard]
  );

  // row.path is already relative to the true worktree root even when the tree
  // has been re-rooted to a subfolder, so it copies verbatim — no rootPath
  // stripping or re-joining, which would only double-prefix a correct value.
  const handleCopyRelativePath = useCallback(
    (path: string) => {
      copyToClipboard(path, "Couldn't copy path");
    },
    [copyToClipboard]
  );

  const handleCopyFileName = useCallback(
    (name: string) => {
      copyToClipboard(name, "Couldn't copy file name");
    },
    [copyToClipboard]
  );

  const reveal = useMemo(() => revealCopy(), []);
  const handleReveal = useCallback(
    (path: string) => {
      if (!worktreePath) return;
      const run = async () => {
        const result = await actionService.dispatch(
          "file.showItemInFolder",
          { path: join(worktreePath, path) },
          { source: "context-menu" }
        );
        // The menu has already closed by the time this settles, so a failure
        // here is invisible without a toast — e.g. the entry was deleted
        // between listing and click.
        if (!result.ok) {
          notify({
            type: "error",
            title: reveal.errorTitle,
            message: result.error.message,
            action: { label: "Retry", onClick: () => void run() },
          });
        }
      };
      void run();
    },
    [worktreePath, reveal]
  );

  const rowContextMenu = useCallback(
    (row: FlatTreeRow) => (
      <>
        {row.isDirectory && (
          <>
            <ContextMenuItem onSelect={() => handleSetRoot(row.path)}>Set as root</ContextMenuItem>
            {/* Disabled rather than hidden for ignored folders: CopyTree's
                discovery respects .gitignore, so the copy would always come
                back empty — but the item vanishing would read as a bug. */}
            <ContextMenuItem
              disabled={row.isIgnored}
              onSelect={() => handleCopyFolderContext(row.path)}
            >
              Copy context
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handleCopyFullPath(row.path)}>
          Copy full path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyRelativePath(row.path)}>
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyFileName(row.name)}>
          Copy file name
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleReveal(row.path)}>{reveal.label}</ContextMenuItem>
      </>
    ),
    [
      handleSetRoot,
      handleCopyFolderContext,
      handleCopyFullPath,
      handleCopyRelativePath,
      handleCopyFileName,
      handleReveal,
      reveal,
    ]
  );

  // A restored panel remembers a selection whose ancestors may be collapsed.
  // Expanding them on demand is what makes the row appear; doing it here rather
  // than in an effect keeps it a response to the user opening the panel.
  const selectedIsReachable = useMemo(
    () => selectedPath === null || rows.some((row) => row.path === selectedPath),
    [rows, selectedPath]
  );
  // A selection outside the current root has no row to reveal — expanding its
  // ancestors couldn't make one appear, so the reveal strip stays hidden.
  const selectionInRoot =
    selectedPath === null || rootPath === "" || selectedPath.startsWith(`${rootPath}/`);
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
      ? join(worktreePath, selectedPath)
      : null;
  const selectedFileName = selectedPath ? (selectedPath.split("/").pop() ?? selectedPath) : "";

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
    >
      {/* In both locations the parent provides a definite height — the grid
          cell directly, the dialog via the registry's `dialogFullHeight` pin
          on the AppDialog surface — so a plain flex-1/min-h-0 chain fills it
          without the content-sized-parent collapse trap. */}
      <div className="flex min-h-0 w-full flex-1 bg-daintree-bg">
        <div
          ref={treeColumnRef}
          className="flex min-h-0 w-72 shrink-0 flex-col self-stretch border-r border-daintree-border bg-daintree-sidebar"
        >
          <div className="flex shrink-0 items-center gap-0.5 border-b border-daintree-border px-1.5 py-1">
            {/* Root anchor mirrors the diff sidebar's header: where am I
                rooted, then the controls that reshape the view. The root icon
                doubles as the way back when the tree is rooted somewhere. */}
            {rootPath !== "" ? (
              <FileViewerToolbar.IconButton label="Back to worktree root" onClick={handleResetRoot}>
                <FolderRoot className="h-3.5 w-3.5" />
              </FileViewerToolbar.IconButton>
            ) : (
              // Same footprint as the button so the path text doesn't shift
              // when the tree is re-rooted.
              <span className="shrink-0 p-1.5 text-daintree-text/40" aria-hidden="true">
                <FolderRoot className="h-3.5 w-3.5" />
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-daintree-text/40"
              title={rootPath ? `${basename(worktreePath)}/${rootPath}` : worktreePath}
            >
              {rootPath || (worktreePath ? basename(worktreePath) : "")}
            </span>
            {rootPath !== "" && (
              <FileViewerToolbar.IconButton label="Up one level" onClick={handleUpOneLevel}>
                <CornerLeftUp className="h-3.5 w-3.5" />
              </FileViewerToolbar.IconButton>
            )}
            <FileViewerToolbar.IconButton
              label="Show ignored"
              pressed={showIgnored}
              onClick={handleToggleIgnored}
            >
              <EyeOff className="h-3.5 w-3.5" />
            </FileViewerToolbar.IconButton>
            <FileViewerToolbar.IconButton label="Refresh" onClick={handleRefresh}>
              <SpinningIcon icon={RefreshCw} active={isRefreshing} className="h-3.5 w-3.5" />
            </FileViewerToolbar.IconButton>
          </div>
          {renderTree()}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <FileBrowserViewer
            filePath={selectedFilePath}
            rootPath={worktreePath}
            fileName={selectedFileName}
            relativePath={selectedNode?.isDirectory === false ? (selectedPath ?? null) : null}
            revision={viewerRevision}
          />
        </div>
      </div>
    </ContentPanel>
  );

  function renderTree() {
    if (!worktreeId || !worktreePath) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          {/* w-full: EmptyState is a CSS container (inline-size containment),
              so as a bare flex item its width collapses and the copy wraps
              word-by-word. */}
          <EmptyState
            variant="zero-data"
            scale="sidebar"
            icon={<FolderTree className="h-5 w-5" />}
            title="Open a worktree to browse its files"
            className="w-full"
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
            title={rootPath ? "Couldn't read this folder" : "Couldn't read this worktree"}
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
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            variant={showIgnored ? "zero-data" : "filtered-empty"}
            scale="sidebar"
            className="w-full"
            {...(showIgnored ? { icon: <FolderTree className="h-5 w-5" /> } : {})}
            title={
              showIgnored
                ? rootPath
                  ? "This folder is empty"
                  : "This worktree is empty"
                : "Everything here is ignored"
            }
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
        <FileTreeView
          rows={rows}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onToggleExpanded={handleToggleExpanded}
          onRootFolder={handleSetRoot}
          rowContextMenu={rowContextMenu}
          label={`Files in ${title}`}
        />
        {/* Below the tree, never above: the strip unmounts the instant a
            click makes the selection reachable, and sitting above the rows it
            would shift them mid-gesture — the second click of a double-click
            would land one row off. */}
        {selectedPath !== null && selectionInRoot && !selectedIsReachable && (
          <button
            type="button"
            onClick={revealSelection}
            className="shrink-0 truncate border-t border-daintree-border px-3 py-1 text-left font-mono text-[11px] text-daintree-text/60 transition-colors duration-150 ease-out hover:bg-tint/5 hover:text-daintree-text"
          >
            Reveal {selectedFileName}
          </button>
        )}
      </>
    );
  }
}

const EMPTY_PATHS: readonly string[] = [];
