import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  FileText,
  FileX,
  Folder,
  FolderTree,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  WrapText,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { CircleCheck, FolderOpen } from "@/components/icons";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { CodeViewer } from "@/components/FileViewer/CodeViewer";
import { FileEditorBanner } from "@/components/FileViewer/FileEditorBanner";
import {
  FileViewerToolbar,
  TOOLBAR_ICON_CLASS,
  useFileViewerToolbarCompact,
} from "@/components/FileViewer/FileViewerToolbar";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FileImagePreview } from "@/components/FileViewer/FileImagePreview";
import { ZoomableImage } from "@/components/FileViewer/ZoomableImage";
import { FileVideoPreview } from "@/components/FileViewer/FileVideoPreview";
import { FileAudioPreview } from "@/components/FileViewer/FileAudioPreview";
import { FilePdfPreview } from "@/components/FileViewer/FilePdfPreview";
import {
  isImageFilePath,
  isPdfFilePath,
  isSvgFilePath,
  isAudioFilePath,
  isUnsupportedAudioFilePath,
  isUnsupportedVideoFilePath,
  isVideoFilePath,
  UNSUPPORTED_AUDIO_MESSAGE,
  UNSUPPORTED_VIDEO_MESSAGE,
} from "@/components/FileViewer/filePreviewKinds";
import { MarkdownViewer } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import {
  MarkdownTextSizeControl,
  MarkdownTextSizeMenuItems,
} from "@/components/Markdown/MarkdownTextSizeControl";
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { toFileReadErrorCode } from "@/components/FileViewer/fileReadErrors";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { usePreferencesStore } from "@/store/preferencesStore";
import { FolderListingView } from "./FolderListingView";
import { FileBrowserViewOptions } from "./FileBrowserViewOptions";
import { FileBrowserHiddenStrip } from "./FileBrowserHiddenStrip";
import type {
  FileBrowserSortOrder,
  FileEntryLike,
  FolderListingRow,
  HiddenRowCounts,
} from "./fileBrowserTree";
import type { FolderListingStatus } from "./useFileBrowserTree";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { useFileEditor } from "@/registry/fileEditorRegistry";
import { useFileDocumentDraftText } from "@/store/fileDocumentStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { FileRenderMode } from "@shared/types/panel";
import { logError } from "@/utils/logger";
import type { WorkingTreeFileChange } from "@/lib/workingTreeDiff";
import { FileBrowserChangeSummary } from "./FileBrowserChangeSummary";
import { getFileTypeIcon } from "./fileTypeIcons";
import { basename, join } from "@shared/utils/path";
import type { MarkdownFontSize } from "@/store/preferencesStore";

export interface FileBrowserViewerProps {
  /** A governed project/worktree identity for plugin-contributed editor views. */
  editorContext?: { projectId: string; worktreePath: string | null; isFocused: boolean };
  /** Owning panel's id, so a mode chosen in one panel stays in that panel. */
  panelId: string;
  /** Absolute path of the selected file; null when nothing is selected. */
  filePath: string | null;
  /** Absolute worktree root — the containment root for reads and asset loads. */
  rootPath: string;
  /** File name, used for accessible labels. */
  fileName: string;
  /** Worktree-relative path shown in the toolbar's path pill. */
  relativePath: string | null;
  /**
   * Changes once per refresh cycle — a live worktree change tick or an explicit
   * Refresh. Re-reads the open file, so an agent rewriting it in place is
   * reflected instead of leaving stale bytes on screen.
   */
  revision: string;
  /**
   * Changes on a foreground refresh — pressing Refresh, or returning to this
   * project after it sat cached — never on an ambient worktree tick. The half
   * of `revision` the PDF frame can safely honour; media takes the narrower
   * `mediaReloadNonce` below. Typed `number` rather than `string | number` so
   * handing it the merged `revision` (which also carries the change tick) is a
   * compile error, not a silent regression to re-navigating the frame on every
   * background write.
   */
  surfaceRefreshNonce: number;
  /**
   * The media half of `surfaceRefreshNonce`, held back when the player on
   * screen is mid-playback (#12165). Split from it rather than gated inside it
   * so a stale playback flag can at worst skip a media re-fetch — never stall
   * the text re-read, the PDF re-navigation, or the reclassification that
   * brings a failed preview back.
   */
  mediaReloadNonce: number;
  /** Reports the media preview's play state up to the pane that owns the nonce above. */
  onMediaPlayingChange: (playing: boolean) => void;
  /** Runs the pane's manual refresh — re-reads the tree and the open file. */
  onRefresh: () => void;
  /** Whether that refresh is still draining; spins the Refresh icon. */
  isRefreshing: boolean;
  /** Collapses every expanded tree branch; disabled when none are open. */
  onCollapseAll: () => void;
  canCollapseAll: boolean;
  /** Whether the tree sidebar is collapsed; drives the disclosure toggle's icon and state. */
  sidebarCollapsed: boolean;
  /** Opens/closes the tree sidebar. Owned by the pane, which persists the state. */
  onToggleSidebar: () => void;
  /**
   * id of the tree column the toggle discloses. Referenced by `aria-controls`
   * only while the column is mounted (open); the pane unmounts it when collapsed.
   */
  treeSidebarId: string;
  /**
   * The worktree's changed files, churn-sorted, with worktree-relative paths.
   * Drives what fills the pane when nothing is selected.
   *
   * Three states, and the empty array is not the same as null: `null` means no
   * git status is available (a workspace root has no worktree behind it, and a
   * snapshot may not have arrived yet), while `[]` is a positive statement that
   * the worktree is clean. Collapsing them would report an unknown worktree as
   * clean, which is the one thing this pane must not do.
   */
  changedFiles: readonly WorkingTreeFileChange[] | null;
  /** Opens a file picked from the changed-files summary in this viewer. */
  onSelectChangedFile: (relativePath: string) => void;
  /**
   * Worktree-relative path of the selected *folder*, or null when the selection
   * is a file or nothing (#11620). Mutually exclusive with `filePath` — the
   * pane resolves the selection's kind once and hands over exactly one.
   */
  folderPath: string | null;
  /** Rows for `folderPath`'s contents; null when no folder is selected. */
  folderRows: FolderListingRow[] | null;
  /** Raw fetch state for `folderPath` — never anti-flicker gated (#10083). */
  folderStatus: FolderListingStatus;
  /** Whether the dotfile toggle is what's hiding this folder's entries. */
  folderHasHiddenDotfiles: boolean;
  /**
   * The selected folder's own hidden tally. Separate from `hiddenCounts`, which
   * describes the TREE: a folder can be listed here without being expanded in
   * the tree, and the tree's walk only descends through expanded branches, so
   * the two answer different questions about different row sets.
   */
  folderHiddenCounts: HiddenRowCounts;
  /** Turns the dotfile filter off; offered from the filtered-empty state. */
  onShowDotfiles: () => void;
  /**
   * Selecting an entry in the listing — a folder steps in, a file opens. The
   * listing's only click gesture; re-rooting and opening in a panel live in the
   * row's context menu and in the tree, which is why no activate/root callback
   * is threaded through here (see `FolderListingView`).
   */
  onSelectEntry: (path: string) => void;
  /** Menu items for a listing row's right-click menu — the tree's own callback. */
  rowContextMenu?: (row: FileEntryLike) => React.ReactNode;
  /** Absolute base the listing's relative paths hang off, for drags (#11576). */
  basePath: string;
  /** Current order for the tree and the listing; driven by the toolbar menu. */
  sort: FileBrowserSortOrder;
  onSortChange: (sort: FileBrowserSortOrder) => void;
  /**
   * The dotfile filter, handed down so the view-options menu this toolbar
   * renders while the tree is collapsed drives the same setting the tree
   * header's copy does. `onShowDotfiles` below stays separate: it is the
   * unconditional recovery an empty state offers, not a toggle.
   */
  hideDotfiles: boolean;
  onHideDotfilesChange: (hide: boolean) => void;
  hiddenCounts: HiddenRowCounts;
  /**
   * Worktree-relative path of a selected file that has since vanished from
   * disk — its parent was re-listed without it — or null. Mutually exclusive
   * with `filePath`, which resolves null for a path that no longer exists.
   */
  missingFilePath: string | null;
  /** Points the viewer at a folder's listing; the missing state's way out. */
  onShowFolder: (path: string) => void;
}

