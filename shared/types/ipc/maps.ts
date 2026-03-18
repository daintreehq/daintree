import type { StagingStatus } from "../git.js";
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
import type { GitInitOptions, GitInitProgressEvent, GitInitResult } from "./gitInit.js";
import type { AgentSettings } from "../agentSettings.js";
import type { UserAgentRegistry, UserAgentConfig } from "../userAgentRegistry.js";
import type { KeyAction } from "../keymap.js";
import type { KeybindingImportResult, MicPermissionStatus, VoiceInputSettings } from "./api.js";

import type {
  WorktreeSetActivePayload,
  WorktreeDeletePayload,
  CreateWorktreeOptions,
  BranchInfo,
  WorktreeConfig,
  CreateForTaskPayload,
  CleanupTaskOptions,
  AttachIssuePayload,
  DetachIssuePayload,
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
  SystemWakePayload,
  CliAvailability,
  AgentVersionInfo,
  AgentUpdateSettings,
  StartAgentUpdatePayload,
  StartAgentUpdateResult,
  CliInstallStatus,
  SystemHealthCheckResult,
} from "./system.js";
import type { AppState, HydrateResult } from "./app.js";
import type { LogEntry, LogFilterOptions } from "./logs.js";
import type { RetryAction, AppError, RetryProgressPayload } from "./errors.js";
import type { EventRecord, EventFilterOptions } from "./events.js";
import type {
  ProjectCloseResult,
  ProjectStats,
  ProjectSwitchPayload,
  ProjectMcpServerRunState,
} from "./project.js";
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
import type {
  GitGetFileDiffPayload,
  GitCompareWorktreesPayload,
  CrossWorktreeDiffResult,
} from "./git.js";
import type { TerminalConfig } from "./config.js";
import type { SystemSleepMetrics } from "./systemSleep.js";
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
  GlobalDevServersGetResult,
  GlobalDevServersChangedPayload,
} from "./globalDevServers.js";
import type { ProjectPulse, PulseRangeDays } from "../pulse.js";
import type {
  GitCommitListOptions,
  GitCommitListResponse,
  IssueTooltipData,
  PRTooltipData,
} from "../github.js";
import type { SpawnResult, TerminalStatusPayload } from "../pty-host.js";
import type { HibernationConfig } from "./hibernation.js";
import type { AgentRegistry, AgentMetadata } from "./agentCapabilities.js";
import type { AppThemeConfig } from "../appTheme.js";
import type {
  DemoMoveToPayload,
  DemoMoveToSelectorPayload,
  DemoTypePayload,
  DemoSetZoomPayload,
  DemoWaitForSelectorPayload,
  DemoSleepPayload,
  DemoScreenshotResult,
  DemoStartCapturePayload,
  DemoStartCaptureResult,
  DemoStopCaptureResult,
  DemoCaptureStatus,
  DemoEncodePayload,
  DemoEncodeProgressEvent,
  DemoEncodeResult,
} from "./demo.js";

export type ChecklistItemId = "openedProject" | "launchedAgent" | "createdWorktree";

export interface ChecklistItems {
  openedProject: boolean;
  launchedAgent: boolean;
  createdWorktree: boolean;
}

export interface ChecklistState {
  dismissed: boolean;
  items: ChecklistItems;
}

export interface OnboardingState {
  schemaVersion: number;
  completed: boolean;
  currentStep: string | null;
  firstRunToastSeen: boolean;
  newsletterPromptSeen: boolean;
  migratedFromLocalStorage: boolean;
  checklist: ChecklistState;
}

// IPC Contract Maps

