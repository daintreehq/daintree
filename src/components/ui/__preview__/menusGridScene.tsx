import { DndContext } from "@dnd-kit/core";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { ContentGrid } from "@/components/Terminal/ContentGrid";
import { MENUS_PROJECT } from "./menusShims";

/**
 * The REAL `ContentGrid` with no panels, so its background — the whole region —
 * is the right-click target for the grid's launch menu. Two agents are pinned,
 * which is what splits the launch rows into a pinned run and the rest.
 */

const WORKTREE: WorktreeSnapshot = {
  id: "wt-main",
  worktreeId: "wt-main",
  path: MENUS_PROJECT.path,
  name: "main",
  branch: "develop",
  isCurrent: true,
  isMainWorktree: true,
};

const PINS: readonly BuiltInAgentId[] = ["claude", "codex"];

const worktreeStore = createWorktreeStore();
let agentAvailability: CliAvailability = {};

export function seedGridScene(): void {
  initBuiltInPanelKinds();
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  worktreeStore.setState({ worktrees: new Map([[WORKTREE.id, WORKTREE]]) });
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: WORKTREE.id });
  useProjectStore.setState({ currentProject: MENUS_PROJECT, projects: [MENUS_PROJECT] });

  const availability: Record<string, AgentAvailabilityState> = {};
  for (const id of PINS) availability[id] = "ready";
  agentAvailability = availability as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });
  useAgentSettingsStore.setState({
    settings: {
      agents: Object.fromEntries(PINS.map((id) => [id, { pinned: true }])),
    } as AgentSettings,
  });
}

export function GridScene() {
  return (
    <WorktreeStoreContext.Provider value={worktreeStore}>
      <DndContext>
        <div
          data-testid="menus-grid"
          className="relative overflow-hidden rounded-[var(--radius-md)] border border-divider"
          style={{ width: 900, height: 860 }}
        >
          <ContentGrid
            className="h-full w-full"
            agentAvailability={agentAvailability}
            defaultCwd={MENUS_PROJECT.path}
            emptyContent={<div className="h-full w-full" aria-hidden="true" />}
          />
        </div>
      </DndContext>
    </WorktreeStoreContext.Provider>
  );
}