/** Toolbar sort menu entries, in menu order. */
/** Narrow a menu value back to a known key, falling back to the current one. */
/** Which external surface a toolbar action aims the current file at. */
// `default-app` is the PDF error state's way out (#12598): the OS default
// handler for the file's type, which is what `file.openInBrowser` opens.
type ExternalTarget = "reveal" | "editor" | "default-app";

const EXTERNAL_ACTIONS = {
  reveal: "file.showItemInFolder",
  editor: "file.openInEditor",
  "default-app": "file.openInBrowser",
} as const;

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "text"; content: string }
  | { status: "html"; content: string; previewUrl: string | null }
  | { status: "svg"; markup: string | null }
  | { status: "image" }
  | { status: "video" }
  | { status: "audio" }
  | { status: "pdf" }
  | { status: "error"; reason: UnavailableReason; message: string };

/**
 * Why a file can't be shown, kept structured past the read so the unavailable
 * state can say it in words and offer the way out that fits — rather than one
 * generic "Can't show this file" over a terse code.
 */
type UnavailableReason =
  | FileReadErrorCode
  | "UNSUPPORTED_MEDIA"
  | "MEDIA_FAILED"
  | "IMAGE_FAILED"
  | "SVG_REJECTED"
  | "PDF_FAILED"
  | "READ_FAILED";

// Markdown and HTML both get a Source/Rendered switch mirroring FilePane's
// toggle. Typed at the constant so the option values stay `FileRenderMode`
// rather than widening to `string`; a two-entry list only — no diff mode here.
const FILE_RENDER_MODE_OPTIONS: Array<{ value: FileRenderMode; label: string }> = [
  { value: "source", label: "Source" },
  { value: "rendered", label: "Rendered" },
];

/**
 * File viewer beside the tree, with optional plugin-contributed editing.
 *
 * Deliberately not a reuse of `FilePane`: that component renders its own
 * `ContentPanel` — header, controls, tabs — and nesting it inside the browser
 * panel would draw that chrome twice. What is shared is everything below the
 * chrome: the same leaf viewers, the same `files:read` path, the same error
 * copy, so a file looks identical in either surface.
 */
