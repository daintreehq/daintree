import type { GitRemoteCommitPreview, StagingStatus } from "../git.js";
import type { AgentId } from "../agent.js";
import type {
  VoiceInputError,
  VoiceInputStatus,
  VoiceLiveSessionUpdate,
  VoiceLiveLevel,
  VoicePauseRequest,
  VoiceRevealRequest,
  VoiceSessionEndReason,
  VoiceStopRequest,
} from "../voice.js";
import type {
  VoiceCorrectionTiming,
  VoiceCorrectionVerdict,
  VoicePrefetchMatch,
  VoiceSessionReport,
} from "../voiceSessionSummary.js";
import type {
  Project,
  ProjectAddOptions,
  ProjectSettings,
  RecipeNameCollision,
  RunCommand,
  TerminalRecipe,
} from "../project.js";
import type { GitInitOptions, GitInitProgressEvent, GitInitResult } from "./gitInit.js";
import type { GitPushPayload, PushProgressEvent } from "./gitPush.js";
import type { AgentSettings } from "../agentSettings.js";
import type { AgentPreset } from "../../config/agentRegistry.js";
import type { UserAgentRegistry, UserAgentConfig } from "../userAgentRegistry.js";
import type { KeyAction } from "../keymap.js";
import type { TerminalExitContext } from "../terminal.js";
import type {
  KeybindingImportResult,
  KeybindingOverridesSnapshot,
  MicPermissionStatus,
  NotificationSettings,
  VoiceCleanupFailure,
  VoiceCorrectionPace,
  VoiceInputSettings,
  VoiceInputSettingsPatch,
} from "./api.js";

import type { TerminalActivityPayload } from "./terminal.js";
import type {
  AgentStateChangePayload,
  AgentStateTransitionDroppedPayload,
  AgentDetectedPayload,
  AgentRateLimitObservedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  ArtifactDetectedPayload,
  AgentHelpRequest,
  AgentHelpResult,
} from "./agent.js";
import type {
  CopyTreeGeneratePayload,
  CopyTreeResult,
  CopyTreeGenerateAndCopyFilePayload,
  CopyTreeInjectPayload,
  CopyTreeCancelPayload,
  CopyTreeGetFileTreePayload,
  CopyTreeTestConfigPayload,
  CopyTreeTestConfigResult,
  FileTreeNode,
  CopyTreeProgress,
} from "./copyTree.js";
import type {
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  SystemOpenInEditorPayload,
  SystemOpenInEditorFallback,
  SystemWakePayload,
  SystemMemoryPressurePayload,
  CliAvailability,
  AgentCliDetails,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  SystemHealthCheckOptions,
  SystemHealthCheckResult,
  AppMetricsSummary,
  HardwareInfo,
  ProcessMetricEntry,
  HeapStats,
  DiagnosticsInfo,
  AgentInstallPayload,
  AgentInstallResult,
  AgentInstallProgressEvent,
} from "./system.js";
import type { AppState, BootResult, HydrateResult } from "./app.js";
import type { LogEntry, LogFilterOptions } from "./logs.js";
import type { RetryAction, ErrorRecord, RetryProgressPayload } from "./errors.js";
import type { EventRecord } from "./events.js";
import type {
  ProjectCloseResult,
  ProjectStats,
  ProjectStatusMap,
  ProjectSwitchPayload,
  ProjectSwitchOutgoingState,
  ProjectWorktreeLoadStatusPayload,
  ProjectFocusOnActivateIntent,
  ProjectSwitchTrace,
  ProjectSwitchResult,
} from "./project.js";
import type { FleetSnapshot } from "./fleet.js";
import type {
  GitGetFileDiffPayload,
  GitFileDiffResult,
  GitCompareWorktreesPayload,
  CrossWorktreeDiffResult,
} from "./git.js";
import type {
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
} from "./files.js";
import type { DevPreviewStateChangedPayload, DevPreviewAllSessionsPayload } from "./devPreview.js";
import type { ServiceConnectivityPayload } from "./connectivity.js";
import type { AgentDefaultsSnapshot } from "./agentDefaults.js";
import type { AgentToolbarPinsSnapshot } from "./agentToolbarPins.js";
import type { SanitizedTelemetryEvent, TelemetryPreviewState } from "./telemetryPreview.js";
import type { ProjectPulse, PulseRangeDays } from "../pulse.js";
import type { GitCommitListOptions, GitCommitListResponse } from "../git.js";
import type {
  SpawnResult,
  TerminalReliabilityMetricPayload,
  TerminalResizeResult,
  TerminalSubmitStatusPayload,
  TerminalFirstPromptPayload,
  TerminalStatusPayload,
  TerminalResourceBatchPayload,
  BroadcastWriteResultPayload,
} from "../pty-host.js";
import type { KeepAwakeState } from "./keepAwake.js";
import type { IdleTerminalNotifyPayload } from "./idleTerminals.js";
import type { IdleBackgroundClosedPayload } from "./idleBackgroundAutoClose.js";
import type { AppThemeConfig } from "../appTheme.js";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
} from "./demo.js";
import type { BulkProjectStats } from "./project.js";
import type { Scratch } from "../scratch.js";
import type { ScratchSwitchPayload } from "./scratch.js";
import type {
  PrerequisiteSpec,
  PrerequisiteCheckResult,
  DiagnosticsReviewPayload,
  DiagnosticsBundleSavePayload,
} from "./system.js";
import type { CloneRepoProgressEvent } from "./gitClone.js";
import type { AppAgentConfig } from "../appAgent.js";
import type { GeneratedIpcInvokeMap } from "./generated.js";
import type {
  AuthValidation,
  ForgeProviderEntry,
  ResolvedForgeProvider,
  PushErrorClassification,
  Issue,
  PR,
  Page,
  ListOptions,
  ForgeUser,
} from "../forge.js";
import type {
  ForgeRateLimitChangedPayload,
  ForgeTokenHealthChangedPayload,
  ForgeRepoStatsAndPagePayload,
  ForgeRepoCountsUpdatedPayload,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
} from "./forge.js";

export type ChecklistItemId =
  "openedProject" | "launchedAgent" | "createdWorktree" | "ranSecondParallelAgent";

export interface ChecklistItems {
  openedProject: boolean;
  launchedAgent: boolean;
  createdWorktree: boolean;
  ranSecondParallelAgent: boolean;
}

export interface ChecklistState {
  dismissed: boolean;
  celebrationShown: boolean;
  items: ChecklistItems;
}

/** One tour's progress. Keyed by tour id in `OnboardingState.tours`. */
export interface TourOnboardingState {
  completed: boolean;
  /** The user turned down the tour's invitation; it is never offered again unasked. */
  dismissed: boolean;
  /** Chapter the user last reached, so a reopened tour resumes there. */
  lastChapter: number;
  /**
   * Id of the chapter last reached. Resume keys on it rather than on the
   * index, so reordered chapters still land in the right place. Absent on
   * records written before chapter ids were kept.
   */
  lastChapterId?: string;
  /** The tour's declared content version this progress was recorded against. */
  contentVersion?: string;
  /** The content version that was playing when the tour was last completed. */
  completedVersion?: string;
  /** How the last run that opened ended. */
  lastOutcome?: TourOutcome;
  /** The run {@link lastOutcome} belongs to, as `help.tour.show` reported it. */
  lastRunId?: string;
}

/**
 * How one run of a tour ended. `completed`: played to the end of its last
 * chapter. `dismissed`: closed before that. `superseded`: another tour opened
 * over it. `withdrawn`: its plugin was disabled or reloaded while it was open.
 * `failed`: it couldn't be loaded.
 */
export type TourOutcome = "completed" | "dismissed" | "superseded" | "withdrawn" | "failed";

export interface TourProgressUpdate {
  completed?: boolean;
  lastChapter?: number;
  lastChapterId?: string;
  /** Stamped on every write by a versioned tour; `null` for an unversioned one. */
  contentVersion?: string | null;
  lastOutcome?: TourOutcome;
  lastRunId?: string;
}

export interface OnboardingState {
  schemaVersion: number;
  completed: boolean;
  currentStep: string | null;
  agentSetupIds: string[];
  firstRunToastSeen: boolean;
  newsletterPromptSeen: boolean;
  waitingNudgeSeen: boolean;
  seenAgentIds: string[];
  availabilityFirstSeen: Record<string, number>;
  welcomeCardDismissed: boolean;
  setupBannerDismissed: boolean;
  checklist: ChecklistState;
  /** Progress per tour id; a tour with no entry has never been started. */
  tours: Record<string, TourOnboardingState>;
  /** One narration preference across every tour. */
  tourMuted: boolean;
}

/**
 * The Daintree MCP tool set a help-panel session or agent pane is served:
 * `core` is the orchestration surface, `full` adds the rest. Nothing outside
 * `full` is reachable over MCP at all.
 */
export type HelpAssistantTier = "core" | "full";

/** Serializable toast payload sent from main process to renderer via IPC. */
export interface MainProcessToastPayload {
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  /**
   * Auto-dismiss delay in milliseconds, threaded through to `notify({ duration })`.
   * Omit to use the app's per-type default. Used by plugin-issued toasts that
   * pass `durationMs`.
   */
  duration?: number;
  /**
   * Rate-limit bucket override threaded through to `notify({ rateLimitKey })`.
   * Without this, payloads share a bucket keyed only on `type` (e.g. all
   * `"error"` toasts), so an unrelated burst of errors can absorb a billing-
   * critical notification into a generic overflow row.
   */
  rateLimitKey?: string;
  /**
   * Threaded through to `notify({ rateLimitLabel })`: how the overflow summary
   * names the source when `rateLimitKey` is an internal id.
   */
  rateLimitLabel?: string;
  /**
   * Routing priority threaded through to `notify({ priority })`. Omit for the
   * default `"high"` (toast when focused). `"low"` routes to the history inbox
   * only — never a toast or OS notification — for signals the user can act on
   * later (e.g. a plugin refused by the blocklist / kill-switch, #10891).
   * `"watch"` always shows both an in-app toast and an OS native notification.
   */
  priority?: "high" | "low" | "watch";
  /**
   * Threaded through to `notify({ urgent })`: shown even during quiet hours
   * and the startup quiet period. Only for a notice that loses its point if it
   * waits, such as confirmed database corruption. Never set for a plugin's
   * toast.
   */
  urgent?: boolean;
  action?: {
    label: string;
    /** IPC channel to invoke when the action button is clicked */
    ipcChannel: string;
    /** Optional payload passed to the renderer-side action handler
     *  (e.g. the text to copy for a "clipboard:write-text" action). */
    data?: string;
  };
  /**
   * Buttons from a plugin's `host.notify` (#13505). Main has already held each
   * `actionId` to that plugin's own namespace; a click dispatches it with its
   * `args`.
   */
  pluginActions?: Array<{ label: string; actionId: string; args?: Record<string, unknown> }>;
  /**
   * Replaces the live toast and the inbox row of an earlier notification with
   * the same key (#13505).
   */
  replaceKey?: string;
  /**
   * A switch to another host that failed, for the renderer's one host-switch
   * failure presenter: it picks the recovery from the code (Set up…, Update…,
   * Settings…, Retry), so a launch restore reads like every other entry point.
   * `action` stays as the Retry for a renderer that doesn't know this field.
   */
  hostSwitchFailure?: {
    hostId: string;
    projectId: string;
    code: import("../appError.js").AppErrorCode | null;
  };
  /**
   * Threaded through to `notify({ context })`: what a plugin's toast or
   * notification is about and which plugin raised it (#13818). Main sets every
   * field from the plugin's own binding and its checked target, never from
   * what the plugin wrote.
   */
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
    plugin?: NotificationPluginSource;
  };
}

/**
 * The plugin a notification came from: its instance id, which is the key a
 * silence is stored under (a project plugin's names its project), and the
 * display name the inbox shows.
 */
export interface NotificationPluginSource {
  id: string;
  name: string;
}

/** One plugin the user silenced, as Settings → Notifications lists it (#13818). */
export interface PluginNotificationSilence {
  /** The plugin's instance id, as a notification's `context.plugin.id` names it. */
  pluginId: string;
  /** Its display name while it is loaded, else its manifest id. */
  name: string;
  /** The project a project plugin's silence covers; `null` for an installed plugin. */
  projectId: string | null;
}

// IPC Contract Maps

