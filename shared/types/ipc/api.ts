import type { GitStatus, StagingStatus } from "../git.js";
import type { SnapshotInfo, SnapshotRevertResult } from "./git.js";
import type { AgentId } from "../agent.js";
import type { TabGroup } from "../panel.js";
import type { WorktreeState } from "../worktree.js";
import type {
  Project,
  ProjectSettings,
  RunCommand,
  TerminalRecipe,
  TerminalSnapshot,
} from "../project.js";
import type { OnboardingState, ChecklistState, ChecklistItemId } from "./maps.js";
import type { AgentSettings, AgentSettingsEntry } from "../agentSettings.js";
import type { VoiceInputStatus } from "../voice.js";
export type { VoiceInputStatus };
import type {
  CreateWorktreeOptions,
  BranchInfo,
  WorktreeConfig,
  CreateForTaskPayload,
  CleanupTaskOptions,
  AttachIssuePayload,
  IssueAssociation,
} from "./worktree.js";
import type {
  TerminalSpawnOptions,
  TerminalReconnectResult,
  BackendTerminalInfo,
  TerminalInfoPayload,
  TerminalActivityPayload,
} from "./terminal.js";
import type {
  SaveArtifactOptions,
  SaveArtifactResult,
  ApplyPatchOptions,
  ApplyPatchResult,
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  ArtifactDetectedPayload,
  AgentHelpRequest,
  AgentHelpResult,
} from "./agent.js";
import type { AgentSessionRecord } from "./agentSessionHistory.js";
import type {
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
  DemoEncodePayload,
  DemoEncodeProgressEvent,
  DemoEncodeResult,
} from "./demo.js";
import type {
  CopyTreeResult,
  CopyTreeOptions,
  FileTreeNode,
  CopyTreeProgress,
} from "./copyTree.js";
import type {
  SystemWakePayload,
  SystemOpenInEditorPayload,
  CliAvailability,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  SystemHealthCheckResult,
  PrerequisiteSpec,
  PrerequisiteCheckResult,
} from "./system.js";
import type { AppState, HydrateResult } from "./app.js";
import type { LogEntry, LogFilterOptions } from "./logs.js";
import type { RetryAction, AppError, RetryProgressPayload } from "./errors.js";
import type { EventRecord, EventFilterOptions } from "./events.js";
import type { ProjectCloseResult, ProjectStats, BulkProjectStats } from "./project.js";
import type { GitInitOptions, GitInitProgressEvent, GitInitResult } from "./gitInit.js";
import type { CloneRepoOptions, CloneRepoResult, CloneRepoProgressEvent } from "./gitClone.js";
import type {
  RepositoryStats,
  ProjectHealthData,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
} from "./github.js";
import type { TerminalConfig } from "./config.js";
import type { HibernationConfig, HibernationProjectHibernatedPayload } from "./hibernation.js";
import type { SystemSleepMetrics } from "./systemSleep.js";
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
} from "../pty-host.js";
import type { ShowContextMenuPayload } from "../menu.js";
import type {
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
} from "./files.js";
import type { SlashCommand, SlashCommandListRequest } from "../slashCommands.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewStateChangedPayload,
} from "./devPreview.js";
import type {
  CommandContext,
  CommandManifestEntry,
  CommandResult,
  CommandExecutePayload,
  CommandGetPayload,
  BuilderStep,
} from "../commands.js";
import type { AppAgentConfig } from "../appAgent.js";
import type { ActionContext } from "../actions.js";
import type { AgentRegistry, AgentMetadata } from "./agentCapabilities.js";
import type { AppThemeConfig } from "../appTheme.js";

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
}

// ElectronAPI Type (exposed via preload)

