import type { TabGroup, TabGroupLocation } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { type PanelInstance, type PanelKind, isPtyPanel } from "@shared/types/panel";
import { panelKindHasPty, normalizeGroupDockLocation } from "@shared/config/panelKindRegistry";
import { getNarrowPanel } from "./selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus, dissolvePanelFromGroup } from "./helpers";
import {
  buildWorktreeIndex,
  NO_WORKTREE,
  panelMatchesWorktreeScope,
  transferBetweenWorktreeIndex,
} from "./worktreeIndex";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

/**
 * Candidate panel ids for the ungrouped-panel scan in `getTabGroups`.
 *
 * Iterates `panelIds` first (preserving committed order so explicit/virtual
 * group ordering and drag-reorder via `reorderTabGroups` stay correct), then
 * appends any ids present in `panelIdsByWorktreeId` but not yet in `panelIds`.
 *
 * That tail is the fix for #9649: during a `beginSpawnBatch`/`flushSpawnBatch`
 * window, the worktree index is updated eagerly at panel creation while
 * `panelIds` only appends at flush. Reading `panelIds` alone left freshly-
 * batched recipe panels out of every virtual group until a worktree switch
 * forced a re-derive. `gridPanelIds` in `useContentGridContext` already reads
 * the index, so including its pending ids keeps the ungrouped source consistent
 * with the grid's structural dep — the panel paints on first mount.
 *
 * For a concrete `worktreeId`, the tail scans that worktree's bucket plus the
 * `NO_WORKTREE` bucket (dock-global panels are visible in every worktree-scoped
 * dock — the per-panel `panelMatchesWorktreeScope` filter inside the loop keeps
 * them out of grid queries). For `worktreeId === undefined`, it scans every
 * bucket.
 */
function collectUngroupedCandidateIds(
  panelIds: string[],
  panelIdsByWorktreeId: Record<string, string[]>,
  worktreeId: string | undefined
): string[] {
  const seen = new Set(panelIds);
  const buckets =
    worktreeId === undefined
      ? Object.values(panelIdsByWorktreeId)
      : [panelIdsByWorktreeId[worktreeId], panelIdsByWorktreeId[NO_WORKTREE]];

  let pending: string[] | undefined;
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const id of bucket) {
      if (seen.has(id)) continue;
      seen.add(id);
      (pending ??= []).push(id);
    }
  }

  return pending ? [...panelIds, ...pending] : panelIds;
}

function getPanelTabGroupLocation(
  panel: PanelInstance | CarrierPanel | undefined
): TabGroupLocation | null {
  // Overlay panels (the Daintree Assistant) and dialog panels belong to no tab
  // group — they self-manage and must never be folded into a grid or dock
  // group (#9699).
  if (
    !panel ||
    panel.location === "trash" ||
    panel.location === "background" ||
    panel.location === "overlay" ||
    panel.location === "dialog"
  )
    return null;
  return panel.location === "dock" ? "dock" : "grid";
}

export const createTabGroupActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "getPanelGroup"
  | "createTabGroup"
  | "addPanelToGroup"
  | "removePanelFromGroup"
  | "reorderPanelsInGroup"
  | "deleteTabGroup"
  | "getTabGroupPanels"
  | "getTabGroups"
  | "moveTabGroupToLocation"
  | "moveTabGroupToWorktree"
  | "reorderTabGroups"
  | "setActiveTab"
  | "getActiveTabId"
  | "hydrateTabGroups"
  | "setTabGroupInfo"
