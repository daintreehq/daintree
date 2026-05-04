import path from "path";
import { events } from "../events.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { gitHubRateLimitService } from "../github/index.js";
import { type ProcessEntry, type CopyTreeProgressCallback, sendToEntryWindows } from "./types.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

export type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

export interface WorkspaceHostEventRouterDeps {
  emit: EmitFn;
  worktreePathToProject: Map<string, string>;
  copyTreeProgressCallbacks: Map<string, CopyTreeProgressCallback>;
}

export class WorkspaceHostEventRouter {
  private static readonly RATE_LIMIT_TOKEN_CHANGE_GUARD_MS = 5_000;

  private emit: EmitFn;
  private worktreePathToProject: Map<string, string>;
  private copyTreeProgressCallbacks: Map<string, CopyTreeProgressCallback>;

  private githubTokenChangeAt = 0;

  constructor(deps: WorkspaceHostEventRouterDeps) {
    this.emit = deps.emit;
    this.worktreePathToProject = deps.worktreePathToProject;
    this.copyTreeProgressCallbacks = deps.copyTreeProgressCallbacks;
  }

  updateGitHubToken(_token: string | null): void {
    this.githubTokenChangeAt = Date.now();
  }

  routeHostEvent(entry: ProcessEntry, event: WorkspaceHostEvent): void {
    switch (event.type) {
      case "worktree-update": {
        const worktree = event.worktree;
        if (worktree.path) {
          this.worktreePathToProject.set(path.resolve(worktree.path), entry.projectPath);
        }
        sendToEntryWindows(entry, CHANNELS.EVENTS_PUSH, {
          name: "worktree:update",
          payload: { worktree },
        });
        this.emit("worktree-update", {
          worktree,
          projectPath: entry.projectPath,
        });
        events.emit("sys:worktree:update", {
          id: worktree.id,
          path: worktree.path,
          name: worktree.name,
          branch: worktree.branch,
          isCurrent: worktree.isCurrent,
          isMainWorktree: worktree.isMainWorktree,
          gitDir: worktree.gitDir,
          summary: worktree.summary,
          modifiedCount: worktree.modifiedCount,
          changes: worktree.changes,
          mood: worktree.mood,
          lastActivityTimestamp: worktree.lastActivityTimestamp ?? null,
          createdAt: worktree.createdAt,
          aiNote: worktree.aiNote,
          aiNoteTimestamp: worktree.aiNoteTimestamp,
          issueNumber: worktree.issueNumber,
          prNumber: worktree.prNumber,
          prUrl: worktree.prUrl,
          prState: worktree.prState,
          worktreeChanges: worktree.worktreeChanges,
          worktreeId: worktree.worktreeId,
          timestamp: worktree.timestamp,
        } as any);
        break;
      }

      case "worktree-removed":
        sendToEntryWindows(entry, CHANNELS.WORKTREE_REMOVE, {
          worktreeId: event.worktreeId,
        });
        this.emit("worktree-removed", {
          worktreeId: event.worktreeId,
          projectPath: entry.projectPath,
        });
        break;

      case "pr-detected": {
        const prPayload = {
          worktreeId: event.worktreeId,
          prNumber: event.prNumber,
          prUrl: event.prUrl,
          prState: event.prState,
          prTitle: event.prTitle,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          timestamp: Date.now(),
        };
        events.emit("sys:pr:detected", prPayload);
        sendToEntryWindows(entry, CHANNELS.PR_DETECTED, prPayload);
        break;
      }

      case "pr-cleared": {
        const clearPayload = {
          worktreeId: event.worktreeId,
          timestamp: Date.now(),
        };
        events.emit("sys:pr:cleared", clearPayload);
        sendToEntryWindows(entry, CHANNELS.PR_CLEARED, clearPayload);
        break;
      }

      case "issue-detected": {
        const issuePayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
        };
        events.emit("sys:issue:detected", {
          ...issuePayload,
          timestamp: Date.now(),
        });
        sendToEntryWindows(entry, CHANNELS.ISSUE_DETECTED, issuePayload);
        break;
      }

      case "issue-not-found": {
        const notFoundPayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          timestamp: Date.now(),
        };
        events.emit("sys:issue:not-found", notFoundPayload);
        sendToEntryWindows(entry, CHANNELS.ISSUE_NOT_FOUND, notFoundPayload);
        break;
      }

      case "github-rate-limit-changed": {
        if (
          event.state.blocked &&
          this.githubTokenChangeAt > 0 &&
          Date.now() - this.githubTokenChangeAt <
            WorkspaceHostEventRouter.RATE_LIMIT_TOKEN_CHANGE_GUARD_MS
        ) {
          break;
        }
        gitHubRateLimitService.applyRemoteState(event.state);
        break;
      }

      case "copytree:progress": {
        const callback = this.copyTreeProgressCallbacks.get(event.operationId);
        callback?.(event.progress);
        break;
      }

      case "inotify-limit-reached": {
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "warning",
          title: "File watching degraded",
          message:
            "Linux inotify watch limit reached. Some files may not auto-refresh until you raise it.",
          action: {
            label: "Copy fix command",
            ipcChannel: CHANNELS.CLIPBOARD_WRITE_TEXT,
            data: "sudo sysctl fs.inotify.max_user_watches=524288",
          },
        });
        break;
      }

      case "emfile-limit-reached": {
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "warning",
          title: "File watching degraded",
          message:
            "macOS file descriptor ceiling reached. Some files may not auto-refresh until you raise it.",
          action: {
            label: "Copy fix command",
            ipcChannel: CHANNELS.CLIPBOARD_WRITE_TEXT,
            data: "sudo sysctl -w kern.maxfilesperproc=64000",
          },
        });
        break;
      }
    }
  }
}
