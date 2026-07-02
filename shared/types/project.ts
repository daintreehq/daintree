import type { AgentId, AgentState } from "./agent.js";
import type { BrowserHistory } from "./browser.js";
import type {
  PanelKind,
  PanelLocation,
  PanelTitleMode,
  TabGroup,
  PanelExitBehavior,
  ViewportPresetId,
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
  /**
   * Timestamp (ms) the background-idle auto-close reclaimed this project's
   * memory and marked it `closed`. Absent for projects closed manually or still
   * open; the project switcher surfaces it as a distinct "Suspended to free
   * memory" label. Cleared when the project is reopened.
   */
  autoParkedAt?: number;
}

/** Panel snapshot for state preservation. */
export interface PanelSnapshot {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: PanelKind;
  /**
   * Launch hint — agent this terminal was launched to run. Persisted so
   * restart re-injects the same command. Not identity. See
   * `docs/architecture/terminal-identity.md`.
   */
  launchAgentId?: AgentId;
  /** Display title */
  title: string;
  /** How the title is owned. Absent defaults to "default". */
  titleMode?: PanelTitleMode;
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
  /** Active dev-preview console drawer tab ("output" = PTY, "console" = guest-page console) */
  devPreviewConsoleTab?: "output" | "console";
  /** Active viewport preset for dev-preview responsive emulation */
  viewportPreset?: ViewportPresetId;
  /** Whether the active dev-preview viewport preset is rotated to landscape */
  viewportRotated?: boolean;
  /** Device-pixel-ratio override for the active dev-preview viewport preset */
  viewportDpr?: 1 | 2 | 3;
  /** Whether the dev-preview viewport is scaled to fit the available pane */
  viewportFit?: boolean;
  /** Last captured dev-preview scroll position, paired with URL for stale-scroll prevention */
  devPreviewScrollPosition?: { url: string; scrollY: number };
  /** Behavior when terminal exits */
  exitBehavior?: PanelExitBehavior;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /**
   * Caller-resolved launch env (preset/recipe/caller layers) captured at launch,
   * persisted so a restored session replays the same provider environment it
   * launched with rather than re-deriving it from a preset that may no longer
   * resolve (#10922). Sanitized via `sanitizeAgentEnv` on write and read.
   */
  env?: Record<string, string>;
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
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
  /**
   * Timestamp (ms) of the last user-initiated focus on this panel. Used by
   * panel restore to promote the most-recently-active panel per worktree to
   * the priority restore tier.
   */
  lastActiveAt?: number;
  /** Legacy persisted creation timestamp (milliseconds since epoch). */
  createdAt?: number;
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
  /** Quick-switcher MRU list (terminal:/worktree: ids) — per-project so opening another project's view can't gut it */
  mruList?: string[];
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
  /** Clone-layout placement. Transient — stripped before disk persistence. Only "dock" is captured; absence means grid. */
  location?: "dock";
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
  /** Set at merge time when this recipe is shadowed by a higher-tier recipe with the same name */
  shadowedBy?: string;
  /**
   * Marks a recipe as living in `.daintree/recipes/`. Set at load time and on
   * creation of in-repo recipes. Decouples scope detection from the recipe id,
   * which is now an opaque UUID for in-repo recipes rather than a name-derived
   * `inrepo-<slug>` string (legacy ids still carry the prefix). See
   * {@link isInRepoRecipeId}.
   */
  scope?: "inrepo";
}

/**
 * Describes a `.daintree/recipes/` filename collision discovered during
 * reconciliation: two distinct recipes whose names slugify to the same
 * filename. Only one can own the file, so the other cannot be promoted to the
 * shared in-repo store. Surfaced to the renderer (instead of a silent
 * `console.error`) so the user can rename one to resolve it.
 */
