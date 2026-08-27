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
import type { StagingFileEntry, StagingStatus, GitStatus } from "@shared/types";
import type { PanelLocation } from "@shared/types/panel";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";
import { isClientAppError } from "@/utils/clientAppError";
import { cn } from "@/lib/utils";

import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  X,
  RefreshCw,
  CircleCheck,
  ArrowUpFromLine,
  ChevronRight,
  AlertTriangle,
  CircleAlert,
  GitBranch,
} from "lucide-react";
import { isProtectedBranch } from "@shared/utils/gitConstants";
import { useUIStore } from "@/store/uiStore";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import type { DiffChangeSetEntry } from "@/components/FileViewer/diffChangeSet";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { basename, join } from "@shared/utils/path";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  useFileRowMenuItems,
} from "@/hooks/useFileRowMenuItems";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeIdForPath } from "@/panels/diff/useWorktreeIdForPath";
import { type FileStageRowSection } from "./FileStageRow";
import { FileSection } from "./FileSection";
import {
  useReviewHubStagingActions,
  type ReviewHubActionFailure,
} from "./useReviewHubStagingActions";
import { BaseBranchFileRow } from "./BaseBranchFileRow";
import { PushErrorBanner } from "./PushErrorBanner";
import { PrStatusChip } from "./PrStatusChip";
import { CommitPanel } from "./CommitPanel";
import { ConflictPanel } from "./ConflictPanel";
import { ReadinessRail } from "./ReadinessRail";
import {
  deriveReviewReadiness,
  type ReviewReadinessCta,
  type ReviewReadinessItem,
} from "./reviewReadiness";
// Lazy: these modals statically reach the DiffViewer/CodeViewer/vendor-editor
// chunks (~223 KB gzip), and ReviewPane is a first-render preload seed — a
// static import drags the whole editor stack into every boot's modulepreload
// list. The modals open only on row click, so the chunk fetch overlaps user
// think-time; useKeepMounted gates the first mount so nothing is fetched (or
// rendered) until a diff is actually opened.
import { ForcePushConfirmDialog } from "./ForcePushConfirmDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { debounce } from "@/utils/debounce";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useFileDecorations } from "@/hooks/useFileDecorations";
import {
  useForgeProviderHealthStore,
  selectForgeProviderHealth,
} from "@/store/forgeProviderHealthStore";
import { useShallow } from "zustand/react/shallow";
import { systemClient } from "@/clients/systemClient";
import { forgeClient } from "@/clients/forgeClient";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { classifyGitError } from "@shared/utils/gitOperationErrors";
import {
  type DiffMode,
  type PushErrorState,
  type SectionViewState,
  DEFAULT_SECTION_STATE,
  matchesFilter,
  REVIEW_HUB_STICKY_BAND,
  readGitErrorFields,
  resolveBulkScope,
  sortFiles,
  sumChurn,
} from "./reviewHubUtils";
import { isGeneratedFile } from "../generatedFileClassifier";

/**
 * Floor for the dialog-hosted body, so the pane stops resizing itself around
 * its own content as it moves between loading, failure, empty and resolved.
 * Named rather than inlined to match `McpConfirmDialog`'s
 * `PREVIEW_MIN_BODY_HEIGHT`, which reserves a dialog body for the same reason.
 */
