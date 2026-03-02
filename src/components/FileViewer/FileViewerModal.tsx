import { useEffect, useCallback, useState, useRef } from "react";
import type { ViewType } from "react-diff-view";
import { AppDialog } from "@/components/ui/AppDialog";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { CodeViewer } from "./CodeViewer";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import { ExternalLink, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import type { FileReadErrorCode } from "@shared/types/ipc/files";

export interface FileViewerModalProps {
  isOpen: boolean;
  filePath: string;
  rootPath: string;
  initialLine?: number;
  initialCol?: number;
  diff?: string;
  defaultMode?: "view" | "diff";
  onClose: () => void;
}

type ViewMode = "view" | "diff";
type LoadState = "loading" | "loaded" | "error";

const ERROR_MESSAGES: Record<FileReadErrorCode, string> = {
  BINARY_FILE: "Binary file — cannot display",
  FILE_TOO_LARGE: "File too large to display (> 500 KB)",
  NOT_FOUND: "File no longer exists",
  OUTSIDE_ROOT: "File is outside the project root",
  INVALID_PATH: "Invalid file path",
};

export function FileViewerModal({
  isOpen,
  filePath,
  rootPath,
  initialLine,
  initialCol,
  diff,
  defaultMode,
  onClose,
}: FileViewerModalProps) {
  const hasDiff = Boolean(diff && diff.trim() && diff !== "NO_CHANGES");
  const [mode, setMode] = useState<ViewMode>(() => {
    if (defaultMode) return defaultMode;
    return hasDiff && !initialLine ? "diff" : "view";
  });
  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const [viewType, setViewType] = useState<ViewType>("split");
  const [diffCopied, setDiffCopied] = useState(false);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setContent(null);
      setLoadState("loading");
      setErrorCode(null);
      setDiffCopied(false);
      requestRef.current = 0;
      const nextMode = defaultMode ?? (hasDiff && !initialLine ? "diff" : "view");
      setMode(nextMode);
      return;
    }

    const requestId = ++requestRef.current;
    setLoadState("loading");
    setErrorCode(null);

    filesClient
      .read({ path: filePath, rootPath })
      .then((result) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        if (result.ok) {
          setContent(result.content);
          setLoadState("loaded");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filePath, rootPath]);

  // When diff arrives after mount (FileDiffModal async pattern), switch to diff mode if default is diff
  useEffect(() => {
    if (hasDiff && defaultMode === "diff" && mode !== "diff") {
      setMode("diff");
    }
  }, [hasDiff, defaultMode, mode]);

  const handleOpenInEditor = useCallback(() => {
    actionService
      .dispatch(
        "file.openInEditor",
        { path: filePath, line: initialLine, col: initialCol },
        { source: "user" }
      )
      .catch((err) => console.error("[FileViewerModal] openInEditor failed:", err));
  }, [filePath, initialLine, initialCol]);

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

  const fileName = filePath.split("/").pop() || filePath;
  const dirPart = filePath.replace(fileName, "");

  const canShowView = loadState === "loaded" && content !== null;

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="6xl" maxHeight="max-h-[90vh]">
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-3 min-w-0">
          <AppDialog.Title className="text-sm font-medium truncate">
            <span className="text-muted-foreground">{dirPart}</span>
            <span className="text-canopy-text">{fileName}</span>
          </AppDialog.Title>

          {/* Show view/diff toggle only when both are potentially available */}
          {hasDiff && (canShowView || loadState !== "loading") && (
            <div className="flex bg-canopy-sidebar rounded p-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setMode("view")}
                disabled={!canShowView}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  mode === "view"
                    ? "bg-canopy-border text-canopy-text"
                    : "text-muted-foreground hover:text-canopy-text disabled:opacity-40 disabled:cursor-not-allowed"
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
                    ? "bg-canopy-border text-canopy-text"
                    : "text-muted-foreground hover:text-canopy-text"
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
            <div className="flex bg-canopy-sidebar rounded p-0.5">
              <button
                type="button"
                onClick={() => setViewType("split")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded transition-colors",
                  viewType === "split"
                    ? "bg-canopy-border text-canopy-text"
                    : "text-muted-foreground hover:text-canopy-text"
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
                    ? "bg-canopy-border text-canopy-text"
                    : "text-muted-foreground hover:text-canopy-text"
                )}
              >
                Unified
              </button>
            </div>
          )}

          {/* Copy diff — only visible in diff mode */}
          {mode === "diff" && hasDiff && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyDiff}
                    aria-label={diffCopied ? "Copied!" : "Copy diff to clipboard"}
                    className="p-1.5 rounded transition-colors text-muted-foreground hover:text-canopy-text hover:bg-canopy-border"
                  >
                    {diffCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {diffCopied ? "Copied!" : "Copy diff to clipboard"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <button
            type="button"
            onClick={handleOpenInEditor}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground hover:text-canopy-text hover:bg-canopy-border rounded transition-colors"
            title="Open in editor"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Editor
          </button>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.BodyScroll className="p-0">
        {mode === "view" && (
          <>
            {loadState === "loading" && (
              <div className="flex items-center justify-center h-64">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>Loading file...</span>
                </div>
              </div>
            )}

            {loadState === "error" && errorCode && (
              <div className="flex flex-col items-center justify-center h-64 gap-3">
                <p className="text-sm text-muted-foreground">{ERROR_MESSAGES[errorCode]}</p>
                <button
                  type="button"
                  onClick={handleOpenInEditor}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-canopy-text bg-canopy-border hover:bg-canopy-border/80 rounded transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open in Editor
                </button>
              </div>
            )}

            {loadState === "loaded" && content !== null && (
              <CodeViewer
                content={content}
                filePath={filePath}
                initialLine={initialLine}
                className="min-h-[300px]"
              />
            )}
          </>
        )}

        {mode === "diff" && diff && (
          <DiffViewer diff={diff} filePath={filePath} viewType={viewType} />
        )}

        {mode === "diff" && !diff && (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-3 text-muted-foreground">
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Loading diff...</span>
            </div>
          </div>
        )}
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