/** Maps IPC channels to their args/result types for type-safe invoke/handle */
export interface IpcInvokeMap extends GeneratedIpcInvokeMap {
  // Files channels
  "files:search": {
    args: [payload: FileSearchPayload];
    result: FileSearchResult;
  };
  "files:read": {
    args: [payload: FileReadPayload];
    result: FileReadResult;
  };

  // Slash command discovery
  // Agent channels
  "agent-help:get": {
    args: [request: AgentHelpRequest];
    result: AgentHelpResult;
  };

  // CopyTree channels
  "copytree:generate": {
    args: [payload: CopyTreeGeneratePayload];
    result: CopyTreeResult;
  };
  "copytree:generate-and-copy-file": {
    args: [payload: CopyTreeGenerateAndCopyFilePayload];
    result: CopyTreeResult;
  };
  "copytree:inject": {
    args: [payload: CopyTreeInjectPayload];
    result: CopyTreeResult;
  };
  "copytree:available": {
    args: [];
    result: boolean;
  };
  "copytree:cancel": {
    args: [payload: CopyTreeCancelPayload];
    result: void;
  };
  "copytree:get-file-tree": {
    args: [payload: CopyTreeGetFileTreePayload];
    result: FileTreeNode[];
  };
  "copytree:test-config": {
    args: [payload: CopyTreeTestConfigPayload];
    result: CopyTreeTestConfigResult;
  };

  // System channels
  "system:open-external": {
    args: [payload: SystemOpenExternalPayload];
    result: void;
  };
  "system:open-path": {
    args: [payload: SystemOpenPathPayload];
    result: void;
  };
  "system:open-in-editor": {
    args: [payload: SystemOpenInEditorPayload];
    result: SystemOpenInEditorFallback | void;
  };
  "system:check-command": {
    args: [command: string];
    result: boolean;
  };
  "system:check-directory": {
    args: [path: string];
    result: boolean;
  };
  "system:get-home-dir": {
    args: [];
    result: string;
  };
  "system:get-tmp-dir": {
    args: [];
    result: string;
  };
  "system:get-cli-availability": {
    args: [];
    result: CliAvailability;
  };
  "system:refresh-cli-availability": {
    args: [];
    result: CliAvailability;
  };
  "system:get-agent-cli-details": {
    args: [];
    result: AgentCliDetails;
  };
  "system:get-agent-versions": {
    args: [];
    result: AgentVersionInfo[];
  };
  "system:get-agent-version": {
    args: [agentId: string, refresh?: boolean];
    result: AgentVersionInfo;
  };
  "system:refresh-agent-versions": {
    args: [];
    result: AgentVersionInfo[];
  };
  "system:get-agent-update-settings": {
    args: [];
    result: AgentUpdateSettings;
  };
  "system:set-agent-update-settings": {
    args: [settings: AgentUpdateSettings];
    result: void;
  };
  "system:start-agent-update": {
    args: [payload: StartAgentUpdatePayload];
    result: StartAgentUpdateResult;
  };
  "setup:agent-install": {
    args: [payload: AgentInstallPayload];
    result: AgentInstallResult;
  };

  "system:health-check": {
    args: [options?: SystemHealthCheckOptions];
    result: SystemHealthCheckResult;
  };
  "system:download-diagnostics": {
    args: [];
    result: boolean;
  };
  "system:collect-diagnostics-for-review": {
    args: [];
    result: DiagnosticsReviewPayload;
  };
  "system:save-diagnostics-bundle": {
    args: [payload: DiagnosticsBundleSavePayload];
    result: boolean;
  };
  "system:get-app-metrics": {
    args: [];
    result: AppMetricsSummary;
  };
  "system:get-hardware-info": {
    args: [];
    result: HardwareInfo;
  };
  "diagnostics:get-process-metrics": {
    args: [];
    result: ProcessMetricEntry[];
  };
  "diagnostics:get-heap-stats": {
    args: [];
    result: HeapStats;
  };
  "diagnostics:get-info": {
    args: [];
    result: DiagnosticsInfo;
  };
  "system:get-report-enrichment": {
    args: [];
    result: import("./system.js").ReportIssueEnrichment;
  };
  // Renderer reports process.getBlinkMemoryInfo() to ProcessMemoryMonitor.
  // The webContents id is taken from event.sender on the handler side, so
  // a renderer cannot claim to be a different view. All numeric fields are
  // kilobytes (Electron's BlinkMemoryInfo unit, not bytes).
  "system:report-blink-memory": {
    args: [
      payload: {
        requestId: string;
        allocated: number;
        marked?: number;
        total?: number;
        partitionAlloc?: number;
      },
    ];
    result: void;
  };
  // Renderer reports long-animation-frame blocking (LoAF blockingDuration
  // accumulated since the prior sample) to ProcessMemoryMonitor. Not event-loop
  // utilisation, despite the channel name: `blockingDurationMs` counts only the
  // part of each frame past 50ms; main derives the ratio against
  // `sampleWindowMs`. The longest frame and the DOM input-blocking snapshot are
  // optional so a renderer built before them still reports. The webContents id
  // is taken from event.sender on the handler side.
  "system:report-renderer-elu": {
    args: [
      payload: {
        requestId: string;
        blockingDurationMs: number;
        sampleWindowMs: number;
        longestFrameMs?: number;
        longestBlockingMs?: number;
        inputBlocking?: import("./system.js").RendererInputBlockingSnapshot;
      },
    ];
    result: void;
  };
  // Renderer CPU profile capture (Settings > Troubleshooting). Start begins a
  // CDP Profiler session on the calling WebContents with a main-side 15s
  // auto-stop; stop collects the profile and runs the save-dialog flow. The
  // target WebContents is taken from event.sender on the handler side.
  "system:renderer-cpu-profile-start": {
    args: [];
    result: import("./system.js").RendererCpuProfileStartResult;
  };
  "system:renderer-cpu-profile-stop": {
    args: [];
    result: import("./system.js").RendererCpuProfileStopResult;
  };

  // App state channels
  "app:get-state": {
    args: [];
    result: AppState;
  };
  "app:set-state": {
    args: [partialState: Partial<AppState>];
    result: void;
  };
  "app:get-version": {
    args: [];
    result: string;
  };
  "app:hydrate": {
    args: [];
    result: HydrateResult;
  };
  "app:boot": {
    args: [];
    result: BootResult;
  };
  "app:quit": {
    args: [];
    result: void;
  };
  "app:force-quit": {
    args: [];
    result: void;
  };
  "app:reset-and-relaunch": {
    args: [];
    result: void;
  };
  "app:first-interactive": {
    args: [];
    result: void;
  };
  "app:view-painted": {
    args: [];
    result: void;
  };
  "app:view-warm-painted": {
    args: [];
    result: void;
  };
  "app:reload-config": {
    args: [];
    result: { success: boolean };
  };
  // Window channels
  "window:toggle-fullscreen": {
    args: [];
    result: boolean;
  };
  "window:reload": {
    args: [];
    result: void;
  };
  "window:force-reload": {
    args: [];
    result: void;
  };
  "window:toggle-devtools": {
    args: [];
    result: void;
  };
  "window:zoom-in": {
    args: [];
    result: void;
  };
  "window:zoom-out": {
    args: [];
    result: void;
  };
  "window:zoom-reset": {
    args: [];
    result: void;
  };
  "window:close": {
    args: [];
    result: void;
  };

  // Logs channels
  "logs:get-all": {
    args: [filters?: LogFilterOptions];
    result: LogEntry[];
  };
  "logs:get-sources": {
    args: [];
    result: string[];
  };
  "logs:clear": {
    args: [];
    result: void;
  };
  "logs:open-file": {
    args: [];
    result: void;
  };
  "logs:set-verbose": {
    args: [enabled: boolean];
    result: void;
  };
  "logs:get-verbose": {
    args: [];
    result: boolean;
  };
  "logs:write": {
    args: [
      payload: {
        level: "debug" | "info" | "warn" | "error";
        message: string;
        context?: Record<string, unknown>;
      },
    ];
    result: void;
  };
  "logs:get-level-overrides": {
    args: [];
    result: Record<string, string>;
  };
  "logs:set-level-overrides": {
    args: [overrides: Record<string, string>];
    result: { success: boolean };
  };
  "logs:clear-level-overrides": {
    args: [];
    result: { success: boolean };
  };
  "logs:get-registry": {
    args: [];
    result: string[];
  };

  // Error channels
  "error:retry": {
    args: [payload: { errorId: string; action: RetryAction; args?: Record<string, unknown> }];
    result: void;
  };
  "error:open-logs": {
    args: [];
    result: void;
  };
  "error:get-pending": {
    args: [];
    result: ErrorRecord[];
  };

  // Event inspector channels
  "events:emit": {
    args: [eventType: string, payload: unknown];
    result: void;
  };

  // Project channels
  "project:get-all": {
    args: [];
    result: Project[];
  };
  "project:get-current": {
    args: [];
    result: Project | null;
  };
  "project:add": {
    args: [path: string, options?: ProjectAddOptions];
    result: Project;
  };
  "project:remove": {
    args: [projectId: string];
    result: void;
  };
  "project:update": {
    args: [projectId: string, updates: Partial<Project>];
    result: Project;
  };
  "project:switch": {
    args: [
      projectId: string,
      outgoingState?: ProjectSwitchOutgoingState,
      options?: {
        focusIntent?: ProjectFocusOnActivateIntent;
        trace?: ProjectSwitchTrace;
        ignoreMemoryPressure?: boolean;
      },
    ];
    result: ProjectSwitchResult;
  };
  "project:prefetch-hydrate": {
    args: [projectId: string];
    result: void;
  };
  "project:open-dialog": {
    args: [];
    result: string | null;
  };
  "project:get-settings": {
    args: [projectId: string];
    result: ProjectSettings;
  };
  "project:save-settings": {
    args: [payload: { projectId: string; settings: ProjectSettings }];
    result: void;
  };
  "project:detect-runners": {
    args: [projectId: string];
    result: RunCommand[];
  };
  "project:close": {
    args: [projectId: string, options?: { killTerminals?: boolean }];
    result: ProjectCloseResult;
  };
  "project:reopen": {
    args: [
      projectId: string,
      outgoingState?: ProjectSwitchOutgoingState,
      options?: { trace?: ProjectSwitchTrace; ignoreMemoryPressure?: boolean },
    ];
    result: ProjectSwitchResult;
  };
  "project:get-stats": {
    args: [projectId: string];
    result: ProjectStats;
  };
  "project:create-folder": {
    args: [
      payload: {
        parentPath: string;
        folderName: string;
        /** Copied in once the folder exists (#13825); the digest is the previewed list's. */
        template?: import("../plugin.js").ProjectTemplateSelection;
      },
    ];
    result: string;
  };
  "project:init-git": {
    args: [directoryPath: string];
    result: void;
  };
  "project:init-git-guided": {
    args: [options: GitInitOptions];
    result: GitInitResult;
  };
  "project:get-recipes": {
    args: [projectId: string];
    result: { recipes: TerminalRecipe[]; collisions: RecipeNameCollision[] };
  };
  "project:save-recipes": {
    args: [payload: { projectId: string; recipes: TerminalRecipe[] }];
    result: void;
  };
  "project:add-recipe": {
    args: [payload: { projectId: string; recipe: TerminalRecipe }];
    result: void;
  };
  "project:update-recipe": {
    args: [
      payload: {
        projectId: string;
        recipeId: string;
        updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
      },
    ];
    result: void;
  };
  "project:delete-recipe": {
    args: [payload: { projectId: string; recipeId: string }];
    result: void;
  };
  "project:read-claude-md": {
    args: [projectId: string];
    result: string | null;
  };
  "project:write-claude-md": {
    args: [payload: { projectId: string; content: string }];
    result: void;
  };
  "project:enable-in-repo-settings": {
    args: [projectId: string];
    result: Project;
  };
  "project:disable-in-repo-settings": {
    args: [projectId: string];
    result: Project;
  };
  "project:check-missing": {
    args: [];
    result: string[];
  };
  "project:locate": {
    args: [projectId: string];
    result: Project | null;
  };

  // Agent settings channels
  "agent-settings:get": {
    args: [];
    result: AgentSettings;
  };
  "agent-settings:set": {
    args: [payload: { agentType: AgentId; settings: Record<string, unknown> }];
    result: AgentSettings;
  };
  "agent-settings:reset": {
    args: [agentType?: AgentId];
    result: AgentSettings;
  };
  "agent-settings:stamp-version": {
    args: [version: number];
    result: Record<string, unknown>;
  };

