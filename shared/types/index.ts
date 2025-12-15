/**
 * Shared types for Canopy Command Center
 *
 * This module provides a single source of truth for type definitions
 * used across the main process, renderer process, and preload script.
 *
 * Organization:
 * - domain.ts: Core business entities (Worktree, DevServer, Terminal, etc.)
 * - ipc.ts: IPC payloads and options (TerminalSpawnOptions, CopyTreeOptions, etc.)
 * - config.ts: Application configuration types (CanopyConfig, etc.)
 * - keymap.ts: Keyboard shortcut types (KeyAction, KeyMapConfig, etc.)
 */

// Domain types - core business entities
export type {
  // Git types
  GitStatus,
  FileChangeDetail,
  WorktreeChanges,
  // Worktree types
  WorktreeMood,
  Worktree,
  WorktreeState,
  // Notification types
  NotificationType,
  Notification,
  NotificationPayload,
  // Agent types
  AgentState,
  TaskState,
  RunRecord,
  LegacyAgentType,
  // Terminal types
  TerminalKind,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
  TerminalRestartError,
  TerminalInstance,
  PtySpawnOptions,
  TerminalDimensions,
} from "./domain.js";

// Export enums separately (not as types)
export { TerminalRefreshTier } from "./domain.js";

// Continue with domain type exports
export type {
  // Project types
  Project,
  TerminalSnapshot,
  TerminalLayout,
  ProjectState,
  // Recipe types
  RecipeTerminalType,
  RecipeTerminal,
  TerminalRecipe,
  // Project settings types
  RunCommand,
  ProjectSettings,
} from "./domain.js";

// IPC types - communication payloads
export type {
  // Terminal IPC types
  TerminalSpawnOptions,
  TerminalState,
  TerminalDataPayload,
  TerminalResizePayload,
  TerminalKillPayload,
  TerminalExitPayload,
  TerminalErrorPayload,
  BackendTerminalInfo,
  TerminalReconnectResult,
  // CopyTree IPC types
  CopyTreeOptions,
  CopyTreeGeneratePayload,
  CopyTreeGenerateAndCopyFilePayload,
  CopyTreeInjectPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeResult,
  CopyTreeProgress,
  FileTreeNode,
  // Worktree IPC types
  WorktreeRemovePayload,
  WorktreeSetActivePayload,
  WorktreeDeletePayload,
  // System IPC types
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  CliAvailability,
  // PR detection IPC types
  PRDetectedPayload,
  PRClearedPayload,
  // Project close IPC types
  ProjectCloseResult,
  ProjectStats,
  // GitHub IPC types
  RepositoryStats,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  // Hibernation types
  HibernationConfig,
  // System Sleep types
  SleepPeriod,
  SystemSleepMetrics,
  // App state types
  SavedRecipeTerminal,
  SavedRecipe,
  AppState,
  HydrateResult,
  // Log types
  LogLevel,
  LogEntry,
  LogFilterOptions,
  // Event inspector types
  EventCategory,
  EventPayload,
  EventRecord,
  EventFilterOptions,
  // Error types
  ErrorType,
  RetryAction,
  AppError,
  // Agent session types
  Artifact,
  // Agent state change
  AgentStateChangePayload,
  // Artifact types
  ArtifactDetectedPayload,
  SaveArtifactOptions,
  SaveArtifactResult,
  ApplyPatchOptions,
  ApplyPatchResult,
  // Git types
  GitGetFileDiffPayload,
  // File search types
  FileSearchPayload,
  FileSearchResult,
  // Electron API
  ElectronAPI,
  BranchInfo,
  CreateWorktreeOptions,
  // Adaptive backoff
  AdaptiveBackoffMetrics,
  // Terminal config
  TerminalConfig,
  // Worktree config
  WorktreeConfig,
  // IPC Contract Maps
  IpcInvokeMap,
  IpcEventMap,
  IpcInvokeArgs,
  IpcInvokeResult,
  IpcEventPayload,
} from "./ipc.js";

// Config types - application configuration
export type {
  // Terminal grid layout config
  TerminalLayoutStrategy,
  TerminalGridConfig,
  // Opener config
  OpenerConfig,
  OpenersConfig,
  // Quick links config
  QuickLink,
  QuickLinksConfig,
  // Monitor config
  MonitorConfig,
  // Note config
  NoteConfig,
  // Dev server config
  DevServerConfig,
  // UI config
  UIConfig,
  WorktreesConfig,
  GitDisplayConfig,
  // Main config
  CanopyConfig,
} from "./config.js";

// Keymap types - keyboard shortcuts
export type { KeyAction, KeymapPreset, KeyMapConfig } from "./keymap.js";

// Agent settings types - AI agent CLI configuration
export type { AgentSettingsEntry, AgentSettings } from "./agentSettings.js";

// Agent settings helpers
export {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_DANGEROUS_ARGS,
  getAgentSettingsEntry,
  generateAgentFlags,
} from "./agentSettings.js";

// Event types - event context for correlation
export type { EventContext } from "./events.js";

// Terminal activity types - semantic activity detection
export type {
  TerminalTaskType,
  TerminalActivityStatus,
  TerminalActivity,
  TerminalActivityPayload,
} from "./terminal.js";

// GitHub types - issues and pull requests
export type {
  GitHubUser,
  GitHubIssue,
  GitHubPR,
  GitHubListOptions,
  GitHubListResponse,
} from "./github.js";

// Pty Host types - IPC protocol for terminal management
export type {
  PtyHostSpawnOptions,
  PtyHostRequest,
  PtyHostEvent,
  PtyHostTerminalSnapshot,
  AgentSpawnedPayload,
  AgentOutputPayload,
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentKilledPayload,
  TerminalFlowStatus,
  TerminalStatusPayload,
} from "./pty-host.js";

// Sidecar types - browser dock
export type {
  SidecarLayoutMode,
  SidecarLayoutModePreference,
  SidecarLinkType,
  SidecarLink,
  LinkTemplate,
  SidecarTab,
  SidecarBounds,
  SidecarNavEvent,
  SidecarCreatePayload,
  SidecarShowPayload,
  SidecarCloseTabPayload,
  SidecarNavigatePayload,
} from "./sidecar.js";

export {
  LINK_TEMPLATES,
  DEFAULT_SIDECAR_TABS,
  SIDECAR_MIN_WIDTH,
  SIDECAR_MAX_WIDTH,
  SIDECAR_DEFAULT_WIDTH,
  MIN_GRID_WIDTH,
} from "./sidecar.js";

// Workspace Host types - IPC protocol for workspace management
export type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorkspaceClientConfig,
  WorktreeSnapshot,
  MonitorConfig as WorkspaceMonitorConfig,
  CreateWorktreeOptions as WorkspaceCreateWorktreeOptions,
  BranchInfo as WorkspaceBranchInfo,
} from "./workspace-host.js";

// Project Pulse types - activity heatmap and commit history
export type {
  PulseRangeDays,
  HeatLevel,
  HeatCell,
  CommitItem,
  BranchDeltaToMain,
  ProjectPulse,
  GetProjectPulseOptions,
} from "./pulse.js";

// Native menu types - renderer → main menu templates
export type { MenuItemOption, ShowContextMenuPayload } from "./menu.js";

// Slash command discovery
export type { SlashCommand, SlashCommandListRequest, SlashCommandScope } from "./slashCommands.js";
export { CLAUDE_BUILTIN_SLASH_COMMANDS } from "./slashCommands.js";
