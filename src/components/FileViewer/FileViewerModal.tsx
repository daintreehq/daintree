import { useEffect, useEffectEvent, useCallback, useState, useRef, useMemo } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { CodeViewer } from "./CodeViewer";
import type { CodeViewerHandle } from "./CodeViewer";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import { ExternalLink, Copy, Check, Image as ImageIcon } from "lucide-react";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
import { logError } from "@/utils/logger";
import { usePreferencesStore } from "@/store/preferencesStore";

export interface FileViewerModalProps {
  isOpen: boolean;
  filePath: string;
  rootPath: string;
  branch?: string;
  initialLine?: number;
  initialCol?: number;
  diff?: string;
  defaultMode?: "view" | "diff";
  onRetryDiff?: () => void;
  onClose: () => void;
}

type ViewMode = "view" | "diff";
type LoadState = "loading" | "loaded" | "error" | "image" | "svg";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const SVG_EXTENSION = "svg";

function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) || ext === SVG_EXTENSION;
}

function isSvgFile(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === SVG_EXTENSION;
}

function buildDaintreeFileUrl(filePath: string, rootPath: string): string {
  return `daintree-file://load?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}

const ERROR_MESSAGES: Record<FileReadErrorCode, string> = {
  BINARY_FILE: "Binary file — cannot display",
  FILE_TOO_LARGE: "File too large to display (> 500 KB)",
  LFS_POINTER: "Git LFS pointer — run `git lfs pull` to download the file contents",
  NOT_FOUND: "File no longer exists",
  OUTSIDE_ROOT: "File is outside the project root",
  INVALID_PATH: "Invalid file path",
  PERMISSION: "Permission denied — you don't have access to this file",
};

export function FileViewerModal({
  isOpen,
  filePath,
  rootPath,
  branch,
  initialLine,
  initialCol,
  diff,
  defaultMode,
  onRetryDiff,
  onClose,
}: FileViewerModalProps) {
  // If the file is outside the project root, use its parent directory as the
  // effective root so that the daintree-file:// protocol and files.read IPC
  // containment checks pass.
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const fwdRoot = fwd(rootPath).replace(/\/$/, "") + "/";
  const effectiveRootPath = fwd(filePath).startsWith(fwdRoot)
    ? rootPath
    : filePath.substring(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))) || "/";

  const hasDiff = Boolean(diff && diff.trim() && diff !== "NO_CHANGES" && diff !== "ERROR");
  const [mode, setMode] = useState<ViewMode>(() => {
    if (isImageFile(filePath)) return "view";
    if (defaultMode) return defaultMode;
    return hasDiff && !initialLine ? "diff" : "view";
  });
  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const diffViewType = usePreferencesStore((s) => s.diffViewType);
  const setDiffViewType = usePreferencesStore((s) => s.setDiffViewType);
  const [diffCopied, setDiffCopied] = useState(false);
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const codeViewerRef = useRef<CodeViewerHandle>(null);
  const hasSwitchedToDiffRef = useRef(false);
  const diffViewerRef = useRef<HTMLDivElement>(null);
  // -1 sentinel: "no hunk navigated to yet". First `n` or `p` jumps to hunk 0.
  const currentHunkIndexRef = useRef<number>(-1);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number>(-1);
  const [hunkCount, setHunkCount] = useState<number>(0);
  const hunkRatiosRef = useRef<Map<number, number>>(new Map());
  const observerGenerationRef = useRef(0);
  const observerDisposedRef = useRef(false);

  const imageFile = isImageFile(filePath);
  const svgFile = isSvgFile(filePath);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  // Non-reactive: reads defaultMode/hasDiff/initialLine/imageFile/svgFile at call
  // time so the effect only re-runs on isOpen/filePath/effectiveRootPath changes.
  const loadFile = useEffectEvent(() => {
    if (!isOpen) {
      setContent(null);
      setLoadState("loading");
      setErrorCode(null);
      setDiffCopied(false);
      setSanitizedSvg(null);
      requestRef.current++;
      hasSwitchedToDiffRef.current = false;
      currentHunkIndexRef.current = -1;
      const nextMode = defaultMode ?? (hasDiff && !initialLine ? "diff" : "view");
      setMode(nextMode);
      return;
    }

    const requestId = ++requestRef.current;
    setLoadState("loading");
    setErrorCode(null);
    hasSwitchedToDiffRef.current = false;
    currentHunkIndexRef.current = -1;

    if (imageFile && !svgFile) {
      setLoadState("image");
      return;
    }

    filesClient
      .read({ path: filePath, rootPath: effectiveRootPath })
      .then(({ content: fileContent }) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        if (svgFile) {
          const sanitized = sanitizeSvg(fileContent);
          if (sanitized.ok) {
            setSanitizedSvg(sanitized.svg);
            setLoadState("svg");
          } else {
            setErrorCode("INVALID_PATH");
            setLoadState("error");
          }
        } else {
          setContent(fileContent);
          setLoadState("loaded");
        }
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        const code = isClientAppError(error) ? (error.code as FileReadErrorCode) : "INVALID_PATH";
        setErrorCode(code);
        setLoadState("error");
      });
  });
  useEffect(() => {
    void isOpen;
    void filePath;
    void effectiveRootPath;
    loadFile();
  }, [isOpen, filePath, effectiveRootPath]);

  // When diff arrives after mount (FileDiffModal async pattern), switch to diff mode once
  useEffect(() => {
    if (hasDiff && defaultMode === "diff" && !hasSwitchedToDiffRef.current) {
      hasSwitchedToDiffRef.current = true;
      setMode("diff");
    }
  }, [hasDiff, defaultMode]);

  const handleOpenInEditor = useCallback(() => {
    actionService
      .dispatch(
        "file.openInEditor",
        { path: filePath, line: initialLine, col: initialCol },
        { source: "user" }
      )
      .catch((err) => logError("[FileViewerModal] openInEditor failed", err));
  }, [filePath, initialLine, initialCol]);

  const handleImageError = useCallback(() => {
    setErrorCode("NOT_FOUND");
    setLoadState("error");
  }, []);

  const handleOpenInImageViewer = useCallback(() => {
    actionService
      .dispatch("file.openImageViewer", { path: filePath }, { source: "user" })
      .catch((err) => logError("[FileViewerModal] openImageViewer failed", err));
  }, [filePath]);

  const handleCopyDiff = useCallback(async () => {
    if (!hasDiff || !diff) return;
    try {
      await navigator.clipboard.writeText(diff);
      if (!isMountedRef.current) return;
      setDiffCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) setDiffCopied(false);
      }, 2000);
    } catch {
      // Silently fail
    }
  }, [hasDiff, diff]);

  const fileName = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;

  // Compute relative path by stripping rootPath prefix; guard against empty root
  const displayRoot = rootPath ? (rootPath.endsWith("/") ? rootPath : rootPath + "/") : null;
  const relativePath =
    displayRoot && filePath.startsWith(displayRoot) ? filePath.slice(displayRoot.length) : fileName;
  const relativeDir = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/") + 1)
    : "";

  const canShowView = loadState === "loaded" && content !== null;
  const isImageMode = loadState === "image" || loadState === "svg";

  const metadata = useMemo(() => {
    if (!canShowView || content === null) return null;
    const lineCount = content.split("\n").length;
    const byteSize = new TextEncoder().encode(content).byteLength;
    return { lineCount, sizeLabel: formatBytes(byteSize) };
  }, [canShowView, content]);

  // Route Cmd+F (daintree:find-in-panel) and Cmd+L to CodeViewer
  useEffect(() => {
    if (!isOpen || isImageMode || mode !== "view") return;

    const handleFindInPanel = () => {
      codeViewerRef.current?.openSearch();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        codeViewerRef.current?.openGotoLine();
      }
    };

    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isOpen, isImageMode, mode]);

  // Reset hunk index whenever the diff content changes — covers refresh-after-
  // commit and any other in-place diff swap that leaves filePath unchanged.
  useEffect(() => {
    currentHunkIndexRef.current = -1;
  }, [diff]);

  // Hunk navigation in diff mode: `n` → next hunk, `p` → previous hunk.
  // react-diff-view renders each hunk as <tbody class="diff-hunk">; scroll the
  // hunk into view with native scrollIntoView (CSS scroll-margin-top keeps the
  // hunk header clear of the sticky dialog chrome). Hunk index lives in a ref
  // so navigation does not re-render the heavy diff tree on every keystroke.
  useEffect(() => {
    if (!isOpen || mode !== "diff") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "p") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable)
      ) {
        return;
      }

      const container = diffViewerRef.current;
      if (!container) return;
      const hunks = container.querySelectorAll<HTMLElement>("tbody.diff-hunk");
      if (hunks.length === 0) return;

      e.preventDefault();

      const lastIndex = hunks.length - 1;
      const current = currentHunkIndexRef.current;
      let next: number;
      if (e.key === "n") {
        next = current < 0 ? 0 : Math.min(current + 1, lastIndex);
      } else {
        // `p` from the initial sentinel (-1) lands on the first hunk so the
        // user gets feedback either way before they've started navigating.
        next = current < 0 ? 0 : Math.max(current - 1, 0);
      }
      currentHunkIndexRef.current = next;
      setActiveHunkIndex(next);
      hunks[next]?.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, mode]);

  // IntersectionObserver tracks the most-visible hunk during free scrolling.
  // Observes tr:first-child (not tbody — table-row-group collapses to 0 height
  // in Chromium and races with layout). The observer is keyed on diffViewType
  // so split/unified toggles re-observe the new DOM.
  useEffect(() => {
    if (!isOpen || mode !== "diff" || !diff) {
      setActiveHunkIndex(-1);
      setHunkCount(0);
      return;
    }

    const container = diffViewerRef.current;
    if (!container) return;

    const hunks = container.querySelectorAll<HTMLElement>("tbody.diff-hunk");
    const count = hunks.length;
    setHunkCount(count);

    if (count <= 1) {
      setActiveHunkIndex(-1);
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const generation = ++observerGenerationRef.current;
    observerDisposedRef.current = false;
    hunkRatiosRef.current = new Map();

    const observer = new IntersectionObserver(
      (entries) => {
        if (observerDisposedRef.current) return;
        if (generation !== observerGenerationRef.current) return;

        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.hunkObserverIndex);
          if (Number.isNaN(idx)) continue;
          if (entry.intersectionRatio === 0) {
            hunkRatiosRef.current.delete(idx);
          } else {
            hunkRatiosRef.current.set(idx, entry.intersectionRatio);
          }
        }

        let bestIdx = -1;
        let bestRatio = -1;
        for (const [idx, ratio] of hunkRatiosRef.current) {
          if (ratio > bestRatio || (ratio === bestRatio && idx < bestIdx)) {
            bestRatio = ratio;
            bestIdx = idx;
          }
        }

        if (bestIdx >= 0) {
          setActiveHunkIndex(bestIdx);
          currentHunkIndexRef.current = bestIdx;
        }
      },
      { root: container, threshold: [0, 0.2, 0.4, 0.6, 0.8, 1.0] }
    );

    hunks.forEach((hunk, index) => {
      const firstRow = hunk.querySelector("tr:first-child");
      if (firstRow) {
        (firstRow as HTMLElement).dataset.hunkObserverIndex = String(index);
        observer.observe(firstRow);
      }
    });

    return () => {
      observerDisposedRef.current = true;
      observer.disconnect();
    };
  }, [isOpen, mode, diff, diffViewType]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="6xl"
      maxHeight="max-h-[90vh]"
      data-testid="file-viewer-dialog"
    >
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Tooltip>
            <AppDialog.Title className="text-sm font-medium min-w-0">
              <TooltipTrigger asChild>
                <span className="truncate cursor-default">
                  {branch && <span className="text-muted-foreground/70 mr-1.5">{branch}</span>}
                  {relativeDir && <span className="text-muted-foreground">{relativeDir}</span>}
                  <span className="text-daintree-text">{fileName}</span>
                </span>
              </TooltipTrigger>
            </AppDialog.Title>
            <TooltipContent side="bottom" className="max-w-lg break-all">
              {filePath}
            </TooltipContent>
          </Tooltip>

          {/* Show view/diff toggle only when both are potentially available */}
          {hasDiff && !imageFile && (canShowView || loadState !== "loading") && (
            <div className="flex bg-daintree-sidebar rounded p-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setMode("view")}
                disabled={!canShowView}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  mode === "view"
                    ? "bg-daintree-border text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                )}
              >
                View
              </button>
              <button
                type="button"
                onClick={() => setMode("diff")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  mode === "diff"
                    ? "bg-daintree-border text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text"
                )}
              >
                Diff
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Hunk position indicator — visible during free scroll and n/p nav */}
          {mode === "diff" && hunkCount > 1 && activeHunkIndex >= 0 && (
            <span
              data-testid="hunk-position-indicator"
              className="text-xs text-muted-foreground tabular-nums"
            >
              Hunk {activeHunkIndex + 1} of {hunkCount}
            </span>
          )}
          {/* Split/Unified toggle — only visible in diff mode */}
          {mode === "diff" && hasDiff && (
            <div className="flex bg-daintree-sidebar rounded p-0.5">
              <button
                type="button"
                onClick={() => setDiffViewType("split")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  diffViewType === "split"
                    ? "bg-daintree-border text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text"
                )}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => setDiffViewType("unified")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  diffViewType === "unified"
                    ? "bg-daintree-border text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text"
                )}
              >
                Unified
              </button>
            </div>
          )}

          {/* Copy diff — only visible in diff mode */}
          {mode === "diff" && hasDiff && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyDiff}
                  aria-label={diffCopied ? "Copied!" : "Copy diff to clipboard"}
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                >
                  {diffCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {diffCopied ? "Copied!" : "Copy diff to clipboard"}
              </TooltipContent>
            </Tooltip>
          )}

          {imageFile ? (
            <button
              type="button"
              onClick={handleOpenInImageViewer}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-daintree-text hover:bg-daintree-border rounded transition-colors"
              title="Open in image viewer"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Open in Image Viewer
            </button>
          ) : (
            <button
              type="button"
              onClick={handleOpenInEditor}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-daintree-text hover:bg-daintree-border rounded transition-colors"
              title="Open in editor"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in Editor
            </button>
          )}
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.BodyScroll className="p-0">
        {isImageMode && (
          <div className="flex items-center justify-center p-6 min-h-[300px]">
            {loadState === "image" && (
              <img
                key={filePath}
                src={buildDaintreeFileUrl(filePath, effectiveRootPath)}
                alt={fileName}
                className="max-w-full max-h-[70vh] object-contain rounded"
                draggable={false}
                onError={handleImageError}
              />
            )}
            {loadState === "svg" && sanitizedSvg && (
              <div
                className="max-w-full max-h-[70vh] overflow-auto [&>svg]:max-w-full [&>svg]:h-auto"
                dangerouslySetInnerHTML={{ __html: createTrustedHTML(sanitizedSvg) }}
              />
            )}
          </div>
        )}

        {!isImageMode && mode === "view" && (
          <>
            {loadState === "loading" && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading file">
                  <SkeletonBone className="h-5 w-1/3" />
                  <SkeletonText lines={15} />
                </Skeleton>
              </div>
            )}

            {loadState === "error" && errorCode && (
              <div className="flex flex-col items-center justify-center h-64 gap-3">
                <p className="text-sm text-muted-foreground">{ERROR_MESSAGES[errorCode]}</p>
                {imageFile ? (
                  <button
                    type="button"
                    onClick={handleOpenInImageViewer}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                    Open in Image Viewer
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleOpenInEditor}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in Editor
                  </button>
                )}
              </div>
            )}

            {loadState === "loaded" && content !== null && (
              <>
                {metadata && (
                  <div
                    data-testid="file-viewer-metadata"
                    className="px-3 py-1 border-b border-daintree-border text-xs text-muted-foreground font-mono"
                  >
                    {metadata.lineCount} lines · {metadata.sizeLabel} · UTF-8
                  </div>
                )}
                <CodeViewer
                  ref={codeViewerRef}
                  content={content}
                  filePath={filePath}
                  initialLine={initialLine}
                  className="min-h-[300px]"
                />
              </>
            )}
          </>
        )}

        {!isImageMode && mode === "diff" && diff && (
          <DiffViewer
            ref={diffViewerRef}
            diff={diff}
            filePath={filePath}
            viewType={diffViewType}
            rootPath={rootPath}
            onRetry={onRetryDiff}
          />
        )}

        {!isImageMode && mode === "diff" && !diff && (
          <div className="p-4 space-y-3">
            <Skeleton label="Loading diff">
              <SkeletonBone className="h-7 w-3/4" />
              <SkeletonText lines={8} />
            </Skeleton>
          </div>
        )}
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
