/**
 * Use atomic selectors to prevent unnecessary re-renders.
 * @see src/hooks/useTerminalSelectors.ts for optimized selector hooks
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  createPanelRegistrySlice,
  createTerminalFocusSlice,
  createTerminalCommandQueueSlice,
  createTerminalBulkActionsSlice,
  createTerminalMruSlice,
  createWatchedPanelsSlice,
  flushPanelPersistence,
  isHydrationBatchActive,
  resetBatchState,
  selectOrderedTerminals,
  type PanelRegistrySlice,
  type TerminalFocusSlice,
  type TerminalCommandQueueSlice,
  type TerminalBulkActionsSlice,
  type TerminalMruSlice,
  type WatchedPanelsSlice,
  type AddPanelOptions,
  type QueuedCommand,
  isAgentReady,
} from "./slices";
import type { TerminalRefreshTier, AddPanelFocusPolicy } from "@shared/types";
import { isGridPanelLocation, isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { TerminalRefreshTier as TerminalRefreshTierEnum } from "@/types";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { isAssistantFocused } from "./macroFocusStore";
import { isMcpSpawnFocusSuppressed } from "./mcpSpawnFocusGuard";
import type { CrashType } from "@shared/types/pty-host";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { clearTerminalRestartGuard } from "./restartExitSuppression";
import { buildPanelSnapshotOptions } from "@/services/terminal/panelDuplicationService";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { resolvePanelKindPolicy, type PanelKindPolicy } from "@shared/config/panelKindRegistry";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name (#8957). The alias auto-resolves once
// the carrier flips to `PanelInstance` in step 5.
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export type { AddPanelOptions, QueuedCommand, CrashType };
// Re-exported for backwards-compat with tests still typing fixtures as
// `TerminalInstance`. The interface itself is now the persistence Tolerant
// Reader; production code uses `PanelInstance` from `@shared/types/panel`.
export type { TerminalInstance } from "@shared/types";
export { isAgentReady };
export type { TerminalMruSlice, WatchedPanelsSlice };

const PROJECT_SWITCH_RESIZE_SUPPRESSION_MS = 10_000;

/**
 * State snapshot required by `pickFallbackFocusId` — a minimal subset of the
 * panel store so the helper stays pure and easy to test in isolation.
 */
interface FallbackFocusStateSnapshot {
  panelsById: Record<string, CarrierPanel>;
  panelIds: string[];
  previousFocusedId: string | null;
}

/**
 * Pick the next `focusedId` after a panel (or group) leaves the grid.
 *
 * Policy-driven via `policy.dockFallbackTarget`:
 *   - `"previous-focused"` — restore to `state.previousFocusedId` when it is
 *     still a grid-resident panel in the active worktree and isn't being
 *     removed by the same operation; otherwise fall through to first-grid.
 *   - `"first-grid"` (default / unknown) — first remaining grid panel of the
 *     active worktree. When `preferAgent` is true, prefer the first runtime
 *     agent terminal in that set before falling back to the plain first-grid
 *     pick (trash variants only).
 *
 * Pure: no `set`/`get` calls, no `getActiveWorktreeId` indirection — the
 * caller passes the active worktree id so the helper can be exercised in
 * unit tests without booting the store.
 *
 * @returns the next panel id, or `null` if no candidate exists
 */
function pickFallbackFocusId(
  state: FallbackFocusStateSnapshot,
  excludeIds: ReadonlySet<string>,
  activeWorktreeId: string | undefined,
  policy: Required<PanelKindPolicy>,
  preferAgent: boolean
): string | null {
  if (policy.dockFallbackTarget === "previous-focused") {
    const prevId = state.previousFocusedId;
    if (prevId !== null && !excludeIds.has(prevId)) {
      const prev = state.panelsById[prevId];
      if (prev && prev.location === "grid" && (prev.worktreeId ?? undefined) === activeWorktreeId) {
        return prevId;
      }
    }
    // Stale or invalid previous focus — fall through to first-grid so the
    // user always lands on a real panel rather than being stranded at null.
  }

  // Default "first-grid" path (also the fallback for unknown strategies).
  const gridTerminals: CarrierPanel[] = [];
  for (const tid of state.panelIds) {
    const t = state.panelsById[tid];
    if (
      t &&
      !excludeIds.has(t.id) &&
      t.location === "grid" &&
      (t.worktreeId ?? undefined) === activeWorktreeId
    ) {
      gridTerminals.push(t);
    }
  }
  if (preferAgent) {
    const nextAgent = gridTerminals.find((t) => isRuntimeAgentTerminal(t));
    if (nextAgent) return nextAgent.id;
  }
  return gridTerminals[0]?.id ?? null;
}

