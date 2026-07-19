import { create, type StateCreator } from "zustand";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier, isGridPanelLocation, isPtyPanel } from "@shared/types/panel";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { Issue, PR } from "@shared/types/forge";
import type { FleetScopeToken } from "@shared/types/worktree";
import { useFocusStore } from "@/store/focusStore";
import { usePanelStore } from "@/store/panelStore";
import { logErrorWithContext } from "@/utils/errorContext";
import { PERF_MARKS } from "@shared/perf/marks";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { getFleetArmedIds, getFleetLastArmedId } from "./storeAccessors";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface CreateDialogState {
  isOpen: boolean;
  initialIssue: Issue | null;
  initialPR: PR | null;
  initialRecipeId: string | null;
  initialBranchInput: string | null;
  onCreated?: (worktreeId: string) => void;
}

export interface PendingCreation {
  path: string;
  branch: string;
  startedAt: number;
  status: "creating" | "error";
  error?: string;
}

/**
 * A worktree whose directory is gone but whose terminals are still alive
 * (#11232). Deleting a worktree used to kill every terminal that belonged to
 * it, which silently destroyed an agent's conversation — most painfully when
 * the agent deleted its *own* worktree via the `worktree.delete` action.
 *
 * The row keeps the sidebar row alive so those terminals have somewhere to
 * live until the user drags them to another worktree or dismisses the row.
 * Only display metadata is snapshotted here: membership is *derived* from the
 * panel store (see `getDeletedWorktreeTerminalIds`), so a terminal leaving by
 * any route — moved, trashed, killed, or exited — shrinks the row without
 * this store having to observe terminal lifecycle events at all.
 */
export interface DeletedWorktree {
  id: string;
  /**
   * Last known display name — the branch, or the directory name when the
   * worktree had no branch to speak of (detached HEAD). Snapshotted because
   * nothing can look it up again: git has forgotten the worktree entirely.
   */
  title: string;
  path: string;
  deletedAt: number;
  /**
   * When the row's auto-cleanup fires (terminals move to trash, row goes).
   * `null` while cleanup is off or the countdown hasn't been armed yet. Owned
   * entirely by the cleanup sweep (`deletedWorktreeCleanup.ts`), which arms,
   * pauses (by re-extending), and fires it — nothing else writes this.
   */
  expiresAt: number | null;
  /**
   * Index the row occupied in the sidebar's scrollable list when it was
   * deleted, so the row holds its slot instead of jumping to an edge.
   *
   * A deleted worktree cannot re-sort like a live worktree — the git status and activity
   * timestamps its sort keys derive from froze at deletion — so the position
   * is pinned once here rather than recomputed. `-1` means the row was not
   * visible (filtered out, or deleted before the sidebar ever rendered it),
   * in which case the row appends.
   */
  pinnedIndex: number;
}

/**
 * The sidebar's most recent visible worktree order, published by
 * `SidebarContent` so a deleted worktree can be pinned to the slot its row occupied.
 *
 * Deliberately a module-level value rather than store state: it changes on
 * every filter/sort keystroke and is read exactly once (at deletion), so
 * putting it in the store would re-render every subscriber for data nothing
 * renders from.
 */
let lastSidebarWorktreeOrder: readonly string[] = [];

export function recordSidebarWorktreeOrder(ids: readonly string[]): void {
  lastSidebarWorktreeOrder = ids;
}

export function getPinnedDeletedWorktreeIndex(worktreeId: string): number {
  return lastSidebarWorktreeOrder.indexOf(worktreeId);
}

/**
 * Terminals still held by a deleted worktree's row.
 *
 * Mirrors `bulkTrashByWorktree`'s filter exactly (trash + overlay + dialog
 * excluded) so
 * the count shown in the dismiss confirm always matches what dismissing
 * actually closes (#9699). Overlay panels are the Daintree Assistant, not
 * worktree sessions.
 */
export function getDeletedWorktreeTerminalIds(worktreeId: string): string[] {
  const { panelIdsByWorktreeId, panelsById } = usePanelStore.getState();
  const ids = panelIdsByWorktreeId[worktreeId];
  if (!ids || ids.length === 0) return [];
  return ids.filter((id) => {
    const panel = panelsById[id];
    return (
      panel != null &&
      panel.location !== "trash" &&
      panel.location !== "overlay" &&
      panel.location !== "dialog"
    );
  });
}

interface QuickCreateState {
  isOpen: boolean;
  issue: Issue | null;
  pr: PR | null;
}

interface BulkCreateDialogState {
  isOpen: boolean;
  mode: "issue" | "pr";
  selectedIssues: Issue[];
  selectedPRs: PR[];
  onComplete?: () => void;
}

interface CrossDiffDialogState {
  isOpen: boolean;
  initialWorktreeId: string | null;
}

