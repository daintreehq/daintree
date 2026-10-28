import { DiffStat } from "@/components/ui/DiffStat";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import type { StagingFileEntry, GitStatus } from "@shared/types";
import type { PanelLocation } from "@shared/types/panel";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import { cn } from "@/lib/utils";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";

import { RefreshCw, CircleCheck, ArrowUpFromLine, ChevronRight, AlertTriangle } from "lucide-react";
import { BookmarkCheck } from "@/components/icons";
import { isProtectedBranch } from "@shared/utils/gitConstants";
import { useUIStore } from "@/store/uiStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectStore } from "@/store/projectStore";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import type { DiffChangeSetEntry } from "@/components/FileViewer/diffChangeSet";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { basename, join } from "@shared/utils/path";
import { useFileRowMenuItems } from "@/hooks/useFileRowMenuItems";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeIdForPath } from "@/panels/diff/useWorktreeIdForPath";
import { type FileStageRowSection } from "./FileStageRow";
import { FileSection } from "./FileSection";
import { BaseBranchFileList } from "./BaseBranchFileList";
import {
  useReviewHubStagingActions,
  type ReviewHubActionFailure,
} from "./useReviewHubStagingActions";
import { PushErrorBanner } from "./PushErrorBanner";
import { PrStatusChip } from "./PrStatusChip";
import { ReviewHubContext } from "./ReviewHubContext";
import { CommitPanel } from "./CommitPanel";
import { ConflictPanel } from "./ConflictPanel";
import { ReadinessRail } from "./ReadinessRail";
import { useReviewHubStatus } from "./useReviewHubStatus";
import { useReviewMarksStore } from "@/store/reviewMarksStore";
import { useReviewHubMark } from "./useReviewHubMark";
import { ReviewMarkLine } from "./ReviewMarkLine";
import { SinceReviewPanel } from "./SinceReviewPanel";
import { describeSinceReview, sinceReviewUnavailableReason } from "./reviewMarkComparison";
import { registerReviewHubMarkTarget } from "./reviewHubMarkTargets";
import { useReviewHubBaseBranch } from "./useReviewHubBaseBranch";
import { useReviewHubCommitAndPush } from "./useReviewHubCommitAndPush";
import { useReviewHubRowSelection } from "./useReviewHubRowSelection";
import { useReviewHubFileCursor } from "./useReviewHubFileCursor";
import { useReviewHubKeyboard } from "./useReviewHubKeyboard";
import { PluginReadinessChecks, useWorktreeReviewPluginChecks } from "./PluginReadinessChecks";
import {
  deriveReviewReadiness,
  type ReviewReadinessCta,
  type ReviewReadinessItem,
  type ReviewReadinessSummary,
} from "./reviewReadiness";
// Lazy: these modals statically reach the DiffViewer/CodeViewer/vendor-editor
// chunks (~223 KB gzip), and ReviewPane is a first-render preload seed — a
// static import drags the whole editor stack into every boot's modulepreload
// list. The modals open only on row click, so the chunk fetch overlaps user
// think-time; useKeepMounted gates the first mount so nothing is fetched (or
// rendered) until a diff is actually opened.
import { Button } from "@/components/ui/button";
import {
  SurfaceHeader,
  SurfaceHeaderCloseButton,
  SURFACE_HEADER_FOCUS_LIFT_CLASS,
} from "@/components/ui/SurfaceHeader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useFileDecorations } from "@/hooks/useFileDecorations";
import {
  useForgeProviderHealthStore,
  selectForgeProviderHealth,
} from "@/store/forgeProviderHealthStore";
import { useShallow } from "zustand/react/shallow";
import { systemClient } from "@/clients/systemClient";
import { announceOpenInEditorFallback } from "@/utils/openInEditorFallback";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  type DiffMode,
  type SectionViewState,
  DEFAULT_SECTION_STATE,
  matchesFilter,
  REVIEW_HUB_COUNT_CHIP,
  REVIEW_HUB_SECTION_BAND,
  REVIEW_HUB_STICKY_BAND,
  resolveBulkScope,
  sortFiles,
  sumChurn,
} from "./reviewHubUtils";
import { isGeneratedFile } from "../generatedFileClassifier";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { BranchBadge } from "@/components/ui/BranchBadge";
import { Badge } from "@/components/ui/badge";
import { pluralize } from "@/lib/pluralize";

/**
 * Floor for the dialog-hosted body, so the pane stops resizing itself around
 * its own content as it moves between loading, failure, empty and resolved.
 * Named rather than inlined to match `McpConfirmDialog`'s
 * `PREVIEW_MIN_BODY_HEIGHT`, which reserves a dialog body for the same reason.
 */
const DIALOG_MIN_BODY_HEIGHT = "min-h-[22rem]";

/** Ragged widths so the loading rows read as file paths, not as a table. */
const SKELETON_FILE_ROW_WIDTHS = ["w-64", "w-48", "w-56"] as const;

export interface ReviewHubContentProps {
  /**
   * Drives the open/close lifecycle: starts the staging-status fetch and
   * worktree subscription on `true`, atomically resets all internal state on
   * `false`. Mirrors the prior `<ReviewHub isOpen>` semantics so callers that
   * want to keep the component mounted across open/close cycles can do so by
   * toggling this prop.
   */
  isOpen: boolean;
  worktreePath: string;
  onClose: () => void;
  /**
   * Id of the panel record hosting this content, when it has one. Used to layer
   * a per-file diff above this surface instead of replacing it, so the staging
   * state survives a drill-down.
   */
  panelId?: string;
  /**
   * Where this content is presented. At `"dialog"` the host already draws a
   * title and close control, so this component suppresses its own rather than
   * drawing them twice — mirroring `ContentPanel`'s handling of the same
   * location. Defaults to `"grid"`.
   */
  location?: PanelLocation;
  /**
   * Whether the hosting pane has the keyboard. Review renders no PanelHeader,
   * so its own title bar takes the focused-pane lift a PanelHeader would —
   * in the grid only, as PanelHeader does (the dock keeps its flat bar and a
   * dialog draws no bar of ours at all).
   */
  isFocused?: boolean;
  /**
   * Where to attach the Escape-key listener. Defaults to `document` so the
   * modal shell continues to capture Escape globally. Non-modal callers can
   * pass a scoped element to confine Escape to their panel. `undefined`/`null`
   * both fall back to `document`; if you intend a scoped element but the ref
   * isn't attached yet, gate the prop yourself rather than passing `null`.
   */
  keyboardScope?: Document | HTMLElement | null;
  /**
   * Seed value for the commit message on open. The first open after `isOpen`
   * flips from false to true populates the textarea with this value if it is
   * not empty; subsequent edits by the user are preserved. Reset to empty on
   * close so a future reopen without a seed starts blank.
   */
  initialCommitMessage?: string;
  /**
   * When true, stage all unstaged files on open if there are no staged files
   * yet. Fires once per open; reopening the hub re-evaluates.
   */
  autoStageOnOpen?: boolean;
  /**
   * Open into the "Since review" view rather than the working tree. Applied on
   * each open, and falls back to the working tree if the worktree has no mark.
   */
  initialMode?: "since-review";
}

const selectNoProviderHealth = () => null;

/**
 * Self-contained Review & Commit surface. All staging-status fetches,
 * subscriptions, push/pull-rebase IPC, and UI interaction state live in this
 * component so it can be rendered inside the existing modal shell
 * (`<ReviewHub>`) or, in the future, inside a non-modal panel kind. The
 * `isOpen` prop drives the start/reset lifecycle: when it flips from false to
 * true the staging fetch + worktree subscription arm; when it flips back to
 * false every transient field is reset atomically so a later reopen starts
 * from a clean slate (preserves the lesson-4958 atomic-reset invariant).
 */