  // User agent registry channels
  "user-agent-registry:get": {
    args: [];
    result: UserAgentRegistry;
  };
  "user-agent-registry:add": {
    args: [config: UserAgentConfig];
    result: { success: boolean; error?: string };
  };
  "user-agent-registry:update": {
    args: [payload: { id: string; config: UserAgentConfig }];
    result: { success: boolean; error?: string };
  };
  "user-agent-registry:remove": {
    args: [id: string];
    result: { success: boolean; error?: string };
  };

  // Terminal config channels
  "terminal-config:import-color-scheme": {
    args: [];
    result:
      | {
          ok: true;
          scheme: {
            id: string;
            name: string;
            type: "dark" | "light";
            colors: Record<string, string>;
          };
        }
      | { ok: false; errors: string[] };
  };

  // Accessibility channels
  // Git channels
  "git:get-file-diff": {
    args: [payload: GitGetFileDiffPayload];
    result: GitFileDiffResult;
  };
  "git:get-project-pulse": {
    args: [
      options: {
        worktreeId: string;
        rangeDays: PulseRangeDays;
        includeDelta?: boolean;
        includeRecentCommits?: boolean;
        forceRefresh?: boolean;
      },
    ];
    result: ProjectPulse;
  };
  "git:list-commits": {
    args: [options: GitCommitListOptions];
    result: GitCommitListResponse;
  };
  "git:stage-file": {
    args: [payload: { cwd: string; filePath: string }];
    result: void;
  };
  "git:unstage-file": {
    args: [payload: { cwd: string; filePath: string }];
    result: void;
  };
  "git:stage-files": {
    args: [payload: { cwd: string; filePaths: string[] }];
    result: void;
  };
  "git:unstage-files": {
    args: [payload: { cwd: string; filePaths: string[] }];
    result: void;
  };
  "git:stage-all": {
    args: [cwd: string];
    result: void;
  };
  "git:unstage-all": {
    args: [cwd: string];
    result: void;
  };
  "git:commit": {
    args: [payload: { cwd: string; message: string }];
    result: { hash: string; summary: string };
  };
  "git:push": {
    args: [payload: GitPushPayload];
    /**
     * Resolves on success. Throws `GitOperationError` on failure — the renderer
     * reads `caught.gitReason` to surface a classified recovery hint.
     *
     * On `gitReason === "push-rejected-outdated"` the thrown error also carries
     * `leaseSha` (captured `refs/remotes/origin/<branch>` SHA at rejection
     * time) and `branchName`, used by the divergence-recovery flow to drive
     * `git:force-push-with-lease`.
     */
    result: void;
  };
  "git:pull-rebase": {
    args: [payload: { cwd: string }];
    /**
     * Runs `git pull --rebase origin <currentBranch>`. Throws
     * `GitOperationError` on failure (including `conflict-unresolved` when the
     * rebase halts on a conflict).
     */
    result: void;
  };
  "git:force-push-with-lease": {
    args: [payload: { cwd: string; branchName: string; leaseSha: string }];
    /**
     * Runs `git push origin <branch> --force-with-lease=<branch>:<leaseSha>
     * --force-if-includes`. The lease SHA must come from the `leaseSha` field
     * captured on the original `git:push` rejection error — capturing later
     * (e.g. at click time) lets a background fetch advance the local
     * remote-tracking ref and silently degrade the lease to `--force`.
     */
    result: void;
  };
  "git:list-remote-commits": {
    args: [payload: { cwd: string; branchName: string; limit?: number }];
    /**
     * Returns the parsed commits in `HEAD..<the branch's resolved push ref>` so
     * the force-push confirmation modal can show which remote commits would be
     * discarded, alongside the destination they live on and the full count over
     * the same range. Rows are capped at `limit` (default 20); `total` is not.
     * Rejects when the push destination can't be resolved — an empty list would
     * read as "nothing to discard" (#11746).
     */
    result: GitRemoteCommitPreview;
  };
  "git:get-staging-status": {
    args: [cwd: string];
    result: StagingStatus;
  };
  "git:abort-repository-operation": {
    args: [cwd: string];
    result: void;
  };
  "git:continue-repository-operation": {
    args: [cwd: string];
    result: void;
  };
  "git:scan-conflict-markers": {
    args: [payload: import("./git.js").GitScanConflictMarkersPayload];
    result: import("./git.js").ConflictMarkerScanEntry[];
  };
  "git:checkout-ours-theirs": {
    args: [payload: import("./git.js").GitCheckoutOursTheirsPayload];
    result: void;
  };
  "git:compare-worktrees": {
    args: [payload: GitCompareWorktreesPayload];
    result: CrossWorktreeDiffResult | string;
  };
  "git:get-username": {
    args: [cwd: string];
    result: string | null;
  };
  "git:get-working-diff": {
    args: [payload: { cwd: string; type: "unstaged" | "staged" | "head" }];
    result: string;
  };
  "git:mark-safe-directory": {
    args: [path: string];
    result: void;
  };

  // Portal channels
  // Keybinding channels
  "keybinding:get-overrides": {
    args: [];
    result: KeybindingOverridesSnapshot;
  };
  "keybinding:set-override": {
    args: [payload: { actionId: KeyAction; combo: string[] }];
    result: KeybindingOverridesSnapshot;
  };
  "keybinding:remove-override": {
    args: [actionId: KeyAction];
    result: KeybindingOverridesSnapshot;
  };
  "keybinding:reset-all": {
    args: [];
    result: KeybindingOverridesSnapshot;
  };
  "keybinding:export-profile": {
    args: [];
    result: boolean;
  };
  "keybinding:import-profile": {
    args: [];
    result: KeybindingImportResult;
  };

  // Plugin channels
  // Dev Preview channels
  // Auto-update channels
  "update:quit-and-install": {
    args: [];
    result: void;
  };
  "update:check-for-updates": {
    args: [];
    result: void;
  };
  "update:get-channel": {
    args: [];
    result: "stable" | "nightly";
  };
  "update:set-channel": {
    args: [channel: "stable" | "nightly"];
    result: "stable" | "nightly";
  };
  "update:get-last-check": {
    args: [];
    result: number | null;
  };
  "update:get-latest": {
    args: [];
    result: { version: string; downloaded: boolean } | null;
  };

  // Windows Store update notification channels
  "store-update:get-latest": {
    args: [];
    result: { version: string; storeUrl: string } | null;
  };
  "store-update:dismiss": {
    args: [version: string];
    result: void;
  };
  "store-update:get-settings": {
    args: [];
    result: { enabled: boolean };
  };
  "store-update:set-settings": {
    args: [enabled: boolean];
    result: { enabled: boolean };
  };

  // Clipboard channels — handlers throw `AppError` on failure (CLIPBOARD_EMPTY,
  // CLIPBOARD_INVALID, UNSUPPORTED, VALIDATION). Renderer consumers use
  // try/catch + isClientAppError(e) to branch on e.code.
  // Notification settings channels
  "notification:settings-get": {
    args: [];
    result: NotificationSettings;
  };
  "notification:settings-set": {
    args: [settings: Partial<NotificationSettings>];
    result: void;
  };
  "notification:play-sound": {
    args: [soundFile: string];
    result: void;
  };
  "sound:play-ui-event": {
    args: [soundId: string];
    result: void;
  };
  "sound:get-dir": {
    args: [];
    result: string;
  };

  // App theme channels
  "app-theme:get": {
    args: [];
    result: AppThemeConfig;
  };
  "app-theme:set-color-scheme": {
    args: [schemeId: string];
    result: void;
  };
  "app-theme:set-custom-schemes": {
    args: [schemes: unknown];
    result: void;
  };
  "app-theme:import": {
    args: [];
    result: import("../appTheme.js").AppThemeImportResult;
  };
  "app-theme:export": {
    args: [scheme: import("../appTheme.js").AppColorScheme];
    result: boolean;
  };
  "app-theme:set-color-vision-mode": {
    args: [mode: import("../appTheme.js").ColorVisionMode];
    result: void;
  };
  "app-theme:set-follow-system": {
    args: [enabled: boolean];
    result: void;
  };
  "app-theme:set-preferred-dark-scheme": {
    args: [schemeId: string];
    result: void;
  };
  "app-theme:set-preferred-light-scheme": {
    args: [schemeId: string];
    result: void;
  };
  // GPU
  "gpu:get-status": {
    args: [];
    result: { hardwareAccelerationDisabled: boolean; angleFallbackActive: boolean };
  };
  "gpu:set-hardware-acceleration": {
    args: [enabled: boolean];
    result: void;
  };

