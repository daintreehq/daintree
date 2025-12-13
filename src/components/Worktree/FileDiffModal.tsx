import { useEffect, useCallback, useState, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DiffViewer } from "./DiffViewer";
import { useOverlayState } from "@/hooks";
import type { ViewType } from "react-diff-view";
import type { GitStatus } from "@shared/types";

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
  useOverlayState(isOpen);

  const [diff, setDiff] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [viewType, setViewType] = useState<ViewType>("split");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogTitleId = useId();

  const fetchDiff = useCallback(async () => {
    setLoadingState("loading");
    setError(null);

    try {
      const diffResult = await window.electron.git.getFileDiff(worktreePath, filePath, status);

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
      return;
    }

    previousFocusRef.current = document.activeElement as HTMLElement;

    let cancelled = false;

    async function fetchDiffWithCancel() {
      await fetchDiff();
      if (cancelled) return;
    }

    fetchDiffWithCancel();

    return () => {
      cancelled = true;
      if (previousFocusRef.current && previousFocusRef.current.focus) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, fetchDiff]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleKeyDown]);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 100);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  if (!isOpen) return null;

  const fileName = filePath.split("/").pop() || filePath;
  const statusInfo = getStatusInfo(status);

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 backdrop-blur-sm backdrop-saturate-[1.25]"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-6xl max-h-[90vh] mx-4 flex flex-col bg-canopy-bg border border-canopy-border rounded-[var(--radius-xl)] shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
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

            <h2 id={dialogTitleId} className="text-sm font-medium text-canopy-text truncate">
              <span className="text-muted-foreground">{filePath.replace(fileName, "")}</span>
              <span className="text-canopy-text">{fileName}</span>
            </h2>
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

            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-muted-foreground hover:text-canopy-text hover:bg-canopy-border"
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto min-h-0">
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
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-canopy-border bg-canopy-sidebar/50 shrink-0">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body
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
