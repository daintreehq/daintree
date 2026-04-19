import type { AgentId, AgentState } from "./agent.js";
import type { BrowserHistory } from "./browser.js";
import type {
  PanelKind,
  TerminalType,
  PanelLocation,
  TabGroup,
  PanelExitBehavior,
} from "./panel.js";
import type { CommandOverride } from "./commands.js";
import type { EditorConfig } from "./editor.js";
import type { NotificationSettings } from "./ipc/api.js";

/**
 * Project lifecycle status:
 * - `active`: Currently open and in use (only one project can be active at a time)
 * - `background`: Has running processes but not currently displayed
 * - `closed`: No running processes, fully dormant
 * - `missing`: Project directory no longer exists at the stored path
 */
export type ProjectStatus = "active" | "background" | "closed" | "missing";

/** Project (Git repository) managed by Daintree */
export interface Project {
  /** Unique identifier (UUID or path hash) */
  id: string;
  /** Git repository root path */
  path: string;
  /** User-editable display name */
  name: string;
  /** User-editable emoji (default: tree) */
  emoji: string;
  /** Timestamp of last opening (for sorting) */
  lastOpened: number;
  /** Theme color/gradient (optional) */
  color?: string;
  /** Project lifecycle status (defaults to 'closed' for backward compatibility) */
  status?: ProjectStatus;
  /** Whether a .daintree/project.json was found in the repository root */
  daintreeConfigPresent?: boolean;
  /** Whether in-repo settings mode is enabled (writes to .daintree/ on update) */
  inRepoSettings?: boolean;
  /** Whether the project is pinned to the top of the project switcher */
  pinned?: boolean;
  /** Frecency score for sorting (exponential decay, default 3.0) */
  frecencyScore?: number;
  /** Timestamp (ms) of last frecency update */
  lastAccessedAt?: number;
}

/** Panel snapshot for state preservation. */
export interface PanelSnapshot {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: PanelKind;
  /** Terminal type */
  type?: TerminalType;
  /** Agent ID when kind is an agent - enables extensibility */
  agentId?: AgentId;
  /** Display title */
  title: string;
  /** Working directory - only present for PTY panels */
  cwd?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location: PanelLocation;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
  /** Current URL for browser/dev-preview panes */
  browserUrl?: string;
  /** Navigation history for browser/dev-preview panes */
  browserHistory?: BrowserHistory;
  /** Zoom factor for browser/dev-preview panes */
  browserZoom?: number;
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
  /** Dev server status for dev-preview panels */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server URL for dev-preview panels */
  devServerUrl?: string;
  /** Dev server error for dev-preview panels */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server for dev-preview panels */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Path to note file (kind === 'notes') */
  notePath?: string;
  /** Note ID (kind === 'notes') */
  noteId?: string;
  /** Note scope (kind === 'notes') */
  scope?: "worktree" | "project";
  /** Note creation timestamp (kind === 'notes') */
  createdAt?: number;
  /** Behavior when terminal exits */
  exitBehavior?: PanelExitBehavior;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Preset ID active at launch time, used to restore colored icon on reload */
  agentPresetId?: string;
  /** Preset hex color captured at launch time; fallback when preset is later deleted */
  agentPresetColor?: string;
  /** Original user-selected preset ID; immutable across fallback hops. */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** How many fallback hops have been consumed from the primary's chain. */
  fallbackChainIndex?: number;
  /** Last known agent state for crash recovery display */
  agentState?: AgentState;
  /** Timestamp of last agent state change */
  lastStateChange?: number;
  /** Opaque state bag for extension panels — survives the save/restore round-trip */
  extensionState?: Record<string, unknown>;
  // Note: Tab membership is now stored in ProjectState.tabGroups, not on terminals
}

/** @deprecated Use PanelSnapshot instead. */
export type TerminalSnapshot = PanelSnapshot;

/** Terminal layout metadata */
export interface TerminalLayout {
  /** Grid configuration (optional for future use) */
  grid?: {
    rows: number;
    cols: number;
  };
  /** Focused terminal ID */
  focusedTerminalId?: string;
  /** Maximized terminal ID */
  maximizedTerminalId?: string;
}

/** Focus panel state saved before entering focus mode */
export interface FocusPanelState {
  /** Sidebar width before focus mode */
  sidebarWidth: number;
  /** Whether diagnostics dock was open */
  diagnosticsOpen: boolean;
}

