import { with as withTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { TerminalRefreshTier } from "@/types";
import type { TabGroup } from "@shared/types/panel";

export const optimizeForDock = (id: string): void => {
  withTerminalService(
    (service) => service.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE),
    id
  );
};

// Trashed terminals are never on screen, so they drop to BACKGROUND rather than
// being promoted — promotion would also load the deferred addons onto them.
export const demoteForTrash = (id: string): void => {
  withTerminalService(
    (service) => service.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND),
    id
  );
};

// Only the active tab of a grid group in the active worktree is on screen after
// a move or restore. Everything else stays BACKGROUND. A null active worktree
// (store not hydrated yet) counts as the active one, matching addPanel;
// applyWorktreeTerminalPolicy reconciles once the worktree is set.
export const applyGridPlacementTier = (
  id: string,
  panel: { worktreeId?: string | null },
  group: Pick<TabGroup, "activeTabId"> | undefined
): void => {
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
  const inActiveWorktree =
    activeWorktreeId === null || (panel.worktreeId ?? null) === activeWorktreeId;
  const isActiveTab = !group || group.activeTabId === id;
  withTerminalService(
    (service) =>
      service.applyRendererPolicy(
        id,
        inActiveWorktree && isActiveTab
          ? TerminalRefreshTier.VISIBLE
          : TerminalRefreshTier.BACKGROUND
      ),
    id
  );
};