  // Forge integration
  "forge:get-settings": {
    args: [];
    result: { defaultProviderId: string | null };
  };
  "forge:set-default-provider": {
    args: [providerId: string | null];
    result: { defaultProviderId: string | null };
  };
  "forge:get-providers": {
    args: [];
    result: ForgeProviderEntry[];
  };
  "forge:resolve-provider": {
    args: [projectId: string, remoteUrl?: string];
    result: ResolvedForgeProvider;
  };
  "forge:open-issues": {
    args: [cwd: string, query?: string, state?: string];
    /** The page's URL for a caller on another machine, whose Shell opens it; nothing here. */
    result: string | undefined;
  };
  "forge:open-prs": {
    args: [cwd: string, query?: string, state?: string];
    /** The page's URL for a caller on another machine, whose Shell opens it; nothing here. */
    result: string | undefined;
  };
  "forge:open-commits": {
    args: [cwd: string, branch?: string];
    /** The page's URL for a caller on another machine, whose Shell opens it; nothing here. */
    result: string | undefined;
  };
  "forge:open-issue": {
    args: [payload: { cwd: string; issueNumber: number }];
    /** The page's URL for a caller on another machine, whose Shell opens it; nothing here. */
    result: string | undefined;
  };
  "forge:get-issue-url": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: string;
  };
  "forge:assign-issue": {
    args: [payload: { cwd: string; issueNumber: number; username: string }];
    result: ForgeUser[];
  };
  "forge:validate-token": {
    args: [payload: { providerId: string; token: string }];
    result: AuthValidation;
  };
  "forge:set-credential": {
    args: [providerId: string, credentials: Record<string, string>];
    result: AuthValidation;
  };
  "forge:get-credential-status": {
    args: [providerId: string];
    result: { hasCredential: boolean; fingerprint?: string };
  };
  "forge:clear-credential": {
    args: [providerId: string];
    result: void;
  };
  "forge:list-issues": {
    args: [payload: { cwd: string; opts?: ListOptions }];
    result: Page<Issue>;
  };
  "forge:list-prs": {
    args: [payload: { cwd: string; opts?: ListOptions }];
    result: Page<PR>;
  };
  "forge:get-issue": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: Issue | null;
  };
  "forge:get-pr": {
    args: [payload: { cwd: string; prNumber: number; fresh?: boolean }];
    result: PR | null;
  };
  "forge:get-repo-metadata": {
    args: [payload: { cwd: string }];
    result: import("./forge.js").ForgeRepoMetadataPayload;
  };
  "forge:get-current-user": {
    args: [payload: { cwd: string }];
    result: ForgeUser | null;
  };
  "forge:classify-push-error": {
    args: [payload: { cwd: string; stderr: string }];
    result: { providerId: string; classification: PushErrorClassification | null } | null;
  };

  // Voice input
  "voice-input:get-settings": {
    args: [];
    result: VoiceInputSettings;
  };
  "voice-input:set-settings": {
    args: [patch: VoiceInputSettingsPatch];
    result: void;
  };

  "voice-input:check-mic-permission": {
    args: [];
    result: MicPermissionStatus;
  };
  "voice-input:request-mic-permission": {
    args: [];
    result: boolean;
  };
  "voice-input:open-mic-settings": {
    args: [];
    result: boolean;
  };
  "voice-input:validate-api-key": {
    args: [apiKey: string];
    result: { valid: boolean; error?: string };
  };
  "voice-input:correct": {
    args: [
      request: {
        rawText: string;
        recentContext?: string[];
        /** The draft after the passage, bounded: context cleanup never rewrites, sent to OpenAI and never logged. */
        followingText?: string;
        /** The prompts last sent to `terminalId`, oldest first, bounded: sent to OpenAI with the passage, never logged. */
        recentPrompts?: string[];
        /** The panel the passage was dictated into: it picks the project vocabulary and the agent's commands. */
        terminalId?: string;
        /** Nothing but whitespace comes before the passage in the draft. */
        startsPrompt?: boolean;
        /** The command or skill the whole draft opens with, as typed: cleanup is told what it takes as arguments. */
        openingCommandToken?: string;
        /** The dictation the passage came from: its context was read while it ran. */
        sessionId?: string;
        /** Spans of `rawText` the recogniser was unsure of. */
        uncertain?: Array<{ from: number; to: number }>;
        /** Positions in `rawText` where the speaker paused, each straight after a word. */
        pauses?: number[];
        /** Dictated into a terminal outside the asking view: cleaned up without its project's vocabulary. */
        outsideView?: true;
        /** Streams the reply: its text so far comes back as `voice-input:correction-progress` under this id. */
        streamId?: string;
      },
    ];
    // `failed`: the request failed or was cancelled, leaving the raw text.
    // `timing`: main's share of the wait, timings only.
    result: {
      action: "no_change" | "replace";
      correctedText: string;
      failed?: true;
      /** Why the passage came back as it did: a code, never text. */
      verdict?: VoiceCorrectionVerdict;
      timing?: VoiceCorrectionTiming;
      /** A streamed reply that came back whole; a retried request's stall left out. */
      pace?: VoiceCorrectionPace;
      /** What became of a pause's prefetch of the passage; only for a passage with a session. */
      prefetch?: VoicePrefetchMatch;
      /** A failure that will recur, on the one reply of its outage that should say so. */
      cleanupFailure?: VoiceCleanupFailure;
    };
  };

  // Crash Recovery channels
  "crash-recovery:get-pending": {
    args: [];
    result: import("./crashRecovery.js").PendingCrash | null;
  };
  "crash-recovery:resolve": {
    args: [action: import("./crashRecovery.js").CrashRecoveryAction];
    result: void;
  };
  "crash-recovery:get-config": {
    args: [];
    result: import("./crashRecovery.js").CrashRecoveryConfig;
  };
  "crash-recovery:set-config": {
    args: [config: Partial<import("./crashRecovery.js").CrashRecoveryConfig>];
    result: import("./crashRecovery.js").CrashRecoveryConfig;
  };

  // Webview console capture
  "webview:start-console-capture": {
    args: [webContentsId: number, paneId: string];
    result: void;
  };
  "webview:stop-console-capture": {
    args: [webContentsId: number, paneId: string];
    result: void;
  };
  "webview:clear-console-capture": {
    args: [webContentsId: number, paneId: string];
    result: void;
  };
  "webview:get-console-properties": {
    args: [webContentsId: number, paneId: string, rowId: number, objectId: string];
    result: import("./webviewConsole.js").CdpGetPropertiesResult;
  };
  "webview:reload-ignoring-cache": {
    args: [webContentsId: number, panelId: string];
    result: void;
  };
  "webview:get-scroll-position": {
    // `null` means the read failed; `0` means the page is genuinely at the top.
    args: [webContentsId: number];
    result: number | null;
  };

  // Demo mode channels (dev-only, gated by --demo-mode flag)
  // App Agent channels
  "app-agent:get-config": {
    args: [];
    result: Omit<AppAgentConfig, "apiKey">;
  };
  "app-agent:set-config": {
    args: [config: Partial<AppAgentConfig>];
    result: Omit<AppAgentConfig, "apiKey">;
  };
  "app-agent:has-api-key": {
    args: [];
    result: boolean;
  };
  "app-agent:test-api-key": {
    args: [apiKey: string];
    result: { valid: boolean; error?: string };
  };
  "app-agent:test-model": {
    args: [model: string];
    result: { valid: boolean; error?: string };
  };

  // Additional app theme channels
  "app-theme:set-accent-color-override": {
    args: [color: unknown];
    result: void;
  };
  "app-theme:set-recent-scheme-ids": {
    args: [ids: unknown];
    result: void;
  };

  // Command system channels
  // Scratch (throwaway one-off agent workspace) channels
  // Global env channels
  // Global recipe channels
  // Help channels
  // Bulk project stats
  "project:get-bulk-stats": {
    args: [projectIds: string[]];
    result: BulkProjectStats;
  };
  "project:get-notification-overrides": {
    args: [projectIds: string[]];
    result: Record<string, Partial<NotificationSettings>>;
  };

  // In-repo recipe channels
  "project:get-inrepo-recipes": {
    args: [projectId: string];
    result: TerminalRecipe[];
  };
  "project:sync-inrepo-recipes": {
    args: [payload: { projectId: string; recipes: TerminalRecipe[] }];
    result: void;
  };
  "project:update-inrepo-recipe": {
    args: [
      payload: {
        projectId: string;
        recipe: TerminalRecipe;
        previousName?: string;
        force?: boolean;
      },
    ];
    result: void;
  };
  "project:delete-inrepo-recipe": {
    args: [payload: { projectId: string; recipeName: string }];
    result: void;
  };
  "project:get-inrepo-presets": {
    args: [projectId: string];
    result: Record<string, AgentPreset[]>;
  };
  "project:list-remotes": {
    args: [cwd: string];
    result: Array<{
      name: string;
      fetchUrl: string;
      parsedRepo: { owner: string; repo: string } | null;
    }>;
  };

  // Recipe import/export
  "recipe:export-file": {
    args: [payload: { name: string; json: string }];
    result: boolean;
  };
  "recipe:import-file": {
    args: [];
    result: string | null;
  };

  // Recovery channels
  "recovery:reload-app": {
    args: [];
    result: void;
  };
  "recovery:reset-and-reload": {
    args: [];
    result: void;
  };
  "recovery:export-diagnostics": {
    args: [];
    result: boolean;
  };
  "recovery:open-logs": {
    args: [];
    result: void;
  };

  // System prerequisite check channels
  "system:check-tool": {
    args: [spec: PrerequisiteSpec];
    result: PrerequisiteCheckResult;
  };
  "system:health-check-specs": {
    args: [agentIds?: string[]];
    result: PrerequisiteSpec[];
  };

  // Webview lifecycle / dialog / OAuth channels
  "webview:set-lifecycle-state": {
    args: [webContentsId: number, frozen: boolean];
    result: void;
  };
  "webview:register-panel": {
    args: [payload: { webContentsId: number; panelId: string }];
    result: void;
  };
  "webview:dialog-response": {
    args: [payload: { dialogId: string; confirmed: boolean; response?: string }];
    result: void;
  };
  "webview:oauth-loopback": {
    args: [
      authUrl: string,
      panelId: string,
      webContentsId: number,
      sessionStorageSnapshot?: Array<[string, string]>,
    ];
    result: import("../oauth.js").OAuthLoopbackResult;
  };
  "webview:cancel-oauth-loopback": {
    args: [payload: { panelId: string }];
    result: void;
  };
}

/**
 * IPC Event Contract Map
 */
export interface IpcEventMap {
  // Remote Hosts namespaces: one push channel each, carrying a discriminated union.
  "remote-hosts:event": import("./remoteHosts.js").RemoteHostsEvent;
  "host-mode:event": import("./hostMode.js").HostModeEvent;
  "device-answer:event": import("./deviceAnswer.js").DeviceAnswerEvent;
  "drive-lease:event": import("./driveLease.js").DriveLeaseEvent;
  "operations:event": import("./operations.js").OperationsEvent;
  "file-transfer:event": import("./fileTransfer.js").FileTransferEvent;
  "host-metrics:event": import("./hostMetrics.js").HostMetricsEvent;
  "canopy-host:event": import("./canopyHost.js").CanopyHostEvent;
  "port-forwards:event": import("./portForwards.js").PortForwardsEvent;

  // Worktree events
  "worktree:remove": { worktreeId: string };
  "worktree:activated": { worktreeId: string };

  // Paint-fabric surface views (Phase 1V): main → surface-view push carrying
  // the webglBudget waterfill grant for that surface.
  "paint-surface:webgl-thresholds": import("../paintFabricSurface.js").SurfaceWebglThresholds;

  // Terminal events
  "terminal:data": [id: string, data: string | Uint8Array];
  "terminal:exit": [id: string, exitCode: number, context?: TerminalExitContext];
  "terminal:error": [id: string, error: string];
  "terminal:trashed": { id: string; expiresAt: number };
  "terminal:restored": { id: string };
  // A gated park lifted itself: the gate terminal came free ("gate-ready") or
  // was closed ("gate-closed"). Carries the note so the hand-back surface can
  // say why the run was waiting without a second read.
  "terminal:park-released": {
    id: string;
    gateRunId: string;
    note?: string;
    reason: "gate-ready" | "gate-closed";
    timestamp: number;
  };
  // A close path journaled a resumable agent session (trash expiry, kill,
  // gracefulKill). Signal-only for resume surfaces to refetch the journal.
  "agent-session:recorded": {
    sessionId: string;
    worktreeId: string | null;
    projectId: string | null;
    timestamp: number;
  };
  "terminal:status": TerminalStatusPayload;
  "terminal:submit-status": TerminalSubmitStatusPayload;
  // Carries prompt text (#15521): sent only to this machine's views of the
  // owning project, never relayed off the bus or to a remote view.
  "terminal:first-prompt": TerminalFirstPromptPayload;
  // Every terminal currently handed to an orchestrating pane (#12490). The
  // whole list on each change: it is small and rarely changes.
  "terminal:adoptions-changed": import("./mcpServer.js").TerminalAdoptionEntry[];
  // The terminals a Canopy panel on another machine holds at its own size (#14497);
  // their panes follow the PTY's grid instead of fitting.
  "terminal:canopy-size-holds-changed": string[];
  // A pane's pending terminal notices changed; project-scoped send.
  "terminal:notify-state": import("../terminalNotify.js").PaneNotifyState;
  "terminal:reliability-metric": TerminalReliabilityMetricPayload;
  "terminal:resource-metrics": { metrics: TerminalResourceBatchPayload; timestamp: number };
  "terminal:broadcast-write-result": BroadcastWriteResultPayload;
  "terminal:send-key": [id: string, key: string];
  "terminal:spawn-result": [id: string, result: SpawnResult];
  "terminal:resize-result": [id: string, result: TerminalResizeResult];
  // The host's memory-leak policy picked this view to restart a terminal over
  // its auto-restart threshold (#14703). Sent to one view of the project only.
  "terminal:memory-leak-restart-requested": { terminalId: string; thresholdMb: number };
  "terminal:backend-crashed": {
    crashType: string;
    code: number | null;
    signal: string | null;
    timestamp: number;
  };
  "terminal:backend-recovering": {
    crashType: string;
    code: number | null;
    signal: string | null;
    timestamp: number;
  };
  "terminal:backend-ready": void;
  // App-wide terminal-host memory pause (#12375), sent to each window's active
  // view on every change. Views that missed it pull `terminal:get-host-memory-pause`.
  "terminal:host-memory-pause": import("../pty-host.js").HostMemoryPauseSnapshot;
  // Memory-pressure reclaim for the receiving view: every terminal it isn't
  // showing drops to `targetLines` of scrollback, under the reducer's guards.
  "terminal:reduce-scrollback": { targetLines: number };
  "terminal:restore-scrollback": { terminalIds: string[] };

  // Watchdog deadlock detector — emitted once when the main-process watchdog
  // hits its restart cap and deadlock detection becomes inactive for the
  // session. Renderer surfaces a recovery banner so the user can restart it.
  "watchdog:disabled": {
    attemptCount: number;
    lastExitCode: number | null;
    timestamp: number;
  };
  // Cleared global state after a successful manual restart — every window
  // dismisses its WatchdogDisabledBanner. Broadcast (not window-scoped) so
  // dispatching the action from one window also clears stale banners in
  // sibling windows of a multi-window session.
  "watchdog:active": void;

  // Agent events
  "agent:state-changed": AgentStateChangePayload;
  "agent:state-transition-dropped": AgentStateTransitionDroppedPayload;
  "agent:all-clear": { timestamp: number; shouldFlash: boolean };
  "agent:detected": AgentDetectedPayload;
  "agent:rate-limit-observed": AgentRateLimitObservedPayload;
  "agent:exited": AgentExitedPayload;
  "agent:fallback-triggered": AgentFallbackTriggeredPayload;

  // Terminal activity events
  "terminal:activity": TerminalActivityPayload;

