import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useId,
  type ReactNode,
} from "react";
import { DiffStat } from "@/components/ui/DiffStat";
import {
  GitCompare,
  ChevronLeft,
  ChevronRight,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  WrapText,
} from "lucide-react";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useRovingRows, type UseRovingRowsResult } from "@/hooks/useRovingRows";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { AppDialog } from "@/components/ui/AppDialog";
import type { GitStatus } from "@shared/types";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";
import { basename, dirname } from "@shared/utils/path";
import { DiffFilePath, DiffViewer, type DiffViewerSideLabels } from "./DiffViewer";
import { WorktreeSelector } from "./WorktreeSelector";
import {
  WHOLE_FILE_CONTEXT_LINES,
  committedSourceFromFullDiff,
  sortWorktreesForComparison,
  worktreeOptionLabel,
} from "./crossWorktreeDiffUtils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { usePreferencesStore, type DiffViewType } from "@/store/preferencesStore";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { diffFontStyle } from "./diffFontSize";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { DIFF_STATUS_CONFIG, formatDiffDir } from "@/components/FileViewer/diffChangeSet";
import { isProseFilePath } from "@/components/FileViewer/isProseFile";
import { pluralize } from "@/lib/pluralize";

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
  roving: RowRoving;
}

type RowRoving = Pick<UseRovingRowsResult, "tabStopKey" | "onRowFocus" | "rowRef">;

const fileKey = (file: CrossWorktreeFile) => `${file.status}:${file.path}`;