export interface RecipeNameCollision {
  /** The filename slug both recipes resolve to. */
  filename: string;
  /** Id of the recipe that owns the filename. */
  keptId: string;
  /** Id of the recipe that could not be promoted. */
  droppedId: string;
  /** Display name of the recipe that could not be promoted. */
  droppedName: string;
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
  /** True when the detector identified this script as the canonical dev script
   * for a known framework signature (e.g. `start` for Create React App). Lets
   * the renderer trust the upstream framework-aware ordering instead of
   * re-imposing name-only priority. */
  isFrameworkDefault?: boolean;
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

/** Snapshot fleet scope: stores the exact pane IDs at save time. Missing IDs are silently dropped on recall. */
export interface SnapshotFleetSavedScope {
  kind: "snapshot";
  id: string;
  name: string;
  terminalIds: string[];
  createdAt: number;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
  /** Timestamps of recent runs for frecency scoring (capped at 20 entries) */
  usageHistory?: number[];
}

/** Predicate fleet scope: stores a filter rule that is re-evaluated against the current panel set on recall. */
export interface PredicateFleetSavedScope {
  kind: "predicate";
  id: string;
  name: string;
  scope: "current" | "all";
  /** "all" maps to armAll(scope); "working"/"waiting"/"finished" map to armByState(preset, scope, false). */
  stateFilter: "all" | "working" | "waiting" | "finished";
  createdAt: number;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
  /** Timestamps of recent runs for frecency scoring (capped at 20 entries) */
  usageHistory?: number[];
}

/** A saved fleet scope — a named selection persisted per-project for quick recall. */
export type FleetSavedScope = SnapshotFleetSavedScope | PredicateFleetSavedScope;

/** Per-project terminal configuration overrides */
export interface ProjectTerminalSettings {
  /** Override shell executable path */
  shell?: string;
  /** Override shell arguments (replaces default args when set) */
  shellArgs?: string[];
  /** Override default working directory for new terminals */
  defaultWorkingDirectory?: string;
  /** Override scrollback line count (100–10,000) */
  scrollbackLines?: number;
}

/**
 * Classifies how a `ProjectSettings` (or sub-field) field is persisted.
 * - `shareable`: written to `.daintree/settings.json` (committed to git, shared with teammates)
 * - `local`: persisted only in the machine-local project store, never written to the repo file
 * - `transient`: runtime-only, never persisted to disk
 *
 * The shareability tables (`PROJECT_SETTINGS_SHAREABILITY`,
 * `PROJECT_TERMINAL_SETTINGS_SHAREABILITY`) are the single source of truth — adding a new
 * field to `ProjectSettings` without classifying it here is a build error.
 */
export type FieldShareability = "shareable" | "local" | "transient";

/**
 * Shareability classification for each field of `ProjectTerminalSettings`.
 *
 * `shell` and `defaultWorkingDirectory` are both machine-local: the reader
 * (`parseTerminalSettings`) requires an absolute path, and absolute paths
 * are inherently per-machine. Teammates cannot meaningfully share either.
 */
export const PROJECT_TERMINAL_SETTINGS_SHAREABILITY = {
  shell: "local",
  shellArgs: "shareable",
  defaultWorkingDirectory: "local",
  scrollbackLines: "shareable",
} as const satisfies Record<keyof ProjectTerminalSettings, FieldShareability>;

/** Project-level settings that persist per repository */
export interface ProjectSettings {
  /** List of custom run commands for this project */
  runCommands: RunCommand[];
  /** Environment variables to set */
  environmentVariables?: Record<string, string>;
  /** List of env var keys stored separately from settings.json */
  secureEnvironmentVariables?: string[];
  /** List of env var keys found in plaintext that should be migrated */
  insecureEnvironmentVariables?: string[];
  /** List of secure keys that couldn't be decrypted */
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

