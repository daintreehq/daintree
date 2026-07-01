import type { PushProgressEvent } from "./gitPush.js";
import type { GitStatus, StagingStatus } from "../git.js";
import type { SnapshotInfo, SnapshotRevertResult } from "./git.js";
import type { AgentId } from "../agent.js";
import type { TabGroup } from "../panel.js";
import type { WorktreeState } from "../worktree.js";
import type {
  Project,
  ProjectSettings,
  RecipeNameCollision,
  RunCommand,
  TerminalRecipe,
  TerminalSnapshot,
} from "../project.js";
import type { ChecklistState, HelpAssistantTier, IpcEventBusMap, IpcInvokeMap } from "./maps.js";
import type { GeneratedElectronAPI } from "./generated-api.js";
import type { AgentSettings, AgentSettingsEntry } from "../agentSettings.js";
import type { AgentPreset } from "../../config/agentRegistry.js";
import type { VoiceInputError, VoiceInputStatus } from "../voice.js";
export type { VoiceInputError, VoiceInputStatus };
import type {
  AuthValidation,
  ForgeProviderEntry,
  ResolvedForgeProvider,
  PushErrorClassification,
  Issue,
  PR,
  Page,
  RepoMetadata,
  ListOptions,
  ForgeUser,
  ForgeLabel,
  IssueComment,
  CreateIssueInput,
  EditIssueInput,
  IssueCloseReason,
  ReviewThread,
  ForgeTokenHealthState,
  RateLimitDetails,
} from "../forge.js";
import type { ResourceProfilePayload } from "../resourceProfile.js";
import type {
  CreateWorktreeOptions,
  BranchInfo,
  WorktreeConfig,
  AttachIssuePayload,
  IssueAssociation,
} from "./worktree.js";
import type {
  WorktreePortAction,
  WorktreePortRequestArgs,
  WorktreePortResult,
} from "../worktree-port.js";
import type {
  TerminalSpawnOptions,
  TerminalReconnectResult,
  BackendTerminalInfo,
  TerminalInfoPayload,
  TerminalActivityPayload,
  SemanticSearchMatch,
} from "./terminal.js";
import type { AppVersionInfo } from "./app.js";
import type {
  SaveArtifactOptions,
  SaveArtifactResult,
  ApplyPatchOptions,
  ApplyPatchResult,
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  ArtifactDetectedPayload,
  AgentHelpRequest,
  AgentHelpResult,
} from "./agent.js";
import type { AgentSessionRecord, AgentSessionRetentionDays } from "./agentSessionHistory.js";
import type {
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
  DemoAnnotateResult,
  DemoAnnotationPlacement,
  DemoAnnotationSize,
  DemoTerminalKey,
} from "./demo.js";
import type {
  CopyTreeResult,
  CopyTreeOptions,
  CopyTreeTestConfigOptions,
  FileTreeNode,
  CopyTreeProgress,
} from "./copyTree.js";
import type {
  SystemWakePayload,
  SystemOpenInEditorPayload,
  CliAvailability,
  AgentCliDetails,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  SystemHealthCheckResult,
  PrerequisiteSpec,
  PrerequisiteCheckResult,
} from "./system.js";
import type { AppState, BootResult, HydrateResult } from "./app.js";
import type { LogEntry, LogFilterOptions } from "./logs.js";
import type { RetryAction, ErrorRecord, RetryProgressPayload } from "./errors.js";
import type { EventRecord } from "./events.js";
import type {
  ProjectCloseResult,
  ProjectFreeMemoryResult,
  ProjectStats,
  ProjectStatusMap,
  BulkProjectStats,
  ProjectSwitchOutgoingState,
} from "./project.js";
import type { GitInitOptions, GitInitProgressEvent, GitInitResult } from "./gitInit.js";
import type { CloneRepoOptions, CloneRepoResult, CloneRepoProgressEvent } from "./gitClone.js";
import type {
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
  ForgeRepositoryStats,
  ForgeRepoStatsAndPagePayload,
  ForgeRepoCountsUpdatedPayload,
  ForgeFirstPageCachePayload,
  ForgeProjectHealthPayload,
} from "./forge.js";
import type { TerminalConfig } from "./config.js";
import type { HibernationProjectHibernatedPayload } from "./hibernation.js";
import type { IdleTerminalNotifyPayload } from "./idleTerminals.js";
import type { IdleBackgroundClosedPayload } from "./idleBackgroundAutoClose.js";
import type { KeyAction } from "../keymap.js";

export interface KeybindingImportResult {
  ok: boolean;
  overrides: Record<string, string[]>;
  applied: number;
  skipped: number;
  errors: string[];
}
import type {
  TerminalStatusPayload,
  PtyHostActivityTier,
  SpawnResult,
  TerminalResourceBatchPayload,
  BroadcastWriteResultPayload,
  FdLeakWarningPayload,
  TerminalReliabilityMetricPayload,
} from "../pty-host.js";
import type {
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
} from "./files.js";
import type { DevPreviewStateChangedPayload, DevPreviewAllSessionsPayload } from "./devPreview.js";
import type { AppAgentConfig } from "../appAgent.js";
import type { ActionContext } from "../actions.js";
import type { AppThemeConfig } from "../appTheme.js";
import type { SanitizedTelemetryEvent, TelemetryPreviewState } from "./telemetryPreview.js";

export interface NotificationSettings {
  enabled: boolean;
  completedEnabled: boolean;
  waitingEnabled: boolean;
  soundEnabled: boolean;
  completedSoundFile: string;
  waitingSoundFile: string;
  escalationSoundFile: string;
  waitingEscalationEnabled: boolean;
  waitingEscalationDelayMs: number;
  workingPulseEnabled: boolean;
  workingPulseSoundFile: string;
  uiFeedbackSoundEnabled: boolean;
  /** When true, non-urgent notifications are suppressed during the scheduled window. */
  quietHoursEnabled: boolean;
  /** Start of the quiet window, minutes since local midnight (0-1439). */
  quietHoursStartMin: number;
  /** End of the quiet window, minutes since local midnight (0-1439). Start === End disables. */
  quietHoursEndMin: number;
  /** Days the schedule applies to, 0 (Sun) - 6 (Sat). Empty array means every day. */
  quietHoursWeekdays: number[];
  /** When true, the bell drawer groups entries by worktree/project context. */
  groupByContext?: boolean;
}

// ElectronAPI Type (exposed via preload)

/**
 * Complete Electron API exposed to renderer.
 *
 * Namespaces backed by `defineIpcNamespace` + a `*.preload.ts` shim are
 * generated into `GeneratedElectronAPI` by `scripts/codegen/ipc-renderer.mjs`.
 * Hand-maintained entries below either layer event listeners and other non-
 * invoke methods on top of a generated namespace (intersected with
 * `GeneratedElectronAPI[<ns>]`) or cover namespaces that are not generated
 * (legacy `ipcMain.handle` registrations, variadic plugin invocations, the
 * positional-arg `demo` namespace, etc.).
 */