interface WorktreeSelectionState {
  activeWorktreeId: string | null;
  /**
   * The last *durable* worktree selection — the one that should round-trip
   * across project switches. Diverges from `activeWorktreeId` when a worktree
   * becomes active incidentally (a terminal in another worktree gains focus;
   * see `selectWorktree({ source: "focus" })`). Such focus promotions update
   * `activeWorktreeId` for the session but must not become the persisted
   * restore point, or an unrelated operation (e.g. a batch PR merge spinning up
   * temporary worktrees) could leave the project restoring a stray temp
   * worktree instead of root (#9512).
   */
  restoreWorktreeId: string | null;
  focusedWorktreeId: string | null;
  pendingWorktreeId: string | null;
  pendingCreations: Map<string, PendingCreation>;
  /**
   * Deleted worktrees whose terminals outlived them, keyed by the former
   * worktree id (#11232). In-memory only — a deleted directory no longer
   * exists and git has forgotten the worktree, so there is nothing for the
   * restore pipeline's cwd inference to resolve on the next launch.
   */
  deletedWorktrees: Map<string, DeletedWorktree>;
  expandedWorktrees: Set<string>;
  expandedTerminals: Set<string>;
  createDialog: CreateDialogState;
  bulkCreateDialog: BulkCreateDialogState;
  quickCreate: QuickCreateState;
  crossDiffDialog: CrossDiffDialogState;
  _policyGeneration: number;
  lastFocusedTerminalByWorktree: Map<string, string>;
  /**
   * Maximize state for every worktree that is *not* the active one (#11183).
   *
   * The panel store's `maximizedId`/`maximizeTarget`/`preMaximizeLayout` are
   * flat singular fields describing what the grid is showing *right now*, so
   * they can only ever describe one worktree. Left alone across a switch, they
   * keep pointing at a panel the incoming worktree doesn't own — `ContentGrid`
   * takes its maximize branch, fails to find the target among the active
   * worktree's grid panels, and renders nothing.
   *
   * Invariant: a worktree's maximize lives in exactly ONE place — the panel
   * store's flat fields while it is active, this map while it is not. Switching
   * out writes the outgoing worktree's slot; switching in deletes the incoming
   * one (restorable or not) and moves it back into the flat fields.
   */
  maximizeByWorktree: Map<string, WorktreeMaximizeSnapshot>;
  isFleetScopeActive: boolean;
  _previousActiveWorktreeId: string | null;
  /** Durable selection captured at fleet-scope entry, restored on exit (#9512). */
  _previousRestoreWorktreeId: string | null;
  _fleetScopeToken: FleetScopeToken | null;

  setActiveWorktree: (id: string | null) => void;
  setFocusedWorktree: (id: string | null) => void;
  selectWorktree: (id: string, options?: { source?: "user" | "focus" }) => void;
  setPendingWorktree: (id: string | null) => void;
  applyPendingWorktreeSelection: (worktreeId: string) => void;
  addPendingCreation: (path: string, meta: { branch: string }) => void;
  resolvePendingCreation: (path: string) => void;
  failPendingCreation: (path: string, error: string) => void;
  dismissPendingCreation: (path: string) => void;
  addDeletedWorktree: (worktree: DeletedWorktree) => void;
  dismissDeletedWorktree: (worktreeId: string) => void;
  setDeletedWorktreeExpiry: (worktreeId: string, expiresAt: number | null) => void;
  clearRestoreTarget: (worktreeId: string) => void;
  pruneDeletedWorktrees: (liveWorktreeIds: ReadonlySet<string>) => void;
  toggleWorktreeExpanded: (id: string) => void;
  setWorktreeExpanded: (id: string, expanded: boolean) => void;
  collapseAllWorktrees: () => void;
  toggleTerminalsExpanded: (id: string) => void;
  setTerminalsExpanded: (id: string, expanded: boolean) => void;
  openCreateDialog: (
    initialIssue?: Issue | null,
    options?: {
      initialRecipeId?: string | null;
      initialBranchInput?: string | null;
      onCreated?: (worktreeId: string) => void;
    }
  ) => void;
  openCreateDialogForPR: (pr: PR) => void;
  closeCreateDialog: () => void;
  openBulkCreateDialog: (selectedIssues: Issue[], onComplete?: () => void) => void;
  openBulkCreateDialogForPRs: (selectedPRs: PR[], onComplete?: () => void) => void;
  closeBulkCreateDialog: () => void;
  openQuickCreate: (context?: { issue?: Issue | null; pr?: PR | null }) => void;
  closeQuickCreate: () => void;
  openCrossWorktreeDiff: (initialWorktreeId?: string | null) => void;
  closeCrossWorktreeDiff: () => void;
  trackTerminalFocus: (worktreeId: string, terminalId: string) => void;
  clearWorktreeFocusTracking: (worktreeId: string) => void;
  clearWorktreeMaximizeTracking: (worktreeId: string) => void;
  enterFleetScope: () => FleetScopeToken;
  exitFleetScope: (token: FleetScopeToken) => void;
  reset: () => void;
}

type ClientsModule = typeof import("@/clients");

let clientsModulePromise: Promise<ClientsModule> | null = null;
let lastPersistedActiveWorktreeId: string | null | undefined;
let pendingPersistActiveWorktreeId: string | null | undefined;
let persistRequestVersion = 0;

let lastPersistedMruList: string[] | undefined;
let pendingPersistMruList: string[] | undefined;
let mruPersistVersion = 0;
let mruRecordingSuppressed = false;

/** Call before app/project hydration to prevent hydration focus events from corrupting MRU. */
export function suppressMruRecording(suppress: boolean): void {
  mruRecordingSuppressed = suppress;
}

export function isMruRecordingSuppressed(): boolean {
  return mruRecordingSuppressed;
}

function mruListsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function persistMruList(list: string[]): void {
  if (mruListsEqual(pendingPersistMruList ?? lastPersistedMruList, list)) {
    return;
  }

  pendingPersistMruList = list;
  const requestVersion = ++mruPersistVersion;

  void loadClientsModule()
    .then(({ appClient }) => appClient.setState({ mruList: list }))
    .then(() => {
      if (requestVersion === mruPersistVersion) {
        lastPersistedMruList = list;
        pendingPersistMruList = undefined;
      }
    })
    .catch((error) => {
      if (requestVersion === mruPersistVersion) {
        pendingPersistMruList = undefined;
      }
      logErrorWithContext(error, {
        operation: "persist_mru_list",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { listLength: list.length },
      });
    });
}

function loadClientsModule(): Promise<ClientsModule> {
  if (!clientsModulePromise) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    markRendererPerformance("dynamic_import_start", { module: "@/clients" });
    clientsModulePromise = import("@/clients")
      .then((module) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/clients",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: true,
        });
        return module;
      })
      .catch((error) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/clients",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: false,
          error: formatErrorMessage(error, "Failed to load @/clients module"),
        });
        throw error;
      });
  }
  return clientsModulePromise;
}

