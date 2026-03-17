import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { Worktree } from "@shared/types/worktree";
import type { SettingsNavTarget } from "@/components/Settings";

export type ActionRegistry = Map<ActionId, () => ActionDefinition<unknown, unknown>>;

export type NavigationDirection = "up" | "down" | "left" | "right";

export interface ActionCallbacks {
  onOpenSettings: () => void;
  onOpenSettingsTab: (target: SettingsNavTarget) => void;
  onToggleSidebar: () => void;
  onToggleFocusMode: () => void;
  onFocusRegionNext: () => void;
  onFocusRegionPrev: () => void;
  onOpenWorktreePalette: () => void;
  onOpenQuickCreatePalette: () => void;
  onToggleWorktreeOverview: () => void;
  onOpenWorktreeOverview: () => void;
  onCloseWorktreeOverview: () => void;
  onOpenPanelPalette: () => void;
  onOpenProjectSwitcherPalette: () => void;
  onOpenActionPalette: () => void;
  onOpenQuickSwitcher: () => void;
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
