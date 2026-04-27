import { useEffect, useEffectEvent, useCallback, useState, useRef, useMemo } from "react";
import type { ViewType } from "react-diff-view";
import { AppDialog } from "@/components/ui/AppDialog";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { CodeViewer } from "./CodeViewer";
import type { CodeViewerHandle } from "./CodeViewer";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import { ExternalLink, Copy, Check, Image as ImageIcon } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";

export interface FileViewerModalProps {
  isOpen: boolean;
  filePath: string;
  rootPath: string;
  branch?: string;
  initialLine?: number;
  initialCol?: number;
  diff?: string;
  defaultMode?: "view" | "diff";
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

  const hasDiff = Boolean(diff && diff.trim() && diff !== "NO_CHANGES");
  const [mode, setMode] = useState<ViewMode>(() => {
    if (isImageFile(filePath)) return "view";
    if (defaultMode) return defaultMode;
    return hasDiff && !initialLine ? "diff" : "view";
  });
  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const [viewType, setViewType] = useState<ViewType>("split");
  const [diffCopied, setDiffCopied] = useState(false);
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const codeViewerRef = useRef<CodeViewerHandle>(null);
  const hasSwitchedToDiffRef = useRef(false);

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
      requestRef.current = 0;
      hasSwitchedToDiffRef.current = false;
      const nextMode = defaultMode ?? (hasDiff && !initialLine ? "diff" : "view");
      setMode(nextMode);
      return;
    }

    const requestId = ++requestRef.current;
    setLoadState("loading");
    setErrorCode(null);
    hasSwitchedToDiffRef.current = false;

    if (imageFile && !svgFile) {
      setLoadState("image");
      return;
    }

    filesClient
      .read({ path: filePath, rootPath: effectiveRootPath })
      .then((result) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        if (result.ok) {
          if (svgFile) {
            const sanitized = sanitizeSvg(result.content);
            if (sanitized.ok) {
              setSanitizedSvg(sanitized.svg);
              setLoadState("svg");
            } else {
              setErrorCode("INVALID_PATH");
              setLoadState("error");
            }
          } else {
            setContent(result.content);
            setLoadState("loaded");
          }
        } else {
          setErrorCode(result.code);
          setLoadState("error");
        }
      })
      .catch(() => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        setErrorCode("INVALID_PATH");
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
      .catch((err) => console.error("[FileViewerModal] openInEditor failed:", err));
  }, [filePath, initialLine, initialCol]);

  const handleImageError = useCallback(() => {
    setErrorCode("NOT_FOUND");
    setLoadState("error");
  }, []);

  const handleOpenInImageViewer = useCallback(() => {
    actionService
      .dispatch("file.openImageViewer", { path: filePath }, { source: "user" })
      .catch((err) => console.error("[FileViewerModal] openImageViewer failed:", err));
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
        codeViewerRef.current?.openGotoLine();
      }
    };

    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, isImageMode, mode]);

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
                    : "text-muted-foreground hover:text-daintree-text disabled:opacity-40 disabled:cursor-not-allowed"
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
          {/* Split/Unified toggle — only visible in diff mode */}
          {mode === "diff" && hasDiff && (
            <div className="flex bg-daintree-sidebar rounded p-0.5">
              <button
                type="button"
                onClick={() => setViewType("split")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  viewType === "split"
                    ? "bg-daintree-border text-daintree-text"
                    : "text-muted-foreground hover:text-daintree-text"
                )}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => setViewType("unified")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  viewType === "unified"
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
                dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
              />
            )}
          </div>
        )}

        {!isImageMode && mode === "view" && (
          <>
            {loadState === "loading" && (
              <div className="flex items-center justify-center h-64">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Spinner size="lg" />
                  <span>Loading file...</span>
                </div>
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
          <DiffViewer diff={diff} filePath={filePath} viewType={viewType} rootPath={rootPath} />
        )}

        {!isImageMode && mode === "diff" && !diff && (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Spinner size="lg" />
              <span>Loading diff...</span>
            </div>
          </div>
        )}
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
