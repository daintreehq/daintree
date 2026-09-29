import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import { GitCompare, ChevronLeft, ChevronRight, Folder, RefreshCw, WrapText } from "lucide-react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { AppDialog } from "@/components/ui/AppDialog";
import type { GitStatus } from "@shared/types";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";
import { basename, dirname } from "@shared/utils/path";
import { DiffViewer } from "./DiffViewer";
import { WorktreeSelector } from "./WorktreeSelector";
import { sortWorktreesForComparison, worktreeOptionLabel } from "./crossWorktreeDiffUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { usePreferencesStore } from "@/store/preferencesStore";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { DIFF_STATUS_CONFIG, formatDiffDir } from "@/components/FileViewer/diffChangeSet";
import { isProseFilePath } from "@/components/FileViewer/isProseFile";

interface CrossWorktreeDiffProps {
  isOpen: boolean;
  onClose: () => void;
  initialWorktreeId: string | null;
}

const STATUS_BY_LETTER: Record<string, GitStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
};

/** The same letters and colours as the diff workspace's changed-files shelf. */
function statusDisplay(letter: string): { label: string; color: string; name: string } {
  const status = STATUS_BY_LETTER[letter];
  if (!status) return { label: letter, color: "text-text-secondary", name: "changed" };
  return { ...DIFF_STATUS_CONFIG[status], name: status };
}

function fileRowLabel(file: CrossWorktreeFile): string {
  const parts = [file.path, statusDisplay(file.status).name];
  if (file.oldPath) parts.push(`from ${file.oldPath}`);
  if ((file.insertions ?? 0) > 0) parts.push(`${file.insertions} added`);
  if ((file.deletions ?? 0) > 0) parts.push(`${file.deletions} removed`);
  return parts.join(", ");
}

interface FileGroup {
  dir: string;
  files: CrossWorktreeFile[];
}

/**
 * Directory bands, root first, then by path — the diff workspace's shelf
 * order. Two `index.ts` files are only tellable apart by their directory.
 */
export function groupComparisonFiles(files: CrossWorktreeFile[]): FileGroup[] {
  const grouped = new Map<string, CrossWorktreeFile[]>();
  for (const file of files) {
    const dir = dirname(file.path);
    const key = !dir || dir === "." ? "" : dir;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(file);
    else grouped.set(key, [file]);
  }
  return Array.from(grouped.entries())
    .map(([dir, groupFiles]) => ({
      dir,
      files: [...groupFiles].sort((a, b) => basename(a.path).localeCompare(basename(b.path))),
    }))
    .sort((a, b) => {
      if (a.dir === "") return -1;
      if (b.dir === "") return 1;
      return a.dir.localeCompare(b.dir);
    });
}

function isSameFile(a: CrossWorktreeFile, b: CrossWorktreeFile): boolean {
  return a.path === b.path && a.status === b.status;
}

interface CrossWorktreeFileRowProps {
  file: CrossWorktreeFile;
  isSelected: boolean;
  /** The directory band above is shortened or clipped, so the path is not on screen. */
  directoryHidden: boolean;
  onClick: () => void;
}

