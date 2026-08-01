import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  Copy,
  CornerLeftUp,
  EyeOff,
  FolderRoot,
  FolderTree,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";
import { AtSign, FolderOpen, Folders } from "@/components/icons";
import { basename, join } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { copyContextWithFeedback } from "@/hooks/useWorktreeActions";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { flushPanelPersistence } from "@/store/slices";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useExternalChangeTick } from "@/hooks/useExternalChangeTick";
import { useProjectViewRevealed } from "@/hooks/useProjectViewRevealed";
import { FileTreeView } from "./FileTreeView";
import { FileBrowserViewer } from "./FileBrowserViewer";
import { buildWorkingTreeDiffModel } from "@/lib/workingTreeDiff";
import { buildFileBrowserGitStatusIndex, isReadableRelativePath } from "./fileBrowserGitStatus";
import { useFileBrowserTree } from "./useFileBrowserTree";
import { useInsertFileReference } from "./useInsertFileReference";
import { INSERT_FILE_REFERENCE_COMBO } from "./fileReference";
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
  type FileBrowserSortOrder,
  type FileBrowserSource,
  type FileEntryLike,
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
  // Selected as two primitives rather than one object: a selector returning a
  // fresh object would fail the store's reference check and re-render this
  // panel on every unrelated store write.
  const sortKey = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? (panel.browserSortKey ?? "name") : "name";
      },
      [id]
    )
  );
  const sortDirection = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? (panel.browserSortDirection ?? "asc") : "asc";
      },
      [id]
    )
  );
  const sort = useMemo<FileBrowserSortOrder>(
    () => ({ key: sortKey, direction: sortDirection }),
    [sortKey, sortDirection]
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
  // Resolved against the sidebar flag rather than read raw, mirroring the width
  // clamp below: a reachable gesture can never set both (each column's toggle
  // lives in the other column's header, so the one that would hide the last
  // column isn't mounted), but a hand-edited or corrupted record could — and
  // "both collapsed" would render an empty panel with no way back. The older
  // sidebar bit is the one that decides: with both set the tree stays hidden and
  // the viewer is forced open, so the panel always has a visible column and the
  // toggle inside it. Neither stored bit is rewritten — one toggle from here
  // reaches a consistent layout again.
  const viewerCollapsed = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser"
          ? panel.browserViewerCollapsed === true && panel.browserSidebarCollapsed !== true
          : false;
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

  const workspaceRooted = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "file-browser" ? panel.browserWorkspaceRooted === true : false;
      },
      [id]
    )
  );
  // The worktree this panel *browses*, which is not the one it is placed under:
  // promotion into the grid stamps the active worktree onto a workspace-rooted
  // panel so it lands in a rendered index bucket (#11290), and following that
  // id here would re-root the tree to a folder the user never opened (#11489).
  const sourceWorktreeId = workspaceRooted ? undefined : worktreeId;

  // Resolved fresh from the worktree store rather than persisted, so a rename
  // or move is reflected without restarting the panel.
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (sourceWorktreeId ? (state.worktrees.get(sourceWorktreeId)?.path ?? "") : ""),
      [sourceWorktreeId]
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
    // Presence, not truthiness: a persisted `worktreeId: ""` names a worktree
    // that cannot resolve, and treating it as absent would quietly browse the
    // workspace root instead of refusing it.
    if (sourceWorktreeId !== undefined) {
      return worktreePath
        ? { kind: "worktree", worktreeId: sourceWorktreeId, basePath: worktreePath }
        : null;
    }
    return workspaceRootPath ? { kind: "workspace", basePath: workspaceRootPath } : null;
  }, [sourceWorktreeId, worktreePath, workspaceRootPath]);

  // Everything path-shaped in the pane joins against this: the tree's rows are
  // relative to it in both modes.
  const basePath = source?.basePath ?? "";
  // A stable primitive for the menu callback's dependencies — the source object
  // is rebuilt every render.
  const isWorktreeSource = source?.kind === "worktree";
  // The whole snapshot, not just its tick: the per-file statuses on it are what
  // the tree markers and the idle pane's summary read (#11614). Selecting the
  // object is safe for Zustand — it is a stored reference, so an unchanged
  // snapshot returns identically and re-renders nothing.
  const worktreeChanges = useWorktreeStore(
    useCallback(
      (state) =>
        sourceWorktreeId ? state.worktrees.get(sourceWorktreeId)?.worktreeChanges : undefined,
      [sourceWorktreeId]
    )
  );
  // The worktree's git-status change tick — already coalesced by the watcher's
  // adaptive burst debounce, so a bulk write lands as one tick.
  const gitChangeTick = worktreeChanges?.lastUpdated;
  // The raw filesystem-write tick, independent of git status. Combining the two
  // is the fix for the issue's reproduction: a write into a gitignored folder
  // moves this even though `worktreeChanges` (which dedups content-identical
  // snapshots) never advances (#11330).
  const fsChangeTick = useWorktreeStore(
    useCallback(
      (state) =>
        sourceWorktreeId ? state.workingTreeChangedAtById.get(sourceWorktreeId) : undefined,
      [sourceWorktreeId]
    )
  );
  // A single monotonic signal for "re-read the tree": whichever moved most
  // recently. `|| undefined` so a never-changed worktree keeps the "no tick"
  // identity the hook expects. Both sources are worktree-store maps, so a
  // workspace root gets nothing from them (#11482) — `externalChangeTick` below
  // is what covers it.
  const worktreeChangeTick = Math.max(gitChangeTick ?? 0, fsChangeTick ?? 0) || undefined;

  // The changed files this browser can mark up and summarise.
  //
  // Relativized against `worktreeChanges.rootPath` — the realpath-resolved root
  // each `change.path` was itself resolved against — and never against
  // `basePath`, which is the raw worktree path off the store. The two denote the
  // same directory but not the same string whenever an ancestor is a symlink
  // (/tmp -> /private/tmp on macOS), and the strip in `buildWorkingTreeDiffModel`
  // fails *silently* on a mismatch: it hands back the untouched absolute path,
  // which matches no tree row, so the feature would look shipped and mark
  // nothing on exactly the machines it was written for.
  //
  // `null` means no git status is available at all — a workspace root has no
  // worktree behind it, and a snapshot may not have arrived yet. That is a
  // different thing from `[]`, which says the worktree is clean.
  const changedFiles = useMemo(() => {
    if (!isWorktreeSource) return null;
    const changesRoot = worktreeChanges?.rootPath;
    const changes = worktreeChanges?.changes;
    if (!changesRoot || !Array.isArray(changes)) return null;
    const safe = buildWorkingTreeDiffModel(changes, changesRoot).sortedChanges.filter((change) =>
      // Anything still absolute here is a strip that missed. Dropping it keeps a
      // path that can't address a row from ever reaching the selection.
      isReadableRelativePath(change.relativePath)
    );
    // Git reported changes but none of them survived. That is an unusable
    // snapshot, not an empty one — reporting it as "clean" would state the
    // opposite of what git said. Fall back to "status unavailable".
    if (safe.length === 0 && changes.length > 0) return null;
    return safe;
  }, [isWorktreeSource, worktreeChanges]);

  const gitStatusIndex = useMemo(
    () => (changedFiles === null ? null : buildFileBrowserGitStatusIndex(changedFiles)),
    [changedFiles]
  );

  const stableExpandedPaths = useMemo(() => expandedPaths ?? EMPTY_PATHS, [expandedPaths]);

  // What a workspace-rooted panel watches, in the order that decides who
  // survives the hook's per-sample cap.
  //
  // The tree's own root comes first — that is the re-rooted subdirectory when
  // there is one, not the workspace folder above it, or a write directly into
  // the browsed folder would be invisible. The selected file comes second and
  // ahead of every directory: an in-place rewrite moves neither its parent's
  // mtime nor that parent's child-name digest, so nothing else in this set can
  // see it, and it is what the viewer beside the tree is showing. Expanded
  // directories fill the rest; a collapsed subtree isn't rendered and is re-read
  // from scratch when it reopens.
  const watchedPaths = useMemo(() => {
    if (!basePath || isWorktreeSource) return EMPTY_PATHS;
    const treeRoot = join(basePath, rootPath);
    const selectedFile = selectedPath === null ? [] : [join(basePath, selectedPath)];
    return [
      treeRoot,
      ...selectedFile,
      ...stableExpandedPaths.map((relative) => join(basePath, relative)),
    ];
  }, [basePath, isWorktreeSource, rootPath, selectedPath, stableExpandedPaths]);

  // Polled from main rather than watched: a scratch or worktree-less project has
  // no workspace host to hang a watcher on, and the poll is its own reconcile
  // (#11590).
  const externalChangeTick = useExternalChangeTick(
    basePath,
    watchedPaths,
    Boolean(basePath) && !isWorktreeSource
  );

  // One tick contract for `useFileBrowserTree`, whichever side supplied it.
  const changeTick = worktreeChangeTick ?? externalChangeTick;

  const {
    rows,
    isInitialLoading,
    rootError,
    hasHiddenDotfiles,
    ensureLoaded,
    refresh,
    isRefreshing,
    captureSnapshot,
    selectedNode,
    listingPath,
    listingRows,
    listingStatus,
    listingHasHiddenDotfiles,
  } = useFileBrowserTree({
    source,
    expandedPaths: stableExpandedPaths,
    hideDotfiles,
    alwaysHiddenPatterns,
    rootPath,
    changeTick,
    treeSnapshot,
    sort,
    selectedPath,
  });

  // Persist the last-known tree at going-away points only (#11367): the
  // document actually being hidden (window minimize, window close, app quit —
  // `visibilitychange` is the reliable detach signal for those, see #9914 in
  // `resource.ts`; a project switch is NOT one of them, since caching a child
  // WebContentsView leaves page visibility alone) and unmount,
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

  // Picking a file from the changed-files summary also opens its ancestors, so
  // the row is waiting in the tree once the summary is replaced by the file.
  // That is the whole reason both halves of #11614 shipped together — a file
  // surfaced in the summary has to stay findable afterwards.
  //
  // It also keeps the selection honest over time: with the row flattened, the
  // tree itself witnesses that the path is a file, so the viewer holds the file
  // open after an agent commits it and git stops reporting it as changed.
  const handleSelectChangedFile = useCallback(
    (path: string) => {
      const expanded = new Set(stableExpandedPaths);
      for (const ancestor of ancestorDirectories(path)) expanded.add(ancestor);
      setFileBrowserView(id, {
        browserSelectedPath: path,
        browserExpandedPaths: [...expanded].sort(),
      });
    },
    [id, stableExpandedPaths, setFileBrowserView]
  );

  // Enter and double-click open the row's file as its own panel (#11496), which
  // is what makes a collapsed viewer usable: the browser stops being a
  // self-contained reader and feeds the grid instead. The action reuses a panel
  // already showing the same file, so repeating the gesture activates that panel
  // rather than piling up duplicates.
  //
  // Positively a file, matching the viewer's own check: the key resolver returns
  // `activate` for whatever row is selected, so directories arrive here too and
  // are deliberately dropped — a folder's Enter does nothing, and re-rooting is
  // the double-click's job.
  const handleActivate = useCallback(
    (path: string) => {
      const row = rows.find((candidate) => candidate.path === path);
      // The base-path half is defensive rather than reachable: an unresolved
      // source renders no tree at all, so nothing can activate a row. It stays
      // because joining against "" would silently produce a wrong absolute path.
      if (!basePath || row?.isDirectory !== false) return;

      const absolutePath = join(basePath, path);
      void (async () => {
        const result = await actionService.dispatch(
          "file.openPanel",
          { path: absolutePath },
          { source: "user" }
        );
        if (!result.ok) {
          // No toast: the realistic failure is the panel ceiling, and `addPanel`
          // already raises that warning itself — a second one would report the
          // same gesture twice.
          logError("[fileBrowser] failed to open file panel", result.error);
          return;
        }
        // As a dialog this browser is modal, so the panel just opened sits behind
        // it and the gesture would look like it did nothing. `onClose` is the
        // dialog host's own close for this panel, so this is the same teardown
        // the close button runs — nothing extra to unwind.
        if (location === "dialog") onClose?.();
      })();
    },
    [location, onClose, basePath, rows]
  );

  // The foreground half of the refresh signal, counted apart from the ambient
  // change tick so Refresh also re-reads the open file, not just the tree. It
  // then travels to the viewer BOTH ways, and both are load-bearing: merged
  // into `viewerRevision` below, and handed over on its own as the media
  // previews' reload key (#11586). Dropping the direct handoff makes Refresh
  // inert for media again; substituting the merged value there restarts
  // playback on every ambient write. Keep both.
  const [surfaceRefreshNonce, setSurfaceRefreshNonce] = useState(0);
  const refreshAll = useCallback(
    (options?: { manual?: boolean }) => {
      setSurfaceRefreshNonce((nonce) => nonce + 1);
      refresh(options);
    },
    [refresh]
  );
  const handleRefresh = useCallback(() => {
    refreshAll({ manual: true });
  }, [refreshAll]);

  // Returning to a project the user left. A view swap is not a page load and
  // `document.visibilityState` never moves for a cached child WebContentsView
  // (`viewCacheState`), so without this the tree and whatever file is open in
  // the viewer both sit on whatever they read on the way out — media and PDFs
  // worst of all, since the change tick deliberately never reaches their reload
  // key. Re-reads exactly what Refresh does, minus `manual`: the spinner
  // reports a gesture, and coming back to a project isn't one.
  const isDockParked = usePanelStore(
    useCallback((state) => location === "dock" && state.activeDockTerminalId !== id, [location, id])
  );
  useProjectViewRevealed(() => refreshAll(), { enabled: !isDockParked });

  // One value per refresh *cycle*, not per directory listed. Deriving it from
  // the tree's per-listing commits would make a 500-directory refresh re-read
  // the open file 500 times. Carrying the nonce here as well as separately is
  // what re-runs the viewer's classification effect, so a media file stuck in
  // `status: "error"` remounts its preview on Refresh instead of staying dead.
  const viewerRevision = `${changeTick ?? 0}:${surfaceRefreshNonce}`;

  const handleToggleDotfiles = useCallback(() => {
    setFileBrowserView(id, { browserHideDotfiles: !hideDotfiles });
  }, [id, hideDotfiles, setFileBrowserView]);

  // Unconditionally turns the filter off, unlike the toggle above: it backs the
  // "Show dotfiles" recovery on an empty state, where the only reason the
  // control is offered is that the filter is currently hiding something.
  const handleShowDotfiles = useCallback(() => {
    setFileBrowserView(id, { browserHideDotfiles: false });
  }, [id, setFileBrowserView]);

  // Both halves in one write: the setter's no-op guard compares each against
  // its own default, so sending them separately would let a key change land
  // while a simultaneous direction change was still being judged unchanged.
  const handleSortChange = useCallback(
    (next: FileBrowserSortOrder) => {
      setFileBrowserView(id, { browserSortKey: next.key, browserSortDirection: next.direction });
    },
    [id, setFileBrowserView]
  );

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

  // Stable ids for the two columns so each toggle's `aria-controls` can name the
  // region it discloses. Only referenced while that column is mounted (open).
  const treeSidebarId = useId();
  const viewerColumnId = useId();
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
  // cover: the pane unmounting mid-drag (project switch), and the grip
  // unmounting mid-drag while the pane stays mounted (so its unmount effect
  // never fires). The grip only exists in the split layout, so either collapse
  // takes it away — collapsing the tree unmounts the column it lives in, and
  // collapsing the viewer leaves nothing to resize against (#11496).
  useEffect(() => {
    return () => dragCleanupRef.current?.();
  }, []);
  useEffect(() => {
    if (sidebarCollapsed || viewerCollapsed) dragCleanupRef.current?.();
  }, [sidebarCollapsed, viewerCollapsed]);

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
      const column = treeColumnRef.current;
      if (!column) return;
      // The tree when there are rows to land on, otherwise the first control the
      // column still has: the loading, error and empty branches render no tree at
      // all, and querying only for it would drop focus to the document in exactly
      // the cases this exists to cover.
      const target =
        column.querySelector<HTMLElement>('[role="tree"]') ??
        column.querySelector<HTMLElement>("button");
      target?.focus();
    });
  }, []);

  // Collapsing the viewer unmounts everything in it, including its own controls.
  // The containment check is what keeps the common path intact: the toggle lives
  // in the tree header, so a click leaves focus on a button that survives the
  // collapse, and redirecting unconditionally would yank it away. It only hands
  // focus to the tree when the collapse came from elsewhere (a programmatic or
  // assistive activation) while something inside the viewer held it, which
  // would otherwise drop focus to the document.
  const viewerColumnRef = useRef<HTMLDivElement>(null);
  const handleToggleViewer = useCallback(() => {
    const focusWasInViewer =
      !viewerCollapsed && viewerColumnRef.current?.contains(document.activeElement) === true;
    setFileBrowserView(id, { browserViewerCollapsed: !viewerCollapsed });
    if (focusWasInViewer) focusTree();
  }, [id, viewerCollapsed, setFileBrowserView, focusTree]);

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
      if (!sourceWorktreeId) return;
      // Literal path, not a pattern: scoping keeps the worktree's ignore rules
      // in play, so the folder yields what a whole-worktree copy would have.
      void copyContextWithFeedback(sourceWorktreeId, "context-menu", {
        scopePaths: [path],
      });
    },
    [sourceWorktreeId]
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
  const rootAbsolutePath = rootPath === "" || basePath === "" ? "" : join(basePath, rootPath);
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

  // Hand a row to the agent the user was last talking to, without a drag
  // (#11577). `basePath` turns the tree's relative row into the absolute path
  // the hook needs; the hook then relativizes it against the destination
  // agent's cwd, exactly as a Finder drop into that agent's input would.
  const { canInsert: canInsertFileReference, insert: insertFileReference } =
    useInsertFileReference();
  const handleInsertFileReference = useCallback(
    (path: string) => {
      // Same guard as the copy handlers: a relative token would name nothing
      // the agent can open. Unreachable through the UI — the pane shows its
      // placeholder rather than a tree when no base resolves — but the
      // handlers are what own the invariant.
      if (!basePath) return;
      insertFileReference(join(basePath, path));
    },
    [basePath, insertFileReference]
  );
  const insertShortcutHint = isMac() ? "⌘I" : "Ctrl+I";
  const insertAriaKeyshortcuts = comboToAriaKeyshortcuts(INSERT_FILE_REFERENCE_COMBO, isMac());

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

  // Typed on the shared entry shape rather than on `FlatTreeRow` so the tree and
  // the folder listing hand it their own row types and get the identical menu
  // (#11620). Nothing below reads a tree-only field — the handlers all take a
  // path or a name — and a second copy of this menu for the listing would be
  // sixty lines that have to stay in lockstep forever.
  const rowContextMenu = useCallback(
    (row: FileEntryLike) => (
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
            {isWorktreeSource && (
              <ContextMenuItem onSelect={() => handleCopyFolderContext(row.path)}>
                <Folders className="w-3.5 h-3.5 mr-2" />
                Copy context
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {/* Disabled rather than hidden when nothing resolves: the gesture is
            the point of the menu entry, and a row that silently drops it would
            read as broken. The agent is resolved from typing history, so this
            is off until the user has actually talked to one. */}
        <ContextMenuItem
          onSelect={() => handleInsertFileReference(row.path)}
          disabled={!canInsertFileReference}
          {...(canInsertFileReference ? { "aria-keyshortcuts": insertAriaKeyshortcuts } : {})}
        >
          <AtSign className="w-3.5 h-3.5 mr-2" />
          Insert file reference
          <ContextMenuShortcut>{insertShortcutHint}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
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
      isWorktreeSource,
      handleSetRoot,
      handleCopyFolderContext,
      handleInsertFileReference,
      canInsertFileReference,
      insertShortcutHint,
      insertAriaKeyshortcuts,
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

  // Picking a file from the changed-files summary selects a path whose tree row
  // may not be flattened at all — its ancestors are collapsed, so `selectedNode`
  // is undefined for it. Git is the second witness that it is a readable file:
  // every entry here is a path git just reported as changed.
  //
  // Deleted files are excluded on purpose. They are listed in the summary (the
  // change set would be a lie without them) but there is nothing on disk to
  // read, and admitting one here would swap the placeholder for a file-not-found
  // error the moment a live delete landed on the open selection.
  const isSelectedChangedFile = useMemo(
    () =>
      selectedPath !== null &&
      changedFiles !== null &&
      changedFiles.some(
        (change) => change.relativePath === selectedPath && change.status !== "deleted"
      ),
    [changedFiles, selectedPath]
  );
  // Positively a file, not merely "not known to be a directory": collapsing a
  // parent hides the selected row without clearing the selection, and treating
  // that unknown node as a file makes the viewer try to read a directory.
  //
  // Git only gets a vote when the tree has no opinion. A known directory is a
  // hard veto — git reports a dirty submodule as a changed path while the
  // filesystem calls it a directory, and letting the change set override the row
  // would hand the viewer a directory to read.
  //
  // `selectedNode` now comes from the tree hook, resolved against its listings
  // map rather than against the rendered rows (#11620), so it already answers
  // for an entry picked out of a folder listing whose parent is collapsed. Git
  // still covers what that cannot: a path whose parent directory has not been
  // listed at all, where there is no node to consult either way.
  const isSelectedReadableFile =
    selectedNode === undefined ? isSelectedChangedFile : selectedNode.isDirectory === false;
  // `selectionFilteredHidden` is part of the gate, not decoration: resolving the
  // node from the listings map means it survives the filter that removed its
  // row, so without this an entry hidden by the dotfile toggle would keep its
  // contents on screen in the viewer while the tree stopped showing it at all.
  const selectedFilePath =
    selectedPath && basePath && isSelectedReadableFile && !selectionFilteredHidden
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
            // As the sole column the tree fills the panel instead of holding its
            // dragged width: a 600px-capped tree beside dead space would keep
            // exactly the imbalance collapsing the viewer is meant to fix
            // (#11496). The width is remembered, not applied — reopening the
            // viewer restores the split. The right border goes with the divider,
            // since there is nothing on the other side of it.
            className={cn(
              "relative flex min-h-0 flex-col self-stretch bg-daintree-sidebar",
              viewerCollapsed ? "min-w-0 flex-1" : "shrink-0 border-r border-daintree-border"
            )}
            style={viewerCollapsed ? undefined : { width: sidebarWidth }}
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
              {/* Refresh follows what's on screen rather than sitting in both
                  headers: with a file open the viewer's toolbar owns it, beside
                  that file's own actions, and two buttons named "Refresh" wired
                  to this same handler would read as two different actions to
                  anyone who can't see which column they're in (#11496). Every
                  other layout leaves it here — a collapsed viewer has no toolbar
                  to hand it to, and with nothing open there is no file for the
                  viewer's copy to be about. */}
              {(viewerCollapsed || selectedFilePath === null) && (
                <FileViewerToolbar.IconButton label="Refresh" onClick={handleRefresh}>
                  <SpinningIcon icon={RefreshCw} active={isRefreshing} className="h-4 w-4" />
                </FileViewerToolbar.IconButton>
              )}
              {/* The viewer's disclosure, homed here rather than in the viewer —
                  the mirror of where the tree's toggle lives (#11496). That
                  placement is also what makes "both collapsed" unreachable:
                  each toggle only exists while the column it would leave behind
                  is on screen. Last in the row so it sits against the divider,
                  the way the tree's toggle sits first in the viewer's toolbar.
                  A static label per the toggle-label rule; the icon swap and
                  `aria-expanded` carry the state, and `aria-controls` is dropped
                  while the named region is unmounted. */}
              <FileViewerToolbar.IconButton
                label="Toggle file viewer"
                expanded={!viewerCollapsed}
                controls={viewerCollapsed ? undefined : viewerColumnId}
                sidebarToggle
                onClick={handleToggleViewer}
                data-testid="file-browser-viewer-toggle"
              >
                {viewerCollapsed ? (
                  <PanelRightOpen className="h-4 w-4" />
                ) : (
                  <PanelRightClose className="h-4 w-4" />
                )}
              </FileViewerToolbar.IconButton>
            </div>
            {renderTree()}
            {/* Straddles the right border between the tree and the viewer. Lives
                inside the collapsible column, so it unmounts with the tree —
                no grip while collapsed, per #11331 — and is gated on the viewer
                too, since a sole column has nothing to resize against (#11496).
                Styling mirrors the worktree Sidebar / PortalDock handle: a thin
                pill that thickens on hover, an accent focus anchor for keyboard
                resize. */}
            {!viewerCollapsed && (
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
            )}
          </div>
        )}
        {/* Unmounts entirely when collapsed, the mirror of the tree column: the
            toggle that brings it back lives in the tree's header, so there is no
            orphaned control (#11496). */}
        {!viewerCollapsed && (
          <div
            id={viewerColumnId}
            ref={viewerColumnRef}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            <FileBrowserViewer
              filePath={selectedFilePath}
              rootPath={basePath}
              fileName={selectedFileName}
              relativePath={isSelectedReadableFile ? (selectedPath ?? null) : null}
              revision={viewerRevision}
              // Handed over separately from `revision` rather than pulled back
              // out of it: the media previews may only re-fetch on the explicit
              // half of that pair, and a merged string can't say which half
              // moved (#11586).
              surfaceRefreshNonce={surfaceRefreshNonce}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={handleToggleSidebar}
              treeSidebarId={treeSidebarId}
              changedFiles={changedFiles}
              onSelectChangedFile={handleSelectChangedFile}
              // The folder-selected state (#11620). `folderPath` and `filePath`
              // are mutually exclusive by construction — both are derived from
              // the same resolved `selectedNode`, so the viewer never has to
              // decide which one wins.
              folderPath={listingPath}
              folderRows={listingRows}
              folderStatus={listingStatus}
              folderHasHiddenDotfiles={hideDotfiles && listingHasHiddenDotfiles}
              onShowDotfiles={handleShowDotfiles}
              onSelectEntry={handleSelect}
              rowContextMenu={rowContextMenu}
              basePath={basePath}
              sort={sort}
              onSortChange={handleSortChange}
            />
          </div>
        )}
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
          onActivate={handleActivate}
          onRootFolder={handleSetRoot}
          rowContextMenu={rowContextMenu}
          onInsertFileReference={handleInsertFileReference}
          canInsertFileReference={canInsertFileReference}
          // Turns a dragged row's relative path absolute (#11576), the same
          // join the insert-reference and copy-path handlers above use.
          basePath={basePath}
          label={`Files in ${title}`}
          gitStatusIndex={gitStatusIndex}
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
