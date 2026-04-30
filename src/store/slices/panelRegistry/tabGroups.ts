import type { TabGroup, TabGroupLocation } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice, TerminalInstance } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus } from "./helpers";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

function getPanelTabGroupLocation(panel: TerminalInstance | undefined): TabGroupLocation | null {
  if (!panel || panel.location === "trash" || panel.location === "background") return null;
  return panel.location === "dock" ? "dock" : "grid";
}

function panelMatchesWorktreeScope(
  panelWorktreeId: string | undefined,
  worktreeId: string | undefined,
  location: TabGroupLocation
): boolean {
  if ((panelWorktreeId ?? undefined) === worktreeId) return true;
  // Docked global panels are intentionally visible in every worktree-scoped dock.
  // Grid panels remain worktree-exact to avoid leaking global panels into every grid.
  return location === "dock" && panelWorktreeId === undefined && worktreeId !== undefined;
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
  },

  removePanelFromGroup: (panelId) => {
    set((state) => {
      let groupToUpdate: TabGroup | undefined;
      for (const group of state.tabGroups.values()) {
        if (group.panelIds.includes(panelId)) {
          groupToUpdate = group;
          break;
        }
      }

      if (!groupToUpdate) return state;

      const newPanelIds = groupToUpdate.panelIds.filter((id) => id !== panelId);
      const newTabGroups = new Map(state.tabGroups);

      if (newPanelIds.length <= 1) {
        newTabGroups.delete(groupToUpdate.id);
      } else {
        const newActiveTabId =
          groupToUpdate.activeTabId === panelId
            ? (newPanelIds[0] ?? "")
            : groupToUpdate.activeTabId;
        const newGroup: TabGroup = {
          ...groupToUpdate,
          panelIds: newPanelIds,
          activeTabId: newActiveTabId,
        };
        newTabGroups.set(groupToUpdate.id, newGroup);
      }

      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
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
          (t): t is TerminalInstance =>
            t !== undefined &&
            getPanelTabGroupLocation(t) !== null &&
            (location === undefined || getPanelTabGroupLocation(t) === location) &&
            !trashedTerminals.has(t.id)
        );
    }

    // Not an explicit group - check if it's a single ungrouped panel
    const panel = state.panelsById[groupId];
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
    const panelsInExplicitGroups = new Set<string>();

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
          validPanelIds.forEach((id) => panelsInExplicitGroups.add(id));
        }
      }
    }

    // Find ungrouped panels
    const ungroupedPanels: TerminalInstance[] = [];
    for (const tid of state.panelIds) {
      const t = state.panelsById[tid];
      if (!t) continue;
      if (t.location === "trash" || trashedTerminals.has(t.id)) continue;
      const effectiveLocation = getPanelTabGroupLocation(t);
      if (effectiveLocation === null) continue;
      if (effectiveLocation !== location) continue;
      if (!panelMatchesWorktreeScope(t.worktreeId, worktreeId, location)) continue;
      if (panelsInExplicitGroups.has(t.id)) continue;
      ungroupedPanels.push(t);
    }

    const virtualGroups: TabGroup[] = ungroupedPanels.map((panel) => ({
      id: panel.id,
      location,
      worktreeId,
      activeTabId: panel.id,
      panelIds: [panel.id],
    }));

    // Sort explicit groups by their earliest terminal index in panelIds
    const idIndexMap = new Map(state.panelIds.map((id, i) => [id, i]));
    explicitGroups.sort((a, b) => {
      const aFirstIndex = Math.min(...a.panelIds.map((id) => idIndexMap.get(id) ?? Infinity));
      const bFirstIndex = Math.min(...b.panelIds.map((id) => idIndexMap.get(id) ?? Infinity));
      return aFirstIndex - bFirstIndex;
    });

    return [...explicitGroups, ...virtualGroups];
  },

  moveTabGroupToLocation: (groupId, location) => {
    const group = get().tabGroups.get(groupId);
    if (!group) {
      console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
      return false;
    }

    if (group.location === location) return true;

    if (location === "grid") {
      const targetWorktreeId = group.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const state = get();

      const gridTerminalIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }

      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of state.tabGroups.values()) {
        if (
          g.id !== groupId &&
          g.location === "grid" &&
          (g.worktreeId ?? null) === targetWorktreeId
        ) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }

      const movingPanelIds = new Set(group.panelIds);
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid) && !movingPanelIds.has(tid)) {
          ungroupedCount++;
        }
      }

      if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
        console.warn(
          `[TabGroup] Cannot move group ${groupId} to grid: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
        );
        return false;
      }
    }

    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup = { ...group, location };
      newTabGroups.set(groupId, updatedGroup);

      const panelIdSet = new Set(group.panelIds);
      const newById = { ...state.panelsById };
      for (const pid of panelIdSet) {
        const t = newById[pid];
        if (!t) continue;
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) continue;
        newById[pid] = {
          ...t,
          location,
          isVisible: location === "grid",
          runtimeStatus: deriveRuntimeStatus(location === "grid", t.flowStatus, t.runtimeStatus),
        };
      }

      saveNormalized(newById, state.panelIds);
      saveTabGroups(newTabGroups);
      return { panelsById: newById, tabGroups: newTabGroups };
    });

    for (const panelId of group.panelIds) {
      const terminal = get().panelsById[panelId];
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (location === "dock") {
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

    if (group.location === "grid") {
      const targetWorktreeId = worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const state = get();

      const gridTerminalIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }

      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of state.tabGroups.values()) {
        if (
          g.id !== groupId &&
          g.location === "grid" &&
          (g.worktreeId ?? null) === targetWorktreeId
        ) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }

      const movingPanelIds = new Set(group.panelIds);
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid) && !movingPanelIds.has(tid)) {
          ungroupedCount++;
        }
      }

      if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
        console.warn(
          `[TabGroup] Cannot move group ${groupId} to worktree ${worktreeId}: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
        );
        return false;
      }
    }

    const targetLocation: TabGroupLocation = group.location === "grid" ? "grid" : "dock";

    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup = { ...group, worktreeId };
      newTabGroups.set(groupId, updatedGroup);

      const panelIdSet = new Set(group.panelIds);
      const newById = { ...state.panelsById };
      for (const pid of panelIdSet) {
        const t = newById[pid];
        if (!t) continue;
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) continue;
        newById[pid] = {
          ...t,
          worktreeId,
          location: targetLocation,
          isVisible: targetLocation === "grid",
          runtimeStatus: deriveRuntimeStatus(
            targetLocation === "grid",
            t.flowStatus,
            t.runtimeStatus
          ),
        };
      }

      saveNormalized(newById, state.panelIds);
      saveTabGroups(newTabGroups);
      return { panelsById: newById, tabGroups: newTabGroups };
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
      const targetWorktreeId = worktreeId ?? null;

      const allGroups = get().getTabGroups(location, worktreeId ?? undefined);

      if (fromGroupIndex < 0 || fromGroupIndex >= allGroups.length) return state;
      if (toGroupIndex < 0 || toGroupIndex > allGroups.length) return state;

      const reorderedGroups = [...allGroups];
      const [movedGroup] = reorderedGroups.splice(fromGroupIndex, 1);
      if (!movedGroup) return state;
      reorderedGroups.splice(toGroupIndex, 0, movedGroup);

      // Build new panelIds with the reordered groups
      const matchesLocation = (t: TerminalInstance) =>
        location === "grid"
          ? t.location === "grid" || t.location === undefined
          : t.location === "dock";

      const newLocationIds: string[] = [];
      const processedIds = new Set<string>();

      for (const group of reorderedGroups) {
        const groupPanelIds = group.panelIds.filter((pid) => {
          const t = state.panelsById[pid];
          if (!t) return false;
          if ((t.worktreeId ?? null) !== targetWorktreeId) return false;
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

      // Add terminals in this location but other worktrees
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          !processedIds.has(tid) &&
          matchesLocation(t) &&
          (t.worktreeId ?? null) !== targetWorktreeId
        ) {
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
      return { panelIds: newIds };
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
    if (terminal && terminal.location !== "trash" && terminal.location !== "background") {
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
              newById[tid] = {
                ...t,
                location: effectiveLocation,
                worktreeId: group.worktreeId,
                isVisible: effectiveLocation === "grid",
                runtimeStatus: deriveRuntimeStatus(
                  effectiveLocation === "grid",
                  t.flowStatus,
                  t.runtimeStatus
                ),
              };
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
      return { panelsById: newById, tabGroups: sanitizedGroups };
    });
  },

  // @deprecated - kept for backward compatibility during migration
  setTabGroupInfo: (_id, _tabGroupId, _orderInGroup) => {
    console.warn(
      "[TabGroup] setTabGroupInfo is deprecated. Use createTabGroup/addPanelToGroup instead."
    );
  },
});