/** Per-project state snapshot */
export interface ProjectState {
  /** ID of the project this state belongs to */
  projectId: string;
  /** Active worktree ID */
  activeWorktreeId?: string;
  /** Sidebar width */
  sidebarWidth: number;
  /** Terminal snapshots */
  terminals: TerminalSnapshot[];
  /** Tab groups - explicit groups only (single panels are implicit) */
  tabGroups?: TabGroup[];
  /** Terminal layout metadata */
  terminalLayout?: TerminalLayout;
  /** Whether focus mode is active (panels collapsed for max terminal space) */
  focusMode?: boolean;
  /** Saved panel state before entering focus mode (for restoration) */
  focusPanelState?: FocusPanelState;
  /** Terminal dimensions per terminal ID (preserved across project switches) */
  terminalSizes?: Record<string, { cols: number; rows: number }>;
  /** Hybrid input bar draft text per terminal ID (preserved across project switches) */
  draftInputs?: Record<string, string>;
}

/** Recipe terminal type */
export type RecipeTerminalType = AgentId | "terminal" | "dev-preview";

/** A single terminal definition within a recipe */
export interface RecipeTerminal {
  /** Type of terminal to spawn */
  type: RecipeTerminalType;
  /** Custom title for this terminal (optional) */
  title?: string;
  /** Command to execute for custom terminal types (optional) */
  command?: string;
  /** Environment variables to set (optional) */
  env?: Record<string, string>;
  /** Initial prompt to send to agent terminals after boot (optional). Supports {{issue_number}}, {{pr_number}}, {{worktree_path}}, {{branch_name}} variables replaced at runtime. */
  initialPrompt?: string;
  /** Additional CLI arguments for agent terminals (e.g., "--model sonnet"). Whitespace-separated; applied at spawn time only. */
  args?: string;
  /** Dev server command for dev-preview terminals (optional). Falls back to project devServerCommand if not set. */
  devCommand?: string;
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely (optional, defaults to "keep") */
  exitBehavior?: PanelExitBehavior;
  /** Per-panel model override captured at launch (agent types only). Transient — stripped before disk persistence. */
  agentModelId?: string;
  /** Process-level launch flags captured at launch (agent types only). Transient — stripped before disk persistence. */
  agentLaunchFlags?: string[];
}

/** A saved terminal recipe */
export interface TerminalRecipe {
  /** Unique identifier for the recipe */
  id: string;
  /** Human-readable name for the recipe */
  name: string;
  /** Project ID this recipe belongs to; undefined means global (not tied to any project) */
  projectId?: string;
  /** Associated worktree ID (optional for worktree-specific recipes) */
  worktreeId?: string;
  /** List of terminals to spawn when recipe is executed */
  terminals: RecipeTerminal[];
  /** Timestamp when recipe was created (milliseconds since epoch) */
  createdAt: number;
  /** Whether this recipe should appear in the empty state as a primary launcher */
  showInEmptyState?: boolean;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
  /** Timestamps of recent runs for frecency scoring (capped at 20 entries) */
  usageHistory?: number[];
  /** Controls whether the linked GitHub issue is auto-assigned during quick worktree creation */
  autoAssign?: "always" | "never" | "prompt";
}

/** Returns the effective autoAssign mode for a recipe, defaulting to "always" for legacy recipes */
export function getAutoAssign(recipe: TerminalRecipe): "always" | "never" | "prompt" {
  return recipe.autoAssign ?? "always";
}

/** Run command definition */
export interface RunCommand {
  /** Unique identifier for this command */
  id: string;
  /** Display name (e.g. "Dev Server" or "Run Tests") */
  name: string;
  /** Command to execute (e.g. "npm run dev" or "php artisan test") */
  command: string;
  /** Optional icon name for UI display */
  icon?: string;
  /** Optional description (e.g. the script content from package.json) */
  description?: string;
  /** Preferred panel location when running this command */
  preferredLocation?: "dock" | "grid";
  /** Whether to auto-restart the command on exit */
  preferredAutoRestart?: boolean;
}

/** CopyTree context generation settings */
export interface CopyTreeSettings {
  /** Maximum total context size in bytes (e.g., 1MB, 5MB, 10MB). Undefined = unlimited */
  maxContextSize?: number;
  /** Maximum individual file size in bytes. Files larger are skipped */
  maxFileSize?: number;
  /** Character limit per file for truncation. Files exceeding this will be truncated */
  charLimit?: number;
  /** Truncation strategy: "all" (no truncation) or "modified" (newest first when limits hit) */
  strategy?: "all" | "modified";
  /** Glob patterns to always include, even if old */
  alwaysInclude?: string[];
  /** Glob patterns to always exclude from context */
  alwaysExclude?: string[];
}