export function FileBrowserViewer({
  editorContext,
  panelId,
  filePath,
  rootPath,
  fileName,
  relativePath,
  revision,
  surfaceRefreshNonce,
  mediaReloadNonce,
  onMediaPlayingChange,
  onRefresh,
  isRefreshing,
  onCollapseAll,
  canCollapseAll,
  sidebarCollapsed,
  onToggleSidebar,
  treeSidebarId,
  changedFiles,
  onSelectChangedFile,
  folderPath,
  folderRows,
  folderStatus,
  folderHasHiddenDotfiles,
  folderHiddenCounts,
  onShowDotfiles,
  onSelectEntry,
  rowContextMenu,
  basePath,
  sort,
  onSortChange,
  hideDotfiles,
  onHideDotfilesChange,
  hiddenCounts,
  missingFilePath,
  onShowFolder,
}: FileBrowserViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "idle" });
  // The reader's explicit Source/Rendered choice, `null` until they touch the
  // toggle. Untouched, each renderable type opens on the default that suits it:
  // markdown is a document you read rendered, while HTML in a repo is code you
  // opened to read, and a page that renders near-blank otherwise looks like a
  // broken file (#12205). Once chosen the mode is sticky and shared across both
  // types, deliberately not reset on file change: a reader paging through docs
  // in source keeps source, mirroring FilePane (whose per-panel mode also
  // survives a file swap). Files that are neither simply hide the toggle, so a
  // stale mode never applies where it can't be honoured.
  const [explicitRenderMode, setExplicitRenderMode] = useState<FileRenderMode | "edit" | null>(
    null
  );
  const isMarkdown = filePath !== null && isMarkdownFilePath(filePath);
  const isHtml = filePath !== null && isHtmlFilePath(filePath);
  const isRenderable = isMarkdown || isHtml;
  const editor = useFileEditor(filePath ?? undefined);
  const pluginKnown = usePluginRuntimeStore((state) =>
    editor ? state.pluginMetaById.has(editor.registration.pluginId) : false
  );
  const draftText = useFileDocumentDraftText(panelId);
  const wrapLines = usePreferencesStore((state) => state.markdownWrapLines);
  const setWrapLines = usePreferencesStore((state) => state.setMarkdownWrapLines);
  const contentBytes = useMemo(
    () => (state.status === "text" ? new TextEncoder().encode(state.content).byteLength : null),
    [state]
  );
  const canEdit =
    !!editorContext &&
    !!editor &&
    pluginKnown &&
    (explicitRenderMode === "edit" ||
      draftText !== null ||
      (contentBytes !== null && contentBytes <= editor.registration.maxBytes));
  const renderMode =
    explicitRenderMode === "edit"
      ? canEdit
        ? "edit"
        : "source"
      : (explicitRenderMode ?? (isMarkdown ? "rendered" : "source"));
  const readerOptions = isRenderable
    ? FILE_RENDER_MODE_OPTIONS
    : [{ value: "source" as const, label: "Source" }];
  const renderOptions = canEdit
    ? [...readerOptions, { value: "edit" as const, label: "Edit" }]
    : readerOptions;
  const modeToggleRef = useRef<HTMLDivElement>(null);
  const previousMode = useRef(renderMode);
  useEffect(() => {
    if (
      previousMode.current === "edit" &&
      renderMode !== "edit" &&
      document.activeElement === document.body
    ) {
      modeToggleRef.current
        ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
    }
    previousMode.current = renderMode;
  }, [renderMode]);
  const [changeTick, setChangeTick] = useState(0);
  useEffect(() => setChangeTick((value) => value + 1), [revision]);
  // The panel id rides a sentinel because this component is not remounted per
  // panel: a tab group renders one unkeyed GridPanel for whichever tab is
  // active, so switching between two file browsers reuses this instance —
  // `FileBrowserPane` guards its cursor the same way, and for the same reason.
  // Adjusting state during render is React's documented alternative to an
  // effect here: it re-renders before paint, so the new panel's first file is
  // never briefly shown in the old panel's mode. Without it a Rendered choice
  // made in one panel would decide how the next panel's first file opens, and
  // an HTML file there would land on the very preview it is meant not to.
  const [modeOwnerPanelId, setModeOwnerPanelId] = useState(panelId);
  if (modeOwnerPanelId !== panelId) {
    setModeOwnerPanelId(panelId);
    setExplicitRenderMode(null);
  }
  // The same app-level reading size the file panel shows, so a document is the
  // size the reader last chose in whichever surface they opened it (#12134).
  const markdownFontSize = usePreferencesStore((state) => state.markdownFontSize);
  const setMarkdownFontSize = usePreferencesStore((state) => state.setMarkdownFontSize);
  // Bumped on every load so `HtmlViewer` re-navigates its sandboxed frame when
  // an agent rewrites the file underneath it.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Which file the state on screen belongs to. A re-read triggered by a listing
  // change is for the same file, so it must not clear what is already rendered.
  const shownPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!filePath || !rootPath) {
      shownPathRef.current = null;
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const isImage = isImageFilePath(filePath);
    const isSvg = isSvgFilePath(filePath);
    const isSameFile = shownPathRef.current === filePath;
    shownPathRef.current = filePath;

    // Raster images never round-trip their bytes through IPC — the
    // `daintree-file://` protocol serves them straight to the <img>.
    if (isImage && !isSvg) {
      setState({ status: "image" });
      return;
    }

    // Videos stream from the same protocol into a <video> element; the text
    // path would reject them with a misleading size/binary error.
    if (isVideoFilePath(filePath)) {
      setState({ status: "video" });
      return;
    }

    // Audio takes the same protocol-to-blob route as video.
    if (isAudioFilePath(filePath)) {
      setState({ status: "audio" });
      return;
    }

    // PDFs are framed from `daintree-pdf://` into Chromium's built-in viewer;
    // the text path would reject them as a binary file.
    if (isPdfFilePath(filePath)) {
      setState({ status: "pdf" });
      return;
    }

    // Formats Chromium can't decode get a truthful "can't play" message
    // instead of falling through to the text path's size cap.
    if (isUnsupportedVideoFilePath(filePath)) {
      setState({
        status: "error",
        reason: "UNSUPPORTED_MEDIA",
        message: UNSUPPORTED_VIDEO_MESSAGE,
      });
      return;
    }

    if (isUnsupportedAudioFilePath(filePath)) {
      setState({
        status: "error",
        reason: "UNSUPPORTED_MEDIA",
        message: UNSUPPORTED_AUDIO_MESSAGE,
      });
      return;
    }

    // Only the initial read of a file shows a skeleton. A background re-read
    // after a worktree change keeps the current content on screen until the new
    // bytes arrive — on a busy worktree the tick fires often, and blanking the
    // pane (losing scroll position with it) every time would make the viewer
    // unusable.
    if (!isSameFile) setState({ status: "loading" });
    const wantsHtmlPreview = isHtmlFilePath(filePath);

    void filesClient
      .read({ path: filePath, rootPath, ...(wantsHtmlPreview && { htmlPreview: true }) })
      .then((result) => {
        if (cancelled) return;
        setReloadNonce((nonce) => nonce + 1);
        if (isSvg) {
          // Sanitized here, never handed to the viewer raw: `FileImagePreview`
          // documents that its input must already be safe. A rejected SVG shows
          // the sanitizer's reason rather than a blank pane.
          const outcome = sanitizeSvg(result.content);
          if (!outcome.ok) {
            setState({ status: "error", reason: "SVG_REJECTED", message: outcome.error });
            return;
          }
          setState({ status: "svg", markup: outcome.svg });
          return;
        }
        if (wantsHtmlPreview) {
          setState({
            status: "html",
            content: result.content,
            previewUrl: result.htmlPreviewUrl ?? null,
          });
          return;
        }
        setState({ status: "text", content: result.content });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isClientAppError(error)) {
          setState({ status: "error", reason: toFileReadErrorCode(error.code), message: "" });
          return;
        }
        logError("[fileBrowser] failed to read file", error);
        setState({ status: "error", reason: "READ_FAILED", message: "" });
      });

    return () => {
      cancelled = true;
    };
    // `revision` is a dependency, not a value this effect reads: a committed
    // listing change means the open file may have been rewritten under the same
    // path, which no other dependency would notice.
  }, [filePath, rootPath, revision]);

  // Toolbar state — the path pill's copied flash and the external actions'
  // pending/error tracking. Reset when the file changes: a failure banner for
  // a file no longer on screen would aim its Retry at the wrong path.
  const [pathCopied, setPathCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [externalError, setExternalError] = useState<{
    message: string;
    target: ExternalTarget;
  } | null>(null);
  // Tracked per target, not as one flag: revealing successfully says nothing
  // about a missing editor, so the two must not clear or spin for each other.
  const [pendingTargets, setPendingTargets] = useState<readonly ExternalTarget[]>([]);
  const externalGenerationRef = useRef(0);
  // Synchronous re-entry guard: state can't stop a double-click in one tick.
  const externalInFlightRef = useRef<Set<ExternalTarget>>(new Set());

  useEffect(() => {
    externalGenerationRef.current += 1;
    externalInFlightRef.current.clear();
    setExternalError(null);
    setPendingTargets([]);
    setPathCopied(false);
  }, [filePath, folderPath]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // What the path pill names, absolute: the open file, else the listed folder,
  // else the file that vanished — the three things the pill can identify.
  const identityRelativePath = filePath
    ? (relativePath ?? fileName)
    : folderPath !== null
      ? folderPath
      : missingFilePath;
  const identityAbsolutePath =
    filePath ??
    (folderPath !== null
      ? join(basePath, folderPath)
      : missingFilePath !== null
        ? join(basePath, missingFilePath)
        : null);

  const handleCopyPath = useCallback(() => {
    if (!identityAbsolutePath || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(identityAbsolutePath)
      .then(() => {
        setPathCopied(true);
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setPathCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — the tooltip simply never flips to Copied */
      });
  }, [identityAbsolutePath]);

  const handleExternalAction = useCallback(
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
        if (externalGenerationRef.current !== generation) return;
        if (result.ok) {
          setExternalError((current) => (current?.target === target ? null : current));
          return;
        }
        logError(`[FileBrowserViewer] ${EXTERNAL_ACTIONS[target]} failed`, result.error);
        setExternalError({ message: result.error.message, target });
      } finally {
        // Releasing in `finally` keeps a rejection from wedging the button for
        // good; the generation check leaves a reset's clean slate alone.
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

  const reveal = revealCopy();
  const externalErrorCopy =
    externalError === null
      ? null
      : externalError.target === "reveal"
        ? {
            title: reveal.errorTitle,
            retry: reveal.retryAriaLabel,
            dismiss: "Dismiss file manager error",
          }
        : externalError.target === "default-app"
          ? {
              title: "Couldn't open in default app",
              retry: "Retry opening in default app",
              dismiss: "Dismiss default app error",
            }
          : {
              title: "Couldn't open in editor",
              retry: "Retry opening in editor",
              dismiss: "Dismiss editor error",
            };

  // Which external surface the toolbar's second action aims at. Text belongs in
  // the editor; media, PDFs and images open with whatever the OS uses for that
  // type; an HTML page opens in the browser, mirroring FilePane. Never the OS
  // default for an unknown or binary file — that handler may execute it.
  const openTarget: OpenTarget =
    filePath === null
      ? "editor"
      : isHtml
        ? "browser"
        : isImageFilePath(filePath) && !isSvgFilePath(filePath)
          ? "default-app"
          : isVideoFilePath(filePath) ||
              isAudioFilePath(filePath) ||
              isPdfFilePath(filePath) ||
              isUnsupportedVideoFilePath(filePath) ||
              isUnsupportedAudioFilePath(filePath)
            ? "default-app"
            : "editor";
  const openAction = OPEN_ACTION_COPY[openTarget];
  const runOpen = () =>
    void handleExternalAction(openTarget === "browser" ? "default-app" : openTarget);

  const identityIcon: LucideIcon = filePath
    ? getFileTypeIcon(fileName).Icon
    : folderPath !== null
      ? Folder
      : FileX;
  // The worktree root lists under "" — name it by its folder, not as a blank pill.
  const identityLabel =
    identityRelativePath === "" ? basename(basePath) : (identityRelativePath ?? undefined);

  // One persistent toolbar with the tree toggle as its first control, rendered
  // whether or not a file is selected: the toggle is the sidebar's only home
  // once collapsed, and the empty state has no toolbar of its own. Keeping a
  // single Root (rather than one per branch) preserves the toggle's DOM node
  // and keyboard focus across selection changes. `aria-controls` names the tree
  // region only while it's mounted — omitted when collapsed to avoid a dangling
  // reference. A static "Toggle file tree" label per the toggle-label rule; the
  // icon swap and `aria-expanded` carry the open/closed state.
  //
  // `compactBelow` is where the secondary actions fold into "More actions" so
  // the path pill keeps room for a file name. A row carrying the mode toggle
  // folds earlier, because that control alone takes ~120px.
  const showModeToggle = filePath !== null && (isRenderable || canEdit);
  return (
    <>
      <FileViewerToolbar.Root
        label="File viewer controls"
        compactBelow={showModeToggle ? COMPACT_BELOW_WITH_MODES : COMPACT_BELOW}
      >
        <FileViewerToolbar.IconButton
          label="Toggle file tree"
          expanded={!sidebarCollapsed}
          controls={sidebarCollapsed ? undefined : treeSidebarId}
          sidebarToggle
          onClick={onToggleSidebar}
          data-testid="file-browser-sidebar-toggle"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className={TOOLBAR_ICON_CLASS} />
          ) : (
            <PanelLeftClose className={TOOLBAR_ICON_CLASS} />
          )}
        </FileViewerToolbar.IconButton>
        {showModeToggle && (
          <div ref={modeToggleRef} className="contents">
            {/* Compact density: the toolbar's icon buttons are 26px, and the
                default 28px segment made every renderable file's row taller
                than every other file's. */}
            <SegmentedToggle<FileRenderMode | "edit">
              options={renderOptions}
              value={renderMode}
              onChange={setExplicitRenderMode}
              density="compact"
            />
          </div>
        )}
        {/* Identity for every subject the viewer can have — a file, a listed
            folder, or a file that has just been deleted — so the row always
            says what the body below it is about. */}
        {identityAbsolutePath !== null && (
          <FileViewerToolbar.Path
            path={identityLabel}
            icon={identityIcon}
            copyLabel={filePath || missingFilePath !== null ? "Copy file path" : "Copy folder path"}
            copied={pathCopied}
            onCopy={handleCopyPath}
          />
        )}
        {/* The right-aligned group, following whatever the viewer is showing:
            a list is sorted, a file gets its own actions, and Refresh appears
            only while the tree header that normally owns it is collapsed away.
            Sort and Refresh both sit outside the `filePath` gate that wraps the
            block above — each has a job in the no-selection layouts too. */}
        <FileViewerToolbar.Actions>
          {/* Everything that changes what the tree shows lives in one menu now
              (sort AND the dotfile filter), and it is owned by whichever column
              is rendering the tree's chrome. This copy appears only while the
              tree column is collapsed away, exactly like the Refresh below it,
              so there is precisely one view-options control in every layout.

              The old gate here was `!filePath`, which was wrong in a way the
              pixels made obvious: sort governs the TREE — `flattenTree` sorts
              every level — so opening a file, or collapsing the viewer, removed
              the only control for a setting that was still reordering the rows
              on screen. It also sat above "Changed files", a churn-sorted list
              it never governed at all, so the menu's own checkmarks contradicted
              the order underneath it. */}
          {sidebarCollapsed && (
            <FileBrowserViewOptions
              sort={sort}
              onSortChange={onSortChange}
              hideDotfiles={hideDotfiles}
              onHideDotfilesChange={onHideDotfilesChange}
              hiddenCounts={hiddenCounts}
              onRefresh={onRefresh}
              isRefreshing={isRefreshing}
              onCollapseAll={onCollapseAll}
              canCollapseAll={canCollapseAll}
              data-testid="file-browser-view-options"
            />
          )}
          {filePath && (
            <FileActions
              filePath={filePath}
              contents={state.status === "text" || state.status === "html" ? state.content : null}
              textSize={
                isMarkdown && renderMode === "rendered"
                  ? { value: markdownFontSize, onValueChange: setMarkdownFontSize }
                  : null
              }
              wrap={
                isMarkdown && renderMode === "source"
                  ? { value: wrapLines, onValueChange: setWrapLines }
                  : null
              }
              revealLabel={reveal.label}
              onReveal={() => void handleExternalAction("reveal")}
              openLabel={openAction.label}
              openIcon={openAction.icon}
              onOpen={runOpen}
            />
          )}
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      {filePath && editorContext && renderMode !== "edit" && state.status === "text" && (
        <FileEditorBanner
          key={`${panelId}:${filePath}`}
          filePath={filePath}
          content={state.content}
          onEdit={() => setExplicitRenderMode("edit")}
        />
      )}
      {filePath && externalError && externalErrorCopy && (
        <InlineStatusBanner
          icon={XCircle}
          severity="error"
          title={externalErrorCopy.title}
          description={externalError.message}
          action={{
            id: "retry-external-action",
            label: "Retry",
            icon: RefreshCw,
            variant: "dangerFilled",
            loading: showRetrySpinner,
            disabled: isErrorTargetPending,
            onClick: () => void handleExternalAction(externalError.target),
            ariaLabel: externalErrorCopy.retry,
          }}
          onClose={() => setExternalError(null)}
          closeAriaLabel={externalErrorCopy.dismiss}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* A selected folder outranks the idle body: the changed-files summary
            answers "nothing is selected", and a folder selection is a
            selection (#11620). */}
        {filePath
          ? renderBody()
          : missingFilePath !== null
            ? renderMissingBody(missingFilePath)
            : folderPath !== null
              ? renderFolderBody()
              : renderIdleBody()}
      </div>
    </>
  );

  /**
   * What fills the pane with nothing selected. The browser is opened to answer
   * "what did the agent just change in here", so on a dirty worktree that answer
   * is the body — not a placeholder apologising for the absence of one.
   */
  function renderIdleBody() {
    if (changedFiles !== null && changedFiles.length > 0) {
      return <FileBrowserChangeSummary changes={changedFiles} onSelect={onSelectChangedFile} />;
    }

    // flex-1 + min-h-0, not h-full: below the now-persistent toolbar a
    // 100%-height body would overflow the viewer column.
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {changedFiles === null ? (
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<FileText className="h-6 w-6" />}
            title="Nothing selected"
            description="Pick a file in the tree to read it here."
            className="w-full"
          />
        ) : (
          // A clean worktree is a finished state, not an empty one: the
          // `user-cleared` variant stays quiet and takes no action, since there
          // is nothing here the user failed to do.
          <EmptyState
            variant="user-cleared"
            scale="canvas"
            icon={<CircleCheck className="h-6 w-6" />}
            title="Worktree is clean"
            className="w-full"
          />
        )}
      </div>
    );
  }

  /**
   * The open file was deleted. Said plainly, in place, under the file's own
   * name in the toolbar — the alternative this replaced was the viewer quietly
   * swapping to the changed-files summary, which reads as the file never having
   * been open. The way out is the folder it lived in; a file at the root, which
   * has no folder row to show, gets Refresh in case it comes back.
   */
  function renderMissingBody(path: string) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return (
      <UnavailableState
        icon={FileX}
        title="This file was deleted"
        description={`${basename(path)} is no longer on disk.`}
        action={
          parent !== "" ? (
            <Button variant="subtle" size="sm" onClick={() => onShowFolder(parent)}>
              <Folder />
              Show folder
            </Button>
          ) : (
            <Button variant="subtle" size="sm" onClick={onRefresh}>
              <RefreshCw />
              Refresh
            </Button>
          )
        }
      />
    );
  }

  /**
   * The folder-selected state (#11620) — what a selected folder shows instead
   * of the same "Nothing selected" a bare panel shows.
   *
   * Branches on `folderStatus`, the raw fetch state, never on a Doherty-gated
   * flag: a gated boolean is false both before the gate opens and after the
   * data arrives, so branching on it renders "this folder is empty" for the
   * first 400ms of every load. The gate below decides only whether the skeleton
   * paints during a pending window — under 400ms this renders nothing at all,
   * which is the point.
   */
  function renderFolderBody() {
    if (folderPath === null) return null;
    const folderName = folderPath.split("/").pop() ?? folderPath;

    if (folderStatus === "error") {
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<FolderTree className="h-6 w-6" />}
            title="Can't show this folder"
            description="The folder couldn't be read. It may have been moved or deleted."
            action={
              <button
                type="button"
                onClick={onRefresh}
                className="text-xs underline underline-offset-2"
              >
                Retry
              </button>
            }
            className="w-full"
          />
        </div>
      );
    }

    // `== null`, so an absent value is treated the same as an explicit null:
    // "no rows yet" is the honest reading either way, and reaching `.length`
    // on it below would throw rather than degrade.
    if (folderStatus === "pending" || folderRows == null) {
      return (
        // Predictable shape (a column of rows), so a skeleton rather than a
        // spinner — and `Skeleton` carries the 400ms gate itself, so a listing
        // already in the cache shows nothing before the rows appear.
        <div className="p-3">
          <Skeleton label="Loading folder">
            <SkeletonText lines={10} />
          </Skeleton>
        </div>
      );
    }

    if (folderRows.length === 0) {
      // "Filtered" only when turning the dotfile toggle off would actually
      // reveal something here — otherwise the folder is genuinely empty, and
      // offering a control that changes nothing would be a dead end.
      const canRevealDotfiles = folderHasHiddenDotfiles;
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            variant={canRevealDotfiles ? "filtered-empty" : "zero-data"}
            scale="canvas"
            className="w-full"
            {...(canRevealDotfiles ? {} : { icon: <FolderTree className="h-6 w-6" /> })}
            title={
              canRevealDotfiles
                ? "Dotfiles are hidden here"
                : folderHiddenCounts.alwaysHidden > 0
                  ? "Everything here is on the always-hidden list"
                  : "Nothing in this folder yet"
            }
            {...(canRevealDotfiles || folderHiddenCounts.alwaysHidden > 0
              ? {}
              : { description: "Add a file to it and it'll show up here." })}
            action={
              canRevealDotfiles ? (
                <button
                  type="button"
                  onClick={onShowDotfiles}
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
        <FolderListingView
          rows={folderRows}
          onSelect={onSelectEntry}
          {...(rowContextMenu ? { rowContextMenu } : {})}
          basePath={basePath}
          label={`Contents of ${folderName}`}
        />
        {/* The same disclosure the tree gets, for the same reason. A listing
            showing `visible.ts` while silently dropping `.env` reads as a
            complete folder, and this surface is reachable with the tree column
            collapsed entirely — so the tree's own strip is not on screen to
            cover it. Keyed on this folder's tally rather than the tree's: a
            folder can be listed here without being expanded in the tree, and
            the tree's walk only descends through expanded branches. */}
        <FileBrowserHiddenStrip counts={folderHiddenCounts} onShowDotfiles={onShowDotfiles} />
      </>
    );
  }

  function renderBody() {
    // Narrows `filePath` for this closure — the caller only reaches here through
    // the truthy `filePath` branch above, but that narrowing doesn't flow into a
    // nested function.
    if (!filePath) return null;
    if (renderMode === "edit") {
      if (!canEdit || !editor || !editorContext) return null;
      return (
        <div className="h-full min-h-0 overflow-auto">
          <Suspense
            fallback={
              <div className="p-4">
                <Skeleton label="Loading editor">
                  <SkeletonText lines={10} />
                </Skeleton>
              </div>
            }
          >
            <editor.Component
              key={`${panelId}:${filePath}`}
              panelId={panelId}
              filePath={filePath}
              fileName={fileName}
              rootPath={rootPath}
              worktreePath={editorContext.worktreePath}
              projectId={editorContext.projectId}
              wrapLines={wrapLines}
              isFocused={editorContext.isFocused}
              changeTick={changeTick}
              onOpenExternalEditor={() => void handleExternalAction("editor")}
            />
          </Suspense>
        </div>
      );
    }
    switch (state.status) {
      case "idle":
      case "loading":
        return (
          // Predictable shape, so a skeleton rather than a spinner. `Skeleton`
          // carries the 400ms anti-flicker gate, so a fast local read shows
          // nothing at all.
          <div className="p-4">
            <Skeleton label="Loading file">
              <SkeletonBone className="h-6 w-1/2" />
              <SkeletonText lines={10} />
            </Skeleton>
          </div>
        );

      case "error": {
        const copy = unavailableCopy(state.reason, state.message);
        const action =
          copy.action === "open" ? (
            <Button variant="subtle" size="sm" onClick={runOpen}>
              <openAction.icon />
              {openAction.label}
            </Button>
          ) : copy.action === "reveal" ? (
            <Button variant="subtle" size="sm" onClick={() => void handleExternalAction("reveal")}>
              <FolderOpen />
              {reveal.label}
            </Button>
          ) : copy.action === "retry" ? (
            <Button variant="subtle" size="sm" onClick={onRefresh}>
              <RefreshCw />
              Retry
            </Button>
          ) : undefined;
        return (
          <UnavailableState
            icon={getFileTypeIcon(fileName).Icon}
            title={copy.title}
            description={copy.description}
            action={action}
          />
        );
      }

      case "image":
        return (
          // `cacheBust` rather than a new `key`: the protocol URL is otherwise
          // stable, so Chromium has no reason to refetch a rewritten image — but
          // remounting to force it would throw away the user's zoom and pan
          // mid-inspection. Changing the src reloads the bytes in place.
          <ZoomableImage
            filePath={filePath}
            rootPath={rootPath}
            alt={fileName}
            cacheBust={revision}
            onError={() => setState({ status: "error", reason: "IMAGE_FAILED", message: "" })}
          />
        );

      case "svg":
        return (
          <div className={MEDIA_STAGE_CLASS}>
            <FileImagePreview
              filePath={filePath}
              rootPath={rootPath}
              alt={fileName}
              sanitizedSvg={state.markup}
              maxHeightClassName="max-h-full"
            />
          </div>
        );

      case "video":
        return (
          <div className={MEDIA_STAGE_CLASS}>
            {/* Reloaded on `mediaReloadNonce`, never on `revision`: that ticks
                on every worktree write, and re-fetching would reset playback
                whenever an agent touches any file. Only a foreground refresh
                outranks continuity — pressing Refresh (#11586), or coming back
                to this project while nothing is playing (#11588, #12165) — so
                only those pull the rewritten bytes. */}
            <FileVideoPreview
              filePath={filePath}
              rootPath={rootPath}
              label={fileName}
              reloadKey={mediaReloadNonce}
              onPlayingChange={onMediaPlayingChange}
              onError={(error) =>
                setState({
                  status: "error",
                  reason: error?.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "MEDIA_FAILED",
                  message: error?.title ?? "This video couldn't be played",
                })
              }
              maxHeightClassName="max-h-full"
            />
          </div>
        );

      case "audio":
        return (
          <div className={MEDIA_STAGE_CLASS}>
            {/* Same split as video above: a worktree write elsewhere must not
                restart the track someone is listening to, while Refresh
                still re-fetches it on demand. */}
            <FileAudioPreview
              filePath={filePath}
              rootPath={rootPath}
              label={fileName}
              reloadKey={mediaReloadNonce}
              onPlayingChange={onMediaPlayingChange}
              onError={(error) =>
                setState({
                  status: "error",
                  reason: error?.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "MEDIA_FAILED",
                  message: error?.title ?? "This audio file couldn't be played",
                })
              }
            />
          </div>
        );

      case "pdf":
        return (
          // Same split as the video case: re-navigating the frame on every
          // worktree write would throw away the reader's page and zoom, so only
          // an explicit Refresh moves the key.
          <FilePdfPreview
            filePath={filePath}
            rootPath={rootPath}
            label={fileName}
            reloadKey={surfaceRefreshNonce}
            onError={(error) =>
              setState({
                status: "error",
                reason: error.code === "FILE_TOO_LARGE" ? "FILE_TOO_LARGE" : "PDF_FAILED",
                message: error.title,
              })
            }
          />
        );

      case "html":
        // Source is the same CodeViewer the non-markdown text branch uses, off
        // content the preview read already returned — switching modes never
        // costs a second read. A null previewUrl still renders HtmlViewer in
        // rendered mode rather than silently showing source: its empty state
        // says why and points at the Source segment, which now exists here.
        if (renderMode === "source") {
          return <CodeViewer content={state.content} filePath={filePath} className="h-full" />;
        }
        return (
          <HtmlViewer previewUrl={state.previewUrl} reloadNonce={reloadNonce} title={fileName} />
        );

      case "text":
        if (!isMarkdown) {
          return <CodeViewer content={state.content} filePath={filePath} className="h-full" />;
        }
        // Source mode was never part of #11441: CodeViewer's root is already a
        // scrollport, and at pane height it owns BOTH axes, so its horizontal
        // scrollbar stays pinned to the bottom of the visible pane. Letting it
        // grow to content height instead would hand the vertical axis to an
        // outer wrapper and strand the horizontal scrollbar below the fold —
        // lines here don't wrap (CodeViewer defaults `wrapLines` to false).
        // `min-h-0` only replaces MarkdownViewer's min-h-[300px] floor, which
        // used to overflow a preview shorter than 300px.
        if (renderMode === "source") {
          return (
            <MarkdownViewer
              content={state.content}
              filePath={filePath}
              rootPath={rootPath}
              viewMode={renderMode}
              wrapLines={wrapLines}
              className="h-full min-h-0"
            />
          );
        }
        return (
          // Rendered markdown is the bug: MarkdownDocument's root carries no
          // overflow class by design, and the viewer column above only clips,
          // so anything past the first screenful was unreachable (#11441).
          // Same local-wrapper idiom as the svg/video/audio branches.
          <div data-testid="file-browser-markdown-scroll" className="h-full w-full overflow-auto">
            {/* min-h-full, never h-full: a floor lets a tall document grow past
                the wrapper and scroll it, while a short one still fills the
                preview. h-full would clamp it and silently restore the bug. */}
            {/* `cacheBust` rather than a new `key`, for the same reason as the
                image branch above: remounting would throw away the reader's
                scroll position, while changing the image srcs reloads the
                bytes in place. Unlike video/audio/pdf there is no playback to
                interrupt (#11587). */}
            <MarkdownViewer
              content={draftText ?? state.content}
              filePath={filePath}
              rootPath={rootPath}
              viewMode={renderMode}
              fontSize={markdownFontSize}
              cacheBust={revision}
              className="min-h-full"
            />
          </div>
        );
    }
  }
}

/**
 * One stage for every preview kind the viewer centres: the preview sits in the
 * middle of the space the column gives it, the way the raster image and every
 * unavailable state already do. Top-anchored media left a video or an audio bar
 * pinned under the toolbar with the rest of the column empty, and the subject
 * moved every time the file type changed.
 */
const MEDIA_STAGE_CLASS = "flex h-full w-full items-center justify-center overflow-auto";

/** Row widths under which the secondary actions fold into "More actions". */
const COMPACT_BELOW = 360;
const COMPACT_BELOW_WITH_MODES = 560;

type OpenTarget = "editor" | "default-app" | "browser";

const OPEN_ACTION_COPY: Record<OpenTarget, { label: string; icon: LucideIcon }> = {
  editor: { label: "Open in editor", icon: ExternalLink },
  "default-app": { label: "Open in default app", icon: ExternalLink },
  browser: { label: "Open in browser", icon: Globe },
};

interface UnavailableCopy {
  title: string;
  description: string;
  /** The way out the body offers, beyond the toolbar's own actions. */
  action: "open" | "reveal" | "retry" | null;
}

/**
 * What an unavailable file says, per cause: a title naming what happened, a
 * line saying what to do instead, and the one action that does it. The open
 * action follows the toolbar's own target for the file's type, so "open" means
 * the editor for text and the OS default app for media — never the OS default
 * for a binary, which may execute it; a binary gets Reveal.
 */
function unavailableCopy(reason: UnavailableReason, message: string): UnavailableCopy {
  switch (reason) {
    case "BINARY_FILE":
      return {
        title: "Binary file",
        description: "It can't be shown as text. Reveal it to open it with another app.",
        action: "reveal",
      };
    case "FILE_TOO_LARGE":
      return {
        title: "Too large to preview",
        description: "It's over the size this viewer opens. Open it outside Daintree instead.",
        action: "open",
      };
    case "LFS_POINTER":
      return {
        title: "Git LFS pointer",
        description: "Run `git lfs pull` to download the file's contents, then refresh.",
        action: "retry",
      };
    case "NOT_FOUND":
      return {
        title: "This file was deleted",
        description: "It's no longer on disk.",
        action: "retry",
      };
    case "PERMISSION":
      return {
        title: "No permission to read this file",
        description: "Reveal it to check its permissions.",
        action: "reveal",
      };
    case "OUTSIDE_ROOT":
      return {
        title: "Outside this worktree",
        description: "The file resolves to a location outside the folder being browsed.",
        action: "reveal",
      };
    case "NOT_A_FILE":
      return {
        title: "This is a folder",
        description: "Refresh to show its contents.",
        action: "retry",
      };
    case "INVALID_PATH":
      return {
        title: "Couldn't read this file",
        description: "Its path isn't valid.",
        action: "reveal",
      };
    case "UNSUPPORTED_MEDIA":
      return { title: "Can't play this format", description: message, action: "open" };
    case "MEDIA_FAILED":
      return {
        title: message || "Couldn't play this file",
        description: "Open it in your default app to play it.",
        action: "open",
      };
    case "IMAGE_FAILED":
      return {
        title: "Couldn't load this image",
        description: "It may be damaged, or in a format that can't be decoded here.",
        action: "open",
      };
    case "SVG_REJECTED":
      return { title: "Can't preview this SVG", description: message, action: "open" };
    case "PDF_FAILED":
      return {
        title: message || "This PDF couldn't be displayed",
        description: "Open it in your default app to read it.",
        action: "open",
      };
    case "READ_FAILED":
      return {
        title: "Couldn't read this file",
        description: "Something went wrong reading it from disk.",
        action: "retry",
      };
  }
}

/**
 * The body for every file the viewer can't show, and for a file that vanished.
 * A polite status region, so the change is announced without moving focus
 * (WCAG 4.1.3): selecting a binary in the tree otherwise reads as nothing
 * having happened at all.
 */
function UnavailableState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full w-full items-center justify-center p-6"
      data-testid="file-browser-unavailable"
    >
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<Icon className="h-6 w-6" />}
        title={title}
        description={description}
        action={action}
        className="w-full"
      />
    </div>
  );
}