export function ReviewHubContent({
  isOpen,
  worktreePath,
  onClose,
  panelId,
  location = "grid",
  isFocused = false,
  keyboardScope,
  initialCommitMessage,
  autoStageOnOpen,
  initialMode,
}: ReviewHubContentProps) {
  const isDialog = location === "dialog";
  const worktreeId = useWorktreeIdForPath(worktreePath);
  const {
    status,
    statusCapture,
    statusIsFresh,
    loading,
    isBackgroundRefreshing,
    loadError,
    refresh,
    readWithCapture,
    debouncedBgRefreshRef,
    beginOpen: beginStatusOpen,
    reset: resetStatus,
  } = useReviewHubStatus({ isOpen, worktreePath, worktreeId });
  const [actionError, setActionError] = useState<ReviewHubActionFailure | null>(null);
  const reportMarkFailure = useCallback(
    (failure: { title: string; detail: string }) => setActionError(failure),
    []
  );
  const reviewMark = useReviewHubMark({
    isOpen,
    worktreeId,
    worktreePath,
    statusCapture,
    readWithCapture,
    onFailure: reportMarkFailure,
  });
  const {
    markReviewed,
    clearReviewMark,
    markBlockedReason,
    isMarking,
    reviewMark: currentReviewMark,
  } = reviewMark;
  const hasReviewMark = currentReviewMark !== null;

  // `worktree.markReviewed` and `worktree.clearReviewMark` act through the
  // hub they target, dialog or grid; marking needs the state it displayed.
  // The palette asks whether they're ready while it renders, so the target
  // reads what this hub last committed rather than calling into its render.
  const markTargetRef = useRef({ markBlockedReason, hasReviewMark, markReviewed, clearReviewMark });
  useEffect(() => {
    markTargetRef.current = { markBlockedReason, hasReviewMark, markReviewed, clearReviewMark };
  });
  useEffect(() => {
    if (!isOpen || !panelId || !worktreeId) return;
    return registerReviewHubMarkTarget({
      panelId,
      worktreeId,
      isDialog,
      markBlockedReason: () => markTargetRef.current.markBlockedReason,
      hasMark: () => markTargetRef.current.hasReviewMark,
      markReviewed: () => markTargetRef.current.markReviewed(),
      clearReviewMark: () => markTargetRef.current.clearReviewMark(),
    });
  }, [isOpen, panelId, worktreeId, isDialog]);
  const {
    pushError,
    showPushBanner,
    forgeErrorCode,
    forgeProviderId,
    showPushDetails,
    setShowPushDetails,
    setPushBannerDismissed,
    pushProgress,
    pushTargetBranch,
    isCommitPushInFlight,
    pushAnnouncement,
    isPushing,
    pullRebasing,
    handleCommit,
    handleCommitAndPush,
    handleRetryPush,
    handlePushClean,
    confirmPullRebase,
    handleForcePush,
    clearPushError,
    reset: resetPush,
  } = useReviewHubCommitAndPush({ worktreePath, refresh, setActionError, debouncedBgRefreshRef });
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    status: GitStatus;
    section: FileStageRowSection;
  } | null>(null);
  // Session-scoped per-file Viewed indicator, shared with the diff
  // workspace's sidebar through diffViewedStore so a file checked off in
  // either surface reads as reviewed in both. Keys are `staged:{path}` or
  // `unstaged:{path}` so that the same path appearing in both sections (valid
  // during partial staging) tracks Viewed independently. Survives close and
  // reopen within an app session; not persisted.
  const viewedFiles = useDiffViewedStore(
    useCallback((state) => selectViewedSet(state, worktreePath), [worktreePath])
  );
  const setStoreViewed = useDiffViewedStore((state) => state.setViewed);
  const [diffMode, setDiffMode] = useState<DiffMode>("working-tree");
  const [selectedBaseBranchFile, setSelectedBaseBranchFile] = useState<CrossWorktreeFile | null>(
    null
  );
  const mainBranch = useWorktreeStore(
    (state) =>
      Array.from(state.worktrees.values()).find((wt) => wt.isMainWorktree)?.branch ?? "main"
  );
  const {
    baseBranchFiles,
    baseBranchLoading,
    baseBranchError,
    fetchBaseBranch,
    invalidate: invalidateBaseBranch,
    reset: resetBaseBranch,
  } = useReviewHubBaseBranch({
    worktreePath,
    mainBranch,
    currentBranch: status?.currentBranch,
    setSelectedBaseBranchFile,
  });
  // Diff panels opened by this hub. The selection state above stays the record
  // of "a diff is open" (the hub clears it on commit, worktree switch, and
  // conflict-mode entry), but the panel itself owns stepping between files once
  // open — so these effects only handle open, close, and keeping the change set
  // in step with the live poll.
  const [diffPanelId, setDiffPanelId] = useState<string | null>(null);
  const hasWorkingTreeSelection = selectedFile !== null;
  const hasBaseBranchSelection = selectedBaseBranchFile !== null;
  const [selectedSinceReviewPath, setSelectedSinceReviewPath] = useState<string | null>(null);
  const hasSinceReviewSelection = selectedSinceReviewPath !== null;
  const dialogStack = usePanelDialogStore((state) => state.dialogStack);

  // Layer the diff above this hub when the hub is itself the presented dialog;
  // a plain open would supersede it, destroying the staging surface (draft,
  // selection, filters) the user is in the middle of using (#11243). Everywhere
  // else the hub is grid-hosted and the diff is the only dialog, so the
  // replacing open stays correct.
  const openDiffDialog = useCallback(
    (
      store: ReturnType<typeof usePanelDialogStore.getState>,
      options: Parameters<typeof store.openPanelDialog>[0]
    ): Promise<string | null> =>
      isDialog && panelId
        ? store.pushPanelDialog(options, panelId)
        : store.openPanelDialog(options),
    [isDialog, panelId]
  );

  // Ownership loss: the user closed the dialog, promoted it into the grid, or
  // another surface superseded it. The selection has to go with the pointer —
  // it is the record of "a diff is open", and the open effects below key off
  // it, so dropping only the pointer reads as "we want a panel" and instantly
  // reopens the dialog the user just dismissed (or duplicates the promoted one).
  //
  // Membership, not top-of-stack: a diff opened from this hub stays ours even
  // if something is layered above it.
  useEffect(() => {
    if (!diffPanelId || dialogStack.includes(diffPanelId)) return;
    setDiffPanelId(null);
    setSelectedFile(null);
    setSelectedBaseBranchFile(null);
    setSelectedSinceReviewPath(null);
  }, [dialogStack, diffPanelId]);

  // Close the panel when the hub drops its selection for a reason of its own
  // (commit, worktree switch, conflict mode). Targeted by id: closing the top
  // of the stack from here would tear down whatever dialog currently sits
  // there, which may not be ours.
  useEffect(() => {
    if (
      hasWorkingTreeSelection ||
      hasBaseBranchSelection ||
      hasSinceReviewSelection ||
      !diffPanelId
    ) {
      return;
    }
    usePanelDialogStore.getState().closePanelDialogById(diffPanelId);
  }, [hasWorkingTreeSelection, hasBaseBranchSelection, hasSinceReviewSelection, diffPanelId]);
  const selection = useReviewHubRowSelection(status);
  const {
    selectedPaths,
    setSelectedPaths,
    selectionSection,
    setSelectionSection,
    selectionAnchorRef,
  } = selection;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The same element as `scrollContainerRef`, held in STATE as well: Virtuoso
  // needs it as a prop, and a ref mutation does not re-render, so windowing
  // would otherwise never learn the container exists.
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const attachScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollParent(node);
  }, []);
  const savedScrollTop = useRef(0);
  const conflictSectionRef = useRef<HTMLDivElement>(null);
  const unstagedSectionRef = useRef<HTMLDivElement>(null);
  // Row element that opened a diff modal; AppDialog falls back to it when the
  // trigger unmounted (e.g. the file left the list while the modal was open).
  const diffTriggerRef = useRef<HTMLElement | null>(null);
  // One-shot guard for the auto-stage-on-open behavior. Resets in the close
  // branch of the isOpen effect so reopening re-arms the check.
  const hasAutoStagedRef = useRef(false);

  const fileListExpanded = useUIStore((s) => s.reviewHubFileListExpanded[worktreePath] ?? true);
  const setFileListExpanded = useUIStore((s) => s.setReviewHubFileListExpanded);

  const skipPushConfirm = usePreferencesStore(
    (s) => s.skipPushConfirmByWorktreePath[worktreePath] ?? false
  );
  const setSkipPushConfirmForWorktree = usePreferencesStore((s) => s.setSkipPushConfirmForWorktree);

  const [stagedView, setStagedView] = useState<SectionViewState>(DEFAULT_SECTION_STATE);
  const [changesView, setChangesView] = useState<SectionViewState>(DEFAULT_SECTION_STATE);
  const stagedInputRef = useRef<HTMLInputElement | null>(null);
  const changesInputRef = useRef<HTMLInputElement | null>(null);

  const setStagedFilterQuery = useCallback((q: string) => {
    setStagedView((prev) => ({ ...prev, filterQuery: q }));
  }, []);

  const setChangesFilterQuery = useCallback((q: string) => {
    setChangesView((prev) => ({ ...prev, filterQuery: q }));
  }, []);

  const clearStagedFilter = useCallback(() => {
    if (stagedInputRef.current) stagedInputRef.current.value = "";
    setStagedView((prev) => ({ ...prev, filterQuery: "" }));
  }, []);

  const clearChangesFilter = useCallback(() => {
    if (changesInputRef.current) changesInputRef.current.value = "";
    setChangesView((prev) => ({ ...prev, filterQuery: "" }));
  }, []);

  const deferredStagedQuery = useDeferredValue(stagedView.filterQuery);
  const deferredChangesQuery = useDeferredValue(changesView.filterQuery);

  const derivedStaged = useMemo(() => {
    if (!status) return [];
    let rows = status.staged;
    if (!stagedView.showGenerated) rows = rows.filter((f) => !isGeneratedFile(f.path));
    if (deferredStagedQuery) rows = rows.filter((f) => matchesFilter(f.path, deferredStagedQuery));
    return sortFiles(rows, stagedView.sortKey, stagedView.sortDir);
  }, [status, stagedView, deferredStagedQuery]);

  const derivedUnstaged = useMemo(() => {
    if (!status) return [];
    let rows = status.unstaged;
    if (!changesView.showGenerated) rows = rows.filter((f) => !isGeneratedFile(f.path));
    if (deferredChangesQuery)
      rows = rows.filter((f) => matchesFilter(f.path, deferredChangesQuery));
    return sortFiles(rows, changesView.sortKey, changesView.sortDir);
  }, [status, changesView, deferredChangesQuery]);

  // Flat keyboard-navigation list: staged rows first, then unstaged, matching
  // render order. Each entry carries its section so action keys (stage/unstage,
  // viewed) and the `section:path` focus key can be derived without a lookup.
  const navigableItems = useMemo(
    () => [
      ...derivedStaged.map((file) => ({ section: "staged" as FileStageRowSection, file })),
      ...derivedUnstaged.map((file) => ({ section: "unstaged" as FileStageRowSection, file })),
    ],
    [derivedStaged, derivedUnstaged]
  );

  const cursor = useReviewHubFileCursor({
    navigableItems,
    stagedCount: derivedStaged.length,
    menuReplayBlocked:
      !fileListExpanded ||
      diffMode !== "working-tree" ||
      selectedFile !== null ||
      selectedBaseBranchFile !== null ||
      selectedSinceReviewPath !== null,
  });
  const {
    focusedIndex,
    setFocusedIndex,
    writeCursorKey,
    fileListRef,
    movingListFocusRef,
    stagedListRef,
    unstagedListRef,
    handleStagedRangeChange,
    handleUnstagedRangeChange,
    workingTreeVirtualized,
    focusedRowIsMounted,
  } = cursor;

  const sortedBaseBranchFiles = useMemo(
    () =>
      baseBranchFiles
        ? [...baseBranchFiles].sort((a, b) =>
            a.path.replace(/\\/g, "/").localeCompare(b.path.replace(/\\/g, "/"))
          )
        : null,
    [baseBranchFiles]
  );

  const baseBranchChurn = useMemo(
    () => sumChurn(sortedBaseBranchFiles ?? []),
    [sortedBaseBranchFiles]
  );

  // Position of the open working-tree diff within `navigableItems` (the flat
  // staged-then-unstaged render order). Path-only fallback keeps the index
  // alive when the open file moves between sections (stage/unstage) while the
  // modal is up; null when the file left the list entirely.
  const selectedFileIndex = useMemo(() => {
    if (!selectedFile) return null;
    const exact = navigableItems.findIndex(
      (item) => item.section === selectedFile.section && item.file.path === selectedFile.path
    );
    if (exact !== -1) return exact;
    const byPath = navigableItems.findIndex((item) => item.file.path === selectedFile.path);
    return byPath === -1 ? null : byPath;
  }, [selectedFile, navigableItems]);

  // Changesets handed to the diff modals so they can render the
  // review-workspace sidebar. Indexed identically to the modal's
  // `currentFileIndex`, and viewed keys match the hub's own conventions so
  // markers stay in sync across both surfaces.
  const workingTreeChangeSet = useMemo(
    (): DiffChangeSetEntry[] =>
      navigableItems.map((item) => ({
        path: item.file.path,
        status: item.file.status,
        insertions: item.file.insertions,
        deletions: item.file.deletions,
        viewedKey: `${item.section}:${item.file.path}`,
        side: item.section,
      })),
    [navigableItems]
  );

  const baseBranchChangeSet = useMemo((): DiffChangeSetEntry[] | undefined => {
    if (!sortedBaseBranchFiles) return undefined;
    const statusMap: Record<string, GitStatus> = {
      A: "added",
      D: "deleted",
      M: "modified",
      R: "renamed",
      C: "copied",
      U: "conflicted",
    };
    return sortedBaseBranchFiles.map((file) => ({
      path: file.path,
      status: statusMap[file.status] ?? "modified",
      insertions: file.insertions,
      deletions: file.deletions,
      viewedKey: `base:${file.path}`,
    }));
  }, [sortedBaseBranchFiles]);

  const sinceReviewView = useMemo(
    () => describeSinceReview(currentReviewMark, reviewMark.comparison),
    [currentReviewMark, reviewMark.comparison]
  );
  // The files the Since review list shows, in its order, so the panel steps
  // through what the user sees. A path git spells in bytes that aren't UTF-8
  // can't be named by a panel, so it isn't offered.
  const sinceReviewChangeSet = useMemo((): DiffChangeSetEntry[] | undefined => {
    if (sinceReviewView.kind !== "listed") return undefined;
    const ordered = [
      ...sinceReviewView.files.filter((file) => file.group === "branch"),
      ...sinceReviewView.files.filter((file) => file.group === "base-update"),
    ];
    return ordered
      .filter((file) => file.pathBytes === undefined)
      .map((file) => ({
        path: file.path,
        status: file.status === "unknown" ? "modified" : file.status,
        viewedKey: `since-review:${file.path}`,
      }));
  }, [sinceReviewView]);

  const lastSelectedFileIndexRef = useRef(0);
  useEffect(() => {
    if (selectedFileIndex !== null) lastSelectedFileIndexRef.current = selectedFileIndex;
  }, [selectedFileIndex]);

  const selectedBaseBranchIndex = useMemo(() => {
    if (!selectedBaseBranchFile || !sortedBaseBranchFiles) return null;
    const idx = sortedBaseBranchFiles.findIndex((f) => f.path === selectedBaseBranchFile.path);
    return idx === -1 ? null : idx;
  }, [selectedBaseBranchFile, sortedBaseBranchFiles]);

  const lastBaseBranchIndexRef = useRef(0);
  useEffect(() => {
    if (selectedBaseBranchIndex !== null) lastBaseBranchIndexRef.current = selectedBaseBranchIndex;
  }, [selectedBaseBranchIndex]);

  // Both change sets are rebuilt on every poll, so the open effects below read
  // them through this ref instead of depending on them — otherwise a quiet poll
  // would retrigger the open. Seeded at mount and resynced ahead of those
  // effects (effects in one commit run in declaration order); the panel's own
  // copy is kept current by the sync effect further down.
  const changeSetsRef = useRef({
    workingTree: workingTreeChangeSet,
    baseBranch: baseBranchChangeSet,
    sinceReview: sinceReviewChangeSet,
  });
  useEffect(() => {
    changeSetsRef.current = {
      workingTree: workingTreeChangeSet,
      baseBranch: baseBranchChangeSet,
      sinceReview: sinceReviewChangeSet,
    };
  }, [workingTreeChangeSet, baseBranchChangeSet, sinceReviewChangeSet]);

  // Open (or retarget) the working-tree diff panel as the hub's selection moves.
  // Status follows the LIVE entry, not the open-time snapshot: a file that is
  // staged or committed under the open panel must be re-fetched under its
  // current status or the diff renders in the wrong mode.
  const liveWorkingTreeItem =
    selectedFileIndex !== null ? navigableItems[selectedFileIndex] : undefined;
  const liveWorkingTreeStatus = liveWorkingTreeItem?.file.status ?? selectedFile?.status;
  // Section-scoped, matching `workingTreeChangeSet`: it is the only thing that
  // separates the staged and unstaged rows of a partially staged file, which
  // otherwise share both path and status.
  const liveWorkingTreeViewedKey = liveWorkingTreeItem
    ? `${liveWorkingTreeItem.section}:${liveWorkingTreeItem.file.path}`
    : selectedFile
      ? `${selectedFile.section}:${selectedFile.path}`
      : undefined;
  useEffect(() => {
    if (!selectedFile || !liveWorkingTreeStatus) return;
    const store = usePanelDialogStore.getState();
    if (diffPanelId) {
      usePanelStore
        .getState()
        .setDiffPanelFile(
          diffPanelId,
          selectedFile.path,
          liveWorkingTreeStatus,
          liveWorkingTreeViewedKey
        );
      return;
    }
    void openDiffDialog(store, {
      kind: "diff",
      filePath: selectedFile.path,
      fileStatus: liveWorkingTreeStatus,
      diffSource: "working-tree",
      changeSet: changeSetsRef.current.workingTree,
      title: basename(selectedFile.path),
      ...(liveWorkingTreeViewedKey && { viewedKey: liveWorkingTreeViewedKey }),
      ...(worktreeId && { worktreeId }),
    })
      // A refused or superseded open resolves null. Drop the selection with it,
      // or this effect sees "selection, no panel" and retries forever.
      .then((newPanelId) => (newPanelId ? setDiffPanelId(newPanelId) : setSelectedFile(null)));
  }, [
    selectedFile,
    liveWorkingTreeStatus,
    liveWorkingTreeViewedKey,
    diffPanelId,
    worktreeId,
    openDiffDialog,
  ]);

  useEffect(() => {
    if (!selectedBaseBranchFile) return;
    const store = usePanelDialogStore.getState();
    const viewedKey = `base:${selectedBaseBranchFile.path}`;
    if (diffPanelId) {
      usePanelStore
        .getState()
        .setDiffPanelFile(diffPanelId, selectedBaseBranchFile.path, "modified", viewedKey);
      return;
    }
    void openDiffDialog(store, {
      kind: "diff",
      filePath: selectedBaseBranchFile.path,
      fileStatus: "modified",
      diffSource: "base-branch",
      baseBranch: mainBranch,
      changeSet: changeSetsRef.current.baseBranch,
      title: basename(selectedBaseBranchFile.path),
      viewedKey,
      ...(worktreeId && { worktreeId }),
    }).then((newPanelId) =>
      newPanelId ? setDiffPanelId(newPanelId) : setSelectedBaseBranchFile(null)
    );
  }, [selectedBaseBranchFile, diffPanelId, worktreeId, mainBranch, openDiffDialog]);

  useEffect(() => {
    if (!selectedSinceReviewPath) return;
    const store = usePanelDialogStore.getState();
    const viewedKey = `since-review:${selectedSinceReviewPath}`;
    if (diffPanelId) {
      usePanelStore
        .getState()
        .setDiffPanelFile(diffPanelId, selectedSinceReviewPath, "modified", viewedKey);
      return;
    }
    void openDiffDialog(store, {
      kind: "diff",
      filePath: selectedSinceReviewPath,
      fileStatus: "modified",
      diffSource: "since-review",
      changeSet: changeSetsRef.current.sinceReview,
      title: basename(selectedSinceReviewPath),
      viewedKey,
      ...(worktreeId && { worktreeId }),
    }).then((newPanelId) =>
      newPanelId ? setDiffPanelId(newPanelId) : setSelectedSinceReviewPath(null)
    );
  }, [selectedSinceReviewPath, diffPanelId, worktreeId, openDiffDialog]);

  // Keep the open panel's change set in step with the live poll. The store
  // bails on a value-equal set, so a quiet poll costs nothing.
  useEffect(() => {
    if (!diffPanelId) return;
    const changeSet = selectedSinceReviewPath
      ? sinceReviewChangeSet
      : selectedBaseBranchFile
        ? baseBranchChangeSet
        : workingTreeChangeSet;
    if (changeSet) usePanelStore.getState().setDiffPanelChangeSet(diffPanelId, changeSet);
  }, [
    diffPanelId,
    selectedSinceReviewPath,
    selectedBaseBranchFile,
    sinceReviewChangeSet,
    baseBranchChangeSet,
    workingTreeChangeSet,
  ]);

  const worktreePR = useWorktreeStore(
    useShallow((state) => {
      for (const wt of state.worktrees.values()) {
        if (wt.path === worktreePath) {
          return wt.linked?.pr
            ? {
                prNumber: wt.linked.pr.ref.number,
                prUrl: wt.linked.pr.url,
                prState: wt.linked.pr.state,
                prCiStatus: wt.linked.pr.ciStatus,
                mergeIntent: wt.linked.pr.mergeIntent,
                headMovedWhileArmed: wt.linked.pr.headMovedWhileArmed,
              }
            : null;
        }
      }
      return null;
    })
  );

  // Per-file review-thread badges now come from the generic plugin
  // file-decoration system (the active provider plugin contributes the
  // `worktree-diff:*` provider) rather than a direct `getPRReviewThreads`
  // call here. The scope is empty (→ no-op, no IPC) unless the base-branch
  // diff is showing for a worktree with a linked PR.
  const decorationScope =
    isOpen && diffMode === "base-branch" && worktreePR?.prNumber && worktreePath
      ? `worktree-diff:${worktreePath}`
      : "";
  const decorationPaths = useMemo(
    () => sortedBaseBranchFiles?.map((f) => f.path) ?? [],
    [sortedBaseBranchFiles]
  );
  const reviewDecorations = useFileDecorations(decorationScope, decorationPaths);

  const behindCount = useWorktreeStore((state) => {
    for (const wt of state.worktrees.values()) {
      if (wt.path === worktreePath) {
        return wt.behindCount;
      }
    }
    return undefined;
  });

  const aheadCount = useWorktreeStore((state) => {
    for (const wt of state.worktrees.values()) {
      if (wt.path === worktreePath) {
        return wt.aheadCount;
      }
    }
    return undefined;
  });

  const forgeHealthProviderId = useWorktreeStore((state) => {
    for (const wt of state.worktrees.values()) {
      if (wt.path === worktreePath) {
        return wt.linked?.providerId ?? wt.matchedForgeProviderId ?? null;
      }
    }
    return null;
  });

  const providerHealth = useForgeProviderHealthStore(
    forgeHealthProviderId
      ? selectForgeProviderHealth(forgeHealthProviderId)
      : selectNoProviderHealth
  );

  const pluginChecks = useWorktreeReviewPluginChecks(worktreeId ?? "");

  const readinessSummary = useMemo(
    () =>
      deriveReviewReadiness({
        status,
        aheadCount,
        behindCount,
        pr: worktreePR
          ? {
              number: worktreePR.prNumber,
              url: worktreePR.prUrl,
              state: worktreePR.prState,
              ciState: worktreePR.prCiStatus?.state ?? null,
            }
          : null,
        providerHealth: providerHealth
          ? {
              rateLimitBlocked: providerHealth.rateLimitBlocked,
              tokenUnhealthy: providerHealth.tokenUnhealthy,
            }
          : null,
        pushError: pushError ? { reason: pushError.reason } : null,
      }),
    [status, aheadCount, behindCount, worktreePR, providerHealth, pushError]
  );

  /**
   * What the rail actually renders. Identical to `readinessSummary` except for
   * items the pane already shows elsewhere — `push-failed` while the dedicated
   * push banner is up (see the note at the `ReadinessRail` call site), and the
   * two below. Never used for gating.
   */
  const railSummary = useMemo<ReviewReadinessSummary>(() => {
    // Conditions this pane already states in its own chrome, so a rail row for
    // them is the same fact twice: `pr-missing` is the header's "No PR" chip
    // (same `hasRemote && no PR` condition), and `unpushed-commits` only arises
    // on a clean tree, whose empty state headlines the very same count.
    const shownElsewhere = new Set<string>(["pr-missing", "unpushed-commits"]);
    if (showPushBanner) shownElsewhere.add("push-failed");
    const drop = (items: ReviewReadinessItem[]) => items.filter((i) => !shownElsewhere.has(i.id));
    const blockers = drop(readinessSummary.blockers);
    const warnings = drop(readinessSummary.warnings);
    return {
      ...readinessSummary,
      // Re-derived from what SURVIVES the filter, by the same rule
      // `deriveReviewReadiness` uses. The rail takes its glyph and copy from
      // the first remaining item but announces `level` sr-only, so carrying the
      // unfiltered verdict here would say "Blocked" beside a warning row
      // whenever push-failed was the only blocker. `unknown` is passed through:
      // it means staging status hasn't resolved, and the rail renders nothing.
      level:
        readinessSummary.level === "unknown"
          ? readinessSummary.level
          : blockers.length > 0
            ? "blocked"
            : warnings.length > 0
              ? "needs-review"
              : "ready",
      blockers,
      warnings,
      infos: drop(readinessSummary.infos),
      nextActions: drop(readinessSummary.nextActions),
    };
  }, [readinessSummary, showPushBanner]);

  const {
    handleStageAll,
    handleUnstageAll,
    handleStageFiltered,
    handleUnstageFiltered,
    handleStageSelection,
    handleUnstageSelection,
    handleToggleStaged,
    handleToggleUnstaged,
  } = useReviewHubStagingActions({
    worktreePath,
    refresh,
    derivedStaged,
    derivedUnstaged,
    selectedPaths,
    selectionSection,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
    debouncedBgRefreshRef,
  });

  // Read the latest initialCommitMessage without re-running the open/close
  // effect when the AI-note changes mid-session — protects user edits per #4220.
  const readInitialCommitMessage = useEffectEvent(() => initialCommitMessage ?? "");

  useEffect(() => {
    if (isOpen) {
      // This branch also re-runs when worktreePath changes while open (via
      // `refresh`'s identity): drop the previous worktree's staging status so
      // the file list and readiness rail never mix two worktrees' state. The
      // cache is keyed by worktree, so what it seeds is this worktree's.
      beginStatusOpen();
      setActionError(null);
      clearPushError();
      const seed = readInitialCommitMessage();
      if (seed) setCommitMessage(seed);
      void refresh();
    } else {
      // Abandons every in-flight read by bumping its request generation, and
      // clears the loading flags those reads' `finally` blocks no longer will:
      // left true they strand `useDohertyGate` (skeleton flashes on reopen) and
      // deadlock base-branch (handleDiffModeChange refuses to refetch while
      // baseBranchLoading is true).
      resetStatus();
      resetBaseBranch();
      resetPush();
      setActionError(null);
      setSelectedFile(null);
      setCommitMessage("");
      setDiffMode("working-tree");
      setSelectedBaseBranchFile(null);
      setSelectedSinceReviewPath(null);
      // Viewed markers deliberately survive close/reopen (diffViewedStore).
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      setFocusedIndex(-1);
      writeCursorKey(null);
      hasAutoStagedRef.current = false;
      // Filter state lives in `stagedView`/`changesView` rather than refs, so the
      // modal-shell path (which unmounts on close) never noticed leftover
      // filters. Once mounted as a non-modal panel, the same component instance
      // survives close→reopen — reset the filter, sort, and density so the
      // next open starts from defaults.
      if (stagedInputRef.current) stagedInputRef.current.value = "";
      if (changesInputRef.current) changesInputRef.current.value = "";
      setStagedView(DEFAULT_SECTION_STATE);
      setChangesView(DEFAULT_SECTION_STATE);
    }
  }, [
    isOpen,
    refresh,
    writeCursorKey,
    worktreePath,
    beginStatusOpen,
    clearPushError,
    resetStatus,
    resetBaseBranch,
    resetPush,
    setFocusedIndex,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
  ]);

  useEffect(() => {
    if (!isOpen || !autoStageOnOpen) return;
    if (!status || !statusIsFresh) return;
    if (hasAutoStagedRef.current) return;
    if (status.staged.length > 0) {
      // Already staged from a prior session — skip and mark as handled.
      hasAutoStagedRef.current = true;
      return;
    }
    if (status.unstaged.length === 0) return;
    // Optimistically take the guard so a concurrent status update can't
    // re-trip this effect mid-call. If staging fails, release the guard so
    // the next status update gets another chance instead of leaving the
    // user stuck looking at unstaged files for the rest of the session.
    // We inline the IPC call here (rather than reusing handleStageAll) to
    // observe failure — handleStageAll swallows errors into a banner.
    hasAutoStagedRef.current = true;
    void (async () => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.stageAll(worktreePath);
        await refresh();
      } catch (err) {
        hasAutoStagedRef.current = false;
        setActionError({
          title: "Couldn't stage all files",
          detail: formatErrorMessage(err, "Failed to stage all files"),
          retry: () => void handleStageAll(),
        });
      }
    })();
  }, [
    isOpen,
    autoStageOnOpen,
    status,
    statusIsFresh,
    refresh,
    worktreePath,
    handleStageAll,
    debouncedBgRefreshRef,
  ]);

  const appliedInitialModeRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      appliedInitialModeRef.current = false;
      return;
    }
    if (initialMode && !appliedInitialModeRef.current) {
      appliedInitialModeRef.current = true;
      setDiffMode(initialMode);
    }
  }, [isOpen, initialMode]);

  // The view needs a mark; once the marks are known and there isn't one (it was
  // cleared, here or in another window), the hub goes back to the working tree.
  const marksLoaded = useReviewMarksStore((state) => state.loaded);
  useEffect(() => {
    if (diffMode === "since-review" && marksLoaded && !hasReviewMark) {
      setDiffMode("working-tree");
    }
  }, [diffMode, marksLoaded, hasReviewMark]);

  useEffect(() => {
    if (diffMode === "base-branch" && status?.currentBranch === mainBranch) {
      invalidateBaseBranch();
      setDiffMode("working-tree");
      setSelectedBaseBranchFile(null);
    }
  }, [status?.currentBranch, mainBranch, diffMode, invalidateBaseBranch]);
  const handleAbortOperation = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.abortRepositoryOperation(worktreePath);
      await refresh();
    } catch (err) {
      setActionError({
        title: "Couldn't abort repository operation",
        detail: formatErrorMessage(err, "Failed to abort repository operation"),
      });
      throw err;
    }
  }, [worktreePath, refresh, debouncedBgRefreshRef]);

  const handleContinueOperation = useCallback(
    async function continueOperation(): Promise<void> {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.continueRepositoryOperation(worktreePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't continue repository operation",
          detail: formatErrorMessage(err, "Failed to continue repository operation"),
          retry: () => void continueOperation().catch(() => {}),
        });
        throw err;
      }
    },
    [worktreePath, refresh, debouncedBgRefreshRef]
  );

  const handleOpenInEditor = useCallback(
    async function openInEditor(args: string | { path: string; line?: number }): Promise<void> {
      setActionError(null);
      const filePath = typeof args === "string" ? args : args.path;
      const line = typeof args === "string" ? undefined : args.line;
      try {
        const base = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
        const tail = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
        const payload: { path: string; line?: number; projectId?: string } = {
          path: `${base}/${tail}`,
          // Read at click time rather than subscribing — without it the main
          // process never loads the project's preferred-editor setting.
          projectId: useProjectStore.getState().currentProject?.id,
        };
        if (typeof line === "number" && Number.isFinite(line) && line > 0) {
          payload.line = line;
        }
        announceOpenInEditorFallback(await window.electron.system.openInEditor(payload));
      } catch (err) {
        setActionError({
          title: "Couldn't open file in editor",
          detail: formatErrorMessage(err, "Failed to open file in editor"),
          retry: () => void openInEditor(args),
        });
      }
    },
    [worktreePath]
  );

  const handleCheckoutOursTheirs = useCallback(
    async (filePath: string, side: "ours" | "theirs") => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.checkoutOursTheirs(worktreePath, filePath, side);
        await refresh();
      } catch (err) {
        setActionError({
          title: side === "ours" ? "Couldn't take ours" : "Couldn't take theirs",
          detail: formatErrorMessage(
            err,
            side === "ours" ? "Failed to take ours" : "Failed to take theirs"
          ),
        });
        throw err;
      }
    },
    [worktreePath, refresh, debouncedBgRefreshRef]
  );

  // Same body as handleStageFile but rethrows so ConflictPanel can roll back
  // optimistic resolution on failure. The general handleStageFile is called
  // via `void handleStageFile(...)` from FileStageRow and shouldn't change its
  // swallow-and-banner semantics for that path.
  const handleMarkResolved = useCallback(
    async (filePath: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.stageFile(worktreePath, filePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't mark file resolved",
          detail: formatErrorMessage(err, "Failed to mark file resolved"),
        });
        throw err;
      }
    },
    [worktreePath, refresh, debouncedBgRefreshRef]
  );

  const handleFocusBlocker = useCallback(
    (blocker: "conflicts" | "staged-files") => {
      // Conflict warning + Staged + Unstaged sections live inside the
      // collapsible file-list disclosure. Expand it first so the targeted
      // refs exist before we try to focus them — otherwise the click on a
      // disabled Commit button is silently swallowed when the list is hidden.
      if (!fileListExpanded) {
        setFileListExpanded(worktreePath, true);
      }
      // Defer one frame so the just-expanded DOM is committed before focus.
      requestAnimationFrame(() => {
        if (blocker === "conflicts") {
          // The first conflicted row's Open — the control that makes progress —
          // whether the rows are the strip's worklist or the operation panel's.
          // The strip's wrapper is the fallback, so a list still settling
          // never swallows the click.
          const firstOpen = rootRef.current?.querySelector<HTMLElement>(
            '[data-testid="conflict-worklist"] li button, [data-testid="conflict-panel"] li button'
          );
          (firstOpen ?? conflictSectionRef.current)?.focus();
        } else {
          // The section's bulk Stage control by name: the first button in the
          // header is View options, which is focus without progress. When the
          // section has nothing to stage there is no such control, and the
          // file list itself is the next place to act.
          const stageAllBtn = unstagedSectionRef.current?.querySelector<HTMLElement>(
            '[data-testid="review-hub-stage-section-button"]'
          );
          (stageAllBtn ?? fileListRef.current)?.focus();
        }
      });
    },
    [fileListExpanded, setFileListExpanded, worktreePath, fileListRef]
  );

  const handleReadinessCta = useCallback(
    (cta: ReviewReadinessCta) => {
      switch (cta.kind) {
        case "focus-conflicts":
        case "focus-staged":
          // The file list only renders in working-tree mode; flip back first so
          // the focus targets exist by the time handleFocusBlocker's rAF runs.
          setDiffMode("working-tree");
          handleFocusBlocker(cta.kind === "focus-conflicts" ? "conflicts" : "staged-files");
          return;
        case "pull-rebase":
          void confirmPullRebase();
          return;
        case "open-pr":
          void systemClient.openExternal(cta.url);
          return;
      }
    },
    [handleFocusBlocker, confirmPullRebase]
  );

  useLayoutEffect(() => {
    if (scrollContainerRef.current && status) {
      scrollContainerRef.current.scrollTop = savedScrollTop.current;
    }
  }, [status]);

  const handleScrollContainer = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    savedScrollTop.current = e.currentTarget.scrollTop;
  }, []);

  // The plain "show me this file's diff" gesture, shared by a click, Enter and
  // the row menu's `Open diff` (#11757) so all three clear the selection the
  // same way and hand focus back to the same row on close. A second opener
  // would drift from this one the first time either changed.
  const openFileDiff = useCallback(
    (
      section: FileStageRowSection,
      filePath: string,
      fileStatus: GitStatus,
      triggerEl: HTMLElement | null
    ) => {
      setSelectedPaths((prev) => (prev.size === 0 ? prev : new Set()));
      setSelectionSection((prev) => (prev === null ? prev : null));
      selectionAnchorRef.current = filePath;
      diffTriggerRef.current = triggerEl;
      setSelectedFile({ path: filePath, status: fileStatus, section });
    },
    [setSelectedPaths, setSelectionSection, selectionAnchorRef]
  );

  const handleOpenBaseBranchFile = useCallback((file: CrossWorktreeFile, trigger: HTMLElement) => {
    diffTriggerRef.current = trigger;
    setSelectedBaseBranchFile(file);
  }, []);

  const handleOpenDecorationUrl = useCallback((url: string) => {
    void systemClient.openExternal(url);
  }, []);

  const handleRowClick = useCallback(
    (
      section: FileStageRowSection,
      filePath: string,
      fileStatus: GitStatus,
      e: React.MouseEvent
    ) => {
      const files = section === "staged" ? status?.staged : status?.unstaged;
      if (e.shiftKey && files && selectionSection === section && selectionAnchorRef.current) {
        const anchorIdx = files.findIndex((f) => f.path === selectionAnchorRef.current);
        const clickIdx = files.findIndex((f) => f.path === filePath);
        if (anchorIdx !== -1 && clickIdx !== -1) {
          const start = Math.min(anchorIdx, clickIdx);
          const end = Math.max(anchorIdx, clickIdx);
          const range = new Set<string>();
          for (let i = start; i <= end; i++) {
            const entry = files[i];
            if (entry) range.add(entry.path);
          }
          setSelectedPaths(range);
          setSelectionSection(section);
          return;
        }
      }

      if (e.metaKey || e.ctrlKey) {
        setSelectedPaths((prev) => {
          const next = selectionSection === section ? new Set(prev) : new Set<string>();
          if (next.has(filePath)) {
            next.delete(filePath);
          } else {
            next.add(filePath);
          }
          if (next.size === 0) {
            setSelectionSection(null);
            selectionAnchorRef.current = null;
          } else {
            setSelectionSection(section);
            selectionAnchorRef.current = filePath;
          }
          return next;
        });
        return;
      }

      // Plain click: clear any selection, open diff.
      openFileDiff(
        section,
        filePath,
        fileStatus,
        e.currentTarget instanceof HTMLElement ? e.currentTarget : null
      );
    },
    [
      status,
      selectionSection,
      openFileDiff,
      setSelectedPaths,
      setSelectionSection,
      selectionAnchorRef,
    ]
  );

  const handleViewedChange = useCallback(
    (viewedKey: string, viewed: boolean) => {
      setStoreViewed(worktreePath, viewedKey, viewed);
    },
    [setStoreViewed, worktreePath]
  );

  // The one file-row menu, shared with the worktree card, the file browser and
  // the diff sidebar (#11757). Built once here rather than per row: a large
  // changeset renders thousands of rows, and a hook per row would be a store
  // subscription per row.
  const { renderItems: renderFileRowMenuItems } = useFileRowMenuItems({
    worktreePath,
    worktreeId: worktreeId ?? null,
    copyTreeRunSource: "worktree-card",
  });

  const renderRowMenu = useCallback(
    (
      file: StagingFileEntry,
      section: FileStageRowSection,
      triggerRef: RefObject<HTMLElement | null>
    ) =>
      renderFileRowMenuItems(
        {
          absolutePath: join(worktreePath, file.path),
          relativePath: file.path,
          name: basename(file.path),
          isDirectory: false,
          status: file.status,
        },
        {
          // Routed through the hub's own opener so the menu lands on the same
          // overlay a click does, with the same selection reset.
          onOpenDiff: () => openFileDiff(section, file.path, file.status, triggerRef.current),
          hasChanges: true,
        }
      ),
    [renderFileRowMenuItems, worktreePath, openFileDiff]
  );

  const handleDiffModeChange = useCallback(
    (mode: DiffMode) => {
      setDiffMode(mode);
      if (mode === "base-branch" && baseBranchFiles === null && !baseBranchLoading) {
        void fetchBaseBranch();
      }
    },
    [baseBranchFiles, baseBranchLoading, fetchBaseBranch]
  );

  useReviewHubKeyboard({
    isOpen,
    keyboardScope,
    onClose,
    cursor,
    selection,
    navigableItems,
    selectedFile,
    setSelectedFile,
    selectedBaseBranchFile,
    setSelectedBaseBranchFile,
    fileListExpanded,
    diffMode,
    openFileDiff,
    handleToggleStaged,
    handleToggleUnstaged,
    handleViewedChange,
    viewedFiles,
  });

  // Shape-matched skeletons replace the old full-area spinners. Doherty-gate
  // both so sub-400ms loads render nothing (no flash); bones inside use
  // `immediate` since the gate already absorbs the threshold.
  const showWorkingTreeSkeleton = useDohertyGate(loading && !status);
  const showBaseBranchSkeleton = useDohertyGate(baseBranchLoading);

  if (!isOpen) return null;

  const totalChanges =
    (status?.staged.length ?? 0) +
    (status?.unstaged.length ?? 0) +
    (status?.conflicted.length ?? 0);
  const hasConflicts = (status?.conflicted.length ?? 0) > 0;
  const hasStagedSelection = selectionSection === "staged" && selectedPaths.size > 0;
  const hasUnstagedSelection = selectionSection === "unstaged" && selectedPaths.size > 0;
  const stagedPaths = status?.staged.map((f) => f.path) ?? [];
  const sinceReviewUnavailable = sinceReviewUnavailableReason(currentReviewMark);
  const refreshBusy =
    diffMode === "base-branch"
      ? baseBranchLoading
      : diffMode === "since-review"
        ? sinceReviewView.kind === "comparing"
        : loading;
  const refreshSpinning = diffMode === "working-tree" && isBackgroundRefreshing;
  const repoState = status?.repoState ?? "CLEAN";
  const isOperationState =
    repoState === "MERGING" ||
    repoState === "REBASING" ||
    repoState === "CHERRY_PICKING" ||
    repoState === "REVERTING";

  return (
    <>
      <div
        ref={rootRef}
        className={cn(
          "relative flex flex-col flex-1 min-h-0",
          "bg-surface-canvas",
          "outline-hidden"
        )}
        data-testid="review-hub-content"
      >
        {/* The pane's own title bar: review renders no PanelHeader, so this is
            the compact SurfaceHeader a grid pane would otherwise get. */}
        <SurfaceHeader
          density="compact"
          data-testid="review-hub-header"
          className={cn(
            "gap-2 transition-colors",
            location === "grid" && isFocused && [SURFACE_HEADER_FOCUS_LIFT_CLASS, "border-overlay"]
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* The dialog host already draws the title in AppDialog.Header —
                drawing it again would stack two "Review & Commit" headings. */}
            {!isDialog && (
              <h2 id="review-hub-title" className="text-xs font-medium text-text-primary shrink-0">
                Review & commit
              </h2>
            )}
            {status?.currentBranch && <BranchBadge branch={status.currentBranch} />}
            {status?.currentBranch && isProtectedBranch(status.currentBranch.toLowerCase()) && (
              <Badge size="sm" tone="warning" data-testid="review-hub-protected-branch-chip">
                <AlertTriangle aria-hidden="true" />
                <span>Protected</span>
              </Badge>
            )}
            <PrStatusChip
              hasRemote={status?.hasRemote}
              worktreePR={worktreePR}
              worktreePath={worktreePath}
              onOpenExternal={(url) => void systemClient.openExternal(url)}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Diff mode switch: the shared segmented control, so it looks,
                answers the keyboard and slides like every other mode switch. */}
            <SegmentedRadioGroup
              density="compact"
              aria-label="Diff mode"
              testId="review-hub-diff-mode"
              value={diffMode}
              onChange={handleDiffModeChange}
              options={[
                { value: "working-tree" as const, label: "Working tree" },
                {
                  value: "base-branch" as const,
                  label: `vs ${mainBranch}`,
                  disabled: !status?.currentBranch || status.currentBranch === mainBranch,
                },
                {
                  value: "since-review" as const,
                  label: "Since review",
                  disabled: sinceReviewUnavailable !== null,
                  tooltip: sinceReviewUnavailable ?? undefined,
                },
              ]}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (!markBlockedReason) void markReviewed();
                  }}
                  // Not `disabled`, as for Refresh: focus stays on the control.
                  aria-disabled={markBlockedReason !== null || undefined}
                  aria-busy={isMarking || undefined}
                  className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                  aria-label="Mark reviewed"
                  data-testid="review-hub-mark-reviewed"
                >
                  <BookmarkCheck className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {markBlockedReason && !isMarking
                  ? `Mark reviewed (${markBlockedReason})`
                  : "Mark reviewed"}
              </TooltipContent>
            </Tooltip>

            {/* In both modes: hiding it in base-branch mode slid the mode
                switch sideways on every toggle, and that comparison goes stale
                as much as the working tree does. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    if (diffMode === "base-branch") {
                      if (!baseBranchLoading) void fetchBaseBranch();
                    } else if (diffMode === "since-review") {
                      if (!refreshBusy) reviewMark.retryCompare();
                    } else if (!loading) {
                      void refresh();
                      // A fresh capture too, so a mark covers what this read shows.
                      readWithCapture(true);
                    }
                  }}
                  // Not `disabled`: pressing it would drop keyboard focus to the page.
                  aria-disabled={refreshBusy || undefined}
                  aria-busy={refreshBusy || refreshSpinning || undefined}
                  className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                  aria-label="Refresh"
                >
                  <SpinningIcon
                    icon={RefreshCw}
                    active={refreshBusy || refreshSpinning}
                    className={PANE_TOOLBAR_ICON_CLASS}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh</TooltipContent>
            </Tooltip>
            {/* Same reason as the title: AppDialog.Header supplies the close
                control at this location. */}
            {!isDialog && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <SurfaceHeaderCloseButton
                    onClick={onClose}
                    aria-label="Close review & commit"
                    data-testid="review-hub-close"
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">Close review & commit</TooltipContent>
              </Tooltip>
            )}
          </div>
        </SurfaceHeader>

        <ReviewMarkLine
          reviewMark={currentReviewMark}
          comparison={reviewMark.comparison}
          notice={reviewMark.notice}
          isRecording={reviewMark.isRecording}
          isClearing={reviewMark.isClearing}
          onClear={() => void clearReviewMark()}
          onRetry={reviewMark.retryCompare}
          onOpenSinceReview={
            diffMode === "since-review" ? undefined : () => handleDiffModeChange("since-review")
          }
          onDismissNotice={reviewMark.dismissNotice}
        />

        <ReviewHubContext worktreePath={worktreePath} worktreeId={worktreeId} />

        {/* Merge-readiness rail — hidden until staging status resolves.
            While `PushErrorBanner` is mounted it owns the push failure outright:
            it classifies the reason, names the remedy, and carries the only
            actions (pull-rebase / force-push). The rail's own `push-failed` item
            says the same thing in different words, one severity louder, with no
            action — so the two stacked directly on top of each other and the
            louder of the pair was the useless one. Filtered from what the RAIL
            renders only; `readinessSummary` itself keeps the blocker so
            readiness and push gating are unchanged. */}
        <ReadinessRail summary={railSummary} onCta={handleReadinessCta} />
        {/* Advisory plugin checks (#13806): outside the rail and never fed to
            `deriveReviewReadiness`, so they cannot change commit or push. */}
        {worktreeId && <PluginReadinessChecks worktreeId={worktreeId} plugins={pluginChecks} />}

        {/* Inline error banners */}
        {actionError && (
          /* One grammar for every failure on this surface: icon, verb-noun
             title, the git detail as supporting copy, and exactly one recovery.
             This used to be a bespoke strip that printed raw stderr with no
             title, no role and nothing the user could do — the message sat in
             the layout permanently because there was not even a dismiss. It is
             `role="status"` rather than `alert` because the pane is still fully
             usable: the failed action is recoverable in place, and an assertive
             interrupt for a secondary failure would fight the user's focus. */
          <InlineStatusBanner
            severity="error"
            role="status"
            ariaLive="polite"
            title={actionError.title}
            description={actionError.detail}
            onClose={() => setActionError(null)}
            // Retry re-runs the failed operation itself. A failure with no safe
            // re-run (one that would skip a confirmation) offers none rather
            // than a "Retry" that only re-reads status and changes nothing.
            action={
              actionError.retry
                ? {
                    id: "review-hub-action-error-retry",
                    label: "Retry",
                    onClick: actionError.retry,
                  }
                : undefined
            }
          />
        )}
        <span role="status" className="sr-only" data-testid="review-hub-push-announcement">
          {pushAnnouncement}
        </span>
        {pushError && showPushBanner && (
          <PushErrorBanner
            pushError={pushError}
            behindCount={behindCount}
            forgeProviderId={forgeProviderId}
            forgeErrorCode={forgeErrorCode}
            showPushDetails={showPushDetails}
            onToggleDetails={() => setShowPushDetails((prev) => !prev)}
            pullRebasing={pullRebasing}
            onOpenForgeSettings={(providerId) =>
              void actionService.dispatch(
                "app.settings.openTab",
                { tab: "code-forge", subtab: providerId },
                { source: "user" }
              )
            }
            onRetryPush={() => void handleRetryPush()}
            onPullRebase={() => void confirmPullRebase()}
            onForcePush={() => void handleForcePush()}
            onDismiss={() => setPushBannerDismissed(true)}
          />
        )}

        {/* Content */}
        <div
          ref={attachScrollContainer}
          data-testid="review-hub-scroll-container"
          className={cn(
            // `min-h-0` is load-bearing and stays alone in its Tailwind group:
            // it is what lets the scroller shrink inside a dialog body capped
            // at 85vh. A `min-h-*` floor added here would not sit beside it —
            // tailwind-merge collapses the group and keeps the last one — so
            // the reservation below lives on the content wrapper instead.
            "flex-1 overflow-y-auto min-h-0",
            // A revealed row stops below the sticky section band instead of
            // under it (WCAG 2.4.11); `scrollIntoView` honours scroll padding.
            "scroll-pt-10",
            isBackgroundRefreshing && "surface-stale"
          )}
          aria-busy={isBackgroundRefreshing || undefined}
          onScroll={handleScrollContainer}
        >
          {/* Reserve the body in the DIALOG host so the pane stops resizing
              itself around its own content. Loading, failure, empty and
              resolved states used to produce wildly different dialog heights
              — the same "Working tree clean" composition measured 458px on one
              route and 522px on another — so a retry or a mode switch read as
              a major transition rather than as the same surface updating.
              Long content still scrolls inside this block, and the Doherty
              gate still paints nothing before 400ms: the space is reserved,
              not filled.

              The floor is on the CONTENT, not on the scrollport: as scrollable
              content it grows the dialog while there is room and scrolls once
              there isn't, so a short window (the 600px minimum, 85vh = 510px)
              still shrinks the scroller instead of pushing the commit button
              out through the dialog body's `overflow-hidden`.

              Grid-hosted panes are deliberately excluded. There the tile owns
              its own height from the layout, so a floor here would fight the
              grid instead of stabilising anything. */}
          <div
            data-testid="review-hub-body-reservation"
            className={cn(isDialog && DIALOG_MIN_BODY_HEIGHT)}
          >
            {diffMode === "since-review" ? (
              <SinceReviewPanel
                view={sinceReviewView}
                onOpenFile={(path, trigger) => {
                  diffTriggerRef.current = trigger;
                  setSelectedSinceReviewPath(path);
                }}
                onClear={() => void clearReviewMark()}
                onRetry={reviewMark.retryCompare}
              />
            ) : diffMode === "base-branch" ? (
              /* Base-branch diff panel */
              baseBranchLoading ? (
                showBaseBranchSkeleton ? (
                  <>
                    <Skeleton label={`Loading changes vs ${mainBranch}`}>
                      <SkeletonBone immediate className="h-8 mx-4 my-2" />
                      <div className="px-2 py-1 flex flex-col gap-0.5">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <div key={i} className="flex items-center gap-2 px-1.5 py-1.5">
                            <SkeletonBone immediate className="h-4 w-4 shrink-0 rounded-sm" />
                            <SkeletonBone
                              immediate
                              className={cn(
                                "h-2.5",
                                ["w-48", "w-32", "w-56", "w-24", "w-40", "w-36", "w-52", "w-28"][
                                  i % 8
                                ]
                              )}
                            />
                          </div>
                        ))}
                      </div>
                    </Skeleton>
                    <SkeletonHint className="px-3 py-2" onRetry={() => void fetchBaseBranch()} />
                  </>
                ) : null
              ) : baseBranchError ? (
                /* A SECONDARY failure — the comparison could not be computed, but
                 the pane and its chrome are intact. Announced politely and
                 without moving focus (WCAG 2.2 SC 3.2.1/3.2.2); only the root
                 failure below is assertive. */
                <InlineStatusBanner
                  severity="error"
                  role="status"
                  ariaLive="polite"
                  title={`Couldn't compare with ${mainBranch}`}
                  description={baseBranchError}
                  action={{
                    id: "review-hub-base-branch-retry",
                    label: "Retry",
                    onClick: () => void fetchBaseBranch(),
                  }}
                />
              ) : sortedBaseBranchFiles !== null && sortedBaseBranchFiles.length === 0 ? (
                /* A completed inspection: there is genuinely nothing to review
                 against the base branch. `user-cleared` is the Blank-Slate
                 variant — it forbids a description and an action by design, so
                 the redundant "This branch has no commits ahead of {main}"
                 subtitle goes with it. The headline alone carries the meaning,
                 and it is deliberately a DIFFERENT headline and a different
                 icon from the working-tree clean state, which used to look
                 identical to this one. */
                <EmptyState
                  variant="user-cleared"
                  scale="canvas"
                  className="py-12"
                  icon={<CircleCheck />}
                  title={`No changes vs ${mainBranch}`}
                />
              ) : sortedBaseBranchFiles !== null ? (
                <div>
                  <div className={REVIEW_HUB_STICKY_BAND}>
                    <div className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider")}>
                      <span className={SECTION_LABEL_CLASS}>
                        Changed vs{" "}
                        <span className="font-mono font-medium normal-case tracking-normal">
                          {mainBranch}
                        </span>
                        <span className={REVIEW_HUB_COUNT_CHIP}>
                          {pluralize(sortedBaseBranchFiles.length, "file")}
                        </span>
                        {/* On the band rather than in the chip, as in the
                            working-tree sections: the status inks fall under
                            4.5:1 on the chip's fill. */}
                        <DiffStat
                          insertions={baseBranchChurn.ins}
                          deletions={baseBranchChurn.del}
                          className="ml-2 font-normal normal-case tracking-normal"
                        />
                      </span>
                    </div>
                  </div>
                  <BaseBranchFileList
                    files={sortedBaseBranchFiles}
                    decorations={reviewDecorations}
                    onOpenFile={handleOpenBaseBranchFile}
                    onOpenDecorationUrl={handleOpenDecorationUrl}
                    scrollParent={scrollParent}
                  />
                </div>
              ) : null
            ) : (
              /* Working-tree panel */
              <>
                {loading && !status ? (
                  showWorkingTreeSkeleton ? (
                    <>
                      {/* File-list disclosure header, plus the section header
                        and rows that land under it when the list is expanded —
                        which is the default, but not if this worktree carries a
                        collapse, so the bones follow `fileListExpanded` rather
                        than the default or the list would snap shut on resolve.
                        The commit-panel skeleton lives outside this scroll
                        container (below), matching the real layout. */}
                      <Skeleton label="Loading review changes">
                        <div className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider")}>
                          <SkeletonBone immediate className="h-3.5 w-28" />
                        </div>
                        {fileListExpanded && (
                          <>
                            <div className="px-3 py-2 flex items-center justify-between">
                              <SkeletonBone immediate className="h-3.5 w-20" />
                              <SkeletonBone immediate className="h-5 w-32" />
                            </div>
                            <div className="px-3 pb-2 flex flex-col gap-2">
                              {SKELETON_FILE_ROW_WIDTHS.map((w) => (
                                <SkeletonBone key={w} immediate className={cn("h-3.5", w)} />
                              ))}
                            </div>
                          </>
                        )}
                      </Skeleton>
                      <SkeletonHint className="px-3 py-2" onRetry={() => void refresh()} />
                    </>
                  ) : null
                ) : loadError ? (
                  /* The ROOT failure: nothing else in the body rendered, so this
                   is the one presentation that is genuinely blocking and the
                   one that takes `role="alert"`. It previously rendered raw git
                   stderr as its entire user-facing message, with no icon at
                   all — which meant that under `forced-colors: active`, where
                   the UA strips the tint, it was typographically identical to
                   ordinary body text and nothing marked it as an error
                   (WCAG 2.2 SC 1.4.1). The icon is what survives that. */
                  <InlineStatusBanner
                    severity="error"
                    role="alert"
                    title="Couldn't load changes"
                    description={loadError}
                    action={{
                      id: "review-hub-load-retry",
                      label: "Retry",
                      onClick: () => void refresh(),
                    }}
                  />
                ) : status && isOperationState ? (
                  <ConflictPanel
                    status={status}
                    worktreePath={worktreePath}
                    onMarkResolved={handleMarkResolved}
                    onOpenInEditor={handleOpenInEditor}
                    onCheckoutOursTheirs={handleCheckoutOursTheirs}
                    onAbort={handleAbortOperation}
                    onContinue={handleContinueOperation}
                  />
                ) : status && totalChanges === 0 ? (
                  status.hasRemote && (aheadCount ?? 0) > 0 ? (
                    /* NOT a completed state. The working tree being clean is the
                     inert fact here; the unpushed commits are the live one, so
                     they own the headline and the icon rather than sitting in a
                     12px subtitle under a completion mark. Previously this and
                     the genuinely-finished state below rendered the same glyph,
                     the same layout and the same type scale, which meant "you
                     still have work to publish" and "you are done" were
                     distinguishable only by reading the small print. */
                    <div data-testid="review-hub-clean-unpushed">
                      <EmptyState
                        variant="zero-data"
                        scale="canvas"
                        className="py-12"
                        // The copy below is conditional on `pushError`, and
                        // EmptyState's fade-through keeps the OUTGOING text
                        // visually dominant for ~150ms. That is long enough to
                        // show "ready to push" underneath a banner that has
                        // already said the push failed, so this one transition
                        // has to be atomic rather than animated.
                        instant={pushError !== null}
                        icon={<ArrowUpFromLine />}
                        // "Ready to push" only where Push is actually offered:
                        // behind the remote, or with the divergence unknown,
                        // the button is withheld, and a readiness headline over
                        // no action was the pane contradicting itself.
                        title={
                          isPushing
                            ? `Pushing ${pluralize(aheadCount ?? 0, "commit")}`
                            : readinessSummary.pushReady && !pushError
                              ? `${pluralize(aheadCount ?? 0, "commit")} ready to push`
                              : `${pluralize(aheadCount ?? 0, "commit")} not pushed`
                        }
                        // "Ready to push" is a readiness claim, so it must not
                        // survive a rejection: after a push fails, `pushReady`
                        // goes false and the remedy moves to the push banner's
                        // pull-rebase / force-push. Claiming readiness while the
                        // banner directly above explains why it is not ready is
                        // the pane contradicting itself.
                        description={
                          pushError
                            ? `Nothing left to commit — resolve the push above to publish ${aheadCount === 1 ? "it" : "them"}.`
                            : status.pushDestination === null
                              ? // The commit history dropdown's words for the same case.
                                "No push destination · set an upstream to push"
                              : aheadCount === 1
                                ? "Nothing left to commit — this commit just isn't on the remote yet."
                                : "Nothing left to commit — these commits just aren't on the remote yet."
                        }
                        action={
                          readinessSummary.pushReady ? (
                            <Button
                              variant="contrast"
                              size="sm"
                              onClick={() => void handlePushClean()}
                              loading={isPushing}
                              data-testid="review-hub-clean-push"
                            >
                              Push
                            </Button>
                          ) : undefined
                        }
                      />
                    </div>
                  ) : (
                    /* Genuinely finished. `user-cleared` nulls the action and
                     forbids a description, which is what removes the redundant
                     "No changes to commit" line: the headline already says it. */
                    <EmptyState
                      variant="user-cleared"
                      scale="canvas"
                      className="py-12"
                      icon={<CircleCheck />}
                      title="Working tree clean"
                    />
                  )
                ) : status ? (
                  <div>
                    {/* File-list disclosure — default EXPANDED. The files are
                      what Commit & Push acts on, so they are this surface's D2
                      preview; "Show files (n)" alone was the bare count the
                      safeguards rubric calls insufficient. Collapsing reclaims
                      no space either (fixed-height dialog, commit box pinned
                      below). Still collapsible — state lives per worktree in
                      uiStore (session-scoped, in-memory only). */}
                    <div className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider")}>
                      <button
                        type="button"
                        onClick={() => setFileListExpanded(worktreePath, !fileListExpanded)}
                        aria-expanded={fileListExpanded}
                        aria-controls={`review-hub-files-${worktreePath}`}
                        data-testid="review-hub-file-list-toggle"
                        className={cn(
                          "inline-flex items-center gap-1 text-2xs font-medium text-text-secondary hover:text-text-primary transition-colors",
                          "rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                        )}
                      >
                        <ChevronRight
                          data-animated-chevron
                          className={cn(
                            "w-3 h-3 transition-transform duration-150 ease-out",
                            fileListExpanded && "rotate-90"
                          )}
                          aria-hidden="true"
                        />
                        {/* One label in both states (house rule: toggle labels
                            never change); the chevron and `aria-expanded`
                            carry open versus closed. */}
                        <span>Files ({totalChanges})</span>
                      </button>
                    </div>
                    {fileListExpanded && (
                      <div id={`review-hub-files-${worktreePath}`}>
                        {/* Conflicts with no operation behind them (a stash
                          pop). The rail above already says how many and that
                          they block the commit; what was missing was the files
                          themselves — they sit in neither section below, so the
                          pane could count a conflict it never named. The
                          worklist rows are ConflictPanel's own, with the same
                          Open, marker-checked Mark resolved and take-side menu.
                          Outside the listbox: its controls are real tab stops. */}
                        {hasConflicts && (
                          <div
                            ref={conflictSectionRef}
                            tabIndex={-1}
                            /* Focusable as the fallback target for the rail's
                               "Show conflicts" CTA, which lands on the first
                               row's Open when there is one. `focus:` because a
                               scripted focus after a pointer click never
                               matches `:focus-visible`; inset so the unpadded
                               scrollport cannot clip it. */
                            className="rounded-[var(--radius-md)] focus:outline focus:outline-2 focus:outline-accent-primary focus:-outline-offset-2"
                          >
                            <ConflictPanel
                              variant="worklist"
                              // The resolved file is now staged, so the next step
                              // is the message; the list is the fallback when the
                              // composer is unavailable.
                              onWorklistCleared={() =>
                                requestAnimationFrame(() => {
                                  const message =
                                    rootRef.current?.querySelector<HTMLTextAreaElement>(
                                      '[data-testid="review-hub-commit-message"]:not(:disabled)'
                                    );
                                  (message ?? fileListRef.current)?.focus({ preventScroll: true });
                                })
                              }
                              status={status}
                              worktreePath={worktreePath}
                              onMarkResolved={handleMarkResolved}
                              onOpenInEditor={handleOpenInEditor}
                              onCheckoutOursTheirs={handleCheckoutOursTheirs}
                              onAbort={handleAbortOperation}
                              onContinue={handleContinueOperation}
                            />
                          </div>
                        )}

                        <div
                          ref={fileListRef}
                          role="listbox"
                          aria-label="Changed files"
                          aria-multiselectable="true"
                          // The list's one tab stop (the same roving contract as the
                          // other file lists): rows never take DOM focus, and their
                          // diff, Viewed and stage controls sit outside the tab
                          // order because Enter, V and Space act on the cursor row.
                          tabIndex={navigableItems.length > 0 ? 0 : -1}
                          onFocus={(e) => {
                            // Tabbing in lands the cursor on the first row, so the
                            // active descendant (and its ring) exists at once.
                            // The key is what drives the reveal, so it is set with
                            // the index; re-entry reveals the cursor it left.
                            if (
                              e.target !== e.currentTarget ||
                              navigableItems.length === 0 ||
                              movingListFocusRef.current
                            )
                              return;
                            if (focusedIndex < 0) {
                              const first = navigableItems[0]!;
                              setFocusedIndex(0);
                              writeCursorKey(`${first.section}:${first.file.path}`);
                            } else {
                              fileListRef.current
                                ?.querySelector<HTMLElement>(`[data-row-index="${focusedIndex}"]`)
                                ?.scrollIntoView({ behavior: "instant", block: "nearest" });
                            }
                          }}
                          // Stands the global Shift+F10 / Menu-key handler down so
                          // the focused row's own menu opens instead of the focused
                          // panel's (`useGlobalKeybindings`).
                          data-row-menu=""
                          aria-activedescendant={
                            focusedRowIsMounted ? `review-hub-row-${focusedIndex}` : undefined
                          }
                          className="outline-hidden"
                        >
                          {/* Staged section */}
                          <FileSection
                            isStaged={true}
                            files={derivedStaged}
                            allFiles={status.staged}
                            indexOffset={0}
                            virtualized={workingTreeVirtualized}
                            setSize={navigableItems.length}
                            scrollParent={scrollParent}
                            listRef={stagedListRef}
                            onRenderedRangeChange={handleStagedRangeChange}
                            focusedIndex={focusedIndex}
                            selectionSection={selectionSection}
                            selectedPaths={selectedPaths}
                            hasSelection={hasStagedSelection}
                            view={stagedView}
                            setView={setStagedView}
                            inputRef={stagedInputRef}
                            setFilterQuery={setStagedFilterQuery}
                            clearFilter={clearStagedFilter}
                            onToggle={handleToggleStaged}
                            onRowClick={handleRowClick}
                            onBulkAction={() => {
                              const scope = resolveBulkScope(stagedView, hasStagedSelection);
                              void (scope === "selection"
                                ? handleUnstageSelection()
                                : scope === "shown"
                                  ? handleUnstageFiltered()
                                  : handleUnstageAll());
                            }}
                            viewedFiles={viewedFiles}
                            onViewedChange={handleViewedChange}
                            renderRowMenu={renderRowMenu}
                          />

                          {/* Unstaged section */}
                          <FileSection
                            sectionRef={unstagedSectionRef}
                            isStaged={false}
                            otherSectionHasFiles={status.staged.length > 0}
                            files={derivedUnstaged}
                            allFiles={status.unstaged}
                            indexOffset={derivedStaged.length}
                            virtualized={workingTreeVirtualized}
                            setSize={navigableItems.length}
                            scrollParent={scrollParent}
                            listRef={unstagedListRef}
                            onRenderedRangeChange={handleUnstagedRangeChange}
                            focusedIndex={focusedIndex}
                            selectionSection={selectionSection}
                            selectedPaths={selectedPaths}
                            hasSelection={hasUnstagedSelection}
                            view={changesView}
                            setView={setChangesView}
                            inputRef={changesInputRef}
                            setFilterQuery={setChangesFilterQuery}
                            clearFilter={clearChangesFilter}
                            onToggle={handleToggleUnstaged}
                            onRowClick={handleRowClick}
                            onBulkAction={() => {
                              const scope = resolveBulkScope(changesView, hasUnstagedSelection);
                              void (scope === "selection"
                                ? handleStageSelection()
                                : scope === "shown"
                                  ? handleStageFiltered()
                                  : handleStageAll());
                            }}
                            viewedFiles={viewedFiles}
                            onViewedChange={handleViewedChange}
                            renderRowMenu={renderRowMenu}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* Commit-panel skeleton — sibling of the scroll container so it occupies
            the same slot the real CommitPanel fills once status resolves, avoiding
            a height shift when content swaps in. Bones are aria-hidden; the in-
            scroll Skeleton above owns the role="status" announcement. */}
        {diffMode === "working-tree" && showWorkingTreeSkeleton && (
          <div className="border-t border-divider p-3 space-y-2" aria-hidden="true">
            <div className="flex items-center justify-between">
              <SkeletonBone immediate className="h-3 w-24" />
              <SkeletonBone immediate className="h-2.5 w-8" />
            </div>
            <SkeletonBone immediate className="h-14 w-full" />
            <SkeletonBone immediate className="h-3 w-48" />
            <div className="flex items-center gap-2">
              <SkeletonBone immediate className="h-7 flex-1" />
              <SkeletonBone immediate className="h-7 w-7 shrink-0" />
            </div>
          </div>
        )}

        {/* Commit panel — only in working-tree mode, and never during a conflict op */}
        {diffMode === "working-tree" &&
          status &&
          (totalChanges > 0 || isCommitPushInFlight) &&
          !loadError &&
          !isOperationState && (
            <CommitPanel
              stagedCount={status.staged.length}
              stagedPaths={stagedPaths}
              unpushedCount={aheadCount ?? null}
              isDetachedHead={status.isDetachedHead}
              hasConflicts={hasConflicts}
              hasRemote={status.hasRemote}
              pushDestination={status.pushDestination}
              worktreePath={worktreePath}
              currentBranch={status.currentBranch}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              onCommit={handleCommit}
              onCommitAndPush={handleCommitAndPush}
              onFocusBlocker={handleFocusBlocker}
              isPushing={isPushing}
              pushProgress={pushProgress}
              pushTargetBranch={pushTargetBranch}
              skipPushConfirm={skipPushConfirm}
              onSetSkipPushConfirm={(value) => setSkipPushConfirmForWorktree(worktreePath, value)}
              isVerifying={!statusIsFresh}
            />
          )}
      </div>
    </>
  );
}
