import type {
  WorktreeState,
  Project,
  ProjectSettings,
  RunCommand,
  AgentId,
  TerminalRecipe,
} from "../domain.js";
import type { AgentSettings } from "../agentSettings.js";
import type { UserAgentRegistry, UserAgentConfig } from "../userAgentRegistry.js";
import type { KeyAction } from "../keymap.js";

import type {
  WorktreeSetActivePayload,
  WorktreeDeletePayload,
  CreateWorktreeOptions,
  BranchInfo,
  WorktreeConfig,
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
  FileTreeNode,
  CopyTreeProgress,
} from "./copyTree.js";
import type {
  SystemOpenExternalPayload,
  SystemOpenPathPayload,
  SystemWakePayload,
  CliAvailability,
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
import type { GitGetFileDiffPayload } from "./git.js";
import type { TerminalConfig } from "./config.js";
import type { SystemSleepMetrics } from "./systemSleep.js";
import type { ShowContextMenuPayload } from "../menu.js";
import type { FileSearchPayload, FileSearchResult } from "./files.js";
import type { SlashCommand, SlashCommandListRequest } from "../slashCommands.js";
import type { DevPreviewStatusPayload, DevPreviewUrlPayload } from "./devPreview.js";
import type { ProjectPulse, PulseRangeDays } from "../pulse.js";
import type {
  GitCommitListOptions,
  GitCommitListResponse,
  IssueTooltipData,
  PRTooltipData,
} from "../github.js";
import type { SpawnResult, TerminalStatusPayload } from "../pty-host.js";
import type { HibernationConfig } from "./hibernation.js";

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

  // System channels
  "system:open-external": {
    args: [payload: SystemOpenExternalPayload];
    result: void;
  };
  "system:open-path": {
    args: [payload: SystemOpenPathPayload];
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
  "system:get-cli-availability": {
    args: [];
    result: CliAvailability;
  };
  "system:refresh-cli-availability": {
    args: [];
    result: CliAvailability;
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

  // Error channels
  "error:retry": {
    args: [payload: { errorId: string; action: RetryAction; args?: Record<string, unknown> }];
    result: void;
  };
  "error:open-logs": {
    args: [];
    result: void;
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
    args: [projectId: string];
    result: ProjectCloseResult;
  };
  "project:reopen": {
    args: [projectId: string];
    result: void;
  };
  "project:get-stats": {
    args: [projectId: string];
    result: ProjectStats;
  };
  "project:init-git": {
    args: [directoryPath: string];
    result: { success: boolean; error?: string };
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

  // GitHub channels
  "github:get-repo-stats": {
    args: [cwd: string, bypassCache?: boolean];
    result: RepositoryStats;
  };
  "github:open-issues": {
    args: [cwd: string];
    result: void;
  };
  "github:open-prs": {
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
      }[];
      query: string;
    };
  };

  // Dev Preview channels
  "dev-preview:start": {
    args: [panelId: string, cwd: string, cols: number, rows: number, devCommand?: string];
    result: void;
  };
  "dev-preview:stop": {
    args: [panelId: string];
    result: void;
  };
  "dev-preview:restart": {
    args: [panelId: string];
    result: void;
  };
  "dev-preview:set-url": {
    args: [panelId: string, url: string];
    result: void;
  };
}

/**
 * IPC Event Contract Map
 */
export interface IpcEventMap {
  // Worktree events
  "worktree:update": WorktreeState;
  "worktree:remove": { worktreeId: string };

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

  // PR detection events
  "pr:detected": PRDetectedPayload;
  "pr:cleared": PRClearedPayload;

  // Issue detection events
  "issue:detected": IssueDetectedPayload;

  // Error events
  "error:notify": AppError;

  // Log events
  "logs:entry": LogEntry;
  "logs:batch": LogEntry[];

  // Event inspector events
  "event-inspector:event": EventRecord;

  // Project events
  "project:on-switch": Project;

  // System events
  "system:wake": SystemWakePayload;

  // Sidecar events
  "sidecar:nav-event": import("../sidecar.js").SidecarNavEvent;
  "sidecar:focus": void;
  "sidecar:blur": void;
  "sidecar:new-tab-menu-action": import("../sidecar.js").SidecarNewTabMenuAction;

  // System Sleep events
  "system-sleep:on-wake": number;

  // Menu events
  "menu:action": string;

  // Window events
  "window:fullscreen-change": boolean;

  // Notification events
  "notification:update": { waitingCount: number; failedCount: number };

  // Dev Preview events
  "dev-preview:status": DevPreviewStatusPayload;
  "dev-preview:url": DevPreviewUrlPayload;

  // Notes events
  "notes:updated": {
    notePath: string;
    title: string;
    action: "created" | "updated" | "deleted";
  };
}

export type IpcInvokeArgs<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["args"];
export type IpcInvokeResult<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["result"];
export type IpcEventPayload<K extends keyof IpcEventMap> = IpcEventMap[K];
