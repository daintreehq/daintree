import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { GitCompare, FileIcon, AlertCircle } from "lucide-react";
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
          <span className="ml-auto flex items-center gap-1 shrink-0 text-[10px] tabular-nums">
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
          file.path
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
    [leftWorktree, rightWorktree]
  );

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
              <div className="flex flex-col items-center justify-center py-12 text-text-muted">
                <p className="text-sm">Select two worktrees to compare</p>
                <p className="text-xs mt-1">
                  Pick branches from the selectors above to view changes
                </p>
              </div>
            )}
            {result?.files.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-text-muted">
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
        <div className="flex-1 overflow-auto bg-surface-canvas">
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
            <div className="flex items-center justify-center gap-2 h-full text-status-error text-sm">
              <AlertCircle className="w-4 h-4" />
              Failed to load diff
            </div>
          )}
          {selectedFile && !fileDiffLoading && !fileDiffError && fileDiff !== null && (
            // Split view is required here — the inline cross-worktree split-pane
            // layout depends on it, so this is not driven by the persisted
            // diffViewType preference.
            <DiffViewer diff={fileDiff} filePath={selectedFile.path} viewType="split" />
          )}
        </div>
      </div>
    </AppDialog>
  );
}