function isVisibleLivePtyTerminal(terminal: PtyPanelData): boolean {
  if (!isGridPanelLocation(terminal.location)) return false;
  if (terminal.isVisible === false) return false;
  if (terminal.hasPty === false) return false;
  if (terminal.runtimeStatus === "exited" || terminal.runtimeStatus === "error") return false;
  if (terminal.runtimeStatus === "background") return false;
  if (terminal.agentState === "completed" || terminal.agentState === "exited") return false;
  return true;
}

export function getTerminalRefreshTier(
  terminal: CarrierPanel | undefined,
  isFocused: boolean,
  options: { isFleetArmed?: boolean } = {}
): TerminalRefreshTier {
  if (!terminal) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  if (isFocused) {
    return TerminalRefreshTierEnum.FOCUSED;
  }

  // Hidden (scrolled out of viewport) panels cap at BACKGROUND regardless of
  // agentState. Without this gate, a working agent scrolled off-screen in the
  // scrollable grid would keep streaming at FOCUSED rate, defeating the whole
  // throttling rationale of the BACKGROUND tier.
  if (terminal.isVisible === false) {
    return TerminalRefreshTierEnum.BACKGROUND;
  }

  const ptyTerminal = isPtyPanel(terminal) ? terminal : undefined;

  // Working agents that ARE visible get max refresh to prevent render jitter.
  if (ptyTerminal?.agentState === "working") {
    return TerminalRefreshTierEnum.FOCUSED;
  }

  // Fleet input can target a terminal before runtime agent detection has
  // caught up. Keep armed live PTYs visible so broadcast responses stream
  // promptly instead of being parked in the background tier.
  if (
    options.isFleetArmed &&
    ptyTerminal?.hasPty !== false &&
    isGridPanelLocation(terminal.location) &&
    ptyTerminal?.runtimeStatus !== "exited" &&
    ptyTerminal?.runtimeStatus !== "error"
  ) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Active agent terminals stay at VISIBLE minimum to preserve live output.
  // Completed agents drop to BACKGROUND so they can be hibernated to free memory.
  // Uses runtime-detected identity so panels that have left agent mode can hibernate.
  if (
    isRuntimeAgentTerminal(terminal) &&
    ptyTerminal?.agentState !== "completed" &&
    ptyTerminal?.agentState !== "exited"
  ) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Visible live PTYs must keep streaming even when they are not focused.
  // The previous "working" guard was too dependent on activity heuristics:
  // if a long-running process was still classified as waiting/idle, the
  // renderer moved to BACKGROUND and output stopped until focus/wake.
  if (isPtyPanel(terminal) && isVisibleLivePtyTerminal(terminal)) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Only explicitly hidden, completed/exited, errored, or PTY-less terminals
  // reach BACKGROUND now. Visible live terminals stay connected to the active
  // streaming path even when another pane has focus.
  return TerminalRefreshTierEnum.BACKGROUND;
}

export type BackendStatus = "connected" | "disconnected" | "recovering";

export type WatchdogStatus = "active" | "disabled";

export interface WatchdogDisabledInfo {
  attemptCount: number;
  lastExitCode: number | null;
  timestamp: number;
}

export interface PanelGridState
  extends
    PanelRegistrySlice,
    TerminalFocusSlice,
    TerminalCommandQueueSlice,
    TerminalBulkActionsSlice,
    TerminalMruSlice,
    WatchedPanelsSlice {
  backendStatus: BackendStatus;
  lastCrashType: CrashType | null;
  watchdogStatus: WatchdogStatus;
  watchdogDisabledInfo: WatchdogDisabledInfo | null;
  setBackendStatus: (status: BackendStatus) => void;
  setLastCrashType: (crashType: CrashType | null) => void;
  setWatchdogDisabled: (info: WatchdogDisabledInfo) => void;
  clearWatchdogDisabled: () => void;
  reset: () => Promise<void>;
  resetWithoutKilling: (options?: { preserveTerminalIds?: Set<string> }) => Promise<void>;
  detachTerminalsForProjectSwitch: () => void;
  clearTerminalStoreForSwitch: () => void;
  lastClosedConfig: AddPanelOptions | null;
  /** Restores the most recently trashed terminal. Returns `false` when the
   * trash is empty (nothing restored) so callers can fall back to another
   * source (e.g. the resume journal). */
  restoreLastTrashed: () => boolean;
}

/**
 * Build the maximize-clearing patch for a panel leaving the active worktree's
 * grid. Returns `{ maximizedId, maximizeTarget, preMaximizeLayout }` set to null
 * when `panelId` is the maximized panel itself, or a member of the maximized
 * group; otherwise an empty patch.
 *
 * Fixes #9936: "Send to Background", "Move to Worktree", and drag-to-dock could
 * relocate a maximized panel out of grid scope while `maximizedId` stayed set,
 * so `ContentGrid` rendered `null` and the whole grid went blank for every
 * worktree that didn't contain the panel. `group` MUST be snapshotted before the
 * registry mutation — backgrounding and dock moves dissolve the group. Mirrors
 * the check `moveTerminalToDock` already performs.
 */