/** Complete Electron API exposed to renderer */
export interface ElectronAPI {
  worktree: {
    getAll(): Promise<WorktreeState[]>;
    refresh(): Promise<void>;
    refreshPullRequests(): Promise<void>;
    getPRStatus(): Promise<import("../workspace-host.js").PRServiceStatus | null>;
    setActive(worktreeId: string): Promise<void>;
    create(options: CreateWorktreeOptions, rootPath: string): Promise<string>;
    listBranches(rootPath: string): Promise<BranchInfo[]>;
    getRecentBranches(rootPath: string): Promise<string[]>;
    getDefaultPath(rootPath: string, branchName: string): Promise<string>;
    getAvailableBranch(rootPath: string, branchName: string): Promise<string>;
    delete(worktreeId: string, force?: boolean, deleteBranch?: boolean): Promise<void>;
    /**
     * Create a worktree for a specific task with auto-generated collision-safe branch name.
     * @param payload - Contains taskId, optional baseBranch, and optional description
     * @returns The created worktree state including the assigned taskId
     */
    createForTask(payload: CreateForTaskPayload): Promise<WorktreeState>;
    /**
     * Get all worktrees linked to a specific task.
     * @param taskId - The task ID to filter by
     * @returns Array of worktree states matching the taskId
     */
    getByTaskId(taskId: string): Promise<WorktreeState[]>;
    /**
     * Cleanup worktrees associated with a task.
     * @param taskId - The task ID whose worktrees should be cleaned up
     * @param options - Optional: { force: boolean, deleteBranch: boolean } (defaults: force=true, deleteBranch=true)
     */
    cleanupTask(taskId: string, options?: CleanupTaskOptions): Promise<void>;
    attachIssue(payload: AttachIssuePayload): Promise<void>;
    detachIssue(worktreeId: string): Promise<void>;
    getIssueAssociation(worktreeId: string): Promise<IssueAssociation | null>;
    getAllIssueAssociations(): Promise<Record<string, IssueAssociation>>;
    onUpdate(callback: (state: WorktreeState) => void): () => void;
    onRemove(callback: (data: { worktreeId: string }) => void): () => void;
    onActivated(callback: (data: { worktreeId: string }) => void): () => void;
  };
  terminal: {
    spawn(options: TerminalSpawnOptions): Promise<string>;
    write(id: string, data: string): void;
    submit(id: string, text: string): Promise<void>;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    trash(id: string): Promise<void>;
    restore(id: string): Promise<boolean>;
    setActivityTier(id: string, tier: PtyHostActivityTier): void;
    wake(id: string): Promise<{ state: string | null; warnings?: string[] }>;
    acknowledgeData(id: string, length: number): void;
    getForProject(projectId: string): Promise<BackendTerminalInfo[]>;
    getAvailableTerminals(): Promise<BackendTerminalInfo[]>;
    getTerminalsByState(state: import("../agent.js").AgentState): Promise<BackendTerminalInfo[]>;
    getAllTerminals(): Promise<BackendTerminalInfo[]>;
    reconnect(terminalId: string): Promise<TerminalReconnectResult>;
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
    onAllAgentsClear(callback: (data: { timestamp: number }) => void): () => void;
    onActivity(callback: (data: TerminalActivityPayload) => void): () => void;
    onTrashed(callback: (data: { id: string; expiresAt: number }) => void): () => void;
    onRestored(callback: (data: { id: string }) => void): () => void;
    forceResume(id: string): Promise<{ success: boolean; error?: string }>;
    onStatus(callback: (data: TerminalStatusPayload) => void): () => void;
    onResourceMetrics(
      callback: (data: { metrics: TerminalResourceBatchPayload; timestamp: number }) => void
    ): () => void;
    onBackendCrashed(
      callback: (data: {
        crashType: string;
        code: number | null;
        signal: string | null;
        timestamp: number;
      }) => void
    ): () => void;
    onBackendReady(callback: () => void): () => void;
    sendKey(id: string, key: string): void;
    reportTitleState(id: string, state: "working" | "waiting"): void;
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
  slashCommands: {
    list(payload: SlashCommandListRequest): Promise<SlashCommand[]>;
  };
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
      options?: CopyTreeOptions
    ): Promise<import("./copyTree.js").CopyTreeTestConfigResult>;
    onProgress(callback: (progress: CopyTreeProgress) => void): () => void;
  };
  editor: {
    getConfig(projectId?: string): Promise<import("../editor.js").EditorGetConfigResult>;
    setConfig(payload: import("../editor.js").EditorSetConfigPayload): Promise<void>;
    discover(): Promise<import("../editor.js").DiscoveredEditor[]>;
  };
  system: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    openInEditor(payload: SystemOpenInEditorPayload & { projectId?: string }): Promise<void>;
    checkCommand(command: string): Promise<boolean>;
    checkDirectory(path: string): Promise<boolean>;
    getHomeDir(): Promise<string>;
    getTmpDir(): Promise<string>;
    getCliAvailability(): Promise<CliAvailability>;
    refreshCliAvailability(): Promise<CliAvailability>;
    getAgentVersions(): Promise<AgentVersionInfo[]>;
    refreshAgentVersions(): Promise<AgentVersionInfo[]>;
    getAgentUpdateSettings(): Promise<AgentUpdateSettings>;
    setAgentUpdateSettings(settings: AgentUpdateSettings): Promise<void>;
    startAgentUpdate(payload: StartAgentUpdatePayload): Promise<StartAgentUpdateResult>;
    healthCheck(agentIds?: string[]): Promise<SystemHealthCheckResult>;
    getHealthCheckSpecs(agentIds?: string[]): Promise<PrerequisiteSpec[]>;
    checkTool(spec: PrerequisiteSpec): Promise<PrerequisiteCheckResult>;
    downloadDiagnostics(): Promise<boolean>;
    getAppMetrics(): Promise<import("./system.js").AppMetricsSummary>;
    getHardwareInfo(): Promise<import("./system.js").HardwareInfo>;
    getProcessMetrics(): Promise<import("./system.js").ProcessMetricEntry[]>;
    getHeapStats(): Promise<import("./system.js").HeapStats>;
    getDiagnosticsInfo(): Promise<import("./system.js").DiagnosticsInfo>;
    onWake(callback: (data: SystemWakePayload) => void): () => void;
  };
  app: {
    getState(): Promise<AppState>;
    setState(partialState: Partial<AppState>): Promise<void>;
    getVersion(): Promise<string>;
    hydrate(): Promise<HydrateResult>;
    quit(): Promise<void>;
    forceQuit(): Promise<void>;
    onMenuAction(callback: (action: string) => void): () => void;
  };
  menu: {
    showContext(payload: ShowContextMenuPayload): Promise<string | null>;
  };
  logs: {
    getAll(filters?: LogFilterOptions): Promise<LogEntry[]>;
    getSources(): Promise<string[]>;
    clear(): Promise<void>;
    openFile(): Promise<void>;
    setVerbose(enabled: boolean): Promise<{ success: boolean }>;
    getVerbose(): Promise<boolean>;
    onEntry(callback: (entry: LogEntry) => void): () => void;
    onBatch(callback: (entries: LogEntry[]) => void): () => void;
    write(
      level: "debug" | "info" | "warn" | "error",
      message: string,
      context?: Record<string, unknown>
    ): Promise<void>;
  };
  errors: {
    onError(callback: (error: AppError) => void): () => void;
    retry(errorId: string, action: RetryAction, args?: Record<string, unknown>): Promise<void>;
    cancelRetry(errorId: string): void;
    onRetryProgress(callback: (payload: RetryProgressPayload) => void): () => void;
    openLogs(): Promise<void>;
    getPending(): Promise<AppError[]>;
  };
  eventInspector: {
    getEvents(): Promise<EventRecord[]>;
    getFiltered(filters: EventFilterOptions): Promise<EventRecord[]>;
    clear(): Promise<void>;
    subscribe(): void;
    unsubscribe(): void;
    onEvent(callback: (event: EventRecord) => void): () => void;
  };
  events: {
    emit(eventType: string, payload: unknown): Promise<void>;
  };
  project: {
    getAll(): Promise<Project[]>;
    getCurrent(): Promise<Project | null>;
    add(path: string): Promise<Project>;
    remove(projectId: string): Promise<void>;
    update(projectId: string, updates: Partial<Project>): Promise<Project>;
    switch(projectId: string): Promise<Project>;
    openDialog(): Promise<string | null>;
    onSwitch(
      callback: (payload: {
        project: Project;
        switchId: string;
        worktreeLoadError?: string;
      }) => void
    ): () => void;
    getSettings(projectId: string): Promise<ProjectSettings>;
    saveSettings(projectId: string, settings: ProjectSettings): Promise<void>;
    detectRunners(projectId: string): Promise<RunCommand[]>;
    /**
     * Close/background a project.
     * @param projectId - Project ID to close
     * @param options - Optional: { killTerminals: true } to kill running terminals (default: false, just backgrounds)
     */
    close(projectId: string, options?: { killTerminals?: boolean }): Promise<ProjectCloseResult>;
    /**
     * Reopen a background project, making it the active project.
     * Terminals that were running in the background will be reconnected.
     */
    reopen(projectId: string): Promise<Project>;
    getStats(projectId: string): Promise<ProjectStats>;
    getBulkStats(projectIds: string[]): Promise<BulkProjectStats>;
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
    getRecipes(projectId: string): Promise<TerminalRecipe[]>;
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
     * Enable in-repo settings mode: writes current identity and settings to .canopy/,
     * then sets project.inRepoSettings = true.
     */
    enableInRepoSettings(projectId: string): Promise<Project>;
    /**
     * Disable in-repo settings mode: clears project.inRepoSettings flag.
     * Does NOT delete .canopy/ files.
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
  globalRecipes: {
    getRecipes(): Promise<TerminalRecipe[]>;
    addRecipe(recipe: TerminalRecipe): Promise<void>;
    updateRecipe(
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void>;
    deleteRecipe(recipeId: string): Promise<void>;
  };
  agentSettings: {
    get(): Promise<AgentSettings>;
    set(agentId: AgentId, settings: Partial<AgentSettingsEntry>): Promise<AgentSettings>;
    reset(agentId?: AgentId): Promise<AgentSettings>;
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
  github: {
    getRepoStats(cwd: string, bypassCache?: boolean): Promise<RepositoryStats>;
    getProjectHealth(cwd: string, bypassCache?: boolean): Promise<ProjectHealthData>;
    openIssues(cwd: string, query?: string, state?: string): Promise<void>;
    openPRs(cwd: string, query?: string, state?: string): Promise<void>;
    openCommits(cwd: string, branch?: string): Promise<void>;
    openIssue(cwd: string, issueNumber: number): Promise<void>;
    openPR(prUrl: string): Promise<void>;
    checkCli(): Promise<GitHubCliStatus>;
    getConfig(): Promise<GitHubTokenConfig>;
    setToken(token: string): Promise<GitHubTokenValidation>;
    clearToken(): Promise<void>;
    validateToken(token: string): Promise<GitHubTokenValidation>;
    listIssues(options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "all";
      cursor?: string;
      bypassCache?: boolean;
      sortOrder?: import("../github.js").GitHubSortOrder;
    }): Promise<import("../github.js").GitHubListResponse<import("../github.js").GitHubIssue>>;
    listPullRequests(options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
      bypassCache?: boolean;
      sortOrder?: import("../github.js").GitHubSortOrder;
    }): Promise<import("../github.js").GitHubListResponse<import("../github.js").GitHubPR>>;
    assignIssue(cwd: string, issueNumber: number, username: string): Promise<void>;
    getIssueTooltip(
      cwd: string,
      issueNumber: number
    ): Promise<import("../github.js").IssueTooltipData | null>;
    getPRTooltip(
      cwd: string,
      prNumber: number
    ): Promise<import("../github.js").PRTooltipData | null>;
    getIssueUrl(cwd: string, issueNumber: number): Promise<string | null>;
    getIssueByNumber(
      cwd: string,
      issueNumber: number
    ): Promise<import("../github.js").GitHubIssue | null>;
    getPRByNumber(cwd: string, prNumber: number): Promise<import("../github.js").GitHubPR | null>;
    listRemotes(cwd: string): Promise<import("./github.js").RemoteInfo[]>;
    onPRDetected(callback: (data: PRDetectedPayload) => void): () => void;
    onPRCleared(callback: (data: PRClearedPayload) => void): () => void;
    onIssueDetected(callback: (data: IssueDetectedPayload) => void): () => void;
    onIssueNotFound(callback: (data: IssueNotFoundPayload) => void): () => void;
  };
  notes: {
    create(
      title: string,
      scope: "worktree" | "project",
      worktreeId?: string
    ): Promise<{
      metadata: {
        id: string;
        title: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        tags?: string[];
      };
      content: string;
      path: string;
      lastModified: number;
    }>;
    read(notePath: string): Promise<{
      metadata: {
        id: string;
        title: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        tags?: string[];
      };
      content: string;
      path: string;
      lastModified: number;
    }>;
    write(
      notePath: string,
      content: string,
      metadata: {
        id: string;
        title: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        tags?: string[];
      },
      expectedLastModified?: number
    ): Promise<{
      lastModified?: number;
      error?: "conflict";
      message?: string;
      currentLastModified?: number;
    }>;
    list(): Promise<
      Array<{
        id: string;
        title: string;
        path: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        modifiedAt: number;
        preview: string;
        tags: string[];
      }>
    >;
    delete(notePath: string): Promise<void>;
    search(query: string): Promise<{
      notes: Array<{
        id: string;
        title: string;
        path: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        modifiedAt: number;
        preview: string;
        tags: string[];
      }>;
      query: string;
    }>;
    onUpdated(
      callback: (data: {
        notePath: string;
        title: string;
        action: "created" | "updated" | "deleted";
      }) => void
    ): () => void;
  };
  devPreview: {
    ensure(request: DevPreviewEnsureRequest): Promise<DevPreviewSessionState>;
    restart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState>;
    stop(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState>;
    stopByPanel(request: DevPreviewStopByPanelRequest): Promise<void>;
    getState(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState>;
    onStateChanged(callback: (data: DevPreviewStateChangedPayload) => void): () => void;
  };
  git: {
    getFileDiff(cwd: string, filePath: string, status: GitStatus): Promise<string>;
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
    }): Promise<import("../github.js").GitCommitListResponse>;
    stageFile(cwd: string, filePath: string): Promise<void>;
    unstageFile(cwd: string, filePath: string): Promise<void>;
    stageAll(cwd: string): Promise<void>;
    unstageAll(cwd: string): Promise<void>;
    commit(cwd: string, message: string): Promise<{ hash: string; summary: string }>;
    push(cwd: string, setUpstream?: boolean): Promise<{ success: boolean; error?: string }>;
    getStagingStatus(cwd: string): Promise<StagingStatus>;
    compareWorktrees(
      cwd: string,
      branch1: string,
      branch2: string,
      filePath?: string,
      useMergeBase?: boolean
    ): Promise<import("./git.js").CrossWorktreeDiffResult | string>;
    getUsername(cwd: string): Promise<string | null>;
    getWorkingDiff(cwd: string, type: "unstaged" | "staged" | "head"): Promise<string>;
    snapshotGet(worktreeId: string): Promise<SnapshotInfo | null>;
    snapshotList(): Promise<SnapshotInfo[]>;
    snapshotRevert(worktreeId: string): Promise<SnapshotRevertResult>;
    snapshotDelete(worktreeId: string): Promise<void>;
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
    setCustomSchemes(schemesJson: string): Promise<void>;
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
  };
  accessibility: {
    getEnabled(): Promise<boolean>;
    onSupportChanged(callback: (data: { enabled: boolean }) => void): () => void;
  };
  portal: {
    create(payload: import("../portal.js").PortalCreatePayload): Promise<void>;
    show(payload: import("../portal.js").PortalShowPayload): Promise<void>;
    hide(): Promise<void>;
    resize(bounds: import("../portal.js").PortalBounds): Promise<void>;
    closeTab(payload: import("../portal.js").PortalCloseTabPayload): Promise<void>;
    navigate(payload: import("../portal.js").PortalNavigatePayload): Promise<void>;
    goBack(tabId: string): Promise<boolean>;
    goForward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<void>;
    showNewTabMenu(payload: import("../portal.js").PortalShowNewTabMenuPayload): Promise<void>;
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
    registerPanel(webContentsId: number, panelId: string): Promise<void>;
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
    /** Subscribe to find-in-page shortcuts forwarded from focused webview guests */
    onFindShortcut(
      callback: (payload: { panelId: string; shortcut: "find" | "next" | "prev" | "close" }) => void
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
  };
  hibernation: {
    getConfig(): Promise<HibernationConfig>;
    updateConfig(config: Partial<HibernationConfig>): Promise<HibernationConfig>;
    onProjectHibernated(
      callback: (payload: HibernationProjectHibernatedPayload) => void
    ): () => void;
  };
  systemSleep: {
    /** Get metrics about system sleep tracking */
    getMetrics(): Promise<SystemSleepMetrics>;
    /** Get elapsed awake time since timestamp, excluding sleep periods */
    getAwakeTimeSince(startTimestamp: number): Promise<number>;
    /** Reset accumulated sleep tracking */
    reset(): Promise<void>;
    /** Subscribe to suspend events */
    onSuspend(callback: () => void): () => void;
    /** Subscribe to wake events with sleep duration */
    onWake(callback: (sleepDurationMs: number) => void): () => void;
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
  };
  sound: {
    /** Listen for sound trigger events from main process */
    onTrigger(callback: (payload: { soundFile: string }) => void): () => void;
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
  };
  gemini: {
    /** Get Gemini config status (exists, alternate buffer enabled) */
    getStatus(): Promise<{ exists: boolean; alternateBufferEnabled: boolean; error?: string }>;
    /** Enable alternate buffer in Gemini settings */
    enableAlternateBuffer(): Promise<{ success: boolean }>;
  };
  commands: {
    /** List all registered commands */
    list(context?: CommandContext): Promise<CommandManifestEntry[]>;
    /** Get a specific command by ID */
    get(payload: CommandGetPayload): Promise<CommandManifestEntry | null>;
    /** Execute a command */
    execute(payload: CommandExecutePayload): Promise<CommandResult>;
    /** Get builder configuration for a command */
    getBuilder(commandId: string): Promise<{ steps: BuilderStep[] } | null>;
  };
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
  agentCapabilities: {
    /** Get effective registry (built-in + user overrides) */
    getRegistry(): Promise<AgentRegistry>;
    /** Get list of effective agent IDs */
    getAgentIds(): Promise<string[]>;
    /** Get metadata for specific agent */
    getAgentMetadata(agentId: string): Promise<AgentMetadata | null>;
    /** Check if agent is enabled/available */
    isAgentEnabled(agentId: string): Promise<boolean>;
  };
  agentSessionHistory: {
    list(worktreeId?: string): Promise<AgentSessionRecord[]>;
    clear(worktreeId?: string): Promise<void>;
  };
  clipboard: {
    saveImage(): Promise<
      { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string }
    >;
    thumbnailFromPath(
      filePath: string
    ): Promise<
      { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string }
    >;
  };
  webUtils: {
    getPathForFile(file: File): string;
  };
  appTheme: {
    get(): Promise<AppThemeConfig>;
    setColorScheme(schemeId: string): Promise<void>;
    setCustomSchemes(schemesJson: string): Promise<void>;
    importTheme(): Promise<import("../appTheme.js").AppThemeImportResult>;
    exportTheme(scheme: import("../appTheme.js").AppColorScheme): Promise<boolean>;
    setColorVisionMode(mode: import("../appTheme.js").ColorVisionMode): Promise<void>;
    setFollowSystem(enabled: boolean): Promise<void>;
    setPreferredDarkScheme(schemeId: string): Promise<void>;
    setPreferredLightScheme(schemeId: string): Promise<void>;
    onSystemAppearanceChanged(
      callback: (payload: { isDark: boolean; schemeId: string }) => void
    ): () => void;
  };
  telemetry: {
    get(): Promise<{ enabled: boolean; hasSeenPrompt: boolean }>;
    setEnabled(enabled: boolean): Promise<void>;
    markPromptShown(): Promise<void>;
    track(event: string, properties: Record<string, unknown>): Promise<void>;
  };
  gpu: {
    getStatus(): Promise<{ hardwareAccelerationDisabled: boolean }>;
    setHardwareAcceleration(enabled: boolean): Promise<void>;
  };
  privacy: {
    getSettings(): Promise<{
      telemetryLevel: "off" | "errors" | "full";
      logRetentionDays: 7 | 30 | 90 | 0;
      dataFolderPath: string;
    }>;
    setTelemetryLevel(level: "off" | "errors" | "full"): Promise<void>;
    setLogRetention(days: 7 | 30 | 90 | 0): Promise<void>;
    openDataFolder(): Promise<void>;
    clearCache(): Promise<void>;
    resetAllData(): Promise<void>;
    getDataFolderPath(): Promise<string>;
  };
  onboarding: {
    get(): Promise<OnboardingState>;
    migrate(payload: {
      agentSelectionDismissed: boolean;
      agentSetupComplete: boolean;
      firstRunToastSeen: boolean;
    }): Promise<OnboardingState>;
    setStep(step: string | null | { step: string | null; agentSetupIds?: string[] }): Promise<void>;
    complete(): Promise<void>;
    markToastSeen(): Promise<void>;
    markNewsletterSeen(): Promise<void>;
    markWaitingNudgeSeen(): Promise<void>;
    getChecklist(): Promise<ChecklistState>;
    dismissChecklist(): Promise<void>;
    markChecklistItem(item: ChecklistItemId): Promise<void>;
    markChecklistCelebrationShown(): Promise<void>;
  };
  milestones: {
    get(): Promise<Record<string, boolean>>;
    markShown(id: string): Promise<void>;
  };
  shortcutHints: {
    getCounts(): Promise<Record<string, number>>;
    incrementCount(actionId: string): Promise<void>;
  };
  voiceInput: {
    getSettings(): Promise<VoiceInputSettings>;
    setSettings(settings: Partial<VoiceInputSettings>): Promise<void>;
    start(): Promise<{ ok: true } | { ok: false; error: string }>;
    stop(): Promise<{ rawText: string | null; correctionId: string | null }>;
    flushParagraph(): Promise<{ rawText: string | null; correctionId: string | null }>;
    sendAudioChunk(chunk: ArrayBuffer): void;
    onTranscriptionDelta(callback: (delta: string) => void): () => void;
    onTranscriptionComplete(
      callback: (payload: { text: string; willCorrect: boolean }) => void
    ): () => void;
    onCorrectionQueued(
      callback: (payload: {
        correctionId: string;
        rawText: string;
        reason?: string;
        segmentCount?: number;
        recentContext?: string[];
      }) => void
    ): () => void;
    onCorrectionReplace(
      callback: (payload: {
        correctionId: string;
        correctedText: string;
        rawText?: string;
        action?: "no_change" | "replace";
        confidence?: "low" | "medium" | "high";
        reason?: string;
        segmentCount?: number;
        recentContext?: string[];
        edits?: Array<{ start: number; end: number; fromText: string; toText: string }>;
      }) => void
    ): () => void;
    onParagraphBoundary(
      callback: (payload: { rawText: string | null; correctionId: string | null }) => void
    ): () => void;
    onError(callback: (error: string) => void): () => void;
    onStatus(callback: (status: VoiceInputStatus) => void): () => void;
    checkMicPermission(): Promise<MicPermissionStatus>;
    requestMicPermission(): Promise<boolean>;
    openMicSettings(): Promise<void>;
    validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;
    validateCorrectionApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }>;
  };
  mcpServer: {
    /** Get current MCP server status and configuration */
    getStatus(): Promise<{
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    }>;
    /** Enable or disable the MCP server */
    setEnabled(enabled: boolean): Promise<{
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    }>;
    /** Set a fixed port (null = auto-assign ephemeral port) */
    setPort(port: number | null): Promise<{
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    }>;
    /** Set the API key for bearer token authentication (empty string = no auth) */
    setApiKey(apiKey: string): Promise<{
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    }>;
    /** Generate a random API key and persist it */
    generateApiKey(): Promise<string>;
    /** Get the JSON config snippet to paste into an MCP client config */
    getConfigSnippet(): Promise<string>;
  };
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
      }) => void
    ): () => void;
    /** Send action dispatch result to main process */
    sendDispatchActionResponse(payload: {
      requestId: string;
      result: import("../actions.js").ActionDispatchResult;
    }): void;
  };
  plugin: {
    list(): Promise<import("../plugin.js").LoadedPluginInfo[]>;
    invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown>;
    on(pluginId: string, channel: string, callback: (payload: unknown) => void): () => void;
    toolbarButtons(): Promise<
      import("../../config/toolbarButtonRegistry.js").ToolbarButtonConfig[]
    >;
    menuItems(): Promise<
      Array<{
        pluginId: string;
        item: import("../plugin.js").MenuItemContribution;
      }>
    >;
  };
  crashRecovery: {
    getPending(): Promise<import("./crashRecovery.js").PendingCrash | null>;
    resolve(action: import("./crashRecovery.js").CrashRecoveryAction): Promise<void>;
    getConfig(): Promise<import("./crashRecovery.js").CrashRecoveryConfig>;
    setConfig(
      config: Partial<import("./crashRecovery.js").CrashRecoveryConfig>
    ): Promise<import("./crashRecovery.js").CrashRecoveryConfig>;
  };
  help: {
    getFolderPath(): Promise<string | null>;
  };
  demo?: {
    moveTo(x: number, y: number, durationMs: number): Promise<void>;
    moveToSelector(
      selector: string,
      durationMs: number,
      offsetX?: number,
      offsetY?: number
    ): Promise<void>;
    click(): Promise<void>;
    type(selector: string, text: string, cps?: number): Promise<void>;
    setZoom(factor: number, durationMs?: number): Promise<void>;
    screenshot(): Promise<DemoScreenshotResult>;
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    sleep(durationMs: number): Promise<void>;
    startCapture(payload: DemoStartCapturePayload): Promise<DemoStartCaptureResult>;
    stopCapture(): Promise<DemoStopCaptureResult>;
    getCaptureStatus(): Promise<DemoCaptureStatus>;
    encode(payload: DemoEncodePayload): Promise<DemoEncodeResult>;
    onEncodeProgress(callback: (event: DemoEncodeProgressEvent) => void): () => void;
    onExecCommand(
      channel: string,
      callback: (payload: Record<string, unknown>) => void
    ): () => void;
    sendCommandDone(requestId: string, error?: string): void;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
  };
}

