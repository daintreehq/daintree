import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { FolderOpen } from "@/components/icons";
import { actionService } from "@/services/ActionService";
import { CodeViewer } from "@/components/FileViewer/CodeViewer";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
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
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import {
  FILE_READ_ERROR_MESSAGES,
  toFileReadErrorCode,
} from "@/components/FileViewer/fileReadErrors";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import type { FileRenderMode } from "@shared/types/panel";
import { logError } from "@/utils/logger";

export interface FileBrowserViewerProps {
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
   * of `revision` the media branches can safely honour. Typed `number` rather
   * than `string | number` so handing it the merged `revision` (which also
   * carries the change tick) is a compile error, not a silent regression to
   * restarting playback on every background write.
   */
  surfaceRefreshNonce: number;
  /** Runs the pane's manual refresh — re-reads the tree and the open file. */
  onRefresh: () => void;
  /** Whether that refresh is still draining; spins the Refresh icon. */
  isRefreshing: boolean;
  /** Whether the tree sidebar is collapsed; drives the disclosure toggle's icon and state. */
  sidebarCollapsed: boolean;
  /** Opens/closes the tree sidebar. Owned by the pane, which persists the state. */
  onToggleSidebar: () => void;
  /**
   * id of the tree column the toggle discloses. Referenced by `aria-controls`
   * only while the column is mounted (open); the pane unmounts it when collapsed.
   */
  treeSidebarId: string;
}

/** Which external surface a toolbar action aims the current file at. */
type ExternalTarget = "reveal" | "editor";

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
  | { status: "error"; message: string };

// Markdown gets a Source/Rendered switch mirroring FilePane's toggle. Typed at
// the constant so the option values stay `FileRenderMode` rather than widening
// to `string`; a two-entry list only — the browser preview has no diff mode.
const MARKDOWN_MODE_OPTIONS: Array<{ value: FileRenderMode; label: string }> = [
  { value: "source", label: "Source" },
  { value: "rendered", label: "Rendered" },
];

/**
 * Read-only viewer beside the tree.
 *
 * Deliberately not a reuse of `FilePane`: that component renders its own
 * `ContentPanel` — header, controls, tabs — and nesting it inside the browser
 * panel would draw that chrome twice. What is shared is everything below the
 * chrome: the same leaf viewers, the same `files:read` path, the same error
 * copy, so a file looks identical in either surface.
 */