export interface ElectronAPI extends GeneratedElectronAPI {
  worktree: {
    getAll(): Promise<WorktreeState[]>;
    refresh(worktreeId?: string): Promise<void>;
    refreshPullRequests(): Promise<void>;
    getPRStatus(): Promise<import("../workspace-host.js").PRServiceStatus | null>;
    setActive(worktreeId: string): Promise<void>;
    create(options: CreateWorktreeOptions, rootPath: string): Promise<string>;
    listBranches(rootPath: string): Promise<BranchInfo[]>;
    fetchPRBranch(rootPath: string, prNumber: number, headRefName: string): Promise<void>;
    getRecentBranches(rootPath: string): Promise<string[]>;
    getDefaultPath(rootPath: string, branchName: string): Promise<string>;
    getAvailableBranch(rootPath: string, branchName: string): Promise<string>;
    delete(worktreeId: string, force?: boolean, deleteBranch?: boolean): Promise<void>;
    attachIssue(payload: AttachIssuePayload): Promise<void>;
    detachIssue(worktreeId: string): Promise<void>;
    getAllIssueAssociations(): Promise<Record<string, IssueAssociation>>;
    restartService(): Promise<void>;
    retryProjectLoad(): Promise<void>;
    retryAuthFetch(): Promise<void>;
    onRemove(callback: (data: { worktreeId: string }) => void): () => void;
    onActivated(callback: (data: { worktreeId: string }) => void): () => void;
  };
  worktreePort: {
    request<K extends WorktreePortAction>(
      action: K,
      ...args: WorktreePortRequestArgs<K>
    ): Promise<WorktreePortResult<K>>;
    onEvent(type: string, callback: (data: unknown) => void): () => void;
    isReady(): boolean;
    onReady(callback: () => void): () => void;
    onDisconnected(callback: () => void): () => void;
    onFatalDisconnect(callback: () => void): () => void;
  };
  terminal: {
    spawn(options: TerminalSpawnOptions): Promise<string>;
    write(id: string, data: string): void;
    submit(id: string, text: string): Promise<void>;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    gracefulKill(id: string): Promise<string | null>;
    trash(id: string): Promise<void>;
    restore(id: string): Promise<boolean>;
    setActivityTier(id: string, tier: PtyHostActivityTier, pollingIntervalMs?: number): void;
    acknowledgeData(id: string, length: number): void;
    getForProject(projectId: string): Promise<BackendTerminalInfo[]>;
    getAvailableTerminals(): Promise<BackendTerminalInfo[]>;
    getTerminalsByState(state: import("../agent.js").AgentState): Promise<BackendTerminalInfo[]>;
    getAllTerminals(): Promise<BackendTerminalInfo[]>;
    searchSemanticBuffers(query: string, isRegex: boolean): Promise<SemanticSearchMatch[]>;
    reconnect(terminalId: string): Promise<TerminalReconnectResult>;
    reconnectBulk(terminalIds: string[]): Promise<Record<string, TerminalReconnectResult>>;
    replayHistory(terminalId: string, maxLines?: number): Promise<{ replayed: number }>;
    getSerializedState(terminalId: string): Promise<string | null>;
    getSerializedStates(terminalIds: string[]): Promise<Record<string, string | null>>;
    getSharedBuffers(): Promise<{
      visualBuffers: SharedArrayBuffer[];
      signalBuffer: SharedArrayBuffer | null;
    }>;
    getAnalysisBuffer(): Promise<SharedArrayBuffer | null>;
    getInfo(id: string): Promise<TerminalInfoPayload>;
    onData(id: string, callback: (data: string | Uint8Array) => void): () => void;
    onExit(callback: (id: string, exitCode: number) => void): () => void;
    onAgentStateChanged(callback: (data: AgentStateChangePayload) => void): () => void;
    onAgentDetected(callback: (data: AgentDetectedPayload) => void): () => void;
    onAgentExited(callback: (data: AgentExitedPayload) => void): () => void;
    onFallbackTriggered(callback: (data: AgentFallbackTriggeredPayload) => void): () => void;
    onAllAgentsClear(callback: (data: { timestamp: number }) => void): () => void;
    onActivity(callback: (data: TerminalActivityPayload) => void): () => void;
    onTrashed(callback: (data: { id: string; expiresAt: number }) => void): () => void;
    onRestored(callback: (data: { id: string }) => void): () => void;
    forceResume(id: string): Promise<void>;
    onStatus(callback: (data: TerminalStatusPayload) => void): () => void;
    onReliabilityMetric(callback: (data: TerminalReliabilityMetricPayload) => void): () => void;
    onResourceMetrics(
      callback: (data: { metrics: TerminalResourceBatchPayload; timestamp: number }) => void
    ): () => void;
    onFdLeakWarning(callback: (data: FdLeakWarningPayload) => void): () => void;
    onBackendCrashed(
      callback: (data: {
        crashType: string;
        code: number | null;
        signal: string | null;
        timestamp: number;
      }) => void
    ): () => void;
    onBackendRecovering(
      callback: (data: {
        crashType: string;
        code: number | null;
        signal: string | null;
        timestamp: number;
      }) => void
    ): () => void;
    onBackendReady(callback: () => void): () => void;
    sendKey(id: string, key: string): void;
    batchDoubleEscape(ids: string[]): void;
    broadcastWrite(ids: string[], data: string): void;
    onBroadcastWriteResult(callback: (data: BroadcastWriteResultPayload) => void): () => void;
    reportTitleState(id: string, state: "working" | "waiting"): void;
    updateObservedTitle(id: string, title: string): void;
    onSpawnResult(callback: (id: string, result: SpawnResult) => void): () => void;
    onReduceScrollback(
      callback: (data: { terminalIds: string[]; targetLines: number }) => void
    ): () => void;
    onRestoreScrollback(callback: (data: { terminalIds: string[] }) => void): () => void;
    restartService(): Promise<void>;
    onReclaimMemory(callback: () => void): () => void;
  };
  files: {
    search(payload: FileSearchPayload): Promise<FileSearchResult>;
    read(payload: FileReadPayload): Promise<FileReadResult>;
  };
  watchdog: {
    restart(): Promise<void>;
    onDisabled(
      callback: (data: {
        attemptCount: number;
        lastExitCode: number | null;
        timestamp: number;
      }) => void
    ): () => void;
    onActive(callback: () => void): () => void;
  };
  // slashCommands is generated — see GeneratedElectronAPI.
  artifact: {
    onDetected(callback: (data: ArtifactDetectedPayload) => void): () => void;
    saveToFile(options: SaveArtifactOptions): Promise<SaveArtifactResult | null>;
    applyPatch(options: ApplyPatchOptions): Promise<ApplyPatchResult>;
  };
  copyTree: {
    generate(worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult>;
    generateAndCopyFile(worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult>;
    injectToTerminal(
      terminalId: string,
      worktreeId: string,
      options?: CopyTreeOptions,
      injectionId?: string
    ): Promise<CopyTreeResult>;
    isAvailable(): Promise<boolean>;
    cancel(injectionId?: string): Promise<void>;
    getFileTree(worktreeId: string, dirPath?: string): Promise<FileTreeNode[]>;
    testConfig(
      worktreeId: string,
      options?: CopyTreeTestConfigOptions
    ): Promise<import("./copyTree.js").CopyTreeTestConfigResult>;
    onProgress(callback: (progress: CopyTreeProgress) => void): () => void;
  };
  editor: {
    getConfig(projectId?: string): Promise<import("../editor.js").EditorGetConfigResult>;
    setConfig(payload: import("../editor.js").EditorSetConfigPayload): Promise<void>;
    discover(): Promise<import("../editor.js").DiscoveredEditor[]>;
  };
  // getResourceProfile comes from GeneratedElectronAPI; the rest are legacy
  // typedHandle registrations plus event listeners.
  system: GeneratedElectronAPI["system"] & {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    openInEditor(payload: SystemOpenInEditorPayload & { projectId?: string }): Promise<void>;
    checkCommand(command: string): Promise<boolean>;
    checkDirectory(path: string): Promise<boolean>;
    getHomeDir(): Promise<string>;
    getTmpDir(): Promise<string>;
    getCliAvailability(): Promise<CliAvailability>;
    refreshCliAvailability(): Promise<CliAvailability>;
    getAgentCliDetails(): Promise<AgentCliDetails>;
    getAgentVersions(): Promise<AgentVersionInfo[]>;
    getAgentVersion(agentId: string, refresh?: boolean): Promise<AgentVersionInfo>;
    refreshAgentVersions(): Promise<AgentVersionInfo[]>;
    getAgentUpdateSettings(): Promise<AgentUpdateSettings>;
    setAgentUpdateSettings(settings: AgentUpdateSettings): Promise<void>;
    startAgentUpdate(payload: StartAgentUpdatePayload): Promise<StartAgentUpdateResult>;
    healthCheck(agentIds?: string[]): Promise<SystemHealthCheckResult>;
    getHealthCheckSpecs(agentIds?: string[]): Promise<PrerequisiteSpec[]>;
    checkTool(spec: PrerequisiteSpec): Promise<PrerequisiteCheckResult>;
    downloadDiagnostics(): Promise<boolean>;
    collectDiagnosticsForReview(): Promise<import("./system.js").DiagnosticsReviewPayload>;
    saveDiagnosticsBundle(
      payload: import("./system.js").DiagnosticsBundleSavePayload
    ): Promise<boolean>;
    getAppMetrics(): Promise<import("./system.js").AppMetricsSummary>;
    getHardwareInfo(): Promise<import("./system.js").HardwareInfo>;
    getProcessMetrics(): Promise<import("./system.js").ProcessMetricEntry[]>;
    getHeapStats(): Promise<import("./system.js").HeapStats>;
    getDiagnosticsInfo(): Promise<import("./system.js").DiagnosticsInfo>;
    getReportEnrichment(): Promise<import("./system.js").ReportIssueEnrichment>;
    startRendererCpuProfile(): Promise<import("./system.js").RendererCpuProfileStartResult>;
    stopRendererCpuProfile(): Promise<import("./system.js").RendererCpuProfileStopResult>;
    installAgent(payload: {
      agentId: string;
      methodIndex?: number;
      jobId: string;
    }): Promise<import("./system.js").AgentInstallResult>;
    onAgentInstallProgress(
      callback: (event: import("./system.js").AgentInstallProgressEvent) => void
    ): () => void;
    onWake(callback: (data: SystemWakePayload) => void): () => void;
    onResourceProfileChanged(callback: (payload: ResourceProfilePayload) => void): () => void;
  };
  app: {
    getState(): Promise<AppState>;
    setState(partialState: Partial<AppState>): Promise<void>;
    getVersion(): Promise<string>;
    getVersionInfo(): Promise<AppVersionInfo>;
    hydrate(): Promise<HydrateResult>;
    boot(): Promise<BootResult>;
    quit(): Promise<void>;
    forceQuit(): Promise<void>;
    resetAndRelaunch(): Promise<void>;
    /** Persist the permanent dismissal of the Rosetta translation warning banner. */
    dismissRosettaWarning(): Promise<void>;
    /**
     * Clear a single panel's quarantine entry from the suspect ledger so it
     * hydrates normally on the next launch. Returns `{ cleared: true }` if the
     * ledger had a record for the given panel ID, `false` otherwise (e.g.,
     * already cleared or never quarantined). Next-restart-only — does not
     * re-hydrate the panel in the current session.
     */
    clearQuarantinedPanel(panelId: string): Promise<{ cleared: boolean }>;
    /** Fire-and-forget skeleton-parsed reveal signal sent before module-graph eval. */
    skeletonParsed(): void;
    notifyFirstInteractive(): Promise<void>;
    notifyViewPainted(): Promise<void>;
    notifyWarmViewPainted(): Promise<void>;
    onMenuAction(callback: (payload: { actionId: string; args?: unknown }) => void): () => void;
    reloadConfig(): Promise<{ success: boolean }>;
    onConfigReloaded(callback: () => void): () => void;
    /**
     * Subscribe to the post-reveal repaint signal (#10362). Main fires this
     * after it detaches the warm anti-flash bridge and focuses the cached view,
     * i.e. once the view is the composited foreground surface. The renderer
     * re-runs its terminal redraw then, since the wake fan-out driven by
     * visibilitychange/resume ran while the view was still occluded.
     */
    onViewRevealed(callback: () => void): () => void;
    onViewCached(callback: () => void): () => void;
  };
  // menu is generated — see GeneratedElectronAPI.
  logs: {
    getAll(filters?: LogFilterOptions): Promise<LogEntry[]>;
    getSources(): Promise<string[]>;
    clear(): Promise<void>;
    openFile(): Promise<void>;
    setVerbose(enabled: boolean): Promise<void>;
    getVerbose(): Promise<boolean>;
    onEntry(callback: (entry: LogEntry) => void): () => void;
    onBatch(callback: (entries: LogEntry[]) => void): () => void;
    write(
      level: "debug" | "info" | "warn" | "error",
      message: string,
      context?: Record<string, unknown>
    ): Promise<void>;
    writeBatch(
      entries: Array<{
        level: "debug" | "info" | "warn" | "error";
        message: string;
        context?: Record<string, unknown>;
      }>
    ): Promise<void>;
    getDefaultLevel(): Promise<string>;
    getLevelOverrides(): Promise<Record<string, string>>;
    setLevelOverrides(overrides: Record<string, string>): Promise<{ success: boolean }>;
    clearLevelOverrides(): Promise<{ success: boolean }>;
    onLevelOverridesChanged(callback: (overrides: Record<string, string>) => void): () => void;
    getRegistry(): Promise<string[]>;
  };
  errors: {
    onError(callback: (error: ErrorRecord) => void): () => void;
    retry(errorId: string, action: RetryAction, args?: Record<string, unknown>): Promise<void>;
    cancelRetry(errorId: string): void;
    onRetryProgress(callback: (payload: RetryProgressPayload) => void): () => void;
    openLogs(): Promise<void>;
    getPending(): Promise<ErrorRecord[]>;
  };
  // getEvents / getFiltered / clear come from GeneratedElectronAPI; the
  // remaining methods are renderer-only subscription helpers.
  eventInspector: GeneratedElectronAPI["eventInspector"] & {
    subscribe(): void;
    unsubscribe(): void;
    onEventBatch(callback: (events: EventRecord[]) => void): () => void;
  };
  events: {
    emit(eventType: string, payload: unknown): Promise<void>;
    on<K extends keyof IpcEventBusMap>(
      name: K,
      callback: (payload: IpcEventBusMap[K]) => void
    ): () => void;
  };
  project: {
    getAll(): Promise<Project[]>;
    getCurrent(): Promise<Project | null>;
    add(path: string): Promise<Project>;
    remove(projectId: string): Promise<void>;
    update(projectId: string, updates: Partial<Project>): Promise<Project>;
    switch(
      projectId: string,
      outgoingState?: ProjectSwitchOutgoingState,
      options?: { focusIntent?: "focus-next-waiting" }
    ): Promise<Project>;
    /**
     * Hover-prefetch trigger for the project switcher palette. Fire-and-forget:
     * the main process builds the `HydrateResult` for the given project and
     * caches it so the next `app:hydrate` call from the new project view
     * resolves as a cache hit. Errors are swallowed in the cache layer.
     */
    prefetchHydrate(projectId: string): Promise<void>;
    openDialog(): Promise<string | null>;
    onSwitch(
      callback: (payload: {
        project: Project;
        switchId: string;
        worktreeLoadError?: string;
        hydrateResult?: import("./app.js").HydrateResult;
      }) => void
    ): () => void;
    onWorktreeLoadStatus(
      callback: (payload: { projectId: string; worktreeLoadError: string | null }) => void
    ): () => void;
    onFocusOnActivate(callback: (payload: { intent: "focus-next-waiting" }) => void): () => void;
    onBackgroundResize(callback: (payload: { width: number; height: number }) => void): () => void;
    onUpdated(callback: (project: Project) => void): () => void;
    onRemoved(callback: (projectId: string) => void): () => void;
    getSettings(projectId: string): Promise<ProjectSettings>;
    saveSettings(projectId: string, settings: ProjectSettings): Promise<void>;
    detectRunners(projectId: string): Promise<RunCommand[]>;
    /**
     * List all git remotes for a working directory, with an optional parsed
     * owner/repo for remotes whose URL looks like a forge repo. Provider-
     * agnostic replacement for the legacy `github.listRemotes` (#8456).
     */
    listRemotes(cwd: string): Promise<import("./forge.js").RemoteInfo[]>;
    /**
     * Close/background a project.
     * @param projectId - Project ID to close
     * @param options - Optional: { killTerminals: true } to kill running terminals (default: false, just backgrounds)
     */
    close(projectId: string, options?: { killTerminals?: boolean }): Promise<ProjectCloseResult>;
    /**
     * Reclaim a background project's resident memory — tears down its cached
     * renderer, gracefully kills its PTYs (sessions preserved), and evicts its
     * workspace host — while keeping the project in the list as `closed` and
     * preserving its layout for a non-destructive reopen. Rejects if the
     * project is currently active (switch away first).
     */
    freeMemory(projectId: string): Promise<ProjectFreeMemoryResult>;
    /**
     * Reopen a background project, making it the active project.
     * Terminals that were running in the background will be reconnected.
     */
    reopen(projectId: string, outgoingState?: ProjectSwitchOutgoingState): Promise<Project>;
    getStats(projectId: string): Promise<ProjectStats>;
    getBulkStats(projectIds: string[]): Promise<BulkProjectStats>;
    getNotificationOverrides(
      projectIds: string[]
    ): Promise<Record<string, Partial<NotificationSettings>>>;
    onStatsUpdated(callback: (stats: ProjectStatusMap) => void): () => void;
    createFolder(parentPath: string, folderName: string): Promise<string>;
    initGit(directoryPath: string): Promise<void>;
    /** Initialize git repository with progress events */
    initGitGuided(options: GitInitOptions): Promise<GitInitResult>;
    /** Subscribe to git init progress events */
    onInitGitProgress(callback: (event: GitInitProgressEvent) => void): () => void;
    /** Clone a git repository from a URL */
    cloneRepo(options: CloneRepoOptions): Promise<CloneRepoResult>;
    /** Subscribe to clone progress events */
    onCloneProgress(callback: (event: CloneRepoProgressEvent) => void): () => void;
    /** Cancel an in-progress clone operation */
    cancelClone(): Promise<void>;
    getRecipes(
      projectId: string
    ): Promise<{ recipes: TerminalRecipe[]; collisions: RecipeNameCollision[] }>;
    saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void>;
    addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void>;
    updateRecipe(
      projectId: string,
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void>;
    deleteRecipe(projectId: string, recipeId: string): Promise<void>;
    exportRecipeToFile(name: string, json: string): Promise<boolean>;
    importRecipeFromFile(): Promise<string | null>;
    getInRepoRecipes(projectId: string): Promise<TerminalRecipe[]>;
    syncInRepoRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void>;
    updateInRepoRecipe(
      projectId: string,
      recipe: TerminalRecipe,
      previousName?: string,
      options?: { force?: boolean }
    ): Promise<void>;
    deleteInRepoRecipe(projectId: string, recipeName: string): Promise<void>;
    getInRepoPresets(projectId: string): Promise<Record<string, AgentPreset[]>>;
    /**
     * Get saved terminal snapshots for a project (per-project panel state).
     * Used for restoring panel layout when switching projects.
     */
    getTerminals(projectId: string): Promise<TerminalSnapshot[]>;
    /**
     * Save terminal snapshots for a project (per-project panel state).
     * Used for preserving panel layout when switching away from a project.
     */
    setTerminals(projectId: string, terminals: TerminalSnapshot[]): Promise<void>;
    /**
     * Get terminal dimensions for a project.
     * Used for restoring terminal sizes when switching to a project.
     */
    getTerminalSizes(projectId: string): Promise<Record<string, { cols: number; rows: number }>>;
    /**
     * Save terminal dimensions for a project.
     * Used for preserving terminal sizes when switching away from a project.
     */
    setTerminalSizes(
      projectId: string,
      terminalSizes: Record<string, { cols: number; rows: number }>
    ): Promise<void>;
    /**
     * Get draft inputs for a project.
     * Used for restoring hybrid input bar drafts when switching to a project.
     */
    getDraftInputs(projectId: string): Promise<Record<string, string>>;
    /**
     * Save draft inputs for a project.
     * Used for preserving hybrid input bar drafts when switching away from a project.
     */
    setDraftInputs(projectId: string, draftInputs: Record<string, string>): Promise<void>;
    /**
     * Get tab groups for a project.
     * Used for restoring tab groups when switching to a project.
     */
    getTabGroups(projectId: string): Promise<TabGroup[]>;
    /**
     * Save tab groups for a project.
     * Used for persisting tab group state per-project.
     */
    setTabGroups(projectId: string, tabGroups: TabGroup[]): Promise<void>;
    /**
     * Get focus mode state for a project.
     * Used for restoring focus mode when switching projects.
     */
    getFocusMode(projectId: string): Promise<{
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }>;
    /**
     * Set focus mode state for a project.
     * Used for persisting focus mode per-project.
     */
    setFocusMode(
      projectId: string,
      focusMode: boolean,
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
    ): Promise<void>;
    readClaudeMd(projectId: string): Promise<string | null>;
    writeClaudeMd(projectId: string, content: string): Promise<void>;
    /**
     * Enable in-repo settings mode: writes current identity and settings to .daintree/,
     * then sets project.inRepoSettings = true.
     */
    enableInRepoSettings(projectId: string): Promise<Project>;
    /**
     * Disable in-repo settings mode: clears project.inRepoSettings flag.
     * Does NOT delete .daintree/ files.
     */
    disableInRepoSettings(projectId: string): Promise<Project>;
    /**
     * Checks all non-active projects for missing directories.
     * Updates status to "missing" for projects whose paths no longer exist,
     * and resets "missing" back to "closed" for paths that are accessible again.
     * Returns the IDs of projects newly marked as missing.
     */
    checkMissing(): Promise<string[]>;
    /**
     * Opens a directory picker to let the user relocate a missing project.
     * Updates the stored path and resets status to "closed".
     * Returns the updated Project, or null if the user cancelled.
     */
    locate(projectId: string): Promise<Project | null>;
  };
  scratch: {
    getAll(): Promise<import("../scratch.js").Scratch[]>;
    getCurrent(): Promise<import("../scratch.js").Scratch | null>;
    create(name?: string): Promise<import("../scratch.js").Scratch>;
    update(
      scratchId: string,
      updates: { name?: string; lastOpened?: number }
    ): Promise<import("../scratch.js").Scratch>;
    remove(scratchId: string): Promise<void>;
    switch(scratchId: string): Promise<import("../scratch.js").Scratch>;
    saveAsProject(scratchId: string): Promise<import("./scratch.js").ScratchSaveAsProjectResult>;
    onUpdated(callback: (scratch: import("../scratch.js").Scratch) => void): () => void;
    onRemoved(callback: (scratchId: string) => void): () => void;
    onSwitch(callback: (payload: import("./scratch.js").ScratchSwitchPayload) => void): () => void;
  };
  globalRecipes: {
    getRecipes(): Promise<TerminalRecipe[]>;
    addRecipe(recipe: TerminalRecipe): Promise<void>;
    updateRecipe(
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt" | "worktreeId">>
    ): Promise<void>;
    deleteRecipe(recipeId: string): Promise<void>;
  };
  // globalEnv keeps a positional `set(variables)` renderer signature even
  // though the IPC channel carries a wrapped `{ variables }` payload — the
  // preload shim does the translation, so it stays hand-written here.
  globalEnv: {
    get(): Promise<Record<string, string>>;
    set(variables: Record<string, string>): Promise<void>;
  };
  agentSettings: {
    get(): Promise<AgentSettings>;
    set(agentId: AgentId, settings: Partial<AgentSettingsEntry>): Promise<AgentSettings>;
    /**
     * Set the global skip-permissions override (#10432). Persisted as a
     * dot-path leaf so per-agent records aren't rewritten with defaults.
     */
    setGlobal(value: boolean): Promise<AgentSettings>;
    reset(agentId?: AgentId): Promise<AgentSettings>;
    /**
     * Mark the persisted store with the given schema version. Only called by
     * the renderer migration after every per-agent pin clear has succeeded
     * (#7673). Idempotent: a no-op when the stored version is already ≥
     * the requested value.
     */
    stampVersion(version: number): Promise<Record<string, unknown>>;
  };
  userAgentRegistry: {
    get(): Promise<import("../userAgentRegistry.js").UserAgentRegistry>;
    add(
      config: import("../userAgentRegistry.js").UserAgentConfig
    ): Promise<{ success: boolean; error?: string }>;
    update(
      id: string,
      config: import("../userAgentRegistry.js").UserAgentConfig
    ): Promise<{ success: boolean; error?: string }>;
    remove(id: string): Promise<{ success: boolean; error?: string }>;
  };
  agentHelp: {
    get(request: AgentHelpRequest): Promise<AgentHelpResult>;
  };
  // getState comes from GeneratedElectronAPI; onServiceChanged is a renderer-only subscription.
  connectivity: GeneratedElectronAPI["connectivity"] & {
    onServiceChanged(
      callback: (payload: import("./connectivity.js").ServiceConnectivityPayload) => void
    ): () => void;
  };
  // ensure / restart / stop / getState etc. come from GeneratedElectronAPI;
  // onStateChanged is a renderer-only subscription.
  devPreview: GeneratedElectronAPI["devPreview"] & {
    onStateChanged(callback: (data: DevPreviewStateChangedPayload) => void): () => void;
    onAllSessionsChanged(callback: (data: DevPreviewAllSessionsPayload) => void): () => void;
  };
  git: {
    getFileDiff(
      cwd: string,
      filePath: string,
      status: GitStatus,
      ignoreWhitespace?: boolean
    ): Promise<string>;
    getProjectPulse(options: {
      worktreeId: string;
      rangeDays: import("../pulse.js").PulseRangeDays;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }): Promise<import("../pulse.js").ProjectPulse>;
    listCommits(options: {
      cwd: string;
      search?: string;
      branch?: string;
      skip?: number;
      limit?: number;
    }): Promise<import("../git.js").GitCommitListResponse>;
    stageFile(cwd: string, filePath: string): Promise<void>;
    unstageFile(cwd: string, filePath: string): Promise<void>;
    stageFiles(cwd: string, filePaths: string[]): Promise<void>;
    unstageFiles(cwd: string, filePaths: string[]): Promise<void>;
    stageAll(cwd: string): Promise<void>;
    unstageAll(cwd: string): Promise<void>;
    commit(cwd: string, message: string): Promise<{ hash: string; summary: string }>;
    push(cwd: string, setUpstream?: boolean): Promise<void>;
    pullRebase(cwd: string): Promise<void>;
    forcePushWithLease(cwd: string, branchName: string, leaseSha: string): Promise<void>;
    listRemoteCommits(
      cwd: string,
      branchName: string,
      limit?: number
    ): Promise<Array<{ hash: string; date: string; message: string; author: string }>>;
    onPushProgress(callback: (event: PushProgressEvent) => void): () => void;
    getStagingStatus(cwd: string): Promise<StagingStatus>;
    abortRepositoryOperation(cwd: string): Promise<void>;
    continueRepositoryOperation(cwd: string): Promise<void>;
    scanConflictMarkers(
      cwd: string,
      filePaths: string[]
    ): Promise<import("./git.js").ConflictMarkerScanEntry[]>;
    checkoutOursTheirs(cwd: string, filePath: string, side: "ours" | "theirs"): Promise<void>;
    compareWorktrees(
      cwd: string,
      branch1: string,
      branch2: string,
      filePath?: string,
      useMergeBase?: boolean,
      ignoreWhitespace?: boolean
    ): Promise<import("./git.js").CrossWorktreeDiffResult | string>;
    getUsername(cwd: string): Promise<string | null>;
    getWorkingDiff(cwd: string, type: "unstaged" | "staged" | "head"): Promise<string>;
    snapshotGet(worktreeId: string): Promise<SnapshotInfo | null>;
    snapshotList(): Promise<SnapshotInfo[]>;
    snapshotRevert(worktreeId: string): Promise<SnapshotRevertResult>;
    snapshotDelete(worktreeId: string): Promise<void>;
    markSafeDirectory(path: string): Promise<void>;
  };
  terminalConfig: {
    get(): Promise<TerminalConfig>;
    setScrollback(scrollbackLines: number): Promise<void>;
    setPerformanceMode(performanceMode: boolean): Promise<void>;
    setFontSize(fontSize: number): Promise<void>;
    setFontFamily(fontFamily: string): Promise<void>;
    setHybridInputEnabled(enabled: boolean): Promise<void>;
    setHybridInputAutoFocus(enabled: boolean): Promise<void>;
    setColorScheme(schemeId: string): Promise<void>;
    setCustomSchemes(schemes: unknown): Promise<void>;
    setRecentSchemeIds(ids: string[]): Promise<void>;
    importColorScheme(): Promise<
      | {
          ok: true;
          scheme: {
            id: string;
            name: string;
            type: "dark" | "light";
            colors: Record<string, string>;
          };
        }
      | { ok: false; errors: string[] }
    >;
    setScreenReaderMode(mode: "auto" | "on" | "off"): Promise<void>;
    setResourceMonitoring(enabled: boolean): Promise<void>;
    setMemoryLeakDetection(enabled: boolean): Promise<void>;
    setMemoryLeakAutoRestartThresholdMb(thresholdMb: number): Promise<void>;
    setCachedProjectViews(cachedProjectViews: number): Promise<void>;
    setExitSnapshot(enabled: boolean): Promise<void>;
  };
  // getEnabled comes from GeneratedElectronAPI; onSupportChanged is a
  // renderer-only subscription.
  accessibility: GeneratedElectronAPI["accessibility"] & {
    onSupportChanged(callback: (data: { enabled: boolean }) => void): () => void;
  };
  // create / show / hide / resize / navigate / goBack / goForward / reload /
  // closeTab / showNewTabMenu come from GeneratedElectronAPI; the rest are
  // renderer-only subscriptions.
  portal: GeneratedElectronAPI["portal"] & {
    onNavEvent(callback: (data: import("../portal.js").PortalNavEvent) => void): () => void;
    onFocus(callback: () => void): () => void;
    onBlur(callback: () => void): () => void;
    onNewTabMenuAction(
      callback: (action: import("../portal.js").PortalNewTabMenuAction) => void
    ): () => void;
    onTabEvicted(callback: (data: { tabId: string }) => void): () => void;
    onTabsEvicted(callback: (payload: { tabIds: string[] }) => void): () => void;
  };
  webview: {
    /** Freeze or unfreeze a webview's JS execution via CDP Page.setWebLifecycleState */
    setLifecycleState(webContentsId: number, frozen: boolean): Promise<void>;
    /** Register a webview's webContentsId with its panel ID for dialog routing */
    registerPanel(webContentsId: number, panelId: string, kind?: string): Promise<void>;
    /** Respond to a JavaScript dialog (alert/confirm/prompt) shown by a webview */
    respondToDialog(dialogId: string, confirmed: boolean, response?: string): Promise<void>;
    /** Subscribe to dialog requests from webview guests */
    onDialogRequest(
      callback: (payload: {
        dialogId: string;
        panelId: string;
        type: "alert" | "confirm" | "prompt";
        message: string;
        defaultValue: string;
      }) => void
    ): () => void;
    /** Subscribe to dialog-dismiss events — guest navigated away or its renderer crashed */
    onDialogDismiss(callback: (payload: { panelId: string }) => void): () => void;
    /** Subscribe to find-in-page shortcuts forwarded from focused webview guests */
    onFindShortcut(
      callback: (payload: { panelId: string; shortcut: "find" | "next" | "prev" | "close" }) => void
    ): () => void;
    /** Subscribe to reload shortcut (Cmd/Ctrl+R) forwarded from focused webview guests */
    onReloadShortcut(callback: (payload: { panelId: string }) => void): () => void;
    /** Subscribe to close shortcut (Cmd/Ctrl+W) forwarded from focused webview guests */
    onCloseShortcut(callback: (payload: { panelId: string }) => void): () => void;
    /** Subscribe to blocked cross-origin navigation events from webview guests */
    onNavigationBlocked(
      callback: (payload: { panelId: string; url: string; canOpenExternal: boolean }) => void
    ): () => void;
    /** Subscribe to unresponsive events from webview guest render processes */
    onUnresponsive(callback: (payload: { panelId: string }) => void): () => void;
    onResponsive(callback: (payload: { panelId: string }) => void): () => void;
    /** Start OAuth loopback flow: system browser for IdP, ephemeral server for callback, CDP for token exchange */
    startOAuthLoopback(
      authUrl: string,
      panelId: string,
      webContentsId: number,
      sessionStorageSnapshot?: Array<[string, string]>
    ): Promise<
      | {
          success: true;
          callbackUrl: string;
          loopbackRedirectUri: string;
          originalRedirectUri: string;
        }
      | {
          success: false;
          cause: "cancelled" | "timed-out" | "server-error" | "open-external-failed";
        }
    >;
    /** Cancel an in-progress OAuth loopback flow for a panel */
    cancelOAuthLoopback(panelId: string): Promise<void>;
    /** Subscribe to OAuth loopback phase transitions from main process */
    onOAuthLoopbackStatus(
      callback: (payload: {
        panelId: string;
        phase: "token-exchange-intercepted" | "completed" | "timed-out" | "error";
        message?: string;
      }) => void
    ): () => void;
    /** Start CDP console capture for a webview panel */
    startConsoleCapture(webContentsId: number, paneId: string): Promise<void>;
    /** Stop CDP console capture for a webview panel */
    stopConsoleCapture(webContentsId: number, paneId: string): Promise<void>;
    /** Clear tracked object references for a webview panel */
    clearConsoleCapture(webContentsId: number, paneId: string): Promise<void>;
    /** Fetch properties for a CDP remote object */
    getConsoleProperties(
      webContentsId: number,
      objectId: string
    ): Promise<import("./webviewConsole.js").CdpGetPropertiesResult>;
    /** Subscribe to structured console messages */
    onConsoleMessage(
      callback: (row: import("./webviewConsole.js").SerializedConsoleRow) => void
    ): () => void;
    /** Subscribe to execution context cleared events (navigation) */
    onConsoleContextCleared(
      callback: (payload: { paneId: string; navigationGeneration: number }) => void
    ): () => void;
    /** Reload a webview bypassing HTTP cache */
    reloadIgnoringCache(webContentsId: number, panelId: string): Promise<void>;
    /** Read the current scroll position from Blink layout — works on frozen pages */
    getScrollPosition(webContentsId: number): Promise<number>;
    /** Capture the panel's webview viewport as a PNG, returned base64-encoded */
    captureScreenshot(
      panelId: string
    ): Promise<{ pngBase64: string; width: number; height: number }>;
    /** Read Chromium navigation history for the webview */
    getNavigationHistory(
      webContentsId: number
    ): Promise<import("../browser.js").BrowserNavigationHistorySnapshot>;
    /** Navigate to a specific index in Chromium's navigation history */
    goToHistoryIndex(webContentsId: number, index: number): Promise<void>;
  };
  // Invoke methods come from GeneratedElectronAPI; the rest are renderer-only subscriptions.
  hibernation: GeneratedElectronAPI["hibernation"] & {
    onProjectHibernated(
      callback: (payload: HibernationProjectHibernatedPayload) => void
    ): () => void;
  };
  // Channel is `idle-terminal:*` (singular) but the renderer surface uses
  // `idleTerminals` (plural). The preload opts out of the API codegen via
  // RENDERER_API_SKIP — methods are hand-typed here against IpcInvokeMap.
  idleTerminals: {
    getConfig(): Promise<IpcInvokeMap["idle-terminal:get-config"]["result"]>;
    updateConfig(
      ...args: IpcInvokeMap["idle-terminal:update-config"]["args"]
    ): Promise<IpcInvokeMap["idle-terminal:update-config"]["result"]>;
    closeProject(
      ...args: IpcInvokeMap["idle-terminal:close-project"]["args"]
    ): Promise<IpcInvokeMap["idle-terminal:close-project"]["result"]>;
    dismissProject(
      ...args: IpcInvokeMap["idle-terminal:dismiss-project"]["args"]
    ): Promise<IpcInvokeMap["idle-terminal:dismiss-project"]["result"]>;
    onNotify(callback: (payload: IdleTerminalNotifyPayload) => void): () => void;
  };
  // Channel is `idle-background:*` but the renderer surface uses
  // `idleBackgroundAutoClose`. The preload opts out of the API codegen via
  // RENDERER_API_SKIP — methods are hand-typed here against IpcInvokeMap.
  idleBackgroundAutoClose: {
    getConfig(): Promise<IpcInvokeMap["idle-background:get-config"]["result"]>;
    updateConfig(
      ...args: IpcInvokeMap["idle-background:update-config"]["args"]
    ): Promise<IpcInvokeMap["idle-background:update-config"]["result"]>;
    onClosed(callback: (payload: IdleBackgroundClosedPayload) => void): () => void;
  };
  // Invoke methods come from GeneratedElectronAPI; suspend/wake are renderer-only subscriptions.
  systemSleep: GeneratedElectronAPI["systemSleep"] & {
    /** Subscribe to suspend events */
    onSuspend(callback: () => void): () => void;
    /** Subscribe to wake events with sleep duration */
    onWake(callback: (sleepDurationMs: number) => void): () => void;
  };
  /**
   * OS Do-Not-Disturb / Focus state.
   *
   * `osDndActive` is `true` when the OS reports DND/Focus active, `false`
   * when off, and `undefined` on unsupported platforms (Windows/Linux) or
   * when detection fails — fail-soft semantics. Consumers must treat
   * `undefined` as "unknown / do not gate". Used by the working-pulse audio
   * gate and the read-only toolbar tooltip; never for in-app toast
   * suppression. Invoke method comes from GeneratedElectronAPI;
   * onStateChanged is a renderer-only subscription.
   */
  osDnd: GeneratedElectronAPI["osDnd"] & {
    /** Subscribe to DND state transitions. Returns an unsubscribe function. */
    onStateChanged(callback: (payload: { osDndActive: boolean | undefined }) => void): () => void;
  };
  keybinding: {
    /** Get current keybinding overrides */
    getOverrides(): Promise<Record<KeyAction, string[]>>;
    /** Set override for a specific action */
    setOverride(actionId: KeyAction, combo: string[]): Promise<void>;
    /** Remove override for a specific action (revert to default) */
    removeOverride(actionId: KeyAction): Promise<void>;
    /** Reset all overrides to defaults */
    resetAll(): Promise<void>;
    /** Export current overrides to a file via save dialog; returns false if cancelled */
    exportProfile(): Promise<boolean>;
    /** Import overrides from a file via open dialog; returns import result */
    importProfile(): Promise<KeybindingImportResult>;
  };
  worktreeConfig: {
    /** Get worktree path pattern configuration */
    get(): Promise<WorktreeConfig>;
    /** Set worktree path pattern */
    setPattern(pattern: string): Promise<WorktreeConfig>;
    /**
     * Toggle WSL-routed git for a single worktree. Persists the preference
     * and forwards to the workspace host so the next git invocation uses the
     * matching factory. Windows-only.
     */
    setWslGit(worktreeId: string, enabled: boolean): Promise<void>;
    /** Hide the WSL git suggestion banner for this worktree without enabling. */
    dismissWslBanner(worktreeId: string): Promise<void>;
    /**
     * Re-probe the WSL default distro on demand (user "Re-check") and refresh
     * eligibility across all WSL worktrees. Windows-only.
     */
    reprobeWsl(worktreeId: string): Promise<void>;
  };
  window: {
    /** Subscribe to fullscreen state changes */
    onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void;
    /** Toggle simple fullscreen mode (extends into notch area on MacBook) */
    toggleFullscreen(): Promise<boolean>;
    /** Reload the window via Electron webContents */
    reload(): Promise<void>;
    /** Force reload ignoring cache */
    forceReload(): Promise<void>;
    /** Toggle DevTools */
    toggleDevTools(): Promise<void>;
    /** Zoom in */
    zoomIn(): Promise<void>;
    /** Zoom out */
    zoomOut(): Promise<void>;
    /** Reset zoom */
    zoomReset(): Promise<void>;
    /** Get current zoom factor (synchronous, no IPC) */
    getZoomFactor(): number;
    /** Close window */
    close(): Promise<void>;
    /** Open a new window, optionally for a specific project path */
    openNew(projectPath?: string): Promise<void>;
    /** Subscribe to hidden webview destruction events from memory pressure */
    onDestroyHiddenWebviews(callback: (payload: { tier: 1 | 2 }) => void): () => void;
    /** Subscribe to disk space status changes */
    onDiskSpaceStatus(
      callback: (payload: {
        status: "normal" | "warning" | "critical";
        availableMb: number;
        writesSuppressed: boolean;
      }) => void
    ): () => void;
  };
  recovery: {
    /** Reload the main app from the recovery page */
    reloadApp(): Promise<void>;
    /** Reset workspace state and reload the main app from the recovery page */
    resetAndReload(): Promise<void>;
    /** Export a diagnostics bundle via save dialog. Resolves true if saved, false if cancelled. */
    exportDiagnostics(): Promise<boolean>;
    /** Open the main log file with the OS default viewer */
    openLogs(): Promise<void>;
  };
  notification: {
    /** Update window title and dock badge based on terminal attention state */
    updateBadge(state: { waitingCount: number }): void;
    /** Get notification settings */
    getSettings(): Promise<NotificationSettings>;
    /** Update notification settings (partial update) */
    setSettings(settings: Partial<NotificationSettings>): Promise<void>;
    /** Play a sound file by name for preview */
    playSound(soundFile: string): Promise<void>;
    /** Play a UI feedback event sound by ID (routed to SoundService with variant selection) */
    playUiEvent(soundId: string): Promise<void>;
    /** Show a simple native OS notification with no navigation context */
    showNative(payload: { title: string; body: string }): void;
    /** Show a high-priority watch notification unconditionally (no focus suppression) */
    showWatchNotification(payload: {
      title: string;
      body: string;
      panelId: string;
      panelTitle: string;
      worktreeId?: string;
    }): void;
    /** Subscribe to toast notifications pushed from the main process */
    onShowToast(
      callback: (payload: import("./maps.js").MainProcessToastPayload) => void
    ): () => void;
    /** Subscribe to watch notification click → navigate events from main process */
    onWatchNavigate(
      callback: (context: { panelId: string; panelTitle: string; worktreeId?: string }) => void
    ): () => void;
    /** Sync the renderer's watched panel set to main so AgentNotificationService can gate on it */
    syncWatchedPanels(panelIds: string[]): void;
    /** Acknowledge a waiting agent escalation (cancels pending escalation timer) */
    acknowledgeWaiting(terminalId: string): void;
    /** Acknowledge working pulse (cancels periodic pulse sound for the terminal) */
    acknowledgeWorkingPulse(terminalId: string): void;
    /**
     * Synchronize the renderer's session-mute expiry (set by "Mute 1h" / "Until morning")
     * to the main process so completion watch notifications and working-pulse sounds
     * are also suppressed until the timestamp.
     */
    setSessionMuteUntil(timestampMs: number): void;
  };
  sound: {
    /** Listen for sound trigger events from main process */
    onTrigger(callback: (payload: { soundFile: string; detune?: number }) => void): () => void;
    /** Listen for sound cancel events from main process */
    onCancel(callback: () => void): () => void;
    /** Get the absolute path to the sounds directory */
    getSoundDir(): Promise<string>;
  };
  update: {
    onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
    onDownloadProgress(callback: (info: { percent: number }) => void): () => void;
    onUpdateDownloaded(callback: (info: { version: string }) => void): () => void;
    quitAndInstall(): Promise<void>;
    checkForUpdates(): Promise<void>;
    getChannel(): Promise<"stable" | "nightly">;
    setChannel(channel: "stable" | "nightly"): Promise<"stable" | "nightly">;
    notifyDismiss(version: string): Promise<void>;
    getLastCheck(): Promise<number | null>;
  };
  storeUpdate: {
    /** Subscribe to Store-build update notifications. Renderer hook short-circuits unless `isWindowsStore`. */
    onUpdateAvailable(callback: (info: { version: string; storeUrl: string }) => void): () => void;
    /** Hydrate-time getter so the renderer doesn't miss a detection that fired before first paint. */
    getLatest(): Promise<{ version: string; storeUrl: string } | null>;
    /** Persist that the user has seen this version so it isn't re-notified. */
    dismiss(version: string): Promise<void>;
    /** Read the user's preference for Store update notifications. */
    getSettings(): Promise<{ enabled: boolean }>;
    /** Toggle Store update notifications on/off. */
    setSettings(enabled: boolean): Promise<{ enabled: boolean }>;
  };
  // gemini is generated — see GeneratedElectronAPI.
  // commands is generated — see GeneratedElectronAPI.
  appAgent: {
    /** Get the current app agent config (without API key) */
    getConfig(): Promise<Omit<AppAgentConfig, "apiKey">>;
    /** Update app agent config */
    setConfig(config: Partial<AppAgentConfig>): Promise<Omit<AppAgentConfig, "apiKey">>;
    /** Check if API key is configured */
    hasApiKey(): Promise<boolean>;
    /** Test an API key without saving it */
    testApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;
    /** Test a model name using the stored API key */
    testModel(model: string): Promise<{ valid: boolean; error?: string }>;
    /** Listen for action dispatch requests from main process (for Assistant tool calling) */
    onDispatchActionRequest(
      callback: (payload: {
        requestId: string;
        actionId: string;
        args?: Record<string, unknown>;
        context: ActionContext;
        confirmed?: boolean;
      }) => void
    ): () => void;
    /** Send action dispatch response back to main process */
    sendDispatchActionResponse(payload: {
      requestId: string;
      result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    }): void;
    /** Listen for action confirmation requests from main process */
    onConfirmationRequest(
      callback: (payload: {
        requestId: string;
        actionId: string;
        actionName?: string;
        args?: Record<string, unknown>;
        danger: "safe" | "confirm" | "restricted";
      }) => void
    ): () => void;
    /** Send confirmation response back to main process */
    sendConfirmationResponse(payload: { requestId: string; approved: boolean }): void;
  };
  // Invoke methods come from GeneratedElectronAPI; onPresetsUpdated is a renderer-only subscription.
  agentCapabilities: GeneratedElectronAPI["agentCapabilities"] & {
    onPresetsUpdated(
      callback: (payload: {
        agentId: string;
        presets: Array<{
          id: string;
          name: string;
          description?: string;
          env?: Record<string, string>;
          args?: string[];
          color?: string;
          dangerousEnabled?: boolean;
          customFlags?: string;
          inlineMode?: boolean;
        }>;
      }) => void
    ): () => void;
  };
  agentSessionHistory: {
    list(worktreeId?: string): Promise<AgentSessionRecord[]>;
    clear(worktreeId?: string): Promise<void>;
    getRetentionDays(): Promise<AgentSessionRetentionDays>;
    setRetentionDays(days: AgentSessionRetentionDays): Promise<void>;
    getSnapshot(sessionId: string): Promise<{ found: boolean; snapshot: string | null }>;
  };
  // clipboard is generated — see GeneratedElectronAPI.
  webUtils: {
    getPathForFile(file: File): string;
  };
  appTheme: {
    get(): Promise<AppThemeConfig>;
    setColorScheme(schemeId: string): Promise<void>;
    setCustomSchemes(schemes: unknown): Promise<void>;
    importTheme(): Promise<import("../appTheme.js").AppThemeImportResult>;
    exportTheme(scheme: import("../appTheme.js").AppColorScheme): Promise<boolean>;
    setColorVisionMode(mode: import("../appTheme.js").ColorVisionMode): Promise<void>;
    setFollowSystem(enabled: boolean): Promise<void>;
    setPreferredDarkScheme(schemeId: string): Promise<void>;
    setPreferredLightScheme(schemeId: string): Promise<void>;
    setRecentSchemeIds(ids: string[]): Promise<void>;
    setAccentColorOverride(color: string | null): Promise<void>;
    onSystemAppearanceChanged(
      callback: (payload: { isDark: boolean; schemeId: string }) => void
    ): () => void;
  };
  telemetry: {
    get(): Promise<{ enabled: boolean; hasSeenPrompt: boolean }>;
    setEnabled(enabled: boolean): Promise<void>;
    markPromptShown(): Promise<void>;
    track(event: string, properties: Record<string, unknown>): Promise<void>;
    preview: {
      getState(): Promise<TelemetryPreviewState>;
      toggle(active: boolean): Promise<TelemetryPreviewState>;
      subscribe(): void;
      unsubscribe(): void;
      onEventBatch(callback: (events: SanitizedTelemetryEvent[]) => void): () => void;
      onStateChanged(callback: (state: TelemetryPreviewState) => void): () => void;
    };
  };
  gpu: {
    getStatus(): Promise<{ hardwareAccelerationDisabled: boolean; angleFallbackActive: boolean }>;
    setHardwareAcceleration(enabled: boolean): Promise<void>;
  };
  // Invoke methods come from GeneratedElectronAPI; onTelemetryConsentChanged is a renderer-only subscription.
  privacy: GeneratedElectronAPI["privacy"] & {
    onTelemetryConsentChanged(
      callback: (payload: { level: "off" | "errors" | "full"; hasSeenPrompt: boolean }) => void
    ): () => void;
  };
  // sentry is generated — see GeneratedElectronAPI.
  // Invoke methods come from GeneratedElectronAPI; onChecklistPush is a renderer-only subscription.
  onboarding: GeneratedElectronAPI["onboarding"] & {
    onChecklistPush(callback: (state: ChecklistState) => void): () => void;
  };
  // milestones is generated — see GeneratedElectronAPI.
  // shortcutHints is generated — see GeneratedElectronAPI.
  forge: {
    /** Read the persisted forge settings (global default provider id). */
    getSettings(): Promise<{ defaultProviderId: string | null }>;
    /**
     * Persist the global default forge provider id. Pass `null` to clear the
     * default and fall back to hostname auto-match. Server treats empty
     * strings as `null`.
     */
    setDefaultProvider(providerId: string | null): Promise<{ defaultProviderId: string | null }>;
    /**
     * List forge providers contributed by currently-loaded plugins. Reflects
     * the live registry — plugins loaded after settings open should appear
     * on the next call without restart.
     */
    getProviders(): Promise<ForgeProviderEntry[]>;
    /**
     * Resolve the active forge provider for the given project, applying the
     * per-project override → global default → first hostname match precedence
     * chain. `entry` is `null` when no rule resolves (override or default
     * points at an unavailable provider, no hostname match) and `resolvedVia`
     * is `null` in lock-step. Consumers treat `entry === null` the same as
     * "no provider registered".
     *
     * `remoteUrl`, when supplied, replaces the project's `origin` for the
     * hostname-match step — used by per-remote routing UIs that need a
     * resolution per remote rather than the project default.
     */
    resolveProvider(projectId: string, remoteUrl?: string): Promise<ResolvedForgeProvider>;
    /** Open the issues list page for the resolved forge provider. */
    openIssues(cwd: string, query?: string, state?: string): Promise<void>;
    /** Open the pull requests list page for the resolved forge provider. */
    openPRs(cwd: string, query?: string, state?: string): Promise<void>;
    /** Open the commits page for the resolved forge provider. */
    openCommits(cwd: string, branch?: string): Promise<void>;
    /** Open a single issue in the system browser via the resolved forge provider. */
    openIssue(payload: { cwd: string; issueNumber: number }): Promise<void>;
    /** Resolve the canonical URL for a single issue via the resolved forge provider. */
    getIssueUrl(payload: { cwd: string; issueNumber: number }): Promise<string>;
    /** Assign an issue to a user via the resolved forge provider. */
    assignIssue(payload: { cwd: string; issueNumber: number; username: string }): Promise<void>;
    /** Unassign a user from an issue via the resolved forge provider. */
    unassignIssue(payload: { cwd: string; issueNumber: number; username: string }): Promise<void>;
    /** Create a new issue via the resolved forge provider, returning the created issue. */
    createIssue(payload: { cwd: string; input: CreateIssueInput }): Promise<Issue>;
    /** Close an open issue via the resolved forge provider, returning the updated issue. */
    closeIssue(payload: {
      cwd: string;
      issueNumber: number;
      stateReason?: IssueCloseReason;
    }): Promise<Issue>;
    /** Reopen a closed issue via the resolved forge provider, returning the updated issue. */
    reopenIssue(payload: { cwd: string; issueNumber: number }): Promise<Issue>;
    /** Edit an issue's title and/or body via the resolved forge provider, returning the updated issue. */
    editIssue(payload: { cwd: string; issueNumber: number; input: EditIssueInput }): Promise<Issue>;
    /** Add a comment to an issue via the resolved forge provider, returning the created comment. */
    addIssueComment(payload: {
      cwd: string;
      issueNumber: number;
      body: string;
    }): Promise<IssueComment>;
    /** Add a label (by name) to an issue, returning the issue's full label set. */
    addIssueLabel(payload: {
      cwd: string;
      issueNumber: number;
      label: string;
    }): Promise<ForgeLabel[]>;
    /** Remove a label (by name) from an issue, returning the issue's remaining label set. */
    removeIssueLabel(payload: {
      cwd: string;
      issueNumber: number;
      label: string;
    }): Promise<ForgeLabel[]>;
    /**
     * Approve a pull request via the resolved provider's `reviews` capability.
     * `body` is an optional approval comment. Rejects when the provider lacks
     * the capability or the forge refuses (e.g. approving your own PR).
     */
    approvePR(payload: { cwd: string; prNumber: number; body?: string }): Promise<void>;
    /**
     * Submit a request-changes review on a pull request via the resolved
     * provider's `reviews` capability. `body` is required — it explains what
     * needs to change.
     */
    requestChanges(payload: { cwd: string; prNumber: number; body: string }): Promise<void>;
    /**
     * Dismiss a submitted review on a pull request via the resolved provider's
     * `reviews` capability. `reviewId` identifies the review (obtained from a
     * prior review-thread lookup); `message` explains the dismissal.
     */
    dismissReview(payload: {
      cwd: string;
      prNumber: number;
      reviewId: number;
      message: string;
    }): Promise<void>;
    /**
     * Request reviewers on a pull request via the resolved provider's `reviews`
     * capability. `users` are account logins; `teams` are team identifiers
     * (GitHub team slugs). At least one must be non-empty.
     */
    requestReviewers(payload: {
      cwd: string;
      prNumber: number;
      users?: string[];
      teams?: string[];
    }): Promise<void>;
    /**
     * Validate a token against a specific forge provider, identified by its
     * canonical `{pluginId}.{contributionId}` id. The Test button in the
     * Code Forge settings surfaces a single provider at a time and passes
     * that provider's id directly — there is no implicit default fallback,
     * so a token entered in the GitHub tab can never be validated against
     * a non-GitHub forge (issue #9985).
     */
    validateToken(payload: { providerId: string; token: string }): Promise<AuthValidation>;
    /**
     * Validate and persist credentials for a specific forge provider, keyed
     * by its canonical `{pluginId}.{contributionId}` id. `credentials` is a
     * map of the provider's declared `credentialFields` ids to entered
     * values. The primary field is validated via the provider impl; on
     * success the full record is persisted and synced to the workspace host.
     * Returns the validation result — credentials are persisted only when
     * `valid` is `true`.
     */
    setCredential(providerId: string, credentials: Record<string, string>): Promise<AuthValidation>;
    /** Report whether credentials are stored for the given forge provider id. */
    getCredentialStatus(providerId: string): Promise<{ hasCredential: boolean }>;
    /** Clear stored credentials for the given forge provider id. */
    clearCredential(providerId: string): Promise<void>;
    /**
     * List issues for the resolved forge provider. Provider-agnostic — returns
     * normalized {@link Issue} rows, not GitHub-shaped types. Listing filters
     * go through `opts`, never client-side across pages.
     */
    listIssues(payload: { cwd: string; opts?: ListOptions }): Promise<Page<Issue>>;
    /** List pull/merge requests for the resolved forge provider. */
    listPRs(payload: { cwd: string; opts?: ListOptions }): Promise<Page<PR>>;
    /** Fetch a single normalized issue, or `null` when it doesn't exist. */
    getIssue(payload: { cwd: string; issueNumber: number }): Promise<Issue | null>;
    /** Fetch a single normalized PR, or `null` when it doesn't exist. */
    getPR(payload: { cwd: string; prNumber: number }): Promise<PR | null>;
    /** Fetch the normalized repository metadata roll-up. */
    getRepoMetadata(payload: { cwd: string }): Promise<RepoMetadata>;
    /**
     * Resolve the active forge provider's current authenticated viewer for a
     * project, used by the renderer to drive provider-agnostic "assign issue
     * to me" flows. Returns `null` when the provider doesn't carry a viewer
     * concept, has no credentials, or the user is signed out — callers treat
     * that as "skip self-assignment", not an error.
     */
    getCurrentUser(payload: { cwd: string }): Promise<ForgeUser | null>;
    /**
     * Provider-keyed rate-limit state push. Every forge provider (GitHub
     * included) flows through this channel tagged with its canonical
     * `providerId`; consumers filter to the provider they care about.
     */
    onRateLimitChanged(
      callback: (data: import("./forge.js").ForgeRateLimitChangedPayload) => void
    ): () => void;
    /**
     * Provider-keyed token-health state push. Forward-compat — no provider
     * implementation emits this yet; GitHub token health still flows over
     * `github.onTokenHealthChanged`.
     */
    onTokenHealthChanged(
      callback: (data: import("./forge.js").ForgeTokenHealthChangedPayload) => void
    ): () => void;
    /**
     * Classify a `git push` failure via the resolved forge provider. Returns
     * the provider's canonical `{pluginId}.{contributionId}` id (for routing
     * the push-error banner's settings CTA) plus the provider's classification
     * (a stable error code, or `null` when the provider doesn't recognize the
     * stderr). Resolves to `null` when no forge provider can be resolved for
     * `cwd`.
     */
    classifyPushError(payload: {
      cwd: string;
      stderr: string;
    }): Promise<{ providerId: string; classification: PushErrorClassification | null } | null>;
    /**
     * Provider-agnostic repository stats roll-up (toolbar counts badge).
     * Blends the host-computed local commit count with the resolved
     * provider's forge counts. Throws when the provider doesn't implement
     * the `repoStats` capability.
     */
    getRepoStats(payload: { cwd: string; bypassCache?: boolean }): Promise<ForgeRepositoryStats>;
    /**
     * Disk-persisted first page for cold-start toolbar hydration. `null`
     * when the provider has no cache, doesn't implement the capability, or
     * no provider resolves for `cwd` — never throws.
     */
    getFirstPageCache(payload: { cwd: string }): Promise<ForgeFirstPageCachePayload | null>;
    /**
     * Project-health roll-up for the project pulse card. Errors surface in
     * the returned payload's `error` field, never as a rejection.
     */
    getProjectHealth(payload: {
      cwd: string;
      bypassCache?: boolean;
    }): Promise<ForgeProjectHealthPayload>;
    /** Hover-tooltip projection of an issue. Best-effort — `null` on any failure. */
    getIssueTooltip(payload: {
      cwd: string;
      issueNumber: number;
    }): Promise<import("../forge.js").IssueTooltipData | null>;
    /** Hover-tooltip projection of a PR. Best-effort — `null` on any failure. */
    getPRTooltip(payload: {
      cwd: string;
      prNumber: number;
    }): Promise<import("../forge.js").PRTooltipData | null>;
    /**
     * Batch-fetch issues by number via the provider's `batchLookups`
     * capability. Returns the found issues in input order; numbers that
     * don't resolve are omitted. `[]` when the capability is absent.
     */
    getIssuesByNumbers(payload: { cwd: string; numbers: number[] }): Promise<Issue[]>;
    /** Batch-fetch PRs by number. See {@link getIssuesByNumbers}. */
    getPRsByNumbers(payload: { cwd: string; numbers: number[] }): Promise<PR[]>;
    /**
     * Opaque review threads for a PR via the provider's `reviews`
     * capability. `[]` when the capability is absent. Note this is the
     * normalized contract shape ({@link ReviewThread}[]), not the legacy
     * `github.getPRReviewThreads` per-path count record.
     */
    getPRReviewThreads(payload: { cwd: string; prNumber: number }): Promise<ReviewThread[]>;
    /** Resolve a commit-author email to an avatar URL. Best-effort — `null` on any failure. */
    resolveAuthorAvatar(payload: { cwd: string; email: string }): Promise<string | null>;
    /**
     * Replay the current token-health state for a provider (canonical
     * `{pluginId}.{contributionId}` id) so late-mounting windows can render
     * the banner without waiting for the next push. `null` when the provider
     * isn't activated or doesn't implement `healthEvents`.
     */
    getTokenHealth(payload: { providerId: string }): Promise<ForgeTokenHealthState | null>;
    /** Detailed per-bucket rate-limit snapshot for diagnostics UI; `null` when not inspectable. */
    getRateLimitDetails(payload: { cwd: string }): Promise<RateLimitDetails | null>;
    /** Open a single PR in the system browser via the resolved forge provider. */
    openPR(payload: { cwd: string; prNumber: number }): Promise<void>;
    /** Open a new pull request from `head` into `base` via the resolved forge provider. */
    createPR(payload: {
      cwd: string;
      head: string;
      base: string;
      title: string;
      body?: string;
      draft?: boolean;
    }): Promise<PR>;
    /** Close an open pull request without merging. */
    closePR(payload: { cwd: string; prNumber: number }): Promise<void>;
    /** Reopen a previously closed pull request. */
    reopenPR(payload: { cwd: string; prNumber: number }): Promise<void>;
    /** Merge a pull request with the optional strategy/commit overrides. Irreversible. */
    mergePR(payload: {
      cwd: string;
      prNumber: number;
      mergeMethod?: "merge" | "squash" | "rebase";
      commitTitle?: string;
      commitMessage?: string;
    }): Promise<void>;
    /** Convert an open pull request to a draft. */
    convertPRToDraft(payload: { cwd: string; prNumber: number }): Promise<void>;
    /** Mark a draft pull request ready for review. */
    markPRReadyForReview(payload: { cwd: string; prNumber: number }): Promise<void>;
    /** Post a comment on a pull request. */
    commentOnPR(payload: { cwd: string; prNumber: number; body: string }): Promise<void>;
    /** Edit a pull request's title and/or body via the resolved forge provider. */
    editPR(payload: { cwd: string; prNumber: number; title?: string; body?: string }): Promise<PR>;
    /** Provider-keyed stats + first-page push after a fresh network poll. */
    onRepoStatsAndPageUpdated(callback: (data: ForgeRepoStatsAndPagePayload) => void): () => void;
    /** Provider-keyed count-only stats push (cheap background poll path). */
    onRepoCountsUpdated(callback: (data: ForgeRepoCountsUpdatedPayload) => void): () => void;
    /** Branch→PR detection push from the worktree monitor. */
    onPRDetected(callback: (data: PRDetectedPayload) => void): () => void;
    /** PR association cleared for a worktree. */
    onPRCleared(callback: (data: PRClearedPayload) => void): () => void;
    /** Branch→issue detection push from the worktree monitor. */
    onIssueDetected(callback: (data: IssueDetectedPayload) => void): () => void;
    /** The forge confirmed an associated issue doesn't exist on the repo. */
    onIssueNotFound(callback: (data: IssueNotFoundPayload) => void): () => void;
  };
  // forgeAudit comes from GeneratedElectronAPI
  voiceInput: {
    getSettings(): Promise<VoiceInputSettings>;
    setSettings(settings: Partial<VoiceInputSettings>): Promise<void>;
    start(): Promise<{ ok: true } | { ok: false; error: string }>;
    stop(): Promise<{ rawText: string | null }>;
    flushParagraph(): Promise<{ rawText: string | null }>;
    sendAudioChunk(chunk: ArrayBuffer): void;
    onTranscriptionDelta(callback: (delta: string) => void): () => void;
    onTranscriptionComplete(
      callback: (payload: { text: string; willCorrect: boolean }) => void
    ): () => void;
    onParagraphBoundary(callback: (payload: { rawText: string | null }) => void): () => void;
    onError(callback: (error: VoiceInputError) => void): () => void;
    onStatus(callback: (status: VoiceInputStatus) => void): () => void;
    checkMicPermission(): Promise<MicPermissionStatus>;
    requestMicPermission(): Promise<boolean>;
    openMicSettings(): Promise<void>;
    validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;
    /** Run a whole-passage AI cleanup pass over the dictated text after recording stops. */
    correct(request: {
      rawText: string;
      recentContext?: string[];
    }): Promise<{ action: "no_change" | "replace"; correctedText: string }>;
    onFileTokenResolved(
      callback: (payload: { description: string; replacement: string; resolved: boolean }) => void
    ): () => void;
  };
  // Invoke methods come from GeneratedElectronAPI; the rest are
  // renderer-only event subscriptions.
  mcpServer: GeneratedElectronAPI["mcpServer"] & {
    /** Subscribe to runtime-state transitions. */
    onRuntimeStateChanged(
      callback: (snapshot: import("./mcpServer.js").McpRuntimeSnapshot) => void
    ): () => void;
    /**
     * Subscribe to tier-not-permitted pushes for the pinned help-session in
     * this WebContents. The callback fires when a tool call is denied because
     * the session tier doesn't permit it.
     */
    onTierNotPermitted(
      callback: (payload: {
        sessionId: string;
        toolId: string;
        tier: string;
        targetTier: "workbench" | "action" | "system" | null;
      }) => void
    ): () => void;
    /**
     * Subscribe to grant lifecycle events (`issued`, `expired`, `revoked`)
     * for the pinned help-session in this WebContents. Targeted send —
     * grant state is session-scoped (#8442).
     */
    onGrantLifecycle(
      callback: (payload: import("./mcpServer.js").McpGrantLifecyclePayload) => void
    ): () => void;
    /**
     * Subscribe to session-revoked pushes for the pinned help-session in this
     * WebContents. Fires when the abuse policy revokes the session after the
     * denial threshold is exceeded so the renderer can explain why it ended
     * and offer a new-session recovery action (#10017).
     */
    onSessionRevoked(
      callback: (payload: { sessionId: string; denialKind: string }) => void
    ): () => void;
    /**
     * Subscribe to live tool-call-started pushes for the pinned help-session
     * in this WebContents. Drives the Assistant panel's activity strip (#9759).
     */
    onToolCallStarted(
      callback: (payload: import("./mcpServer.js").McpToolCallStartedPayload) => void
    ): () => void;
    /**
     * Subscribe to live tool-call-settled pushes that match a prior
     * `onToolCallStarted` for this WebContents' pinned help-session (#9759).
     */
    onToolCallSettled(
      callback: (payload: import("./mcpServer.js").McpToolCallSettledPayload) => void
    ): () => void;
    /**
     * Subscribe to `help.displayImage` pushes for the pinned help-session in
     * this WebContents. Each push carries a validated daintree.org image URL
     * and its session-assigned figure number for inline rendering (#9828).
     */
    onDisplayImage(
      callback: (payload: import("./mcpServer.js").McpHelpDisplayImagePayload) => void
    ): () => void;
    /**
     * Subscribe to turn-outcome alerts (`agent-stuck` / `reasoning-loop`) for
     * the pinned help-session in this WebContents. Drives the Assistant
     * footer's ambient outcome pip (#10018). Targeted send — never broadcast.
     */
    onTurnOutcomeAlert(
      callback: (payload: import("./mcpServer.js").McpTurnOutcomeAlertPayload) => void
    ): () => void;
  };
  // All help methods (incl. reportPanelOpen + peekPendingHibernation, which
  // surfaces `panelWasOpen` for cold switch-back auto-resume) come from
  // GeneratedElectronAPI (#10815).
  help: GeneratedElectronAPI["help"];
  // helpAssistant is generated — see GeneratedElectronAPI.
  mcpBridge: {
    /** Listen for manifest requests from main process */
    onGetManifestRequest(callback: (requestId: string) => void): () => void;
    /** Send action manifest to main process */
    sendGetManifestResponse(
      requestId: string,
      manifest: import("../actions.js").ActionManifestEntry[]
    ): void;
    /** Listen for action dispatch requests from main process */
    onDispatchActionRequest(
      callback: (payload: {
        requestId: string;
        actionId: string;
        args?: unknown;
        confirmed?: boolean;
        /**
         * Provision-time `ActionContext` snapshot bound to pinned
         * help-session dispatch (#8317). Undefined for unpinned
         * external/api-key dispatch, which keeps live renderer context.
         */
        context?: ActionContext;
        /**
         * Display-only requesting-bearer identity for the confirm dialog
         * (#9157). Present only for unpinned external/api-key dispatch;
         * absent for pinned help-session dispatch so the dialog stays
         * provenance-free.
         */
        callerInfo?: import("./mcpServer.js").McpBearerIdentity;
      }) => void
    ): () => void;
    /** Send action dispatch result to main process */
    sendDispatchActionResponse(payload: {
      requestId: string;
      result: import("../actions.js").ActionDispatchResult;
      confirmationDecision?: import("./mcpServer.js").McpConfirmationDecision;
    }): void;
  };
  pluginBridge: {
    /**
     * Listen for plugin-sourced action dispatch requests from the main process.
     * Unlike {@link mcpBridge.onDispatchActionRequest} there is no `confirmed`,
     * `context`, or `callerInfo`: plugins cannot bypass confirm-gating and don't
     * override the action context.
     */
    onDispatchActionRequest(
      callback: (payload: { requestId: string; actionId: string; args?: unknown }) => void
    ): () => void;
    /** Send the plugin action dispatch result back to the main process. */
    sendDispatchActionResponse(payload: {
      requestId: string;
      result: import("../actions.js").ActionDispatchResult;
    }): void;
    /**
     * Listen for plugin built-in action-catalog requests from the main process (a
     * plugin calling `host.actions.list()`, #10561). Reply with
     * {@link sendActionsListResponse}, correlated by `requestId`.
     */
    onActionsListRequest(callback: (payload: { requestId: string }) => void): () => void;
    /** Send the projected built-in action catalog back to the main process. */
    sendActionsListResponse(payload: {
      requestId: string;
      entries: import("../actions.js").PluginActionManifestEntry[];
    }): void;
    /**
     * Listen for plugin single-action lookup requests from the main process (a
     * plugin calling `host.actions.get(id)` / `host.actions.canDispatch(id)`,
     * #10561). Reply with {@link sendActionsGetResponse}, correlated by `requestId`.
     */
    onActionsGetRequest(
      callback: (payload: { requestId: string; actionId: string }) => void
    ): () => void;
    /** Send the single projected action entry (or null) back to the main process. */
    sendActionsGetResponse(payload: {
      requestId: string;
      entry: import("../actions.js").PluginActionManifestEntry | null;
    }): void;
    /**
     * Listen for imperative plugin UI-prompt requests from the main process (a
     * plugin calling `host.showQuickPick`/`showInputBox`/`showConfirm`, #10522).
     * Reply with {@link sendUiPromptResponse}, correlated by `promptId`.
     */
    onUiPromptRequest(
      callback: (payload: import("../pluginUiPrompt.js").PluginUiPromptRequest) => void
    ): () => void;
    /** Send the user's answer to a plugin UI prompt back to the main process. */
    sendUiPromptResponse(payload: import("../pluginUiPrompt.js").PluginUiPromptResponse): void;
    /**
     * Listen for cancel signals (plugin unloaded mid-prompt): dismiss the open
     * dialog and resolve the queued promise with the dismiss value.
     */
    onUiPromptCancel(
      callback: (payload: import("../pluginUiPrompt.js").PluginUiPromptCancel) => void
    ): () => void;
  };
  // list / toolbarButtons / validateActionIds / get|register|
  // unregisterAction / getPanelKinds / getForgeProviders / getDecorations
  // come from GeneratedElectronAPI; invoke + on are variadic plugin RPC
  // helpers that aren't expressible through IpcInvokeMap, and the on*
  // entries are renderer-only subscriptions.
  plugin: GeneratedElectronAPI["plugin"] & {
    /**
     * Resolve the absolute native filesystem path of a dropped File via
     * `webUtils.getPathForFile`. Plugin-scoped (never exposed globally) so
     * native-path recovery stays confined to the plugin install surface
     * (#9295). Returns `""` for synthetic/non-disk File objects (clipboard
     * paste, virtual files) — treat empty as a structured error.
     */
    getDroppedFilePath(file: File): string;
    invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown>;
    /**
     * Subscribe to broadcast pushes for `(pluginId, channel)` — every
     * `host.postToPanel(channel, payload)` (no panelId) and
     * `host.broadcastToRenderer` push. Returns a cleanup. Per-instance pushes
     * (`postToPanel(channel, payload, panelId)`) are delivered via {@link onPanel}.
     */
    on(pluginId: string, channel: string, callback: (payload: unknown) => void): () => void;
    /**
     * Subscribe to per-instance pushes for `(pluginId, channel)` targeted at a
     * single `panelId` via `host.postToPanel(channel, payload, panelId)` (#10618),
     * so sibling instances of the same panel kind don't receive each other's
     * pushes. Broadcast pushes (no panelId) are NOT delivered here — use
     * {@link on} for those. Returns a cleanup.
     */
    onPanel(
      pluginId: string,
      channel: string,
      panelId: string,
      callback: (payload: unknown) => void
    ): () => void;
    /** Subscribe to plugin-action registry changes. Returns a cleanup. */
    onActionsChanged(
      callback: (payload: { actions: import("../plugin.js").PluginActionDescriptor[] }) => void
    ): () => void;
    /**
     * Subscribe to provenance/installed-set changes (install, uninstall). The
     * callback carries no data — re-pull via {@link list}. Returns a cleanup.
     */
    onProvenanceChanged(callback: (payload: Record<string, never>) => void): () => void;
    /**
     * Subscribe to file-decoration invalidations. The callback fires with the
     * changed scope (and optionally the narrowed paths) — it carries no
     * decoration data; re-pull via {@link getDecorations}. Returns a cleanup.
     */
    onDecorationsChanged(
      callback: (payload: { scope: string; paths?: string[] }) => void
    ): () => void;
    /**
     * Subscribe to plugin panel-badge changes (#10585). The callback fires with
     * one plugin's COMPLETE current badge map (`panelId → badge`); an empty map
     * clears that plugin's badges. Returns a cleanup.
     */
    onPanelBadgesChanged(
      callback: (payload: {
        pluginId: string;
        badges: Record<string, import("../plugin.js").PluginPanelBadge>;
      }) => void
    ): () => void;
    /**
     * Subscribe to plugin-unload badge clears (#10585). Fires with the unloaded
     * plugin's id so the renderer drops all of its panel badges. Returns a cleanup.
     */
    onPanelBadgesCleared(callback: (payload: { pluginId: string }) => void): () => void;
    /**
     * Subscribe to `daintree://` deep-link intents (#9559). Fires when the OS
     * hands the app a deep link; the callback opens the Plugin Manager. Returns
     * a cleanup.
     */
    onDeepLink(callback: (intent: import("../plugin.js").PluginDeepLinkIntent) => void): () => void;
    /** Subscribe to plugin panel kind registry changes. Returns a cleanup. */
    onPanelKindsChanged(
      callback: (payload: {
        kinds: import("../../config/panelKindRegistry.js").PanelKindConfig[];
      }) => void
    ): () => void;
    /** Subscribe to plugin agent registry changes. Returns a cleanup. */
    onAgentsChanged(
      callback: (payload: {
        agents: Record<string, import("../../config/agentRegistry.js").AgentConfig>;
        complete: boolean;
      }) => void
    ): () => void;
    /** Subscribe to plugin toolbar button registry changes. Returns a cleanup. */
    onToolbarButtonsChanged(
      callback: (payload: {
        buttons: import("../../config/toolbarButtonRegistry.js").ToolbarButtonConfig[];
        complete: boolean;
      }) => void
    ): () => void;
    /** Subscribe to plugin keybinding registry changes. Returns a cleanup. */
    onKeybindingsChanged(
      callback: (payload: {
        keybindings: import("../plugin.js").PluginKeybindingDescriptor[];
        complete: boolean;
      }) => void
    ): () => void;
    /** Subscribe to plugin context-menu item registry changes. Returns a cleanup. */
    onContextMenuItemsChanged(
      callback: (payload: {
        items: Array<{
          pluginId: string;
          item: import("../plugin.js").ContextMenuContribution;
        }>;
        complete: boolean;
      }) => void
    ): () => void;
  };
  crashRecovery: {
    getPending(): Promise<import("./crashRecovery.js").PendingCrash | null>;
    resolve(action: import("./crashRecovery.js").CrashRecoveryAction): Promise<void>;
    getConfig(): Promise<import("./crashRecovery.js").CrashRecoveryConfig>;
    setConfig(
      config: Partial<import("./crashRecovery.js").CrashRecoveryConfig>
    ): Promise<import("./crashRecovery.js").CrashRecoveryConfig>;
  };
  // help is generated — see GeneratedElectronAPI.
  perf: {
    flushMarks(payload: import("../../perf/marks.js").RendererPerfFlushPayload): void;
  };
  demo?: {
    moveTo(x: number, y: number, durationMs?: number): Promise<void>;
    moveToSelector(
      selector: string,
      durationMs?: number,
      offsetX?: number,
      offsetY?: number
    ): Promise<void>;
    click(): Promise<void>;
    type(selector: string, text: string, cps?: number): Promise<void>;
    screenshot(): Promise<DemoScreenshotResult>;
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    sleep(durationMs: number): Promise<void>;
    scroll(selector: string): Promise<void>;
    drag(fromSelector: string, toSelector: string, durationMs?: number): Promise<void>;
    pressKey(
      key: string,
      code?: string,
      modifiers?: Array<"mod" | "ctrl" | "shift" | "alt" | "meta">,
      selector?: string
    ): Promise<void>;
    typeInTerminal(selector: string, text: string, cps?: number): Promise<void>;
    sendKeyToTerminal(selector: string, key: DemoTerminalKey): Promise<void>;
    spotlight(selector: string, padding?: number): Promise<void>;
    dismissSpotlight(): Promise<void>;
    annotate(
      selector: string,
      text: string,
      position?: DemoAnnotationPlacement,
      size?: DemoAnnotationSize,
      id?: string
    ): Promise<DemoAnnotateResult>;
    dismissAnnotation(id?: string): Promise<void>;
    waitForIdle(settleMs?: number, timeoutMs?: number): Promise<void>;
    startCapture(payload: DemoStartCapturePayload): Promise<DemoStartCaptureResult>;
    sendCaptureChunk(captureId: string, data: Uint8Array): void;
    sendCaptureStop(captureId: string, chunkCount: number, error?: string): void;
    stopCapture(): Promise<DemoStopCaptureResult>;
    getCaptureStatus(): Promise<DemoCaptureStatus>;
    onExecCommand(
      channel: string,
      callback: (payload: Record<string, unknown>) => void
    ): () => void;
    sendCommandDone(requestId: string, error?: string): void;
  };
}

export type MicPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

export type VoiceTranscriptionModel = "gpt-realtime-whisper";

/**
 * Transcription backend. Each provider owns its own WebSocket protocol, audio
 * framing, and turn-detection behavior:
 *
 * - "openai": OpenAI Realtime (`gpt-realtime-whisper`). No server VAD, so the
 *   provider drives segmentation with a client-side commit cadence.
 * - "deepgram": Deepgram Nova-3 streaming. Native server-side VAD / endpointing,
 *   so no client commit timer is needed.
 */
export type VoiceTranscriptionProvider = "openai" | "deepgram";

export type VoiceCorrectionModel = "gpt-5-nano" | "gpt-5-mini";

/**
 * Paragraphing strategy for voice dictation.
 *
 * "spoken-command" (default): The user says "new paragraph" to insert a paragraph break.
 *   Spoken commands ("new paragraph" → \n\n, "period" → ".", "new line" → \n, etc.) are
 *   transcribed literally by the upstream service and rewritten post-hoc by the IPC handler
 *   via applyDictationCommands. Manual Enter is always available as a secondary mechanism.
 *
 * "manual": Paragraph breaks are inserted only via the Enter key. No spoken commands.
 *   Best for users who prefer keyboard control or find spoken formatting commands awkward.
 */
export type VoiceParagraphingStrategy = "spoken-command" | "manual";

/**
 * Recording mode for voice dictation.
 *
 * "toggle" (default): Pressing the voice shortcut starts recording; pressing it
 *   again stops recording. Recording persists until the user explicitly ends it.
 *
 * "push-to-talk": Recording is bound to the keyboard shortcut press. Pressing and
 *   holding the voice shortcut starts recording; releasing the trigger key stops
 *   recording and drains the transcript into the editor without auto-submitting.
 *   Escape still cancels. The toolbar button remains toggle-only regardless of mode.
 */
export type VoiceRecordingMode = "toggle" | "push-to-talk";

export interface VoiceInputSettings {
  enabled: boolean;
  openaiApiKey: string;
  /** API key for the Deepgram transcription provider. Empty string when unset. */
  deepgramApiKey: string;
  language: string;
  customDictionary: string[];
  /** Which transcription backend to use. Defaults to "openai". */
  transcriptionProvider: VoiceTranscriptionProvider;
  transcriptionModel: VoiceTranscriptionModel;
  correctionEnabled: boolean;
  correctionModel: VoiceCorrectionModel;
  correctionCustomInstructions: string;
  /** Controls how paragraph breaks are inserted during dictation. Defaults to "spoken-command". */
  paragraphingStrategy: VoiceParagraphingStrategy;
  /** When enabled, voice commands like "link to X" resolve to @file references. Defaults to true. */
  resolveFileLinks: boolean;
  /** Microphone device ID to use for recording. Empty string means system default. */
  deviceId: string;
  /** OpenAI Organization ID for legacy sk- keys. Sent as OpenAI-Organization header. */
  organizationId: string;
  /** OpenAI Project ID for legacy sk- keys. Sent as OpenAI-Project header. */
  projectId: string;
  /** Controls whether recording is held (push-to-talk) or toggled. Defaults to "toggle". */
  recordingMode: VoiceRecordingMode;
  /**
   * Runtime-only. Context keyterms (custom dictionary + project/branch/terminal
   * context) assembled at session start and frozen for the session's lifetime.
   * Deepgram injects them into the streaming URL as repeated `keyterm=` params;
   * OpenAI passes them through the transcription prompt. Populated by the
   * voice-input start handler — never persisted to the store or supplied by the
   * renderer. Reconnects reuse this snapshot.
   */
  keyterms?: string[];
  /**
   * Words learned from the user's manual corrections to dictated text, pending
   * explicit accept/dismiss. Never added to `customDictionary` silently.
   */
  suggestedDictionary: SuggestedDictionaryEntry[];
  /** When enabled, manual corrections to dictated text surface as suggested dictionary words. Defaults to true. */
  learnFromCorrections: boolean;
}

/** A dictionary word suggested from a user's manual correction, with provenance. */
export interface SuggestedDictionaryEntry {
  /** The corrected term, in the casing the user typed (e.g. "Zustand"). */
  word: string;
  /** The misheard phrase it replaced, shown as provenance (e.g. "zoo stand"). */
  utterance: string;
  /** Epoch ms when the suggestion was last observed. */
  suggestedAt: number;
  /** How many times this substitution has been seen. */
  frequency: number;
}

export type HelpAssistantAuditRetention = 7 | 30 | 0;

export type HelpAssistantIdleHibernateMinutes = 0 | 15 | 30 | 60 | 120;

export interface HelpAssistantSettings {
  /** Allow the help assistant to search Daintree documentation. Defaults to true. */
  docSearch: boolean;
  /** Allow the help assistant to call Daintree control tools via the local MCP. Defaults to true. */
  daintreeControl: boolean;
  /**
   * MCP capability tier the help assistant runs at — controls which Daintree
   * actions the assistant can call without prompting. Defaults to `"action"`.
   */
  tier: HelpAssistantTier;
  /**
   * Pass `--dangerously-skip-permissions` (Claude) and write
   * `defaultMode: "bypassPermissions"` into the session's `.claude/settings.json`.
   * Bypasses Claude Code's per-tool confirmation gate. Defaults to false.
   */
  bypassPermissions: boolean;
  /** How long to retain help-session audit logs. 7 = 7 days, 30 = 30 days, 0 = off. Defaults to 7. */
  auditRetention: HelpAssistantAuditRetention;
  /**
   * Model the assistant launches with, injected as `--model <id>` ahead of
   * {@link customArgs} so a `--model` in custom args still wins as the advanced
   * override. Empty string means "use the CLI's default model" (no flag).
   * Model IDs are agent-specific, so this is reset whenever the agent changes.
   * Defaults to "".
   */
  modelId: string;
  /** Whitespace-separated CLI flags appended at assistant launch (advanced override). Defaults to "". */
  customArgs: string;
  /**
   * Minutes the assistant panel must be continuously hidden before its PTY is
   * gracefully shut down to capture the Claude resume session ID. 0 disables
   * idle hibernation. Defaults to 30.
   */
  idleHibernateMinutes: HelpAssistantIdleHibernateMinutes;
  /**
   * Enable the Daintree Assistant's own full-fidelity debug log for new
   * sessions, by setting `DAINTREE_ASSISTANT_DEBUG_LOG=1` in the spawn env.
   * Only the `daintree-assistant` backend reads this var (per-session trace to
   * `~/.daintree/logs`); it is a no-op for other assistant agents. Defaults to false.
   */
  debugLogging: boolean;
}

/**
 * One grant currently active for the pinned help session. Covers both the
 * per-tool "Approve once" grants (`kind: "per-tool"`) and the native
 * session-scoped automation grants (`kind: "native"`, #10648). Native grants
 * carry a multi-tool allowlist and a use ceiling; the native-only fields are
 * absent on per-tool grants.
 */
export interface HelpSessionActiveGrant {
  /**
   * For per-tool grants, the dotted `BuiltInActionId` authorized (e.g.
   * `terminal.kill`). For native grants, `"*"` — the authorized tools are
   * listed in {@link allowedTools}.
   */
  toolId: string;
  /** Absolute epoch millis when the grant expires without refresh. */
  expiresAt: number;
  /** TTL the grant was minted with, in milliseconds. */
  ttlMs: number;
  /** Discriminates the grant kind. Defaults to `"per-tool"` when absent. */
  kind?: "per-tool" | "native";
  /** Stable UUID of a native grant — the revoke target. Native grants only. */
  grantId?: string;
  /** Dotted `BuiltInActionId`s a native grant authorizes. Native grants only. */
  allowedTools?: string[];
  /** Use ceiling a native grant was minted with. Native grants only. */
  maxUses?: number;
  /** Uses left on a native grant. Native grants only. */
  remainingUses?: number;
}

/**
 * Live status snapshot of the currently pinned help session — the effective
 * tier the session is *running at right now* (which a renderer-approved
 * "Always allow" elevation can raise above the configured
 * {@link HelpAssistantSettings.tier} default) plus the per-tool grants
 * currently in effect. Distinct from the persisted settings: those describe
 * the default for new sessions, this describes the live one. `connected` is
 * false when there is no pinned help session for the caller's WebContents (no
 * session, or the caller isn't the pinned renderer) — the tier/grants fields
 * then carry safe defaults the UI renders as a quiet "no live session" state.
 */
export interface HelpSessionLiveStatus {
  connected: boolean;
  tier: HelpAssistantTier;
  activeGrants: HelpSessionActiveGrant[];
}
