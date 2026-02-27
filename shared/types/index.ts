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
  // Panel types (new architecture)
  BuiltInPanelKind,
  PanelKind,
  PanelLocation,
  PanelInstance,
  PanelSnapshot,
  BrowserHistory,
  // Tab group types
  TabGroupLocation,
  TabGroup,
  // Terminal types (deprecated aliases for backward compat)
  TerminalKind,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
  TerminalRestartError,
  TerminalReconnectError,
  TerminalRuntimeStatus,
  TerminalInstance,
  PtySpawnOptions,
  TerminalDimensions,
  DockMode,
  DockRenderState,
} from "./domain.js";

// Panel type guards
export { isBuiltInPanelKind, isPtyPanelKind } from "./domain.js";

// Export enums separately (not as types)
export { TerminalRefreshTier } from "./domain.js";

// Continue with domain type exports
export type {
  // Project types
  ProjectStatus,
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
  CopyTreeSettings,
  // Panel exit behavior
  PanelExitBehavior,
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
  CopyTreeCancelPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeTestConfigPayload,
  CopyTreeTestConfigResult,
  CopyTreeResult,
  CopyTreeProgress,
  FileTreeNode,
  // Worktree IPC types
  WorktreeRemovePayload,
  WorktreeSetActivePayload,
  WorktreeDeletePayload,
  IssueAssociation,
  AttachIssuePayload,
  DetachIssuePayload,
  // System IPC types
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  CliAvailability,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  // PR detection IPC types
  PRDetectedPayload,
  PRClearedPayload,
  // Issue detection IPC types
  IssueDetectedPayload,
  IssueNotFoundPayload,
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
  // Agent detection
  AgentDetectedPayload,
  AgentExitedPayload,
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
  // Panel grid layout config
  PanelLayoutStrategy,
  PanelGridConfig,
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
export type {
  AgentSettingsEntry,
  AgentSettings,
  GenerateAgentCommandOptions,
} from "./agentSettings.js";

// Agent settings helpers
export {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_DANGEROUS_ARGS,
  getAgentSettingsEntry,
  generateAgentFlags,
  generateAgentCommand,
} from "./agentSettings.js";

// User agent registry types - user-defined agent configuration
export type { UserAgentConfig, UserAgentRegistry } from "./userAgentRegistry.js";
export { UserAgentConfigSchema, UserAgentRegistrySchema } from "./userAgentRegistry.js";

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
  SpawnResult,
  SpawnError,
  SpawnErrorCode,
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
export {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  GEMINI_BUILTIN_SLASH_COMMANDS,
  CODEX_BUILTIN_SLASH_COMMANDS,
} from "./slashCommands.js";

// Action system types - unified action dispatch and introspection
export type {
  ActionSource,
  ActionKind,
  ActionDanger,
  ActionScope,
  ActionId,
  ActionContext,
  ActionDefinition,
  ActionManifestEntry,
  ActionDispatchSuccess,
  ActionDispatchError,
  ActionDispatchResult,
  ActionErrorCode,
  ActionError,
  ActionDispatchOptions,
  ActionDispatchPayload,
} from "./actions.js";

// Command system types - global command registry and execution
export type {
  CommandCategory,
  CommandArgumentType,
  CommandArgument,
  CommandContext,
  CommandResult,
  BuilderFieldType,
  BuilderFieldValidation,
  BuilderField,
  BuilderStep,
  CanopyCommand,
  CommandManifestEntry,
  CommandExecutePayload,
  CommandGetPayload,
} from "./commands.js";

// App Agent types - AI configuration
export type { AppAgentProvider, AppAgentConfig } from "./appAgent.js";

export {
  AppAgentProviderSchema,
  AppAgentConfigSchema,
  DEFAULT_APP_AGENT_CONFIG,
} from "./appAgent.js";

// Assistant types - AI assistant panel
export type {
  AssistantMessageRole,
  AssistantMessage,
  ToolCall,
  ToolResult,
  StreamChunkType,
  StreamChunk,
  SendMessageRequest,
  AssistantChunkPayload,
} from "./assistant.js";

export { AssistantMessageSchema, StreamChunkSchema, ASSISTANT_MODELS } from "./assistant.js";

// Listener types - assistant event subscription management
export type { Listener, ListenerFilter, RegisterListenerOptions } from "./listener.js";
export { ListenerSchema, ListenerFilterSchema, RegisterListenerOptionsSchema } from "./listener.js";

// Agent Capabilities types - query agent registry and metadata
export type { AgentRegistry, AgentMetadata } from "./ipc/agentCapabilities.js";

// Task Queue types - DAG-based task management
export type {
  TaskResult,
  TaskRecord,
  CreateTaskParams,
  TaskFilter,
  DagValidationResult,
  TaskStateChangePayload,
} from "./task.js";

// Workflow types - declarative workflow definitions
export type {
  WorkflowConditionOp,
  WorkflowCondition,
  WorkflowNodeType,
  WorkflowActionConfig,
  WorkflowNode,
  WorkflowDefinition,
  WorkflowValidationResult,
  WorkflowValidationError,
  LoadedWorkflow,
  WorkflowSource,
  WorkflowSummary,
} from "./workflow.js";

export {
  WorkflowConditionOpSchema,
  WorkflowConditionSchema,
  WorkflowNodeTypeSchema,
  WorkflowActionConfigSchema,
  WorkflowNodeSchema,
  WorkflowDefinitionSchema,
} from "./workflow.js";

// Workflow Run types - runtime execution state
export type {
  WorkflowRunStatus,
  NodeState,
  EvaluatedCondition,
  WorkflowRun,
} from "./workflowRun.js";