  // Artifact events
  "artifact:detected": ArtifactDetectedPayload;

  // CopyTree events
  "copytree:progress": CopyTreeProgress;

  // Git push progress events
  "git:push-progress": PushProgressEvent;

  // Git init events
  "project:init-git-progress": GitInitProgressEvent;

  /**
   * Git clone progress (main → renderer). Targeted to the originating window
   * when known, broadcast to all renderers as a fallback. Lifecycle stages and
   * payload shape live in `shared/types/ipc/gitClone.ts`.
   */
  "project:clone-progress": CloneRepoProgressEvent;

  // PR detection events
  "pr:detected": PRDetectedPayload;
  "pr:cleared": PRClearedPayload;

  // Issue detection events
  "issue:detected": IssueDetectedPayload;
  "issue:not-found": IssueNotFoundPayload;

  // Provider-keyed forge rate-limit / token-health state push. Carries the
  // canonical providerId so the renderer keys state per provider — GitHub and
  // any additional forge provider share these channels without cross-talk.
  "forge:rate-limit-changed": ForgeRateLimitChangedPayload;
  "forge:token-health-changed": ForgeTokenHealthChangedPayload;

  // Provider-keyed stats pushes, broadcast by the forge repo-stats handler
  // after a fresh network poll.
  "forge:repo-stats-and-page-updated": ForgeRepoStatsAndPagePayload;
  "forge:repo-counts-updated": ForgeRepoCountsUpdatedPayload;

  // Per-service connectivity state push
  "connectivity:service-changed": ServiceConnectivityPayload;

  // Where projects are open may have changed — re-read with
  // `project-presence:get-snapshot`, which answers per window (#12597).
  "project-presence:changed": void;
  "recent-dictations:changed": void;
  // The sender project's presentation profile changed (#13771); main sends it to every view of that project.
  "project-presentation:changed": import("./projectPresentation.js").ProjectPresentationSnapshot;

  // The sender project's own theme changed (#13833); main sends it to every view of that project.
  "project-theme:changed": import("./projectTheme.js").ProjectThemeChange;

  // The sender project's custom worktree titles changed (#14022); main sends them to every view of that project.
  "worktree-titles:changed": import("./worktreeTitles.js").WorktreeTitlesSnapshot;

  // The sender project's review marks changed (#14584); main sends them to every view of that project.
  "review-marks:changed": import("./reviewMarks.js").ReviewMarksSnapshot;

  // The sender project's schedules changed (#15975); main sends them to every local view of that project.
  "schedules:changed": import("./schedules.js").SchedulesSnapshot;

  /**
   * Main asks the view showing a project to launch a scheduled run (#15978)
   * and awaits a renderer `ipcRenderer.send` reply on
   * `CHANNELS.SCHEDULES_LAUNCH_RESPONSE`, correlated by `requestId`. The
   * response channel is a renderer→main fire-and-forget send tracked in
   * `DEAD_CHANNEL_ALLOWLIST` in channelDrift.test.ts.
   */
  "schedules:launch-request": import("./schedules.js").ScheduledLaunchViewRequest;

  // Main asks every local view of a project to move or remove a scheduled run's pane by its done policy (#15982).
  "schedules:finish-request": import("./schedules.js").ScheduledRunFinishRequest;

  /**
   * MCP server runtime-state transition. Distinct from
   * `connectivity:service-changed` because the renderer needs the derived
   * `disabled|starting|ready|failed` state plus `lastError`, not just
   * binary reachability.
   */
  "mcp-server:runtime-state-changed": import("./mcpServer.js").McpRuntimeSnapshot;

  /**
   * Pinned MCP help-session manifest request. Main process emits this on the
   * pinned WebContents and awaits a renderer `ipcRenderer.send` reply on
   * `CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE`, correlated by `requestId`.
   * The response channel itself is a renderer→main fire-and-forget send and
   * is tracked in `DEAD_CHANNEL_ALLOWLIST` in channelDrift.test.ts.
   */
  "mcp:get-manifest-request": { requestId: string };

  /**
   * Pinned MCP help-session action dispatch request. Same request/response
   * pattern as `mcp:get-manifest-request`; renderer replies via
   * `CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE`. `context` is the optional
   * pinned-session `ActionContext` override (#8317).
   */
  "mcp:dispatch-action-request": {
    requestId: string;
    actionId: string;
    args: unknown;
    confirmed: boolean;
    context?: import("../actions.js").ActionContext;
    callerInfo?: import("./mcpServer.js").McpBearerIdentity;
    /** Approval controls (#12692, #12881); all set only by main. */
    offerSessionApproval?: boolean;
    approvalOnly?: boolean;
    approvalReason?: import("./mcpServer.js").McpApprovalReason;
    /** Another machine's own preview of an `approvalOnly` call (#13501); set only by main. */
    hostPreview?: import("./mcpServer.js").McpHostPreview;
    /** What pre-authorized a `confirmed` dispatch (#12874); set only by main. */
    authorization?: import("./mcpServer.js").McpDispatchAuthorization;
    /** The pane or Assistant tab that sent the call (#14992); set only by main. */
    requester?: import("./mcpServer.js").McpRequester;
    /** Main's deadline for the call as sent, epoch ms (#15648); set only by main. */
    dispatchDeadlineAt?: number;
  };

  /**
   * Plugin-sourced action dispatch request. Main process emits this on the
   * active project WebContents and awaits a renderer `ipcRenderer.send` reply
   * on `CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE`, correlated by `requestId`.
   * Unlike `mcp:dispatch-action-request` there is no `confirmed` or `context`:
   * plugins cannot bypass confirm-gating and don't override the action context.
   * The response channel is a renderer→main fire-and-forget send tracked in
   * `DEAD_CHANNEL_ALLOWLIST` in channelDrift.test.ts.
   */
  "plugin:dispatch-action-request": {
    requestId: string;
    actionId: string;
    args: unknown;
    /** The calling plugin, from its host's closure; absent for host-internal dispatches. */
    pluginId?: string;
  };

  /**
   * Plugin built-in action-catalog request (#10561). Main emits this on the
   * active project WebContents when a plugin calls `host.actions.list()` and
   * awaits a renderer `ipcRenderer.send` reply on
   * `CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE`, correlated by `requestId`. The
   * renderer projects `ActionService.list()` to {@link
   * import("../actions.js").PluginActionManifestEntry}. The response channel is a
   * renderer→main fire-and-forget send tracked in `DEAD_CHANNEL_ALLOWLIST` in
   * channelDrift.test.ts.
   */
  "plugin:actions-list-request": {
    requestId: string;
  };

  /**
   * Plugin built-in action lookup request (#10561). Main emits this when a
   * plugin calls `host.actions.get(id)` / `host.actions.canDispatch(id)` and
   * awaits a renderer `ipcRenderer.send` reply on
   * `CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE`, correlated by `requestId`. Same
   * fire-and-forget response discipline as `plugin:actions-list-request`.
   */
  "plugin:actions-get-request": {
    requestId: string;
    actionId: string;
  };

  /**
   * Plugin agent-pane listing (`host.agents.list()`). Main emits this on the
   * plugin's project WebContents and awaits a renderer `ipcRenderer.send` reply
   * on `CHANNELS.PLUGIN_AGENTS_LIST_RESPONSE`, correlated by `requestId`. Same
   * fire-and-forget response discipline as `plugin:actions-list-request`.
   */
  "plugin:agents-list-request": {
    requestId: string;
  };

  /**
   * Imperative plugin UI-prompt request (#10522). Main emits this on the active
   * project WebContents when a plugin calls `host.showQuickPick`/`showInputBox`/
   * `showConfirm`, and awaits a renderer `ipcRenderer.send` reply on
   * `CHANNELS.PLUGIN_UI_PROMPT_RESPONSE`, correlated by `promptId`. The response
   * channel is a renderer→main fire-and-forget send tracked in
   * `DEAD_CHANNEL_ALLOWLIST` in channelDrift.test.ts.
   */
  "plugin:ui-prompt-request": import("../pluginUiPrompt.js").PluginUiPromptRequest;

  /**
   * Plugin backend panel reload (#12610). Main emits this on the one
   * WebContents that reported the panel's view when a plugin calls
   * `host.reloadPanel(panelId)`, and awaits a renderer `ipcRenderer.send` reply
   * on `CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE`, correlated by `requestId`. The
   * response channel is a renderer→main fire-and-forget send tracked in
   * `DEAD_CHANNEL_ALLOWLIST` in channelDrift.test.ts.
   */
  "plugin:panel-reload-request": import("../pluginPanelReload.js").PluginPanelReloadRequest;

  /**
   * Cancel pending plugin UI prompts (#10522). Main broadcasts this to the
   * active renderer when a plugin is unloaded with a prompt still open so the
   * renderer can dismiss the dialog and resolve its queued promise. Omitting
   * `promptId` cancels every prompt for `pluginId`.
   */
  "plugin:ui-prompt-cancel": import("../pluginUiPrompt.js").PluginUiPromptCancel;

  /**
   * Targeted push: a help-session tool call was denied because its tier
   * doesn't permit the tool. Sent to the pinned WebContents so the renderer
   * can surface an inline approval banner. Tier is `string` (not `McpTier`)
   * because the type is main-process only — see `McpAuditRecord.tier`
   * precedent. `targetTier` is the minimum tier that permits the tool, or
   * `null` if the tool isn't recognized at any tier.
   */
  "mcp-server:tier-not-permitted": {
    sessionId: string;
    toolId: string;
    tier: string;
    targetTier: HelpAssistantTier | null;
  };

  /**
   * Targeted push: a help-session was revoked by the abuse policy after
   * exceeding the denial threshold. Sent to the pinned WebContents so the
   * renderer can surface why the session ended and offer a new-session
   * recovery action. `denialKind` records what tripped the policy
   * (`"auth401"`, `"tierMismatch"`, …).
   */
  "mcp-server:session-revoked": {
    sessionId: string;
    denialKind: string;
  };

  /**
   * Targeted push: a grant lifecycle event for an MCP tool approval.
   * Sent to the pinned WebContents so the renderer can track grant state.
   */
  "mcp-server:grant-lifecycle": import("./mcpServer.js").McpGrantLifecyclePayload;

  /**
   * Targeted push: an MCP tool dispatch entered the call path for the pinned
   * help-session. Drives the Assistant panel's live activity strip (#9759).
   */
  "mcp-server:tool-call-started": import("./mcpServer.js").McpToolCallStartedPayload;
  /**
   * Targeted push: an MCP tool dispatch announced via `tool-call-started`
   * settled. Carries the audit-aligned outcome for the activity strip (#9759).
   */
  "mcp-server:tool-call-settled": import("./mcpServer.js").McpToolCallSettledPayload;
  /**
   * Targeted push: the assistant invoked `help.displayImage`. Carries the
   * validated image URL and session-assigned figure number (#9828).
   */
  "mcp-server:help-display-image": import("./mcpServer.js").McpHelpDisplayImagePayload;
  /**
   * Targeted push: a turn for the pinned help session classified as
   * `agent-stuck` or `reasoning-loop` (#10018). Drives the Assistant footer's
   * ambient outcome pip — Tier 1, never a toast.
   */
  "mcp-server:turn-outcome-alert": import("./mcpServer.js").McpTurnOutcomeAlertPayload;

  // Error events
  "error:notify": ErrorRecord;
  "error:retry-progress": RetryProgressPayload;

  // Log events
  "logs:entry": LogEntry;
  "logs:batch": LogEntry[];
  "logs:level-overrides-changed": Record<string, string>;

  // Event inspector events
  "event-inspector:event-batch": EventRecord[];

