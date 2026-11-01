import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { Worktree } from "@shared/types/worktree";
import type {
  TerminalSpawnSource,
  AddPanelFocusPolicy,
  ScheduledRunRef,
} from "@shared/types/panel";
import type { SettingsNavTarget } from "@/components/Settings";
import type { AddPanelOptions } from "@/store";
import type { PanelLimitSnapshot } from "@/store/panelLimitStore";

type AddTerminalOptions = AddPanelOptions;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any> & {
  /** Present on synthetic definitions backing plugin-contributed actions. */
  pluginId?: string;
  /** The providing plugin's manifest name, set beside {@link pluginId}. */
  pluginName?: string;
  /**
   * Raw JSON-Schema object for plugin-contributed actions. Plugins cannot
   * ship a Zod schema across IPC, so they declare a plain JSON Schema object
   * which is surfaced directly in the MCP manifest.
   */
  rawInputSchema?: Record<string, unknown>;
  /**
   * Raw JSON-Schema object for the action result. Mirrors `rawInputSchema` for
   * cases where a Zod `resultSchema` isn't practical — for example, when the
   * canonical schema lives outside the renderer (shared with the main process)
   * and is the source of truth for both the MCP tool definition and runtime
   * structuredContent shape.
   */
  rawOutputSchema?: Record<string, unknown>;
};

export type ActionRegistry = Map<ActionId, () => AnyActionDefinition>;

export type NavigationDirection = "up" | "down" | "left" | "right";

/**
 * Why a launch resolved to `null` without throwing. Structurally mirrors
 * `LaunchDecline` in `@/hooks/useAgentLauncher`; duplicated so this type never
 * depends on the renderer hook (#11547).
 */
export interface LaunchDecline {
  reason: "panel-limit" | "already-launching" | "spawn-failed" | "unavailable" | "presets-loading";
  /** The count and limits the refusal was judged on; set only for `panel-limit`. */
  panelLimit: PanelLimitSnapshot | null;
}

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
  onOpenResumeSessionsPalette: () => void;
  onOpenProjectSwitcherPalette: () => void;
  onConfirmCloseActiveProject: (projectId: string) => void;
  onOpenActionPalette: () => void;
  onOpenQuickSwitcher: () => void;
  onOpenShortcuts: () => void;
  onLaunchAgent: (
    agentId: string,
    options?: {
      location?: "grid" | "dock" | "overlay" | "background";
      cwd?: string;
      worktreeId?: string;
      prompt?: string;
      handbackCode?: string;
      systemPromptArgs?: string[];
      interactive?: boolean;
      modelId?: string;
      presetId?: string | null;
      activateDockOnCreate?: boolean;
      env?: Record<string, string>;
      excludeFromPersistence?: boolean;
      removeOnExit?: boolean;
      agentLaunchFlags?: string[];
      spawnedBy?: TerminalSpawnSource;
      /** The scheduled run this launch is for, from `ActionContext.scheduledRun` only (#15977). */
      scheduledRun?: ScheduledRunRef;
      /** The plugin behind a plugin dispatch, from `ActionContext.callerPluginId` only. */
      launchedByPluginId?: string;
      focusPolicy?: AddPanelFocusPolicy;
      requestedId?: string;
      force?: boolean;
      name?: string;
      onDecline?: (decline: LaunchDecline) => void;
    }
  ) => Promise<{
    terminalId: string;
    location: "grid" | "dock" | "background";
    /** Present only when Daintree opened a setup diagnostic instead of spawning a PTY. */
    spawnStatus?: "missing-cli";
    /**
     * Where the launch landed, resolved by the launcher before the panel was
     * created. Structurally mirrors `LaunchAgentIdentity` in
     * `@/hooks/useAgentLauncher` — kept duplicated here for the same reason the
     * options bag is: this type must not depend on the renderer hook (#11547).
     */
    worktreeId: string | null;
    worktreePath: string | null;
    branch: string | null;
    cwd: string | null;
    cwdOutsideWorktree: boolean | null;
  } | null>;
  onInject: (worktreeId: string, terminalId?: string) => void;
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
