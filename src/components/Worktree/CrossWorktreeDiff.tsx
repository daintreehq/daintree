import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { GitCompare, FileIcon, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { AppDialog } from "@/components/ui/AppDialog";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";
import { DiffViewer } from "./DiffViewer";
import { WorktreeSelector } from "./WorktreeSelector";
import { sortWorktreesForComparison } from "./crossWorktreeDiffUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { usePreferencesStore } from "@/store/preferencesStore";

interface CrossWorktreeDiffProps {
  isOpen: boolean;
  onClose: () => void;
  initialWorktreeId: string | null;
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
      return { label: "C", className: "text-pr-merged" };
    default:
      return { label: status, className: "text-text-muted" };
  }
}

interface CrossWorktreeFileRowProps {
  file: CrossWorktreeFile;
  isSelected: boolean;
  onClick: () => void;
}

function CrossWorktreeFileRow({ file, isSelected, onClick }: CrossWorktreeFileRowProps) {
  const { ref, isTruncated } = useTruncationDetection();
  const { label, className: statusClass } = statusLabel(file.status);
  const insertions = file.insertions ?? 0;
  const deletions = file.deletions ?? 0;
  const hasChurn = insertions > 0 || deletions > 0;

  return (
    <TruncatedTooltip content={file.path} isTruncated={isTruncated}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-panel-elevated transition-colors",
          isSelected && "bg-overlay-subtle"
        )}
      >
        <span className={cn("font-mono font-bold shrink-0 w-3 text-center", statusClass)}>
          {label}
        </span>
        <FileIcon className="w-3 h-3 shrink-0 text-text-muted" />
        <span ref={ref} className="text-text-secondary truncate min-w-0">
          {file.path.split(/[/\\]/).filter(Boolean).pop()}
        </span>
        {hasChurn && (
          <span className="ml-auto flex items-center gap-1 shrink-0 text-3xs tabular-nums">
            {insertions > 0 && <span className="text-status-success/80">+{insertions}</span>}
            {deletions > 0 && <span className="text-status-error/80">-{deletions}</span>}
          </span>
        )}
      </button>
    </TruncatedTooltip>
  );
}

function AggregateChurn({ files }: { files: CrossWorktreeFile[] }) {
  const { totalInsertions, totalDeletions } = files.reduce(
    (acc, f) => ({
      totalInsertions: acc.totalInsertions + (f.insertions ?? 0),
      totalDeletions: acc.totalDeletions + (f.deletions ?? 0),
    }),
    { totalInsertions: 0, totalDeletions: 0 }
  );

  return (
    <>
      {files.length} file{files.length !== 1 ? "s" : ""}
      {(totalInsertions > 0 || totalDeletions > 0) && (
        <>
          {" "}
          <span className="text-status-success/80">+{totalInsertions}</span>{" "}
          <span className="text-status-error/80">-{totalDeletions}</span>
        </>
      )}
    </>
  );
}

