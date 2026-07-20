import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  FileDiff as FileDiffIcon,
  FileText,
  Globe,
  RefreshCw,
  Search,
  WrapText,
  XCircle,
} from "lucide-react";
import type { FileViewMode } from "@shared/types/panel";
import { isFilePanel } from "@shared/types/panel";
import type { GitStatus } from "@shared/types/git";
import { isPathInside, normalize, toWorktreeRelative } from "@shared/utils/path";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { MarkdownViewer, type MarkdownViewerHandle } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { FileImagePreview } from "@/components/FileViewer/FileImagePreview";
import { isImageFilePath, isSvgFilePath } from "@/components/FileViewer/filePreviewKinds";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { formatBytes } from "@/lib/formatBytes";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useDiffContent } from "@/panels/diff/useDiffContent";
import type { DiffSubject } from "@/panels/diff/diffContentCache";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone, SkeletonHint, SkeletonText } from "@/components/ui/Skeleton";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import {
  FILE_READ_ERROR_MESSAGES,
  toFileReadErrorCode,
} from "@/components/FileViewer/fileReadErrors";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isClientAppError } from "@/utils/clientAppError";
import { logError } from "@/utils/logger";
import { useHeightHold } from "./useHeightHold";

export interface FilePaneProps extends BasePanelProps {
  tabs?: TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

// Kept out of the file panel's chunk: it pulls react-diff-view, the tokenizer
// and the diff stylesheet, none of which a plain file view needs. Mirrors how
// the panel registry splits the panes themselves.
const LazyDiffViewer = lazy(() =>
  import("@/components/Worktree/DiffViewer").then((m) => ({ default: m.DiffViewer }))
);

const MODE_LABELS: Record<FileViewMode, string> = {
  source: "Source",
  rendered: "Rendered",
  diff: "Diff",
};

// Shared by the fetch wait and the lazy-chunk wait so the two are
// indistinguishable on screen. `Skeleton` carries the 400ms anti-flicker gate.
function DiffLoadingSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton label="Loading diff">
        <SkeletonBone className="h-7 w-3/4" />
        <SkeletonText lines={8} />
      </Skeleton>
      {/* Sibling, never nested: the wrapper's aria-busy silences mutations
          inside its own subtree. */}
      <SkeletonHint />
    </div>
  );
}

const toForwardSlashes = (p: string) => p.replace(/\\/g, "/");

function parentDirectory(filePath: string): string {
  const fwd = toForwardSlashes(filePath);
  const idx = fwd.lastIndexOf("/");
  return idx > 0 ? fwd.slice(0, idx) : "/";
}

function isUnderRoot(filePath: string, rootPath: string): boolean {
  if (!rootPath) return false;
  const root = toForwardSlashes(rootPath).replace(/\/$/, "") + "/";
  return toForwardSlashes(filePath).startsWith(root);
}

// "image" and "svg" are terminal preview states: an image is handed to the
// `daintree-file://` protocol as an <img> src, and an SVG is read as text,
// sanitized, then inlined. Neither has readable text content.
type LoadState = "idle" | "loading" | "loaded" | "error" | "image" | "svg";

const SEARCH_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 2000;

interface PickerResult {
  relativePath: string;
  absolutePath: string;
}

