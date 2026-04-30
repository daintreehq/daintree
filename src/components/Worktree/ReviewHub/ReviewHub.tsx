import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StagingStatus, GitStatus } from "@shared/types";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { isClientAppError } from "@/utils/clientAppError";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  X,
  RefreshCw,
  CheckSquare,
  Square,
  AlertTriangle,
  GitBranch,
  GitPullRequest,
  FileIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { FileStageRow } from "./FileStageRow";
import { CommitPanel } from "./CommitPanel";
import { ConflictPanel } from "./ConflictPanel";
import { FileDiffModal } from "../FileDiffModal";
import { BaseBranchDiffModal } from "./BaseBranchDiffModal";
import { Button } from "@/components/ui/button";
import { debounce } from "@/utils/debounce";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useShallow } from "zustand/react/shallow";
import { githubClient } from "@/clients/githubClient";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface ReviewHubProps {
  isOpen: boolean;
  worktreePath: string;
  onClose: () => void;
}

type DiffMode = "working-tree" | "base-branch";

interface PushErrorState {
  reason: GitOperationReason;
  rawMessage: string;
}

type PushBannerCta = { kind: "settings-github"; label: string } | { kind: "retry"; label: string };

interface PushBannerConfig {
  message: string;
  showRaw: boolean;
  cta?: PushBannerCta;
}

function getPushBannerConfig(reason: GitOperationReason): PushBannerConfig {
  switch (reason) {
    case "auth-failed":
      return {
        message: "Authentication failed — check your credentials or SSH key.",
        showRaw: false,
        cta: { kind: "settings-github", label: "Open GitHub settings" },
      };
    case "push-rejected-outdated":
      return {
        message: "The remote has new commits. Pull or rebase before pushing.",
        showRaw: false,
      };
    case "push-rejected-policy":
      return {
        message: "The remote rejected this push (protected branch or repository rule).",
        showRaw: true,
      };
    case "hook-rejected":
      return {
        message: "A server-side hook rejected the push.",
        showRaw: true,
      };
    case "network-unavailable":
      return {
        message: "Could not reach the remote. Check your internet connection.",
        showRaw: false,
        cta: { kind: "retry", label: "Retry push" },
      };
    default:
      return { message: "Push failed. See details below.", showRaw: true };
  }
}

function statusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case "A":
      return { label: "A", className: "text-status-success" };
    case "D":
      return { label: "D", className: "text-status-error" };
    case "M":
      return { label: "M", className: "text-status-warning" };
    case "R":
      return { label: "R", className: "text-status-info" };
    case "C":
      return { label: "C", className: "text-github-merged" };
    default:
      return { label: status, className: "text-text-muted" };
  }
}

interface BaseBranchFileRowProps {
  file: CrossWorktreeFile;
  onClick: () => void;
}

function BaseBranchFileRow({ file, onClick }: BaseBranchFileRowProps) {
  const { label, className: statusClass } = statusLabel(file.status);
  const filename = file.path.split(/[/\\]/).filter(Boolean).pop() || file.path;
  const dirPath = /[/\\]/.test(file.path)
    ? file.path.substring(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")))
    : "";

  return (
    <TruncatedTooltip content={file.path}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs",
          "hover:bg-tint/[0.05] transition-colors",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
        )}
      >
        <span className={cn("font-mono font-bold shrink-0 w-3 text-center", statusClass)}>
          {label}
        </span>
        <FileIcon className="w-3 h-3 shrink-0 text-daintree-text/40" />
        <span className="text-daintree-text/80 truncate min-w-0">{filename}</span>
        <span className="text-daintree-text/30 truncate min-w-0 text-[10px] ml-auto pl-2">
          {dirPath}
        </span>
      </button>
    </TruncatedTooltip>
  );
}

