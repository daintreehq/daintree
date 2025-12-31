import { useEffect, useCallback, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { cn } from "@/lib/utils";
import { DiffViewer } from "./DiffViewer";
import type { ViewType } from "react-diff-view";
import type { GitStatus } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { Copy, Check } from "lucide-react";
import { useNotificationStore } from "@/store/notificationStore";

export interface FileDiffModalProps {
  isOpen: boolean;
  filePath: string;
  status: GitStatus;
  worktreePath: string;
  onClose: () => void;
}

type LoadingState = "loading" | "loaded" | "error";

export function FileDiffModal({
  isOpen,
  filePath,
  status,
  worktreePath,
  onClose,
}: FileDiffModalProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [viewType, setViewType] = useState<ViewType>("split");
  const [diffCopied, setDiffCopied] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const addNotification = useNotificationStore((state) => state.addNotification);

  const fetchDiff = useCallback(async () => {
    setLoadingState("loading");
    setError(null);

    try {
      const result = await actionService.dispatch(
        "git.getFileDiff",
        { cwd: worktreePath, filePath, status },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const diffResult = result.result as string;

      if (!diffResult || !diffResult.trim()) {
        setDiff("NO_CHANGES");
      } else {
        setDiff(diffResult);
      }
      setLoadingState("loaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diff");
      setLoadingState("error");
    }
  }, [worktreePath, filePath, status]);

  useEffect(() => {
    if (!isOpen) {
      setDiff(null);
      setLoadingState("loading");
      setError(null);
      setDiffCopied(false);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      return;
    }

    setDiffCopied(false);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }

    let cancelled = false;

    async function fetchDiffWithCancel() {
      await fetchDiff();
      if (cancelled) return;
    }

    fetchDiffWithCancel();

    return () => {
      cancelled = true;
    };
  }, [isOpen, fetchDiff]);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 100);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  const isValidDiffContent =
    diff !== null &&
    diff !== "NO_CHANGES" &&
    diff !== "BINARY_FILE" &&
    diff !== "FILE_TOO_LARGE" &&
    diff.trim() !== "";

  const handleCopyDiff = async () => {
    if (!isValidDiffContent || !diff) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(diff);
      } else {
        throw new Error("Clipboard API not available");
      }

      if (!isMountedRef.current) return;

      setDiffCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setDiffCopied(false);
          copyTimeoutRef.current = null;
        }
      }, 2000);
    } catch (err) {
      console.error("Failed to copy diff:", err);
      addNotification({
        type: "error",
        title: "Copy Failed",
        message: err instanceof Error ? err.message : "Failed to copy diff to clipboard",
        duration: 5000,
      });
    }
  };

  const fileName = filePath.split("/").pop() || filePath;
  const statusInfo = getStatusInfo(status);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="6xl" maxHeight="max-h-[90vh]">
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={cn(
              "flex-shrink-0 px-2 py-0.5 text-xs font-bold rounded",
              statusInfo.bgColor,
              statusInfo.textColor
            )}
          >
            {statusInfo.label}
          </span>

          <AppDialog.Title className="text-sm font-medium truncate">
            <span className="text-muted-foreground">{filePath.replace(fileName, "")}</span>
            <span className="text-canopy-text">{fileName}</span>
          </AppDialog.Title>
        </div>

        <div className="flex items-center gap-2">
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

          <button
            type="button"
            onClick={handleCopyDiff}
            disabled={loadingState !== "loaded" || !isValidDiffContent}
            aria-label={diffCopied ? "Copied!" : "Copy diff to clipboard"}
            title={diffCopied ? "Copied!" : "Copy diff to clipboard"}
            className={cn(
              "p-1.5 rounded transition-colors",
              loadingState !== "loaded" || !isValidDiffContent
                ? "text-muted-foreground/50 cursor-not-allowed"
                : "text-muted-foreground hover:text-canopy-text hover:bg-canopy-border"
            )}
          >
            {diffCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span className="sr-only" role="status" aria-live="polite">
              {diffCopied ? "Copied to clipboard" : ""}
            </span>
          </button>

          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <AppDialog.BodyScroll className="p-0">
        {loadingState === "loading" && (
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

        {loadingState === "error" && (
          <div className="flex flex-col items-center justify-center h-64 text-[var(--color-status-error)]">
            <svg className="w-8 h-8 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-sm mb-3">{error || "Failed to load diff"}</p>
            <Button
              onClick={() => fetchDiff()}
              variant="ghost"
              size="sm"
              className="text-canopy-text hover:bg-canopy-border"
            >
              Retry
            </Button>
          </div>
        )}

        {loadingState === "loaded" && diff && (
          <DiffViewer diff={diff} filePath={filePath} viewType={viewType} />
        )}
      </AppDialog.BodyScroll>

      <AppDialog.Footer>
        <Button ref={closeButtonRef} variant="ghost" onClick={onClose}>
          Close
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}

function getStatusInfo(status: GitStatus): {
  label: string;
  bgColor: string;
  textColor: string;
} {
  switch (status) {
    case "added":
      return {
        label: "A",
        bgColor: "bg-[var(--color-status-success)]/20",
        textColor: "text-[var(--color-status-success)]",
      };
    case "modified":
      return {
        label: "M",
        bgColor: "bg-[var(--color-status-warning)]/20",
        textColor: "text-[var(--color-status-warning)]",
      };
    case "deleted":
      return {
        label: "D",
        bgColor: "bg-[var(--color-status-error)]/20",
        textColor: "text-[var(--color-status-error)]",
      };
    case "renamed":
      return {
        label: "R",
        bgColor: "bg-[var(--color-status-info)]/20",
        textColor: "text-[var(--color-status-info)]",
      };
    case "copied":
      return {
        label: "C",
        bgColor: "bg-[var(--color-status-info)]/20",
        textColor: "text-[var(--color-status-info)]",
      };
    case "untracked":
      return {
        label: "?",
        bgColor: "bg-canopy-border/20",
        textColor: "text-canopy-text/60",
      };
    case "ignored":
      return {
        label: "I",
        bgColor: "bg-canopy-border/30",
        textColor: "text-canopy-text/60",
      };
    default:
      return {
        label: "?",
        bgColor: "bg-canopy-border/20",
        textColor: "text-canopy-text/60",
      };
  }
}