/** Resource environment configuration for remote compute hooks */
export type ResourceEnvironment = {
  /** Commands to provision the remote environment */
  provision?: string[];
  /** Commands to destroy the remote environment */
  teardown?: string[];
  /** Commands to resume a paused environment */
  resume?: string[];
  /** Commands to pause the environment without destroying */
  pause?: string[];
  /** Single command that outputs JSON with { "status": "<string>" } */
  status?: string;
  /** Command to open a shell session (ssh, docker exec, etc.) */
  connect?: string;
  /** Lucide icon name for visual identification in the UI */
  icon?: string;
};

/** Per-project terminal configuration overrides */
export interface ProjectTerminalSettings {
  /** Override shell executable path (machine-local, not stored in .daintree/settings.json) */
  shell?: string;
  /** Override shell arguments (replaces default args when set) */
  shellArgs?: string[];
  /** Override default working directory for new terminals */
  defaultWorkingDirectory?: string;
  /** Override scrollback line count (100–10,000) */
  scrollbackLines?: number;
}

/** Project-level settings that persist per repository */
export interface ProjectSettings {
  /** List of custom run commands for this project */
  runCommands: RunCommand[];
  /** Environment variables to set */
  environmentVariables?: Record<string, string>;
  /** List of env var keys stored separately from settings.json */
  secureEnvironmentVariables?: string[];
  /** List of env var keys found in plaintext that should be migrated (transient, not persisted) */
  insecureEnvironmentVariables?: string[];
  /** List of secure keys that couldn't be decrypted (transient, not persisted) */
  unresolvedSecureEnvironmentVariables?: string[];
  /** Paths to exclude from monitoring */
  excludedPaths?: string[];
  /** Raw SVG text for project icon (max 250KB, validated/sanitized) */
  projectIconSvg?: string;
  /** ID of the default recipe to run when creating new worktrees */
  defaultWorktreeRecipeId?: string;
  /** Dev server command (e.g., "npm run dev") for the toolbar button */
  devServerCommand?: string;
  /** User dismissed dev server discovery for this project (not a web project) */
  devServerDismissed?: boolean;
  /** Dev server command was auto-detected (vs manually configured) */
  devServerAutoDetected?: boolean;
  /** User dismissed cloud sync folder warning for this project */
  cloudSyncWarningDismissed?: boolean;
  /** User dismissed the offer to import detected project context files (CLAUDE.md, AGENTS.md, etc.) */
  contextFilesOfferDismissed?: boolean;
  /** Timeout in seconds before a slow-loading dev preview is automatically reloaded (default: 30, max: 120) */
  devServerLoadTimeout?: number;
  /** Whether to auto-inject --turbopack for Next.js 15+ projects (default: true) */
  turbopackEnabled?: boolean;
  /** CopyTree context generation configuration */
  copyTreeSettings?: CopyTreeSettings;
  /** Command overrides for project-specific customization */
  commandOverrides?: CommandOverride[];
  /** Git initialization defaults */
  gitInitDefaults?: {
    /** Create an initial commit (default: true) */
    createInitialCommit?: boolean;
    /** Initial commit message (default: "Initial commit") */
    initialCommitMessage?: string;
    /** Create a .gitignore file (default: true) */
    createGitignore?: boolean;
    /** Gitignore template to use (default: "node") */
    gitignoreTemplate?: "node" | "python" | "minimal" | "none";
  };
  /** Preferred external editor for this project */
  preferredEditor?: EditorConfig;
  /** Preferred image viewer for this project */
  preferredImageViewer?: {
    mode: "os" | "custom";
    customCommand?: string;
  };
  /** Branch prefix mode for new worktrees */
  branchPrefixMode?: "none" | "username" | "custom";
  /** Custom branch prefix string when branchPrefixMode is "custom" (e.g., "feature/") */
  branchPrefixCustom?: string;

  /** Git remote name to use for GitHub integration (defaults to "origin") */
  githubRemote?: string;
  /** Per-project worktree path pattern override (uses global default when unset) */
  worktreePathPattern?: string;
  /** Per-project terminal configuration overrides */
  terminalSettings?: ProjectTerminalSettings;
  /** Per-project notification overrides (machine-local, never written to .daintree/settings.json) */
  notificationOverrides?: Partial<NotificationSettings>;
  /** @deprecated Use resourceEnvironments instead. Kept for migration only. */
  resourceEnvironment?: ResourceEnvironment;
  /** Named resource environment configurations for remote compute hooks */
  resourceEnvironments?: Record<string, ResourceEnvironment>;
  /** Name of the currently active resource environment (defaults to "default") */
  activeResourceEnvironment?: string;
  /** Default worktree mode for new worktrees ("local" or an environment key from resourceEnvironments) */
  defaultWorktreeMode?: string;
}
