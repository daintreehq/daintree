import type {
  WorktreeState,
  Project,
  ProjectSettings,
  RunCommand,
  GitStatus,
  AgentId,
  TerminalRecipe,
  TerminalSnapshot,
  TabGroup,
} from "../domain.js";
import type { AgentSettings, AgentSettingsEntry } from "../agentSettings.js";

import type {
  CreateWorktreeOptions,
  BranchInfo,
  WorktreeConfig,
  CreateForTaskPayload,
  CleanupTaskOptions,
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
import type {
  CopyTreeResult,
  CopyTreeOptions,
  FileTreeNode,
  CopyTreeProgress,
} from "./copyTree.js";
import type {
  SystemWakePayload,
  CliAvailability,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
} from "./system.js";
import type { AppState, HydrateResult } from "./app.js";
import type { LogEntry, LogFilterOptions } from "./logs.js";
import type { RetryAction, AppError } from "./errors.js";
import type { EventRecord, EventFilterOptions } from "./events.js";
import type { ProjectCloseResult, ProjectStats } from "./project.js";
import type {
  RepositoryStats,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
} from "./github.js";
import type { TerminalConfig } from "./config.js";
import type { HibernationConfig } from "./hibernation.js";
import type { SystemSleepMetrics } from "./systemSleep.js";
import type { KeyAction } from "../keymap.js";
import type { TerminalStatusPayload, PtyHostActivityTier, SpawnResult } from "../pty-host.js";
import type { ShowContextMenuPayload } from "../menu.js";
import type { FileSearchPayload, FileSearchResult } from "./files.js";
import type { SlashCommand, SlashCommandListRequest } from "../slashCommands.js";
import type { DevPreviewStatusPayload, DevPreviewUrlPayload } from "./devPreview.js";
import type {
  CommandContext,
  CommandManifestEntry,
  CommandResult,
  CommandExecutePayload,
  CommandGetPayload,
  BuilderStep,
} from "../commands.js";
import type { AppAgentConfig } from "../appAgent.js";
import type { ActionManifestEntry, ActionContext } from "../actions.js";
import type { AssistantMessage, AssistantChunkPayload } from "../assistant.js";
import type { AgentRegistry, AgentMetadata } from "./agentCapabilities.js";

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
    onUpdate(callback: (state: WorktreeState) => void): () => void;
    onRemove(callback: (data: { worktreeId: string }) => void): () => void;
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
    getTerminalsByState(state: import("../domain.js").AgentState): Promise<BackendTerminalInfo[]>;
    getAllTerminals(): Promise<BackendTerminalInfo[]>;
    reconnect(terminalId: string): Promise<TerminalReconnectResult>;
    replayHistory(terminalId: string, maxLines?: number): Promise<{ replayed: number }>;
    getSerializedState(terminalId: string): Promise<string | null>;
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
    onActivity(callback: (data: TerminalActivityPayload) => void): () => void;
    onTrashed(callback: (data: { id: string; expiresAt: number }) => void): () => void;
    onRestored(callback: (data: { id: string }) => void): () => void;
    forceResume(id: string): Promise<{ success: boolean; error?: string }>;
    onStatus(callback: (data: TerminalStatusPayload) => void): () => void;
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
    onSpawnResult(callback: (id: string, result: SpawnResult) => void): () => void;
  };
  files: {
    search(payload: FileSearchPayload): Promise<FileSearchResult>;
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
  system: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    checkCommand(command: string): Promise<boolean>;
    checkDirectory(path: string): Promise<boolean>;
    getHomeDir(): Promise<string>;
    getCliAvailability(): Promise<CliAvailability>;
    refreshCliAvailability(): Promise<CliAvailability>;
    getAgentVersions(): Promise<AgentVersionInfo[]>;
    refreshAgentVersions(): Promise<AgentVersionInfo[]>;
    getAgentUpdateSettings(): Promise<AgentUpdateSettings>;
    setAgentUpdateSettings(settings: AgentUpdateSettings): Promise<void>;
    startAgentUpdate(payload: StartAgentUpdatePayload): Promise<StartAgentUpdateResult>;
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
    openLogs(): Promise<void>;
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
    onSwitch(callback: (payload: { project: Project; switchId: string }) => void): () => void;
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
    initGit(directoryPath: string): Promise<void>;
    getRecipes(projectId: string): Promise<TerminalRecipe[]>;
    saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void>;
    addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void>;
    updateRecipe(
      projectId: string,
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void>;
    deleteRecipe(projectId: string, recipeId: string): Promise<void>;
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
    openIssues(cwd: string): Promise<void>;
    openPRs(cwd: string): Promise<void>;
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
    }): Promise<import("../github.js").GitHubListResponse<import("../github.js").GitHubIssue>>;
    listPullRequests(options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
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
    onPRDetected(callback: (data: PRDetectedPayload) => void): () => void;
    onPRCleared(callback: (data: PRClearedPayload) => void): () => void;
    onIssueDetected(callback: (data: IssueDetectedPayload) => void): () => void;
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
    attach(terminalId: string, cwd: string, devCommand?: string): Promise<void>;
    detach(panelId: string): Promise<void>;
    setUrl(panelId: string, url: string): Promise<void>;
    onStatus(callback: (data: DevPreviewStatusPayload) => void): () => void;
    onUrl(callback: (data: DevPreviewUrlPayload) => void): () => void;
    onRecovery(
      callback: (data: { panelId: string; command: string; attempt: number }) => void
    ): () => void;
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
  };
  terminalConfig: {
    get(): Promise<TerminalConfig>;
    setScrollback(scrollbackLines: number): Promise<void>;
    setPerformanceMode(performanceMode: boolean): Promise<void>;
    setFontSize(fontSize: number): Promise<void>;
    setFontFamily(fontFamily: string): Promise<void>;
    setHybridInputEnabled(enabled: boolean): Promise<void>;
    setHybridInputAutoFocus(enabled: boolean): Promise<void>;
  };
  sidecar: {
    create(payload: import("../sidecar.js").SidecarCreatePayload): Promise<void>;
    show(payload: import("../sidecar.js").SidecarShowPayload): Promise<void>;
    hide(): Promise<void>;
    resize(bounds: import("../sidecar.js").SidecarBounds): Promise<void>;
    closeTab(payload: import("../sidecar.js").SidecarCloseTabPayload): Promise<void>;
    navigate(payload: import("../sidecar.js").SidecarNavigatePayload): Promise<void>;
    goBack(tabId: string): Promise<boolean>;
    goForward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<void>;
    showNewTabMenu(payload: import("../sidecar.js").SidecarShowNewTabMenuPayload): Promise<void>;
    onNavEvent(callback: (data: import("../sidecar.js").SidecarNavEvent) => void): () => void;
    onFocus(callback: () => void): () => void;
    onBlur(callback: () => void): () => void;
    onNewTabMenuAction(
      callback: (action: import("../sidecar.js").SidecarNewTabMenuAction) => void
    ): () => void;
  };
  hibernation: {
    getConfig(): Promise<HibernationConfig>;
    updateConfig(config: Partial<HibernationConfig>): Promise<HibernationConfig>;
  };
  systemSleep: {
    /** Get metrics about system sleep tracking */
    getMetrics(): Promise<SystemSleepMetrics>;
    /** Get elapsed awake time since timestamp, excluding sleep periods */
    getAwakeTimeSince(startTimestamp: number): Promise<number>;
    /** Reset accumulated sleep tracking */
    reset(): Promise<void>;
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
    /** Close window */
    close(): Promise<void>;
  };
  notification: {
    /** Update window title and dock badge based on terminal attention state */
    updateBadge(state: { waitingCount: number; failedCount: number }): void;
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
      }) => void
    ): () => void;
    /** Send action dispatch response back to main process */
    sendDispatchActionResponse(payload: {
      requestId: string;
      result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    }): void;
  };
  assistant: {
    /** Send a message to the assistant and receive streaming response with optional tool calling */
    sendMessage(payload: {
      sessionId: string;
      messages: AssistantMessage[];
      actions?: ActionManifestEntry[];
      context?: ActionContext;
    }): Promise<void>;
    /** Cancel an active streaming session */
    cancel(sessionId: string): Promise<void>;
    /** Clear session and remove all listeners associated with it */
    clearSession(sessionId: string): Promise<void>;
    /** Check if API key is configured (uses appAgentConfig) */
    hasApiKey(): Promise<boolean>;
    /** Acknowledge a pending event by ID */
    acknowledgeEvent(sessionId: string, eventId: string): Promise<boolean>;
    /** Subscribe to streaming chunks from the assistant */
    onChunk(callback: (data: AssistantChunkPayload) => void): () => void;
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
}
