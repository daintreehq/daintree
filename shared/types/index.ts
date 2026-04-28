/**
 * Shared types for Daintree
 *
 * This module provides a single source of truth for type definitions
 * used across the main process, renderer process, and preload script.
 */

// Git types
export type {
  GitStatus,
  FileChangeDetail,
  WorktreeChanges,
  StagingFileEntry,
  StagingStatus,
  RepoState,
  ConflictXYCode,
  ConflictedFileEntry,
} from "./git.js";

// Worktree types
export type {
  WorktreeMood,
  WorktreeLifecyclePhase,
  WorktreeLifecycleState,
  WorktreeLifecycleStatus,
  Worktree,
  WorktreeState,
} from "./worktree.js";

// Notification types
export type { NotificationType, Notification, NotificationPayload } from "./notification.js";

// Agent types
export type { AgentState, TaskState, RunRecord, AgentStateChangeTrigger } from "./agent.js";

// Panel types
export type {
  BuiltInPanelKind,
  PanelKind,
  PanelLocation,
  PanelInstance,
  TabGroupLocation,
  TabGroup,
  PanelTitleMode,
  TerminalRestartError,
  TerminalReconnectError,
  TerminalRuntimeStatus,
  TerminalSpawnSource,
  TerminalInstance,
  PtySpawnOptions,
  TerminalDimensions,
  DockMode,
  DockRenderState,
  PanelExitBehavior,
  ViewportPresetId,
} from "./panel.js";

// Panel type guards and enums (value exports)
export { isBuiltInPanelKind, isPtyPanelKind, TerminalRefreshTier } from "./panel.js";

// Panel creation options (discriminated union)
export type {
  AddPanelOptionsBase,
  TerminalPanelOptions,
  BrowserPanelOptions,
  DevPreviewPanelOptions,
  ExtensionPanelOptions,
  AddPanelOptions,
} from "./addPanelOptions.js";

// Browser types
export type { BrowserHistory } from "./browser.js";

// Project types
export type {
  ProjectStatus,
  Project,
  TerminalSnapshot,
  PanelSnapshot,
  TerminalLayout,
  ProjectState,
  RecipeTerminalType,
  RecipeTerminal,
  TerminalRecipe,
  RunCommand,
  ProjectSettings,
  ProjectTerminalSettings,
  CopyTreeSettings,
} from "./project.js";

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
  SemanticSearchMatch,
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
  AppMetricsSummary,
  AgentAvailabilityState,
  CliAvailability,
  AgentCliDetail,
  AgentCliDetails,
  AgentCliProbeSource,
  AgentCliBlockReason,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  PrerequisiteSpec,
  PrerequisiteSeverity,
  PrerequisiteCheckResult,
  SystemHealthCheckResult,
  // PR detection IPC types
  PRDetectedPayload,
  PRClearedPayload,
  // Issue detection IPC types
  IssueDetectedPayload,
  IssueNotFoundPayload,
  // Project close IPC types
  ProjectCloseResult,
  ProjectStats,
  BulkProjectStatsEntry,
  BulkProjectStats,
  ProjectStatusEntry,
  ProjectStatusMap,
  // GitHub IPC types
  RepositoryStats,
  ProjectHealthData,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  GitHubRateLimitPayload,
  GitHubRateLimitKind,
  GitHubTokenHealthPayload,
  GitHubTokenHealthStatus,
  // Hibernation types
  HibernationConfig,
  HibernationProjectHibernatedPayload,
  // Idle terminal notification types
  IdleTerminalNotifyConfig,
  IdleTerminalNotifyPayload,
  IdleTerminalProjectEntry,
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
  RetryProgressPayload,
  // Agent session types
  Artifact,
  // Agent state change
  AgentStateChangePayload,
  // Agent detection
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
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
  FileReadPayload,
  FileReadResult,
  FileReadErrorCode,
  // Electron API
  ElectronAPI,
  NotificationSettings,
  VoiceInputSettings,
  VoiceInputStatus,
  VoiceTranscriptionModel,
  VoiceCorrectionModel,
  VoiceParagraphingStrategy,
  MicPermissionStatus,
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
  IpcEventBusMap,
  EventBusEnvelope,
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
  DaintreeConfig,
} from "./config.js";