// Double-rAF after the selection commit lands the paint-anchored companion to
// WORKTREE_SWITCH_END (which measures store mutation + terminal policy, not
// when the user sees the new panels). Scheduling is skipped entirely unless a
// capture run or consumer buffer is active, so the steady-state cost is one
// boolean check per switch.
function scheduleWorktreeSwitchPaintedMark(
  fromWorktreeId: string | null,
  toWorktreeId: string | null,
  switchStartedAt: number
): void {
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") return;
  if (!isRendererPerfCaptureEnabled() && !Array.isArray(window.__DAINTREE_PERF_MARKS__)) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_PAINTED, {
        fromWorktreeId,
        toWorktreeId,
        durationMs: Date.now() - switchStartedAt,
      });
    });
  });
}

function persistActiveWorktree(id: string | null): void {
  if (id === lastPersistedActiveWorktreeId || id === pendingPersistActiveWorktreeId) {
    return;
  }

  pendingPersistActiveWorktreeId = id;
  const requestVersion = ++persistRequestVersion;

  const payload = { activeWorktreeId: id ?? undefined };

  void loadClientsModule()
    .then(({ appClient }) => appClient.setState(payload))
    .then(() => {
      if (requestVersion === persistRequestVersion) {
        lastPersistedActiveWorktreeId = id;
      }
    })
    .catch((error) => {
      if (requestVersion === persistRequestVersion) {
        pendingPersistActiveWorktreeId = undefined;
      }
      logErrorWithContext(error, {
        operation: "persist_active_worktree",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { worktreeId: id },
      });
    })
    .finally(() => {
      if (pendingPersistActiveWorktreeId === id) {
        pendingPersistActiveWorktreeId = undefined;
      }
    });
}

/** The panel-store fields that together describe one worktree's maximize. */
type PanelMaximizeFields = Pick<
  ReturnType<typeof usePanelStore.getState>,
  "maximizedId" | "maximizeTarget" | "preMaximizeLayout"
>;

/** What the swap needs to read to decide whether a stashed maximize still holds. */
type PanelMaximizeLookup = Pick<
  ReturnType<typeof usePanelStore.getState>,
  "panelsById" | "tabGroups" | "focusedId"
>;

/**
 * A stashed maximize. Both halves of the pair are non-null by construction:
 * `ContentGrid` only takes its maximize branch when `maximizedId` AND
 * `maximizeTarget` are set, and a half-populated pair is the stale-target bug
 * class of #9935. `preMaximizeLayout` rides along so unmaximizing after a
 * round-trip restores the column count the worktree had before it maximized.
 */
export interface WorktreeMaximizeSnapshot {
  maximizedId: string;
  maximizeTarget: NonNullable<PanelMaximizeFields["maximizeTarget"]>;
  preMaximizeLayout: PanelMaximizeFields["preMaximizeLayout"];
}

const CLEARED_MAXIMIZE: PanelMaximizeFields = {
  maximizedId: null,
  maximizeTarget: null,
  preMaximizeLayout: null,
};

function captureMaximizeSnapshot(panels: PanelMaximizeFields): WorktreeMaximizeSnapshot | null {
  const { maximizedId, maximizeTarget, preMaximizeLayout } = panels;
  if (!maximizedId || !maximizeTarget) return null;
  return { maximizedId, maximizeTarget, preMaximizeLayout };
}

/**
 * Is a stashed maximize still renderable in `worktreeId`? Returns the snapshot
 * to write back (normalized), or null to clear.
 *
 * Runs *before* the flat fields are written, unlike `validateMaximizeTarget`,
 * which repairs already-live state from a render effect — too late to stop the
 * grid painting a blank frame. The panel must be a grid panel *of this
 * worktree*: a docked, backgrounded or trashed panel can't satisfy
 * `ContentGrid`'s maximize branch either, and a panel that has since moved to
 * another worktree is no longer ours to show.
 */
function resolveMaximizeForWorktree(
  snapshot: WorktreeMaximizeSnapshot,
  worktreeId: string,
  panels: PanelMaximizeLookup
): WorktreeMaximizeSnapshot | null {
  const panel = panels.panelsById[snapshot.maximizedId];
  if (!panel || panel.worktreeId !== worktreeId || !isGridPanelLocation(panel.location)) {
    return null;
  }

  // The layout snapshot is stamped with the worktree it was captured in; one
  // from elsewhere would restore a foreign column count. Drop just that field
  // rather than the whole maximize — the grid recomputes columns from scratch.
  const preMaximizeLayout =
    snapshot.preMaximizeLayout?.worktreeId === worktreeId ? snapshot.preMaximizeLayout : null;

  if (snapshot.maximizeTarget.type === "panel") {
    if (snapshot.maximizeTarget.id !== snapshot.maximizedId) return null;
    return { ...snapshot, preMaximizeLayout };
  }

  const group = panels.tabGroups.get(snapshot.maximizeTarget.id);
  if (
    !group ||
    group.location !== "grid" ||
    group.worktreeId !== worktreeId ||
    !group.panelIds.includes(snapshot.maximizedId)
  ) {
    return null;
  }
  if (group.panelIds.length === 1) {
    // The group shrank to a single panel while we were away. Downgrade to a
    // panel maximize rather than dropping the maximize entirely, mirroring
    // `validateMaximizeTarget`'s repair of the same case on live state.
    return {
      maximizedId: snapshot.maximizedId,
      maximizeTarget: { type: "panel", id: snapshot.maximizedId },
      preMaximizeLayout,
    };
  }
  return { ...snapshot, preMaximizeLayout };
}

/** Would this maximize leave `panelId` on screen? */
function maximizeShowsPanel(
  snapshot: WorktreeMaximizeSnapshot,
  panelId: string,
  panels: PanelMaximizeLookup
): boolean {
  if (snapshot.maximizeTarget.type === "panel") {
    return snapshot.maximizeTarget.id === panelId;
  }
  return panels.tabGroups.get(snapshot.maximizeTarget.id)?.panelIds.includes(panelId) ?? false;
}

