import type { DriveLeaseNavigation } from "@shared/types/ipc/driveLease";
import { getWorktreeIdSet } from "@/store/storeAccessors";
import { logWarn } from "@/utils/logger";

type Stores = Awaited<ReturnType<typeof loadStores>>;
type PanelState = ReturnType<Stores["usePanelStore"]["getState"]>;

// Imported when first needed: the stores must not be pulled in at module eval.
async function loadStores() {
  const [worktree, panel, focus] = await Promise.all([
    import("@/store/worktreeStore"),
    import("@/store/panelStore"),
    import("@/store/focusStore"),
  ]);
  return {
    useWorktreeSelectionStore: worktree.useWorktreeSelectionStore,
    resolveMaximizeForWorktree: worktree.resolveMaximizeForWorktree,
    suppressMruRecording: worktree.suppressMruRecording,
    isMruRecordingSuppressed: worktree.isMruRecordingSuppressed,
    usePanelStore: panel.usePanelStore,
    useFocusStore: focus.useFocusStore,
  };
}

/** A panel the project's layout holds, rather than one this screen opened for itself. */
function isFollowedPanel(panel: PanelState["panelsById"][string] | undefined): boolean {
  return (
    panel !== undefined &&
    (panel.location === "grid" || panel.location === "dock") &&
    panel.excludeFromPersistence !== true
  );
}

function readNavigation(stores: Stores, lastFocusedPanelId: string | null): DriveLeaseNavigation {
  const panels = stores.usePanelStore.getState();
  const { focusedId, maximizedId, maximizeTarget } = panels;
  return {
    activeWorktreeId: stores.useWorktreeSelectionStore.getState().activeWorktreeId ?? null,
    // Focus on something only this screen shows (an overlay's terminal) keeps
    // the last panel the project itself holds.
    focusedPanelId:
      focusedId === null
        ? null
        : isFollowedPanel(panels.panelsById[focusedId])
          ? focusedId
          : lastFocusedPanelId,
    maximize:
      maximizedId && maximizeTarget ? { panelId: maximizedId, target: maximizeTarget } : null,
    focusMode: stores.useFocusStore.getState().gestureSidebarHidden,
  };
}

function sameNavigation(a: DriveLeaseNavigation | null, b: DriveLeaseNavigation): boolean {
  return (
    a !== null &&
    a.activeWorktreeId === b.activeWorktreeId &&
    a.focusedPanelId === b.focusedPanelId &&
    a.focusMode === b.focusMode &&
    a.maximize?.panelId === b.maximize?.panelId &&
    a.maximize?.target.type === b.maximize?.target.type &&
    a.maximize?.target.id === b.maximize?.target.id
  );
}

export interface DriverNavigationReporter {
  /** Send where this view is now, even if it was sent already. */
  reportNow(): void;
  dispose(): void;
}

/**
 * Watch this view's navigation and hand each change to `send`, at most once
 * per `delayMs` and only while `mayReport` says this view drives. Changes that
 * land while it may not report are not sent later; `reportNow` sends the
 * current state once it may again.
 */
export function startDriverNavigationReporter(options: {
  mayReport: () => boolean;
  send: (navigation: DriveLeaseNavigation) => void;
  delayMs?: number;
}): DriverNavigationReporter {
  const delayMs = options.delayMs ?? 50;
  let stores: Stores | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let force = false;
  let lastSent: DriveLeaseNavigation | null = null;
  const unsubscribes: Array<() => void> = [];

  const flush = () => {
    timer = null;
    // Still loading: a forced report waits for the stores rather than being lost.
    if (disposed || !stores) return;
    if (!options.mayReport()) {
      force = false;
      return;
    }
    const navigation = readNavigation(stores, lastSent?.focusedPanelId ?? null);
    if (!force && sameNavigation(lastSent, navigation)) return;
    force = false;
    lastSent = navigation;
    options.send(navigation);
  };
  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(flush, delayMs);
  };

  void loadStores().then(
    (loaded) => {
      if (disposed) return;
      stores = loaded;
      unsubscribes.push(
        loaded.useWorktreeSelectionStore.subscribe((state, previous) => {
          if (state.activeWorktreeId !== previous.activeWorktreeId) schedule();
        }),
        // The panel store changes with every terminal's state; only these move the view.
        loaded.usePanelStore.subscribe((state, previous) => {
          if (
            state.focusedId !== previous.focusedId ||
            state.maximizedId !== previous.maximizedId ||
            state.maximizeTarget !== previous.maximizeTarget
          ) {
            schedule();
          }
        }),
        loaded.useFocusStore.subscribe((state, previous) => {
          if (state.gestureSidebarHidden !== previous.gestureSidebarHidden) schedule();
        })
      );
      if (force) schedule();
    },
    (error: unknown) => {
      logWarn("[HostDriverNavigation] Couldn't watch this view's navigation", { error });
    }
  );

  return {
    reportNow() {
      force = true;
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    },
  };
}