/**
 * The file's own actions, laid out as buttons at width and folded into one
 * "More actions" menu once the row is compact — so at a narrow width the path
 * pill keeps its file name instead of giving it up to a row of icons. A
 * component rather than inline JSX because the compact flag comes from the
 * toolbar's context, which is only readable inside `Root`.
 */
function FileActions({
  filePath,
  contents,
  textSize,
  wrap,
  revealLabel,
  onReveal,
  openLabel,
  openIcon: OpenIcon,
  onOpen,
}: {
  filePath: string;
  contents: string | null;
  textSize: { value: MarkdownFontSize; onValueChange: (value: MarkdownFontSize) => void } | null;
  wrap: { value: boolean; onValueChange: (value: boolean) => void } | null;
  revealLabel: string;
  onReveal: () => void;
  openLabel: string;
  openIcon: LucideIcon;
  onOpen: () => void;
}) {
  const compact = useFileViewerToolbarCompact();

  if (compact) {
    return (
      <FileViewerToolbar.MoreActions data-testid="file-browser-more-actions">
        {textSize && (
          <>
            <MarkdownTextSizeMenuItems
              value={textSize.value}
              onValueChange={textSize.onValueChange}
            />
            <DropdownMenuSeparator />
          </>
        )}
        {wrap && (
          <>
            <DropdownMenuCheckboxItem
              checked={wrap.value}
              onCheckedChange={(checked) => wrap.onValueChange(checked)}
            >
              Wrap long lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        {contents !== null && (
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard?.writeText(contents).catch(() => {});
            }}
          >
            <Copy className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
            Copy file contents
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onReveal}>
          <FolderOpen className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
          {revealLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpen}>
          <OpenIcon className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
          {openLabel}
        </DropdownMenuItem>
      </FileViewerToolbar.MoreActions>
    );
  }

  return (
    <>
      {/* Rendered markdown only: source is CodeMirror, which this scale does
          not reach, and every other preview kind has no prose to tune. Sits
          ahead of the file actions so the controls that change what you are
          looking at stay left of the ones that leave. */}
      {textSize && (
        <MarkdownTextSizeControl
          value={textSize.value}
          onValueChange={textSize.onValueChange}
          data-testid="file-browser-text-size"
        />
      )}
      {/* Source markdown's own reading control, the mirror of text size above —
          the same toggle, on the same preference, as the file panel's. */}
      {wrap && (
        <FileViewerToolbar.IconButton
          label="Wrap long lines"
          pressed={wrap.value}
          onClick={() => wrap.onValueChange(!wrap.value)}
        >
          <WrapText className={TOOLBAR_ICON_CLASS} />
        </FileViewerToolbar.IconButton>
      )}
      {/* Same control, same order as FilePane's action group. Raw text only:
          `svg` keeps sanitized markup rather than the source it was built
          from, and every media/error state carries none at all. */}
      <FileViewerToolbar.CopyContentsButton key={filePath} contents={contents} />
      <FileViewerToolbar.IconButton label={revealLabel} onClick={onReveal}>
        <FolderOpen className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
      <FileViewerToolbar.IconButton label={openLabel} onClick={onOpen}>
        <OpenIcon className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
    </>
  );
}
