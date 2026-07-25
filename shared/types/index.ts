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
  RebaseAction,
  RebaseEntryState,
  RebaseEntry,
  RebaseSequence,
} from "./git.js";

// Worktree types
export type {
  WorktreeMood,
  WorktreeLifecyclePhase,
  WorktreeLifecycleState,
  WorktreeLifecycleStatus,
  Worktree,
  WorktreeState,
  WslGitEligibility,
} from "./worktree.js";

// Notification types
export type { NotificationType, Notification, NotificationPayload } from "./notification.js";

// Agent types
export type { AgentState, AgentStateChangeTrigger, WaitingReason } from "./agent.js";
export type { TerminalCheckResult } from "./checkResult.js";

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
  TerminalScrollbackRestoreError,
  TerminalRuntimeStatus,
  PersistableFlowStatus,
  FutureSABFlowStatus,
  TerminalSpawnSource,
  AddPanelFocusPolicy,
  TerminalInstance,
  PtySpawnOptions,
  TerminalDimensions,
  DockMode,
  DockRenderState,
  PanelExitBehavior,
  ViewportPresetId,
} from "./panel.js";

// Panel type guards and enums (value exports)
export { isBuiltInPanelKind, TerminalRefreshTier } from "./panel.js";

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
export { isGitBackedProject } from "./project.js";
export type {
  ProjectStatus,
  Project,
  ProjectAddOptions,
  ProjectCreationIdentity,
  ProjectRepoStats,
  TerminalSnapshot,
  PanelSnapshot,
  TerminalLayout,
  ProjectState,
  RecipeTerminalType,
  RecipeTerminal,
  TerminalRecipe,
  RecipeNameCollision,
  RunCommand,
  ProjectSettings,
  ProjectTerminalSettings,
  CopyTreeSettings,
  FleetSavedScope,
  SnapshotFleetSavedScope,
  PredicateFleetSavedScope,
} from "./project.js";

// Scratch types
export type { Scratch } from "./scratch.js";

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
  TerminalInfoPayload,
  SemanticSearchMatch,
  // CopyTree IPC types
  CopyTreeOptions,
  CopyTreeGeneratePayload,
  CopyTreeGenerateAndCopyFilePayload,
  CopyTreeInjectPayload,
  CopyTreeCancelPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeTestConfigOptions,
  CopyTreeTestConfigPayload,
  CopyTreeTestConfigResult,
  CopyTreeResult,
  CopyTreeProgress,
  CopyTreeExclusionReason,
  CopyTreeExclusionSummary,
  CopyTreeBudgetStats,
  CopyTreeTruncatedBy,
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
  ProjectFreeMemoryResult,
  ProjectStats,
  BulkProjectStatsEntry,
  BulkProjectStats,
  ProjectStatusEntry,
  ProjectStatusMap,
  ForgeRateLimitKind,
  ForgeRateLimitChangedPayload,
  ForgeTokenHealthChangedPayload,
  // Per-service connectivity types
  ConnectivityServiceKey,
  ServiceConnectivityStatus,
  ServiceConnectivityPayload,
  ServiceConnectivitySnapshot,
  // Hibernation types
  HibernationConfig,
  HibernationProjectHibernatedPayload,
  // Idle terminal notification types
  IdleTerminalNotifyConfig,
  IdleTerminalNotifyPayload,
  IdleTerminalProjectEntry,
  // Idle background-project auto-close types
  IdleBackgroundAutoCloseConfig,
  IdleBackgroundClosedPayload,
  IdleBackgroundClosedProjectEntry,
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
  ErrorRecord,
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
  PushProgressEvent,
  // File search types
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
  FileReadErrorCode,
  // Diff media (image compare) types
  DiffMediaReadFileVersionsPayload,
  DiffMediaSide,
  DiffMediaSideError,
  DiffMediaFileVersions,
  // Electron API
  ElectronAPI,
  NotificationSettings,
  VoiceInputSettings,
  SuggestedDictionaryEntry,
  VoiceInputStatus,
  VoiceTranscriptionModel,
  VoiceTranscriptionProvider,
  VoiceCorrectionModel,
  VoiceParagraphingStrategy,
  VoiceRecordingMode,
  HelpAssistantSettings,
  HelpAssistantAuditRetention,
  HelpAssistantIdleHibernateMinutes,
  HelpSessionLiveStatus,
  HelpSessionActiveGrant,
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
  DangerousMode,
  InlineMode,
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
  buildResumeLatestCommand,
  buildLaunchCommandFromFlags,
  isAgentBypassSupported,
  resolveEffectiveBypass,
  resolveDangerousMode,
  combineDangerousModes,
  reconcileBypassFlags,
  resolveInlineMode,
  combineInlineModes,
  resolveEffectiveInlineMode,
  reconcileInlineModeFlag,
} from "./agentSettings.js";