export function ReviewHub({ isOpen, worktreePath, onClose }: ReviewHubProps) {
  const [status, setStatus] = useState<StagingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<PushErrorState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    status: GitStatus;
  } | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("working-tree");
  const [baseBranchFiles, setBaseBranchFiles] = useState<CrossWorktreeFile[] | null>(null);
  const [baseBranchLoading, setBaseBranchLoading] = useState(false);
  const [baseBranchError, setBaseBranchError] = useState<string | null>(null);
  const [selectedBaseBranchFile, setSelectedBaseBranchFile] = useState<CrossWorktreeFile | null>(
    null
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const refreshIdRef = useRef(0);
  const bgRefreshIdRef = useRef(0);
  const baseBranchRequestRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const debouncedBgRefreshRef = useRef<ReturnType<typeof debounce> | null>(null);

  const mainBranch = useWorktreeStore(
    (state) =>
      Array.from(state.worktrees.values()).find((wt) => wt.isMainWorktree)?.branch ?? "main"
  );

  const worktreePR = useWorktreeStore(
    useShallow((state) => {
      for (const wt of state.worktrees.values()) {
        if (wt.path === worktreePath) {
          return wt.prNumber
            ? { prNumber: wt.prNumber, prUrl: wt.prUrl, prState: wt.prState }
            : null;
        }
      }
      return null;
    })
  );

  useOverlayState(isOpen);

  const refresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++refreshIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      if (refreshIdRef.current === requestId) {
        setStatus(result);
      }
    } catch (err) {
      if (refreshIdRef.current === requestId) {
        setLoadError(formatErrorMessage(err, "Failed to load staging status"));
      }
    } finally {
      if (refreshIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [worktreePath]);

  const backgroundRefresh = useCallback(async () => {
    if (!worktreePath) return;
    const requestId = ++bgRefreshIdRef.current;
    setIsBackgroundRefreshing(true);
    try {
      const result = await window.electron.git.getStagingStatus(worktreePath);
      if (bgRefreshIdRef.current === requestId) {
        setStatus(result);
        setLoadError(null);
      }
    } catch {
      // Keep existing data visible; silently drop background errors
    } finally {
      if (bgRefreshIdRef.current === requestId) {
        setIsBackgroundRefreshing(false);
      }
    }
  }, [worktreePath]);

  const fetchBaseBranch = useCallback(async () => {
    const currentBranch = status?.currentBranch;
    if (!currentBranch || !worktreePath) return;
    if (currentBranch === mainBranch) return;

    const requestId = ++baseBranchRequestRef.current;
    setBaseBranchLoading(true);
    setBaseBranchError(null);
    setBaseBranchFiles(null);
    setSelectedBaseBranchFile(null);

    try {
      const res = await window.electron.git.compareWorktrees(
        worktreePath,
        mainBranch,
        currentBranch,
        undefined,
        true
      );
      if (baseBranchRequestRef.current !== requestId) return;
      if (typeof res === "string") {
        setBaseBranchError("Unexpected result from comparison");
        return;
      }
      setBaseBranchFiles(res.files);
    } catch (err) {
      if (baseBranchRequestRef.current !== requestId) return;
      setBaseBranchError(formatErrorMessage(err, "Failed to load base branch diff"));
    } finally {
      if (baseBranchRequestRef.current === requestId) setBaseBranchLoading(false);
    }
  }, [worktreePath, mainBranch, status?.currentBranch]);

  useEffect(() => {
    if (isOpen) {
      setActionError(null);
      setPushError(null);
      void refresh();
    } else {
      refreshIdRef.current++;
      bgRefreshIdRef.current++;
      baseBranchRequestRef.current++;
      setStatus(null);
      setLoadError(null);
      setActionError(null);
      setPushError(null);
      setSelectedFile(null);
      setCommitMessage("");
      setIsBackgroundRefreshing(false);
      setDiffMode("working-tree");
      setBaseBranchFiles(null);
      setBaseBranchError(null);
      setSelectedBaseBranchFile(null);
    }
  }, [isOpen, refresh]);

  useEffect(() => {
    if (diffMode === "base-branch" && status?.currentBranch === mainBranch) {
      baseBranchRequestRef.current++;
      setDiffMode("working-tree");
      setBaseBranchFiles(null);
      setBaseBranchError(null);
      setSelectedBaseBranchFile(null);
    }
  }, [status?.currentBranch, mainBranch, diffMode]);

  useEffect(() => {
    if (!isOpen) return;

    const debouncedBgRefresh = debounce(() => void backgroundRefresh(), 800);
    debouncedBgRefreshRef.current = debouncedBgRefresh;

    const unsubscribe = window.electron.worktree.onUpdate((state) => {
      if (state.path === worktreePath) {
        debouncedBgRefresh();
      }
    });

    return () => {
      unsubscribe();
      debouncedBgRefresh.cancel();
      debouncedBgRefreshRef.current = null;
    };
  }, [isOpen, worktreePath, backgroundRefresh]);

  const handleStageFile = useCallback(
    async (filePath: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.stageFile(worktreePath, filePath);
        await refresh();
      } catch (err) {
        setActionError(formatErrorMessage(err, "Failed to stage file"));
      }
    },
    [worktreePath, refresh]
  );

  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.unstageFile(worktreePath, filePath);
        await refresh();
      } catch (err) {
        setActionError(formatErrorMessage(err, "Failed to unstage file"));
      }
    },
    [worktreePath, refresh]
  );

  const handleStageAll = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.stageAll(worktreePath);
      await refresh();
    } catch (err) {
      setActionError(formatErrorMessage(err, "Failed to stage all files"));
    }
  }, [worktreePath, refresh]);

  const handleUnstageAll = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.unstageAll(worktreePath);
      await refresh();
    } catch (err) {
      setActionError(formatErrorMessage(err, "Failed to unstage all files"));
    }
  }, [worktreePath, refresh]);

  const handleCommit = useCallback(
    async (message: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.commit(worktreePath, message);
        await refresh();
      } catch (err) {
        setActionError(formatErrorMessage(err, "Failed to commit changes"));
        throw err;
      }
    },
    [worktreePath, refresh]
  );

  const handleAbortOperation = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.abortRepositoryOperation(worktreePath);
      await refresh();
    } catch (err) {
      setActionError(formatErrorMessage(err, "Failed to abort repository operation"));
      throw err;
    }
  }, [worktreePath, refresh]);

  const handleContinueOperation = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.continueRepositoryOperation(worktreePath);
      await refresh();
    } catch (err) {
      setActionError(formatErrorMessage(err, "Failed to continue repository operation"));
      throw err;
    }
  }, [worktreePath, refresh]);

  const handleOpenInEditor = useCallback(
    async (filePath: string) => {
      setActionError(null);
      try {
        const base = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
        const tail = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
        await window.electron.system.openInEditor({ path: `${base}/${tail}` });
      } catch (err) {
        setActionError(formatErrorMessage(err, "Failed to open file in editor"));
      }
    },
    [worktreePath]
  );

  const runPush = useCallback(async () => {
    try {
      await window.electron.git.push(worktreePath);
      setPushError(null);
    } catch (err) {
      // GitOperationError carries `gitReason` (auth-failed, push-rejected-*, etc.).
      // AppError carries `code` from a different union (RATE_LIMITED, etc.) — fall
      // back to "unknown" so getPushBannerConfig surfaces the raw message rather
      // than rendering an unmapped reason.
      const gitReason = (err as { gitReason?: GitOperationReason }).gitReason;
      const isRateLimited =
        isClientAppError(err) && (err as { code?: string }).code === "RATE_LIMITED";
      setPushError({
        reason: gitReason ?? "unknown",
        rawMessage: isRateLimited
          ? "Too many push attempts in a short window — wait a moment and try again."
          : formatErrorMessage(err, "Failed to push"),
      });
    }
  }, [worktreePath]);

  const handleCommitAndPush = useCallback(
    async (message: string) => {
      setActionError(null);
      setPushError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.commit(worktreePath, message);
      } catch (err) {
        setActionError(formatErrorMessage(err, "Failed to commit changes"));
        throw err;
      }
      await refresh();
      await runPush();
    },
    [worktreePath, refresh, runPush]
  );

  const handleRetryPush = useCallback(async () => {
    setPushError(null);
    debouncedBgRefreshRef.current?.cancel();
    await runPush();
  }, [runPush]);

  useLayoutEffect(() => {
    if (scrollContainerRef.current && status) {
      scrollContainerRef.current.scrollTop = savedScrollTop.current;
    }
  }, [status]);

  const handleScrollContainer = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    savedScrollTop.current = e.currentTarget.scrollTop;
  }, []);

  const handleFileClick = useCallback((filePath: string, fileStatus: GitStatus) => {
    setSelectedFile({ path: filePath, status: fileStatus });
  }, []);

  const handleDiffModeChange = useCallback(
    (mode: DiffMode) => {
      setDiffMode(mode);
      if (mode === "base-branch" && baseBranchFiles === null && !baseBranchLoading) {
        void fetchBaseBranch();
      }
    },
    [baseBranchFiles, baseBranchLoading, fetchBaseBranch]
  );

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (selectedFile) {
        setSelectedFile(null);
      } else if (selectedBaseBranchFile) {
        setSelectedBaseBranchFile(null);
      } else {
        onClose();
      }
    }
  });

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!isOpen) return null;

  const totalChanges =
    (status?.staged.length ?? 0) +
    (status?.unstaged.length ?? 0) +
    (status?.conflicted.length ?? 0);
  const hasConflicts = (status?.conflicted.length ?? 0) > 0;
  const repoState = status?.repoState ?? "CLEAN";
  const isOperationState =
    repoState === "MERGING" ||
    repoState === "REBASING" ||
    repoState === "CHERRY_PICKING" ||
    repoState === "REVERTING";

  return createPortal(
    <>
      <div
        className={cn(
          "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
          "bg-scrim-medium backdrop-blur-sm",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        )}
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-hub-title"
        data-testid="review-hub"
      >
        <div
          className={cn(
            "relative flex flex-col",
            "w-[min(720px,calc(100vw-80px))] max-h-[calc(100vh-80px)] min-h-[320px]",
            "bg-daintree-bg rounded-xl",
            "border border-divider",
            "shadow-[var(--theme-shadow-dialog)]",
            "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-divider shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <h2
                id="review-hub-title"
                className="text-daintree-text font-semibold text-sm tracking-wide shrink-0"
              >
                Review & Commit
              </h2>
              {status?.currentBranch && (
                <TruncatedTooltip content={status.currentBranch}>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] text-daintree-text/60 font-mono truncate max-w-[200px]">
                    <GitBranch className="w-3 h-3 shrink-0" />
                    <span className="truncate">{status.currentBranch}</span>
                  </span>
                </TruncatedTooltip>
              )}
              {status?.hasRemote && worktreePR && worktreePR.prUrl && (
                <button
                  type="button"
                  onClick={() => void githubClient.openPR(worktreePR.prUrl as string)}
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono",
                    "bg-tint/[0.07] border border-tint/[0.08]",
                    "hover:bg-tint/[0.12] transition-colors cursor-pointer",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent"
                  )}
                  aria-label={`Open pull request #${worktreePR.prNumber} on GitHub`}
                >
                  <GitPullRequest
                    className={cn(
                      "w-3 h-3 shrink-0",
                      worktreePR.prState === "merged"
                        ? "text-github-merged"
                        : worktreePR.prState === "closed"
                          ? "text-github-closed"
                          : "text-github-open"
                    )}
                  />
                  <span
                    className={
                      worktreePR.prState === "merged"
                        ? "text-github-merged"
                        : worktreePR.prState === "closed"
                          ? "text-github-closed"
                          : "text-github-open"
                    }
                  >
                    #{worktreePR.prNumber}
                  </span>
                  <span className="text-daintree-text/40">·</span>
                  <span className="text-daintree-text/60">
                    {worktreePR.prState === "merged"
                      ? "merged"
                      : worktreePR.prState === "closed"
                        ? "closed"
                        : "open"}
                  </span>
                </button>
              )}
              {status?.hasRemote && !worktreePR && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] text-daintree-text/40">
                  <GitPullRequest className="w-3 h-3 shrink-0" />
                  <span>No PR</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Diff mode toggle */}
              <div
                className="flex items-center rounded border border-tint/[0.08] overflow-hidden text-[11px]"
                role="group"
                aria-label="Diff mode"
                data-testid="review-hub-diff-mode"
              >
                <button
                  onClick={() => handleDiffModeChange("working-tree")}
                  className={cn(
                    "px-2 py-1 transition-colors",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent",
                    diffMode === "working-tree"
                      ? "bg-tint/[0.12] text-daintree-text"
                      : "text-daintree-text/50 hover:text-daintree-text hover:bg-tint/[0.06]"
                  )}
                  aria-pressed={diffMode === "working-tree"}
                >
                  Working tree
                </button>
                <button
                  onClick={() => handleDiffModeChange("base-branch")}
                  disabled={!status?.currentBranch || status.currentBranch === mainBranch}
                  className={cn(
                    "px-2 py-1 transition-colors border-l border-tint/[0.08]",
                    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    diffMode === "base-branch"
                      ? "bg-tint/[0.12] text-daintree-text"
                      : "text-daintree-text/50 hover:text-daintree-text hover:bg-tint/[0.06]"
                  )}
                  aria-pressed={diffMode === "base-branch"}
                >
                  vs {mainBranch}
                </button>
              </div>

              {diffMode === "working-tree" && (
                <button
                  onClick={() => void refresh()}
                  disabled={loading}
                  className={cn(
                    "p-1.5 rounded transition-colors",
                    "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                  )}
                  aria-label="Refresh"
                >
                  <RefreshCw
                    className={cn(
                      "w-3.5 h-3.5",
                      (loading || isBackgroundRefreshing) && "animate-spin"
                    )}
                  />
                </button>
              )}
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className={cn(
                  "p-1.5 rounded transition-colors",
                  "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                )}
                aria-label="Close"
                data-testid="review-hub-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Inline error banners */}
          {actionError && (
            <div className="px-4 py-2 text-xs text-status-error bg-status-error/10 flex items-start gap-2 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}
          {pushError &&
            (() => {
              const config = getPushBannerConfig(pushError.reason);
              const onCtaClick = () => {
                if (!config.cta) return;
                if (config.cta.kind === "settings-github") {
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "github" },
                    { source: "user" }
                  );
                } else {
                  void handleRetryPush();
                }
              };
              return (
                <div
                  role="alert"
                  data-testid="review-hub-push-error"
                  data-reason={pushError.reason}
                  className="px-4 py-2 text-xs text-status-warning bg-status-warning/10 flex items-start gap-2 shrink-0"
                >
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div>
                      <span className="font-medium">Committed locally.</span>{" "}
                      <span>{config.message}</span>
                    </div>
                    {config.showRaw && pushError.rawMessage && (
                      <pre
                        data-testid="review-hub-push-error-details"
                        className="mt-1 text-[10px] font-mono whitespace-pre-wrap break-all opacity-70"
                      >
                        {pushError.rawMessage}
                      </pre>
                    )}
                    {config.cta && (
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={onCtaClick}
                          data-testid="review-hub-push-error-cta"
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded",
                            "bg-status-warning/20 hover:bg-status-warning/30",
                            "text-status-warning text-[11px] font-medium transition-colors",
                            "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-warning"
                          )}
                        >
                          {config.cta.label}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Content */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto min-h-0"
            onScroll={handleScrollContainer}
          >
            {diffMode === "base-branch" ? (
              /* Base-branch diff panel */
              baseBranchLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Spinner size="lg" className="text-daintree-text/40" />
                </div>
              ) : baseBranchError ? (
                <div className="p-4 text-xs text-status-error">
                  <p className="mb-2">{baseBranchError}</p>
                  <Button variant="subtle" size="sm" onClick={() => void fetchBaseBranch()}>
                    Retry
                  </Button>
                </div>
              ) : baseBranchFiles !== null && baseBranchFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-daintree-text/50">
                  <CheckSquare className="w-8 h-8 mb-2 text-daintree-text/30" />
                  <p className="text-sm">No changes vs {mainBranch}</p>
                  <p className="text-xs mt-1">This branch has no commits ahead of {mainBranch}</p>
                </div>
              ) : baseBranchFiles !== null ? (
                <div>
                  <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle border-b border-divider">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                      Changed vs {mainBranch}
                      <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                        {baseBranchFiles.length}
                      </span>
                    </span>
                  </div>
                  <div className="px-2 py-1 flex flex-col gap-0.5">
                    {baseBranchFiles.map((file) => (
                      <BaseBranchFileRow
                        key={`${file.status}:${file.path}`}
                        file={file}
                        onClick={() => setSelectedBaseBranchFile(file)}
                      />
                    ))}
                  </div>
                </div>
              ) : null
            ) : (
              /* Working-tree panel */
              <>
                {loading && !status ? (
                  <div className="flex items-center justify-center py-12">
                    <Spinner size="lg" className="text-daintree-text/40" />
                  </div>
                ) : loadError ? (
                  <div className="p-4 text-xs text-status-error">
                    <p className="mb-2">{loadError}</p>
                    <Button variant="subtle" size="sm" onClick={() => void refresh()}>
                      Retry
                    </Button>
                  </div>
                ) : status && isOperationState ? (
                  <ConflictPanel
                    status={status}
                    onMarkResolved={handleStageFile}
                    onOpenInEditor={handleOpenInEditor}
                    onAbort={handleAbortOperation}
                    onContinue={handleContinueOperation}
                  />
                ) : status && totalChanges === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-daintree-text/50">
                    <CheckSquare className="w-8 h-8 mb-2 text-daintree-text/30" />
                    <p className="text-sm">Working tree clean</p>
                    <p className="text-xs mt-1">No changes to commit</p>
                  </div>
                ) : status ? (
                  <div>
                    {/* Conflict warning */}
                    {hasConflicts && (
                      <div className="px-4 py-2.5 bg-status-error/10 border-b border-divider flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-status-error mt-0.5 shrink-0" />
                        <div className="text-xs text-status-error">
                          <span className="font-medium">
                            {status.conflicted.length} conflicted file
                            {status.conflicted.length !== 1 ? "s" : ""}
                          </span>
                          <span className="text-daintree-text/60 ml-1">
                            — resolve conflicts before committing
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Staged section */}
                    <div className="border-b border-divider">
                      <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                          Staged
                          <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                            {status.staged.length}
                          </span>
                        </span>
                        {status.staged.length > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleUnstageAll()}
                            className="h-5 px-1.5 text-[10px]"
                          >
                            <Square className="w-3 h-3 mr-1" />
                            Unstage all
                          </Button>
                        )}
                      </div>
                      {status.staged.length > 0 ? (
                        <div className="px-2 py-1 flex flex-col gap-0.5">
                          {status.staged.map((file) => (
                            <FileStageRow
                              key={`staged-${file.path}`}
                              file={file}
                              isStaged={true}
                              onToggle={(path) => void handleUnstageFile(path)}
                              onFileClick={handleFileClick}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="px-4 py-3 text-xs text-daintree-text/40 italic">
                          No staged files
                        </div>
                      )}
                    </div>

                    {/* Unstaged section */}
                    <div>
                      <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                          Changes
                          <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                            {status.unstaged.length}
                          </span>
                        </span>
                        {status.unstaged.length > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleStageAll()}
                            className="h-5 px-1.5 text-[10px]"
                          >
                            <CheckSquare className="w-3 h-3 mr-1" />
                            Stage all
                          </Button>
                        )}
                      </div>
                      {status.unstaged.length > 0 ? (
                        <div className="px-2 py-1 flex flex-col gap-0.5">
                          {status.unstaged.map((file) => (
                            <FileStageRow
                              key={`unstaged-${file.path}`}
                              file={file}
                              isStaged={false}
                              onToggle={(path) => void handleStageFile(path)}
                              onFileClick={handleFileClick}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="px-4 py-3 text-xs text-daintree-text/40 italic">
                          No unstaged changes
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Commit panel — only in working-tree mode, and never during a conflict op */}
          {diffMode === "working-tree" &&
            status &&
            totalChanges > 0 &&
            !loadError &&
            !isOperationState && (
              <CommitPanel
                stagedCount={status.staged.length}
                isDetachedHead={status.isDetachedHead}
                hasConflicts={hasConflicts}
                hasRemote={status.hasRemote}
                commitMessage={commitMessage}
                onCommitMessageChange={setCommitMessage}
                onCommit={handleCommit}
                onCommitAndPush={handleCommitAndPush}
              />
            )}
        </div>
      </div>

      {/* File diff modal — working-tree mode */}
      <FileDiffModal
        isOpen={selectedFile !== null}
        filePath={selectedFile?.path ?? ""}
        status={selectedFile?.status ?? "modified"}
        worktreePath={worktreePath}
        onClose={() => setSelectedFile(null)}
      />

      {/* File diff modal — base-branch mode */}
      <BaseBranchDiffModal
        isOpen={selectedBaseBranchFile !== null}
        filePath={selectedBaseBranchFile?.path ?? ""}
        worktreePath={worktreePath}
        mainBranch={mainBranch}
        currentBranch={status?.currentBranch ?? "HEAD"}
        onClose={() => setSelectedBaseBranchFile(null)}
      />
    </>,
    document.body
  );
}