  // Project events
  "project:on-switch": ProjectSwitchPayload;
  "project:worktree-load-status": ProjectWorktreeLoadStatusPayload;
  "project:focus-on-activate": ProjectFocusOnActivateIntent;
  "project:panel-recovery-query": string;
  "project:background-resize": { width: number; height: number };
  "project:stats-updated": ProjectStatusMap;
  "fleet:snapshot-updated": FleetSnapshot;
  "canopy:snapshot-updated": import("./canopy.js").CanopySnapshot;
  "canopy:terminal-data": import("./canopy.js").CanopyTerminalData;
  "canopy:trash-requested": import("./canopy.js").CanopyTrashRequest;
  "canopy:restore-requested": import("./canopy.js").CanopyRestoreRequest;
  "canopy:remove-requested": import("./canopy.js").CanopyRemoveRequest;
  "canopy:resume-requested": import("./canopy.js").CanopyResumeRequest;
  "canopy:rename-requested": import("./canopy.js").CanopyRenameRequest;
  "project:updated": Project;
  /**
   * A project was put to sleep. Carries the project id so a window showing it
   * drops to the no-project state — its view is deliberately left alive (the
   * window's renderer IS that project's WebContentsView), so nothing else tells
   * a SECOND window its project's terminals are gone. Deliberately its own
   * event rather than an inference from `project:updated` reaching `closed`:
   * relocation, project adoption, the idle sweep and a plain metadata write all
   * reach that status too, and blanking a visible window on any of them is
   * wrong.
   */
  "project:slept": string;
  "project:removed": string;
  // Main asks the renderer to open the guided git-init dialog for a folder the
  // user tried to open that isn't a repository yet (Dock drop, Cmd+O, Recent
  // Projects). Nothing is written to disk until the user confirms in-dialog.
  "project:open-git-init-dialog": { directoryPath: string };

  // Scratch events
  "scratch:on-switch": ScratchSwitchPayload;
  "scratch:updated": Scratch;
  "scratch:removed": string;

  // Agent install progress events
  "setup:agent-install-progress": AgentInstallProgressEvent;

  // Plugin install progress (#11302) — targeted at the window that started the
  // install, not a global broadcast, so it is NOT an event-bus channel.
  "plugin:install-progress": import("../plugin.js").PluginInstallProgressEvent;

  // Per-plugin perf snapshots, pushed only to renderers that subscribed and at
  // most once a second. Carries every tracked plugin, not just the changed ones.
  "plugin:perf-snapshots-changed": import("../pluginMetrics.js").PluginPerfSnapshot[];

  // A project's presence changed (#13813), pushed to that project's renderers.
  "plugin:project-presence-changed": import("../plugin.js").PluginProjectPresence;

  // System events
  "system:wake": SystemWakePayload;
  // Sustained system memory pressure opened or cleared (window-scoped)
  "system:memory-pressure": SystemMemoryPressurePayload;
  // Power policy changed — battery, focus, visibility, or screen lock (#12515)
  "system:power-policy-changed": import("../powerPolicy.js").PowerPolicySnapshot;

  // Portal events
  "portal:nav-event": import("../portal.js").PortalNavEvent;
  "portal:focus": void;
  "portal:blur": void;
  "portal:tab-evicted": { tabId: string };

  // System Sleep events
  "system-sleep:on-suspend": void;
  "system-sleep:on-wake": number;

  // OS Do-Not-Disturb / Focus state transitions. Read-only; never used to
  // suppress in-app toasts.
  "os-dnd:state-changed": import("./osDnd.js").OsDndState;

  // Menu events
  "menu:action": { actionId: string; args?: unknown; portalActionId?: string };

  // Window events
  "window:fullscreen-change": boolean;
  "window:reclaim-memory": { reason: string };
  "window:destroy-hidden-webviews": { tier: 1 | 2 };
  // Main asks renderers to report process.getBlinkMemoryInfo() so
  // ProcessMemoryMonitor can see the Blink (DOM/CSS/inter-frame) memory tier
  // that V8 heap stats miss. Renderer replies via SYSTEM_REPORT_BLINK_MEMORY.
  "window:sample-blink-memory": { requestId: string };
  // Main asks active renderers to report accumulated long-animation-frame
  // blocking time so ProcessMemoryMonitor can see sustained event-loop
  // saturation. Renderer replies via SYSTEM_REPORT_RENDERER_ELU.
  "window:sample-renderer-elu": { requestId: string };
  // Main asks an active renderer, on demand, for its xterm buffer line counts.
  // Renderer replies through system:report-terminal-renderer-diagnostics.
  "window:sample-terminal-buffers": { requestId: string };
  "window:disk-space-status": {
    status: "normal" | "warning" | "critical";
    availableMb: number;
    writesSuppressed: boolean;
  };
  "portal:tabs-evicted": { tabIds: string[] };

  // Sound events (main → renderer)
  "sound:trigger": { soundFile: string; detune?: number };
  "sound:cancel": void;

  // Notification events
  "notification:update": { waitingCount: number };
  "notification:watch-navigate": { panelId: string; panelTitle: string; worktreeId?: string };
  "notification:show-toast": MainProcessToastPayload;

  // Auto-update events
  "update:available": { version: string };
  "update:download-progress": { percent: number };
  "update:downloaded": { version: string };

  // Windows Store update notification events — fired only on Windows Store
  // builds when a newer version is detected on the CDN feed.
  "store-update:available": { version: string; storeUrl: string };

  // Dev Preview events
  "dev-preview:state-changed": DevPreviewStateChangedPayload;
  "dev-preview:all-sessions-changed": DevPreviewAllSessionsPayload;
  "element-picker:event": import("./elementPicker.js").ElementPickerPushPayload;
  "element-picker:source-changed": import("./elementPicker.js").ElementPickerSourceChangedPush;

  // Webview console events
  "webview:console-message": import("./webviewConsole.js").SerializedConsoleRow;
  "webview:console-context-cleared": { paneId: string; navigationGeneration: number };

  // Webview dialog events
  "webview:dialog-request": {
    dialogId: string;
    panelId: string;
    type: "alert" | "confirm" | "prompt";
    message: string;
    defaultValue: string;
    /**
     * Host of the frame that raised the dialog, or null when it has no host worth
     * claiming (data:, blob:, about:). Never guessed — an attribution that can lie is
     * worse than none.
     */
    origin: string | null;
  };

  // Webview dialogs dismissed — guest navigated away or its renderer crashed,
  // invalidating any pending dialog overlays for the panel
  "webview:dialog-dismiss": {
    panelId: string;
  };

  // Webview find-in-page shortcut forwarded from guest
  "webview:find-shortcut": {
    panelId: string;
    shortcut: "find" | "next" | "prev" | "close";
  };

  // Webview reload shortcut (Cmd/Ctrl+R) forwarded from focused guest
  "webview:reload-shortcut": {
    panelId: string;
  };

  // Webview close shortcut (Cmd/Ctrl+W) forwarded from focused guest
  "webview:close-shortcut": {
    panelId: string;
  };

  // Webview navigation blocked — cross-origin navigation was prevented
  "webview:navigation-blocked": {
    panelId: string;
    url: string;
    canOpenExternal: boolean;
  };

  // Webview OAuth loopback status — phase transitions from main process
  "webview:oauth-loopback-status": {
    panelId: string;
    phase: "token-exchange-intercepted" | "completed" | "timed-out" | "error";
    message?: string;
  };

  // Webview render process became unresponsive (>30s no input processing)
  "webview:unresponsive": {
    panelId: string;
  };

  // Webview render process recovered from unresponsive state
  "webview:responsive": {
    panelId: string;
  };

  // Voice input events. Every one carries the id of the session it belongs to.
  "voice-input:transcription-delta": {
    sessionId: string;
    text: string;
    itemId?: string;
    replace?: boolean;
  };
  "voice-input:transcription-complete": {
    sessionId: string;
    text: string;
    willCorrect: boolean;
    /** The words as transcribed, when heard-as rules rewrote them into `text`. */
    heard?: string;
    itemId?: string;
    /** Set when spoken file references in this transcript may follow; their result names it. */
    transcriptId?: string;
    /** The utterance ended with a spoken "send it", already stripped from `text`. */
    send?: boolean;
    /** The text with its spoken opening command written as typed, to use when it starts the prompt. */
    commandText?: string;
    /** Spans of `text` the recogniser was unsure of. */
    uncertain?: Array<{ from: number; to: number }>;
    /** Spans of `heard` the recogniser was unsure of. */
    heardUncertain?: Array<{ from: number; to: number }>;
    /** Spans of `commandText` the recogniser was unsure of. */
    commandUncertain?: Array<{ from: number; to: number }>;
    /**
     * Where the speaker paused in `text`, each straight after a word. With no
     * words, `[0]` marks a pause after the words that landed before it.
     */
    pauses?: number[];
    /** Where the speaker paused in `heard`. */
    heardPauses?: number[];
    /** Where the speaker paused in `commandText`. */
    commandPauses?: number[];
  };
  "voice-input:paragraph-boundary": { sessionId: string; rawText: string | null };
  /** A streaming correction's text so far, cut at a word boundary; only ever grows. */
  "voice-input:correction-progress": { streamId: string; text: string };
  "voice-input:file-token-resolved": {
    sessionId: string;
    transcriptId: string;
    /**
     * Every reference detected, with its worktree-relative path or null for a
     * miss. `failed` marks a lookup that threw, timed out or had nowhere to look.
     */
    references: Array<{ description: string; path: string | null; failed?: true }>;
  };
  "voice-input:error": { sessionId: string; error: VoiceInputError };
  "voice-input:status": { sessionId: string; status: VoiceInputStatus };
  "voice-input:session-ended": {
    sessionId: string;
    reason: VoiceSessionEndReason;
    report: VoiceSessionReport;
  };
  // To every view whenever the live session changes. Not keyed to a session:
  // it names the one live elsewhere, or none.
  "voice-input:live-session": VoiceLiveSessionUpdate;
  // To the owner: another view's dictation key, or a page's, asked it to stop.
  "voice-input:stop-requested": VoiceStopRequest;
  // Another view's indicator, to the owner and to the view on screen in the
  // owner's window, which goes to the owner's workspace on the owner's host.
  "voice-input:reveal-requested": VoiceRevealRequest;
  // The live session's input level, to the views on screen that don't own it.
  "voice-input:live-level": VoiceLiveLevel;
  // To the owner: another view's control panel paused or resumed it.
  "voice-input:pause-requested": VoicePauseRequest;

  // Demo mode events (main → renderer command forwarding)
  "demo:exec-move-to": DemoMoveToPayload;
  "demo:exec-move-to-selector": DemoMoveToSelectorPayload;
  "demo:exec-click": void;
  "demo:exec-type": DemoTypePayload;
  "demo:exec-pause": void;
  "demo:exec-resume": void;
  "demo:exec-wait-for-selector": DemoWaitForSelectorPayload;
  "demo:exec-sleep": DemoSleepPayload;

  // Accessibility events
  "accessibility:support-changed": { enabled: boolean };
  /**
   * A configuration bundle was applied (#11889). No payload — each view
   * re-reads the config it mirrors rather than trusting a pushed snapshot.
   */
  "config-bundle:imported": undefined;

  // Keep-awake events
  "keep-awake:state-changed": KeepAwakeState;

  // Idle terminal notification events
  "idle-terminal:notify": IdleTerminalNotifyPayload;

  // Idle background-project auto-close events
  "idle-background:closed": IdleBackgroundClosedPayload;

  // App theme events
  "app-theme:system-appearance-changed": { isDark: boolean; schemeId: string };

  // Config reload events
  "app:config-reloaded": void;

  // Fired by ProjectViewManager after a warm cached view is detached from the
  // anti-flash bridge and focused as the foreground surface (#10362). The
  // renderer re-runs its terminal redraw here — the wake fan-out driven by
  // visibilitychange/resume ran while the view was still occluded, where
  // Chromium culls the paint, so it can fail to stick until the user clicks.
  // Carries the switch trace id so the incoming renderer's perf marks join the
  // same `project_switch.*` trace main is emitting; absent on the rollback send.
  "app:view-revealed": { switchId?: string } | undefined;
  // Fired by ProjectViewManager the moment it re-attaches a cached view (warm
  // switch). A detached setVisible(false) view receives no visibilitychange or
  // resume event on reattach, so this is the renderer's deterministic trigger
  // to run the wake fan-out whose completion releases the warm paint gate.
  "app:view-warm-activated": { switchId?: string } | undefined;
  // Carries a flush id only when main is holding the view for the renderer's
  // cached-edge flush, which the renderer echoes back once it settles (#15633).
  "app:view-cached": { flushId: string } | undefined;

  // Privacy events
  "privacy:telemetry-consent-changed": {
    level: "off" | "errors" | "full";
    hasSeenPrompt: boolean;
  };

  // Telemetry preview events
  "telemetry:preview-event-batch": SanitizedTelemetryEvent[];
  "telemetry:preview-state-changed": TelemetryPreviewState;

  // Onboarding checklist push (main → renderer)
  "onboarding:checklist-push": ChecklistState;

  // Agent preset events
  "agent-presets:updated": { agentId: string; presets: AgentPreset[] };

