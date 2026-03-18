import type { TabGroup, TabGroupLocation } from "@/types";
import type { TerminalRegistryStoreApi, TerminalRegistrySlice, TerminalInstance } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveTerminals, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus } from "./helpers";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createTabGroupActions = (
  set: Set,
  get: Get
): Pick<
  TerminalRegistrySlice,
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
    const tabGroups = get().tabGroups;
    for (const group of tabGroups.values()) {
      if (group.panelIds.includes(panelId)) {
        return group;
      }
    }
    return undefined;
  },

  createTabGroup: (location, worktreeId, panelIds, activeTabId) => {
    const groupId = `tabgroup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

      // Don't add if already in this group
      if (group.panelIds.includes(panelId)) {
        return state;
      }

      // Enforce worktree invariant - panel must match group's worktree
      const panel = state.terminals.find((t) => t.id === panelId);
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
            // Group has 0 or 1 panels remaining - delete it
            newTabGroups.delete(existingGroupId);
          } else {
            // Update group without this panel
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
          break; // Panel can only be in one group
        }
      }

      // Now add to the target group
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

      if (!groupToUpdate) {
        return state; // Panel not in any group
      }

      const newPanelIds = groupToUpdate.panelIds.filter((id) => id !== panelId);
      const newTabGroups = new Map(state.tabGroups);

      if (newPanelIds.length <= 1) {
        // Group has 0 or 1 panels remaining - delete the group
        newTabGroups.delete(groupToUpdate.id);
      } else {
        // Update the group with remaining panels
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

      // Verify all panel IDs are in the group
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
      if (!state.tabGroups.has(groupId)) {
        return state;
      }
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.delete(groupId);
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });
  },

  getTabGroupPanels: (groupId, _location) => {
    // Note: location parameter is deprecated and ignored - group location is stored in TabGroup
    const terminals = get().terminals;
    const trashedTerminals = get().trashedTerminals;
    const tabGroups = get().tabGroups;

    // Check if this is an explicit tab group
    const group = tabGroups.get(groupId);
    if (group) {
      // Return panels in the order defined by group.panelIds
      return group.panelIds
        .map((id) => terminals.find((t) => t.id === id))
        .filter(
          (t): t is TerminalInstance =>
            t !== undefined && t.location !== "trash" && !trashedTerminals.has(t.id)
        );
    }

    // Not an explicit group - check if it's a single ungrouped panel
    const panel = terminals.find((t) => t.id === groupId);
    if (panel && panel.location !== "trash" && !trashedTerminals.has(panel.id)) {
      // Verify this panel isn't in any explicit group
      for (const g of tabGroups.values()) {
        if (g.panelIds.includes(groupId)) {
          return []; // Panel is in an explicit group, not standalone
        }
      }
      return [panel];
    }

    return [];
  },

  getTabGroups: (location, worktreeId) => {
    const terminals = get().terminals;
    const trashedTerminals = get().trashedTerminals;
    const tabGroups = get().tabGroups;

    // Collect explicit groups for this location/worktree
    const explicitGroups: TabGroup[] = [];
    const panelsInExplicitGroups = new Set<string>();

    for (const group of tabGroups.values()) {
      if (group.location === location && (group.worktreeId ?? undefined) === worktreeId) {
        // Filter out trashed panels from the group
        const validPanelIds = group.panelIds.filter((id) => {
          const panel = terminals.find((t) => t.id === id);
          return panel && panel.location !== "trash" && !trashedTerminals.has(id);
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

    // Find ungrouped panels (single-panel "virtual" groups)
    const ungroupedPanels = terminals.filter((t) => {
      if (t.location === "trash" || trashedTerminals.has(t.id)) return false;
      const effectiveLocation = t.location ?? "grid";
      if (effectiveLocation !== location) return false;
      if ((t.worktreeId ?? undefined) !== worktreeId) return false;
      return !panelsInExplicitGroups.has(t.id);
    });

    // Create virtual single-panel groups for ungrouped panels
    const virtualGroups: TabGroup[] = ungroupedPanels.map((panel) => ({
      id: panel.id, // Use panel ID as group ID for virtual groups
      location,
      worktreeId,
      activeTabId: panel.id,
      panelIds: [panel.id],
    }));

    // Sort explicit groups by their earliest terminal index in the terminals array
    // This makes group order follow terminal array order (which reorderTabGroups manipulates)
    explicitGroups.sort((a, b) => {
      const aFirstIndex = Math.min(
        ...a.panelIds.map((id) => terminals.findIndex((t) => t.id === id)).filter((i) => i !== -1)
      );
      const bFirstIndex = Math.min(
        ...b.panelIds.map((id) => terminals.findIndex((t) => t.id === id)).filter((i) => i !== -1)
      );
      return aFirstIndex - bFirstIndex;
    });

    // Return explicit groups first (sorted by terminal order), then virtual groups
    return [...explicitGroups, ...virtualGroups];
  },

  moveTabGroupToLocation: (groupId, location) => {
    const group = get().tabGroups.get(groupId);
    if (!group) {
      console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
      return false;
    }

    // Already at target location
    if (group.location === location) {
      return true;
    }

    // Check capacity if moving to grid
    if (location === "grid") {
      const targetWorktreeId = group.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();

      // Count current grid groups (each group = 1 slot)
      const gridTerminals = get().terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
      );

      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of get().tabGroups.values()) {
        if (
          g.id !== groupId &&
          g.location === "grid" &&
          (g.worktreeId ?? null) === targetWorktreeId
        ) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }

      // Count ungrouped panels (excluding panels in the moving group)
      let ungroupedCount = 0;
      const movingPanelIds = new Set(group.panelIds);
      for (const t of gridTerminals) {
        if (!panelsInGroups.has(t.id) && !movingPanelIds.has(t.id)) {
          ungroupedCount++;
        }
      }

      // The moving group will occupy 1 slot
      if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
        console.warn(
          `[TabGroup] Cannot move group ${groupId} to grid: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
        );
        return false;
      }
    }

    // Update group location and all member panel locations (skip trashed)
    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup = { ...group, location };
      newTabGroups.set(groupId, updatedGroup);

      // Update all non-trashed panels in the group to the new location
      const panelIdSet = new Set(group.panelIds);
      const newTerminals = state.terminals.map((t) => {
        if (!panelIdSet.has(t.id)) return t;
        // Skip trashed panels - they should remain trashed
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) return t;
        return { ...t, location };
      });

      saveTerminals(newTerminals);
      saveTabGroups(newTabGroups);
      return { terminals: newTerminals, tabGroups: newTabGroups };
    });

    // Apply appropriate renderer policies for PTY-backed panels
    for (const panelId of group.panelIds) {
      const terminal = get().terminals.find((t) => t.id === panelId);
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

    // Already at target worktree
    if (group.worktreeId === worktreeId) {
      return true;
    }

    // Check capacity if moving to grid location
    if (group.location === "grid") {
      const targetWorktreeId = worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();

      // Count current grid groups (each group = 1 slot)
      const gridTerminals = get().terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
      );

      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of get().tabGroups.values()) {
        if (
          g.id !== groupId &&
          g.location === "grid" &&
          (g.worktreeId ?? null) === targetWorktreeId
        ) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }

      // Count ungrouped panels (excluding panels in the moving group)
      let ungroupedCount = 0;
      const movingPanelIds = new Set(group.panelIds);
      for (const t of gridTerminals) {
        if (!panelsInGroups.has(t.id) && !movingPanelIds.has(t.id)) {
          ungroupedCount++;
        }
      }

      // The moving group will occupy 1 slot
      if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
        console.warn(
          `[TabGroup] Cannot move group ${groupId} to worktree ${worktreeId}: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
        );
        return false;
      }
    }

    // Determine location for panels after the move
    const targetLocation: TabGroupLocation = group.location === "grid" ? "grid" : "dock";

    // Update group worktreeId and all member panel worktreeIds (skip trashed)
    set((state) => {
      const newTabGroups = new Map(state.tabGroups);
      const updatedGroup: TabGroup = { ...group, worktreeId };
      newTabGroups.set(groupId, updatedGroup);

      // Update all non-trashed panels in the group to the new worktree
      const panelIdSet = new Set(group.panelIds);
      const newTerminals = state.terminals.map((t) => {
        if (!panelIdSet.has(t.id)) return t;
        // Skip trashed panels - they should remain trashed
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) return t;
        return {
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
      });

      saveTerminals(newTerminals);
      saveTabGroups(newTabGroups);
      return { terminals: newTerminals, tabGroups: newTabGroups };
    });

    // Apply appropriate renderer policies for PTY-backed panels (skip trashed)
    for (const panelId of group.panelIds) {
      const terminal = get().terminals.find((t) => t.id === panelId);
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

      // Get current tab groups for this location/worktree
      // Use getTabGroups which returns both explicit and virtual (single-panel) groups
      const allGroups = get().getTabGroups(location, worktreeId ?? undefined);

      if (fromGroupIndex < 0 || fromGroupIndex >= allGroups.length) return state;
      if (toGroupIndex < 0 || toGroupIndex > allGroups.length) return state;

      // Reorder the groups
      const reorderedGroups = [...allGroups];
      const [movedGroup] = reorderedGroups.splice(fromGroupIndex, 1);
      reorderedGroups.splice(toGroupIndex, 0, movedGroup);

      // Now we need to reorder the terminals array to match the new group order
      // The terminals array order determines display order
      // Each group's panels should be contiguous and in the same order as the group's panelIds

      // Separate terminals by location
      const gridTerminals = state.terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      );
      const dockTerminals = state.terminals.filter((t) => t.location === "dock");
      const trashTerminals = state.terminals.filter((t) => t.location === "trash");
      const backgroundTerminals = state.terminals.filter((t) => t.location === "background");

      // Get terminals in the target location/worktree
      const terminalsInLocation = location === "grid" ? gridTerminals : dockTerminals;

      // Build new terminal list for this location by walking the reordered groups
      // and preserving order of terminals within each group
      const newLocationTerminals: TerminalInstance[] = [];
      const processedIds = new Set<string>();

      // Process terminals in the new group order
      for (const group of reorderedGroups) {
        // Get panels for this group in their proper order, filtering by location
        const groupPanels = state.terminals.filter((t) => {
          if (!group.panelIds.includes(t.id)) return false;
          if ((t.worktreeId ?? null) !== targetWorktreeId) return false;
          if (t.location === "trash") return false;
          // Ensure panel is in the target location
          const effectiveLocation = t.location ?? "grid";
          return effectiveLocation === location;
        });

        // Sort by the order in group.panelIds
        groupPanels.sort((a, b) => group.panelIds.indexOf(a.id) - group.panelIds.indexOf(b.id));

        for (const panel of groupPanels) {
          if (!processedIds.has(panel.id)) {
            newLocationTerminals.push(panel);
            processedIds.add(panel.id);
          }
        }
      }

      // Add any terminals in other worktrees (preserve their relative order)
      for (const terminal of terminalsInLocation) {
        if (!processedIds.has(terminal.id) && (terminal.worktreeId ?? null) !== targetWorktreeId) {
          newLocationTerminals.push(terminal);
          processedIds.add(terminal.id);
        }
      }

      // Reconstruct the full terminals array
      const newTerminals =
        location === "grid"
          ? [...newLocationTerminals, ...dockTerminals, ...trashTerminals, ...backgroundTerminals]
          : [...gridTerminals, ...newLocationTerminals, ...trashTerminals, ...backgroundTerminals];

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setActiveTab: (groupId, panelId) => {
    set((state) => {
      const group = state.tabGroups.get(groupId);
      if (!group) {
        return state;
      }
      if (!group.panelIds.includes(panelId)) {
        return state;
      }
      if (group.activeTabId === panelId) {
        return state;
      }
      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.set(groupId, { ...group, activeTabId: panelId });
      saveTabGroups(newTabGroups);
      return { tabGroups: newTabGroups };
    });
  },

  getActiveTabId: (groupId) => {
    const group = get().tabGroups.get(groupId);
    if (group) {
      return group.activeTabId || null;
    }
    const terminal = get().terminals.find((t) => t.id === groupId);
    if (terminal && terminal.location !== "trash") {
      for (const g of get().tabGroups.values()) {
        if (g.panelIds.includes(groupId)) {
          return null;
        }
      }
      return groupId;
    }
    return null;
  },

  hydrateTabGroups: (tabGroups, options) => {
    const terminals = get().terminals;
    const terminalIdSet = new Set(terminals.map((t) => t.id));
    const trashedTerminals = get().trashedTerminals;

    // Sanitize tab groups during hydration:
    // 1. Deduplicate group IDs (keep first occurrence)
    // 2. Drop panelIds that no longer exist or are trashed (check both trashedTerminals AND location)
    // 3. Deduplicate panelIds within each group
    // 4. Delete groups with <= 1 unique panel
    // 5. Validate group location is "grid" or "dock"
    // 6. Normalize member locations to match group location
    // 7. Repair worktree mismatches (enforce worktree invariant)
    const sanitizedGroups = new Map<string, TabGroup>();
    const panelsAlreadyInGroups = new Set<string>();
    const seenGroupIds = new Set<string>();

    for (const group of tabGroups) {
      // Validate shape: skip malformed groups that would crash during sanitation
      if (!group || typeof group.id !== "string" || !Array.isArray(group.panelIds)) {
        console.warn(`[TabGroup] Hydration: Skipping malformed group`, group);
        continue;
      }

      // Deduplicate group IDs - keep first occurrence
      if (seenGroupIds.has(group.id)) {
        continue;
      }
      seenGroupIds.add(group.id);

      // Validate group location
      const groupLocation = group.location === "dock" ? "dock" : "grid";

      // Filter to only valid, non-trashed/backgrounded panels
      const validPanelIds = group.panelIds.filter((id) => {
        if (!terminalIdSet.has(id)) return false;
        if (trashedTerminals.has(id)) return false;
        const terminal = terminals.find((t) => t.id === id);
        if (terminal?.location === "trash" || terminal?.location === "background") return false;
        return true;
      });

      // Deduplicate panel IDs (preserve first occurrence)
      const uniquePanelIds = Array.from(new Set(validPanelIds));

      // Enforce unique membership: skip panels already assigned to another group
      const finalPanelIds = uniquePanelIds.filter((id) => !panelsAlreadyInGroups.has(id));

      if (finalPanelIds.length <= 1) {
        continue;
      }

      // Check worktree consistency - all panels must have the same worktreeId as the group
      const panelWorktrees = new Map<string | undefined, number>();
      for (const panelId of finalPanelIds) {
        const terminal = terminals.find((t) => t.id === panelId);
        if (terminal) {
          const count = panelWorktrees.get(terminal.worktreeId) || 0;
          panelWorktrees.set(terminal.worktreeId, count + 1);
        }
      }

      // If there's a worktree mismatch, repair it
      let repairedWorktreeId = group.worktreeId;
      if (panelWorktrees.size > 1 || !panelWorktrees.has(group.worktreeId)) {
        // Find the most common worktreeId among panels (majority wins)
        let maxCount = 0;
        for (const [worktreeId, count] of panelWorktrees.entries()) {
          if (count > maxCount) {
            maxCount = count;
            repairedWorktreeId = worktreeId;
          }
        }
        console.warn(
          `[TabGroup] Hydration: Repairing worktree mismatch in group ${group.id} (group: ${group.worktreeId}, repaired to: ${repairedWorktreeId})`
        );
      }

      // Mark these panels as assigned
      finalPanelIds.forEach((id) => panelsAlreadyInGroups.add(id));

      // Ensure activeTabId is valid
      const activeTabId = finalPanelIds.includes(group.activeTabId)
        ? group.activeTabId
        : finalPanelIds[0];

      sanitizedGroups.set(group.id, {
        ...group,
        location: groupLocation,
        worktreeId: repairedWorktreeId,
        panelIds: finalPanelIds,
        activeTabId,
      });
    }

    // Normalize panel locations and worktreeIds to match their group (skip trashed panels)
    set((state) => {
      let terminalsUpdated = false;
      const newTerminals = state.terminals.map((t) => {
        // Skip trashed panels - they should not be normalized
        if (t.location === "trash" || state.trashedTerminals.has(t.id)) {
          return t;
        }

        // Find which group this panel belongs to
        for (const group of sanitizedGroups.values()) {
          if (group.panelIds.includes(t.id)) {
            // Panel is in a group - ensure location and worktreeId match
            const needsLocationUpdate = t.location !== group.location;
            const needsWorktreeUpdate =
              (t.worktreeId ?? undefined) !== (group.worktreeId ?? undefined);

            if (needsLocationUpdate || needsWorktreeUpdate) {
              terminalsUpdated = true;
              return {
                ...t,
                location: group.location,
                worktreeId: group.worktreeId,
                isVisible: group.location === "grid",
                runtimeStatus: deriveRuntimeStatus(
                  group.location === "grid",
                  t.flowStatus,
                  t.runtimeStatus
                ),
              };
            }
            break;
          }
        }
        return t;
      });

      if (terminalsUpdated) {
        saveTerminals(newTerminals);
      }
      // Skip persistence if this is an error-recovery clear
      if (!options?.skipPersist) {
        saveTabGroups(sanitizedGroups);
      }
      return { terminals: newTerminals, tabGroups: sanitizedGroups };
    });
  },

  // @deprecated - kept for backward compatibility during migration
  setTabGroupInfo: (_id, _tabGroupId, _orderInGroup) => {
    console.warn(
      "[TabGroup] setTabGroupInfo is deprecated. Use createTabGroup/addPanelToGroup instead."
    );
    // This method is now a no-op as we've normalized the data model
    // The UI should use createTabGroup and addPanelToGroup
  },
});
