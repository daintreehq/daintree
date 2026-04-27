import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { Worktree } from "@shared/types/worktree";
import type { SettingsNavTarget } from "@/components/Settings";
import type { AddPanelOptions } from "@/store";

type AddTerminalOptions = AddPanelOptions;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any> & {
  /** Present on synthetic definitions backing plugin-contributed actions. */
  pluginId?: string;
  /**
   * Raw JSON-Schema object for plugin-contributed actions. Plugins cannot
   * ship a Zod schema across IPC, so they declare a plain JSON Schema object
   * which is surfaced directly in the MCP manifest.
   */
  rawInputSchema?: Record<string, unknown>;
};

export type ActionRegistry = Map<ActionId, () => AnyActionDefinition>;

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
  onConfirmCloseActiveProject: (projectId: string) => void;
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
      modelId?: string;
      presetId?: string | null;
    }
  ) => Promise<string | null>;
  onInject: (worktreeId: string) => void;
  getDefaultCwd: () => string;
  getActiveWorktreeId: () => string | undefined;
  getWorktrees: () => Worktree[];
  getFocusedId: () => string | null;
  getIsSettingsOpen: () => boolean;
  getGridNavigation: () => {
    findNearest: (currentId: string, direction: NavigationDirection) => string | null;
    findByIndex: (index: number) => string | null;
    findDockByIndex: (currentId: string, direction: "left" | "right") => string | null;
    getCurrentLocation: () => "grid" | "dock" | null;
  };
  onAddTerminal: (options: AddTerminalOptions) => Promise<void>;
}
