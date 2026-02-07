import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { Worktree } from "@shared/types/domain";

export type ActionRegistry = Map<ActionId, () => ActionDefinition<unknown, unknown>>;

export type NavigationDirection = "up" | "down" | "left" | "right";

export interface ActionCallbacks {
  onOpenSettings: () => void;
  onOpenSettingsTab: (tab: string) => void;
  onToggleSidebar: () => void;
  onToggleFocusMode: () => void;
  onOpenAgentPalette: () => void;
  onOpenWorktreePalette: () => void;
  onToggleWorktreeOverview: () => void;
  onOpenWorktreeOverview: () => void;
  onCloseWorktreeOverview: () => void;
  onOpenNewTerminalPalette: () => void;
  onOpenPanelPalette: () => void;
  onOpenProjectSwitcherPalette: () => void;
  onOpenActionPalette: () => void;
  onOpenShortcuts: () => void;
  onLaunchAgent: (
    agentId: string,
    options?: {
      location?: "grid" | "dock";
      cwd?: string;
      worktreeId?: string;
      prompt?: string;
      interactive?: boolean;
    }
  ) => Promise<string | null>;
  onInject: (worktreeId: string) => void;
  getDefaultCwd: () => string;
  getActiveWorktreeId: () => string | undefined;
  getWorktrees: () => Worktree[];
  getFocusedId: () => string | null;
  getGridNavigation: () => {
    findNearest: (currentId: string, direction: NavigationDirection) => string | null;
    findByIndex: (index: number) => string | null;
    findDockByIndex: (currentId: string, direction: "left" | "right") => string | null;
    getCurrentLocation: () => "grid" | "dock" | null;
  };
}