/**
 * Move maximize state across a worktree switch: stash the outgoing worktree's,
 * restore the incoming worktree's.
 *
 * Returns the next map plus the patch to write to the panel store. The caller
 * writes the worktree store first so any panel-store subscriber woken by the
 * patch already sees the new `activeWorktreeId`. Both writes land synchronously
 * in the same tick (React 19 batches them), so the grid never paints a frame
 * where the trio points at a panel the active worktree can't render.
 *
 * Restore is skipped — and the stash dropped — when:
 *  - the snapshot no longer resolves in the incoming worktree (stale target), or
 *  - the switch is a `"focus"` promotion whose focused panel this maximize would
 *    bury. A promotion means "reveal this panel" — it is how `useTypeAnywhere`,
 *    panel spawning and the quick switcher surface a panel living in a worktree
 *    the user isn't looking at, and those callers' defensive `exitMaximize()`
 *    only clears the *outgoing* worktree's. Restoring a maximize that does show
 *    the panel (navigating straight back to it) is still correct.
 *
 * Worktree switches *inside* fleet scope don't swap at all — they clear the flat
 * trio and leave the parked maximizes alone (see the call sites). Fleet scope
 * spans every worktree, so no single worktree owns the grid while it's up;
 * `exitFleetScope` is the one fleet caller that does swap, reconciling the trio
 * for the worktree being returned to.
 */
function prepareWorktreeMaximizeSwap(
  state: WorktreeSelectionState,
  fromWorktreeId: string | null,
  toWorktreeId: string | null,
  source: "user" | "focus"
): { maximizeByWorktree: Map<string, WorktreeMaximizeSnapshot>; panelPatch: PanelMaximizeFields } {
  const panels = usePanelStore.getState();
  const next = new Map(state.maximizeByWorktree);

  if (fromWorktreeId) {
    const outgoing = captureMaximizeSnapshot(panels);
    if (outgoing) {
      next.set(fromWorktreeId, outgoing);
    } else {
      next.delete(fromWorktreeId);
    }
  }

  let restored: WorktreeMaximizeSnapshot | null = null;
  if (toWorktreeId) {
    const stashed = next.get(toWorktreeId);
    // The incoming worktree becomes active, so its maximize moves back into the
    // flat fields — drop the slot whether or not it survives validation.
    next.delete(toWorktreeId);
    if (stashed) {
      const candidate = resolveMaximizeForWorktree(stashed, toWorktreeId, panels);
      const buriesFocusedPanel =
        source === "focus" &&
        (panels.focusedId === null ||
          !maximizeShowsPanel(candidate ?? stashed, panels.focusedId, panels));
      if (candidate && !buriesFocusedPanel) {
        restored = candidate;
      }
    }
  }

  return { maximizeByWorktree: next, panelPatch: restored ?? CLEARED_MAXIMIZE };
}