export function FileBrowserViewer({
  filePath,
  rootPath,
  fileName,
  relativePath,
  revision,
  surfaceRefreshNonce,
  onRefresh,
  isRefreshing,
  sidebarCollapsed,
  onToggleSidebar,
  treeSidebarId,
}: FileBrowserViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "idle" });
  // Sticky Source/Rendered choice for markdown, defaulting to the rendered view
  // this pane has always shown. Deliberately not reset on file change: a reader
  // paging through docs in source keeps source, mirroring FilePane (whose
  // per-panel mode also survives a file swap). Non-markdown files simply hide
  // the toggle, so a stale "source" never applies where it can't be honoured.
  const [markdownMode, setMarkdownMode] = useState<FileRenderMode>("rendered");
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
      setState({ status: "error", message: UNSUPPORTED_VIDEO_MESSAGE });
      return;
    }

    if (isUnsupportedAudioFilePath(filePath)) {
      setState({ status: "error", message: UNSUPPORTED_AUDIO_MESSAGE });
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
            setState({ status: "error", message: outcome.error });
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
          setState({
            status: "error",
            message: FILE_READ_ERROR_MESSAGES[toFileReadErrorCode(error.code)],
          });
          return;
        }
        logError("[fileBrowser] failed to read file", error);
        setState({ status: "error", message: "Couldn't read this file" });
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
  }, [filePath]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopyPath = useCallback(() => {
    if (!filePath || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(filePath)
      .then(() => {
        setPathCopied(true);
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setPathCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable — the tooltip simply never flips to Copied */
      });
  }, [filePath]);

  const handleExternalAction = useCallback(
    async (target: ExternalTarget) => {
      if (!filePath) return;
      if (externalInFlightRef.current.has(target)) return;
      externalInFlightRef.current.add(target);
      const generation = externalGenerationRef.current;
      setPendingTargets((current) => (current.includes(target) ? current : [...current, target]));
      try {
        const result = await actionService.dispatch(
          target === "reveal" ? "file.showItemInFolder" : "file.openInEditor",
          { path: filePath },
          { source: "user" }
        );
        if (externalGenerationRef.current !== generation) return;
        if (result.ok) {
          setExternalError((current) => (current?.target === target ? null : current));
          return;
        }
        logError(
          `[FileBrowserViewer] ${target === "reveal" ? "showItemInFolder" : "openInEditor"} failed`,
          result.error
        );
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

  // One persistent toolbar with the tree toggle as its first control, rendered
  // whether or not a file is selected: the toggle is the sidebar's only home
  // once collapsed, and the empty state has no toolbar of its own. Keeping a
  // single Root (rather than one per branch) preserves the toggle's DOM node
  // and keyboard focus across selection changes. `aria-controls` names the tree
  // region only while it's mounted — omitted when collapsed to avoid a dangling
  // reference. A static "Toggle file tree" label per the toggle-label rule; the
  // icon swap and `aria-expanded` carry the open/closed state.
  return (
    <>
      <FileViewerToolbar.Root>
        <FileViewerToolbar.IconButton
          label="Toggle file tree"
          expanded={!sidebarCollapsed}
          controls={sidebarCollapsed ? undefined : treeSidebarId}
          sidebarToggle
          onClick={onToggleSidebar}
          data-testid="file-browser-sidebar-toggle"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </FileViewerToolbar.IconButton>
        {filePath && (
          <>
            {isMarkdownFilePath(filePath) && (
              <SegmentedToggle<FileRenderMode>
                options={MARKDOWN_MODE_OPTIONS}
                value={markdownMode}
                onChange={setMarkdownMode}
              />
            )}
            <FileViewerToolbar.Path
              path={relativePath ?? fileName}
              copied={pathCopied}
              onCopy={handleCopyPath}
            />
          </>
        )}
        {/* Outside the `filePath` gate, unlike the actions below it: Refresh
            re-reads the tree as well as the open file, and a workspace-rooted
            browser has no change tick at all (#11482), so a collapsed sidebar
            with nothing selected would otherwise offer no way to refresh
            anything. */}
        <FileViewerToolbar.Actions>
          {/* Only while the tree column is collapsed away. Its header owns the
              Refresh the rest of the time, and two identical buttons in one
              panel would read as two different actions — the same
              one-home-per-control rule that keeps the two disclosure toggles in
              each other's columns (#11496). */}
          {sidebarCollapsed && (
            <FileViewerToolbar.IconButton label="Refresh" onClick={onRefresh}>
              <SpinningIcon icon={RefreshCw} active={isRefreshing} className="h-4 w-4" />
            </FileViewerToolbar.IconButton>
          )}
          {filePath && (
            <>
              <FileViewerToolbar.IconButton
                label={reveal.label}
                onClick={() => void handleExternalAction("reveal")}
              >
                <FolderOpen className="h-4 w-4" />
              </FileViewerToolbar.IconButton>
              <FileViewerToolbar.IconButton
                label="Open in editor"
                onClick={() => void handleExternalAction("editor")}
              >
                <ExternalLink className="h-4 w-4" />
              </FileViewerToolbar.IconButton>
            </>
          )}
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      {filePath && externalError && (
        <InlineStatusBanner
          icon={XCircle}
          severity="error"
          title={externalError.target === "reveal" ? reveal.errorTitle : "Couldn't open in editor"}
          description={externalError.message}
          action={{
            id: "retry-external-action",
            label: "Retry",
            icon: RefreshCw,
            variant: "dangerFilled",
            loading: showRetrySpinner,
            disabled: isErrorTargetPending,
            onClick: () => void handleExternalAction(externalError.target),
            ariaLabel:
              externalError.target === "reveal" ? reveal.retryAriaLabel : "Retry opening in editor",
          }}
          onClose={() => setExternalError(null)}
          closeAriaLabel={
            externalError.target === "reveal"
              ? "Dismiss file manager error"
              : "Dismiss editor error"
          }
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {filePath ? (
          renderBody()
        ) : (
          // flex-1 + min-h-0, not h-full: below the now-persistent toolbar a
          // 100%-height body would overflow the viewer column.
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<FileText className="h-6 w-6" />}
              title="Nothing selected"
              description="Pick a file in the tree to read it here."
              className="w-full"
            />
          </div>
        )}
      </div>
    </>
  );

  function renderBody() {
    // Narrows `filePath` for this closure — the caller only reaches here through
    // the truthy `filePath` branch above, but that narrowing doesn't flow into a
    // nested function.
    if (!filePath) return null;
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

      case "error":
        return (
          <div className="flex h-full w-full items-center justify-center p-6">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<FileText className="h-6 w-6" />}
              title="Can't show this file"
              description={state.message}
              className="w-full"
            />
          </div>
        );

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
            onError={() => setState({ status: "error", message: "Couldn't load this image" })}
          />
        );

      case "svg":
        return (
          <div className="h-full w-full overflow-auto">
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
          <div className="h-full w-full overflow-auto">
            {/* Reloaded on `surfaceRefreshNonce`, never on `revision`: that
                ticks on every worktree write, and re-fetching would reset
                playback whenever an agent touches any file. Only a foreground
                refresh outranks continuity — pressing Refresh (#11586), or
                coming back to this project (#11588) — so only those pull the
                rewritten bytes. */}
            <FileVideoPreview
              filePath={filePath}
              rootPath={rootPath}
              label={fileName}
              reloadKey={surfaceRefreshNonce}
              onError={(error) =>
                setState({
                  status: "error",
                  message: error?.title ?? "This video couldn't be played",
                })
              }
              maxHeightClassName="max-h-full"
            />
          </div>
        );

      case "audio":
        return (
          <div className="h-full w-full overflow-auto">
            {/* Same split as video above: a worktree write elsewhere must not
                restart the track someone is listening to, while Refresh
                still re-fetches it on demand. */}
            <FileAudioPreview
              filePath={filePath}
              rootPath={rootPath}
              label={fileName}
              reloadKey={surfaceRefreshNonce}
              onError={(error) =>
                setState({
                  status: "error",
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
          />
        );

      case "html":
        return (
          <HtmlViewer previewUrl={state.previewUrl} reloadNonce={reloadNonce} title={fileName} />
        );

      case "text":
        if (!isMarkdownFilePath(filePath)) {
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
        if (markdownMode === "source") {
          return (
            <MarkdownViewer
              content={state.content}
              filePath={filePath}
              rootPath={rootPath}
              viewMode={markdownMode}
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
              content={state.content}
              filePath={filePath}
              rootPath={rootPath}
              viewMode={markdownMode}
              cacheBust={revision}
              className="min-h-full"
            />
          </div>
        );
    }
  }
}