/** Maps IPC channels to their args/result types for type-safe invoke/handle */
export interface IpcInvokeMap {
  // Worktree channels
  "worktree:get-all": {
    args: [];
    result: WorktreeState[];
  };
  "worktree:refresh": {
    args: [];
    result: void;
  };
  "worktree:pr-refresh": {
    args: [];
    result: void;
  };
  "worktree:pr-status": {
    args: [];
    result: import("../workspace-host.js").PRServiceStatus | null;
  };
  "worktree:set-active": {
    args: [payload: WorktreeSetActivePayload];
    result: void;
  };
  "worktree:create": {
    args: [payload: { rootPath: string; options: CreateWorktreeOptions }];
    result: string;
  };
  "worktree:list-branches": {
    args: [payload: { rootPath: string }];
    result: BranchInfo[];
  };
  "worktree:get-recent-branches": {
    args: [payload: { rootPath: string }];
    result: string[];
  };
  "worktree:get-default-path": {
    args: [payload: { rootPath: string; branchName: string }];
    result: string;
  };
  "worktree:get-available-branch": {
    args: [payload: { rootPath: string; branchName: string }];
    result: string;
  };
  "worktree:delete": {
    args: [payload: WorktreeDeletePayload];
    result: void;
  };
  "worktree:create-for-task": {
    args: [payload: CreateForTaskPayload];
    result: WorktreeState;
  };
  "worktree:get-by-task-id": {
    args: [taskId: string];
    result: WorktreeState[];
  };
  "worktree:cleanup-task": {
    args: [taskId: string, options?: CleanupTaskOptions];
    result: void;
  };
  "worktree:attach-issue": {
    args: [payload: AttachIssuePayload];
    result: void;
  };
  "worktree:detach-issue": {
    args: [payload: DetachIssuePayload];
    result: void;
  };
  "worktree:get-issue-association": {
    args: [worktreeId: string];
    result: IssueAssociation | null;
  };
  "worktree:get-all-issue-associations": {
    args: [];
    result: Record<string, IssueAssociation>;
  };

  // Terminal channels
  "terminal:spawn": {
    args: [options: TerminalSpawnOptions];
    result: string;
  };
  "terminal:submit": {
    args: [id: string, text: string];
    result: void;
  };
  "terminal:kill": {
    args: [id: string];
    result: void;
  };
  "terminal:trash": {
    args: [id: string];
    result: void;
  };
  "terminal:restore": {
    args: [id: string];
    result: boolean;
  };
  "terminal:wake": {
    args: [id: string];
    result: { state: string | null; warnings?: string[] };
  };
  "terminal:get-for-project": {
    args: [projectId: string];
    result: BackendTerminalInfo[];
  };
  "terminal:reconnect": {
    args: [terminalId: string];
    result: TerminalReconnectResult;
  };
  "terminal:replay-history": {
    args: [payload: { terminalId: string; maxLines?: number }];
    result: { replayed: number };
  };
  "terminal:get-serialized-state": {
    args: [terminalId: string];
    result: string | null;
  };
  "terminal:get-serialized-states": {
    args: [terminalIds: string[]];
    result: Record<string, string | null>;
  };
  "terminal:get-shared-buffers": {
    args: [];
    result: {
      visualBuffers: SharedArrayBuffer[];
      signalBuffer: SharedArrayBuffer | null;
    };
  };
  "terminal:get-analysis-buffer": {
    args: [];
    result: SharedArrayBuffer | null;
  };
  "terminal:get-info": {
    args: [id: string];
    result: TerminalInfoPayload;
  };
  "terminal:force-resume": {
    args: [id: string];
    result: { success: boolean; error?: string };
  };

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
  "slash-commands:list": {
    args: [payload: SlashCommandListRequest];
    result: SlashCommand[];
  };

  // Agent channels
  "agent-help:get": {
    args: [request: AgentHelpRequest];
    result: AgentHelpResult;
  };