const DIALOG_MIN_BODY_HEIGHT = "min-h-[22rem]";

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
  keyboardScope,
  initialCommitMessage,
  autoStageOnOpen,
}: ReviewHubContentProps) {
  const isDialog = location === "dialog";
  const [status, setStatus] = useState<StagingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ReviewHubActionFailure | null>(null);
  const [pushError, setPushError] = useState<PushErrorState | null>(null);
  // Provider-classified push-error state, resolved async via the active forge
  // provider (ForgeProviderImpl lives in main). `forgeErrorCode` is a stable,
  // searchable code (e.g. `GH###`); `forgeProviderId` is the resolved
  // provider's contribution id, used to route the settings CTA. Both null when
  // no provider resolves or it doesn't recognize the stderr.
  const [forgeErrorCode, setForgeErrorCode] = useState<string | undefined>(undefined);
  const [forgeProviderId, setForgeProviderId] = useState<string | null>(null);
  const [showPushDetails, setShowPushDetails] = useState(false);
  const [pushProgress, setPushProgress] = useState<Map<string, PushProgressEvent>>(new Map());
  const [pushTargetBranch, setPushTargetBranch] = useState<string | null>(null);
  const [isPushing, setIsPushing] = useState(false);
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
  const [forcePushDialogOpen, setForcePushDialogOpen] = useState(false);
  const [pullRebaseConfirmOpen, setPullRebaseConfirmOpen] = useState(false);
  const [pullRebasing, setPullRebasing] = useState(false);
  const isPullRebasingRef = useRef(false);
  const [baseBranchFiles, setBaseBranchFiles] = useState<CrossWorktreeFile[] | null>(null);
  const [baseBranchLoading, setBaseBranchLoading] = useState(false);
  const [baseBranchError, setBaseBranchError] = useState<string | null>(null);
  const [selectedBaseBranchFile, setSelectedBaseBranchFile] = useState<CrossWorktreeFile | null>(
    null
  );
  // Diff panels opened by this hub. The selection state above stays the record
  // of "a diff is open" (the hub clears it on commit, worktree switch, and
  // conflict-mode entry), but the panel itself owns stepping between files once
  // open — so these effects only handle open, close, and keeping the change set
  // in step with the live poll.
  const [diffPanelId, setDiffPanelId] = useState<string | null>(null);
  const worktreeId = useWorktreeIdForPath(worktreePath);
  const hasWorkingTreeSelection = selectedFile !== null;
  const hasBaseBranchSelection = selectedBaseBranchFile !== null;
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
  }, [dialogStack, diffPanelId]);

  // Close the panel when the hub drops its selection for a reason of its own
  // (commit, worktree switch, conflict mode). Targeted by id: closing the top
  // of the stack from here would tear down whatever dialog currently sits
  // there, which may not be ours.
  useEffect(() => {
    if (hasWorkingTreeSelection || hasBaseBranchSelection || !diffPanelId) return;
    usePanelDialogStore.getState().closePanelDialogById(diffPanelId);
  }, [hasWorkingTreeSelection, hasBaseBranchSelection, diffPanelId]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectionSection, setSelectionSection] = useState<FileStageRowSection | null>(null);
  // Keyboard-navigation focus across the flat staged+unstaged file list. -1 means
  // no row is keyboard-focused. Driven entirely by the capture-phase key handler;
  // `fileListRef` scopes the listbox + scroll-into-view, and `focusedItemKeyRef`
  // (a `section:path` key) preserves focus on the same file across list mutations.
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const fileListRef = useRef<HTMLDivElement | null>(null);
  const focusedItemKeyRef = useRef<string | null>(null);
  const refreshIdRef = useRef(0);
  const bgRefreshIdRef = useRef(0);
  const baseBranchRequestRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const debouncedBgRefreshRef = useRef<ReturnType<typeof debounce> | null>(null);
  const conflictSectionRef = useRef<HTMLDivElement>(null);
  const unstagedSectionRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  // Row element that opened a diff modal; AppDialog falls back to it when the
  // trigger unmounted (e.g. the file left the list while the modal was open).
  const diffTriggerRef = useRef<HTMLElement | null>(null);
  // One-shot guard for the auto-stage-on-open behavior. Resets in the close
  // branch of the isOpen effect so reopening re-arms the check.
  const hasAutoStagedRef = useRef(false);

  const fileListExpanded = useUIStore((s) => s.reviewHubFileListExpanded[worktreePath] ?? false);
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

  // Reconcile `focusedIndex` when the list mutates (filter, sort, stage/unstage,
  // refresh). Preserve focus on the same file by `section:path`; if it left the
  // list, clamp to the nearest valid index so focus never points off the end.
  useEffect(() => {
    if (navigableItems.length === 0) {
      focusedItemKeyRef.current = null;
      setFocusedIndex((prev) => (prev === -1 ? prev : -1));
      return;
    }
    const key = focusedItemKeyRef.current;
    if (key === null) return;
    const nextIdx = navigableItems.findIndex((item) => `${item.section}:${item.file.path}` === key);
    if (nextIdx === -1) {
      const clamped = Math.min(focusedIndex < 0 ? 0 : focusedIndex, navigableItems.length - 1);
      const clampedItem = navigableItems[clamped];
      focusedItemKeyRef.current = clampedItem
        ? `${clampedItem.section}:${clampedItem.file.path}`
        : null;
      setFocusedIndex(clamped);
    } else if (nextIdx !== focusedIndex) {
      setFocusedIndex(nextIdx);
    }
  }, [navigableItems, focusedIndex]);

  // Scroll the focused row into view. `useLayoutEffect` so the scroll lands in
  // the same frame as the focus change, avoiding lag during key-repeat.
  useLayoutEffect(() => {
    if (focusedIndex < 0 || !fileListRef.current) return;
    const row = fileListRef.current.querySelector<HTMLElement>(
      `[data-row-index="${focusedIndex}"]`
    );
    row?.scrollIntoView({ behavior: "instant", block: "nearest" });
  }, [focusedIndex]);

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

  const mainBranch = useWorktreeStore(
    (state) =>
      Array.from(state.worktrees.values()).find((wt) => wt.isMainWorktree)?.branch ?? "main"
  );

  // Both change sets are rebuilt on every poll, so the open effects below read
  // them through this ref instead of depending on them — otherwise a quiet poll
  // would retrigger the open. Seeded at mount and resynced ahead of those
  // effects (effects in one commit run in declaration order); the panel's own
  // copy is kept current by the sync effect further down.
  const changeSetsRef = useRef({
    workingTree: workingTreeChangeSet,
    baseBranch: baseBranchChangeSet,
  });
  useEffect(() => {
    changeSetsRef.current = { workingTree: workingTreeChangeSet, baseBranch: baseBranchChangeSet };
  }, [workingTreeChangeSet, baseBranchChangeSet]);

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

  // Keep the open panel's change set in step with the live poll. The store
  // bails on a value-equal set, so a quiet poll costs nothing.
  useEffect(() => {
    if (!diffPanelId) return;
    const changeSet = selectedBaseBranchFile ? baseBranchChangeSet : workingTreeChangeSet;
    if (changeSet) usePanelStore.getState().setDiffPanelChangeSet(diffPanelId, changeSet);
  }, [diffPanelId, selectedBaseBranchFile, baseBranchChangeSet, workingTreeChangeSet]);

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
   * What the rail actually renders. Identical to `readinessSummary` except that
   * the `push-failed` item is dropped while the dedicated push banner is up —
   * see the note at the `ReadinessRail` call site. Never used for gating.
   */
  const railSummary = useMemo(() => {
    if (!pushError) return readinessSummary;
    const drop = (items: ReviewReadinessItem[]) => items.filter((i) => i.id !== "push-failed");
    return {
      ...readinessSummary,
      blockers: drop(readinessSummary.blockers),
      warnings: drop(readinessSummary.warnings),
      infos: drop(readinessSummary.infos),
      nextActions: drop(readinessSummary.nextActions),
    };
  }, [readinessSummary, pushError]);

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
    setShowPushDetails(false);
  }, [pushError]);

  // Read the latest initialCommitMessage without re-running the open/close
  // effect when the AI-note changes mid-session — protects user edits per #4220.
  const readInitialCommitMessage = useEffectEvent(() => initialCommitMessage ?? "");

  useEffect(() => {
    if (isOpen) {
      // This branch also re-runs when worktreePath changes while open (via
      // `refresh`'s identity): drop the previous worktree's staging status so
      // the file list and readiness rail never mix two worktrees' state.
      setStatus(null);
      setActionError(null);
      setPushError(null);
      const seed = readInitialCommitMessage();
      if (seed) setCommitMessage(seed);
      void refresh();
    } else {
      refreshIdRef.current++;
      bgRefreshIdRef.current++;
      baseBranchRequestRef.current++;
      // Clear the loading flags too: their owning requests are abandoned above
      // by bumping the request-id refs, so their `finally` blocks no longer fire
      // the reset. Leaving these true strands `useDohertyGate` (skeleton flashes
      // on reopen) and deadlocks base-branch (handleDiffModeChange refuses to
      // refetch while baseBranchLoading is true).
      setLoading(false);
      setBaseBranchLoading(false);
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
      setForcePushDialogOpen(false);
      setPullRebasing(false);
      isPullRebasingRef.current = false;
      // Viewed markers deliberately survive close/reopen (diffViewedStore).
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      setFocusedIndex(-1);
      focusedItemKeyRef.current = null;
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
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen || !autoStageOnOpen) return;
    if (!status) return;
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
        });
      }
    })();
  }, [isOpen, autoStageOnOpen, status, refresh, worktreePath]);

  useEffect(() => {
    if (diffMode === "base-branch" && status?.currentBranch === mainBranch) {
      baseBranchRequestRef.current++;
      setDiffMode("working-tree");
      setBaseBranchFiles(null);
      setBaseBranchError(null);
      setSelectedBaseBranchFile(null);
    }
  }, [status?.currentBranch, mainBranch, diffMode]);

  // Classify push failures via the active forge provider (lives in main).
  // Provider-agnostic: surfaces a stable error code and the provider id used
  // to route the settings CTA. Classification is best-effort — any failure
  // leaves the banner in its generic state with the raw stderr.
  useEffect(() => {
    // Clear synchronously so a new failure never shows the previous error's
    // code or routes its settings CTA to a stale provider while the new
    // classification is in flight.
    setForgeErrorCode(undefined);
    setForgeProviderId(null);
    if (!pushError || !worktreePath) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await forgeClient.classifyPushError(worktreePath, pushError.rawMessage);
        if (cancelled) return;
        setForgeProviderId(result?.providerId ?? null);
        setForgeErrorCode(result?.classification?.code);
      } catch {
        if (cancelled) return;
        setForgeProviderId(null);
        setForgeErrorCode(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushError, worktreePath]);

  useEffect(() => {
    if (!status || !selectionSection) return;
    const sectionFiles = selectionSection === "staged" ? status.staged : status.unstaged;
    const validPaths = new Set(sectionFiles.map((f) => f.path));
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      let mutated = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (validPaths.has(p)) next.add(p);
        else mutated = true;
      }
      if (!mutated) return prev;
      if (next.size === 0) {
        setSelectionSection(null);
        selectionAnchorRef.current = null;
      } else if (
        selectionAnchorRef.current !== null &&
        !validPaths.has(selectionAnchorRef.current)
      ) {
        // Anchor evicted but selection survives — reseat anchor on a remaining
        // path so the next shift-click extends from it rather than falling
        // through to plain-click (which would wipe the selection).
        selectionAnchorRef.current = next.values().next().value ?? null;
      }
      return next;
    });
  }, [status, selectionSection]);

  useEffect(() => {
    if (!isOpen) return;

    const debouncedBgRefresh = debounce(() => void backgroundRefresh(), 800);
    debouncedBgRefreshRef.current = debouncedBgRefresh;

    // Per-view worktree MessagePort — the same delivery the worktree store
    // consumes. The main-relayed events:push copy of worktree-update was
    // removed (this component was its only subscriber).
    const unsubscribe = window.electron.worktreePort.onEvent("worktree-update", (data) => {
      const event = data as { worktree?: { path?: string } };
      if (event?.worktree?.path === worktreePath) {
        debouncedBgRefresh();
      }
    });

    return () => {
      unsubscribe();
      debouncedBgRefresh.cancel();
      debouncedBgRefreshRef.current = null;
    };
  }, [isOpen, worktreePath, backgroundRefresh]);

  const handleCommit = useCallback(
    async (message: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.commit(worktreePath, message);
        // A commit resets the review: anything still (or newly) changed after
        // it is a new change, so stale viewed markers must not stick to it.
        useDiffViewedStore.getState().clearWorktree(worktreePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't commit changes",
          detail: formatErrorMessage(err, "Failed to commit changes"),
        });
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
      setActionError({
        title: "Couldn't abort repository operation",
        detail: formatErrorMessage(err, "Failed to abort repository operation"),
      });
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
      setActionError({
        title: "Couldn't continue repository operation",
        detail: formatErrorMessage(err, "Failed to continue repository operation"),
      });
      throw err;
    }
  }, [worktreePath, refresh]);

  const handleOpenInEditor = useCallback(
    async (args: string | { path: string; line?: number }) => {
      setActionError(null);
      const filePath = typeof args === "string" ? args : args.path;
      const line = typeof args === "string" ? undefined : args.line;
      try {
        const base = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
        const tail = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
        const payload: { path: string; line?: number } = { path: `${base}/${tail}` };
        if (typeof line === "number" && Number.isFinite(line) && line > 0) {
          payload.line = line;
        }
        await window.electron.system.openInEditor(payload);
      } catch (err) {
        setActionError({
          title: "Couldn't open file in editor",
          detail: formatErrorMessage(err, "Failed to open file in editor"),
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
    [worktreePath, refresh]
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
    [worktreePath, refresh]
  );

  const isPushingRef = useRef(false);

  const runPush = useCallback(async () => {
    if (isPushingRef.current) return;
    isPushingRef.current = true;
    setIsPushing(true);
    setPushError(null);
    setPushProgress(new Map());
    setPushTargetBranch(null);

    const cleanup = window.electron.git.onPushProgress((event) => {
      if (event.cwd !== worktreePath) return;
      if (event.stage === "target") {
        setPushTargetBranch(event.targetBranch ?? null);
        return;
      }
      setPushProgress((prev) => {
        const next = new Map(prev);
        next.set(event.stage, event);
        return next;
      });
    });

    try {
      await window.electron.git.push(worktreePath);
      setPushError(null);
    } catch (err) {
      // GitOperationError carries `gitReason` (auth-failed, push-rejected-*, etc.).
      // AppError carries `code` from a different union (RATE_LIMITED, etc.) — fall
      // back to "unknown" so getPushBannerConfig surfaces the raw message rather
      // than rendering an unmapped reason.
      const errFields = readGitErrorFields(err);
      const isRateLimited =
        isClientAppError(err) && (err as { code?: string }).code === "RATE_LIMITED";
      const rawMessage = isRateLimited
        ? "Too many push attempts in a short window — wait a moment and try again."
        : formatErrorMessage(err, "Failed to push");
      setPushError({
        reason: errFields.gitReason ?? classifyGitError(rawMessage),
        rawMessage,
        leaseSha: errFields.leaseSha,
        branchName: errFields.branchName,
      });
    } finally {
      cleanup();
      setIsPushing(false);
      isPushingRef.current = false;
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
        setActionError({
          title: "Couldn't commit changes",
          detail: formatErrorMessage(err, "Failed to commit changes"),
        });
        throw err;
      }
      // Same review reset as handleCommit — the changeset starts over.
      useDiffViewedStore.getState().clearWorktree(worktreePath);
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

  // Push from the clean-tree state, where no CommitPanel (and thus no local
  // push confirm) is mounted. Routes through the same D2 preview dialog the
  // git.push action uses, then reuses runPush so progress and error banners
  // stay on the hub's existing paths.
  const handlePushClean = useCallback(async () => {
    const confirmed = await useGitPushConfirmStore.getState().requestConfirmation(worktreePath);
    if (!confirmed) return;
    await runPush();
  }, [worktreePath, runPush]);

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
          conflictSectionRef.current?.focus();
        } else {
          const stageAllBtn = unstagedSectionRef.current?.querySelector("button");
          stageAllBtn?.focus();
        }
      });
    },
    [fileListExpanded, setFileListExpanded, worktreePath]
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
          setPullRebaseConfirmOpen(true);
          return;
        case "open-pr":
          void systemClient.openExternal(cta.url);
          return;
      }
    },
    [handleFocusBlocker]
  );

  const handlePullRebase = useCallback(async () => {
    if (isPullRebasingRef.current) return;
    isPullRebasingRef.current = true;
    setPullRebasing(true);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.pullRebase(worktreePath);
      // Successful rebase may have changed the working tree; refresh staging
      // status before clearing the banner so the user sees the new state.
      await refresh();
      setPushError(null);
    } catch (err) {
      // A rebase that halts on conflicts surfaces as `conflict-unresolved`;
      // surface it through the same banner so the user sees the next step.
      const errFields = readGitErrorFields(err);
      const rawMessage = formatErrorMessage(err, "Failed to pull and rebase");
      setPushError({
        reason: errFields.gitReason ?? classifyGitError(rawMessage),
        rawMessage,
      });
      // Refresh in case the rebase started and left files in conflict.
      await refresh();
    } finally {
      isPullRebasingRef.current = false;
      setPullRebasing(false);
    }
  }, [worktreePath, refresh]);

  const handleForcePushSuccess = useCallback(() => {
    setForcePushDialogOpen(false);
    setPushError(null);
    void refresh();
  }, [refresh]);

  const handleForcePushError = useCallback((err: unknown) => {
    setForcePushDialogOpen(false);
    const errFields = readGitErrorFields(err);
    const rawMessage = formatErrorMessage(err, "Failed to force push");
    setPushError({
      reason: errFields.gitReason ?? classifyGitError(rawMessage),
      rawMessage,
    });
  }, []);

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
    []
  );

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
    [status, selectionSection, openFileDiff]
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

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (selectedFile) {
        setSelectedFile(null);
      } else if (selectedBaseBranchFile) {
        setSelectedBaseBranchFile(null);
      } else if (selectedPaths.size > 0) {
        setSelectedPaths(new Set());
        setSelectionSection(null);
        selectionAnchorRef.current = null;
      } else {
        onClose();
      }
      return;
    }

    // Navigation/action keys below only apply to the file list. Skip them when
    // a text widget (filter inputs, commit textarea) or an open dropdown menu
    // has focus so normal typing and menu navigation are unaffected.
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    if (document.activeElement?.closest('[role="menu"]')) return;
    // A diff overlay owns the keyboard while open; don't move the list beneath it.
    if (selectedFile || selectedBaseBranchFile) return;
    // The file list is collapsed — no rows are visible, so don't let keys mutate
    // the index or fire stage/unstage/open-diff on rows the user can't see.
    if (!fileListExpanded) return;
    if (navigableItems.length === 0) return;

    // Shift+F10 / the ContextMenu key open the focused row's menu. The rows
    // never take DOM focus (the listbox owns it and names the row through
    // `aria-activedescendant`), so the menu is replayed as a synthetic
    // contextmenu on that row's node — Radix's ContextMenu has no imperative
    // open. Gated on the index resolving to a rendered row, not merely on a
    // non-empty list: a filter change can leave `focusedIndex` naming a row
    // that is no longer in the DOM.
    if (isFileRowMenuKey(e)) {
      const rowElement =
        focusedIndex >= 0
          ? (fileListRef.current?.querySelector<HTMLElement>(
              `[data-row-index="${focusedIndex}"]`
            ) ?? null)
          : null;
      if (openFileRowMenuFromKeyboard(rowElement)) {
        // Also suppresses the browser's own contextmenu for the keypress, so
        // the menu can't double-fire.
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Action keys (Enter/Space/v) carry side effects; never let them fire while a
    // button or link has focus, or we'd hijack that control's native activation
    // (e.g. Space on Refresh) and instead act on the last keyboard-focused row.
    const targetIsControl = target?.tagName === "BUTTON" || target?.tagName === "A";

    const moveFocus = (index: number) => {
      const item = navigableItems[index];
      if (!item) return;
      setFocusedIndex(index);
      focusedItemKeyRef.current = `${item.section}:${item.file.path}`;
      // Move DOM focus to the listbox so assistive tech announces the active
      // option via aria-activedescendant. Scroll is handled by the layout effect.
      fileListRef.current?.focus({ preventScroll: true });
    };

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(focusedIndex < 0 ? 0 : Math.min(focusedIndex + 1, navigableItems.length - 1));
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(focusedIndex < 0 ? navigableItems.length - 1 : Math.max(focusedIndex - 1, 0));
        return;
      }
      case "Enter": {
        if (targetIsControl || focusedIndex < 0) return;
        const item = navigableItems[focusedIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        openFileDiff(
          item.section,
          item.file.path,
          item.file.status,
          fileListRef.current?.querySelector<HTMLElement>(`[data-row-index="${focusedIndex}"]`) ??
            fileListRef.current
        );
        return;
      }
      case " ": {
        if (targetIsControl || focusedIndex < 0) return;
        const item = navigableItems[focusedIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        if (item.section === "staged") {
          handleToggleStaged(item.file.path);
        } else {
          handleToggleUnstaged(item.file.path);
        }
        return;
      }
      default: {
        if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (targetIsControl || focusedIndex < 0) return;
          const item = navigableItems[focusedIndex];
          if (!item) return;
          e.preventDefault();
          e.stopPropagation();
          const viewedKey = `${item.section}:${item.file.path}`;
          handleViewedChange(viewedKey, !viewedFiles.has(viewedKey));
        }
        return;
      }
    }
  });

  useEffect(() => {
    if (!isOpen) return;
    const scope = keyboardScope ?? document;
    if (scope instanceof Document) {
      scope.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => scope.removeEventListener("keydown", handleKeyDown, { capture: true });
    }
    scope.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => scope.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen, keyboardScope]);

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
  const repoState = status?.repoState ?? "CLEAN";
  const isOperationState =
    repoState === "MERGING" ||
    repoState === "REBASING" ||
    repoState === "CHERRY_PICKING" ||
    repoState === "REVERTING";

  return (
    <>
      <div
        className={cn("relative flex flex-col flex-1 min-h-0", "bg-daintree-bg", "outline-hidden")}
        data-testid="review-hub-content"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-divider shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* The dialog host already draws the title in AppDialog.Header —
                drawing it again would stack two "Review & Commit" headings. */}
            {!isDialog && (
              <h2
                id="review-hub-title"
                className="text-daintree-text font-semibold text-sm tracking-wide shrink-0"
              >
                Review & Commit
              </h2>
            )}
            {status?.currentBranch && (
              <TruncatedTooltip content={status.currentBranch}>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tint/[0.07] border border-tint/[0.08] text-[11px] text-daintree-text/60 font-mono truncate max-w-[200px]">
                  <GitBranch className="w-3 h-3 shrink-0" />
                  <span className="truncate">{status.currentBranch}</span>
                </span>
              </TruncatedTooltip>
            )}
            {status?.currentBranch && isProtectedBranch(status.currentBranch.toLowerCase()) && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-status-warning/10 border border-status-warning/30 text-[11px] text-status-warning shrink-0"
                data-testid="review-hub-protected-branch-chip"
              >
                <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>Protected</span>
              </span>
            )}
            <PrStatusChip
              hasRemote={status?.hasRemote}
              worktreePR={worktreePR}
              onOpenExternal={(url) => void systemClient.openExternal(url)}
            />
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
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                  diffMode === "working-tree"
                    ? "bg-filter-selected-bg-strong text-daintree-text"
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
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                  diffMode === "base-branch"
                    ? "bg-filter-selected-bg-strong text-daintree-text"
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
                <SpinningIcon
                  icon={RefreshCw}
                  active={loading || isBackgroundRefreshing}
                  className="w-3.5 h-3.5"
                />
              </button>
            )}
            {/* Same reason as the title: AppDialog.Header supplies the close
                control at this location. */}
            {!isDialog && (
              <button
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
            )}
          </div>
        </div>

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
            icon={CircleAlert}
            title={actionError.title}
            description={actionError.detail}
            onClose={() => setActionError(null)}
            action={{
              id: "review-hub-action-error-refresh",
              label: "Refresh",
              onClick: () => void refresh(),
            }}
          />
        )}
        {pushError && (
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
            onPullRebase={() => setPullRebaseConfirmOpen(true)}
            onForcePush={() => setForcePushDialogOpen(true)}
          />
        )}

        {/* Content */}
        <div
          ref={scrollContainerRef}
          data-testid="review-hub-scroll-container"
          className={cn(
            "flex-1 overflow-y-auto min-h-0",
            // Reserve the body in the DIALOG host so the pane stops resizing
            // itself around its own content. Loading, failure, empty and
            // resolved states used to produce wildly different dialog heights
            // — the same "Working tree clean" composition measured 458px on one
            // route and 522px on another — so a retry or a mode switch read as
            // a major transition rather than as the same surface updating.
            // Long content still scrolls inside this block, and the Doherty
            // gate still paints nothing before 400ms: the space is reserved,
            // not filled.
            //
            // Grid-hosted panes are deliberately excluded. There the tile owns
            // its own height from the layout, so a floor here would fight the
            // grid instead of stabilising anything.
            isDialog && DIALOG_MIN_BODY_HEIGHT,
            isBackgroundRefreshing && "surface-stale"
          )}
          aria-busy={isBackgroundRefreshing || undefined}
          onScroll={handleScrollContainer}
        >
          {diffMode === "base-branch" ? (
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
                  <SkeletonHint className="px-4 py-2" onRetry={() => void fetchBaseBranch()} />
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
                icon={CircleAlert}
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
                  <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle border-b border-divider">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
                      Changed vs {mainBranch}
                      <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                        {sortedBaseBranchFiles.length} file
                        {sortedBaseBranchFiles.length !== 1 ? "s" : ""}
                        {(baseBranchChurn.ins > 0 || baseBranchChurn.del > 0) && (
                          <>
                            {" "}
                            <span className="text-status-success/80">
                              +{baseBranchChurn.ins}
                            </span>{" "}
                            <span className="text-status-error/80">-{baseBranchChurn.del}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </div>
                </div>
                <div className="px-2 py-1 flex flex-col gap-0.5">
                  {sortedBaseBranchFiles.map((file) => {
                    const decoration = reviewDecorations[file.path];
                    return (
                      <BaseBranchFileRow
                        key={`${file.status}:${file.path}`}
                        file={file}
                        onClick={(e) => {
                          diffTriggerRef.current = e.currentTarget;
                          setSelectedBaseBranchFile(file);
                        }}
                        unresolvedDecoration={decoration}
                        onBadgeClick={
                          decoration?.url
                            ? () => void systemClient.openExternal(decoration.url as string)
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ) : null
          ) : (
            /* Working-tree panel */
            <>
              {loading && !status ? (
                showWorkingTreeSkeleton ? (
                  <>
                    {/* File-list disclosure header — mirrors the collapsed-by-
                        default list bar. The commit-panel skeleton lives outside
                        this scroll container (below), matching the real layout. */}
                    <Skeleton label="Loading review changes">
                      <div className="px-4 py-2 bg-overlay-subtle border-b border-divider">
                        <SkeletonBone immediate className="h-3.5 w-28" />
                      </div>
                    </Skeleton>
                    <SkeletonHint className="px-4 py-2" onRetry={() => void refresh()} />
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
                  icon={CircleAlert}
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
                      title={
                        pushError
                          ? `${aheadCount} commit${aheadCount !== 1 ? "s" : ""} not pushed`
                          : `${aheadCount} commit${aheadCount !== 1 ? "s" : ""} ready to push`
                      }
                      // "Ready to push" is a readiness claim, so it must not
                      // survive a rejection: after a push fails, `pushReady`
                      // goes false and the remedy moves to the push banner's
                      // pull-rebase / force-push. Claiming readiness while the
                      // banner directly above explains why it is not ready is
                      // the pane contradicting itself.
                      description={
                        pushError
                          ? "Nothing left to commit — resolve the push above to publish them."
                          : "Nothing left to commit — these commits just aren't on the remote yet."
                      }
                      action={
                        readinessSummary.pushReady ? (
                          <Button
                            variant="subtle"
                            size="sm"
                            onClick={() => void handlePushClean()}
                            disabled={isPushing}
                            data-testid="review-hub-clean-push"
                          >
                            {isPushing ? "Pushing…" : "Push"}
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
                  {/* File-list disclosure — default collapsed so the commit
                      textarea is the focal point on open. State lives per
                      worktree in uiStore (session-scoped, in-memory only). */}
                  <div className="px-4 py-2 bg-overlay-subtle border-b border-divider flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setFileListExpanded(worktreePath, !fileListExpanded)}
                      aria-expanded={fileListExpanded}
                      aria-controls={`review-hub-files-${worktreePath}`}
                      data-testid="review-hub-file-list-toggle"
                      className={cn(
                        "inline-flex items-center gap-1 text-[11px] font-medium text-daintree-text/70 hover:text-daintree-text transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent rounded"
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "w-3 h-3 transition-transform duration-150",
                          fileListExpanded && "rotate-90"
                        )}
                        aria-hidden="true"
                      />
                      <span>
                        {fileListExpanded ? "Hide" : "Show"} files ({totalChanges})
                      </span>
                    </button>
                  </div>
                  {fileListExpanded && (
                    <div
                      id={`review-hub-files-${worktreePath}`}
                      ref={fileListRef}
                      role="listbox"
                      aria-label="Changed files"
                      tabIndex={-1}
                      // Stands the global Shift+F10 / Menu-key handler down so
                      // the focused row's own menu opens instead of the focused
                      // panel's (`useGlobalKeybindings`).
                      data-row-menu=""
                      aria-activedescendant={
                        focusedIndex >= 0 ? `review-hub-row-${focusedIndex}` : undefined
                      }
                      className="outline-hidden"
                    >
                      {/* Conflict warning */}
                      {hasConflicts && (
                        <div
                          ref={conflictSectionRef}
                          tabIndex={-1}
                          /* Focusable because `handleFocusBlocker` sends focus
                             here from the readiness rail's "conflicts" CTA, so
                             it keeps its own ring. The banner inside carries the
                             shared failure grammar; this wrapper only owns
                             focus. */
                          className="outline-hidden focus:ring-2 focus:ring-daintree-accent/30"
                        >
                          <InlineStatusBanner
                            severity="warning"
                            role="status"
                            ariaLive="polite"
                            icon={AlertTriangle}
                            title={`${status.conflicted.length} conflicted file${
                              status.conflicted.length !== 1 ? "s" : ""
                            }`}
                            description="Resolve these before committing."
                            animated={false}
                          />
                        </div>
                      )}

                      {/* Staged section */}
                      <FileSection
                        isStaged={true}
                        files={derivedStaged}
                        allFiles={status.staged}
                        indexOffset={0}
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
                        files={derivedUnstaged}
                        allFiles={status.unstaged}
                        indexOffset={derivedStaged.length}
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
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Commit-panel skeleton — sibling of the scroll container so it occupies
            the same slot the real CommitPanel fills once status resolves, avoiding
            a height shift when content swaps in. Bones are aria-hidden; the in-
            scroll Skeleton above owns the role="status" announcement. */}
        {diffMode === "working-tree" && showWorkingTreeSkeleton && (
          <div className="border-t border-divider p-3 space-y-2" aria-hidden="true">
            <SkeletonBone immediate className="h-14 w-full" />
            <SkeletonBone immediate className="h-2.5 w-8 ml-auto" />
            <div className="flex items-center gap-2">
              <SkeletonBone immediate className="h-7 flex-1" />
              <SkeletonBone immediate className="h-7 w-7 shrink-0" />
            </div>
          </div>
        )}

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
            />
          )}
      </div>

      {pushError?.leaseSha && pushError.branchName && (
        <ForcePushConfirmDialog
          isOpen={forcePushDialogOpen}
          cwd={worktreePath}
          branchName={pushError.branchName}
          leaseSha={pushError.leaseSha}
          onClose={() => setForcePushDialogOpen(false)}
          onSuccess={handleForcePushSuccess}
          onError={handleForcePushError}
        />
      )}

      <ConfirmDialog
        isOpen={pullRebaseConfirmOpen}
        onClose={() => setPullRebaseConfirmOpen(false)}
        title={`Pull and rebase '${status?.currentBranch ?? "current branch"}'?`}
        description={
          <span>
            Replays{" "}
            {aheadCount != null ? (
              <span className="font-medium text-daintree-text">
                {aheadCount} local commit{aheadCount === 1 ? "" : "s"}
              </span>
            ) : (
              "your local commits"
            )}{" "}
            on top of{" "}
            {behindCount != null ? (
              <span className="font-medium text-daintree-text">
                {behindCount} incoming commit{behindCount === 1 ? "" : "s"}
              </span>
            ) : (
              "the incoming commits"
            )}{" "}
            from the remote. Rebasing rewrites local commit history and cannot be undone.
          </span>
        }
        confirmLabel="Pull and rebase"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          setPullRebaseConfirmOpen(false);
          void handlePullRebase();
        }}
      />
    </>
  );
}
