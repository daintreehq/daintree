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
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { FolderOpen } from "@/components/icons";
import type { TabInfo } from "@/components/Panel/TabButton";
import { MarkdownViewer, type MarkdownViewerHandle } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { revealCopy, type RevealCopy } from "@/components/FileViewer/revealCopy";
import { FileImagePreview } from "@/components/FileViewer/FileImagePreview";
import { FileVideoPreview } from "@/components/FileViewer/FileVideoPreview";
import { FileAudioPreview } from "@/components/FileViewer/FileAudioPreview";
import { FilePdfPreview } from "@/components/FileViewer/FilePdfPreview";
import {
  isAudioFilePath,
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
  UNSUPPORTED_AUDIO_MESSAGE,
  UNSUPPORTED_VIDEO_MESSAGE,
} from "@/components/FileViewer/filePreviewKinds";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { formatBytes } from "@/lib/formatBytes";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
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
import { useDohertyGate } from "@/hooks/useDeferredLoading";
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

// "image", "svg", "video", "audio", and "pdf" are terminal preview states: an
// image is handed to the `daintree-file://` protocol as an <img> src, an SVG is
// read as text, sanitized, then inlined, video/audio are fetched from the same
// protocol into a blob the media element plays, and a PDF is framed from
// `daintree-pdf://` into Chromium's built-in viewer. None has readable text
// content.
type LoadState =
  "idle" | "loading" | "loaded" | "error" | "image" | "svg" | "video" | "audio" | "pdf";

// Which external surface a toolbar action aims the current file at. `reveal` is
// always offered; `browser`/`editor` is the mode-dependent open button.
type ExternalTarget = "reveal" | "browser" | "editor";

const EXTERNAL_ACTIONS = {
  reveal: "file.showItemInFolder",
  browser: "file.openInBrowser",
  editor: "file.openInEditor",
} as const satisfies Record<ExternalTarget, BuiltInRuntimeActionId>;