function CrossWorktreeFileRow({
  file,
  isSelected,
  directoryHidden,
  onClick,
  roving,
}: CrossWorktreeFileRowProps) {
  const key = fileKey(file);
  const { ref, isTruncated } = useTruncationDetection();
  const status = statusDisplay(file.status);
  const insertions = file.insertions ?? 0;
  const deletions = file.deletions ?? 0;

  return (
    <TruncatedTooltip content={file.path} isTruncated={isTruncated || directoryHidden}>
      <button
        type="button"
        onClick={onClick}
        ref={roving.rowRef(key)}
        data-roving-row=""
        // One tab stop for the shelf; the arrow keys move it.
        tabIndex={roving.tabStopKey === key ? 0 : -1}
        onFocus={() => roving.onRowFocus(key)}
        aria-current={isSelected || undefined}
        // A list-detail row, not a listbox option: `aria-current` for AT and
        // `data-selected` for the shared selected-row fill (and its forced-colors
        // outline, which `.palette-row` carries).
        data-selected={isSelected ? "true" : undefined}
        aria-label={fileRowLabel(file)}
        data-file-path={file.path}
        className={cn(
          LIST_DETAIL_ROW_CLASS,
          "flex w-full items-center rounded-[var(--radius-md)] px-1.5 py-1 text-left text-xs font-mono",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
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
        <DiffStat
          insertions={insertions}
          deletions={deletions}
          className="ml-auto shrink-0 pl-2 text-2xs"
        />
      </button>
    </TruncatedTooltip>
  );
}

function FileGroupSection({
  group,
  selectedFile,
  onOpen,
  roving,
}: {
  group: FileGroup;
  selectedFile: CrossWorktreeFile | null;
  onOpen: (file: CrossWorktreeFile) => void;
  roving: RowRoving;
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
            key={fileKey(file)}
            roving={roving}
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
      <span className="font-medium text-text-primary">{pluralize(files.length, "file")}</span>
      <DiffStat insertions={totalInsertions} deletions={totalDeletions} className="text-2xs" />
    </div>
  );
}

/**
 * Below this the canvas renders unified whatever the saved layout says: two
 * columns of code under ~450px each clip most real lines. The breakpoint is VS
 * Code's (`diffEditor.renderSideBySideInlineBreakpoint`), and like VS Code the
 * fallback never overwrites the preference, so split returns with the room.
 */
const SPLIT_MIN_WIDTH = 900;

/**
 * Width of an element, tracked across resizes; null until first measured.
 * Takes the element itself rather than a ref: the dialog mounts its body only
 * while open, so a ref read once at mount would never see the canvas.
 */
function useElementWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const measured = element.getBoundingClientRect().width;
      // Zero is a hidden or not-yet-laid-out box, not a narrow one.
      if (measured > 0) setWidth(Math.round(measured));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * The comparison's own controls, carried in the diff's sticky file header
 * rather than a row of their own: one tab stop with the arrow keys between
 * them, the APG toolbar pattern the separate row had.
 */
function ComparisonControls({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref);
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Comparison controls"
      data-comparison-controls=""
      onKeyDown={onKeyDown}
      className="flex items-center gap-1.5"
    >
      {children}
    </div>
  );
}

/** What the viewer renders as a message rather than a diff, with no file header. */
const DIFF_SENTINELS: ReadonlySet<string> = new Set([
  "",
  "NO_CHANGES",
  "BINARY_FILE",
  "FILE_TOO_LARGE",
  "ERROR",
]);

/** Centres a canvas-scale empty state in the diff pane. */
function CanvasState({ children }: { children: ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center p-6">{children}</div>;
}

export function CrossWorktreeDiff({ isOpen, onClose, initialWorktreeId }: CrossWorktreeDiffProps) {
  const shelfId = useId();
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
  // The compare side's committed text for the open file, read with its diff.
  const [fileSource, setFileSource] = useState<string | null>(null);

  // Request tokens to guard stale async responses
  const compareTokenRef = useRef(0);
  const fileDiffTokenRef = useRef(0);
  const selectedFileRef = useRef<CrossWorktreeFile | null>(null);
  const fileDiffRef = useRef<string | null>(null);
  // The key of the comparison `result` belongs to, so a rerun for the same
  // comparison can refresh in place instead of starting over.
  const resultKeyRef = useRef<string | null>(null);

  // Initialize / reset state when modal opens or closes
  useEffect(() => {
    if (!isOpen) {
      resultKeyRef.current = null;
      compareTokenRef.current++;
      fileDiffTokenRef.current++;
      setLeftId(null);
      setRightId(null);
      setResult(null);
      setSelectedFile(null);
      setFileDiff(null);
      setFileSource(null);
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

  // The comparison is branch against branch, so it depends on these values and
  // not on the snapshot objects, which the store replaces for every status or
  // activity update in either worktree (#15009).
  const leftPath = leftWorktree?.path;
  const leftBranch = leftWorktree?.branch;
  const rightBranch = rightWorktree?.branch;
  const leftHead = leftWorktree?.worktreeChanges?.headOid;
  const rightHead = rightWorktree?.worktreeChanges?.headOid;
  const comparisonKey = JSON.stringify([leftId, rightId, leftPath, leftBranch, rightBranch]);

  const ignoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);
  const diffWrapLines = usePreferencesStore((s) => s.diffWrapLines);
  const setDiffWrapLines = usePreferencesStore((s) => s.setDiffWrapLines);
  const diffViewType = usePreferencesStore((s) => s.diffViewType);
  const setDiffViewType = usePreferencesStore((s) => s.setDiffViewType);
  const diffShowFileList = usePreferencesStore((s) => s.diffShowFileList);
  const setDiffShowFileList = usePreferencesStore((s) => s.setDiffShowFileList);
  const diffFontSize = usePreferencesStore((s) => s.diffFontSize);

  // A refresh keeps the diff on screen until the new one lands and ignores
  // failures, so a background update never swaps what is being read for a
  // loading state or an error. With no diff on screen there is nothing to
  // protect, and the request it replaces may still owe the user an error.
  const fetchFileDiff = useCallback(
    async (file: CrossWorktreeFile, wantRefresh = false) => {
      if (!leftPath || !leftBranch || !rightBranch) return;

      const refresh = wantRefresh && fileDiffRef.current !== null;
      const token = ++fileDiffTokenRef.current;

      setSelectedFile(file);
      if (!refresh) {
        setFileDiff(null);
        setFileSource(null);
        setFileDiffError(false);
        setFileDiffLoading(true);
      }

      // Hidden context comes from the same refs as the patch, asked for in the
      // same breath: a whole-file diff carries the compare side's committed
      // text. Only a file present on both sides has gaps to fill, and a failed
      // read costs the expanders, never the diff.
      const expandable = file.status === "M" || file.status === "R" || file.status === "C";
      const sourceRequest = expandable
        ? window.electron.git
            .compareWorktrees(
              leftPath,
              leftBranch,
              rightBranch,
              file.path,
              undefined,
              undefined,
              WHOLE_FILE_CONTEXT_LINES
            )
            .then((full) => (typeof full === "string" ? committedSourceFromFullDiff(full) : null))
            .catch(() => null)
        : Promise.resolve(null);

      try {
        const [diff, source] = await Promise.all([
          window.electron.git.compareWorktrees(
            leftPath,
            leftBranch,
            rightBranch,
            file.path,
            undefined,
            ignoreWhitespace
          ),
          sourceRequest,
        ]);
        if (token !== fileDiffTokenRef.current) return; // stale response
        // Anything but diff text is a failure the user can retry, not a blank pane.
        const ok = typeof diff === "string";
        if (ok) {
          setFileDiff(diff);
          setFileSource(source);
          setFileDiffError(false);
        } else if (!refresh) {
          setFileDiff(null);
          setFileSource(null);
          setFileDiffError(true);
        }
      } catch {
        if (token !== fileDiffTokenRef.current) return;
        if (!refresh) {
          setFileDiff(null);
          setFileSource(null);
          setFileDiffError(true);
        }
      } finally {
        if (token === fileDiffTokenRef.current) setFileDiffLoading(false);
      }
    },
    [leftPath, leftBranch, rightBranch, ignoreWhitespace]
  );

  // Layout, not passive: a response can land between commit and passive effects.
  useLayoutEffect(() => {
    selectedFileRef.current = selectedFile;
    fileDiffRef.current = fileDiff;
  }, [selectedFile, fileDiff]);

  const fetchComparison = useCallback(
    async (refresh = false) => {
      if (!leftPath || !leftBranch || !rightBranch) return;
      if (leftBranch === rightBranch) return;

      const token = ++compareTokenRef.current;

      if (!refresh) {
        resultKeyRef.current = null;
        fileDiffTokenRef.current++;
        setLoading(true);
        setError(null);
        setResult(null);
        setSelectedFile(null);
        setFileDiff(null);
        setFileSource(null);
        setFileDiffError(false);
        setFileDiffLoading(false);
      }

      try {
        const res = await window.electron.git.compareWorktrees(leftPath, leftBranch, rightBranch);
        if (token !== compareTokenRef.current) return; // stale response
        // Only a file list is a comparison; anything else would leave the
        // canvas with nothing to say, so it takes the retryable failure path.
        if (!res || typeof res !== "object" || !Array.isArray(res.files)) {
          if (!refresh) setError("The comparison came back without a file list.");
          return;
        }
        resultKeyRef.current = comparisonKey;
        setResult(res);
        if (!refresh) {
          // Land on the first file in the order the shelf draws it, so the
          // canvas opens on a diff to read rather than a prompt to pick one.
          const first = groupComparisonFiles(res.files)[0]?.files[0];
          if (first) void fetchFileDiff(first);
        }
        if (refresh) {
          const open = selectedFileRef.current;
          const kept = open ? res.files.find((f) => isSameFile(f, open)) : undefined;
          if (kept) {
            void fetchFileDiff(kept, true);
          } else {
            fileDiffTokenRef.current++;
            setSelectedFile(null);
            setFileDiff(null);
            setFileSource(null);
            setFileDiffError(false);
            setFileDiffLoading(false);
          }
        }
      } catch (err) {
        if (token !== compareTokenRef.current) return;
        if (!refresh) setError(formatErrorMessage(err, "Failed to compare worktrees"));
      } finally {
        if (token === compareTokenRef.current) setLoading(false);
      }
    },
    [leftPath, leftBranch, rightBranch, comparisonKey, fetchFileDiff]
  );

  // Auto-fetch when both sides are selected, and again when either branch
  // moves to a new commit. Only that second case may refresh in place.
  useEffect(() => {
    if (leftId && rightId && leftId !== rightId) {
      void fetchComparison(resultKeyRef.current === comparisonKey);
    }
    // The heads are triggers, not inputs: a new commit reruns the comparison.
  }, [leftId, rightId, comparisonKey, leftHead, rightHead, fetchComparison]);

  // File stepping through the comparison set, mirroring the diff modals:
  // `[` / `]` keys plus a footer stepper in the diff panel.
  const groups = useMemo(() => (result ? groupComparisonFiles(result.files) : null), [result]);
  const rovingKeys = useMemo(
    () => groups?.flatMap((group) => group.files.map(fileKey)) ?? [],
    [groups]
  );
  const roving = useRovingRows({
    keys: rovingKeys,
    preferredKey: selectedFile ? fileKey(selectedFile) : null,
  });
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

  const refocusLabelRef = useRef<string | null>(null);
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
      // Stepping from a header control unmounts it with the diff it sat on;
      // remember which one so focus can follow it into the next header.
      const active = document.activeElement;
      refocusLabelRef.current =
        active instanceof HTMLElement && active.closest("[data-comparison-controls]")
          ? active.getAttribute("aria-label")
          : null;
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

  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  const canvasWidth = useElementWidth(canvasElement);
  const splitFits = canvasWidth === null || canvasWidth >= SPLIT_MIN_WIDTH;
  const effectiveViewType: DiffViewType =
    diffViewType === "split" && splitFits ? "split" : "unified";

  // The shelf can only be put away while a file is open: with nothing on the
  // canvas, the list is the only thing to act on.
  const hasFiles = listReady && result !== null && result.files.length > 0;
  const showShelf =
    (showListSkeleton && diffShowFileList) || (hasFiles && (diffShowFileList || !selectedFile));

  const rightPath = rightWorktree?.path;

  const sideLabels = useMemo<DiffViewerSideLabels | undefined>(
    () =>
      leftBranch && rightBranch
        ? {
            old: { role: "Base", name: leftBranch },
            new: { role: "Compare", name: rightBranch },
          }
        : undefined,
    [leftBranch, rightBranch]
  );

  const baseLabel = leftWorktree ? worktreeOptionLabel(leftWorktree) : null;
  const compareLabel = rightWorktree ? worktreeOptionLabel(rightWorktree) : null;

  const fileListToggle = (
    <FileViewerToolbar.IconButton
      label="Toggle file list"
      expanded={diffShowFileList}
      controls={showShelf ? shelfId : undefined}
      sidebarToggle
      onClick={() => setDiffShowFileList(!diffShowFileList)}
    >
      {diffShowFileList ? (
        <PanelLeftClose className={TOOLBAR_ICON_CLASS} />
      ) : (
        <PanelLeftOpen className={TOOLBAR_ICON_CLASS} />
      )}
    </FileViewerToolbar.IconButton>
  );

  const comparisonControls = files ? (
    <ComparisonControls>
      <SegmentedRadioGroup<DiffViewType>
        aria-label="Diff layout"
        options={[
          { value: "unified", label: "Unified" },
          {
            value: "split",
            label: "Split",
            disabled: !splitFits,
            tooltip: splitFits ? undefined : "Needs a wider window",
          },
        ]}
        value={effectiveViewType}
        onChange={setDiffViewType}
        density="compact"
      />
      {files.length > 1 && (
        <div role="group" aria-label="File navigation" className="flex items-center gap-1">
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
    </ComparisonControls>
  ) : null;

  // The diff's own header carries these once it renders. Until then (loading,
  // a failed read, a binary or oversized file) this row stands in for it, so
  // the way to another file never disappears with the one that failed.
  const diffHeaderShown =
    selectedFile !== null &&
    diffReady &&
    !fileDiffError &&
    fileDiff !== null &&
    !DIFF_SENTINELS.has(fileDiff);

  // The control a step was taken from is replaced twice: by the stand-in row
  // while the next file loads, then by the new diff's own header. Each time
  // focus drops to the body, hand it to the control with the same name.
  useLayoutEffect(() => {
    const label = refocusLabelRef.current;
    if (!label || !canvasElement) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      // Moved on by the user, or already landed in the diff's own header.
      if (!active.closest("[data-comparison-controls]") || diffHeaderShown) {
        refocusLabelRef.current = null;
      }
      return;
    }
    const target = Array.from(
      canvasElement.querySelectorAll<HTMLElement>("[data-comparison-controls] [aria-label]")
    ).find((element) => element.getAttribute("aria-label") === label);
    target?.focus({ preventScroll: true });
    if (diffHeaderShown) refocusLabelRef.current = null;
  }, [canvasElement, diffHeaderShown, selectedFile, fileDiff]);

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

      <div className="flex items-end gap-3 px-6 py-3 border-b border-divider shrink-0">
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
        {showShelf && (
          <div
            id={shelfId}
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
              onKeyDown={roving.onKeyDown}
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
                    roving={roving}
                  />
                ))}
            </div>
          </div>
        )}

        <div
          ref={setCanvasElement}
          className="flex-1 min-w-0 flex flex-col overflow-hidden bg-surface-canvas"
          style={diffFontStyle(diffFontSize)}
        >
          {selectedFile && !diffHeaderShown && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-default bg-surface-sidebar px-3 py-1.5 font-mono text-xs">
              <div className="-ml-1.5 flex shrink-0 items-center">{fileListToggle}</div>
              <DiffFilePath path={selectedFile.path} />
              <div className="flex shrink-0 items-center gap-2 font-sans text-text-secondary">
                {comparisonControls}
              </div>
            </div>
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
            {selectedFile && diffReady && !fileDiffError && fileDiff !== null && files && (
              // rootPath is the compare worktree's checkout: the new side of the
              // base..compare comparison, i.e. the file the user is inspecting.
              <DiffViewer
                diff={fileDiff}
                viewType={effectiveViewType}
                rootPath={rightPath}
                source={fileSource}
                wrapLines={effectiveWrapLines}
                onRetry={() => void fetchFileDiff(selectedFile)}
                sideLabels={sideLabels}
                headerLeading={fileListToggle}
                headerActions={comparisonControls}
              />
            )}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