const createWorktreeSelectionStore: StateCreator<WorktreeSelectionState> = (set, get) => ({
  activeWorktreeId: null,
  restoreWorktreeId: null,
  focusedWorktreeId: null,
  pendingWorktreeId: null,
  pendingCreations: new Map<string, PendingCreation>(),
  deletedWorktrees: new Map<string, DeletedWorktree>(),
  expandedWorktrees: new Set<string>(),
  expandedTerminals: new Set<string>(),
  createDialog: {
    isOpen: false,
    initialIssue: null,
    initialPR: null,
    initialRecipeId: null,
    initialBranchInput: null,
    onCreated: undefined,
  },
  bulkCreateDialog: {
    isOpen: false,
    mode: "issue",
    selectedIssues: [],
    selectedPRs: [],
    onComplete: undefined,
  },
  quickCreate: { isOpen: false, issue: null, pr: null },
  crossDiffDialog: { isOpen: false, initialWorktreeId: null },
  _policyGeneration: 0,
  lastFocusedTerminalByWorktree: new Map<string, string>(),
  maximizeByWorktree: new Map<string, WorktreeMaximizeSnapshot>(),
  isFleetScopeActive: false,
  _previousActiveWorktreeId: null,
  _previousRestoreWorktreeId: null,
  _fleetScopeToken: null,

  setActiveWorktree: (id) => {
    const previousId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    const switchStartedAt = Date.now();
    markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_START, {
      fromWorktreeId: previousId ?? null,
      toWorktreeId: id ?? null,
    });

    // Auto-collapse terminals accordion when switching worktrees
    const updates: Partial<WorktreeSelectionState> = {
      activeWorktreeId: id,
      focusedWorktreeId: id,
      _policyGeneration: generation,
    };

    if (id !== null) {
      // An explicit activation is a durable selection — make it the restore
      // target so switching projects round-trips back to it (#9512).
      updates.restoreWorktreeId = id;
    } else if (previousId !== null && previousId === get().restoreWorktreeId) {
      // Active worktree cleared (e.g. it was removed) AND it was the durable
      // selection: drop the restore target so the project falls back to the
      // main worktree on return. If the cleared worktree was only incidentally
      // active (focus-promoted), the durable selection is left intact (#9512).
      updates.restoreWorktreeId = null;
    }

    // An explicit activation is a deliberate selection, so it restores the
    // incoming worktree's maximize the same way `selectWorktree({source:"user"})`
    // does. Guarded on an actual change: re-activating the current worktree must
    // not round-trip its live maximize through the map (#11183).
    let panelPatch: PanelMaximizeFields | null = null;
    if (previousId !== id) {
      updates.expandedTerminals = new Set<string>();
      if (get().isFleetScopeActive) {
        // Inside fleet scope: clear the trio, but leave the parked maximizes
        // alone — the user hasn't left the fleet view, so an inactive worktree's
        // maximize is still owed to them on their way back.
        //
        // The clear is not optional. It is tempting to skip it because the fleet
        // branch renders ahead of the maximize branch, but `isFleetScopeRender`
        // also requires a non-empty armed set (useContentGridContext) — clearing
        // the fleet selection without leaving scope drops straight through to the
        // maximize branch, where a trio left describing the *previous* worktree
        // resolves against this one's panels and renders nothing (#11183).
        panelPatch = CLEARED_MAXIMIZE;
      } else {
        const swap = prepareWorktreeMaximizeSwap(get(), previousId, id, "user");
        updates.maximizeByWorktree = swap.maximizeByWorktree;
        panelPatch = swap.panelPatch;
      }
    }

    set(updates);
    if (panelPatch) {
      usePanelStore.setState(panelPatch);
    }
    scheduleWorktreeSwitchPaintedMark(previousId ?? null, id ?? null, switchStartedAt);

    persistActiveWorktree(id);

    applyWorktreeTerminalPolicy(get, set, id, generation, () => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_END, {
        fromWorktreeId: previousId ?? null,
        toWorktreeId: id ?? null,
        durationMs: Date.now() - switchStartedAt,
      });
    });
  },

  setFocusedWorktree: (id) => set({ focusedWorktreeId: id }),

  selectWorktree: (id, options) => {
    // `"user"` (default) is a deliberate selection: it becomes the durable
    // restore target, is persisted to the main-process store, and is recorded
    // in the MRU. `"focus"` is an incidental promotion (a terminal in another
    // worktree gained focus) — it updates the active worktree for the session
    // only, so it never pollutes the persisted restore point or the MRU (#9512).
    const source = options?.source ?? "user";

    // Skip if already active to prevent terminal reload flicker.
    // Also clear any pending selection for this ID — it's already active,
    // so the terminal policy was applied when we first selected it.
    if (get().activeWorktreeId === id) {
      if (get().pendingWorktreeId === id) {
        set({ pendingWorktreeId: null });
      }
      // A deliberate re-selection of the already-active worktree still confirms
      // it as the durable restore target (it may have been activated only via
      // focus promotion before).
      if (source === "user" && get().restoreWorktreeId !== id) {
        set({ restoreWorktreeId: id });
        persistActiveWorktree(id);
      }
      return;
    }

    const previousId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    const switchStartedAt = Date.now();
    markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_START, {
      fromWorktreeId: previousId ?? null,
      toWorktreeId: id,
    });
    const maximizeSwap = get().isFleetScopeActive
      ? null
      : prepareWorktreeMaximizeSwap(get(), previousId, id, source);
    // Auto-collapse terminals accordion when switching worktrees
    set({
      activeWorktreeId: id,
      focusedWorktreeId: id,
      _policyGeneration: generation,
      expandedTerminals: new Set<string>(),
      ...(maximizeSwap ? { maximizeByWorktree: maximizeSwap.maximizeByWorktree } : {}),
      ...(source === "user" ? { restoreWorktreeId: id } : {}),
    });
    // Hand the incoming worktree's maximize (or a clear) to the panel store in
    // the same tick as the switch, and before the terminal policy / focus
    // restore below — a frame in between would render the outgoing worktree's
    // maximize target against this worktree's grid, i.e. nothing at all (#11183).
    usePanelStore.setState(maximizeSwap?.panelPatch ?? CLEARED_MAXIMIZE);
    scheduleWorktreeSwitchPaintedMark(previousId ?? null, id, switchStartedAt);

    if (source === "user") {
      persistActiveWorktree(id);

      // Record worktree MRU on explicit selection (suppressed during hydration)
      if (!mruRecordingSuppressed) {
        usePanelStore.getState().recordMru(`worktree:${id}`);
        persistMruList(usePanelStore.getState().mruList);
      }
    }

    applyWorktreeTerminalPolicy(get, set, id, generation, () => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_END, {
        fromWorktreeId: previousId ?? null,
        toWorktreeId: id,
        durationMs: Date.now() - switchStartedAt,
      });
    });

    // Restore the last focused terminal for this worktree. Runs synchronously
    // in the same tick as the set() above, so the prior generation/active
    // guards are now dead — nothing between the set() and here can change
    // them. Only the terminal-validity checks remain load-bearing.
    const lastFocusedTerminalId = get().lastFocusedTerminalByWorktree.get(id);
    if (lastFocusedTerminalId) {
      const terminal = usePanelStore.getState().panelsById[lastFocusedTerminalId];
      // Validate terminal still exists, belongs to this worktree, and isn't in trash
      if (terminal && terminal.worktreeId === id && terminal.location !== "trash") {
        usePanelStore.getState().setFocused(lastFocusedTerminalId);
      }
    }
  },

  setPendingWorktree: (id) => set({ pendingWorktreeId: id }),

  applyPendingWorktreeSelection: (worktreeId) => {
    const state = get();
    if (state.pendingWorktreeId !== worktreeId) {
      return;
    }
    // Always clear pending — if the active worktree has since changed, this pending is stale.
    set({ pendingWorktreeId: null });
    // Only apply terminal policy if this worktree is still the active one.
    if (state.activeWorktreeId !== worktreeId) {
      return;
    }
    // Read _policyGeneration WITHOUT incrementing: this applies a pending
    // selection that was queued before the active worktree settled, so it
    // must not supersede an in-flight explicit transition that bumped the
    // generation after the pending was set — passing the current value lets
    // applyWorktreeTerminalPolicy's guard bail if that happened.
    const generation = state._policyGeneration;
    applyWorktreeTerminalPolicy(get, set, worktreeId, generation);
  },

  addPendingCreation: (path, meta) => {
    set((state) => {
      // Idempotent for in-flight creations (StrictMode-safe). An error entry is
      // replaced so a retry resubmission resets status to "creating".
      const existing = state.pendingCreations.get(path);
      if (existing && existing.status === "creating") return state;
      const next = new Map(state.pendingCreations);
      next.set(path, {
        path,
        branch: meta.branch,
        startedAt: Date.now(),
        status: "creating",
      });
      return { pendingCreations: next };
    });
  },

  resolvePendingCreation: (path) => {
    set((state) => {
      if (!state.pendingCreations.has(path)) return state;
      const next = new Map(state.pendingCreations);
      next.delete(path);
      return { pendingCreations: next };
    });
  },

  failPendingCreation: (path, error) => {
    set((state) => {
      const existing = state.pendingCreations.get(path);
      if (!existing) return state;
      const next = new Map(state.pendingCreations);
      next.set(path, { ...existing, status: "error", error });
      return { pendingCreations: next };
    });
  },

  dismissPendingCreation: (path) => {
    set((state) => {
      if (!state.pendingCreations.has(path)) return state;
      const next = new Map(state.pendingCreations);
      next.delete(path);
      return { pendingCreations: next };
    });
  },

  addDeletedWorktree: (worktree) => {
    set((state) => {
      // Re-recording an id already present would reset `deletedAt` and reorder
      // the row for no user-visible gain; the first record wins.
      if (state.deletedWorktrees.has(worktree.id)) return state;
      const next = new Map(state.deletedWorktrees);
      next.set(worktree.id, worktree);
      return { deletedWorktrees: next };
    });
  },

  dismissDeletedWorktree: (worktreeId) => {
    set((state) => {
      if (!state.deletedWorktrees.has(worktreeId)) return state;
      const next = new Map(state.deletedWorktrees);
      next.delete(worktreeId);
      return { deletedWorktrees: next };
    });
  },

  setDeletedWorktreeExpiry: (worktreeId, expiresAt) => {
    set((state) => {
      const entry = state.deletedWorktrees.get(worktreeId);
      if (!entry || entry.expiresAt === expiresAt) return state;
      const next = new Map(state.deletedWorktrees);
      next.set(worktreeId, { ...entry, expiresAt });
      return { deletedWorktrees: next };
    });
  },

  // Demote a worktree from the durable restore target without touching the
  // session-active selection. Used when a deleted worktree lives on as a ghost
  // row: it may stay ACTIVE (the user is mid-cleanup on it), but a deleted id
  // must never persist as the restore point — deletedWorktrees is in-memory
  // only, so after a restart the id would resolve to nothing. The fleet-parked
  // snapshot is scrubbed too: exitFleetScope restores `_previousRestoreWorktreeId`
  // into the durable slot, which would resurrect the deleted id.
  clearRestoreTarget: (worktreeId) => {
    const updates: Partial<WorktreeSelectionState> = {};
    if (get().restoreWorktreeId === worktreeId) updates.restoreWorktreeId = null;
    if (get()._previousRestoreWorktreeId === worktreeId) updates._previousRestoreWorktreeId = null;
    if (Object.keys(updates).length === 0) return;
    set(updates);
    persistActiveWorktree(null);
  },

  pruneDeletedWorktrees: (liveWorktreeIds) => {
    set((state) => {
      if (state.deletedWorktrees.size === 0) return state;
      const stale: string[] = [];
      for (const id of state.deletedWorktrees.keys()) {
        // A row dies when its last terminal leaves (silently — the row
        // simply stops being useful), or when a real worktree reclaims the id,
        // which happens when the workspace host restarts and re-hydrates a
        // worktree we had already deleted.
        if (liveWorktreeIds.has(id) || getDeletedWorktreeTerminalIds(id).length === 0) {
          stale.push(id);
        }
      }
      if (stale.length === 0) return state;
      const next = new Map(state.deletedWorktrees);
      for (const id of stale) next.delete(id);
      return { deletedWorktrees: next };
    });
  },

  toggleWorktreeExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedWorktrees);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedWorktrees: next };
    }),

  setWorktreeExpanded: (id, expanded) =>
    set((state) => {
      const next = new Set(state.expandedWorktrees);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return { expandedWorktrees: next };
    }),

  collapseAllWorktrees: () => set({ expandedWorktrees: new Set<string>() }),

  toggleTerminalsExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedTerminals);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedTerminals: next };
    }),

  setTerminalsExpanded: (id, expanded) =>
    set((state) => {
      const next = new Set(state.expandedTerminals);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return { expandedTerminals: next };
    }),

  openCreateDialog: (initialIssue = null, options) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue,
        initialPR: null,
        initialRecipeId: options?.initialRecipeId ?? null,
        initialBranchInput: options?.initialBranchInput ?? null,
        onCreated: options?.onCreated,
      },
    });
  },

  openCreateDialogForPR: (pr) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue: null,
        initialPR: pr,
        initialRecipeId: null,
        initialBranchInput: null,
        onCreated: undefined,
      },
    });
  },

  closeCreateDialog: () =>
    set({
      createDialog: {
        isOpen: false,
        initialIssue: null,
        initialPR: null,
        initialRecipeId: null,
        initialBranchInput: null,
        onCreated: undefined,
      },
    }),

  openBulkCreateDialog: (selectedIssues, onComplete) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      bulkCreateDialog: {
        isOpen: true,
        mode: "issue",
        selectedIssues,
        selectedPRs: [],
        onComplete,
      },
    });
  },

  openBulkCreateDialogForPRs: (selectedPRs, onComplete) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      bulkCreateDialog: {
        isOpen: true,
        mode: "pr",
        selectedIssues: [],
        selectedPRs,
        onComplete,
      },
    });
  },

  closeBulkCreateDialog: () =>
    set((s) => ({
      bulkCreateDialog: { ...s.bulkCreateDialog, isOpen: false, onComplete: undefined },
    })),

  openQuickCreate: (context) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      quickCreate: {
        isOpen: true,
        issue: context?.issue ?? null,
        pr: context?.pr ?? null,
      },
    });
  },

  closeQuickCreate: () => set({ quickCreate: { isOpen: false, issue: null, pr: null } }),

  openCrossWorktreeDiff: (initialWorktreeId = null) =>
    set({ crossDiffDialog: { isOpen: true, initialWorktreeId } }),

  closeCrossWorktreeDiff: () =>
    set({ crossDiffDialog: { isOpen: false, initialWorktreeId: null } }),

  trackTerminalFocus: (worktreeId, terminalId) =>
    set((state) => {
      const next = new Map(state.lastFocusedTerminalByWorktree);
      next.set(worktreeId, terminalId);
      return { lastFocusedTerminalByWorktree: next };
    }),

  clearWorktreeFocusTracking: (worktreeId) =>
    set((state) => {
      const next = new Map(state.lastFocusedTerminalByWorktree);
      next.delete(worktreeId);
      return { lastFocusedTerminalByWorktree: next };
    }),

  clearWorktreeMaximizeTracking: (worktreeId) =>
    set((state) => {
      const next = new Map(state.maximizeByWorktree);
      next.delete(worktreeId);
      return { maximizeByWorktree: next };
    }),

  enterFleetScope: () => {
    // Idempotent: first pre-scope activeWorktreeId wins so the restoration
    // target isn't corrupted by a double-enter. Return the existing token so
    // a caller that re-enters still holds a token that matches the live scope.
    if (get().isFleetScopeActive) {
      // Non-null in this branch: an active scope always has a live token.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded token narrowing
      return get()._fleetScopeToken as FleetScopeToken;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branding an opaque uuid
    const token = crypto.randomUUID() as FleetScopeToken;
    const activeWorktreeId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    set({
      isFleetScopeActive: true,
      _previousActiveWorktreeId: activeWorktreeId,
      // Snapshot the durable selection too so exiting scope can't downgrade an
      // incidentally-active worktree into the persisted restore target (#9512).
      _previousRestoreWorktreeId: get().restoreWorktreeId,
      _fleetScopeToken: token,
      _policyGeneration: generation,
    });
    // Clear any active maximize so the fleet-scope render path isn't shadowed
    // by the single-panel/group maximize branch in ContentGrid. Also clear the
    // preMaximizeLayout snapshot so exiting scope later doesn't restore a
    // stale layout captured against a different worktree. The earlier
    // idempotency guard already ensures we only reach here when scope is
    // active, so no further re-check is needed now that this runs in-tick
    // (the token-equality guard the dynamic-import path used inside its
    // microtask callback was solely to protect against a back-to-back
    // exit+re-enter that drained later — that race is structurally gone now).
    usePanelStore.setState({
      maximizedId: null,
      maximizeTarget: null,
      preMaximizeLayout: null,
    });
    // Promote armed cross-worktree terminals to VISIBLE so their xterm
    // instances actually stream live output inside the fleet grid. The
    // policy function consults `isFleetScopeActive` + the armed set.
    applyWorktreeTerminalPolicy(get, set, activeWorktreeId, generation);
    return token;
  },

  exitFleetScope: (token) => {
    // Token-equality guard: a stale exit whose async caller fired after a
    // newer `enterFleetScope()` carries an outdated token and is structurally
    // a no-op here — it can't restore against the wrong scope. This replaces
    // the prior `isFleetScopeActive` boolean check, which couldn't tell a
    // stale exit apart from a legitimate one.
    if (get()._fleetScopeToken !== token) return;
    const restoreId = get()._previousActiveWorktreeId;
    const previousRestoreId = get()._previousRestoreWorktreeId;
    const generation = get()._policyGeneration + 1;
    // Snapshot the primary (most-recently-armed) terminal BEFORE `set()` so
    // the value used for focus restore is stable against any reads/writes
    // the in-tick clears below might trigger.
    const primaryTerminalId = getFleetLastArmedId();
    // Reconcile maximize for the worktree we're returning to (#11183). Scope
    // entry cleared the trio, but `activeWorktreeId` can move *during* scope (a
    // fleet panel in another worktree gains focus and promotes it), and
    // `terminal.maximize` still works while scoped — so the flat trio can now
    // describe a worktree we're about to leave. Restoring `restoreId` to the
    // active slot without reconciling would strand that foreign target and
    // blank the grid, which is the very bug this map exists to fix. A maximize
    // made *during* scope is discarded rather than stashed: the fleet branch
    // renders ahead of the maximize branch, so it was never visible anyway.
    const maximizeSwap = prepareWorktreeMaximizeSwap(get(), null, restoreId, "user");
    set({
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
      _previousRestoreWorktreeId: null,
      _fleetScopeToken: null,
      activeWorktreeId: restoreId,
      maximizeByWorktree: maximizeSwap.maximizeByWorktree,
      // Restore the durable selection captured at entry so a focus-promotion
      // that happened before scope entry survives the cycle (#9512).
      restoreWorktreeId: previousRestoreId,
      focusedWorktreeId: restoreId,
      _policyGeneration: generation,
    });
    // The parked active id can have become a ghost row while scope was open
    // (its worktree deleted with surviving terminals). Restoring the session
    // selection to it is fine — persisting it is not: deletedWorktrees is
    // in-memory only, so the id resolves to nothing after a restart.
    persistActiveWorktree(
      restoreId !== null && get().deletedWorktrees.has(restoreId) ? null : restoreId
    );
    // Hand the restored worktree its own maximize back, or clear the trio
    // outright. Either way `preMaximizeLayout` is replaced, so a snapshot that
    // survived scope entry can no longer restore a foreign column count.
    usePanelStore.setState(maximizeSwap.panelPatch);
    // Focus the primary (most-recently-armed) terminal so the user lands on
    // a known pane instead of whatever `focusedId` happened to be during
    // fleet scope. Runs in-tick now, so the prior token/generation guards
    // inside the async callback are structurally dead — the set() above
    // already cleared `_fleetScopeToken` and bumped the generation in the
    // same tick, and nothing between that set() and here can mutate them.
    // Still guarded by:
    //   - worktreeId match: the user's scope-exit intent is "restore the
    //     pre-scope worktree". If the primary lives elsewhere, focusing it
    //     would let `rendererStoreOrchestrator`'s focusedId subscription
    //     call `selectWorktree(primary.worktreeId)` and undo the restore.
    //   - location: skip trashed/backgrounded/docked primaries — a dock
    //     focus would activate the dock rather than a grid pane, and
    //     trashed/background terminals aren't valid focus targets.
    if (primaryTerminalId && restoreId) {
      const terminal = usePanelStore.getState().panelsById[primaryTerminalId];
      if (
        terminal &&
        terminal.worktreeId === restoreId &&
        terminal.location !== "trash" &&
        terminal.location !== "background" &&
        terminal.location !== "dock"
      ) {
        usePanelStore.getState().setFocused(primaryTerminalId);
      }
    }
    // Reconcile terminal streaming tiers: consumers may have mutated
    // activeWorktreeId during scope, so the renderer policy must be
    // reapplied for the restored worktree.
    applyWorktreeTerminalPolicy(get, set, restoreId, generation);
  },

  reset: () =>
    set({
      activeWorktreeId: null,
      restoreWorktreeId: null,
      focusedWorktreeId: null,
      pendingWorktreeId: null,
      pendingCreations: new Map<string, PendingCreation>(),
      deletedWorktrees: new Map<string, DeletedWorktree>(),
      expandedWorktrees: new Set<string>(),
      expandedTerminals: new Set<string>(),
      createDialog: {
        isOpen: false,
        initialIssue: null,
        initialPR: null,
        initialRecipeId: null,
        initialBranchInput: null,
        onCreated: undefined,
      },
      bulkCreateDialog: {
        isOpen: false,
        mode: "issue",
        selectedIssues: [],
        selectedPRs: [],
        onComplete: undefined,
      },
      quickCreate: { isOpen: false, issue: null, pr: null },
      crossDiffDialog: { isOpen: false, initialWorktreeId: null },
      lastFocusedTerminalByWorktree: new Map<string, string>(),
      maximizeByWorktree: new Map<string, WorktreeMaximizeSnapshot>(),
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
      _previousRestoreWorktreeId: null,
      _fleetScopeToken: null,
      // Bump the generation so any in-flight deferred policy/focus-restore
      // microtask (which captured an older generation) sees a mismatch and
      // bails — clearing the token alone can't invalidate them because the
      // post-reset token is null and the exit-side guard compares against
      // null.
      _policyGeneration: get()._policyGeneration + 1,
    }),
});

