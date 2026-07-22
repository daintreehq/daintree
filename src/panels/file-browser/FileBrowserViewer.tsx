import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { CodeViewer } from "@/components/FileViewer/CodeViewer";
import { FileImagePreview } from "@/components/FileViewer/FileImagePreview";
import { ZoomableImage } from "@/components/FileViewer/ZoomableImage";
import { isImageFilePath, isSvgFilePath } from "@/components/FileViewer/filePreviewKinds";
import { MarkdownViewer } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import {
  FILE_READ_ERROR_MESSAGES,
  toFileReadErrorCode,
} from "@/components/FileViewer/fileReadErrors";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { logError } from "@/utils/logger";

export interface FileBrowserViewerProps {
  /** Absolute path of the selected file; null when nothing is selected. */
  filePath: string | null;
  /** Absolute worktree root — the containment root for reads and asset loads. */
  rootPath: string;
  /** File name, used for accessible labels. */
  fileName: string;
  /**
   * Changes once per refresh cycle — a live worktree change tick or an explicit
   * Refresh. Re-reads the open file, so an agent rewriting it in place is
   * reflected instead of leaving stale bytes on screen.
   */
  revision: string;
}

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "text"; content: string }
  | { status: "html"; content: string; previewUrl: string | null }
  | { status: "svg"; markup: string | null }
  | { status: "image" }
  | { status: "error"; message: string };

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
  revision,
}: FileBrowserViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "idle" });
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

  if (!filePath) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileText className="h-6 w-6" />}
          title="Nothing selected"
          description="Pick a file in the tree to read it here."
        />
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

    case "error":
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<FileText className="h-6 w-6" />}
            title="Can't show this file"
            description={state.message}
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

    case "html":
      return (
        <HtmlViewer previewUrl={state.previewUrl} reloadNonce={reloadNonce} title={fileName} />
      );

    case "text":
      return isMarkdownFilePath(filePath) ? (
        <MarkdownViewer
          content={state.content}
          filePath={filePath}
          rootPath={rootPath}
          viewMode="rendered"
          className="h-full"
        />
      ) : (
        <CodeViewer content={state.content} filePath={filePath} className="h-full" />
      );
  }
}