  // Host-owned agent defaults changed (#13345)
  "agent-defaults:changed": AgentDefaultsSnapshot;

  // A saved agent settings change on the host, the whole slice (#14700)
  "agent-settings:changed": import("../agentSettings.js").AgentSettings;

  // This machine's saved grid layout changed (#14700)
  "app:panel-grid-config-changed": import("../config.js").PanelGridConfig;

  // This machine's saved keybinding overrides, the whole map (#15579)
  "keybinding:overrides-changed": KeybindingOverridesSnapshot;

  // A saved terminal-config change, one owner's fields each (#14699)
  "terminal-config:device-changed": Partial<import("./config.js").TerminalConfig>;
  "terminal-config:host-changed": Partial<import("./config.js").TerminalConfig>;

  // This machine's toolbar agent pins changed (#14702)
  "agent-toolbar-pins:changed": AgentToolbarPinsSnapshot;
  "help:global-assistant-changed": import("./help.js").GlobalAssistantView;

  // Plugin action registry events
  "plugin:actions-changed": {
    actions: import("../plugin.js").PluginActionDescriptor[];
  };

  // Plugin panel kind registry events (main → renderer)
  "plugin:panel-kinds-changed": {
    kinds: import("../../config/panelKindRegistry.js").PanelKindConfig[];
  };

  // Plugin toolbar button registry events (main → renderer).
  // `complete` is true only for an authoritative snapshot (a plugin unload —
  // i.e. uninstall — where the registry reflects exactly the currently-loaded
  // set). Load-time broadcasts are partial/growing because plugins load
  // concurrently and `initialize()` is deferred, so the renderer must NOT
  // prune persisted hide preferences off a non-`complete` snapshot.
  "plugin:toolbar-buttons-changed": {
    buttons: import("../../config/toolbarButtonRegistry.js").ToolbarButtonConfig[];
    complete: boolean;
  };

  // Plugin launch-entry registry events (main → renderer, #13788). No
  // `complete` flag: every snapshot replaces the renderer's set wholesale, and
  // nothing is swept against it.
  "plugin:launch-entries-changed": {
    entries: import("../plugin.js").PluginLaunchEntryConfig[];
  };

  // Plugin layout registry events (main → renderer, #13780). Same wholesale
  // replacement as launch entries.
  "plugin:layouts-changed": {
    layouts: import("../plugin.js").PluginLayoutConfig[];
  };

  // Plugin keybinding registry events (main → renderer). Same `complete` flag
  // semantics as toolbar buttons.
  "plugin:keybindings-changed": {
    keybindings: import("../plugin.js").PluginKeybindingDescriptor[];
    complete: boolean;
  };

  // Plugin context-menu item registry events (main → renderer). Same `complete`
  // flag semantics as toolbar buttons.
  "plugin:context-menu-items-changed": {
    items: Array<{ pluginId: string; item: import("../plugin.js").ContextMenuContribution }>;
    complete: boolean;
  };

  // Plugin agent registry events (main → renderer). Carries the flattened
  // plugin-agent record so the renderer can mirror main's effective registry.
  // Same `complete` flag semantics as toolbar buttons: true for an
  // authoritative post-unload snapshot, false for partial/growing load-time
  // broadcasts.
  "plugin:agents-changed": {
    agents: Record<string, import("../../config/agentRegistry.js").AgentConfig>;
    complete: boolean;
  };

  // Plugin recipe registry events (main → renderer, #11860). Carries the full
  // effective plugin recipe list the receiving view's project shows (#13765) —
  // manifest content with the user's sidecar metadata already overlaid — so the
  // renderer replaces its plugin tier wholesale rather than reconciling
  // per-plugin. Same `complete` flag semantics as toolbar buttons.
  "plugin:recipes-changed": {
    recipes: import("../project.js").TerminalRecipe[];
    complete: boolean;
  };

  // Plugin tour registry snapshot (main → renderer, scoped to the view's project).
  "plugin:tours-changed": {
    tours: import("../plugin.js").PluginTourDescriptor[];
  };

  // Plugin views that mount outside the panel grid (#13770), scoped to the
  // view's project. A full snapshot every time; the renderer replaces its copy.
  "plugin:hosted-views-changed": {
    views: import("../plugin.js").PluginHostedViewDescriptor[];
  };

  // Every theme an installed plugin offers (#13832), app-wide. A full snapshot
  // every time; the renderer replaces its copy. `fallbackSchemeId` is set when
  // main replaced a selected plugin theme that is no longer offered.
  "plugin:themes-changed": {
    themes: import("../appTheme.js").AppColorScheme[];
    fallbackSchemeId?: string;
  };

  // Plugin-shipped custom icons visible to this view (#13143). A full
  // snapshot every time; the renderer replaces its copy wholesale.
  "plugin:icons-changed": {
    icons: import("../../config/pluginCustomIcon.js").PluginCustomIconAsset[];
  };

  // Plugin file-decoration invalidation (main → renderer). Carries only the
  // changed scope (optionally narrowed to `paths`) — never decoration data.
  // The renderer re-pulls fresh decorations via `plugin:file-decorations-get`.
  "plugin:decorations-changed": {
    scope: string;
    paths?: string[];
  };

  // Plugin panel-badge state changed (main → renderer, #10585). Carries this
  // plugin's COMPLETE current badge map (panelId → badge) — never a delta — so
  // the renderer replaces all of `pluginId`'s badges in one shot. An empty
  // `badges` clears the plugin's badges. Authoritative per plugin, so no
  // `complete` flag is needed (each event fully describes one plugin's state).
  "plugin:panel-badges-changed": {
    pluginId: string;
    badges: Record<string, import("../plugin.js").PluginPanelBadge>;
  };

  // Plugin unloaded — drop all of its panel badges (main → renderer, #10585).
  "plugin:panel-badges-cleared": {
    pluginId: string;
  };

  // A plugin's activity reports on its own panels changed (main → renderer,
  // #13820). Carries the plugin's COMPLETE current map (panelId → report),
  // never a delta; an empty `activity` clears them, which is also how an
  // unload or a worker swap is sent.
  "plugin:panel-activity-changed": {
    pluginId: string;
    activity: Record<string, import("../plugin.js").PluginPanelActivityReport>;
  };

  // A plugin's tasks changed (main → renderer, #13819). Carries the plugin's
  // COMPLETE current list, oldest first, never a delta; an empty `tasks` clears
  // them. Interrupted tasks stay in it after the plugin unloads, until dismissed.
  "plugin:tasks-changed": {
    pluginId: string;
    tasks: import("../plugin.js").PluginTaskSnapshot[];
  };

  // A plugin's toolbar-button badges changed (main → renderer, #13503). Carries
  // the plugin's COMPLETE current map (manifest button id → badge), never a
  // delta; an empty `badges` clears them, which is also how an unload is sent.
  "plugin:toolbar-badges-changed": {
    pluginId: string;
    badges: Record<string, import("../plugin.js").PluginPanelBadge>;
  };

  // A plugin's toolbar-button state changed (main → renderer, #13785). Carries
  // the plugin's COMPLETE current map (manifest button id → state), never a
  // delta; an empty `states` clears it, which is also how an unload is sent.
  "plugin:toolbar-states-changed": {
    pluginId: string;
    states: Record<string, import("../plugin.js").PluginToolbarButtonRuntimeState>;
  };

  // A plugin's `when`-clause context keys changed (main → renderer, #13506).
  // Carries the plugin's COMPLETE current map (key → value), never a delta. An
  // empty map means it holds no keys; `null` means it unloaded.
  "plugin:context-keys-changed": {
    pluginId: string;
    keys: Record<string, import("../plugin.js").PluginContextValue> | null;
  };

  // A plugin's worktree card statuses in one project changed (main → renderer,
  // #13704). Carries the plugin's COMPLETE map for that project (worktreeId →
  // status), never a delta; an empty `statuses` clears them, which is also how
  // an unload, a worker swap or a project close is sent.
  "plugin:worktree-card-statuses-changed": {
    pluginId: string;
    projectId: string;
    statuses: Record<string, import("../plugin.js").PluginWorktreeCardStatus>;
  };

  // A plugin's readiness checks in one project changed (main → renderer,
  // #13806). Carries the plugin's COMPLETE map for that project (worktreeId →
  // checks), never a delta; an empty `checks` clears them, which is also how an
  // unload, a worker swap or a project close is sent.
  "plugin:worktree-review-checks-changed": {
    pluginId: string;
    projectId: string;
    checks: Record<string, import("../plugin.js").PluginWorktreeReviewCheck[]>;
  };

  // A plugin's terminal header statuses in one project changed (main →
  // renderer, #13802). Carries the plugin's COMPLETE map for that project
  // (terminalId → status), never a delta; an empty `statuses` clears them, which
  // is also how an unload, a worker swap or a project close is sent.
  "plugin:terminal-statuses-changed": {
    pluginId: string;
    projectId: string;
    statuses: Record<string, import("../plugin.js").PluginTerminalStatus>;
  };

  // A plugin's runtime panel menus changed (main → renderer, #13213). Carries
  // the plugin's COMPLETE current map (panelId → items), never a delta; an
  // empty `menus` clears the plugin's lists, which is also how an unload or a
  // retired worker is announced, so one ordered stream replays correctly.
  "plugin:panel-menus-changed": {
    pluginId: string;
    menus: Record<
      string,
      readonly import("../../utils/pluginPanelMenuItems.js").PublishedPanelMenuItem[]
    >;
  };

  // The plugin's action handlers in flight (main → renderer): its COMPLETE set
  // of running action ids, as dispatched (an instance's namespace for a project
  // plugin). An empty list means none, and is what an unload sends.
  "plugin:actions-running-changed": {
    pluginId: string;
    actionIds: string[];
  };

  // Plugin provenance record changed (main → renderer). Signal-only — the
  // renderer re-pulls via `plugin:list` for the full data.
  "plugin:provenance-changed": Record<string, never>;

  // A plugin's stored settings changed, from the settings form or the plugin's
  // own `host.settings.set` (main → renderer). Signal-only: receivers re-read
  // what they derive from it. Project-scoped for a project-local instance.
  "plugin:settings-changed": { pluginId: string };

  // Live health of one plugin instance — worker lifecycle plus dev session
  // (main → renderer, #12277/#12278). Carries the whole per-instance snapshot,
  // so the receiver never has to reconstruct which generation is live from a
  // sequence of notifications; a `null` status means the instance is no longer
  // tracked. Sent via `broadcastToProjectRenderers` for a project-local
  // instance so a project's backend errors and paths stay in its own views;
  // an app-global instance widens to the full broadcast.
  "plugin:runtime-status-changed": import("../plugin.js").PluginRuntimeStatusChangedEvent;

  // A project's `.daintree/plugins/` folder holds valid manifests and has no
  // trust decision on record (main → renderer, project-scoped). The ONLY signal
  // that may open the project-plugin trust dialog: the controller alone knows
  // whether a prompt is due, and it never re-emits after a decision is stored.
  "plugin:project-trust-prompt": import("../plugin.js").ProjectPluginTrustPromptEvent;

  // Full snapshot of a project's own plugins and its trust state (main →
  // renderer, project-scoped). Emitted on every open, trust change and staged
  // activation, so the plugin manager renders from the push rather than
  // refetching.
  "plugin:project-plugins-changed": import("../plugin.js").ProjectPluginsChangedEvent;

  // A manifest id this trusted project has never had appeared and was staged
  // rather than run (main → renderer, project-scoped). Fires once per new id.
  "plugin:project-plugin-staged": import("../plugin.js").ProjectPluginStagedEvent;

  // The per-project visibility overlay for INSTALLED plugins changed (main →
  // renderer, project-scoped). Carries the whole overlay so the settings tab
  // renders from the push rather than refetching.
  "plugin:project-plugin-visibility-changed": import("../plugin.js").ProjectPluginVisibilityChangedEvent;

  // A project's slot state changed — a plugin claimed or released a slot, a
  // claim was refused, or the user answered (main → renderer, project-scoped).
  // Signal-only with the new revision: every view of the project re-reads the
  // snapshot, so the canvas and its settings disclosure agree at once.
  "plugin:project-surfaces-changed": import("../plugin.js").ProjectSurfacesChangedEvent;