export function CrossWorktreeDiff({ isOpen, onClose, initialWorktreeId }: CrossWorktreeDiffProps) {
  const worktreeMap = useWorktreeStore((state) => state.worktrees);
  const worktrees = useMemo(() => sortWorktreesForComparison(worktreeMap.values()), [worktreeMap]);

  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [result, setResult] = useState<CrossWorktreeDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<CrossWorktreeFile | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [fileDiffError, setFileDiffError] = useState(false);

  // Request tokens to guard stale async responses
  const compareTokenRef = useRef(0);
  const fileDiffTokenRef = useRef(0);

  // Initialize / reset state when modal opens or closes
  useEffect(() => {
    if (!isOpen) {
      setLeftId(null);
      setRightId(null);
      setResult(null);
      setSelectedFile(null);
      setFileDiff(null);
      setFileDiffError(false);
      setError(null);
      setLoading(false);
      setFileDiffLoading(false);
      return;
    }
    if (initialWorktreeId) {
      // Only accept if the worktree still exists
      const exists = worktrees.some((wt) => wt.id === initialWorktreeId);
      if (exists) setLeftId(initialWorktreeId);
    }
  }, [isOpen, initialWorktreeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const leftWorktree = worktrees.find((wt) => wt.id === leftId) ?? null;
  const rightWorktree = worktrees.find((wt) => wt.id === rightId) ?? null;

  const fetchComparison = useCallback(async () => {
    if (!leftWorktree?.branch || !rightWorktree?.branch) return;
    if (leftWorktree.branch === rightWorktree.branch) return;

    const token = ++compareTokenRef.current;

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedFile(null);
    setFileDiff(null);
    setFileDiffError(false);

    try {
      const res = await window.electron.git.compareWorktrees(
        leftWorktree.path,
        leftWorktree.branch,
        rightWorktree.branch
      );
      if (token !== compareTokenRef.current) return; // stale response
      if (typeof res === "string") {
        setError("Unexpected result from comparison");
        return;
      }
      setResult(res);
    } catch (err) {
      if (token !== compareTokenRef.current) return;
      setError(formatErrorMessage(err, "Failed to compare worktrees"));
    } finally {
      if (token === compareTokenRef.current) setLoading(false);
    }
  }, [leftWorktree, rightWorktree]);

  // Auto-fetch when both sides are selected
  useEffect(() => {
    if (leftId && rightId && leftId !== rightId) {
      void fetchComparison();
    }
  }, [leftId, rightId, fetchComparison]);

  const ignoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);

  const fetchFileDiff = useCallback(
    async (file: CrossWorktreeFile) => {
      if (!leftWorktree?.branch || !rightWorktree?.branch) return;

      const token = ++fileDiffTokenRef.current;

      setSelectedFile(file);
      setFileDiff(null);
      setFileDiffError(false);
      setFileDiffLoading(true);

      try {
        const diff = await window.electron.git.compareWorktrees(
          leftWorktree.path,
          leftWorktree.branch,
          rightWorktree.branch,
          file.path,
          undefined,
          ignoreWhitespace
        );
        if (token !== fileDiffTokenRef.current) return; // stale response
        setFileDiff(typeof diff === "string" ? diff : null);
        setFileDiffError(false);
      } catch {
        if (token !== fileDiffTokenRef.current) return;
        setFileDiff(null);
        setFileDiffError(true);
      } finally {
        if (token === fileDiffTokenRef.current) setFileDiffLoading(false);
      }
    },
    [leftWorktree, rightWorktree, ignoreWhitespace]
  );

  // File stepping through the comparison set, mirroring the diff modals:
  // `[` / `]` keys plus a footer stepper in the diff panel.
  const files = result?.files ?? null;
  const selectedFileIndex = useMemo(() => {
    if (!files || !selectedFile) return -1;
    return files.findIndex((f) => f.path === selectedFile.path && f.status === selectedFile.status);
  }, [files, selectedFile]);

  const navigateFile = useCallback(
    (delta: -1 | 1) => {
      if (!files || files.length === 0) return;
      // No selection yet: `]` starts the walk at the first file.
      const target =
        selectedFileIndex < 0
          ? delta === 1
            ? files[0]
            : undefined
          : files[selectedFileIndex + delta];
      if (!target) return;
      void fetchFileDiff(target);
      const name = target.path.split(/[/\\]/).filter(Boolean).pop() || target.path;
      const position = selectedFileIndex < 0 ? 1 : selectedFileIndex + delta + 1;
      useAnnouncerStore.getState().announce(`${name}, file ${position} of ${files.length}`);
    },
    [files, selectedFileIndex, fetchFileDiff]
  );

  useEffect(() => {
    if (!isOpen || !files || files.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
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
      e.preventDefault();
      navigateFile(e.key === "]" ? 1 : -1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, files, navigateFile]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="6xl"
      maxHeight="h-[80vh]"
      className="max-h-[800px] overflow-hidden"
    >
      <AppDialog.Header className="px-4 py-3 border-b border-border-subtle !bg-transparent">
        <AppDialog.Title
          icon={<GitCompare className="w-4 h-4 text-text-muted" />}
          className="text-sm font-semibold text-text-primary"
        >
          Compare Worktrees
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      {/* Selectors */}
      <div className="flex items-end gap-4 px-4 py-3 border-b border-border-subtle bg-surface-panel/50 shrink-0">
        <div className="flex-1 min-w-0">
          <WorktreeSelector
            label="Left (base)"
            worktrees={worktrees}
            selectedId={leftId}
            disabledId={rightId}
            onChange={setLeftId}
          />
        </div>
        <div className="text-text-muted text-xs pb-2">vs</div>
        <div className="flex-1 min-w-0">
          <WorktreeSelector
            label="Right (compare)"
            worktrees={worktrees}
            selectedId={rightId}
            disabledId={leftId}
            onChange={setRightId}
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* File list sidebar */}
        <div className="w-64 shrink-0 border-r border-border-subtle flex flex-col overflow-hidden">
          <div className="px-3 py-2 text-xs text-text-muted border-b border-border-subtle shrink-0">
            {result ? <AggregateChurn files={result.files} /> : "Files"}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <Skeleton label="Comparing files" className="py-1">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                    <SkeletonBone className="w-3 h-3 shrink-0" />
                    <SkeletonBone className="w-3 h-3 shrink-0" />
                    <SkeletonBone className={cn("h-3", i % 2 === 0 ? "w-32" : "w-24")} />
                  </div>
                ))}
              </Skeleton>
            )}
            {error && (
              <div className="flex items-start gap-2 p-4 text-status-error text-xs">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {!loading && !error && !result && (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-text-muted">
                <p className="text-sm">Select two worktrees to compare</p>
                <p className="text-xs mt-1">
                  Pick branches from the selectors above to view changes
                </p>
              </div>
            )}
            {result?.files.length === 0 && (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-text-muted">
                <p className="text-sm">No differences between these branches</p>
                <p className="text-xs mt-1">
                  Select different branches or verify both branches have diverged
                </p>
              </div>
            )}
            {result?.files.map((file) => (
              <CrossWorktreeFileRow
                key={`${file.status}:${file.path}`}
                file={file}
                isSelected={selectedFile?.path === file.path}
                onClick={() => void fetchFileDiff(file)}
              />
            ))}
          </div>
        </div>

        {/* Diff panel */}
        <div className="flex-1 flex flex-col overflow-hidden bg-surface-canvas">
          {selectedFile && files && files.length > 1 && (
            <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-border-subtle shrink-0">
              <button
                type="button"
                onClick={() => navigateFile(-1)}
                disabled={selectedFileIndex <= 0}
                aria-label="Previous file"
                title="Previous file ([)"
                className="p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-surface-panel-elevated disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span
                data-testid="cross-worktree-file-position"
                className="text-xs text-text-muted tabular-nums"
              >
                {selectedFileIndex + 1} of {files.length}
              </span>
              <button
                type="button"
                onClick={() => navigateFile(1)}
                disabled={selectedFileIndex >= files.length - 1}
                aria-label="Next file"
                title="Next file (])"
                className="p-1 rounded transition-colors text-text-muted hover:text-text-primary hover:bg-surface-panel-elevated disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="flex-1 overflow-auto diff-scroll-root">
            {!selectedFile && (
              <div className="flex items-center justify-center h-full text-text-muted text-sm">
                {result ? "Select a file to view its diff" : ""}
              </div>
            )}
            {selectedFile && fileDiffLoading && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading diff">
                  <SkeletonBone className="h-7 w-3/4" />
                  <SkeletonText lines={8} />
                </Skeleton>
              </div>
            )}
            {selectedFile && !fileDiffLoading && fileDiffError && (
              <div className="flex flex-col items-center justify-center gap-3 h-full">
                <div className="flex items-center gap-2 text-status-error text-sm">
                  <AlertCircle className="w-4 h-4" />
                  Couldn't load diff
                </div>
                <button
                  type="button"
                  onClick={() => void fetchFileDiff(selectedFile)}
                  className="px-3 py-1.5 text-xs font-medium rounded bg-daintree-border hover:bg-daintree-border/80 text-daintree-text transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
            {selectedFile && !fileDiffLoading && !fileDiffError && fileDiff !== null && (
              // Split view is required here — the inline cross-worktree split-pane
              // layout depends on it, so this is not driven by the persisted
              // diffViewType preference. rootPath is the RIGHT worktree's checkout:
              // the new side of the A..B comparison, i.e. the file the user is
              // inspecting.
              <DiffViewer
                diff={fileDiff}
                viewType="split"
                rootPath={rightWorktree?.path}
                onRetry={() => void fetchFileDiff(selectedFile)}
              />
            )}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