// User agent registry types - user-defined agent configuration
export type { UserAgentConfig, UserAgentRegistry } from "./userAgentRegistry.js";
export {
  UserAgentConfigSchema,
  UserAgentRegistrySchema,
  SAFE_AGENT_ID_PATTERN,
} from "./userAgentRegistry.js";

// Per-service connectivity helpers
export { CONNECTIVITY_SERVICE_KEYS } from "./ipc/connectivity.js";

// Diff media helpers
export { DIFF_MEDIA_MAX_BYTES } from "./ipc/diffMedia.js";

// MCP server audit log + runtime state + turn outcomes
export type {
  McpActiveClientInfo,
  McpAuditRecord,
  McpAuditResult,
  McpAuditStats,
  McpAuditSeverity,
  McpConfirmationDecision,
  McpGrantRecord,
  McpGrantRecordType,
  McpGrantRevokedReason,
  McpLogRecord,
  AssistantTurnRecord,
  TurnOutcomeClass,
  McpAnomalySeverity,
  McpAnomalyKind,
  McpAnomalySignal,
  McpRuntimeSnapshot,
  McpRuntimeState,
  ActiveBearerRecord,
  HelpSessionBearerRecord,
  DisconnectBearerResult,
} from "./ipc/mcpServer.js";
export {
  MCP_AUDIT_MIN_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  isAuditRecord,
  isGrantRecord,
} from "./ipc/mcpServer.js";
export type {
  PluginActionAuditRecord,
  PluginActionAuditRecordType,
  PluginActionAuditResult,
  PluginAuditConfig,
} from "./ipc/pluginAudit.js";
export {
  PLUGIN_AUDIT_SCHEMA_VERSION,
  PLUGIN_AUDIT_MIN_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
} from "./ipc/pluginAudit.js";

// Run history types - durable recipe/fleet automation outcomes (#9949)
export type {
  RunHistoryRecord,
  RecipeRunHistoryRecord,
  FleetRunHistoryRecord,
  RunHistoryTargetOutcome,
  RunHistoryAppendInput,
} from "./ipc/runHistory.js";
export {
  RUN_HISTORY_SCHEMA_VERSION,
  RUN_HISTORY_DEFAULT_MAX_RECORDS,
  RUN_HISTORY_REASON_MAX_LENGTH,
  RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH,
  RUN_HISTORY_TITLE_MAX_LENGTH,
  RUN_HISTORY_MAX_TARGETS,
} from "./ipc/runHistory.js";

// Event types - event context for correlation
export type { EventContext } from "./events.js";

// Terminal activity types - semantic activity detection
export type {
  TerminalTaskType,
  TerminalActivityStatus,
  TerminalActivity,
  TerminalActivityPayload,
} from "./terminal.js";

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
  PORTAL_MIN_EDITOR_WIDTH,
} from "./portal.js";

// Voice types - canonical phase model for voice session and transcript lifecycle
export type { VoiceInputError, VoiceInputErrorSeverity, VoiceTranscriptPhase } from "./voice.js";
export { isActiveVoiceSession } from "./voice.js";

// Workspace Host types - IPC protocol for workspace management
export type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorkspaceClientConfig,
  WorktreeSnapshot,
  WorktreeEventVersion,
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

// Declarative agent completion-source schema (discovery engine input)
export type {
  CompletionTrigger,
  CompletionKind,
  CompletionParserName,
  CompletionPlatform,
  CompletionEnvName,
  CompletionConcreteBase,
  CompletionBaseDir,
  CompletionLocation,
  CompletionDerivation,
  CompletionStaticDiscovery,
  CompletionDirectoryDiscovery,
  CompletionDiscovery,
  CompletionSourceConfig,
} from "./completionSources.js";

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
  HelpAssistantTier,
} from "./ipc/maps.js";

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

// Forge provider types — plugin-contributed forge integrations
export type {
  ForgeProviderContribution,
  ForgeProviderDescriptor,
  ForgeProviderEntry,
  ForgeProviderResolutionVia,
  ForgeCapabilityHint,
  ResolvedForgeProvider,
  CredentialField,
  CredentialFieldType,
} from "./forge.js";