function CrossWorktreeFileRow({
  file,
  isSelected,
  directoryHidden,
  onClick,
}: CrossWorktreeFileRowProps) {
  const { ref, isTruncated } = useTruncationDetection();
  const status = statusDisplay(file.status);
  const insertions = file.insertions ?? 0;
  const deletions = file.deletions ?? 0;

  return (
    <TruncatedTooltip content={file.path} isTruncated={isTruncated || directoryHidden}>
      <button
        type="button"
        onClick={onClick}
        aria-current={isSelected || undefined}
        aria-label={fileRowLabel(file)}
        data-file-path={file.path}
        className={cn(
          "flex w-full items-center rounded-[var(--radius-lg)] px-1.5 py-1 text-left text-xs font-mono transition-colors duration-150 ease-out",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          isSelected
            ? "bg-overlay-subtle forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1 forced-colors:outline-[Highlight]"
            : "hover:bg-tint/5"
        )}
      >
        <span className={cn("w-4 shrink-0 font-bold", status.color)} aria-hidden="true">
          {status.label}
        </span>
        <span
          ref={ref}
          className={cn(
            "min-w-0 truncate text-text-primary",
            isSelected ? "font-semibold" : "font-medium"
          )}
        >
          {basename(file.path)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-2xs tabular-nums">
          {insertions > 0 && <span className="text-status-success">+{insertions}</span>}
          {deletions > 0 && <span className="text-status-error">-{deletions}</span>}
        </span>
      </button>
    </TruncatedTooltip>
  );
}

function FileGroupSection({
  group,
  selectedFile,
  onOpen,
}: {
  group: FileGroup;
  selectedFile: CrossWorktreeFile | null;
  onOpen: (file: CrossWorktreeFile) => void;
}) {
  const { ref, isTruncated } = useTruncationDetection();
  const label = formatDiffDir(group.dir);
  const directoryHidden = isTruncated || (group.dir !== "" && label !== group.dir);
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 px-1.5 py-1 text-2xs text-text-secondary">
        <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span ref={ref} className="truncate font-mono">
          {label}
        </span>
      </div>
      <div className="flex flex-col gap-px">
        {group.files.map((file) => (
          <CrossWorktreeFileRow
            key={`${file.status}:${file.path}`}
            file={file}
            isSelected={selectedFile !== null && isSameFile(selectedFile, file)}
            directoryHidden={directoryHidden}
            onClick={() => onOpen(file)}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeSetSummary({ files }: { files: CrossWorktreeFile[] }) {
  const { totalInsertions, totalDeletions } = files.reduce(
    (acc, f) => ({
      totalInsertions: acc.totalInsertions + (f.insertions ?? 0),
      totalDeletions: acc.totalDeletions + (f.deletions ?? 0),
    }),
    { totalInsertions: 0, totalDeletions: 0 }
  );

  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="font-medium text-text-primary">
        {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      <span className="flex items-center gap-1.5 font-mono text-2xs tabular-nums">
        {totalInsertions > 0 && <span className="text-status-success">+{totalInsertions}</span>}
        {totalDeletions > 0 && <span className="text-status-error">-{totalDeletions}</span>}
      </span>
    </div>
  );
}

/** Centres a canvas-scale empty state in the diff pane. */
function CanvasState({ children }: { children: ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center p-6">{children}</div>;
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
      // Only a file list is a comparison; anything else would leave the
      // canvas with nothing to say, so it takes the retryable failure path.
      if (!res || typeof res !== "object" || !Array.isArray(res.files)) {
        setError("The comparison came back without a file list.");
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
  const diffWrapLines = usePreferencesStore((s) => s.diffWrapLines);
  const setDiffWrapLines = usePreferencesStore((s) => s.setDiffWrapLines);

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
        // Anything but diff text is a failure the user can retry, not a blank pane.
        const ok = typeof diff === "string";
        setFileDiff(ok ? diff : null);
        setFileDiffError(!ok);
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
  const groups = useMemo(() => (result ? groupComparisonFiles(result.files) : null), [result]);
  // Stepping walks the list in the order it is drawn, not git's output order.
  const files = useMemo(() => groups?.flatMap((group) => group.files) ?? null, [groups]);
  // `null` means auto — prose wraps, code doesn't. Derived from the file on
  // screen during render so the diff is already wrapped on first paint (#12170).
  const effectiveWrapLines =
    diffWrapLines ?? (selectedFile !== null && isProseFilePath(selectedFile.path));

  const selectedFileIndex = useMemo(() => {
    if (!files || !selectedFile) return -1;
    return files.findIndex((f) => isSameFile(f, selectedFile));
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
      // The full path: two files can share a basename, and the list tells
      // them apart by directory band, which a screen reader never hears.
      const position = selectedFileIndex < 0 ? 1 : selectedFileIndex + delta + 1;
      useAnnouncerStore.getState().announce(`${target.path}, file ${position} of ${files.length}`);
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

  // Keep the open file's row in view while stepping with the keyboard.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedFile || !listRef.current) return;
    const row = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-file-path]")).find(
      (el) => el.dataset.filePath === selectedFile.path
    );
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "instant", block: "nearest" });
    }
  }, [selectedFile]);

  // Gated and floored: a fast comparison shows nothing, a slow one shows a
  // skeleton that stays long enough to read as one.
  const showListSkeleton = useSkeletonFloor(useSkeletonGate(loading));
  const showDiffSkeleton = useSkeletonFloor(useSkeletonGate(fileDiffLoading));
  const listReady = !loading && !showListSkeleton;
  const diffReady = !fileDiffLoading && !showDiffSkeleton;

  const baseLabel = leftWorktree ? worktreeOptionLabel(leftWorktree) : null;
  const compareLabel = rightWorktree ? worktreeOptionLabel(rightWorktree) : null;

  let canvas: ReactNode = null;
  if (!leftId || !rightId) {
    canvas = (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<GitCompare />}
        title={leftId ? "Choose a worktree to compare" : "Choose two worktrees to compare"}
        description={
          baseLabel
            ? `Its committed changes are shown against ${baseLabel}. Uncommitted edits aren't included.`
            : "The compare branch's committed changes are shown against the base. Uncommitted edits aren't included."
        }
      />
    );
  } else if (error && !loading) {
    canvas = (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title="Couldn't compare these worktrees"
        description={error}
        action={
          <Button variant="subtle" size="sm" onClick={() => void fetchComparison()}>
            <RefreshCw />
            Retry
          </Button>
        }
      />
    );
  } else if (listReady && result && result.files.length === 0) {
    canvas = (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title="No differences"
        description={`${compareLabel ?? "The compare branch"} has the same committed files as ${baseLabel ?? "the base"}. Uncommitted edits aren't included.`}
      />
    );
  } else if (listReady && result && !selectedFile) {
    canvas = (
      <EmptyState
        variant="user-cleared"
        scale="canvas"
        title="Pick a changed file to see its diff"
      />
    );
  } else if (selectedFile && diffReady && fileDiffError) {
    canvas = (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title="Couldn't load this diff"
        description={selectedFile.path}
        action={
          <Button variant="subtle" size="sm" onClick={() => void fetchFileDiff(selectedFile)}>
            <RefreshCw />
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="6xl"
      maxHeight="max-h-[85vh]"
      className="h-[85vh]"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<GitCompare className="w-4 h-4 text-text-secondary" />}>
          Compare worktrees
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <div className="flex items-end gap-3 px-6 py-3 border-b border-border-default shrink-0">
        <div className="flex-1 min-w-0">
          <WorktreeSelector
            label="Base"
            worktrees={worktrees}
            selectedId={leftId}
            disabledId={rightId}
            onChange={setLeftId}
          />
        </div>
        <span aria-hidden="true" className="pb-2 text-xs text-text-secondary">
          vs
        </span>
        <div className="flex-1 min-w-0">
          <WorktreeSelector
            label="Compare"
            worktrees={worktrees}
            selectedId={rightId}
            disabledId={leftId}
            onChange={setRightId}
          />
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div
          className="flex w-60 shrink-0 flex-col border-r border-border-default bg-surface-sidebar"
          data-testid="cross-worktree-file-shelf"
        >
          {listReady && result && result.files.length > 0 && (
            <div className="shrink-0 border-b border-border-default px-3.5 py-2">
              <ChangeSetSummary files={result.files} />
            </div>
          )}
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1.5"
          >
            {showListSkeleton && (
              <Skeleton label="Comparing files" className="flex flex-col gap-1 py-1">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-1.5 py-1">
                    <SkeletonBone className="w-3 h-3 shrink-0" />
                    <SkeletonBone className={cn("h-3", i % 2 === 0 ? "w-32" : "w-24")} />
                  </div>
                ))}
              </Skeleton>
            )}
            {listReady &&
              groups?.map((group) => (
                <FileGroupSection
                  key={group.dir || "(root)"}
                  group={group}
                  selectedFile={selectedFile}
                  onOpen={(file) => void fetchFileDiff(file)}
                />
              ))}
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-surface-canvas">
          {/* One row for every selected file, not just multi-file comparisons:
              wrap applies to a single-file diff exactly as much, and gating the
              whole row on the file count is what left this surface with no
              reachable toggle at all (#12170). Only stepping is count-gated. */}
          {selectedFile && files && (
            <FileViewerToolbar.Root label="Comparison controls">
              <FileViewerToolbar.Actions>
                {files.length > 1 && (
                  <div
                    role="group"
                    aria-label="File navigation"
                    className="flex items-center gap-1"
                  >
                    <FileViewerToolbar.IconButton
                      label="Previous file"
                      tooltip="Previous file ([)"
                      disabled={selectedFileIndex <= 0}
                      onClick={() => navigateFile(-1)}
                    >
                      <ChevronLeft className={TOOLBAR_ICON_CLASS} />
                    </FileViewerToolbar.IconButton>
                    <span
                      data-testid="cross-worktree-file-position"
                      className="text-xs text-text-secondary tabular-nums"
                    >
                      {selectedFileIndex + 1} of {files.length}
                    </span>
                    <FileViewerToolbar.IconButton
                      label="Next file"
                      tooltip="Next file (])"
                      disabled={selectedFileIndex >= files.length - 1}
                      onClick={() => navigateFile(1)}
                    >
                      <ChevronRight className={TOOLBAR_ICON_CLASS} />
                    </FileViewerToolbar.IconButton>
                  </div>
                )}
                <FileViewerToolbar.IconButton
                  label="Wrap long lines"
                  pressed={effectiveWrapLines}
                  onClick={() => setDiffWrapLines(!effectiveWrapLines)}
                >
                  <WrapText className={TOOLBAR_ICON_CLASS} />
                </FileViewerToolbar.IconButton>
              </FileViewerToolbar.Actions>
            </FileViewerToolbar.Root>
          )}
          <div className="flex-1 overflow-auto diff-scroll-root">
            {canvas && <CanvasState>{canvas}</CanvasState>}
            {selectedFile && showDiffSkeleton && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading diff">
                  <SkeletonBone className="h-7 w-3/4" />
                  <SkeletonText lines={8} />
                </Skeleton>
              </div>
            )}
            {selectedFile && diffReady && !fileDiffError && fileDiff !== null && (
              // Split view is required here — the inline cross-worktree split-pane
              // layout depends on it, so this is not driven by the persisted
              // diffViewType preference. rootPath is the RIGHT worktree's checkout:
              // the new side of the A..B comparison, i.e. the file the user is
              // inspecting.
              <DiffViewer
                diff={fileDiff}
                viewType="split"
                rootPath={rightWorktree?.path}
                wrapLines={effectiveWrapLines}
                onRetry={() => void fetchFileDiff(selectedFile)}
              />
            )}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