// Button label comes from `revealCopy()` (platform-named); the failure banner's
// title, retry name and dismiss name are resolved together with it so the three
// can't drift. Browser/editor wording is static — only reveal is platform-bound.
function externalTargetCopy(
  target: ExternalTarget,
  reveal: RevealCopy
): { errorTitle: string; retryAriaLabel: string; dismissAriaLabel: string } {
  switch (target) {
    case "reveal":
      return {
        errorTitle: reveal.errorTitle,
        retryAriaLabel: reveal.retryAriaLabel,
        dismissAriaLabel: "Dismiss file manager error",
      };
    case "browser":
      return {
        errorTitle: "Couldn't open in browser",
        retryAriaLabel: "Retry opening in browser",
        dismissAriaLabel: "Dismiss browser error",
      };
    case "editor":
      return {
        errorTitle: "Couldn't open in editor",
        retryAriaLabel: "Retry opening in editor",
        dismissAriaLabel: "Dismiss editor error",
      };
  }
}

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

  // The containing worktree's "something moved on disk" signal, resolved off the
  // same containment path as the diff subject rather than `panel.worktreeId`.
  // Two ticks, because neither is sufficient alone: `worktreeChanges.lastUpdated`
  // misses writes into gitignored folders (git status never moves), and the raw
  // filesystem tick misses nothing but says nothing about git. Whichever moved
  // most recently wins, matching FileBrowserPane (#11330). Scalar for the same
  // reason as `localChangeStatus` — an object would re-render on every poll.
  // `undefined` when the file is in no known worktree: no watcher covers it, so
  // there is simply no live signal to give.
  const changeTick = useWorktreeStore(
    useCallback(
      (state): number | undefined => {
        if (!diffWorktreePath) return undefined;
        for (const worktree of state.worktrees.values()) {
          if (normalize(worktree.path) !== normalize(diffWorktreePath)) continue;
          return (
            Math.max(
              worktree.worktreeChanges?.lastUpdated ?? 0,
              state.workingTreeChangedAtById.get(worktree.id) ?? 0
            ) || undefined
          );
        }
        return undefined;
      },
      [diffWorktreePath]
    )
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
  // Reload generation for every surface whose content lives behind a URL rather
  // than in React state: the sandboxed HTML preview frame, the media players,
  // and the raster <img>. Their URLs are pure functions of path and root, so
  // without a changing token a rewritten file is never re-requested. Bumped on
  // every successful load, not just entry-file changes, so relative assets stay
  // fresh too. Never a `loadFile` dependency — that would re-trigger the load.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Which surface a toolbar Refresh press is currently spinning for (or null).
  // The mode is captured at click so a mode switch mid-refresh doesn't settle
  // the spin against the wrong signal. Drives the shared SpinningIcon.
  const [refreshingMode, setRefreshingMode] = useState<FileViewMode | null>(null);

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
  // Whether something readable for the *current* file is already on screen.
  // A silent refresh may only swallow a failure when there is good content to
  // preserve — otherwise the pane would sit on a skeleton forever, waiting for
  // a load that already failed. Reset per identity, since content from the
  // previous file is not something worth keeping.
  const hasGoodViewRef = useRef(false);
  useEffect(() => {
    hasGoodViewRef.current = false;
  }, [filePath, effectiveRootPath]);

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
        // Unconditionally, unlike the media branches below: a still image has no
        // playback or reader position to protect, so a silent background pass
        // should show the new bytes rather than preserve the old ones. Without
        // this the <img> URL never changes and even toolbar Refresh is inert.
        setReloadNonce((nonce) => nonce + 1);
        setLoadState("image");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Videos stream from the protocol handler into a <video> element; the
      // text path would reject them with a misleading size/binary error.
      if (isVideoFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only an explicit load (open, toolbar Refresh) re-requests the media —
        // a silent background pass must not remount the player and reset
        // playback while someone is watching.
        if (!silent) setReloadNonce((nonce) => nonce + 1);
        setLoadState("video");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Audio takes the same protocol-to-blob route as video — the text path
      // would reject it with a misleading size/binary error.
      if (isAudioFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only an explicit load (open, toolbar Refresh) re-requests the media —
        // a silent background pass must not remount the player and reset
        // playback while someone is listening.
        if (!silent) setReloadNonce((nonce) => nonce + 1);
        setLoadState("audio");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // PDFs are framed straight from the protocol handler into Chromium's
      // built-in viewer; the text path would reject them as a binary file.
      if (isPdfFilePath(filePath)) {
        setContent(null);
        setSanitizedSvg(null);
        // Only an explicit load (open, toolbar Refresh) re-requests the
        // document — a silent background pass must not remount the frame and
        // throw away the reader's page and zoom.
        if (!silent) setReloadNonce((nonce) => nonce + 1);
        setLoadState("pdf");
        setErrorCode(null);
        setErrorMessage(null);
        return;
      }

      // Formats Chromium can't decode get a truthful "can't play" message
      // instead of falling through to the text path's size cap.
      const unsupportedMediaMessage = isUnsupportedVideoFilePath(filePath)
        ? UNSUPPORTED_VIDEO_MESSAGE
        : isUnsupportedAudioFilePath(filePath)
          ? UNSUPPORTED_AUDIO_MESSAGE
          : null;
      if (unsupportedMediaMessage) {
        setContent(null);
        setSanitizedSvg(null);
        setErrorCode("BINARY_FILE");
        setErrorMessage(unsupportedMediaMessage);
        setLoadState("error");
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
              hasGoodViewRef.current = true;
            } else if (!silent || !hasGoodViewRef.current) {
              // The file read fine; its contents just aren't safe to inline.
              // A background pass catching a half-written file mid-save would
              // read as sanitizer rejection, so keep the last good drawing
              // rather than replacing it — the same bargain the text path's
              // transient-failure guard below makes.
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
          hasGoodViewRef.current = true;
        })
        .catch((error: unknown) => {
          if (requestRef.current !== requestId) return;
          const code = isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH";
          // Silent background refreshes keep showing the last good content on
          // transient failures, but a permanently-gone file (deleted, perms
          // revoked) must surface rather than display stale text forever.
          // Only worth swallowing when there is good content to keep: a silent
          // pass that supersedes the very first read would otherwise strand the
          // pane on its skeleton with nothing left to settle it.
          const permanent =
            code === "NOT_FOUND" || code === "PERMISSION" || code === "OUTSIDE_ROOT";
          if (silent && !permanent && hasGoodViewRef.current) return;
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

  // Toolbar Refresh: spin the icon until the refreshed surface settles. Capture
  // the mode at press time so switching source⇄diff mid-refresh can't clear the
  // spin against the wrong signal. A synchronous branch (image/svg, or an
  // already-loaded diff) settles the same tick — SpinningIcon still guarantees a
  // full rotation from the single active render.
  const handleToolbarRefresh = useCallback(() => {
    setRefreshingMode(viewMode);
    if (viewMode === "diff") retryDiff();
    else loadFile(false);
  }, [viewMode, retryDiff, loadFile]);

  useEffect(() => {
    if (refreshingMode === null) return;
    // The refreshed surface is no longer on screen (mode switched, or diff mode
    // clamped away when the change vanished) → the spin is moot, disarm it. This
    // also covers an abandoned diff: `diffSubject` going null leaves diffContent
    // `undefined` forever, which would otherwise strand the spin on "diff".
    const settled =
      refreshingMode !== viewMode ||
      (refreshingMode === "diff"
        ? diffSubject === null || diffContent !== undefined
        : loadState !== "loading");
    if (settled) setRefreshingMode(null);
  }, [refreshingMode, viewMode, diffSubject, diffContent, loadState]);

  // Leaving Diff — by choice or because the change vanished — lands on source
  // cached before the edit that prompted the diff in the first place. Re-read it
  // silently, so a file deleted mid-view can't keep reading as present.
  const wasDiffModeRef = useRef(viewMode === "diff");
  useEffect(() => {
    if (wasDiffModeRef.current && viewMode !== "diff") loadFile(true);
    wasDiffModeRef.current = viewMode === "diff";
  }, [viewMode, loadFile]);

  // Agents rewrite files while the user watches, and the pane stays focused the
  // whole time — so focus regain alone can't be the only live signal. Re-read
  // silently whenever the containing worktree reports a change.
  //
  // Identity travels with the tick so only a genuine disk write triggers this: a
  // path or root switch changes the tick too, but already has its own explicit
  // load, and firing here as well would read the same file twice.
  const lastChangeSignalRef = useRef({
    filePath,
    readRoot: effectiveRootPath,
    watchRoot: diffWorktreePath,
    tick: changeTick,
    viewMode,
  });
  useEffect(() => {
    const previous = lastChangeSignalRef.current;
    lastChangeSignalRef.current = {
      filePath,
      readRoot: effectiveRootPath,
      watchRoot: diffWorktreePath,
      tick: changeTick,
      viewMode,
    };
    // Diff owns its own freshness — useDiffContent subscribes to the same store
    // and raises a stale banner — and leaving Diff already re-reads source, so a
    // tick on either side of that transition would only duplicate the work.
    if (viewMode === "diff" || previous.viewMode === "diff") return;
    if (!filePath || !diffWorktreePath || changeTick === undefined) return;
    // What the pane reads, versus what it watches. Only a change to the former
    // implies an explicit load already happened — `loadFile` is keyed on those
    // two alone, so acquiring a watcher moves `watchRoot` while leaving the read
    // identity untouched, and nothing else would re-read.
    if (previous.filePath !== filePath || previous.readRoot !== effectiveRootPath) return;
    // A newly resolved worktree counts as a signal in its own right: whatever
    // happened to the file before anything was watching it is exactly what the
    // pane cannot otherwise know about.
    if (previous.watchRoot === diffWorktreePath && previous.tick === changeTick) return;
    loadFile(true);
  }, [filePath, effectiveRootPath, diffWorktreePath, changeTick, viewMode, loadFile]);

  // Which surfaces a background re-read may replace. Images and inlined SVG join
  // "loaded" because both are cheap to re-request and show nothing but the file.
  // Video, audio and PDF are deliberately absent: their reload key only moves on
  // an explicit load, so a silent pass here would be inert for them anyway, and
  // widening it would reset playback or a reader's page on an unrelated write.
  const reloadsSilently = loadState === "loaded" || loadState === "image" || loadState === "svg";

  // Still worth re-reading on focus regain: a write that landed while no watcher
  // covered the file (opened outside every known worktree) has no tick at all.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current && reloadsSilently) {
      loadFile(true);
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused, reloadsSilently, loadFile]);

  useEffect(() => {
    if (!reloadsSilently) return;
    const handleWindowFocus = () => loadFile(true);
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [reloadsSilently, loadFile]);

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
  // Reveal is a third, always-present target that sits alongside this one.
  const openTarget: "browser" | "editor" = isHtml && viewMode === "rendered" ? "browser" : "editor";

  // dispatch() resolves an ActionDispatchResult and never rejects, so a failed
  // open used to vanish entirely (#11114). Surface it inline on the pane that
  // owns the button rather than through a global toast. `target` rides along so
  // Retry re-aims at what actually failed, even after a mode toggle.
  const [externalError, setExternalError] = useState<{
    message: string;
    target: ExternalTarget;
  } | null>(null);
  // Tracked per target, not as one flag: revealing successfully says nothing
  // about a missing editor, so the two must not clear or spin for each other.
  const [pendingTargets, setPendingTargets] = useState<readonly ExternalTarget[]>([]);
  // Bumped only by the reset below, so a still-running action is invalidated by
  // the file changing under it — never by a sibling button starting.
  const externalGenerationRef = useRef(0);
  // Synchronous re-entry guard: state can't stop a double-click in one tick.
  const externalInFlightRef = useRef<Set<ExternalTarget>>(new Set());

  // A result that lands after the pane switched files (or panels) belongs to the
  // old file: drop it, and clear any banner the old file left behind.
  useEffect(() => {
    externalGenerationRef.current += 1;
    externalInFlightRef.current.clear();
    setExternalError(null);
    setPendingTargets([]);
  }, [id, filePath]);

  const handleOpenExternal = useCallback(
    async (target: ExternalTarget) => {
      if (!filePath) return;
      if (externalInFlightRef.current.has(target)) return;
      externalInFlightRef.current.add(target);
      const generation = externalGenerationRef.current;
      setPendingTargets((current) => (current.includes(target) ? current : [...current, target]));
      try {
        const result = await actionService.dispatch(
          EXTERNAL_ACTIONS[target],
          { path: filePath },
          { source: "user" }
        );
        // The file (or panel) changed while this was in flight: the result
        // describes a file the pane no longer shows.
        if (externalGenerationRef.current !== generation) return;
        if (result.ok) {
          // Clears only its own failure — a sibling's banner stands until that
          // button's own retry succeeds.
          setExternalError((current) => (current?.target === target ? null : current));
          return;
        }
        logError(`[FilePane] ${EXTERNAL_ACTIONS[target]} failed`, result.error);
        setExternalError({ message: result.error.message, target });
      } finally {
        // Releasing in `finally` keeps a rejection from wedging the button; the
        // generation check leaves a reset's clean slate alone.
        if (externalGenerationRef.current === generation) {
          externalInFlightRef.current.delete(target);
          setPendingTargets((current) => current.filter((t) => t !== target));
        }
      }
    },
    [filePath]
  );

  const isErrorTargetPending =
    externalError !== null && pendingTargets.includes(externalError.target);
  // Below the Doherty threshold a spinner is just a flash; `disabled` still
  // blocks a double submit from the first millisecond.
  const showRetrySpinner = useDohertyGate(isErrorTargetPending);

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
  const reveal = revealCopy();
  const errorCopy = externalError ? externalTargetCopy(externalError.target, reveal) : null;
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
          <FileViewerToolbar.IconButton label="Refresh" onClick={handleToolbarRefresh}>
            <SpinningIcon icon={RefreshCw} active={refreshingMode !== null} className="w-4 h-4" />
          </FileViewerToolbar.IconButton>
          {/* Reveal is always offered, even for a file the viewer can't render
              (oversized, unsupported video) — the OS file manager is then the
              only way forward. */}
          <FileViewerToolbar.IconButton
            label={reveal.label}
            onClick={() => void handleOpenExternal("reveal")}
          >
            <FolderOpen className="w-4 h-4" />
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
      {externalError && errorCopy && (
        <InlineStatusBanner
          icon={XCircle}
          title={errorCopy.errorTitle}
          description={externalError.message}
          severity="error"
          action={{
            id: "retry-open-external",
            label: "Retry",
            icon: RefreshCw,
            variant: "dangerFilled",
            loading: showRetrySpinner,
            disabled: isErrorTargetPending,
            onClick: () => void handleOpenExternal(externalError.target),
            ariaLabel: errorCopy.retryAriaLabel,
          }}
          onClose={() => setExternalError(null)}
          closeAriaLabel={errorCopy.dismissAriaLabel}
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
            {/* An unsupported format is deterministic — retrying the same
                extension can never succeed, so the action would be dead. */}
            {!isUnsupportedVideoFilePath(filePath) && !isUnsupportedAudioFilePath(filePath) && (
              <button
                type="button"
                onClick={() => loadFile(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
          </div>
        )}

        {filePath && viewMode !== "diff" && (loadState === "image" || loadState === "svg") && (
          <FileImagePreview
            filePath={filePath}
            rootPath={effectiveRootPath}
            alt={fileName ?? filePath}
            sanitizedSvg={loadState === "svg" ? sanitizedSvg : null}
            cacheBust={String(reloadNonce)}
            onError={() => {
              setErrorCode("NOT_FOUND");
              setLoadState("error");
            }}
            maxHeightClassName="max-h-full"
          />
        )}

        {filePath && viewMode !== "diff" && loadState === "video" && (
          <FileVideoPreview
            filePath={filePath}
            rootPath={effectiveRootPath}
            label={fileName ?? filePath}
            reloadKey={reloadNonce}
            onError={(error) => {
              // An allowlisted container can still hold a codec Chromium lacks;
              // name that instead of implying the file is missing.
              setErrorCode(error?.code ?? "BINARY_FILE");
              setErrorMessage(error?.title ?? "This video couldn't be played");
              setLoadState("error");
            }}
            maxHeightClassName="max-h-full"
          />
        )}

        {filePath && viewMode !== "diff" && loadState === "audio" && (
          <FileAudioPreview
            filePath={filePath}
            rootPath={effectiveRootPath}
            label={fileName ?? filePath}
            reloadKey={reloadNonce}
            onError={(error) => {
              // An allowlisted extension can still hold a codec Chromium lacks;
              // name that instead of implying the file is missing.
              setErrorCode(error?.code ?? "BINARY_FILE");
              setErrorMessage(error?.title ?? "This audio file couldn't be played");
              setLoadState("error");
            }}
          />
        )}

        {filePath && viewMode !== "diff" && loadState === "pdf" && (
          <FilePdfPreview
            filePath={filePath}
            rootPath={effectiveRootPath}
            label={fileName ?? filePath}
            reloadKey={reloadNonce}
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
