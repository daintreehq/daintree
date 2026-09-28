import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { CopyTreeHistoryRecord } from "@shared/types";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useCopyTreeHistoryStore } from "@/store/copyTreeHistoryStore";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";
import { Toolbar } from "@/components/Layout/Toolbar";
import { MENUS_PROJECT } from "./menusShims";

/**
 * The real `Toolbar`, seeded for the two menus `toolbar-preview.html` cannot
 * reach: the project pill's "Stop all agents" row (only drawn while the project
 * has live processes) and the plugin tray (only drawn while plugins contribute
 * toolbar buttons — answered by the bridge shim in `menusShims.ts`). It also
 * carries four worktrees, so an agent button's "Launch in worktree" submenu has
 * rows, and a copy-tree history, so the copy-context menu lists recent runs.
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
  ...(
    [
      { name: "menus", branch: "design/menus-popovers" },
      { name: "handback", branch: "feature/issue-12486-handback-marker" },
      { name: "dock-drop", branch: "bugfix/issue-12593-dock-drop" },
    ] as const
  ).map(({ name, branch }) => ({
    id: `wt-${name}`,
    worktreeId: `wt-${name}`,
    path: `/Users/greg/Projects/daintree-worktrees/${name}`,
    name,
    branch,
    isCurrent: false,
    isMainWorktree: false,
  })),
];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function copyRecord(
  id: string,
  name: string,
  fileCount: number,
  totalSize: number,
  agoMs: number,
  options: CopyTreeHistoryRecord["options"]
): CopyTreeHistoryRecord {
  const lastUsedAt = Date.now() - agoMs;
  return {
    id,
    dedupeKey: `key-${id}`,
    name,
    options,
    source: "toolbar",
    worktreeId: "wt-main",
    stats: { fileCount, totalSize, duration: 1200 },
    createdAt: lastUsedAt - 7 * DAY,
    lastUsedAt,
    runCount: 3,
  };
}

const COPY_TREE_RECENTS: CopyTreeHistoryRecord[] = [
  copyRecord("f1", "src/components/Layout", 212, 840 * 1024, 20 * MIN, {
    scopePaths: ["src/components/Layout"],
  }),
  copyRecord("f2", "Changed files only", 17, 96 * 1024, 180 * MIN, { modified: true }),
  copyRecord("f3", "*.test.ts", 486, 4.1 * 1024 * 1024, 11 * DAY, { filter: ["**/*.test.ts"] }),
  copyRecord("f4", "docs", 88, 410 * 1024, 26 * DAY, { scopePaths: ["docs"] }),
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
  // The menu's own init pulls over the bridge; answer it from the fixture instead.
  useCopyTreeHistoryStore.setState({ records: COPY_TREE_RECENTS, loading: false, init: () => {} });

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
