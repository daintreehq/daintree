import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, useWorktreeSelectionStore } from "@/store";
import { useScratchStore } from "@/store/scratchStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { resolveWorkspaceCwd } from "@/utils/workspaceCwd";
import { sortAgentsByToolbarPin } from "@/lib/agentMenuOrder";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { isAssistantOnlyAgentId, LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import type { DockLaunchAgent, DockLaunchInventoryState } from "./dockLaunchItems";
import type { RecipeContext } from "@/utils/recipeVariables";

export interface LauncherData {
  agents: DockLaunchAgent[];
  /** How many leading entries of `agents` are pinned — drives the Pinned/Other split. */
  pinnedCount: number;
  agentInventoryState: DockLaunchInventoryState;
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
  hasWorkspace: boolean;
  hasProject: boolean;
}

/**
 * Everything a launcher placement needs about the workspace it is launching
 * into: which agents exist, where they would land, and which preconditions are
 * currently unmet.
 *
 * Hoisted out of `ContentDock` because the toolbar now hosts the same launcher
 * and had none of this — and a second copy of the inventory rules is how the two
 * placements start offering different things. Deliberately returns no pin state
 * and no setters: the pin write path stays `dispatchToolbarVisibility` /
 * `setPanelButtonOnToolbar` inside the launcher, which is what Settings calls
 * too (#11667).
 */
export function useLauncherData(): LauncherData {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((s) => s.currentProject);
  const currentScratch = useScratchStore((s) => s.currentScratch);
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);
  const leftButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.leftButtons));
  const rightButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.rightButtons));
  const { worktrees } = useWorktrees();

  const activeWorktree = activeWorktreeId ? worktrees.find((w) => w.id === activeWorktreeId) : null;

  // This cwd rides down as an explicit launch option, and `""` is not nullish —
  // it would win over any fallback further down the chain, so it has to resolve
  // the whole workspace here (#11076).
  const cwd = resolveWorkspaceCwd({
    worktreePath: activeWorktree?.path,
    projectPath: currentProject?.path,
    scratchPath: currentScratch?.path,
  });

  // Before the first real availability result lands, "nothing installed" and
  // "still detecting" are indistinguishable — so neither the empty state nor
  // the discovery fallback may commit yet.
  const isAvailabilityLoading = agentAvailability === undefined || !hasRealData;

  const { agents, pinnedCount, agentInventoryState } = useMemo(() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    const toAgent = (id: string): DockLaunchAgent => {
      const config = getAgentConfig(id);
      return {
        id,
        name: config?.name ?? id,
        icon: config?.icon,
        brandColor: config?.color,
        availability: agentAvailability?.[id],
      };
    };

    const offered = [...baseIds, ...extraIds]
      // Assistant-only agents are never offered in a launch menu.
      .filter((id) => !isAssistantOnlyAgentId(id))
      .map(toAgent);
    const installed = offered.filter((agent) => isAgentInstalled(agent.availability));

    // Nothing installed on this machine: offer every built-in with a Setup
    // route rather than an "no agents available" dead end. Only once real
    // detection has landed, or first paint would flash the discovery list at
    // someone who has agents (#11681).
    if (!isAvailabilityLoading && installed.length === 0) {
      return {
        agents: LAUNCHABLE_AGENT_IDS.map(toAgent),
        pinnedCount: 0,
        agentInventoryState: "fallback" as DockLaunchInventoryState,
      };
    }

    const { sorted, pinnedCount } = sortAgentsByToolbarPin(
      installed,
      leftButtons,
      agentSettings,
      rightButtons
    );
    return {
      agents: sorted,
      pinnedCount,
      agentInventoryState: (isAvailabilityLoading
        ? "loading"
        : "installed") as DockLaunchInventoryState,
    };
  }, [agentAvailability, agentSettings, isAvailabilityLoading, leftButtons, rightButtons]);

  const recipeContext = activeWorktree
    ? {
        issueNumber: activeWorktree.issueNumber,
        prNumber: activeWorktree.linked?.pr?.ref.number,
        branchName: activeWorktree.branch,
        worktreePath: activeWorktree.path,
      }
    : undefined;

  return {
    agents,
    pinnedCount,
    agentInventoryState,
    activeWorktreeId,
    cwd,
    recipeContext,
    // A workspace of any kind — the file browser browses the project or scratch
    // root when no worktree is selected (#11482), so gating it on a project
    // would disable it in exactly the worktree-less workspaces where it works.
    hasWorkspace: Boolean(currentProject || currentScratch),
    hasProject: Boolean(currentProject),
  };
}