export type MicPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

export type VoiceTranscriptionModel = "nova-3" | "nova-2";

export type VoiceCorrectionModel = "gpt-5-nano" | "gpt-5-mini";

/**
 * Paragraphing strategy for voice dictation.
 *
 * "spoken-command" (default): The user says "new paragraph" to insert a paragraph break.
 *   Deepgram Dictation mode intercepts spoken commands ("new paragraph" → \n\n, "period" → ".",
 *   "new line" → \n, etc.) rather than transcribing them literally. Manual Enter is always
 *   available as a secondary mechanism.
 *
 * "manual": Paragraph breaks are inserted only via the Enter key. No spoken commands.
 *   Best for users who prefer keyboard control or find spoken formatting commands awkward.
 *
 * Note: Deepgram's `paragraphs: true` parameter was evaluated and rejected as the primary
 * mechanism — in live streaming it populates a structured JSON object rather than injecting
 * \n\n into the transcript text, making it unreliable as an auto-paragraphing trigger.
 * Custom keyword detection was also evaluated and rejected in favor of Deepgram Dictation,
 * which natively handles the "new paragraph" command in Nova-3.
 */
export type VoiceParagraphingStrategy = "spoken-command" | "manual";

export interface VoiceInputSettings {
  enabled: boolean;
  deepgramApiKey: string;
  correctionApiKey: string;
  language: string;
  customDictionary: string[];
  transcriptionModel: VoiceTranscriptionModel;
  correctionEnabled: boolean;
  correctionModel: VoiceCorrectionModel;
  correctionCustomInstructions: string;
  /** Controls how paragraph breaks are inserted during dictation. Defaults to "spoken-command". */
  paragraphingStrategy: VoiceParagraphingStrategy;
}