  // The project's git remote table changed (main → renderer, #11155) — e.g.
  // `git remote add origin`. Signal-only and project-scoped: the renderer drops
  // its cached forge-provider resolution for `projectId` and re-resolves via
  // `forge:resolve-provider`. No remote URL crosses the bridge (https remotes
  // can embed credentials).
  "forge:remote-changed": { projectId: string };

  // Background plugin update check found available updates (main → renderer,
  // #10893). Carries the batched set so the renderer can raise one low-priority
  // inbox notification. Broadcast only when at least one update is available.
  "plugin:bg-update-available": import("../plugin.js").PluginBackgroundUpdateCheckResult;

  // Project groups changed (main → renderer). The whole ordered list, so every
  // view redraws its switcher headers after a create, rename, reorder or delete.
  "project-groups:update": import("../project.js").ProjectGroup[];

  // Run history changed (main → renderer, #9949). Carries the full newest-first
  // snapshot so every live window updates without a reload after a recipe/fleet
  // run is recorded or the log is cleared.
  "run-history:update": import("./runHistory.js").RunHistoryRecord[];

  // Copy-tree run history changed (main → renderer, #11732). Sent only to views
  // bound to `projectId`, never broadcast: unlike the run-history ring this is
  // per-project data, so the id rides along and the renderer mirror ignores a
  // snapshot for anything but its own project.
  "copy-tree-history:update": {
    projectId: string;
    records: import("./copyTreeHistory.js").CopyTreeHistoryRecord[];
  };

  // Scheduled-run history changed (main → renderer, #15976). Sent only to views
  // bound to `projectId`; carries which schedules changed, and the view reads
  // their runs again.
  "scheduled-runs:changed": import("./scheduledRuns.js").ScheduledRunsChangedPayload;

  // `daintree://` deep-link intent (main → renderer, #9559). Delivered to the
  // primary window once it has painted; the renderer opens the Plugin Manager
  // (URL pre-filled for install, or scrolled to the plugin for open). Routing
  // installs through the existing manager flow keeps every security gate intact.
  "plugin:deep-link": import("../plugin.js").PluginDeepLinkIntent;

  // Double-clicked `.dntr` archive awaiting install confirmation (main →
  // renderer, #11280). Carries the manifest parsed without extracting, so the
  // renderer can preview real identity/capabilities before anything is written.
  // One event per archive; the renderer queues them FIFO so each gets its own
  // decision.
  "plugin:archive-install-intent": import("../plugin.js").PluginArchiveInstallIntent;

  // Resource profile change (main → renderer)
  "resource:profile-changed": import("../resourceProfile.js").ResourceProfilePayload;

  // App-agent action dispatch/confirmation request events (main → renderer)
  "app-agent:dispatch-action-request": {
    requestId: string;
    actionId: string;
    args?: Record<string, unknown>;
    context: {
      projectId?: string;
      activeWorktreeId?: string;
      focusedWorktreeId?: string;
      focusedTerminalId?: string;
    };
    confirmed?: boolean;
  };
  "app-agent:confirmation-request": {
    requestId: string;
    actionId: string;
    actionName?: string;
    args?: Record<string, unknown>;
    danger: "safe" | "confirm" | "restricted";
  };

  /**
   * Targeted push: a plugin-MCP `tools/call` requires user consent. Sent to the
   * WebContents that initiated the call (pinned via `event.sender`, never the
   * focused window) so the consent dialog renders in the originating session.
   * The renderer replies via `plugin-mcp:resolve-consent`, correlated by
   * `requestId`. Payload is display-safe — raw description/args never cross it.
   */
  "plugin-mcp:consent-request": import("../pluginMcpConsent.js").PluginMcpConsentRequestEvent;

  /**
   * Targeted push: a plugin is exercising a high-risk host capability
   * (`shell:exec`, `fs:*-write`, `git:write`) for the first time and needs
   * just-in-time consent (#10524). Sent to the focused window (falling back to
   * the primary) — unlike the MCP consent push there is no initiating renderer,
   * because the call originates in the plugin's own utility process. The
   * renderer replies via `plugin-capability:resolve-consent`, correlated by
   * `requestId`. The same push carries the one-approval offer-back after a
   * replacing install (#14019), told apart by its `restore` list.
   */
  "plugin-capability:consent-request": import("../pluginCapabilityConsent.js").PluginCapabilityConsentRequestEvent;

  // Typed event bus envelope (multiplexed main → renderer for IpcEventBusMap)
  "events:push": EventBusEnvelope;
}

/**
 * Typed event bus map — the subset of IpcEventMap bridged through the multiplexed
 * `events:push` channel and exposed to the renderer via
 * `window.electron.events.on(name, cb)`.
 *
 * The main-side bridge in `registerEventsHandlers` enforces that every key here
 * has a corresponding entry in `EVENT_BUS_BRIDGED_MANIFEST` via
 * `satisfies Record<keyof IpcEventBusMap, ...>`. Extend both when adding events.
 *
 * Excluded by design: binary / high-frequency channels (`terminal:data`,
 * `terminal:resource-metrics`, `logs:batch`) stay on dedicated channels or the
 * MessagePort path — envelope wrapping would force base64 encoding and add JS
 * dispatch overhead unsuitable for hundreds-of-events-per-second streams.
 */
export type IpcEventBusMap = Pick<
  IpcEventMap,
  // Agent lifecycle (global broadcast)
  | "agent:state-changed"
  | "agent:state-transition-dropped"
  | "agent:all-clear"
  | "agent:detected"
  | "agent:rate-limit-observed"
  | "agent:exited"
  | "agent:fallback-triggered"
  // Window lifecycle (window-scoped)
  | "window:fullscreen-change"
  | "window:reclaim-memory"
  | "window:destroy-hidden-webviews"
  | "window:disk-space-status"
  | "window:sample-blink-memory"
  | "window:sample-renderer-elu"
  | "window:sample-terminal-buffers"
  // System wake (per-webContents)
  | "system:wake"
  // System memory pressure episode edges (window-scoped)
  | "system:memory-pressure"
  // Power policy (global broadcast, replayed on view load)
  | "system:power-policy-changed"
  // Resource profile (global broadcast)
  | "resource:profile-changed"
  // Sound cancel (global broadcast)
  | "sound:cancel"
  // App-agent dispatch/confirmation (window-scoped)
  | "app-agent:dispatch-action-request"
  | "app-agent:confirmation-request"
  // Plugin-MCP tool-call consent prompt (window-scoped — pinned to the caller)
  | "plugin-mcp:consent-request"
  // Plugin host-capability JIT consent prompt (window-scoped — focused window)
  | "plugin-capability:consent-request"
  // Plugin action registry (global broadcast)
  | "plugin:actions-changed"
  // Plugin panel kind registry (global broadcast)
  | "plugin:panel-kinds-changed"
  // Plugin toolbar button registry (global broadcast)
  | "plugin:toolbar-buttons-changed"
  // Plugin launch-entry registry (global broadcast)
  | "plugin:launch-entries-changed"
  // Plugin layout registry (global broadcast)
  | "plugin:layouts-changed"
  // Plugin keybinding registry (global broadcast)
  | "plugin:keybindings-changed"
  // Plugin context-menu item registry (global broadcast)
  | "plugin:context-menu-items-changed"
  // Plugin agent registry (global broadcast)
  | "plugin:agents-changed"
  // Plugin recipe registry (global broadcast)
  | "plugin:recipes-changed"
  | "plugin:tours-changed"
  | "plugin:hosted-views-changed"
  | "plugin:themes-changed"
  | "plugin:icons-changed"
  // Plugin file-decoration invalidation (global broadcast)
  | "plugin:decorations-changed"
  // Plugin panel-badge state (global broadcast)
  | "plugin:panel-badges-changed"
  | "plugin:panel-badges-cleared"
  // Plugin panel activity reports (project-scoped for a project instance)
  | "plugin:panel-activity-changed"
  // Plugin tasks (project-scoped for a project instance)
  | "plugin:tasks-changed"
  // Plugin toolbar-button badges (project-scoped for a project instance)
  | "plugin:toolbar-badges-changed"
  // Plugin toolbar-button state (project-scoped for a project instance)
  | "plugin:toolbar-states-changed"
  // Plugin `when`-clause context keys (project-scoped for a project instance)
  | "plugin:context-keys-changed"
  // Plugin worktree card statuses (always scoped to the status's own project)
  | "plugin:worktree-card-statuses-changed"
  // Plugin worktree readiness checks (always scoped to the checks' own project)
  | "plugin:worktree-review-checks-changed"
  // Plugin terminal header statuses (always scoped to the status's own project)
  | "plugin:terminal-statuses-changed"
  // Plugin runtime panel menus (project-scoped for a project instance)
  | "plugin:panel-menus-changed"
  // Plugin action handlers in flight (project-scoped for a project instance)
  | "plugin:actions-running-changed"
  // Plugin provenance record changed (global broadcast)
  | "plugin:provenance-changed"
  // Plugin stored settings changed (global broadcast for an app-global
  // instance, project-scoped send for a project one)
  | "plugin:settings-changed"
  // Plugin instance runtime health: worker lifecycle + dev session (global
  // broadcast for an app-global instance, project-scoped send for a project one)
  | "plugin:runtime-status-changed"
  // Project-local plugin trust + inventory (project-scoped send)
  | "plugin:project-trust-prompt"
  | "plugin:project-plugins-changed"
  | "plugin:project-plugin-staged"
  | "plugin:project-plugin-visibility-changed"
  | "plugin:project-surfaces-changed"
  // Project's git remotes changed — re-resolve the forge provider (global broadcast)
  | "forge:remote-changed"
  // Background plugin update check found updates (global broadcast)
  | "plugin:bg-update-available"
  // Project groups changed (global broadcast)
  | "project-groups:update"
  // Run history changed (global broadcast)
  | "run-history:update"
  // Copy-tree run history changed (project-scoped send)
  | "copy-tree-history:update"
  // Scheduled-run history changed (project-scoped send)
  | "scheduled-runs:changed"
  // Plugin deep-link intent (targeted at the primary window)
  | "plugin:deep-link"
  // Double-clicked `.dntr` archive awaiting confirmation (targeted at the primary window)
  | "plugin:archive-install-intent"
  // Terminal lifecycle (non-data) — exit, spawn-result, backend crash/ready
  | "terminal:exit"
  | "terminal:backend-crashed"
  | "terminal:backend-recovering"
  | "terminal:backend-ready"
  // Terminal-host memory pause, one snapshot for the whole app (window-scoped)
  | "terminal:host-memory-pause"
  | "terminal:spawn-result"
  // Terminal observability
  | "terminal:resize-result"
  | "terminal:memory-leak-restart-requested"
  | "terminal:reliability-metric"
  | "terminal:status"
  | "terminal:submit-status"
  | "terminal:first-prompt"
  // Terminals handed to an orchestrating pane (global broadcast)
  | "terminal:adoptions-changed"
  | "terminal:canopy-size-holds-changed"
  | "terminal:notify-state"
  // Agent session journaled — resume surfaces refetch (global broadcast)
  | "agent-session:recorded"
  // A gated park auto-released — the ready-again hand-back (global broadcast)
  | "terminal:park-released"
  // Watchdog deadlock detector — emitted once on cap-hit; global broadcast.
  | "watchdog:disabled"
  | "watchdog:active"
>;

/**
 * Compile-time guard: high-frequency / binary-payload channels documented above
 * as excluded by design must never end up in {@link IpcEventBusMap}. Resolves
 * to `true` when the exclusion holds; flips to `never` (and breaks the
 * dependent test in `__tests__/ipcEnvelopeConstraint.test.ts`) the moment one
 * of the banned keys is added to the `Pick<>` list above.
 */
export type _IpcEventBusMapExcludesHighFrequency =
  Extract<
    keyof IpcEventBusMap,
    "terminal:data" | "terminal:resource-metrics" | "logs:batch"
  > extends never
    ? true
    : never;

/**
 * Envelope carried on CHANNELS.EVENTS_PUSH. Discriminated by `name` so the
 * renderer-side `events.on(name, cb)` can filter and narrow the payload type.
 */
export type EventBusEnvelope = {
  [K in keyof IpcEventBusMap]: { name: K; payload: IpcEventBusMap[K] };
}[keyof IpcEventBusMap];

export type IpcInvokeArgs<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["args"];
export type IpcInvokeResult<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["result"];
export type IpcEventPayload<K extends keyof IpcEventMap> = IpcEventMap[K];