> => ({
  getPanelGroup: (panelId) => {
    const state = get();
    const tabGroups = state.tabGroups;
    const panelLocation = getPanelTabGroupLocation(state.panelsById[panelId]);
    for (const group of tabGroups.values()) {
      if (group.panelIds.includes(panelId)) {
        if (panelLocation !== null && panelLocation !== group.location) continue;
        return group;
      }
    }
    return undefined;
  },

  createTabGroup: (location, worktreeId, panelIds, activeTabId) => {
    const groupId = `tabgroup-${crypto.randomUUID()}`;
    const group: TabGroup = {
      id: groupId,
      location,
      worktreeId,
      activeTabId: activeTabId ?? panelIds[0] ?? "",
      panelIds,
    };

    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.set(groupId, group);
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });

    return groupId;
  },

  addPanelToGroup: (groupId, panelId, index) => {
    set((state) => {
      const group = state.tabGroups.get(groupId);
      if (!group) {
        console.warn(`[TabGroup] Cannot add panel: group ${groupId} not found`);
        return state;
      }

      if (group.panelIds.includes(panelId)) {
        return state;
      }

      const panel = state.panelsById[panelId];
      if (!panel) {
        console.warn(`[TabGroup] Cannot add panel ${panelId}: panel not found`);
        return state;
      }

      if ((panel.worktreeId ?? undefined) !== (group.worktreeId ?? undefined)) {
        console.warn(
          `[TabGroup] Cannot add panel ${panelId} to group ${groupId}: worktree mismatch (panel: ${panel.worktreeId}, group: ${group.worktreeId})`
        );
        return state;
      }

      // CRITICAL: Enforce unique membership - remove from any existing group first
      const newTabGroups = new Map(state.tabGroups);
      for (const [existingGroupId, existingGroup] of newTabGroups) {
        if (existingGroup.panelIds.includes(panelId)) {
          const filteredPanelIds = existingGroup.panelIds.filter((id) => id !== panelId);
          if (filteredPanelIds.length <= 1) {
            newTabGroups.delete(existingGroupId);
          } else {
            const newActiveTabId =
              existingGroup.activeTabId === panelId
                ? (filteredPanelIds[0] ?? "")
                : existingGroup.activeTabId;
            newTabGroups.set(existingGroupId, {
              ...existingGroup,
              panelIds: filteredPanelIds,
              activeTabId: newActiveTabId,
            });
          }
          break;
        }
      }

      const targetGroup = newTabGroups.get(groupId);
      if (!targetGroup) {
        console.warn(`[TabGroup] Target group ${groupId} was deleted during cleanup`);
        return state;
      }

      const newPanelIds = [...targetGroup.panelIds];
      if (index !== undefined && index >= 0 && index <= newPanelIds.length) {
        newPanelIds.splice(index, 0, panelId);
      } else {
        newPanelIds.push(panelId);
      }

      newTabGroups.set(groupId, { ...targetGroup, panelIds: newPanelIds });
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });

    // Verify against the canonical store rather than a closure side-effect: the
    // set() updater bails out (returning unchanged state) on a missing group,
    // missing panel, or worktree mismatch, so membership is the source of truth
    // for whether the add actually took. Callers gate cleanup on this boolean.
    return get().tabGroups.get(groupId)?.panelIds.includes(panelId) ?? false;
  },

  removePanelFromGroup: (panelId) => {
    set((state) => {
      const { tabGroups: newTabGroups, dissolved } = dissolvePanelFromGroup(
        state.tabGroups,
        panelId
      );
      if (dissolved) {
        saveTabGroups(newTabGroups);
      }
      return dissolved ? { tabGroups: newTabGroups } : state;
    });
  },

  reorderPanelsInGroup: (groupId, panelIds) => {
    set((state) => {
      const group = state.tabGroups.get(groupId);
      if (!group) {
        console.warn(`[TabGroup] Cannot reorder: group ${groupId} not found`);
        return state;
      }

      const existingSet = new Set(group.panelIds);
      const newSet = new Set(panelIds);
      if (existingSet.size !== newSet.size || !group.panelIds.every((id) => newSet.has(id))) {
        console.warn(`[TabGroup] Reorder mismatch: panels don't match group ${groupId}`);
        return state;
      }

      const newGroup: TabGroup = { ...group, panelIds };
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.set(groupId, newGroup);
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });
  },

  deleteTabGroup: (groupId) => {
    set((state) => {
      if (!state.tabGroups.has(groupId)) return state;
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.delete(groupId);
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });
  },

  getTabGroupPanels: (groupId, location) => {
    const state = get();
    const trashedTerminals = state.trashedTerminals;
    const tabGroups = state.tabGroups;

    const group = tabGroups.get(groupId);
    if (group) {
      return group.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is CarrierPanel =>
            t !== undefined &&
            getPanelTabGroupLocation(t) !== null &&
            (location === undefined || getPanelTabGroupLocation(t) === location) &&
            !trashedTerminals.has(t.id)
        );
    }

    // Not an explicit group - check if it's a single ungrouped panel
    const panel: CarrierPanel | undefined = state.panelsById[groupId];
    if (
      panel &&
      getPanelTabGroupLocation(panel) !== null &&
      (location === undefined || getPanelTabGroupLocation(panel) === location) &&
      !trashedTerminals.has(panel.id)
    ) {
      for (const g of tabGroups.values()) {
        if (g.panelIds.includes(groupId)) {
          return [];
        }
      }
      return [panel];
    }

    return [];
  },

  getTabGroups: (location, worktreeId) => {
    const state = get();
    const trashedTerminals = state.trashedTerminals;
    const tabGroups = state.tabGroups;

    const explicitGroups: TabGroup[] = [];

    for (const group of tabGroups.values()) {
      if (
        group.location === location &&
        panelMatchesWorktreeScope(group.worktreeId, worktreeId, location)
      ) {
        const validPanelIds = group.panelIds.filter((id) => {
          const panel = state.panelsById[id];
          if (!panel || trashedTerminals.has(id)) return false;
          const panelLocation = getPanelTabGroupLocation(panel);
          if (panelLocation === null) return false;
          if (!panelMatchesWorktreeScope(panel.worktreeId, worktreeId, location)) return false;
          return panelLocation === location;
        });

        if (validPanelIds.length > 0) {
          explicitGroups.push({
            ...group,
            panelIds: validPanelIds,
            activeTabId: validPanelIds.includes(group.activeTabId)
              ? group.activeTabId
              : (validPanelIds[0] ?? ""),
          });
        }
      }
    }

    // Map each valid explicit-group member to its sanitized group so the
    // interleave pass below can slot the group in at its earliest member's
    // position instead of forcing every explicit group ahead of the virtual
    // ones — the latter made a panel jump to grid position 0 the moment it
    // gained a second tab (#10435).
    const memberToGroup = new Map<string, TabGroup>();
    for (const group of explicitGroups) {
      for (const id of group.panelIds) memberToGroup.set(id, group);
    }
    const emittedGroupIds = new Set<string>();

    // Interleave explicit and virtual (single-panel) groups in one ordered pass.
    // Source from the eagerly-committed worktree index (not `panelIds`, which
    // lags during a spawn batch) so freshly-batched panels paint immediately
    // rather than after a worktree switch (#9649). Each explicit group is
    // emitted once, when its earliest member is first encountered; every other
    // panel becomes a virtual single-panel group in place — preserving the
    // panelIds grid order across both kinds (#10435).
    const result: TabGroup[] = [];
    for (const tid of collectUngroupedCandidateIds(
      state.panelIds,
      state.panelIdsByWorktreeId,
      worktreeId
    )) {
      const explicit = memberToGroup.get(tid);
      if (explicit) {
        if (!emittedGroupIds.has(explicit.id)) {
          emittedGroupIds.add(explicit.id);
          result.push(explicit);
        }
        continue;
      }

      const t = state.panelsById[tid];
      if (!t) continue;
      if (t.location === "trash" || trashedTerminals.has(t.id)) continue;
      const effectiveLocation = getPanelTabGroupLocation(t);
      if (effectiveLocation === null) continue;
      if (effectiveLocation !== location) continue;
      if (!panelMatchesWorktreeScope(t.worktreeId, worktreeId, location)) continue;

      result.push({
        id: t.id,
        location,
        worktreeId,
        activeTabId: t.id,
        panelIds: [t.id],
      });
    }

    // Defensive tail: emit any explicit group whose members never surfaced in
    // the candidate iteration, preserving the prior guarantee that an explicit
    // group is never silently dropped from the returned list.
    for (const group of explicitGroups) {
      if (!emittedGroupIds.has(group.id)) {
        emittedGroupIds.add(group.id);
        result.push(group);
      }
    }

    return result;
  },

  moveTabGroupToLocation: (groupId, location) => {
    const group = get().tabGroups.get(groupId);
    if (!group) {
      console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
      return false;
    }

    // A tab group is atomic — every member shares one location — so a dock move
    // is all-or-nothing: if ANY live member's kind is non-dockable, the whole
    // group lands in the grid rather than splitting (#11375). A mixed-location
    // group is invisible to `getPanelGroup` and corrupts persistence. Skip trash
    // members, matching the per-member relocation loop below.
    const groupState = get();
    const memberKinds: (PanelKind | undefined)[] = [];
    for (const pid of group.panelIds) {
      const t = groupState.panelsById[pid];
      if (!t || t.location === "trash" || groupState.trashedTerminals.has(t.id)) continue;
      memberKinds.push(t.kind);
    }
    const effectiveLocation = normalizeGroupDockLocation(memberKinds, location);

    if (group.location === effectiveLocation) return true;

    // Scrollable grid (#8805): tab-group moves to the grid no longer gate on a
    // screen-fit cap. The grid scrolls vertically so the move always succeeds.

    // A worktree-less dock group is visible in every worktree's dock, but the
    // grid renders only the active worktree's index bucket — landing there
    // without a worktreeId strands the whole group off-screen (#11290).
    // Promotion (including a dock request rescued to grid above) adopts the
    // active worktree for the group and every live member; a real existing
    // group attribution is never changed.
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
    const adoptedWorktreeId =
      effectiveLocation === "grid" && group.worktreeId == null && activeWorktreeId !== null
        ? activeWorktreeId
        : null;
    const backfilledPanelIds: string[] = [];

    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup =
        adoptedWorktreeId !== null
          ? { ...group, location: effectiveLocation, worktreeId: adoptedWorktreeId }
          : { ...group, location: effectiveLocation };
      newTabGroups.set(groupId, updatedGroup);

      const panelIdSet = new Set(group.panelIds);
      const newById = { ...state.panelsById };
      let newIndex = state.panelIdsByWorktreeId;
      for (const pid of panelIdSet) {
        const t = newById[pid];
        if (!t) continue;
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) continue;
        const ptyT = isPtyPanel(t) ? t : undefined;
        newById[pid] = {
          ...t,
          ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
          location: effectiveLocation,
          isVisible: effectiveLocation === "grid",
          runtimeStatus: deriveRuntimeStatus(
            effectiveLocation === "grid",
            ptyT?.flowStatus,
            ptyT?.runtimeStatus
          ),
        } as PanelInstance;
        if (adoptedWorktreeId !== null) {
          newIndex = transferBetweenWorktreeIndex(newIndex, t.worktreeId, adoptedWorktreeId, pid);
          backfilledPanelIds.push(pid);
        }
      }

      saveNormalized(newById, state.panelIds);
      saveTabGroups(newTabGroups);
      return {
        panelsById: newById,
        tabGroups: newTabGroups,
        ...(adoptedWorktreeId !== null && { panelIdsByWorktreeId: newIndex }),
      };
    });

    // A user-initiated promotion is explicit worktree attribution — recorded
    // so later cwd-based inference can never silently re-home the panels.
    if (adoptedWorktreeId !== null) {
      for (const pid of backfilledPanelIds) {
        const ledgerGeneration = agentLifecycleLedger.currentGeneration(pid);
        if (ledgerGeneration !== undefined) {
          agentLifecycleLedger.recordWorktreeAttribution(
            pid,
            ledgerGeneration,
            adoptedWorktreeId,
            "explicit"
          );
        }
      }
    }

    for (const panelId of group.panelIds) {
      const terminal = get().panelsById[panelId];
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (effectiveLocation === "dock") {
          optimizeForDock(panelId);
        } else {
          terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.VISIBLE);
        }
      }
    }

    return true;
  },

  moveTabGroupToWorktree: (groupId, worktreeId) => {
    const group = get().tabGroups.get(groupId);
    if (!group) {
      console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
      return false;
    }

    if (group.worktreeId === worktreeId) return true;

    // Scrollable grid (#8805): no screen-fit cap — moving a group to another
    // worktree's grid always succeeds; the destination grid scrolls.

    // Preserve the group's current location, but normalize a stale dock to grid
    // if any live member's kind is no longer dockable (#11375) — else the whole
    // group stays stranded in the dock after a dockability flip. All-or-nothing,
    // mirroring moveTabGroupToLocation; the group and its members move together.
    const worktreeMoveState = get();
    const worktreeMemberKinds: (PanelKind | undefined)[] = [];
    for (const pid of group.panelIds) {
      const t = worktreeMoveState.panelsById[pid];
      if (!t || t.location === "trash" || worktreeMoveState.trashedTerminals.has(t.id)) continue;
      worktreeMemberKinds.push(t.kind);
    }
    const targetLocation: TabGroupLocation = normalizeGroupDockLocation(
      worktreeMemberKinds,
      group.location === "grid" ? "grid" : "dock"
    );

    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup = { ...group, worktreeId, location: targetLocation };
      newTabGroups.set(groupId, updatedGroup);

      const panelIdSet = new Set(group.panelIds);
      const newById = { ...state.panelsById };
      let newIndex = state.panelIdsByWorktreeId;
      for (const pid of panelIdSet) {
        const t = newById[pid];
        if (!t) continue;
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) continue;
        const ptyT2 = isPtyPanel(t) ? t : undefined;
        newById[pid] = {
          ...t,
          worktreeId,
          location: targetLocation,
          isVisible: targetLocation === "grid",
          runtimeStatus: deriveRuntimeStatus(
            targetLocation === "grid",
            ptyT2?.flowStatus,
            ptyT2?.runtimeStatus
          ),
        } as PanelInstance;
        newIndex = transferBetweenWorktreeIndex(newIndex, t.worktreeId, worktreeId, pid);
      }

      saveNormalized(newById, state.panelIds);
      saveTabGroups(newTabGroups);
      return { panelsById: newById, panelIdsByWorktreeId: newIndex, tabGroups: newTabGroups };
    });

    for (const panelId of group.panelIds) {
      const terminal = get().panelsById[panelId];
      if (
        terminal &&
        terminal.location !== "trash" &&
        !get().trashedTerminals.has(panelId) &&
        panelKindHasPty(terminal.kind ?? "terminal")
      ) {
        if (targetLocation === "dock") {
          optimizeForDock(panelId);
        } else {
          terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.VISIBLE);
        }
      }
    }

    return true;
  },

  reorderTabGroups: (fromGroupIndex, toGroupIndex, location, worktreeId) => {
    if (fromGroupIndex === toGroupIndex) return;

    set((state) => {
      const allGroups = get().getTabGroups(location, worktreeId ?? undefined);

      if (fromGroupIndex < 0 || fromGroupIndex >= allGroups.length) return state;
      if (toGroupIndex < 0 || toGroupIndex > allGroups.length) return state;

      const reorderedGroups = [...allGroups];
      const [movedGroup] = reorderedGroups.splice(fromGroupIndex, 1);
      if (!movedGroup) return state;
      reorderedGroups.splice(toGroupIndex, 0, movedGroup);

      // Build new panelIds with the reordered groups
      const matchesLocation = (t: CarrierPanel) =>
        location === "grid"
          ? t.location === "grid" || t.location === undefined
          : t.location === "dock";

      const newLocationIds: string[] = [];
      const processedIds = new Set<string>();

      for (const group of reorderedGroups) {
        const groupPanelIds = group.panelIds.filter((pid) => {
          const t = state.panelsById[pid];
          if (!t) return false;
          // Same scope predicate as getTabGroups — an exact-match filter here
          // would evict a global dock member into the tail bucket, discarding
          // the position the drag just committed (#11289).
          if (!panelMatchesWorktreeScope(t.worktreeId, worktreeId, location)) return false;
          if (t.location === "trash") return false;
          const effectiveLocation = t.location ?? "grid";
          return effectiveLocation === location;
        });

        // Sort by the order in group.panelIds
        groupPanelIds.sort((a, b) => group.panelIds.indexOf(a) - group.panelIds.indexOf(b));

        for (const pid of groupPanelIds) {
          if (!processedIds.has(pid)) {
            newLocationIds.push(pid);
            processedIds.add(pid);
          }
        }
      }

      // Append every location-matched panel the group pass didn't place —
      // other worktrees' panels, plus any in-scope edge case getTabGroups
      // excluded. Unconditional so no panel is ever dropped from panelIds.
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (t && !processedIds.has(tid) && matchesLocation(t)) {
          newLocationIds.push(tid);
          processedIds.add(tid);
        }
      }

      // Reconstruct full panelIds: location-matched IDs in new order, others preserved
      const otherIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (!t || !matchesLocation(t)) {
          otherIds.push(tid);
        }
      }

      const newIds =
        location === "grid"
          ? [...newLocationIds, ...otherIds]
          : [
              ...state.panelIds.filter((tid) => {
                const t = state.panelsById[tid];
                return t && (t.location === "grid" || t.location === undefined);
              }),
              ...newLocationIds,
              ...state.panelIds.filter((tid) => {
                const t = state.panelsById[tid];
                return (
                  t && t.location !== "grid" && t.location !== undefined && t.location !== "dock"
                );
              }),
            ];

      saveNormalized(state.panelsById, newIds);
      // Rebuild bucket order so per-worktree selectors observe the new order
      // (issue #7451). Reorder is user-gesture rate, so a full rebuild is fine.
      return {
        panelIds: newIds,
        panelIdsByWorktreeId: buildWorktreeIndex(newIds, state.panelsById),
      };
    });
  },

  setActiveTab: (groupId, panelId) => {
    set((state) => {
      const group = state.tabGroups.get(groupId);
      if (!group) return state;
      if (!group.panelIds.includes(panelId)) return state;
      if (group.activeTabId === panelId) return state;
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.set(groupId, { ...group, activeTabId: panelId });
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });
  },

  getActiveTabId: (groupId) => {
    const group = get().tabGroups.get(groupId);
    if (group) return group.activeTabId || null;
    const terminal = get().panelsById[groupId];
    if (
      terminal &&
      terminal.location !== "trash" &&
      terminal.location !== "background" &&
      terminal.location !== "overlay" &&
      terminal.location !== "dialog"
    ) {
      for (const g of get().tabGroups.values()) {
        if (g.panelIds.includes(groupId)) return null;
      }
      return groupId;
    }
    return null;
  },

  hydrateTabGroups: (tabGroups, options) => {
    const state = get();
    const terminalIdSet = new Set(state.panelIds);
    const trashedTerminals = state.trashedTerminals;

    const sanitizedGroups = new Map<string, TabGroup>();
    const panelsAlreadyInGroups = new Set<string>();
    const seenGroupIds = new Set<string>();

    for (const group of tabGroups) {
      if (!group || typeof group.id !== "string" || !Array.isArray(group.panelIds)) {
        console.warn(`[TabGroup] Hydration: Skipping malformed group`, group);
        continue;
      }

      if (seenGroupIds.has(group.id)) continue;
      seenGroupIds.add(group.id);

      const groupLocation = group.location === "dock" ? "dock" : "grid";

      const validPanelIds = group.panelIds.filter((id) => {
        if (!terminalIdSet.has(id)) return false;
        if (trashedTerminals.has(id)) return false;
        const terminal = state.panelsById[id];
        if (terminal?.location === "trash" || terminal?.location === "background") return false;
        // A panel whose saved location conflicts with a persisted group means
        // the panel was moved after the group snapshot. Preserve the newer
        // per-panel location and sever stale membership; otherwise restart can
        // resurrect a dock outline for a panel that was already restored to grid.
        if (terminal && getPanelTabGroupLocation(terminal) !== groupLocation) return false;
        return true;
      });

      const uniquePanelIds = Array.from(new Set(validPanelIds));
      const finalPanelIds = uniquePanelIds.filter((id) => !panelsAlreadyInGroups.has(id));

      if (finalPanelIds.length <= 1) continue;

      const panelWorktrees = new Map<string | undefined, number>();
      for (const panelId of finalPanelIds) {
        const terminal = state.panelsById[panelId];
        if (terminal) {
          const count = panelWorktrees.get(terminal.worktreeId) || 0;
          panelWorktrees.set(terminal.worktreeId, count + 1);
        }
      }

      let repairedWorktreeId = group.worktreeId;
      if (panelWorktrees.size > 1 || !panelWorktrees.has(group.worktreeId)) {
        let maxCount = 0;
        for (const [wid, count] of panelWorktrees.entries()) {
          if (count > maxCount) {
            maxCount = count;
            repairedWorktreeId = wid;
          }
        }
        console.warn(
          `[TabGroup] Hydration: Repairing worktree mismatch in group ${group.id} (group: ${group.worktreeId}, repaired to: ${repairedWorktreeId})`
        );
      }

      finalPanelIds.forEach((id) => panelsAlreadyInGroups.add(id));

      const activeTabId = finalPanelIds.includes(group.activeTabId)
        ? group.activeTabId
        : finalPanelIds[0]!;

      sanitizedGroups.set(group.id, {
        ...group,
        location: groupLocation,
        worktreeId: repairedWorktreeId,
        panelIds: finalPanelIds,
        activeTabId,
      });
    }

    set((s) => {
      let terminalsUpdated = false;
      const newById = { ...s.panelsById };
      let newIndex = s.panelIdsByWorktreeId;

      for (const tid of s.panelIds) {
        const t = newById[tid];
        if (!t) continue;
        if (t.location === "trash" || s.trashedTerminals.has(t.id)) continue;

        for (const group of sanitizedGroups.values()) {
          if (group.panelIds.includes(t.id)) {
            const needsLocationUpdate = t.location !== group.location;
            const needsWorktreeUpdate =
              (t.worktreeId ?? undefined) !== (group.worktreeId ?? undefined);

            if (needsLocationUpdate || needsWorktreeUpdate) {
              const effectiveLocation = needsLocationUpdate ? group.location : t.location;
              terminalsUpdated = true;
              if (needsWorktreeUpdate) {
                newIndex = transferBetweenWorktreeIndex(
                  newIndex,
                  t.worktreeId,
                  group.worktreeId,
                  tid
                );
              }
              const ptyT3 = isPtyPanel(t) ? t : undefined;
              newById[tid] = {
                ...t,
                location: effectiveLocation,
                worktreeId: group.worktreeId,
                isVisible: effectiveLocation === "grid",
                runtimeStatus: deriveRuntimeStatus(
                  effectiveLocation === "grid",
                  ptyT3?.flowStatus,
                  ptyT3?.runtimeStatus
                ),
              } as PanelInstance;
            }
            break;
          }
        }
      }

      if (terminalsUpdated) {
        saveNormalized(newById, s.panelIds);
      }
      if (!options?.skipPersist) {
        saveTabGroups(sanitizedGroups);
      }
      return {
        panelsById: newById,
        panelIdsByWorktreeId: newIndex,
        tabGroups: sanitizedGroups,
      };
    });
  },

  // @deprecated - kept for backward compatibility during migration
  setTabGroupInfo: (_id, _tabGroupId, _orderInGroup) => {
    console.warn(
      "[TabGroup] setTabGroupInfo is deprecated. Use createTabGroup/addPanelToGroup instead."
    );
  },
});