/** Debounced file search over the panel's root — the empty-state picker. */
function useFileSearch(rootPath: string, query: string): PickerResult[] {
  const [results, setResults] = useState<PickerResult[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      filesClient
        // The files:search IPC schema caps limit at 100; an empty query
        // lists the first files alphabetically.
        .search({ cwd: rootPath, query, limit: 100 })
        .then(({ files }) => {
          if (cancelled) return;
          const root = toForwardSlashes(rootPath).replace(/\/$/, "");
          setResults(
            files
              .filter((f) => !f.endsWith("/"))
              .slice(0, 50)
              .map((relativePath) => ({ relativePath, absolutePath: `${root}/${relativePath}` }))
          );
        })
        .catch((err) => {
          if (!cancelled) setResults([]);
          logError("[FilePane] file search failed", err);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rootPath, query]);

  return results;
}

export function FilePane({
  id,
  title,
  isFocused,
  isMaximized,
  location,
  isMultiPanelGrid,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: FilePaneProps) {
  const panel = usePanelStore(
    useCallback(
      (state) => {
        const candidate = state.panelsById[id];
        return candidate && isFilePanel(candidate) ? candidate : undefined;
      },
      [id]
    )
  );
  const setFileViewMode = usePanelStore((state) => state.setFileViewMode);
  const setFilePanelPath = usePanelStore((state) => state.setFilePanelPath);
  const markdownWrapLines = usePreferencesStore((state) => state.markdownWrapLines);
  const setMarkdownWrapLines = usePreferencesStore((state) => state.setMarkdownWrapLines);
  // Shared with the diff panel so a user's split/unified and wrap choices carry
  // across every surface that shows a diff.
  const diffViewType = usePreferencesStore((state) => state.diffViewType);
  const diffWrapLines = usePreferencesStore((state) => state.diffWrapLines);

  const heightHold = useHeightHold();

  const filePath = panel?.filePath;
  const isMarkdown = filePath !== undefined && isMarkdownFilePath(filePath);
  const isHtml = filePath !== undefined && isHtmlFilePath(filePath);
  // Markdown and HTML get a Rendered mode; every other file is source-only.
  const isRenderable = isMarkdown || isHtml;

  const worktreeId = panel?.worktreeId;
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );

  // Whether a file has local changes is a git fact about where it physically
  // lives, not about the panel's binding: `file.openPanel` resolves an explicit
  // rootPath but still stamps the *active* worktree id, so `panel.worktreeId`
  // can name a worktree the file isn't in. Resolve by containment instead, with
  // the deepest root winning so a nested worktree beats its parent. "" = the
  // file is in no known worktree, so there's nothing to diff it against.
  const diffWorktreePath = useWorktreeStore(
    useCallback(
      (state): string => {
        if (!filePath) return "";
        let best = "";
        let bestLength = -1;
        for (const worktree of state.worktrees.values()) {
          if (!isPathInside(filePath, worktree.path)) continue;
          const length = normalize(worktree.path).length;
          if (length <= bestLength) continue;
          best = worktree.path;
          bestLength = length;
        }
        return best;
      },
      [filePath]
    )
  );

  const relativeFilePath = useMemo(
    () => (filePath && diffWorktreePath ? toWorktreeRelative(filePath, diffWorktreePath) : ""),
    [filePath, diffWorktreePath]
  );

  // Scalar status, never the change entry: `changes` is rebuilt wholesale every
  // poll tick, so returning the object would re-render the pane on each tick —
  // the same Object.is bail-out `selectDiffFreshnessKey` relies on (#8635).
  const localChangeStatus = useWorktreeStore(
    useCallback(
      (state): GitStatus | undefined => {
        if (!diffWorktreePath || !relativeFilePath) return undefined;
        for (const worktree of state.worktrees.values()) {
          if (normalize(worktree.path) !== normalize(diffWorktreePath)) continue;
          // Stored change paths are absolute today (electron/utils/git.ts keys
          // changesMap by absolutePath) though the type says relative — fold
          // both shapes to the same relative form before comparing.
          return worktree.worktreeChanges?.changes?.find(
            (change) =>
              normalize(toWorktreeRelative(change.path, worktree.path)) === relativeFilePath
          )?.status;
        }
        return undefined;
      },
      [diffWorktreePath, relativeFilePath]
    )
  );

  // Rendered and Diff are independent capabilities. One derived list drives
  // both the toggle and the clamp, so a persisted mode whose capability is gone
  // falls back to Source — never written back, since a poll that transiently
  // drops the change must not erase what the user picked.
  const availableModes = useMemo<FileViewMode[]>(
    () => [
      "source",
      ...(isRenderable ? (["rendered"] as const) : []),
      ...(localChangeStatus !== undefined ? (["diff"] as const) : []),
    ],
    [isRenderable, localChangeStatus]
  );
  const requestedMode = panel?.fileViewMode ?? "source";
  const viewMode: FileViewMode = availableModes.includes(requestedMode) ? requestedMode : "source";
  const toggleOptions = useMemo(
    () => availableModes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] })),
    [availableModes]
  );

  // A dialog host sizes to its content every frame, so swapping markdown source
  // for the rendered chunk's skeleton collapses the dialog and expands it again
  // once the document lands. Pin the source height before the swap; the
  // rendered document releases it on its first commit (#11255). Measured here,
  // synchronously, because a layout effect only runs once the box has already
  // shrunk. Only this direction can collapse — source renders at its own height
  // immediately, so the reverse just drops any stale pin.
  const handleViewModeChange = useCallback(
    (mode: FileViewMode) => {
      // Diff collapses the same way: it swaps the document for an async
      // skeleton. Its first content commit is the release signal, in place of
      // the rendered document's onRendered.
      const collapsesOnEntry = mode === "diff" || (mode === "rendered" && isMarkdown);
      if (location === "dialog" && viewMode === "source" && collapsesOnEntry) {
        heightHold.hold();
      } else {
        heightHold.cancel();
      }
      setFileViewMode(id, mode);
    },
    [location, isMarkdown, viewMode, heightHold, setFileViewMode, id]
  );

  // A file swapped underneath an active pin would hold the new document at the
  // old one's height, and a pane promoted out of the dialog would carry a
  // content-sized floor into a layout-sized host.
  useEffect(() => {
    heightHold.cancel();
  }, [filePath, location, heightHold]);

  // Only fetch while Diff is the live mode; a null subject also invalidates any
  // response still in flight from a mode the user has since left.
  const diffSubject = useMemo<DiffSubject | null>(
    () =>
      viewMode === "diff" && diffWorktreePath && relativeFilePath && localChangeStatus !== undefined
        ? {
            source: "working-tree",
            worktreePath: diffWorktreePath,
            filePath: relativeFilePath,
            status: localChangeStatus,
          }
        : null,
    [viewMode, diffWorktreePath, relativeFilePath, localChangeStatus]
  );
  // No `nextSubject`: there's no file to step to from a single-file viewer.
  const { content: diffContent, stale: diffStale, retry: retryDiff } = useDiffContent(diffSubject);

  // The diff has no onRendered of its own; its first content commit (including
  // the ERROR sentinel) is the equivalent signal for releasing a dialog pin.
  useEffect(() => {
    if (viewMode === "diff" && diffContent !== undefined) heightHold.handleRendered();
  }, [viewMode, diffContent, heightHold]);

  const projectPath = useProjectStore((state) => state.currentProject?.path ?? "");

  // Containment root for files.read / daintree-file://: the worktree or
  // project that contains the file, else its parent directory (same
  // outside-root fallback as FileViewerModal).
  const effectiveRootPath = useMemo(() => {
    if (!filePath) return worktreePath || projectPath;
    return (
      [worktreePath, projectPath].find((root) => isUnderRoot(filePath, root)) ??
      parentDirectory(filePath)
    );
  }, [filePath, worktreePath, projectPath]);

  const [content, setContent] = useState<string | null>(null);
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  // Overrides the code-derived copy for failures that no `FileReadErrorCode`
  // describes (a readable file whose SVG content the sanitizer rejects).
  // Mirrors FileViewerModal's `displayErrorMessage`.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  // Sandboxed-iframe preview URL for HTML files (#11191), minted by files:read.
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null);
  // Bumped on every successful (re)load so the (cross-origin) preview frame
  // re-navigates — a rewritten report re-renders on refresh/focus. Bumping on
  // every load, not just entry-file changes, keeps relative assets fresh too.
  const [reloadNonce, setReloadNonce] = useState(0);

  const metadata = useMemo(() => {
    if (loadState !== "loaded" || content === null) return null;
    return {
      lineCount: content.split("\n").length,
      sizeLabel: formatBytes(new TextEncoder().encode(content).byteLength),
    };
  }, [loadState, content]);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdownViewerRef = useRef<MarkdownViewerHandle>(null);
  const codeViewerRef = useRef<CodeViewerHandle>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const loadFile = useCallback(
    (silent: boolean) => {
      if (!filePath) {
        requestRef.current++;
        setContent(null);
        setLoadState("idle");
        setErrorCode(null);
        return;
      }
      const requestId = ++requestRef.current;
      if (!silent) {
        setLoadState("loading");
        setErrorCode(null);
        setErrorMessage(null);
      }

      // Raster images are served straight to an <img> by the protocol handler —
      // reading them as text would just hit the binary-file guard.
      if (isImageFilePath(filePath) && !isSvgFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        setLoadState("image");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      filesClient
        .read({
          path: filePath,
          rootPath: effectiveRootPath,
          htmlPreview: isHtmlFilePath(filePath),
        })
        .then(({ content: fileContent, htmlPreviewUrl: previewUrl }) => {
          if (requestRef.current !== requestId) return;
          // SVG is text on disk but a picture on screen: sanitize before it can
          // be inlined, and surface a sanitizer rejection as a load error
          // rather than silently rendering nothing.
          if (isSvgFilePath(filePath)) {
            const sanitized = sanitizeSvg(fileContent);
            if (sanitized.ok) {
              setSanitizedSvg(sanitized.svg);
              setContent(null);
              setLoadState("svg");
              setErrorCode(null);
              setErrorMessage(null);
            } else {
              // The file read fine; its contents just aren't safe to inline.
              setErrorCode("INVALID_PATH");
              setErrorMessage(sanitized.error);
              setLoadState("error");
            }
            return;
          }
          setSanitizedSvg(null);
          setContent((previous) => (previous === fileContent ? previous : fileContent));
          setHtmlPreviewUrl(previewUrl ?? null);
          // Re-navigate the preview frame on every successful load so a rewritten
          // report — or an unchanged entry file whose relative asset changed —
          // always reflects the latest bytes. reloadNonce isn't a loadFile dep,
          // so this can't re-trigger the load.
          setReloadNonce((nonce) => nonce + 1);
          setLoadState("loaded");
          setErrorCode(null);
          setErrorMessage(null);
        })
        .catch((error: unknown) => {
          if (requestRef.current !== requestId) return;
          const code = isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH";
          // Silent background refreshes keep showing the last good content on
          // transient failures, but a permanently-gone file (deleted, perms
          // revoked) must surface rather than display stale text forever.
          const permanent =
            code === "NOT_FOUND" || code === "PERMISSION" || code === "OUTSIDE_ROOT";
          if (silent && !permanent) return;
          setErrorCode(code);
          setErrorMessage(null);
          setLoadState("error");
        });
    },
    [filePath, effectiveRootPath]
  );

  useEffect(() => {
    loadFile(false);
  }, [loadFile]);

  // Leaving Diff — by choice or because the change vanished — lands on source
  // cached before the edit that prompted the diff in the first place. Re-read it
  // silently, so a file deleted mid-view can't keep reading as present.
  const wasDiffModeRef = useRef(viewMode === "diff");
  useEffect(() => {
    if (wasDiffModeRef.current && viewMode !== "diff") loadFile(true);
    wasDiffModeRef.current = viewMode === "diff";
  }, [viewMode, loadFile]);

  // Agents rewrite files while the user reads them: silently re-read when the
  // pane regains focus or the app window returns to the foreground.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current && loadState === "loaded") {
      loadFile(true);
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused, loadState, loadFile]);

  useEffect(() => {
    if (loadState !== "loaded") return;
    const handleWindowFocus = () => loadFile(true);
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [loadState, loadFile]);

  // Route Cmd+F to the source view's find bar while this pane is focused
  // (no-op in rendered markdown, matching the dialog).
  useEffect(() => {
    if (!isFocused) return;
    const handleFindInPanel = () => {
      markdownViewerRef.current?.openSearch();
      codeViewerRef.current?.openSearch();
    };
    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    return () => window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
  }, [isFocused]);

  const handleCopyPath = useCallback(() => {
    if (!filePath) return;
    navigator.clipboard
      .writeText(filePath)
      .then(() => {
        useAnnouncerStore.getState().announce("Path copied");
        setPathCopied(true);
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setPathCopied(false), COPY_FEEDBACK_MS);
      })
      .catch((err) => logError("[FilePane] copy path failed", err));
  }, [filePath]);

  // Rendered HTML opens in the browser; every other view opens in the editor.
  // The button and its failure banner follow this target.
  const openTarget: "browser" | "editor" = isHtml && viewMode === "rendered" ? "browser" : "editor";

  // dispatch() resolves an ActionDispatchResult and never rejects, so a failed
  // open used to vanish entirely (#11114). Surface it inline on the pane that
  // owns the button rather than through a global toast. The target is passed in
  // by the caller — the toolbar button uses the live view's target, Retry reuses
  // the banner's — so a mode toggle mid-launch can never relabel or re-aim it.
  const [openError, setOpenError] = useState<{
    message: string;
    target: "browser" | "editor";
  } | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const openAttemptRef = useRef(0);
  // Synchronous re-entry guard: state can't stop a double-click in one tick.
  // Without it a second launch could land after the first succeeded and report
  // a failure over a file that was in fact opened.
  const openInFlightRef = useRef(false);

  // A result that lands after the pane switched files (or panels) belongs to the
  // old file: drop it, and clear any banner the old file left behind.
  useEffect(() => {
    openAttemptRef.current += 1;
    openInFlightRef.current = false;
    setOpenError(null);
    setIsOpening(false);
  }, [id, filePath]);

  const handleOpenExternal = useCallback(
    async (target: "browser" | "editor") => {
      if (!filePath) return;
      if (openInFlightRef.current) return;
      openInFlightRef.current = true;
      const attempt = ++openAttemptRef.current;
      setIsOpening(true);
      const result = await actionService.dispatch(
        target === "browser" ? "file.openInBrowser" : "file.openInEditor",
        { path: filePath },
        { source: "user" }
      );
      // A newer attempt (or a file/panel switch) already reset the guard and owns
      // the banner — an obsolete completion must not unlock it or overwrite state.
      if (openAttemptRef.current !== attempt) return;
      openInFlightRef.current = false;
      setIsOpening(false);
      if (result.ok) {
        setOpenError(null);
        return;
      }
      logError(
        `[FilePane] openIn${target === "browser" ? "Browser" : "Editor"} failed`,
        result.error
      );
      setOpenError({ message: result.error.message, target });
    },
    [filePath]
  );

  const [pickerQuery, setPickerQuery] = useState("");
  const pickerRoot = worktreePath || projectPath;
  const pickerResults = useFileSearch(filePath ? "" : pickerRoot, pickerQuery);

  const fileName = filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : undefined;
  // A user-locked rename outranks the derived file name (title layering: the
  // user rung always wins); otherwise the file name is the live title.
  const displayTitle = panel?.titleMode === "user" ? title : (fileName ?? title);
  const displayPath =
    filePath && isUnderRoot(filePath, pickerRoot)
      ? toForwardSlashes(filePath).slice(toForwardSlashes(pickerRoot).replace(/\/$/, "").length + 1)
      : filePath && toForwardSlashes(filePath);
  const toolbar = filePath ? (
    <>
      <FileViewerToolbar.Root>
        {availableModes.length > 1 && (
          <SegmentedToggle<FileViewMode>
            options={toggleOptions}
            value={viewMode}
            onChange={handleViewModeChange}
          />
        )}
        <FileViewerToolbar.Path path={displayPath} copied={pathCopied} onCopy={handleCopyPath} />
        <FileViewerToolbar.Actions>
          {isMarkdown && viewMode === "source" && (
            <FileViewerToolbar.IconButton
              label="Wrap long lines"
              pressed={markdownWrapLines}
              onClick={() => setMarkdownWrapLines(!markdownWrapLines)}
            >
              <WrapText className="w-4 h-4" />
            </FileViewerToolbar.IconButton>
          )}
          {/* Refresh follows what's on screen — re-reading the file wouldn't
              refetch a diff, and vice versa. */}
          <FileViewerToolbar.IconButton
            label="Refresh"
            onClick={() => (viewMode === "diff" ? retryDiff() : loadFile(false))}
          >
            <RefreshCw className="w-4 h-4" />
          </FileViewerToolbar.IconButton>
          <FileViewerToolbar.IconButton
            label={openTarget === "browser" ? "Open in browser" : "Open in editor"}
            onClick={() => void handleOpenExternal(openTarget)}
          >
            {openTarget === "browser" ? (
              <Globe className="w-4 h-4" />
            ) : (
              <ExternalLink className="w-4 h-4" />
            )}
          </FileViewerToolbar.IconButton>
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      {viewMode === "diff" && diffStale && diffContent !== undefined && (
        <InlineStatusBanner
          severity="info"
          icon={FileDiffIcon}
          title="File changed since this diff loaded"
          role="status"
          ariaLive="polite"
          action={{ id: "refresh-diff", label: "Refresh", icon: RefreshCw, onClick: retryDiff }}
        />
      )}
      {openError && (
        <InlineStatusBanner
          icon={XCircle}
          title={
            openError.target === "browser" ? "Couldn't open in browser" : "Couldn't open in editor"
          }
          description={openError.message}
          severity="error"
          action={{
            id: "retry-open-external",
            label: "Retry",
            icon: RefreshCw,
            variant: "dangerFilled",
            loading: isOpening,
            onClick: () => void handleOpenExternal(openError.target),
            ariaLabel:
              openError.target === "browser"
                ? "Retry opening in browser"
                : "Retry opening in editor",
          }}
          onClose={() => setOpenError(null)}
          closeAriaLabel={
            openError.target === "browser" ? "Dismiss browser error" : "Dismiss editor error"
          }
        />
      )}
    </>
  ) : undefined;

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="file"
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
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      <div
        ref={heightHold.bodyRef}
        className={`flex-1 min-h-0 overflow-auto bg-daintree-bg${
          viewMode === "diff" ? " diff-scroll-root" : ""
        }`}
        data-testid="file-pane-body"
      >
        {/* Ahead of every load-state branch on purpose: a deleted file fails
            files.read, and images/binaries never load as text, yet their diff is
            exactly what the user asked to see. */}
        {filePath && viewMode === "diff" && (
          <Suspense fallback={<DiffLoadingSkeleton />}>
            {diffContent === undefined ? (
              <DiffLoadingSkeleton />
            ) : (
              <LazyDiffViewer
                diff={diffContent}
                viewType={diffViewType}
                // The diff's paths are relative to the worktree the file
                // physically lives in, not the one the panel is stamped with,
                // so open-in-editor has to join against the same root the
                // relative paths were derived from.
                rootPath={diffWorktreePath}
                wrapLines={diffWrapLines}
                onRetry={retryDiff}
              />
            )}
          </Suspense>
        )}

        {!filePath && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<FileText className="h-6 w-6" />}
              title="Open a file"
              description={
                pickerRoot
                  ? "Search the project's files, or click a file path in any terminal."
                  : "Open a project, then search its files here."
              }
            />
            {pickerRoot && (
              <div className="w-full max-w-md flex flex-col gap-1 min-h-0">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-daintree-border bg-daintree-sidebar focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20">
                  <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <input
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    placeholder="Search files"
                    aria-label="Search files"
                    className="w-full bg-transparent text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden"
                    data-testid="file-pane-search"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto flex flex-col" role="listbox">
                  {pickerResults.map((result) => (
                    <button
                      key={result.absolutePath}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setFilePanelPath(id, result.absolutePath)}
                      className="text-left px-2 py-1.5 rounded text-xs font-mono truncate text-muted-foreground transition-colors hover:text-daintree-text hover:bg-daintree-border"
                      data-testid="file-pane-result"
                    >
                      {result.relativePath}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {filePath && viewMode !== "diff" && loadState === "loading" && (
          <div className="p-4 space-y-3">
            <Skeleton label="Loading file">
              <SkeletonBone className="h-5 w-1/3" />
              <SkeletonText lines={12} />
            </Skeleton>
          </div>
        )}

        {filePath && viewMode !== "diff" && loadState === "error" && errorCode && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              {errorMessage ?? FILE_READ_ERROR_MESSAGES[errorCode]}
            </p>
            <button
              type="button"
              onClick={() => loadFile(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        )}

        {filePath && viewMode !== "diff" && (loadState === "image" || loadState === "svg") && (
          <FileImagePreview
            filePath={filePath}
            rootPath={effectiveRootPath}
            alt={fileName ?? filePath}
            sanitizedSvg={loadState === "svg" ? sanitizedSvg : null}
            onError={() => {
              setErrorCode("NOT_FOUND");
              setLoadState("error");
            }}
            maxHeightClassName="max-h-full"
          />
        )}

        {filePath &&
          viewMode !== "diff" &&
          loadState === "loaded" &&
          content !== null &&
          (viewMode === "rendered" && isMarkdown ? (
            <MarkdownViewer
              ref={markdownViewerRef}
              content={content}
              filePath={filePath}
              rootPath={effectiveRootPath}
              viewMode="rendered"
              wrapLines={markdownWrapLines}
              onRendered={heightHold.handleRendered}
            />
          ) : viewMode === "rendered" && isHtml ? (
            // Rendered HTML fills the pane in a sandboxed iframe rather than the
            // min-h-full source column; the frame owns its own scrolling.
            <HtmlViewer
              previewUrl={htmlPreviewUrl}
              reloadNonce={reloadNonce}
              title={fileName ?? "HTML preview"}
              className="min-h-full"
            />
          ) : (
            // min-h-full column (mirrors FileViewerModal): the editor surface
            // stretches to the bottom of the pane even for files shorter than it.
            <div className="flex min-h-full flex-col">
              {/* Source mode always carries the metadata bar, markdown included —
                  it describes the bytes on disk, which is exactly what source
                  mode shows. Rendered mode omits it (the document is the view). */}
              {metadata && (
                <div
                  data-testid="file-viewer-metadata"
                  className="px-3 py-1 border-b border-daintree-border text-xs text-muted-foreground font-mono shrink-0"
                >
                  {metadata.lineCount} lines · {metadata.sizeLabel} · UTF-8
                </div>
              )}
              {isMarkdown ? (
                <MarkdownViewer
                  ref={markdownViewerRef}
                  content={content}
                  filePath={filePath}
                  rootPath={effectiveRootPath}
                  viewMode="source"
                  initialLine={panel?.initialLine}
                  wrapLines={markdownWrapLines}
                  className="flex-1"
                />
              ) : (
                <CodeViewer
                  ref={codeViewerRef}
                  content={content}
                  filePath={filePath}
                  initialLine={panel?.initialLine}
                  className="flex-1"
                />
              )}
            </div>
          ))}
      </div>
    </ContentPanel>
  );
}