function buildMaximizeClearPatch(
  maximizedId: string | null,
  panelId: string,
  group: { panelIds: string[] } | undefined
): Partial<PanelGridState> {
  if (!maximizedId) return {};
  if (maximizedId === panelId || (group?.panelIds.includes(maximizedId) ?? false)) {
    return { maximizedId: null, maximizeTarget: null, preMaximizeLayout: null };
  }
  return {};
}

export const usePanelStore = create<PanelGridState>()(
  subscribeWithSelector((set, get, api) => {
    const getTerminals = () => selectOrderedTerminals(get().panelsById, get().panelIds);
    const getTerminal = (id: string) => get().panelsById[id];

    const registrySlice = createPanelRegistrySlice({
      onTerminalRemoved: (id, removedIndex, remainingIds, _removedTerminal) => {
        clearTerminalRestartGuard(id);
        get().clearQueue(id);
        // Build remaining terminals array for the focus slice
        const state = get();
        const remainingTerminals = remainingIds
          .map((tid) => state.panelsById[tid])
          .filter((t): t is NonNullable<typeof t> => Boolean(t));
        get().handleTerminalRemoved(id, remainingTerminals, removedIndex);

        // Auto-clear watch if panel is removed while watched
        get().unwatchPanel(id);
      },
    })(set, get, api);

    const getActiveWorktreeId = () => useWorktreeSelectionStore.getState().activeWorktreeId;
    const focusSlice = createTerminalFocusSlice(getTerminals, getActiveWorktreeId, (id) =>
      get().stampLastActive(id)
    )(set, get, api);
    const commandQueueSlice = createTerminalCommandQueueSlice(getTerminal)(set, get, api);
    const mruSlice = createTerminalMruSlice(set, get, api);
    const watchedPanelsSlice = createWatchedPanelsSlice()(set, get, api);
    const bulkActionsSlice = createTerminalBulkActionsSlice(
      getTerminals,
      (id) => get().removePanel(id),
      (id) => get().restartTerminal(id),
      (id) => get().trashPanel(id),
      (id) => get().moveTerminalToDock(id),
      (id) => get().moveTerminalToGrid(id),
      () => get().focusedId,
      (id) => get().activateTerminal(id),
      getActiveWorktreeId
    )(set, get, api);

    return {
      ...registrySlice,
      ...focusSlice,
      ...commandQueueSlice,
      ...bulkActionsSlice,
      ...mruSlice,
      ...watchedPanelsSlice,

      backendStatus: "connected" as BackendStatus,
      lastCrashType: null as CrashType | null,
      watchdogStatus: "active" as WatchdogStatus,
      watchdogDisabledInfo: null as WatchdogDisabledInfo | null,
      lastClosedConfig: null as AddPanelOptions | null,
      setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),
      setLastCrashType: (crashType: CrashType | null) => set({ lastCrashType: crashType }),
      setWatchdogDisabled: (info: WatchdogDisabledInfo) =>
        set({ watchdogStatus: "disabled", watchdogDisabledInfo: info }),
      clearWatchdogDisabled: () => set({ watchdogStatus: "active", watchdogDisabledInfo: null }),

      addPanel: async (options: AddPanelOptions) => {
        // Capture the pre-create focus so we can restore previousFocusedId for the
        // dock-activation path (#6590). The registry slice atomically advances
        // focusedId to the new id when activateDockOnCreate is set, so by the
        // time it returns, we've lost the pre-create focus from the store.
        const focusedBeforeCreate = get().focusedId;
        // Read focus-steal gates synchronously, BEFORE the async registry call.
        // `document.activeElement` and the macro-focus store are mutable in
        // response to renderer DOM updates that can land during the await
        // boundary; capturing here pins them to the user's pre-create state
        // (#6959 — assistant focus theft when MCP launches an agent).
        const assistantHasFocus = isAssistantFocused();
        // Resolve the kind's policy synchronously — by the time `addPanel`
        // returns, plugin teardown could have changed the registry. A kind
        // that declares `defaultFocusOnCreate: false` is treated as an
        // implicit `focusPolicy: "preserve"` when the caller didn't supply
        // an explicit policy, so kinds can opt out without forcing every
        // call site to pass an option.
        const kindPolicy = resolvePanelKindPolicy(options.kind);
        const resolvedFocusPolicy: AddPanelFocusPolicy =
          options.focusPolicy ??
          (isMcpSpawnFocusSuppressed() || !kindPolicy.defaultFocusOnCreate ? "preserve" : "auto");
        const panelOptions: AddPanelOptions =
          resolvedFocusPolicy === options.focusPolicy
            ? options
            : { ...options, focusPolicy: resolvedFocusPolicy };
        const id = await registrySlice.addPanel(panelOptions);
        if (id === null) return null;
        // Skip the per-panel focus mutation while a hydration batch is collecting panels:
        // firing `set({ focusedId })` here would schedule one extra render per panel and
        // defeat the batch's single-render guarantee. The arbitrary "last panel added"
        // focus also isn't meaningful during restore — focus is resolved elsewhere once
        // the active worktree is set.
        if ((!options.location || options.location === "grid") && !isHydrationBatchActive()) {
          // Suppress focus capture for preserve-policy spawns or when the
          // Daintree Assistant currently owns keyboard focus. The new panel
          // still lands in the grid; the user keeps typing where they were.
          // The kind's `defaultFocusOnCreate: false` flag is already folded
          // into `resolvedFocusPolicy` above.
          if (
            resolvedFocusPolicy === "preserve" ||
            (resolvedFocusPolicy === "auto" && assistantHasFocus)
          ) {
            return id;
          }
          if (focusedBeforeCreate !== id) {
            set({ focusedId: id, previousFocusedId: focusedBeforeCreate });
          } else {
            set({ focusedId: id });
          }
        } else if (
          options.activateDockOnCreate &&
          options.location === "dock" &&
          !isHydrationBatchActive()
        ) {
          // The registry slice atomically advances `focusedId` to the new id
          // inside its commit for normal dock activations (#6590). When the
          // assistant currently owns input we issue a corrective set() to roll
          // keyboard focus back while leaving the dock popover open. Preserve-policy
          // spawns skip both registry focus and dock-popover activation entirely
          // (handled in `panelRegistry/addPanel.ts`), so no rollback is needed.
          if (assistantHasFocus && resolvedFocusPolicy !== "preserve") {
            set({ focusedId: focusedBeforeCreate });
          } else if (
            resolvedFocusPolicy !== "preserve" &&
            focusedBeforeCreate !== null &&
            focusedBeforeCreate !== id
          ) {
            // Best-effort previousFocusedId for the tmux-style alternate-pane toggle.
            // Updating in a follow-up set() is fine — previousFocusedId is metadata,
            // not load-bearing for dock visibility (which the watchdog effect cares
            // about and which is already covered by the registry's atomic commit).
            // Preserve-policy panels skip this — they never participate in alternate-pane focus.
            set({ previousFocusedId: focusedBeforeCreate });
          }
        }
        return id;
      },

      moveTerminalToDock: (id: string) => {
        const state = get();
        // Resolve the kind's policy BEFORE the registry mutation so the
        // pick-rule reads pre-move grid contents and a sync read can't be
        // replayed against a partially-mutated store under React 19
        // concurrent rendering.
        const movingKind = state.panelsById[id]?.kind;
        const policy = resolvePanelKindPolicy(movingKind);
        // Snapshot group membership before the move — a grouped dock move
        // relocates the group intact, but reading it up front keeps the
        // maximize check identical to the dissolving paths (background/drag).
        const group = registrySlice.getPanelGroup(id);
        registrySlice.moveTerminalToDock(id);

        const updates: Partial<PanelGridState> = {};

        if (state.focusedId === id) {
          updates.focusedId = pickFallbackFocusId(
            state,
            new Set([id]),
            getActiveWorktreeId() ?? undefined,
            policy,
            false
          );
          // Auto-fallback focus from a moved-to-dock panel isn't a user
          // navigation event — clear the alternate pointer to avoid round-
          // tripping into a panel the user didn't choose.
          updates.previousFocusedId = null;
        }
        if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
        }

        Object.assign(updates, buildMaximizeClearPatch(state.maximizedId, id, group));

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },

      moveTerminalToGrid: (id: string) => {
        const moveSucceeded = registrySlice.moveTerminalToGrid(id);
        if (moveSucceeded) {
          const previousFocusedId = get().focusedId;
          set({
            focusedId: id,
            activeDockTerminalId: null,
            ...(previousFocusedId !== id && { previousFocusedId }),
          });
        }
        return moveSucceeded;
      },

      moveTabGroupToLocation: (groupId, location) => {
        const groupBeforeMove = get().tabGroups.get(groupId);
        const moved = registrySlice.moveTabGroupToLocation(groupId, location);
        if (!moved || !groupBeforeMove) return moved;

        if (location === "grid") {
          const activeDockTerminalId = get().activeDockTerminalId;
          const previousFocusedId = get().focusedId;
          const nextFocusedId = groupBeforeMove.panelIds.includes(groupBeforeMove.activeTabId)
            ? groupBeforeMove.activeTabId
            : (groupBeforeMove.panelIds[0] ?? null);
          const shouldClearDock =
            activeDockTerminalId !== null &&
            groupBeforeMove.panelIds.includes(activeDockTerminalId);

          set({
            focusedId: nextFocusedId,
            ...(shouldClearDock && { activeDockTerminalId: null }),
            ...(nextFocusedId !== previousFocusedId && { previousFocusedId }),
          });
        } else {
          const updates: Partial<PanelGridState> = {};
          const focusedId = get().focusedId;
          if (focusedId && groupBeforeMove.panelIds.includes(focusedId)) {
            // The previously focused panel is now in the dock and `focusedId`
            // is being cleared as a side effect of the move, not a user
            // navigation. Clear the alternate pointer to keep round-trip
            // semantics tied to explicit focus changes.
            updates.focusedId = null;
            updates.activeDockTerminalId = groupBeforeMove.activeTabId;
            updates.previousFocusedId = null;
          }
          // Dragging a maximized group into the dock takes it out of grid scope —
          // clear maximize so the grid doesn't render blank (#9936).
          Object.assign(updates, buildMaximizeClearPatch(get().maximizedId, "", groupBeforeMove));
          if (Object.keys(updates).length > 0) {
            set(updates);
          }
        }

        return moved;
      },

      moveTerminalToWorktree: (id: string, worktreeId: string) => {
        const { maximizedId, panelsById } = get();
        const panel = panelsById[id];
        const group = registrySlice.getPanelGroup(id);
        registrySlice.moveTerminalToWorktree(id, worktreeId);
        // Same-worktree no-op leaves maximize valid; grouped moves delegate to
        // the moveTabGroupToWorktree wrapper (via get()), which clears there.
        if (group || !panel || panel.worktreeId === worktreeId) return;
        const patch = buildMaximizeClearPatch(maximizedId, id, undefined);
        if (Object.keys(patch).length > 0) {
          set(patch);
        }
      },

      moveTabGroupToWorktree: (groupId: string, worktreeId: string) => {
        const { maximizedId } = get();
        const group = get().tabGroups.get(groupId);
        const moved = registrySlice.moveTabGroupToWorktree(groupId, worktreeId);
        // Only clear on an actual cross-worktree move of the maximized group.
        if (moved && group && group.worktreeId !== worktreeId) {
          const patch = buildMaximizeClearPatch(maximizedId, "", group);
          if (Object.keys(patch).length > 0) {
            set(patch);
          }
        }
        return moved;
      },

      trashPanel: (id: string) => {
        const state = get();
        const terminalToTrash = state.panelsById[id];
        if (terminalToTrash && terminalToTrash.location !== "trash") {
          const narrowed = getNarrowPanel(state.panelsById, id);
          const snapshot = narrowed ? buildPanelSnapshotOptions(narrowed) : null;
          if (snapshot !== null) {
            set({ lastClosedConfig: snapshot });
          }
        }

        // Resolve the kind's policy and trashed-as-agent flag BEFORE the
        // registry mutation — `state.panelsById[id]` may be gone afterward.
        const policy = resolvePanelKindPolicy(terminalToTrash?.kind);
        const preferAgent = Boolean(terminalToTrash && isRuntimeAgentTerminal(terminalToTrash));

        registrySlice.trashPanel(id);

        // Clear watch when panel is trashed (onTerminalRemoved only fires on full removal)
        get().unwatchPanel(id);

        const updates: Partial<PanelGridState> = {};

        if (state.focusedId === id) {
          updates.focusedId = pickFallbackFocusId(
            state,
            new Set([id]),
            getActiveWorktreeId() ?? undefined,
            policy,
            preferAgent
          );
          updates.previousFocusedId = null;
        } else if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
        }

        if (state.maximizedId === id) {
          // Drop all three maximize fields atomically — the target and layout
          // snapshot both reference the trashed panel and must not survive.
          // #9935.
          updates.maximizedId = null;
          updates.maximizeTarget = null;
          updates.preMaximizeLayout = null;
        }

        if (state.activeDockTerminalId === id) {
          updates.activeDockTerminalId = null;
        }

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },

      trashPanelGroup: (panelId: string) => {
        const state = get();
        const group = registrySlice.getPanelGroup(panelId);
        const panelIdsInGroup = group?.panelIds ?? [panelId];

        const snapshotSourceId =
          group && panelIdsInGroup.includes(state.focusedId ?? "") ? state.focusedId! : panelId;
        const snapshotSource = state.panelsById[snapshotSourceId];
        if (snapshotSource && snapshotSource.location !== "trash") {
          const narrowedSource = getNarrowPanel(state.panelsById, snapshotSourceId);
          const snapshot = narrowedSource ? buildPanelSnapshotOptions(narrowedSource) : null;
          if (snapshot !== null) {
            set({ lastClosedConfig: snapshot });
          }
        }

        // Resolve the kind's policy from the FOCUSED panel of the group
        // (mixed-kind groups don't exist today — only `terminal` has
        // canConvert: true — so this matches the existing single-kind
        // assumption while staying well-defined if that ever changes).
        const focusedTerminal =
          state.focusedId !== null ? state.panelsById[state.focusedId] : undefined;
        const policy = resolvePanelKindPolicy(focusedTerminal?.kind);
        const preferAgent = Boolean(focusedTerminal && isRuntimeAgentTerminal(focusedTerminal));

        registrySlice.trashPanelGroup(panelId);

        const updates: Partial<PanelGridState> = {};

        if (panelIdsInGroup.includes(state.focusedId ?? "")) {
          updates.focusedId = pickFallbackFocusId(
            state,
            new Set(panelIdsInGroup),
            getActiveWorktreeId() ?? undefined,
            policy,
            preferAgent
          );
          updates.previousFocusedId = null;
        } else if (
          state.previousFocusedId !== null &&
          panelIdsInGroup.includes(state.previousFocusedId)
        ) {
          updates.previousFocusedId = null;
        }

        if (state.maximizedId && panelIdsInGroup.includes(state.maximizedId)) {
          // The maximized panel is leaving the grid — clear target and layout
          // snapshot so the next `toggleMaximize` after restore doesn't see
          // a stale `maximizeTarget` and treat itself as an unmaximize.
          // #9935.
          updates.maximizedId = null;
          updates.maximizeTarget = null;
          updates.preMaximizeLayout = null;
        }

        if (state.activeDockTerminalId && panelIdsInGroup.includes(state.activeDockTerminalId)) {
          updates.activeDockTerminalId = null;
        }

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },

      backgroundTerminal: (id: string) => {
        const state = get();
        // Resolve the kind's policy and agent flag BEFORE the registry
        // mutation — mirrors trashPanel so the fallback pick reads
        // pre-background grid contents (#9937).
        const terminalToBackground = state.panelsById[id];
        const policy = resolvePanelKindPolicy(terminalToBackground?.kind);
        const preferAgent = Boolean(
          terminalToBackground && isRuntimeAgentTerminal(terminalToBackground)
        );
        // Snapshot the group before the move — backgrounding dissolves it (#9935).
        const group = registrySlice.getPanelGroup(id);

        registrySlice.backgroundTerminal(id);

        // The slice declines missing/trash/overlay panels — skip focus repair
        // when nothing was backgrounded so a no-op can't steal focus.
        if (get().panelsById[id]?.location !== "background") return;

        const updates: Partial<PanelGridState> = {};

        if (state.focusedId === id) {
          updates.focusedId = pickFallbackFocusId(
            state,
            new Set([id]),
            getActiveWorktreeId() ?? undefined,
            policy,
            preferAgent
          );
          updates.previousFocusedId = null;
        } else if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
        }

        // Clear the full maximize trio (#9935) when the backgrounded panel was
        // maximized or belonged to the maximized group.
        Object.assign(updates, buildMaximizeClearPatch(state.maximizedId, id, group));

        if (state.activeDockTerminalId === id) {
          updates.activeDockTerminalId = null;
        }

        // A hidden panel must not keep a live ping highlight. The ping timer's
        // callback checks `pingedId === id` before clearing, so nulling here
        // can't race it.
        if (state.pingedId === id) {
          updates.pingedId = null;
        }

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },

      backgroundPanelGroup: (panelId: string) => {
        const state = get();
        const group = registrySlice.getPanelGroup(panelId);

        // No group — delegate to the wrapped single-panel path instead of
        // letting the slice's internal fallthrough re-enter this store layer.
        if (!group) {
          get().backgroundTerminal(panelId);
          return;
        }

        const panelIdsInGroup = [...group.panelIds];

        // Resolve the kind's policy from the FOCUSED panel of the group —
        // mirrors trashPanelGroup (see the mixed-kind note there).
        const focusedTerminal =
          state.focusedId !== null ? state.panelsById[state.focusedId] : undefined;
        const policy = resolvePanelKindPolicy(focusedTerminal?.kind);
        const preferAgent = Boolean(focusedTerminal && isRuntimeAgentTerminal(focusedTerminal));

        registrySlice.backgroundPanelGroup(panelId);

        const updates: Partial<PanelGridState> = {};

        if (panelIdsInGroup.includes(state.focusedId ?? "")) {
          updates.focusedId = pickFallbackFocusId(
            state,
            new Set(panelIdsInGroup),
            getActiveWorktreeId() ?? undefined,
            policy,
            preferAgent
          );
          updates.previousFocusedId = null;
        } else if (
          state.previousFocusedId !== null &&
          panelIdsInGroup.includes(state.previousFocusedId)
        ) {
          updates.previousFocusedId = null;
        }

        // Clear the full maximize trio (#9935) when the maximized panel was in
        // the backgrounded group.
        Object.assign(updates, buildMaximizeClearPatch(state.maximizedId, panelId, group));

        if (state.activeDockTerminalId && panelIdsInGroup.includes(state.activeDockTerminalId)) {
          updates.activeDockTerminalId = null;
        }

        if (state.pingedId && panelIdsInGroup.includes(state.pingedId)) {
          updates.pingedId = null;
        }

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },

      restoreTerminal: (id: string, targetWorktreeId?: string) => {
        registrySlice.restoreTerminal(id, targetWorktreeId);
        // The registry restore is a no-op when the id is gone; don't move
        // focus onto a panel that doesn't exist.
        const restoredPanel = get().panelsById[id];
        if (!restoredPanel) return;
        const previousFocusedId = get().focusedId;
        const landsInDock = restoredPanel.location === "dock" && isPtyPanel(restoredPanel);
        set({
          focusedId: id,
          // Open the dock popover when the panel landed back in the dock so
          // focus and the visible panel agree (#9938). If it landed elsewhere,
          // only clear the dock when this very panel was the one shown there —
          // an unrelated open dock session must not be dismissed (#8368).
          ...(landsInDock
            ? { activeDockTerminalId: id }
            : get().activeDockTerminalId === id
              ? { activeDockTerminalId: null }
              : {}),
          ...(previousFocusedId !== id && { previousFocusedId }),
        });
      },

      restoreTrashedGroup: (groupRestoreId: string, targetWorktreeId?: string) => {
        const trashedTerminals = get().trashedTerminals;

        let anchorPanel: ReturnType<typeof trashedTerminals.get> | undefined;
        const groupPanelIds: string[] = [];
        for (const [id, trashed] of trashedTerminals.entries()) {
          if (trashed.groupRestoreId === groupRestoreId) {
            groupPanelIds.push(id);
            if (trashed.groupMetadata) {
              anchorPanel = trashed;
            }
          }
        }

        if (groupPanelIds.length === 0) return;

        registrySlice.restoreTrashedGroup(groupRestoreId, targetWorktreeId);

        const preferredFocusId =
          anchorPanel?.groupMetadata?.activeTabId &&
          groupPanelIds.includes(anchorPanel.groupMetadata.activeTabId)
            ? anchorPanel.groupMetadata.activeTabId
            : groupPanelIds[0]!;
        // The preferred tab may have been pruned from panelsById during the
        // trash window (expiry race); fall back to any surviving member so the
        // restored group still gains focus and reopens its dock popover.
        const focusId = get().panelsById[preferredFocusId]
          ? preferredFocusId
          : groupPanelIds.find((pid) => get().panelsById[pid]);
        if (!focusId) return;
        const restoredPanel = get().panelsById[focusId]!;
        const previousFocusedId = get().focusedId;
        const landsInDock = restoredPanel.location === "dock" && isPtyPanel(restoredPanel);
        set({
          focusedId: focusId,
          // Match the restored panel's location so a docked group reopens the
          // dock popover instead of focusing an invisible panel (#9938); leave
          // an unrelated open dock session untouched when it lands elsewhere
          // (#8368).
          ...(landsInDock
            ? { activeDockTerminalId: focusId }
            : get().activeDockTerminalId === focusId
              ? { activeDockTerminalId: null }
              : {}),
          ...(previousFocusedId !== focusId && { previousFocusedId }),
        });

        const group = get().getPanelGroup(focusId);
        if (group) {
          get().setActiveTab(group.id, focusId);
        }
      },

      restoreLastTrashed: () => {
        const trashedTerminals = get().trashedTerminals;
        const trashedIds = Array.from(trashedTerminals.keys());
        if (trashedIds.length === 0) return false;

        const lastId = trashedIds[trashedIds.length - 1]!;
        const lastTrashed = trashedTerminals.get(lastId);

        if (lastTrashed?.groupRestoreId) {
          get().restoreTrashedGroup(lastTrashed.groupRestoreId);
        } else {
          get().restoreTerminal(lastId);
        }
        return true;
      },

      moveTerminalToPosition: (
        id: string,
        toIndex: number,
        location: "grid" | "dock",
        worktreeId?: string | null
      ) => {
        const state = get();
        // Resolve the kind's policy from the pre-move snapshot so the dock
        // branch's pick-rule reads the moving panel's kind.
        const movingKind = state.panelsById[id]?.kind;
        const policy = resolvePanelKindPolicy(movingKind);
        // Snapshot group membership before the move — moveTerminalToPosition
        // prunes the panel from its tab group, so the maximize check must read
        // it up front (#9936).
        const group = registrySlice.getPanelGroup(id);
        registrySlice.moveTerminalToPosition(id, toIndex, location, worktreeId);

        if (location === "grid") {
          const previousFocusedId = state.focusedId;
          set({
            focusedId: id,
            activeDockTerminalId: null,
            ...(previousFocusedId !== id && { previousFocusedId }),
          });
        } else {
          const updates: Partial<PanelGridState> = {};
          if (state.focusedId === id) {
            // Auto-fallback focus when the focused panel is moved to dock —
            // not a user navigation, so the alternate pointer becomes stale.
            updates.focusedId = pickFallbackFocusId(
              state,
              new Set([id]),
              getActiveWorktreeId() ?? undefined,
              policy,
              false
            );
            updates.previousFocusedId = null;
          }
          // Dragging a maximized panel into the dock takes it out of grid scope —
          // clear maximize so the grid doesn't render blank (#9936).
          Object.assign(updates, buildMaximizeClearPatch(state.maximizedId, id, group));
          if (Object.keys(updates).length > 0) {
            set(updates);
          }
        }
      },

      focusNext: () => {
        focusSlice.focusNext();
        const focusedId = get().focusedId;
        if (focusedId) {
          const terminal = get().panelsById[focusedId];
          if (terminal?.location === "dock") {
            const group = get().getPanelGroup(focusedId);
            if (group) get().setActiveTab(group.id, focusedId);
          }
        }
      },

      focusPrevious: () => {
        focusSlice.focusPrevious();
        const focusedId = get().focusedId;
        if (focusedId) {
          const terminal = get().panelsById[focusedId];
          if (terminal?.location === "dock") {
            const group = get().getPanelGroup(focusedId);
            if (group) get().setActiveTab(group.id, focusedId);
          }
        }
      },

      reset: async () => {
        const state = get();

        // Discard any in-flight spawn/hydration batch so a reset mid-batch can't
        // strand `isHydrationBatchActive()` as `true` and make the next
        // `beginSpawnBatch()` decline to open. (#9165)
        resetBatchState();

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.destroy(tid);
          } catch (error) {
            logWarn(`Failed to destroy terminal instance ${tid}`, { error });
          }
        }

        const killPromises = state.panelIds.map((tid) =>
          terminalRegistryController.kill(tid).catch((error) => {
            logError(`Failed to kill terminal ${tid}`, error);
          })
        );

        await Promise.all(killPromises);

        const { useTerminalInputStore: inputStore } = await import("./terminalInputStore");
        inputStore.getState().clearAllDraftInputs();

        set({
          panelsById: {},
          panelIds: [],
          panelIdsByWorktreeId: {},
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
          maximizedId: null,
          maximizeTarget: null,
          activeDockTerminalId: null,
          pingedId: null,
          preMaximizeLayout: null,
          commandQueue: [],
          commandQueueCountById: {},
          backendStatus: "connected",
          lastCrashType: null,
          lastClosedConfig: null,
          mruList: [],
        });
      },

      resetWithoutKilling: async (_options) => {
        const state = get();

        flushPanelPersistence();

        const allTerminalIds = [...state.panelIds];
        terminalInstanceService.suppressResizesDuringProjectSwitch(
          allTerminalIds,
          PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
        );

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.detachForProjectSwitch(tid);
          } catch (error) {
            logWarn(`Failed to detach terminal instance ${tid}`, { error });
          }
        }

        logInfo(
          `Detached ${state.panelIds.length} terminal instances for project switch (processes preserved)`
        );

        set({
          panelsById: {},
          panelIds: [],
          panelIdsByWorktreeId: {},
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
          maximizedId: null,
          maximizeTarget: null,
          activeDockTerminalId: null,
          pingedId: null,
          preMaximizeLayout: null,
          commandQueue: [],
          commandQueueCountById: {},
          backendStatus: "connected",
          lastCrashType: null,
          lastClosedConfig: null,
          mruList: [],
        });
      },

      detachTerminalsForProjectSwitch: () => {
        const state = get();

        flushPanelPersistence();

        const allTerminalIds = [...state.panelIds];
        terminalInstanceService.suppressResizesDuringProjectSwitch(
          allTerminalIds,
          PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
        );

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.detachForProjectSwitch(tid);
          } catch (error) {
            logWarn(`Failed to detach terminal instance ${tid}`, { error });
          }
        }

        logInfo(
          `Detached ${state.panelIds.length} terminal instances for project switch (processes preserved, state retained)`
        );
      },

      clearTerminalStoreForSwitch: () => {
        // Discard any in-flight spawn/hydration batch so a project switch mid-batch
        // can't strand `isHydrationBatchActive()` true and make the next
        // `beginSpawnBatch()` decline to open on the incoming project. (#9165)
        resetBatchState();

        set({
          panelsById: {},
          panelIds: [],
          panelIdsByWorktreeId: {},
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
          maximizedId: null,
          maximizeTarget: null,
          activeDockTerminalId: null,
          pingedId: null,
          preMaximizeLayout: null,
          commandQueue: [],
          commandQueueCountById: {},
          backendStatus: "connected",
          lastCrashType: null,
          lastClosedConfig: null,
          mruList: [],
          watchedPanels: new Set(),
        });
      },
    };
  })
);

/**
 * Non-hook alias for the panel store's vanilla API. Use this for imperative
 * `getState()`/`subscribe()` access inside React Compiler-processed code
 * (`"use memo"` components, `useMemo` bodies) where referencing the
 * `usePanelStore` hook as a value is disallowed.
 */
export const panelStoreApi = usePanelStore;

export { setupTerminalStoreListeners, cleanupTerminalStoreListeners } from "./panelStoreListeners";