// Keymap types - keyboard shortcuts
export type { BuiltInKeyAction, KeyAction, KeymapPreset, KeyMapConfig } from "./keymap.js";

// Agent settings types - AI agent CLI configuration
export type {
  AgentSettingsEntry,
  AgentSettings,
  GenerateAgentCommandOptions,
  GenerateAgentFlagsOptions,
} from "./agentSettings.js";

// Agent settings helpers
export {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_DANGEROUS_ARGS,
  getAgentSettingsEntry,
  resolveEffectivePresetId,
  generateAgentFlags,
  generateAgentCommand,
  buildAgentLaunchFlags,
  buildResumeCommand,
  buildLaunchCommandFromFlags,
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
  AgentKilledPayload,
  TerminalFlowStatus,
  TerminalStatusPayload,
  BroadcastWriteTargetResult,
  BroadcastWriteResultPayload,
  SpawnResult,
  SpawnError,
  SpawnErrorCode,
} from "./pty-host.js";

// Portal types - browser dock
export type {
  PortalLinkType,
  PortalLink,
  LinkTemplate,
  PortalTab,
  PortalBounds,
  PortalNavEvent,
  PortalCreatePayload,
  PortalShowPayload,
  PortalCloseTabPayload,
  PortalNavigatePayload,
} from "./portal.js";

export {
  LINK_TEMPLATES,
  DEFAULT_SYSTEM_LINKS,
  DEFAULT_PORTAL_TABS,
  PORTAL_MIN_WIDTH,
  PORTAL_MAX_WIDTH,
  PORTAL_DEFAULT_WIDTH,
} from "./portal.js";

// Voice types - canonical phase model for voice session and transcript lifecycle
export type { VoiceTranscriptPhase } from "./voice.js";
export { isActiveVoiceSession } from "./voice.js";

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

// Worktree Port RPC protocol - typed request/response for the dedicated MessagePort
export type {
  WorktreePortProtocol,
  WorktreePortAction,
  WorktreePortPayload,
  WorktreePortResult,
  WorktreePortRequest,
  WorktreePortRequestArgs,
  WorktreePortResourceAction,
} from "./worktree-port.js";

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
export type {
  SlashCommand,
  SlashCommandListRequest,
  SlashCommandScope,
  BuiltinSlashCommandEntry,
} from "./slashCommands.js";
export { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "./slashCommands.js";

// Action system types - unified action dispatch and introspection
export type {
  ActionSource,
  ActionKind,
  ActionDanger,
  ActionScope,
  BuiltInActionId,
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
  DaintreeCommand,
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

// Agent Capabilities types - query agent registry and metadata
export type { AgentRegistry, AgentMetadata } from "./ipc/agentCapabilities.js";

// Onboarding types
export type {
  OnboardingState,
  ChecklistState,
  ChecklistItems,
  ChecklistItemId,
} from "./ipc/maps.js";

// Task Queue types - DAG-based task management
export type {
  TaskResult,
  TaskRecord,
  CreateTaskParams,
  TaskFilter,
  DagValidationResult,
  TaskStateChangePayload,
} from "./task.js";

// Editor integration types - external editor configuration and discovery
export type {
  KnownEditorId,
  EditorConfig,
  DiscoveredEditor,
  EditorSetConfigPayload,
  EditorGetConfigResult,
} from "./editor.js";

// App theme types - app-wide color scheme system
export type {
  AppColorSchemeTokens,
  AppColorScheme,
  AppThemeConfig,
  ColorVisionMode,
} from "./appTheme.js";

// Telemetry preview types — session-scoped payload mirror
export type {
  SanitizedTelemetryEvent,
  SanitizedTelemetryEventKind,
  SanitizedSentryEvent,
  SanitizedAnalyticsEvent,
  TelemetryPreviewState,
} from "./ipc/telemetryPreview.js";
