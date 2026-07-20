import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Check, PanelLeft, RefreshCw, WrapText } from "lucide-react";
import { FileDiff as FileDiffIcon } from "lucide-react";
import type { GitStatus } from "@shared/types/git";
import type { DiffPanelData } from "@shared/types/panel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { FileViewerToolbar } from "@/components/FileViewer/FileViewerToolbar";
import { DiffFileSidebar } from "@/components/FileViewer/DiffFileSidebar";
import { ImageDiffViewer, isImageDiffCandidate } from "@/components/FileViewer/ImageDiffViewer";
import { DiffViewer, FULL_FILE_MAX_LINES } from "@/components/Worktree/DiffViewer";
import type { FullFileUnavailableReason } from "@/components/Worktree/DiffViewer";
import { FILE_READ_ERROR_MESSAGES } from "@/components/FileViewer/fileReadErrors";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { IconToggle } from "@/components/FileViewer/IconToggle";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore, type DiffFontSize } from "@/store/preferencesStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { useDiffContent } from "./useDiffContent";
import { useDiffFileSource } from "./useDiffFileSource";
import { getFullFileAvailability } from "./fullFileAvailability";
import type { DiffSubject } from "./diffContentCache";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";

type DiffViewType = "split" | "unified";

/**
 * How much of the file the diff renders. Kept separate from `DiffViewType`:
 * layout and content scope are independent, and full file stays meaningful in
 * both unified and split.
 */
type DiffContentScope = "changes" | "full-file";

const FULL_FILE_FALLBACK_MESSAGES: Record<FullFileUnavailableReason, string> = {
  "source-mismatch": "The file changed after this diff loaded, so only changed lines are shown",
  "too-large": `Files over ${FULL_FILE_MAX_LINES.toLocaleString()} lines stay on changed lines to keep the diff responsive`,
  unsupported: "The whole file can't be shown for this diff",
};

// Mirrors the ladder the modal used, so the preference keeps meaning the same
// sizes it always did.
const DIFF_FONT_SIZE_PX: Record<DiffFontSize, string> = { s: "11px", m: "12px", l: "14px" };