  /** Git remote name to use for forge integration (defaults to "origin") */
  forgeRemote?: string;
  /**
   * @deprecated Use `forgeRemote` instead. Kept for one-cycle migration of existing project files.
   * Normalized to `forgeRemote` on read by the project settings codec.
   */
  githubRemote?: string;
  /**
   * Pinned forge provider for this project. When set, overrides hostname auto-detection
   * for forge integrations. `null` (or absent) = auto-detect. Stores the bare `contribution.id` of a
   * provider registered via the forge provider registry.
   */
  forgeProviderOverride?: string | null;
  /** Per-project worktree path pattern override (uses global default when unset) */
  worktreePathPattern?: string;
  /** Saved fleet scopes for quick arm/recall */
  fleetSavedScopes?: FleetSavedScope[];
  /** Per-project terminal configuration overrides */
  terminalSettings?: ProjectTerminalSettings;
  /** Per-project notification overrides */
  notificationOverrides?: Partial<NotificationSettings>;
  /** @deprecated Use resourceEnvironments instead. Kept for migration only. */
  resourceEnvironment?: ResourceEnvironment;
  /** Named resource environment configurations for remote compute hooks */
  resourceEnvironments?: Record<string, ResourceEnvironment>;
  /** Name of the currently active resource environment (defaults to "default") */
  activeResourceEnvironment?: string;
  /** Default worktree mode for new worktrees ("local" or an environment key from resourceEnvironments) */
  defaultWorktreeMode?: string;
  /** Hostnames the user approved for the browser panel beyond the implicit local/private allow-list */
  browserAllowedHosts?: string[];
  /**
   * Tier of Daintree MCP access exposed to agents launched in this project's worktrees.
   * - `off` (default): no MCP server injected
   * - `workbench`: read-only introspection (worktree/files/terminal output, project state, history)
   * - `action`: workbench + non-destructive operations (create worktrees, inject context, stage changes)
   * - `system`: action + destructive/irreversible operations (delete worktrees, commit/push, send terminal commands)
   */
  daintreeMcpTier?: DaintreeMcpTier;
  /**
   * @deprecated Use `daintreeMcpTier` instead. Kept for one-cycle migration of existing project files.
   * `true` migrates to `workbench` on read; `false`/undefined migrates to `off`.
   */
  exposeDaintreeMcpToAgents?: boolean;
}

/**
 * Shareability classification for each field of `ProjectSettings`.
 *
 * The `satisfies Record<keyof ProjectSettings, FieldShareability>` constraint makes adding
 * a new `ProjectSettings` field without a classification entry a compile-time error.
 *
 * `terminalSettings` is marked `shareable` because it contains shareable sub-fields; the
 * nested object is filtered through `PROJECT_TERMINAL_SETTINGS_SHAREABILITY` by the writer.
 */
export const PROJECT_SETTINGS_SHAREABILITY = {
  runCommands: "shareable",
  environmentVariables: "local",
  secureEnvironmentVariables: "local",
  insecureEnvironmentVariables: "transient",
  unresolvedSecureEnvironmentVariables: "transient",
  excludedPaths: "shareable",
  projectIconSvg: "local",
  defaultWorktreeRecipeId: "local",
  devServerCommand: "shareable",
  devServerDismissed: "local",
  devServerAutoDetected: "local",
  cloudSyncWarningDismissed: "local",
  devServerLoadTimeout: "shareable",
  turbopackEnabled: "shareable",
  copyTreeSettings: "shareable",
  commandOverrides: "local",
  gitInitDefaults: "local",
  preferredEditor: "local",
  preferredImageViewer: "local",
  branchPrefixMode: "local",
  branchPrefixCustom: "local",
  forgeRemote: "local",
  githubRemote: "local",
  forgeProviderOverride: "local",
  worktreePathPattern: "shareable",
  fleetSavedScopes: "local",
  terminalSettings: "shareable",
  notificationOverrides: "local",
  resourceEnvironment: "local",
  resourceEnvironments: "local",
  activeResourceEnvironment: "local",
  defaultWorktreeMode: "local",
  browserAllowedHosts: "local",
  daintreeMcpTier: "local",
  exposeDaintreeMcpToAgents: "local",
} as const satisfies Record<keyof ProjectSettings, FieldShareability>;

/** Tier of Daintree MCP access exposed to agents in a project. */
export type DaintreeMcpTier = "off" | "workbench" | "action" | "system";

/** Resolve the legacy boolean field into the new tier enum. */
export function resolveDaintreeMcpTier(settings: {
  daintreeMcpTier?: DaintreeMcpTier;
  exposeDaintreeMcpToAgents?: boolean;
}): DaintreeMcpTier {
  const tier = settings.daintreeMcpTier;
  if (tier === "workbench" || tier === "action" || tier === "system") return tier;
  if (tier === "off") return "off";
  if (settings.exposeDaintreeMcpToAgents === true) return "workbench";
  return "off";
}