  // Artifact channels
  "artifact:save-to-file": {
    args: [options: SaveArtifactOptions];
    result: SaveArtifactResult | null;
  };
  "artifact:apply-patch": {
    args: [options: ApplyPatchOptions];
    result: ApplyPatchResult;
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

  // Editor channels
  "editor:get-config": {
    args: [projectId?: string];
    result: import("../editor.js").EditorGetConfigResult;
  };
  "editor:set-config": {
    args: [payload: import("../editor.js").EditorSetConfigPayload];
    result: void;
  };
  "editor:discover": {
    args: [];
    result: import("../editor.js").DiscoveredEditor[];
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
    result: void;
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
  "system:get-agent-versions": {
    args: [];
    result: AgentVersionInfo[];
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
    args: [AgentUpdateSettings];
    result: void;
  };
  "system:start-agent-update": {
    args: [StartAgentUpdatePayload];
    result: StartAgentUpdateResult;
  };
  "system:health-check": {
    args: [agentIds?: string[]];
    result: SystemHealthCheckResult;
  };
  "system:download-diagnostics": {
    args: [];
    result: boolean;
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
  "app:quit": {
    args: [];
    result: void;
  };
  "app:force-quit": {
    args: [];
    result: void;
  };
  "menu:show-context": {
    args: [payload: ShowContextMenuPayload];
    result: string | null;
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
    result: { success: boolean };
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
    result: AppError[];
  };

  // Event inspector channels
  "event-inspector:get-events": {
    args: [];
    result: EventRecord[];
  };
  "event-inspector:get-filtered": {
    args: [filters: EventFilterOptions];
    result: EventRecord[];
  };
  "event-inspector:clear": {
    args: [];
    result: void;
  };

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
    args: [path: string];
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
    args: [projectId: string];
    result: Project;
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
    args: [projectId: string];
    result: Project;
  };
  "project:get-stats": {
    args: [projectId: string];
    result: ProjectStats;
  };
  "project:create-folder": {
    args: [payload: { parentPath: string; folderName: string }];
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
    result: TerminalRecipe[];
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
  "project:get-terminals": {
    args: [projectId: string];
    result: TerminalSnapshot[];
  };
  "project:set-terminals": {
    args: [payload: { projectId: string; terminals: TerminalSnapshot[] }];
    result: void;
  };
  "project:get-terminal-sizes": {
    args: [projectId: string];
    result: Record<string, { cols: number; rows: number }>;
  };
  "project:set-terminal-sizes": {
    args: [
      payload: { projectId: string; terminalSizes: Record<string, { cols: number; rows: number }> },
    ];
    result: void;
  };
  "project:get-tab-groups": {
    args: [projectId: string];
    result: TabGroup[];
  };
  "project:set-tab-groups": {
    args: [payload: { projectId: string; tabGroups: TabGroup[] }];
    result: void;
  };
  "project:get-focus-mode": {
    args: [projectId: string];
    result: {
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    };
  };
  "project:set-focus-mode": {
    args: [
      payload: {
        projectId: string;
        focusMode: boolean;
        focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
      },
    ];
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

  // GitHub channels
  "github:get-repo-stats": {
    args: [cwd: string, bypassCache?: boolean];
    result: RepositoryStats;
  };
  "github:get-project-health": {
    args: [cwd: string, bypassCache?: boolean];
    result: ProjectHealthData;
  };
  "github:open-issues": {
    args: [cwd: string, query?: string, state?: string];
    result: void;
  };
  "github:open-prs": {
    args: [cwd: string, query?: string, state?: string];
    result: void;
  };
  "github:open-commits": {
    args: [cwd: string];
    result: void;
  };
  "github:open-issue": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: void;
  };
  "github:open-pr": {
    args: [prUrl: string];
    result: void;
  };
  "github:check-cli": {
    args: [];
    result: GitHubCliStatus;
  };
  "github:get-config": {
    args: [];
    result: GitHubTokenConfig;
  };
  "github:set-token": {
    args: [token: string];
    result: GitHubTokenValidation;
  };
  "github:clear-token": {
    args: [];
    result: void;
  };
  "github:validate-token": {
    args: [token: string];
    result: GitHubTokenValidation;
  };
  "github:list-issues": {
    args: [
      options: { cwd: string; search?: string; state?: "open" | "closed" | "all"; cursor?: string },
    ];
    result: import("../github.js").GitHubListResponse<import("../github.js").GitHubIssue>;
  };
  "github:assign-issue": {
    args: [payload: { cwd: string; issueNumber: number; username: string }];
    result: void;
  };
  "github:list-prs": {
    args: [
      options: {
        cwd: string;
        search?: string;
        state?: "open" | "closed" | "merged" | "all";
        cursor?: string;
      },
    ];
    result: import("../github.js").GitHubListResponse<import("../github.js").GitHubPR>;
  };
  "github:get-issue-url": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: string | null;
  };
  "github:get-issue-tooltip": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: IssueTooltipData | null;
  };
  "github:get-pr-tooltip": {
    args: [payload: { cwd: string; prNumber: number }];
    result: PRTooltipData | null;
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
  "terminal-config:get": {
    args: [];
    result: TerminalConfig;
  };
  "terminal-config:set-scrollback": {
    args: [scrollbackLines: number];
    result: void;
  };
  "terminal-config:set-performance-mode": {
    args: [performanceMode: boolean];
    result: void;
  };
  "terminal-config:set-font-size": {
    args: [fontSize: number];
    result: void;
  };
  "terminal-config:set-font-family": {
    args: [fontFamily: string];
    result: void;
  };
  "terminal-config:set-hybrid-input-enabled": {
    args: [enabled: boolean];
    result: void;
  };
  "terminal-config:set-hybrid-input-auto-focus": {
    args: [enabled: boolean];
    result: void;
  };
  "terminal-config:set-color-scheme": {
    args: [schemeId: string];
    result: void;
  };
  "terminal-config:set-custom-schemes": {
    args: [schemesJson: string];
    result: void;
  };
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

  "terminal-config:set-screen-reader-mode": {
    args: [mode: "auto" | "on" | "off"];
    result: void;
  };

  // Accessibility channels
  "accessibility:get-enabled": {
    args: [];
    result: boolean;
  };

  // Git channels
  "git:get-file-diff": {
    args: [payload: GitGetFileDiffPayload];
    result: string;
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
    args: [payload: { cwd: string; setUpstream?: boolean }];
    result: { success: boolean; error?: string };
  };
  "git:get-staging-status": {
    args: [cwd: string];
    result: StagingStatus;
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

  // Sidecar channels
  "sidecar:create": {
    args: [payload: import("../sidecar.js").SidecarCreatePayload];
    result: void;
  };
  "sidecar:show": {
    args: [payload: import("../sidecar.js").SidecarShowPayload];
    result: void;
  };
  "sidecar:hide": {
    args: [];
    result: void;
  };
  "sidecar:resize": {
    args: [bounds: import("../sidecar.js").SidecarBounds];
    result: void;
  };
  "sidecar:close-tab": {
    args: [payload: import("../sidecar.js").SidecarCloseTabPayload];
    result: void;
  };
  "sidecar:navigate": {
    args: [payload: import("../sidecar.js").SidecarNavigatePayload];
    result: void;
  };
  "sidecar:go-back": {
    args: [tabId: string];
    result: boolean;
  };
  "sidecar:go-forward": {
    args: [tabId: string];
    result: boolean;
  };
  "sidecar:reload": {
    args: [tabId: string];
    result: void;
  };
  "sidecar:show-new-tab-menu": {
    args: [payload: import("../sidecar.js").SidecarShowNewTabMenuPayload];
    result: void;
  };

  // System Sleep channels
  "system-sleep:get-metrics": {
    args: [];
    result: SystemSleepMetrics;
  };
  "system-sleep:get-awake-time": {
    args: [startTimestamp: number];
    result: number;
  };
  "system-sleep:reset": {
    args: [];
    result: void;
  };

  // Hibernation channels
  "hibernation:get-config": {
    args: [];
    result: HibernationConfig;
  };
  "hibernation:update-config": {
    args: [config: Partial<HibernationConfig>];
    result: HibernationConfig;
  };

  // Keybinding channels
  "keybinding:get-overrides": {
    args: [];
    result: Record<KeyAction, string[]>;
  };
  "keybinding:set-override": {
    args: [payload: { actionId: KeyAction; combo: string[] }];
    result: void;
  };
  "keybinding:remove-override": {
    args: [actionId: KeyAction];
    result: void;
  };
  "keybinding:reset-all": {
    args: [];
    result: void;
  };
  "keybinding:export-profile": {
    args: [];
    result: boolean;
  };
  "keybinding:import-profile": {
    args: [];
    result: KeybindingImportResult;
  };

  // Worktree Config channels
  "worktree-config:get": {
    args: [];
    result: WorktreeConfig;
  };
  "worktree-config:set-pattern": {
    args: [payload: { pattern: string }];
    result: WorktreeConfig;
  };

  // Gemini channels
  "gemini:get-status": {
    args: [];
    result: { exists: boolean; alternateBufferEnabled: boolean; error?: string };
  };
  "gemini:enable-alternate-buffer": {
    args: [];
    result: { success: boolean };
  };

  // Notes channels
  "notes:create": {
    args: [title: string, scope: "worktree" | "project", worktreeId?: string];
    result: {
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
    };
  };
  "notes:read": {
    args: [notePath: string];
    result: {
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
    };
  };
  "notes:write": {
    args: [
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
      expectedLastModified?: number,
    ];
    result: {
      lastModified?: number;
      error?: "conflict";
      message?: string;
      currentLastModified?: number;
    };
  };
  "notes:list": {
    args: [];
    result: {
      id: string;
      title: string;
      path: string;
      scope: "worktree" | "project";
      worktreeId?: string;
      createdAt: number;
      modifiedAt: number;
      preview: string;
      tags: string[];
    }[];
  };
  "notes:delete": {
    args: [notePath: string];
    result: void;
  };
  "notes:search": {
    args: [query: string];
    result: {
      notes: {
        id: string;
        title: string;
        path: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        modifiedAt: number;
        preview: string;
        tags: string[];
      }[];
      query: string;
    };
  };

  // Workflow channels
  "workflow:list": {
    args: [];
    result: import("../workflow.js").WorkflowSummary[];
  };
  "workflow:start": {
    args: [workflowId: string];
    result: string;
  };
  "workflow:cancel": {
    args: [runId: string];
    result: void;
  };
  "workflow:get-run": {
    args: [runId: string];
    result: import("./api.js").WorkflowRunIpc | null;
  };
  "workflow:list-runs": {
    args: [];
    result: import("./api.js").WorkflowRunIpc[];
  };

  // Workflow approval channels
  "workflow:list-pending-approvals": {
    args: [];
    result: import("../workflowRun.js").PendingWorkflowApproval[];
  };
  "workflow:resolve-approval": {
    args: [payload: { runId: string; nodeId: string; approved: boolean; feedback?: string }];
    result: void;
  };

  // Dev Preview channels
  "dev-preview:ensure": {
    args: [request: DevPreviewEnsureRequest];
    result: DevPreviewSessionState;
  };
  "dev-preview:restart": {
    args: [request: DevPreviewSessionRequest];
    result: DevPreviewSessionState;
  };
  "dev-preview:stop": {
    args: [request: DevPreviewSessionRequest];
    result: DevPreviewSessionState;
  };
  "dev-preview:stop-by-panel": {
    args: [request: DevPreviewStopByPanelRequest];
    result: void;
  };
  "dev-preview:get-state": {
    args: [request: DevPreviewSessionRequest];
    result: DevPreviewSessionState;
  };

  // Global Dev Servers channels
  "global-dev-servers:get": {
    args: [];
    result: GlobalDevServersGetResult;
  };

  // Auto-update channels
  "update:quit-and-install": {
    args: [];
    result: void;
  };
  "update:check-for-updates": {
    args: [];
    result: void;
  };

  // Agent Capabilities channels
  "agent-capabilities:get-registry": {
    args: [];
    result: AgentRegistry;
  };
  "agent-capabilities:get-agent-ids": {
    args: [];
    result: string[];
  };
  "agent-capabilities:get-agent-metadata": {
    args: [agentId: string];
    result: AgentMetadata | null;
  };
  "agent-capabilities:is-agent-enabled": {
    args: [agentId: string];
    result: boolean;
  };

  // Canopy CLI install channels
  "cli:install": {
    args: [];
    result: CliInstallStatus;
  };
  "cli:get-status": {
    args: [];
    result: CliInstallStatus;
  };

  // Clipboard channels
  "clipboard:save-image": {
    args: [];
    result: { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string };
  };
  "clipboard:thumbnail-from-path": {
    args: [filePath: string];
    result: { ok: true; filePath: string; thumbnailDataUrl: string } | { ok: false; error: string };
  };

  // Notification settings channels
  "notification:settings-get": {
    args: [];
    result: {
      completedEnabled: boolean;
      waitingEnabled: boolean;
      failedEnabled: boolean;
      soundEnabled: boolean;
      soundFile: string;
      waitingEscalationEnabled: boolean;
      waitingEscalationDelayMs: number;
    };
  };
  "notification:settings-set": {
    args: [
      Partial<{
        completedEnabled: boolean;
        waitingEnabled: boolean;
        failedEnabled: boolean;
        soundEnabled: boolean;
        soundFile: string;
        waitingEscalationEnabled: boolean;
        waitingEscalationDelayMs: number;
      }>,
    ];
    result: void;
  };
  "notification:play-sound": {
    args: [string];
    result: void;
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
    args: [schemesJson: string];
    result: void;
  };
  "app-theme:import": {
    args: [];
    result: import("../appTheme.js").AppThemeImportResult;
  };
  "app-theme:set-color-vision-mode": {
    args: [mode: import("../appTheme.js").ColorVisionMode];
    result: void;
  };
  "telemetry:get": {
    args: [];
    result: { enabled: boolean; hasSeenPrompt: boolean };
  };
  "telemetry:set-enabled": {
    args: [enabled: boolean];
    result: void;
  };
  "telemetry:mark-prompt-shown": {
    args: [];
    result: void;
  };
  "telemetry:track": {
    args: [event: string, properties: Record<string, unknown>];
    result: void;
  };

  // GPU
  "gpu:get-status": {
    args: [];
    result: { hardwareAccelerationDisabled: boolean };
  };
  "gpu:set-hardware-acceleration": {
    args: [enabled: boolean];
    result: void;
  };

  // Privacy & Data
  "privacy:get-settings": {
    args: [];
    result: {
      telemetryLevel: "off" | "errors" | "full";
      logRetentionDays: 0 | 7 | 30 | 90;
      dataFolderPath: string;
    };
  };
  "privacy:set-telemetry-level": {
    args: [level: "off" | "errors" | "full"];
    result: void;
  };
  "privacy:set-log-retention": {
    args: [days: 0 | 7 | 30 | 90];
    result: void;
  };
  "privacy:open-data-folder": {
    args: [];
    result: void;
  };
  "privacy:clear-cache": {
    args: [];
    result: void;
  };
  "privacy:reset-all-data": {
    args: [];
    result: void;
  };
  "privacy:get-data-folder-path": {
    args: [];
    result: string;
  };

  // Onboarding
  "onboarding:get": {
    args: [];
    result: OnboardingState;
  };
  "onboarding:migrate": {
    args: [
      payload: {
        agentSelectionDismissed: boolean;
        agentSetupComplete: boolean;
        firstRunToastSeen: boolean;
      },
    ];
    result: OnboardingState;
  };
  "onboarding:set-step": {
    args: [step: string | null];
    result: void;
  };
  "onboarding:complete": {
    args: [];
    result: void;
  };
  "onboarding:mark-toast-seen": {
    args: [];
    result: void;
  };
  "onboarding:mark-newsletter-seen": {
    args: [];
    result: void;
  };
  "onboarding:checklist-get": {
    args: [];
    result: ChecklistState;
  };
  "onboarding:checklist-dismiss": {
    args: [];
    result: void;
  };
  "onboarding:checklist-mark-item": {
    args: [item: ChecklistItemId];
    result: void;
  };

  // Voice input
  "voice-input:get-settings": {
    args: [];
    result: VoiceInputSettings;
  };
  "voice-input:set-settings": {
    args: [patch: Partial<VoiceInputSettings>];
    result: void;
  };
  "voice-input:start": {
    args: [];
    result: { ok: true } | { ok: false; error: string };
  };
  "voice-input:stop": {
    args: [];
    result: { rawText: string | null; correctionId: string | null };
  };
  "voice-input:flush-paragraph": {
    args: [];
    result: { rawText: string | null; correctionId: string | null };
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
    result: void;
  };
  "voice-input:validate-api-key": {
    args: [apiKey: string];
    result: { valid: boolean; error?: string };
  };
  "voice-input:validate-correction-api-key": {
    args: [apiKey: string];
    result: { valid: boolean; error?: string };
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

  // MCP Server channels
  "mcp-server:get-status": {
    args: [];
    result: {
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    };
  };
  "mcp-server:set-enabled": {
    args: [enabled: boolean];
    result: {
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    };
  };
  "mcp-server:set-port": {
    args: [port: number | null];
    result: {
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    };
  };
  "mcp-server:set-api-key": {
    args: [apiKey: string];
    result: {
      enabled: boolean;
      port: number | null;
      configuredPort: number | null;
      apiKey: string;
    };
  };
  "mcp-server:generate-api-key": {
    args: [];
    result: string;
  };
  "mcp-server:get-config-snippet": {
    args: [];
    result: string;
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
    args: [webContentsId: number, objectId: string];
    result: import("./webviewConsole.js").CdpGetPropertiesResult;
  };

  // Demo mode channels (dev-only, gated by --demo-mode flag)
  "demo:move-to": {
    args: [payload: DemoMoveToPayload];
    result: void;
  };
  "demo:move-to-selector": {
    args: [payload: DemoMoveToSelectorPayload];
    result: void;
  };
  "demo:click": {
    args: [];
    result: void;
  };
  "demo:type": {
    args: [payload: DemoTypePayload];
    result: void;
  };
  "demo:set-zoom": {
    args: [payload: DemoSetZoomPayload];
    result: void;
  };
  "demo:screenshot": {
    args: [];
    result: DemoScreenshotResult;
  };
  "demo:wait-for-selector": {
    args: [payload: DemoWaitForSelectorPayload];
    result: void;
  };
  "demo:pause": {
    args: [];
    result: void;
  };
  "demo:resume": {
    args: [];
    result: void;
  };
  "demo:sleep": {
    args: [payload: DemoSleepPayload];
    result: void;
  };
  "demo:start-capture": {
    args: [payload: DemoStartCapturePayload];
    result: DemoStartCaptureResult;
  };
  "demo:stop-capture": {
    args: [];
    result: DemoStopCaptureResult;
  };
  "demo:get-capture-status": {
    args: [];
    result: DemoCaptureStatus;
  };
  "demo:encode": {
    args: [payload: DemoEncodePayload];
    result: DemoEncodeResult;
  };

  // Project MCP server channels
  "project-mcp:get-statuses": {
    args: [projectId: string];
    result: ProjectMcpServerRunState[];
  };
}

/**
 * IPC Event Contract Map
 */
export interface IpcEventMap {
  // Worktree events
  "worktree:update": WorktreeState;
  "worktree:remove": { worktreeId: string };
  "worktree:activated": { worktreeId: string };

  // Terminal events
  "terminal:data": [id: string, data: string | Uint8Array];
  "terminal:exit": [id: string, exitCode: number];
  "terminal:error": [id: string, error: string];
  "terminal:trashed": { id: string; expiresAt: number };
  "terminal:restored": { id: string };
  "terminal:status": TerminalStatusPayload;
  "terminal:send-key": [id: string, key: string];
  "terminal:spawn-result": [id: string, result: SpawnResult];
  "terminal:backend-crashed": {
    crashType: string;
    code: number | null;
    signal: string | null;
    timestamp: number;
  };
  "terminal:backend-ready": void;
  "terminal:reduce-scrollback": { terminalIds: string[]; targetLines: number };
  "terminal:restore-scrollback": { terminalIds: string[] };

  // Agent events
  "agent:state-changed": AgentStateChangePayload;
  "agent:detected": AgentDetectedPayload;
  "agent:exited": AgentExitedPayload;

  // Terminal activity events
  "terminal:activity": TerminalActivityPayload;

  // Artifact events
  "artifact:detected": ArtifactDetectedPayload;

  // CopyTree events
  "copytree:progress": CopyTreeProgress;

  // Git init events
  "project:init-git-progress": GitInitProgressEvent;

  // PR detection events
  "pr:detected": PRDetectedPayload;
  "pr:cleared": PRClearedPayload;

  // Issue detection events
  "issue:detected": IssueDetectedPayload;
  "issue:not-found": IssueNotFoundPayload;

  // Error events
  "error:notify": AppError;
  "error:retry-progress": RetryProgressPayload;

  // Log events
  "logs:entry": LogEntry;
  "logs:batch": LogEntry[];

  // Event inspector events
  "event-inspector:event": EventRecord;

  // Project events
  "project:on-switch": ProjectSwitchPayload;

  // System events
  "system:wake": SystemWakePayload;

  // Sidecar events
  "sidecar:nav-event": import("../sidecar.js").SidecarNavEvent;
  "sidecar:focus": void;
  "sidecar:blur": void;
  "sidecar:new-tab-menu-action": import("../sidecar.js").SidecarNewTabMenuAction;

  // System Sleep events
  "system-sleep:on-suspend": void;
  "system-sleep:on-wake": number;

  // Menu events
  "menu:action": string;

  // Window events
  "window:fullscreen-change": boolean;

  // Notification events
  "notification:update": { waitingCount: number; failedCount: number };
  "notification:watch-navigate": { panelId: string; panelTitle: string; worktreeId?: string };

  // Auto-update events
  "update:available": { version: string };
  "update:download-progress": { percent: number };
  "update:downloaded": { version: string };
  "update:error": { message: string };

  // Dev Preview events
  "dev-preview:state-changed": DevPreviewStateChangedPayload;

  // Global Dev Servers events
  "global-dev-servers:changed": GlobalDevServersChangedPayload;

  // Notes events
  "notes:updated": {
    notePath: string;
    title: string;
    action: "created" | "updated" | "deleted";
  };

  // Workflow events
  "workflow:started": import("./api.js").WorkflowStartedPayload;
  "workflow:completed": import("./api.js").WorkflowCompletedPayload;
  "workflow:failed": import("./api.js").WorkflowFailedPayload;
  "workflow:approval-requested": {
    runId: string;
    nodeId: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    requestedAt: number;
    timeoutMs?: number;
    timeoutAt?: number;
    timestamp: number;
  };
  "workflow:approval-cleared": {
    runId: string;
    nodeId: string;
    reason: string;
    timestamp: number;
  };

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
  };

  // Webview find-in-page shortcut forwarded from guest
  "webview:find-shortcut": {
    panelId: string;
    shortcut: "find" | "next" | "prev" | "close";
  };

  // Voice input events
  "voice-input:transcription-delta": string;
  "voice-input:transcription-complete": { text: string; willCorrect: boolean };
  "voice-input:correction-queued": {
    correctionId: string;
    rawText: string;
    reason: string;
  };
  "voice-input:correction-replace": { correctionId: string; correctedText: string };
  "voice-input:paragraph-boundary": { rawText: string | null; correctionId: string | null };
  "voice-input:error": string;
  "voice-input:status": "idle" | "connecting" | "recording" | "error";

  // Demo mode events (main → renderer command forwarding)
  "demo:exec-move-to": DemoMoveToPayload;
  "demo:exec-move-to-selector": DemoMoveToSelectorPayload;
  "demo:exec-click": void;
  "demo:exec-type": DemoTypePayload;
  "demo:exec-set-zoom": DemoSetZoomPayload;
  "demo:exec-pause": void;
  "demo:exec-resume": void;
  "demo:exec-wait-for-selector": DemoWaitForSelectorPayload;
  "demo:exec-sleep": DemoSleepPayload;
  "demo:encode:progress": DemoEncodeProgressEvent;

  // Accessibility events
  "accessibility:support-changed": { enabled: boolean };

  // Project MCP server events
  "project-mcp:status-changed": {
    projectId: string;
    servers: ProjectMcpServerRunState[];
  };
}

export type IpcInvokeArgs<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["args"];
export type IpcInvokeResult<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["result"];
export type IpcEventPayload<K extends keyof IpcEventMap> = IpcEventMap[K];
