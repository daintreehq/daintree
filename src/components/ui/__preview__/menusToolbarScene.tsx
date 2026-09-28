import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";
import { Toolbar } from "@/components/Layout/Toolbar";
import { MENUS_PROJECT } from "./menusShims";

/**
 * The real `Toolbar`, seeded for the two menus `toolbar-preview.html` cannot
 * reach: the project pill's "Stop all agents" row (only drawn while the project
 * has live processes) and the plugin tray (only drawn while plugins contribute
 * toolbar buttons — answered by the bridge shim in `menusShims.ts`).
 */

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: MENUS_PROJECT.path,
    name: "main",
    branch: "develop",
    isCurrent: true,
    isMainWorktree: true,
  },
];

const PINS: readonly BuiltInAgentId[] = ["claude", "codex"];

const worktreeStore = createWorktreeStore();
let agentAvailability: CliAvailability = {};
let agentSettings: AgentSettings = { agents: {} };

function seed(): void {
  initBuiltInPanelKinds();
  worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: MENUS_PROJECT, projects: [MENUS_PROJECT] });

  // A live process count is what puts "Stop all agents" on the pill's menu.
  const stats: ProjectStatusMap = {
    [MENUS_PROJECT.id]: {
      activeAgentCount: 2,
      waitingAgentCount: 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      snoozedAgentCount: 0,
      processCount: 3,
    } as ProjectStatusMap[string],
  };
  useProjectStatsStore.setState({ stats });

  const availability: Record<string, AgentAvailabilityState> = {};
  for (const id of PINS) availability[id] = "ready";
  agentAvailability = availability as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });
  agentSettings = {
    agents: Object.fromEntries(PINS.map((id) => [id, { pinned: true }])),
  } as AgentSettings;
  useAgentSettingsStore.setState({ settings: agentSettings });

  const layout = useToolbarPreferencesStore.getState().layout;
  useToolbarPreferencesStore.setState({
    layout: {
      ...layout,
      leftButtons: ["launcher", ...PINS, ...layout.leftButtons.filter((id) => id !== "launcher")],
    },
  });
}

seed();

const noop = () => {};

export function ToolbarScene() {
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <WorktreeStoreContext.Provider value={worktreeStore}>
      <div data-preview-window="" className="relative flex h-screen flex-col">
        <Toolbar
          onLaunchAgent={noop}
          onSettings={noop}
          hasWorkspace
          agentAvailability={agentAvailability}
          agentSettings={agentSettings}
          projectSwitcherPalette={projectSwitcherPalette}
        />
        <div className="flex flex-1">
          <div className="w-[320px] shrink-0 border-r border-divider bg-surface-sidebar" />
          <div className="flex-1 bg-surface-canvas" />
        </div>
      </div>
    </WorktreeStoreContext.Provider>
  );
}