export interface DiffPaneProps extends BasePanelProps {
  tabs?: TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

/**
 * Build the fetch subject for one file, or null when there is nothing to show.
 * Takes the panel's fields rather than the panel so callers can memoize on
 * primitives — the panel object is rebuilt on every worktree poll.
 */
function buildSubject(
  diffSource: DiffPanelData["diffSource"],
  panelBaseBranch: string | undefined,
  worktreePath: string,
  filePath: string | undefined,
  status: GitStatus | undefined,
  currentBranch: string
): DiffSubject | null {
  if (!worktreePath || !filePath) return null;
  if (diffSource === "base-branch") {
    // Without both refs there is no comparison to make; render the empty state
    // rather than asking git to diff against undefined.
    if (!panelBaseBranch || !currentBranch) return null;
    return {
      source: "base-branch",
      worktreePath,
      filePath,
      baseBranch: panelBaseBranch,
      currentBranch,
    };
  }
  return {
    source: diffSource ?? "working-tree",
    worktreePath,
    filePath,
    status: status ?? "modified",
  };
}

export function DiffPane({
  id,
  title,
  isFocused,
  isMaximized,
  location,
  isMultiPanelGrid,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
  worktreeId,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: DiffPaneProps) {
  const panel = usePanelStore((state) => {
    const found = state.panelsById[id];
    return found?.kind === "diff" ? (found as DiffPanelData) : undefined;
  });
  const setDiffPanelFile = usePanelStore((state) => state.setDiffPanelFile);

  // Resolved live rather than persisted, so a worktree rename or move can't
  // strand the panel on a dead path (the ReviewPanelData pattern).
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );
  const currentBranch = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.branch ?? "") : ""),
      [worktreeId]
    )
  );

  const diffViewType = usePreferencesStore((s) => s.diffViewType);
  const setDiffViewType = usePreferencesStore((s) => s.setDiffViewType);
  const diffWrapLines = usePreferencesStore((s) => s.diffWrapLines);
  const setDiffWrapLines = usePreferencesStore((s) => s.setDiffWrapLines);
  const diffFullFile = usePreferencesStore((s) => s.diffFullFile);
  const setDiffFullFile = usePreferencesStore((s) => s.setDiffFullFile);
  const diffShowFileList = usePreferencesStore((s) => s.diffShowFileList);
  const diffFontSize = usePreferencesStore((s) => s.diffFontSize);
  const diffFontStyle: CSSProperties & Record<"--diff-font-size", string> = {
    "--diff-font-size": DIFF_FONT_SIZE_PX[diffFontSize],
  };
  const setDiffShowFileList = usePreferencesStore((s) => s.setDiffShowFileList);

  const filePath = panel?.filePath;
  const fileStatus = panel?.fileStatus;
  const changeSet = panel?.changeSet;
  const diffSource = panel?.diffSource;
  const panelBaseBranch = panel?.baseBranch;
  const panelViewedKey = panel?.viewedKey;

  // Memoized on primitives so the subject identity only moves when what we're
  // diffing does — `useDiffContent` refetches on subject identity.
  const subject = useMemo(
    () =>
      buildSubject(diffSource, panelBaseBranch, worktreePath, filePath, fileStatus, currentBranch),
    [diffSource, panelBaseBranch, worktreePath, filePath, fileStatus, currentBranch]
  );
  const isWorkspace = (changeSet?.length ?? 0) > 1;

  // Resolved by identity, never stored: a change set rebuilt from a later poll
  // can reorder or drop files, so a persisted index would point at the wrong
  // one. `viewedKey` first — it is the only field that separates the staged and
  // unstaged copies of a partially staged file, which share path AND status.
  // Then exact (path + status), then path alone: both fallbacks carry a
  // restored panel (no key) and a file whose status changed under us.
  const currentIndex = useMemo(() => {
    if (!changeSet || filePath === undefined) return -1;
    if (panelViewedKey !== undefined) {
      const byKey = changeSet.findIndex((entry) => entry.viewedKey === panelViewedKey);
      if (byKey !== -1) return byKey;
    }
    const exact = changeSet.findIndex(
      (entry) => entry.path === filePath && entry.status === fileStatus
    );
    if (exact !== -1) return exact;
    return changeSet.findIndex((entry) => entry.path === filePath);
  }, [changeSet, filePath, fileStatus, panelViewedKey]);

  // Survives the open file dropping out of the set, so stepping resumes from
  // where the user was rather than jumping to the top.
  const lastIndexRef = useRef(0);
  useEffect(() => {
    if (currentIndex !== -1) lastIndexRef.current = currentIndex;
  }, [currentIndex]);

  const selectFileAt = useCallback(
    (index: number) => {
      const entry = changeSet?.[index];
      if (!entry) return;
      // Carry the key so the next resolution lands on this exact entry rather
      // than the first one sharing its path and status.
      setDiffPanelFile(id, entry.path, entry.status, entry.viewedKey);
    },
    [changeSet, id, setDiffPanelFile]
  );

  const navigateFile = useCallback(
    (delta: -1 | 1) => {
      if (!changeSet || changeSet.length === 0) return;
      // Clamp against the live length first — a worktree refresh can shrink the
      // set while the panel is open, leaving the resolved index stale.
      const current = Math.min(
        currentIndex === -1 ? lastIndexRef.current : currentIndex,
        changeSet.length - 1
      );
      const next = Math.min(Math.max(current + delta, 0), changeSet.length - 1);
      selectFileAt(next);
    },
    [changeSet, currentIndex, selectFileAt]
  );

  // Warms the next file's diff so forward stepping renders from cache.
  const nextEntry = currentIndex === -1 ? undefined : changeSet?.[currentIndex + 1];
  const nextPath = nextEntry?.path;
  const nextStatus = nextEntry?.status;
  const nextSubject = useMemo(
    () =>
      buildSubject(diffSource, panelBaseBranch, worktreePath, nextPath, nextStatus, currentBranch),
    [diffSource, panelBaseBranch, worktreePath, nextPath, nextStatus, currentBranch]
  );

  const { content, stale, retry } = useDiffContent(subject, nextSubject);

  const viewedSet = useDiffViewedStore(
    useCallback((state) => selectViewedSet(state, worktreePath), [worktreePath])
  );
  const toggleViewed = useDiffViewedStore((state) => state.toggleViewed);
  const currentEntry = currentIndex === -1 ? undefined : changeSet?.[currentIndex];
  const isViewed = currentEntry ? viewedSet.has(currentEntry.viewedKey) : false;

  const [pathCopied, setPathCopied] = useState(false);
  const handleCopyPath = useCallback(() => {
    if (!filePath) return;
    void navigator.clipboard.writeText(filePath).then(() => {
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1500);
    });
  }, [filePath]);

  const hasPrevFile = isWorkspace && currentIndex > 0;
  const hasNextFile =
    isWorkspace && currentIndex !== -1 && currentIndex < (changeSet?.length ?? 0) - 1;

  // `[` / `]` step files and `v` marks the current file viewed — the same keys
  // the modal bound, scoped to this panel so a background one stays inert.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isFocused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        navigateFile(-1);
      } else if (event.key === "]") {
        event.preventDefault();
        navigateFile(1);
      } else if (event.key === "v" && currentEntry && worktreePath) {
        event.preventDefault();
        toggleViewed(worktreePath, currentEntry.viewedKey);
      }
    };
    const root = rootRef.current;
    root?.addEventListener("keydown", onKeyDown);
    return () => root?.removeEventListener("keydown", onKeyDown);
  }, [isFocused, navigateFile, currentEntry, worktreePath, toggleViewed]);

  const isImageMode = Boolean(
    filePath && fileStatus && isImageDiffCandidate(filePath) && panel?.diffSource !== "base-branch"
  );
  // Sentinels the viewer turns into empty states rather than a rendered diff.
  // `NO_CHANGES`/`ERROR` gate the pane's own branches below; the binary and
  // oversized ones matter to the full-file scope, which has nothing to expand
  // when no hunks were rendered in the first place.
  const isDiffSentinel =
    content === "NO_CHANGES" ||
    content === "ERROR" ||
    content === "BINARY_FILE" ||
    content === "FILE_TOO_LARGE";
  const hasDiff = Boolean(content && content.trim() && !isDiffSentinel);

  // Whether this file *can* show its whole contents, independent of whether the
  // user currently wants to — the toggle stays visible either way so the option
  // is discoverable, and explains itself when it can't be used.
  const sourceAvailability = useMemo(
    () => getFullFileAvailability(diffSource, fileStatus),
    [diffSource, fileStatus]
  );
  // An image diff already shows the whole asset, and a diff that hasn't loaded
  // has nothing to expand — folding both into the availability verdict keeps
  // the control from looking live while being inert.
  const fullFileAvailability: typeof sourceAvailability = !sourceAvailability.available
    ? sourceAvailability
    : isImageMode
      ? { available: false, reason: "This view already shows the whole image" }
      : !hasDiff
        ? { available: false, reason: "There's no diff to expand yet" }
        : { available: true };

  // The hunks and the file on disk must describe the same revision. Once the
  // store reports the file changed, they demonstrably don't: the check inside
  // the viewer only covers lines the hunks name, so a change in a hidden gap
  // would otherwise be rendered as unchanged context.
  const wantsFullFile = diffFullFile && fullFileAvailability.available && !stale;

  const sourceSubject = useMemo(
    () => (worktreePath && filePath ? { worktreePath, filePath } : null),
    [worktreePath, filePath]
  );
  const { source, errorCode: sourceErrorCode } = useDiffFileSource(sourceSubject, wantsFullFile);

  // Reported by the viewer once it has the parsed diff and the source side by
  // side — the mismatch and size checks can only be made there.
  //
  // Stamped with the source it describes rather than cleared by an effect:
  // child effects run before parent ones, so a reset keyed on `source` would
  // fire in the same commit that the viewer reported its reason and swallow it.
  const [viewerVerdict, setViewerVerdict] = useState<{
    source: string | null | undefined;
    reason: FullFileUnavailableReason | null;
  } | null>(null);
  const handleFullFileVerdict = useCallback(
    (reason: FullFileUnavailableReason | null, forSource: string | null | undefined) => {
      setViewerVerdict({ source: forSource, reason });
    },
    []
  );
  const activeViewerFallback =
    viewerVerdict && viewerVerdict.source === source ? viewerVerdict.reason : null;

  // Only the diff is retried: clearing it drops `hasDiff`, which disables the
  // source hook and invalidates its read, and the source is fetched again when
  // the new diff lands. Retrying both here would issue that read twice.
  const refreshAll = useCallback(() => {
    retry();
  }, [retry]);

  // One line explaining why a requested whole-file view isn't on screen. The
  // read failure wins over the viewer's verdict: without content the viewer
  // never got far enough to have one. `recoverable` marks the notices a refresh
  // can actually clear — a hunkless rename never grows hunks and an over-size
  // file never shrinks, so those get no action rather than one that can't work.
  const fullFileNotice: { message: string; recoverable: boolean } | null = wantsFullFile
    ? sourceErrorCode
      ? { message: FILE_READ_ERROR_MESSAGES[sourceErrorCode], recoverable: true }
      : activeViewerFallback
        ? {
            message: FULL_FILE_FALLBACK_MESSAGES[activeViewerFallback],
            recoverable: activeViewerFallback === "source-mismatch",
          }
        : null
    : null;

  // The reason rides an aria-describedby rather than the tooltip alone: a
  // disabled segment takes no focus, so a keyboard or screen-reader user would
  // never reach a hover-only explanation.
  const scopeReasonId = `${id}-full-file-reason`;
  const scopeToggle = (
    <div
      role="group"
      aria-label="Diff content"
      aria-describedby={fullFileAvailability.available ? undefined : scopeReasonId}
    >
      <SegmentedToggle<DiffContentScope>
        options={[
          { value: "changes", label: "Changes" },
          {
            value: "full-file",
            label: "Full file",
            disabled: !fullFileAvailability.available,
          },
        ]}
        value={wantsFullFile && !fullFileNotice ? "full-file" : "changes"}
        onChange={(next) => setDiffFullFile(next === "full-file")}
      />
      {!fullFileAvailability.available && (
        <span id={scopeReasonId} className="sr-only">
          {fullFileAvailability.reason}
        </span>
      )}
    </div>
  );

  const fileName = filePath?.split(/[/\\]/).filter(Boolean).pop();
  const displayTitle = panel?.titleMode === "user" ? title : (fileName ?? title);

  const toolbar = filePath ? (
    <>
      <FileViewerToolbar.Root>
        <div role="group" aria-label="Diff layout">
          <SegmentedToggle<DiffViewType>
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
            value={diffViewType}
            onChange={setDiffViewType}
          />
        </div>
        {fullFileAvailability.available ? (
          scopeToggle
        ) : (
          // A disabled segment can't host a tooltip trigger of its own
          // (pointer-events are off), so the explanation hangs off the wrapper.
          <Tooltip>
            <TooltipTrigger asChild>{scopeToggle}</TooltipTrigger>
            <TooltipContent side="bottom">{fullFileAvailability.reason}</TooltipContent>
          </Tooltip>
        )}
        <FileViewerToolbar.Path path={filePath} copied={pathCopied} onCopy={handleCopyPath} />
        <FileViewerToolbar.Actions>
          <FileViewerToolbar.IconButton
            label="Wrap long lines"
            pressed={diffWrapLines}
            onClick={() => setDiffWrapLines(!diffWrapLines)}
          >
            <WrapText className="w-4 h-4" />
          </FileViewerToolbar.IconButton>
          <FileViewerToolbar.IconButton label="Refresh" onClick={retry}>
            <RefreshCw className="w-4 h-4" />
          </FileViewerToolbar.IconButton>
        </FileViewerToolbar.Actions>
      </FileViewerToolbar.Root>
      {stale && hasDiff && (
        <InlineStatusBanner
          severity="info"
          icon={FileDiffIcon}
          title="File changed since this diff loaded"
          role="status"
          ariaLive="polite"
          action={{ id: "refresh-diff", label: "Refresh", icon: RefreshCw, onClick: refreshAll }}
        />
      )}
      {/* Suppressed while the staleness banner is up: both would be pointing at
          the same underlying change and offering the same refresh. */}
      {fullFileNotice && !stale && (
        <InlineStatusBanner
          severity="warning"
          icon={FileDiffIcon}
          title="Showing changed lines only"
          description={fullFileNotice.message}
          role="status"
          ariaLive="polite"
          action={
            fullFileNotice.recoverable
              ? { id: "refresh-full-file", label: "Retry", icon: RefreshCw, onClick: refreshAll }
              : undefined
          }
        />
      )}
    </>
  ) : undefined;

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="diff"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      showRestoreControl={showRestoreControl}
      toolbar={toolbar}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      {/* Keydown host for the file-stepping shortcuts: the listener rides
          bubbling from whatever inside actually holds focus, so the container
          needs no tabIndex (and no outline suppression) of its own. */}
      <div ref={rootRef} className="flex flex-1 min-h-0">
        {isWorkspace && diffShowFileList && changeSet && (
          <DiffFileSidebar
            files={changeSet}
            currentIndex={currentIndex}
            worktreePath={worktreePath}
            onSelect={(index) => {
              if (index === currentIndex) return;
              selectFileAt(index);
            }}
          />
        )}
        {/* `DiffViewer.css` reads `--diff-font-size`; declaring it here is what
            makes the size preference reach the rendered diff. */}
        <div
          className="relative flex-1 min-w-0 min-h-0 flex flex-col"
          style={diffFontStyle}
          data-testid="diff-pane-body"
        >
          <div className="flex-1 min-h-0 overflow-auto diff-scroll-root">
            {!filePath && (
              <div className="flex h-full w-full items-center justify-center p-6">
                <EmptyState
                  variant="user-cleared"
                  scale="canvas"
                  title="Pick a changed file to see its diff"
                />
              </div>
            )}

            {/* A file is set but nothing can be fetched for it: the worktree
                didn't resolve, or a base-branch panel is missing a ref. The
                skeleton below would otherwise spin forever, since `fetchDiff`
                returns early on a null subject and Refresh with it. */}
            {filePath && !subject && (
              <div className="flex h-full w-full items-center justify-center p-6">
                <EmptyState
                  variant="zero-data"
                  scale="canvas"
                  title="Diff unavailable"
                  description={
                    diffSource === "base-branch"
                      ? "The base or current branch couldn't be resolved, so there's no comparison to make."
                      : "This panel's worktree couldn't be resolved — it may have been moved or removed."
                  }
                />
              </div>
            )}

            {filePath && subject && isImageMode && fileStatus && (
              <div className="h-full min-h-[300px]">
                <ImageDiffViewer
                  relPath={filePath}
                  worktreePath={worktreePath}
                  status={fileStatus}
                />
              </div>
            )}

            {filePath && subject && !isImageMode && content && (
              <DiffViewer
                diff={content}
                viewType={diffViewType}
                rootPath={worktreePath}
                source={wantsFullFile ? source : undefined}
                fullFile={wantsFullFile}
                onFullFileVerdict={handleFullFileVerdict}
                wrapLines={diffWrapLines}
                onRetry={retry}
              />
            )}

            {filePath && subject && !isImageMode && !content && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading diff">
                  <SkeletonBone className="h-7 w-3/4" />
                  <SkeletonText lines={8} />
                </Skeleton>
              </div>
            )}
          </div>
        </div>
      </div>

      {(isWorkspace || currentEntry !== undefined) && (
        <div
          data-testid="diff-pane-footer"
          className="flex items-center justify-between gap-3 px-4 py-1.5 border-t border-border-strong bg-surface-panel shrink-0"
        >
          <div className="flex items-center gap-1 min-w-0">
            {isWorkspace && (
              <IconToggle
                pressed={diffShowFileList}
                label="Show file list"
                onToggle={() => setDiffShowFileList(!diffShowFileList)}
              >
                <PanelLeft className="w-4 h-4" />
              </IconToggle>
            )}
            {isWorkspace && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => navigateFile(-1)}
                      disabled={!hasPrevFile}
                      aria-label="Previous file"
                      className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Previous file ([)</TooltipContent>
                </Tooltip>
                <span
                  data-testid="diff-file-position-indicator"
                  className="text-xs text-muted-foreground tabular-nums"
                >
                  {currentIndex + 1} of {changeSet?.length ?? 0}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => navigateFile(1)}
                      disabled={!hasNextFile}
                      aria-label="Next file"
                      className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Next file (])</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
          {currentEntry && worktreePath && (
            <IconToggle
              pressed={isViewed}
              label="Viewed"
              onToggle={() => toggleViewed(worktreePath, currentEntry.viewedKey)}
            >
              <Check className="w-4 h-4" />
              <span className="text-xs">Viewed</span>
            </IconToggle>
          )}
        </div>
      )}
    </ContentPanel>
  );
}