/**
 * Move this view to where the driver is: its worktree, then focus mode, its
 * maximize and its focused panel, in that order so the maximize is checked
 * against the worktree it belongs to and focus lands on a panel that shows.
 * Nothing is written back: the worktree is set without persisting, and the
 * rest is this view's own state, which a watcher's saves leave on this screen.
 * An id this view doesn't have yet is skipped; the next follow pass, after the
 * driver's panels are adopted, applies it again.
 */
export async function applyDriverNavigation(
  navigation: DriveLeaseNavigation,
  isCurrent: () => boolean
): Promise<void> {
  const stores = await loadStores();
  if (!isCurrent()) return;

  const selection = stores.useWorktreeSelectionStore.getState();
  const worktreeId = navigation.activeWorktreeId;
  if (
    worktreeId !== (selection.activeWorktreeId ?? null) &&
    (worktreeId === null || getWorktreeIdSet()?.has(worktreeId))
  ) {
    selection.setActiveWorktree(worktreeId, { persist: false });
  }
  const activeWorktreeId = stores.useWorktreeSelectionStore.getState().activeWorktreeId ?? null;

  // Only the sidebar: the assistant's suppression is this screen's own.
  const focus = stores.useFocusStore.getState();
  if (focus.gestureSidebarHidden !== navigation.focusMode) {
    focus.setSidebarGestureHidden(navigation.focusMode);
  }

  // Checked even when this view already holds the same maximize: a follow pass
  // may have moved its panel since, and a maximize that can't render blanks
  // the grid.
  const panels = stores.usePanelStore.getState();
  const wanted = navigation.maximize;
  const resolved =
    wanted === null ? null : resolveFollowedMaximize(stores, panels, wanted, activeWorktreeId);
  if (resolved === null) {
    // Not one this view can show yet: back to the grid rather than keep a
    // maximize of this screen's own over what the driver sees.
    panels.exitMaximize();
  } else if (
    panels.maximizedId !== resolved.maximizedId ||
    !sameTarget(panels, resolved.maximizeTarget)
  ) {
    stores.usePanelStore.setState({
      maximizedId: resolved.maximizedId,
      maximizeTarget: resolved.maximizeTarget,
      preMaximizeLayout: resolved.preMaximizeLayout,
    });
  }

  const focusedPanelId = navigation.focusedPanelId;
  const current = stores.usePanelStore.getState();
  if (focusedPanelId === null) {
    if (current.focusedId !== null) current.setFocused(null);
    return;
  }
  const panel = current.panelsById[focusedPanelId];
  if (!isFollowedPanel(panel)) return;
  if (panel!.worktreeId !== undefined && panel!.worktreeId !== activeWorktreeId) return;
  showTab(stores, focusedPanelId);
  if (focusedPanelId === current.focusedId) return;
  // The driver's pick, not this screen's: it stays out of the quick switcher's
  // order and leaves the panels' recency alone.
  const wasSuppressed = stores.isMruRecordingSuppressed();
  stores.suppressMruRecording(true);
  try {
    current.setFocused(focusedPanelId, false, { followed: true });
  } finally {
    stores.suppressMruRecording(wasSuppressed);
  }
}

type Maximize = NonNullable<DriveLeaseNavigation["maximize"]>;
type ResolvedMaximize = NonNullable<ReturnType<Stores["resolveMaximizeForWorktree"]>>;

function resolveFollowedMaximize(
  stores: Stores,
  panels: PanelState,
  wanted: Maximize,
  activeWorktreeId: string | null
): ResolvedMaximize | null {
  const snapshot = {
    maximizedId: wanted.panelId,
    maximizeTarget: wanted.target,
    // The column count to go back to is this screen's own.
    preMaximizeLayout: panels.preMaximizeLayout,
  };
  if (activeWorktreeId !== null) {
    return stores.resolveMaximizeForWorktree(snapshot, activeWorktreeId, panels);
  }
  // A project with no worktrees: its panels are filed in none.
  const panel = panels.panelsById[wanted.panelId];
  if (!panel || panel.location !== "grid" || panel.worktreeId !== undefined) return null;
  if (wanted.target.type === "panel") return wanted.target.id === wanted.panelId ? snapshot : null;
  const group = panels.tabGroups.get(wanted.target.id);
  if (
    !group ||
    group.location !== "grid" ||
    group.worktreeId !== undefined ||
    !group.panelIds.includes(wanted.panelId)
  ) {
    return null;
  }
  return snapshot;
}

/**
 * The driver's focus arrives ahead of its tab-group save, so the group the
 * panel sits in shows it here and now. Not saved: the host's own save of the
 * groups follows.
 */
function showTab(stores: Stores, panelId: string): void {
  const { tabGroups } = stores.usePanelStore.getState();
  for (const group of tabGroups.values()) {
    if (!group.panelIds.includes(panelId)) continue;
    if (group.activeTabId === panelId) return;
    const next = new Map(tabGroups);
    next.set(group.id, { ...group, activeTabId: panelId });
    stores.usePanelStore.setState({ tabGroups: next });
    return;
  }
}

function sameTarget(
  panels: Pick<PanelState, "maximizeTarget">,
  target: Maximize["target"]
): boolean {
  return panels.maximizeTarget?.type === target.type && panels.maximizeTarget.id === target.id;
}