export const useWorktreeSelectionStore = create<WorktreeSelectionState>()(
  createWorktreeSelectionStore
);

function applyWorktreeTerminalPolicy(
  get: () => WorktreeSelectionState,
  _set: (partial: Partial<WorktreeSelectionState>) => void,
  targetWorktreeId: string | null,
  generation: number,
  onComplete?: () => void
) {
  // Reliability: terminals from inactive worktrees should not stream output to the renderer.
  // They remain alive in the backend headless model and will be restored on wake.
  // Terminals in the active worktree must be activated to resume streaming.
  //
  // Runs synchronously: callers invoke this immediately after their own set(),
  // so the generation/active guards below are defensive (they no longer guard a
  // microtask boundary, but are kept because applyPendingWorktreeSelection
  // passes a generation captured at a different point).
  if (get()._policyGeneration !== generation) return;
  if ((get().activeWorktreeId ?? null) !== (targetWorktreeId ?? null)) return;

  const { panelsById, panelIds } = usePanelStore.getState();
  const activeDockTerminalId = usePanelStore.getState().activeDockTerminalId;

  // Fleet scope pins armed grid/agent terminals to VISIBLE regardless of
  // worktree affiliation — the whole point of the scope view is to see
  // live output across worktrees. Without this, cross-worktree armed
  // terminals would get demoted to BACKGROUND and show stale/frozen
  // content even though they are mounted in the fleet grid. We fetch the
  // armed set through the shared accessor module to avoid a cyclic import.
  const fleetActive = get().isFleetScopeActive;
  const armedIds = fleetActive ? getFleetArmedIds() : null;

  for (const id of panelIds) {
    const terminal = panelsById[id];
    if (!terminal) continue;
    const isInActiveWorktree = (terminal.worktreeId ?? null) === (targetWorktreeId ?? null);

    const location = terminal.location ?? "grid";
    const isDockOrTrash = location === "dock" || location === "trash";

    // Let DockedTerminalItem manage open/closed dock policy, but if the active dock
    // terminal is not in the active worktree, force it to BACKGROUND.
    if (terminal.id === activeDockTerminalId && isDockOrTrash && isInActiveWorktree) {
      continue;
    }

    const isArmedInFleetScope = armedIds?.has(terminal.id) && !isDockOrTrash;

    const targetTier =
      isArmedInFleetScope || (isInActiveWorktree && !isDockOrTrash)
        ? TerminalRefreshTier.VISIBLE
        : TerminalRefreshTier.BACKGROUND;

    // Apply appropriate renderer policy based on worktree membership.
    // Avoid waking dock/trash terminals - they manage their own visibility.
    // `applyRendererPolicy(VISIBLE)` only restores on a real
    // BACKGROUND->active transition. It returns early on same-tier VISIBLE,
    // so pair active grid promotion with an explicit wake to pull any bytes
    // that arrived while the renderer was hidden or not yet mounted.
    terminalInstanceService.applyRendererPolicy(terminal.id, targetTier);
    if (
      targetTier !== TerminalRefreshTier.BACKGROUND &&
      (!isPtyPanel(terminal) || terminal.hasPty !== false) &&
      panelKindHasPty(terminal.kind ?? "terminal")
    ) {
      try {
        terminalInstanceService.wake(terminal.id);
      } catch (error) {
        logErrorWithContext(error, {
          operation: "wake_visible_worktree_terminal",
          component: "worktreeStore",
          errorType: "process",
          details: { terminalId: terminal.id, targetWorktreeId, generation },
        });
      }
    }
  }

  onComplete?.();
}
