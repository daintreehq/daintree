import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type React from "react";
import { Copy, CornerLeftUp, EyeOff, FolderRoot, FolderTree, RefreshCw } from "lucide-react";
import { FolderOpen, Folders } from "@/components/icons";
import { basename, join } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { flushPanelPersistence } from "@/store/slices";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { FileTreeView } from "./FileTreeView";
import { FileBrowserViewer } from "./FileBrowserViewer";
import { useFileBrowserTree } from "./useFileBrowserTree";
import {
  FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH,
  FILE_BROWSER_SIDEBAR_MAX_WIDTH,
  FILE_BROWSER_SIDEBAR_MIN_WIDTH,
  FILE_BROWSER_SIDEBAR_RESIZE_STEP,
  FILE_BROWSER_SIDEBAR_RESIZE_STEP_COARSE,
  clampFileBrowserSidebarWidth,
} from "./sidebarWidth";
import {
  ancestorDirectories,
  createVisibilityFilter,
  isRowPathVisible,
  parentRootPath,
  type FileBrowserSource,
  type FlatTreeRow,
} from "./fileBrowserTree";
import { useWorkspaceRootPath } from "./useWorkspaceRootPath";

export type FileBrowserPaneProps = BasePanelProps;

/**
 * Read-only file browser: a lazily-expanded tree over one folder beside a
 * viewer for the selected file. The folder is a worktree when the panel names
 * one, otherwise the view's own project or scratch root (#11482).
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
  const hideDotfiles = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserHideDotfiles === true : false;
      },
      [id]
    )
  );
  const alwaysHiddenPatterns = usePreferencesStore(
    (state) => state.fileBrowserAlwaysHiddenPatterns
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
  const sidebarCollapsed = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserSidebarCollapsed === true : false;
      },
      [id]
    )
  );
  const treeSnapshot = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserTreeSnapshot : undefined;
      },
      [id]
    )
  );
  // Clamped at read so a persisted value from a future bounds change (or a
  // corrupted snapshot the deserializer somehow let through) can never render a
  // broken column; returns a stable primitive so the selector doesn't churn.
  const sidebarWidth = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser"
          ? clampFileBrowserSidebarWidth(
              panel.browserSidebarWidth ?? FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH
            )
          : FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH;
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
  // The fallback root for a panel with no worktree: this view's own project or
  // scratch folder (#11482).
  const workspaceRootPath = useWorkspaceRootPath();

  // A panel without a worktree is rooted at its view's workspace instead of
  // being broken — that is the whole of the scratch/worktree-less-project fix.
  // A worktree id that hasn't resolved yet stays unresolved rather than falling
  // back: silently browsing the project root in place of the requested worktree
  // would be the wrong folder, not a degraded one.
  const source = useMemo((): FileBrowserSource | null => {
    if (worktreeId) {
      return worktreePath ? { kind: "worktree", worktreeId, basePath: worktreePath } : null;
    }
    return workspaceRootPath ? { kind: "workspace", basePath: workspaceRootPath } : null;
  }, [worktreeId, worktreePath, workspaceRootPath]);

  // Everything path-shaped in the pane joins against this: the tree's rows are
  // relative to it in both modes.
  const basePath = source?.basePath ?? "";
  // The worktree's git-status change tick — already coalesced by the watcher's
  // adaptive burst debounce, so a bulk write lands as one tick.
  const gitChangeTick = useWorktreeStore(
    useCallback(
      (state) =>
        worktreeId ? state.worktrees.get(worktreeId)?.worktreeChanges?.lastUpdated : undefined,
      [worktreeId]
    )
  );
  // The raw filesystem-write tick, independent of git status. Combining the two
  // is the fix for the issue's reproduction: a write into a gitignored folder
  // moves this even though `worktreeChanges` (which dedups content-identical
  // snapshots) never advances (#11330).
  const fsChangeTick = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? state.workingTreeChangedAtById.get(worktreeId) : undefined),
      [worktreeId]
    )
  );
  // A single monotonic signal for "re-read the tree/file": whichever moved most
  // recently. `|| undefined` so a never-changed worktree keeps the "no tick"
  // identity the hook expects. Both sources are worktree-store maps, so a
  // workspace root has no tick at all and refreshes on demand only (#11482).
  const changeTick = Math.max(gitChangeTick ?? 0, fsChangeTick ?? 0) || undefined;

  const stableExpandedPaths = useMemo(() => expandedPaths ?? EMPTY_PATHS, [expandedPaths]);

  const {
    rows,
    isInitialLoading,
    rootError,
    hasHiddenDotfiles,
    ensureLoaded,
    refresh,
    isRefreshing,
    captureSnapshot,
  } = useFileBrowserTree({
    source,
    expandedPaths: stableExpandedPaths,
    hideDotfiles,
    alwaysHiddenPatterns,
    rootPath,
    changeTick,
    treeSnapshot,
  });

  // Persist the last-known tree at going-away points only (#11367): the view
  // being hidden (project switch, window close, app quit — `visibilitychange`
  // is the reliable detach signal, see #9914 in `resource.ts`) and unmount,
  // which records the outgoing tree (dialog close, re-root) for the *next*
  // restore — a dialog → grid promotion's replacement pane mounts before this
  // cleanup writes, so it still cold-fetches. Never on a change tick — the
  // snapshot rides the panel record, and dirtying it on every filesystem tick
  // would turn each into a layout write.
  useEffect(() => {
    const capture = () => {
      const snapshot = captureSnapshot();
      if (snapshot) setFileBrowserView(id, { browserTreeSnapshot: snapshot });
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      capture();
      // The 500ms persistence debounce usually completes while the hidden
      // renderer stays alive, but flush anyway: on app quit there is no later
      // tick, and the capture above must make this save, not the next one.
      flushPanelPersistence();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // On an identity change this cleanup runs before the new identity's
      // listings commit, so it still captures the outgoing tree under the
      // identity it belongs to (the closed-over captureSnapshot).
      capture();
    };
  }, [id, captureSnapshot, setFileBrowserView]);

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

  const handleToggleDotfiles = useCallback(() => {
    setFileBrowserView(id, { browserHideDotfiles: !hideDotfiles });
  }, [id, hideDotfiles, setFileBrowserView]);

  // A selection the junk list or dotfile toggle now hides. The viewer already
  // clears (the hidden row isn't in `rows`, so `selectedNode` is undefined),
  // but the "Reveal" strip must also stay hidden: expanding ancestors can
  // surface a collapsed row, never a filtered one, so offering it would be a
  // dead end.
  const selectionFilteredHidden = useMemo(() => {
    if (selectedPath === null) return false;
    const isVisible = createVisibilityFilter({ hideDotfiles, alwaysHiddenPatterns });
    return !isRowPathVisible(selectedPath, rootPath, isVisible);
  }, [selectedPath, hideDotfiles, alwaysHiddenPatterns, rootPath]);

  // Stable id for the tree column so the toggle's `aria-controls` can name the
  // region it discloses. Only referenced while the column is mounted (open).
  const treeSidebarId = useId();
  const handleToggleSidebar = useCallback(() => {
    setFileBrowserView(id, { browserSidebarCollapsed: !sidebarCollapsed });
  }, [id, sidebarCollapsed, setFileBrowserView]);

  // Tree-column resize, modeled on PortalDock's handle: delta math from a
  // mousedown-captured start (no DOM measure), continuous writes through the
  // 500ms-debounced panel store, and a ref-held teardown so an unmount mid-drag
  // can drop the document listeners. The column is left-anchored, so dragging
  // right widens (the mirror of PortalDock's right-anchored dock).
  const [isResizing, setIsResizing] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      // Only the primary button drags: a right/middle press must not start a
      // resize (and can't overwrite an in-flight drag's cleanup ref).
      if (e.button !== 0) return;
      // Skip the second mousedown of a double-click: the browser fires mousedown
      // twice before dblclick, so guarding inside the dblclick handler is too
      // late — the drag would already have jittered the width by a pixel.
      if (e.detail > 1) return;
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        // The button was released where we couldn't see the mouseup (over the
        // HTML-preview iframe, or outside the window). Recover on the next move
        // that reaches us rather than staying wedged in a resize.
        if (ev.buttons === 0) {
          cleanup();
          return;
        }
        const next = clampFileBrowserSidebarWidth(startWidth + (ev.clientX - startX));
        setFileBrowserView(id, { browserSidebarWidth: next });
      };
      const handleMouseUp = () => cleanup();
      const cleanup = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        dragCleanupRef.current = null;
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      dragCleanupRef.current = cleanup;
    },
    [id, sidebarWidth, setFileBrowserView]
  );

  const handleResizeDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setFileBrowserView(id, { browserSidebarWidth: FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH });
    },
    [id, setFileBrowserView]
  );

  // Left-anchored splitter: ArrowRight widens, ArrowLeft narrows; Home/End jump
  // to the bounds per the WAI-ARIA window-splitter pattern, Shift for a coarse
  // step (matching PortalDock's keyboard convention).
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey
        ? FILE_BROWSER_SIDEBAR_RESIZE_STEP_COARSE
        : FILE_BROWSER_SIDEBAR_RESIZE_STEP;
      let next: number;
      switch (e.key) {
        case "ArrowRight":
          next = sidebarWidth + step;
          break;
        case "ArrowLeft":
          next = sidebarWidth - step;
          break;
        case "Home":
          next = FILE_BROWSER_SIDEBAR_MIN_WIDTH;
          break;
        case "End":
          next = FILE_BROWSER_SIDEBAR_MAX_WIDTH;
          break;
        default:
          return;
      }
      e.preventDefault();
      setFileBrowserView(id, { browserSidebarWidth: clampFileBrowserSidebarWidth(next) });
    },
    [id, sidebarWidth, setFileBrowserView]
  );

  // The document listeners outlive the grip on two lifecycles the mouseup can't
  // cover: the pane unmounting mid-drag (project switch), and the tree column
  // unmounting because the sidebar collapsed mid-drag (the pane stays mounted,
  // so its unmount effect never fires). Both drop the listeners here.
  useEffect(() => {
    return () => dragCleanupRef.current?.();
  }, []);
  useEffect(() => {
    if (sidebarCollapsed) dragCleanupRef.current?.();
  }, [sidebarCollapsed]);

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
      // Literal path, not a pattern: scoping keeps the worktree's ignore rules
      // in play, so the folder yields what a whole-worktree copy would have.
      void copyContextWithFeedback(worktreeId, "context-menu", {
        scopePaths: [path],
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
      if (!basePath) return;
      copyToClipboard(join(basePath, path), "Couldn't copy path");
    },
    [basePath, copyToClipboard]
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

  // The header label copies the folder the tree is rooted at. Only a re-rooted
  // tree has a path worth copying — at the worktree root the label is a bare
  // basename, so the affordance stays absent rather than disabled.
  const rootAbsolutePath =
    rootPath === "" || basePath === "" ? "" : join(basePath, rootPath);
  const rootHoverPath = rootPath === "" ? basePath : `${basename(basePath)}/${rootPath}`;

  const { copiedText: copiedRootPath, copy: copyRootPath } = useCopyWithFeedback({
    announcement: "Path copied",
  });
  // Matched against the path actually copied, not a bare flag: re-rooting
  // inside the dwell window would otherwise leave the success color describing
  // a folder the header no longer points at.
  const showRootPathCopied = copiedRootPath === rootAbsolutePath;

  const handleCopyRootPath = useCallback(() => {
    if (rootAbsolutePath === "") return;
    // Retry re-enters the whole gesture, so a write that only succeeds on the
    // second attempt still flashes and announces.
    const attempt = () => {
      void copyRootPath(rootAbsolutePath).then((copied) => {
        if (copied) return;
        notify({
          type: "error",
          title: "Couldn't copy path",
          message: "The clipboard rejected the write.",
          // uiFeedback is passive, and the inbox keeps only actionId actions —
          // resolving to "low" would strip the Retry this toast exists for.
          // No panelId/worktreeId: those mark the origin surface as already
          // showing the failure, which suppresses the toast outright — and this
          // label renders nothing when a write fails.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: attempt },
        });
      });
    };
    attempt();
  }, [rootAbsolutePath, copyRootPath]);

  const reveal = useMemo(() => revealCopy(), []);
  const handleReveal = useCallback(
    (path: string) => {
      if (!basePath) return;
      const run = async () => {
        const result = await actionService.dispatch(
          "file.showItemInFolder",
          { path: join(basePath, path) },
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
    [basePath, reveal]
  );

  const rowContextMenu = useCallback(
    (row: FlatTreeRow) => (
      <>
        {row.isDirectory && (
          <>
            <ContextMenuItem onSelect={() => handleSetRoot(row.path)}>
              <FolderRoot className="w-3.5 h-3.5 mr-2" />
              Set as root
            </ContextMenuItem>
            {/* Always enabled for a worktree: the browser no longer knows a
                folder's gitignore status, and CopyTree still applies its own
                .gitignore-aware discovery (reporting when nothing was
                eligible), so this stays safe for a gitignored folder. Absent
                for a workspace root — CopyTree is worktree-scoped, so leaving
                it on would be a dead menu item (#11482). */}
            {source?.kind === "worktree" && (
              <ContextMenuItem onSelect={() => handleCopyFolderContext(row.path)}>
                <Folders className="w-3.5 h-3.5 mr-2" />
                Copy context
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handleCopyFullPath(row.path)}>
          <Copy className="w-3.5 h-3.5 mr-2" />
          Copy full path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyRelativePath(row.path)}>
          <Copy className="w-3.5 h-3.5 mr-2" />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handleCopyFileName(row.name)}>
          <Copy className="w-3.5 h-3.5 mr-2" />
          Copy file name
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleReveal(row.path)}>
          <FolderOpen className="w-3.5 h-3.5 mr-2" />
          {reveal.label}
        </ContextMenuItem>
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
    selectedPath && basePath && selectedNode?.isDirectory === false
      ? join(basePath, selectedPath)
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
        {/* Collapsed unmounts the column entirely (not width 0): a persistent
            toggle in the viewer header re-opens it, so there's no orphaned
            control to home. The tree data hook stays mounted in the pane, so
            the selected file still resolves while the tree is hidden. */}
        {!sidebarCollapsed && (
          <div
            id={treeSidebarId}
            ref={treeColumnRef}
            className="relative flex min-h-0 shrink-0 flex-col self-stretch border-r border-daintree-border bg-daintree-sidebar"
            style={{ width: sidebarWidth }}
          >
            {/* py-1.5 + border-overlay + 16px icons match FileViewerToolbar.Root
                so the two header bars share one height and border token, and the
                line under them reads continuous across the divider (#11328). */}
            <div className="flex shrink-0 items-center gap-0.5 border-b border-overlay px-1.5 py-1.5">
              {/* Root anchor mirrors the diff sidebar's header: where am I
                rooted, then the controls that reshape the view. The root icon
                doubles as the way back when the tree is rooted somewhere. */}
              {rootPath !== "" ? (
                <FileViewerToolbar.IconButton
                  label="Back to worktree root"
                  onClick={handleResetRoot}
                >
                  <FolderRoot className="h-4 w-4" />
                </FileViewerToolbar.IconButton>
              ) : (
                // Same footprint as the button so the path text doesn't shift
                // when the tree is re-rooted.
                <span className="shrink-0 p-1.5 text-daintree-text/40" aria-hidden="true">
                  <FolderRoot className="h-4 w-4" />
                </span>
              )}
              {/* Re-rooted, so the label names a real folder: it copies the
                  absolute path, matching a row's "Copy full path". The tooltip
                  carries the untruncated path the `title` used to show, and
                  hosts the copied confirmation; autoDismiss is off because the
                  path IS the tooltip's body. */}
              {rootAbsolutePath !== "" ? (
                <Tooltip autoDismiss={false}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopyRootPath}
                      aria-label={`Copy folder path: ${rootAbsolutePath}`}
                      className={cn(
                        "min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11px] transition-colors duration-150 ease-out",
                        showRootPathCopied
                          ? "text-status-success"
                          : "text-daintree-text/40 hover:text-daintree-text/70"
                      )}
                    >
                      {rootPath}
                    </button>
                  </TooltipTrigger>
                  {/* The path stays put through the dwell — it's the reason
                      this tooltip exists — so success appends rather than
                      replaces. aria-hidden because the live region already
                      announced it; the description must not change. */}
                  <TooltipContent side="bottom" className="break-words">
                    {rootHoverPath}
                    {showRootPathCopied && (
                      <span aria-hidden="true" className="block text-status-success">
                        Copied!
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-daintree-text/40"
                  title={rootHoverPath}
                >
                  {rootPath || (basePath ? basename(basePath) : "")}
                </span>
              )}
              {rootPath !== "" && (
                <FileViewerToolbar.IconButton label="Up one level" onClick={handleUpOneLevel}>
                  <CornerLeftUp className="h-4 w-4" />
                </FileViewerToolbar.IconButton>
              )}
              <FileViewerToolbar.IconButton
                label="Hide dotfiles"
                pressed={hideDotfiles}
                onClick={handleToggleDotfiles}
              >
                <EyeOff className="h-4 w-4" />
              </FileViewerToolbar.IconButton>
              <FileViewerToolbar.IconButton label="Refresh" onClick={handleRefresh}>
                <SpinningIcon icon={RefreshCw} active={isRefreshing} className="h-4 w-4" />
              </FileViewerToolbar.IconButton>
            </div>
            {renderTree()}
            {/* Straddles the right border between the tree and the viewer. Lives
                inside the collapsible column, so it unmounts with the tree —
                no grip while collapsed, per #11331. Styling mirrors the
                worktree Sidebar / PortalDock handle: a thin pill that thickens
                on hover, an accent focus anchor for keyboard resize. */}
            <div
              role="separator"
              aria-label="Resize file tree"
              aria-orientation="vertical"
              aria-controls={treeSidebarId}
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={FILE_BROWSER_SIDEBAR_MIN_WIDTH}
              aria-valuemax={FILE_BROWSER_SIDEBAR_MAX_WIDTH}
              tabIndex={0}
              data-testid="file-browser-sidebar-resize"
              className={cn(
                "group absolute -right-1.5 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center",
                "transition-colors hover:bg-overlay-soft focus:bg-tint/[0.04] focus:outline-hidden focus:ring-1 focus:ring-daintree-accent/50",
                isResizing && "bg-overlay-medium"
              )}
              onMouseDown={handleResizeStart}
              onDoubleClick={handleResizeDoubleClick}
              onKeyDown={handleResizeKeyDown}
            >
              <div
                className={cn(
                  "h-8 w-px rounded-full transition-[width] delay-100 duration-150 group-hover:w-0.5",
                  "bg-daintree-text/20 group-hover:bg-daintree-text/35 group-focus:bg-daintree-accent",
                  isResizing && "bg-daintree-text/50"
                )}
              />
            </div>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <FileBrowserViewer
            filePath={selectedFilePath}
            rootPath={basePath}
            fileName={selectedFileName}
            relativePath={selectedNode?.isDirectory === false ? (selectedPath ?? null) : null}
            revision={viewerRevision}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={handleToggleSidebar}
            treeSidebarId={treeSidebarId}
          />
        </div>
        {isResizing && (
          // Drag shield: while resizing, cover the surface so the HTML-preview
          // iframe (which the divider drags straight over) can't swallow the
          // mousemove/mouseup the document listeners depend on — without it a
          // drag onto the viewer sticks. Events still bubble to `document`
          // through this element; `fixed` keeps it out of the flex layout.
          <div
            data-testid="file-browser-resize-shield"
            className="fixed inset-0 z-50 cursor-col-resize"
          />
        )}
      </div>
    </ContentPanel>
  );

  function renderTree() {
    if (!source) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          {/* w-full: EmptyState is a CSS container (inline-size containment),
              so as a bare flex item its width collapses and the copy wraps
              word-by-word. */}
          <EmptyState
            variant="zero-data"
            scale="sidebar"
            icon={<FolderTree className="h-5 w-5" />}
            title="Open a folder to browse its files"
            className="w-full"
          />
        </div>
      );
    }

    // The full-pane error is reserved for genuinely having nothing to show
    // (#11367): with rows on screen — live or seeded from the last-known
    // snapshot — a root failure renders inline above them instead, in the
    // populated branch below. An error must never blank a populated tree.
    if (rootError !== null && rows.length === 0) {
      return (
        <div className="p-2">
          <InlineStatusBanner
            severity="error"
            icon={FolderTree}
            title="Couldn't read this folder"
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
      // Only offer "Show dotfiles" when it can actually help — the toggle is on
      // and this root holds dotfiles it is what's hiding. Otherwise the folder
      // is genuinely empty (junk-only contents count as empty too).
      const canRevealDotfiles = hideDotfiles && hasHiddenDotfiles;
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <EmptyState
            variant={canRevealDotfiles ? "filtered-empty" : "zero-data"}
            scale="sidebar"
            className="w-full"
            {...(canRevealDotfiles ? {} : { icon: <FolderTree className="h-5 w-5" /> })}
            title={
              canRevealDotfiles
                ? "Dotfiles are hidden here"
                : rootPath
                  ? "This folder is empty"
                  : "This worktree is empty"
            }
            action={
              canRevealDotfiles ? (
                <button
                  type="button"
                  onClick={handleToggleDotfiles}
                  className="text-xs underline underline-offset-2"
                >
                  Show dotfiles
                </button>
              ) : undefined
            }
          />
        </div>
      );
    }

    return (
      <>
        {/* A root failure with a tree on screen: the banner sits above the
            rows rather than replacing them (same shape as FilePane's stale
            strip), so the last-known files stay usable while the error is
            visible and retryable. */}
        {rootError !== null && (
          <div className="shrink-0 p-2">
            <InlineStatusBanner
              severity="error"
              icon={FolderTree}
              title={rootPath ? "Couldn't refresh this folder" : "Couldn't refresh this worktree"}
              description={`Showing the last known files. ${rootError}`}
              action={{ id: "retry", label: "Retry", onClick: handleRefresh }}
            />
          </div>
        )}
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
        {selectedPath !== null &&
          selectionInRoot &&
          !selectedIsReachable &&
          !selectionFilteredHidden && (
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
