import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import {
  panelKindHasPty,
  normalizeDockLocation,
  normalizeGroupDockLocation,
} from "@shared/config/panelKindRegistry";
import { getNarrowPanel } from "./selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { isDevPreviewPanel, type PanelKind } from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { transferBetweenWorktreeIndex } from "./worktreeIndex";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import {
  stopDevPreviewByPanelId,
  dissolvePanelFromGroup,
  computeRestoredTabGroup,
} from "./helpers";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

export const createBackgroundActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "backgroundTerminal"
  | "backgroundPanelGroup"
  | "restoreBackgroundTerminal"
  | "restoreBackgroundGroup"
  | "isInBackground"
> => ({
  backgroundTerminal: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;
    // Overlay panels (the Daintree Assistant) and dialog panels self-manage and
    // are never backgrounded — short-circuiting also prevents the
    // `originalLocation` collapse below from recording a bogus "grid" restore
    // target (#9699).
    if (
      terminal.location === "trash" ||
      terminal.location === "background" ||
      terminal.location === "overlay" ||
      terminal.location === "dialog"
    )
      return;

    if (isDevPreviewPanel(terminal)) {
      stopDevPreviewByPanelId(id);
    }

    const originalLocation: "dock" | "grid" = terminal.location === "dock" ? "dock" : "grid";

    // Capture group metadata BEFORE set() dissolves the group
    const group = get().getPanelGroup(id);
    let groupRestoreId: string | undefined;
    let groupMetadata: import("./types").TrashedTerminalGroupMetadata | undefined;

    if (group) {
      groupRestoreId = `group-${crypto.randomUUID()}`;
      groupMetadata = {
        panelIds: [...group.panelIds],
        activeTabId: group.activeTabId ?? group.panelIds[0] ?? "",
        location: group.location,
        worktreeId: group.worktreeId ?? null,
      };
    }

    set((state) => {
      const existing = state.panelsById[id];
      if (!existing) return state;
      const newById: Record<string, CarrierPanel> = {
        ...state.panelsById,
        [id]: { ...existing, location: "background" as const },
      };
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.set(id, {
        id,
        originalLocation,
        ...(groupRestoreId && { groupRestoreId }),
        ...(groupMetadata && { groupMetadata }),
      });

      const dissolved = dissolvePanelFromGroup(state.tabGroups, id);
      const newTabGroups = dissolved.tabGroups;
      if (dissolved.dissolved) {
        saveTabGroups(newTabGroups);
      }

      saveNormalized(newById, state.panelIds);
      return {
        panelsById: newById,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    }
  },

  backgroundPanelGroup: (panelId) => {
    const group = get().getPanelGroup(panelId);

    if (!group) {
      get().backgroundTerminal(panelId);
      return;
    }

    const groupRestoreId = `group-${crypto.randomUUID()}`;
    const panelIds = [...group.panelIds];
    const activeTabId = group.activeTabId ?? panelIds[0] ?? "";
    const state = get();

    const existingPanelIds = panelIds.filter((id) => state.panelsById[id]);
    if (existingPanelIds.length === 0) {
      set((s) => {
        const newTabGroups = new Map(s.tabGroups);
        newTabGroups.delete(group.id);
        saveTabGroups(newTabGroups);
        return { tabGroups: newTabGroups };
      });
      return;
    }

    const bgPanelIds = existingPanelIds;
    const resolvedActiveTabId = bgPanelIds.includes(activeTabId)
      ? activeTabId
      : (bgPanelIds[0] ?? "");
    const originalLocation: "dock" | "grid" = group.location === "dock" ? "dock" : "grid";
    const worktreeId = group.worktreeId ?? null;

    set((s) => {
      const newById = { ...s.panelsById };
      for (const bid of bgPanelIds) {
        if (newById[bid]) {
          newById[bid] = { ...newById[bid], location: "background" as const };
        }
      }

      // Store groupMetadata on every member, not just an anchor. If any single
      // member is removed before restore (individual deletion, hydration loss),
      // the surviving members still carry the full restore metadata so ordering
      // and the active tab are preserved. See issue #8944.
      const newBackgrounded = new Map(s.backgroundedTerminals);
      for (const bid of bgPanelIds) {
        newBackgrounded.set(bid, {
          id: bid,
          originalLocation,
          groupRestoreId,
          groupMetadata: {
            panelIds: [...bgPanelIds],
            activeTabId: resolvedActiveTabId,
            location: group.location,
            worktreeId,
          },
        });
      }

      const newTabGroups = new Map(s.tabGroups);
      newTabGroups.delete(group.id);
      saveTabGroups(newTabGroups);

      saveNormalized(newById, s.panelIds);
      return {
        panelsById: newById,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    for (const bid of bgPanelIds) {
      const terminal = state.panelsById[bid];
      if (terminal && isDevPreviewPanel(terminal)) {
        stopDevPreviewByPanelId(bid);
        continue;
      }
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(bid, TerminalRefreshTier.BACKGROUND);
      }
    }
  },

  restoreBackgroundTerminal: (id, targetWorktreeId) => {
    const backgroundedInfo = get().backgroundedTerminals.get(id);
    if (!backgroundedInfo) return;

    if (backgroundedInfo.groupRestoreId) {
      get().restoreBackgroundGroup(backgroundedInfo.groupRestoreId, targetWorktreeId);
      return;
    }

    const rawRestoreLocation = backgroundedInfo.originalLocation ?? "grid";
    const terminal = get().panelsById[id];
    // Normalize a persisted dock location to grid if the kind is no longer
    // dockable (#11375); adopt the active worktree when a rescued worktree-less
    // panel would otherwise strand in the global-only grid bucket (#11290).
    const restoreLocation = normalizeDockLocation(terminal?.kind, rawRestoreLocation);
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

    set((state) => {
      const t = state.panelsById[id];
      if (!t) return state;
      const rescuedToGrid = restoreLocation === "grid" && rawRestoreLocation === "dock";
      const nextWorktreeId =
        targetWorktreeId !== undefined
          ? targetWorktreeId
          : rescuedToGrid && t.worktreeId == null && activeWorktreeId !== null
            ? activeWorktreeId
            : t.worktreeId;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          location: restoreLocation,
          worktreeId: nextWorktreeId,
        },
      };
      const newIndex = transferBetweenWorktreeIndex(
        state.panelIdsByWorktreeId,
        t.worktreeId,
        nextWorktreeId,
        id
      );
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.delete(id);
      saveNormalized(newById, state.panelIds);
      return {
        panelsById: newById,
        panelIdsByWorktreeId: newIndex,
        backgroundedTerminals: newBackgrounded,
      };
    });

    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      if (restoreLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    }
  },

  restoreBackgroundGroup: (groupRestoreId, targetWorktreeId) => {
    const backgroundedTerminals = get().backgroundedTerminals;

    const groupPanels: Array<{
      id: string;
      backgrounded: NonNullable<ReturnType<typeof backgroundedTerminals.get>>;
    }> = [];
    let anchorPanel: NonNullable<ReturnType<typeof backgroundedTerminals.get>> | undefined;

    for (const [id, backgrounded] of backgroundedTerminals.entries()) {
      if (backgrounded.groupRestoreId === groupRestoreId) {
        groupPanels.push({ id, backgrounded });
        // Metadata is replicated identically across all members (#8944); take
        // the first one found so the restore source is deterministic.
        if (!anchorPanel && backgrounded.groupMetadata) {
          anchorPanel = backgrounded;
        }
      }
    }

    if (groupPanels.length === 0) return;

    // A tab group is atomic — normalize a persisted dock location to grid when
    // ANY live member's kind is no longer dockable (#11375), moving the whole
    // group rather than splitting it, and adopt the active worktree for a
    // rescued worktree-less group so it isn't stranded in the grid.
    const rawGroupLocation: "grid" | "dock" =
      (anchorPanel?.groupMetadata?.location ?? groupPanels[0]?.backgrounded?.originalLocation) ===
      "dock"
        ? "dock"
        : "grid";
    const groupMemberKinds: (PanelKind | undefined)[] = [];
    for (const { id } of groupPanels) {
      const t = get().panelsById[id];
      if (t) groupMemberKinds.push(t.kind);
    }
    const restoreLocation = normalizeGroupDockLocation(groupMemberKinds, rawGroupLocation);
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
    const rescuedToGrid = restoreLocation === "grid" && rawGroupLocation === "dock";
    const worktreeId =
      targetWorktreeId !== undefined
        ? targetWorktreeId
        : (anchorPanel?.groupMetadata?.worktreeId ??
          (rescuedToGrid && activeWorktreeId !== null ? activeWorktreeId : undefined));

    set((state) => {
      const panelIdsInGroup = new Set(groupPanels.map(({ id }) => id));
      const newById = { ...state.panelsById };
      let newIndex = state.panelIdsByWorktreeId;
      for (const pid of panelIdsInGroup) {
        const t = newById[pid];
        if (t) {
          const nextWorktreeId = worktreeId ?? t.worktreeId;
          newById[pid] = {
            ...t,
            location: restoreLocation as "dock" | "grid",
            worktreeId: nextWorktreeId,
          };
          newIndex = transferBetweenWorktreeIndex(newIndex, t.worktreeId, nextWorktreeId, pid);
        }
      }

      const newBackgrounded = new Map(state.backgroundedTerminals);
      for (const { id } of groupPanels) {
        newBackgrounded.delete(id);
      }

      saveNormalized(newById, state.panelIds);
      return {
        panelsById: newById,
        panelIdsByWorktreeId: newIndex,
        backgroundedTerminals: newBackgrounded,
      };
    });

    // Recreate the tab group if we have multiple valid panels
    const restoredPanelIds = groupPanels.map(({ id }) => id);
    const existingIds = new Set(get().panelIds);
    const validPanelIds = restoredPanelIds.filter((id) => existingIds.has(id));

    const groupResult = computeRestoredTabGroup(validPanelIds, anchorPanel?.groupMetadata);
    if (groupResult) {
      get().createTabGroup(
        restoreLocation as "dock" | "grid",
        worktreeId,
        groupResult.orderedPanelIds,
        groupResult.activeTabId
      );
    }

    for (const { id } of groupPanels) {
      const terminal = get().panelsById[id];
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (restoreLocation === "dock") {
          optimizeForDock(id);
        } else {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        }
      }
    }
  },

  isInBackground: (id) => {
    return get().backgroundedTerminals.has(id);
  },
});
