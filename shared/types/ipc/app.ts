import type { AgentId } from "../domain.js";
import type { TerminalState } from "./terminal.js";
import type { TerminalConfig } from "./config.js";

/** Saved recipe terminal */
export interface SavedRecipeTerminal {
  /** Terminal type */
  type: AgentId | "terminal";
  /** Optional title */
  title?: string;
  /** Optional command */
  command?: string;
  /** Optional environment variables */
  env?: Record<string, string>;
  /** Optional initial prompt for agent terminals */
  initialPrompt?: string;
}

/** Saved terminal recipe */
export interface SavedRecipe {
  /** Recipe ID */
  id: string;
  /** Recipe name */
  name: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Terminal definitions */
  terminals: SavedRecipeTerminal[];
  /** Creation timestamp */
  createdAt: number;
  /** Whether this recipe should appear in the empty state as a primary launcher */
  showInEmptyState?: boolean;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
}

/** Application state for persistence */
export interface AppState {
  /** Active terminal states */
  terminals: TerminalState[];
  /** Currently active worktree ID */
  activeWorktreeId?: string;
  /** Width of the sidebar in pixels */
  sidebarWidth: number;
  /**
   * Whether focus mode is active (panels collapsed for max terminal space)
   * @deprecated Focus mode is now stored per-project in ProjectState. This field is kept for migration only.
   */
  focusMode?: boolean;
  /**
   * Saved panel state before entering focus mode (for restoration)
   * @deprecated Focus panel state is now stored per-project in ProjectState. This field is kept for migration only.
   */
  focusPanelState?: {
    sidebarWidth: number;
    diagnosticsOpen: boolean;
  };
  /** Height of the diagnostics dock in pixels */
  diagnosticsHeight?: number;
  /** Height of the docked terminal popover in pixels */
  dockedPopoverHeight?: number;
  /** @deprecated Recipes are now stored per-project via project:get-recipes IPC. This field is kept for migration only. */
  recipes?: SavedRecipe[];
  /** Whether the user has seen the welcome screen */
  hasSeenWelcome?: boolean;
  /** Developer mode settings */
  developerMode?: {
    /** Master toggle for all debug features */
    enabled: boolean;
    /** Show state debug overlays in terminal headers */
    showStateDebug: boolean;
    /** Auto-open diagnostics dock on app startup */
    autoOpenDiagnostics: boolean;
    /** Focus events tab when diagnostics opens (requires autoOpenDiagnostics) */
    focusEventsTab: boolean;
  };
  /** Panel grid layout configuration */
  panelGridConfig?: import("../config.js").PanelGridConfig;
  /** Dock display mode: expanded or compact */
  dockMode?: import("../domain.js").DockMode;
  /** Dock behavior: auto (expands when docked terminals) or manual (user controlled) */
  dockBehavior?: import("../domain.js").DockBehavior;
  /** Whether compact dock should use ultra-minimal 6px strip mode */
  compactDockMinimal?: boolean;
}

/** Result from app hydration */
export interface HydrateResult {
  appState: AppState;
  terminalConfig: TerminalConfig;
  project: import("../domain.js").Project | null;
  agentSettings: import("../agentSettings.js").AgentSettings;
}
