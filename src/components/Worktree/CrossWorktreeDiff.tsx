import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { X, GitCompare, FileIcon, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";
import { DiffViewer } from "./DiffViewer";
import { WorktreeSelector } from "./WorktreeSelector";
import { sortWorktreesForComparison } from "./crossWorktreeDiffUtils";

interface CrossWorktreeDiffProps {
  isOpen: boolean;
  onClose: () => void;
  initialWorktreeId: string | null;
}

function statusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case "A":
      return { label: "A", className: "text-emerald-400" };
    case "D":
      return { label: "D", className: "text-red-400" };
    case "M":
      return { label: "M", className: "text-amber-400" };
    case "R":
      return { label: "R", className: "text-blue-400" };
    case "C":
      return { label: "C", className: "text-purple-400" };
    default:
      return { label: status, className: "text-neutral-400" };
  }
}

export function CrossWorktreeDiff({ isOpen, onClose, initialWorktreeId }: CrossWorktreeDiffProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const worktreeMap = useWorktreeDataStore((state) => state.worktrees);
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
      setError(err instanceof Error ? err.message : "Failed to compare worktrees");
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

  // Keyboard: Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
        "bg-black/60 backdrop-blur-sm"
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="flex flex-col bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-[90vw] max-w-6xl h-[80vh] max-h-[800px] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 shrink-0">
          <GitCompare className="w-4 h-4 text-neutral-400" />
          <h2 className="text-sm font-semibold text-neutral-100 flex-1">Compare Worktrees</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selectors */}
        <div className="flex items-end gap-4 px-4 py-3 border-b border-neutral-800 bg-neutral-900/50 shrink-0">
          <div className="flex-1 min-w-0">
            <WorktreeSelector
              label="Left (base)"
              worktrees={worktrees}
              selectedId={leftId}
              disabledId={rightId}
              onChange={setLeftId}
            />
          </div>
          <div className="text-neutral-500 text-xs pb-2">vs</div>
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
          <div className="w-64 shrink-0 border-r border-neutral-800 flex flex-col overflow-hidden">
            <div className="px-3 py-2 text-xs text-neutral-500 border-b border-neutral-800 shrink-0">
              {result
                ? `${result.files.length} file${result.files.length === 1 ? "" : "s"} changed`
                : "Files"}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && (
                <div className="flex items-center justify-center gap-2 p-6 text-neutral-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Comparing…
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 p-4 text-red-400 text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              {!loading && !error && !result && (
                <div className="p-4 text-neutral-500 text-xs">Select two worktrees to compare</div>
              )}
              {result?.files.length === 0 && (
                <div className="p-4 text-neutral-500 text-xs">
                  No differences between these branches
                </div>
              )}
              {result?.files.map((file) => {
                const { label, className: statusClass } = statusLabel(file.status);
                const isSelected = selectedFile?.path === file.path;
                return (
                  <button
                    key={`${file.status}:${file.path}`}
                    onClick={() => void fetchFileDiff(file)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-800 transition-colors",
                      isSelected && "bg-neutral-800"
                    )}
                  >
                    <span
                      className={cn("font-mono font-bold shrink-0 w-3 text-center", statusClass)}
                    >
                      {label}
                    </span>
                    <FileIcon className="w-3 h-3 shrink-0 text-neutral-500" />
                    <span className="text-neutral-300 truncate min-w-0" title={file.path}>
                      {file.path.split("/").pop()}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Diff panel */}
          <div className="flex-1 overflow-auto bg-neutral-950">
            {!selectedFile && (
              <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
                {result ? "Select a file to view its diff" : ""}
              </div>
            )}
            {selectedFile && fileDiffLoading && (
              <div className="flex items-center justify-center gap-2 h-full text-neutral-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading diff…
              </div>
            )}
            {selectedFile && !fileDiffLoading && fileDiffError && (
              <div className="flex items-center justify-center gap-2 h-full text-red-400 text-sm">
                <AlertCircle className="w-4 h-4" />
                Failed to load diff
              </div>
            )}
            {selectedFile && !fileDiffLoading && !fileDiffError && fileDiff !== null && (
              <DiffViewer diff={fileDiff} filePath={selectedFile.path} viewType="split" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
