import path from "path";
import { events } from "../events.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { gitHubRateLimitService } from "../github/index.js";
import { notifyError } from "../../ipc/errorHandlers.js";
import { type ProcessEntry, type CopyTreeProgressCallback, sendToEntryWindows } from "./types.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { RateLimitInfo } from "../../../shared/types/forge.js";
import type { GitHubRateLimitPayload } from "../../../shared/types/ipc/github.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";

export type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

export interface WorkspaceHostEventRouterDeps {
  emit: EmitFn;
  worktreePathToProject: Map<string, string>;
  copyTreeProgressCallbacks: Map<string, CopyTreeProgressCallback>;
}

// Reconstruct a GitHubRateLimitPayload from the provider-agnostic RateLimitInfo
// so the existing gitHubRateLimitService.applyRemoteState() path in main works
// unchanged for the GitHub provider.
function toGitHubRateLimitPayload(info: RateLimitInfo): GitHubRateLimitPayload {
  if (info.remaining !== 0 && !info.secondaryThrottled) {
    return { blocked: false, kind: null };
  }
  // `applyRemoteState` requires `resetAt` for any blocked payload (absent
  // `resetAt` it calls `clear()`). Use a 60s fallback matching the secondary
  // throttle convention so the block is always preserved across the relay.
  const resetAt = info.resetAt ?? Date.now() + 60_000;
  return {
    blocked: true,
    kind: info.secondaryThrottled ? "secondary" : "primary",
    resetAt,
  };
}

export class WorkspaceHostEventRouter {
  private static readonly RATE_LIMIT_TOKEN_CHANGE_GUARD_MS = 5_000;

  private emit: EmitFn;
  private worktreePathToProject: Map<string, string>;
  private copyTreeProgressCallbacks: Map<string, CopyTreeProgressCallback>;

  private forgeCredentialChangeAt = new Map<string, number>();
  private inotifyLimitToastSent = false;
  private emfileLimitToastSent = false;
  private forgeRateLimitStates = new Map<string, RateLimitInfo>();
  private cloudTeardownFailureToastKeys = new Set<string>();

  constructor(deps: WorkspaceHostEventRouterDeps) {
    this.emit = deps.emit;
    this.worktreePathToProject = deps.worktreePathToProject;
    this.copyTreeProgressCallbacks = deps.copyTreeProgressCallbacks;
  }

  updateForgeCredentials(
    providerId: string,
    _credentials: import("../../../shared/types/forge.js").Credentials | null
  ): void {
    this.forgeCredentialChangeAt.set(providerId, Date.now());
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
        events.emit("sys:worktree:update", worktree);

        // Cloud-side teardown failure: when `phase: "resource-teardown"` ends in
        // `failed` or `timed-out`, the user's cloud resource may still be running
        // and billing — the worktree row is about to disappear, so the inbox is
        // the only durable surface. Fired in transit (before the next phase's
        // `running` snapshot overwrites the status) and debounced per
        // `(worktreeId, startedAt)` so repeated snapshots of the same failure
        // don't spam.
        //
        // Asymmetric: we deliberately do NOT mirror this for `phase: "teardown"`
        // (local cleanup) failures. The directory is about to be removed and the
        // user cannot act differently than by ignoring the signal — notify()'s
        // four-question checklist demotes it. Do not "fix" this asymmetry.
        const status = worktree.lifecycleStatus;
        if (
          status?.phase === "resource-teardown" &&
          (status.state === "failed" || status.state === "timed-out")
        ) {
          const key = `${worktree.worktreeId}:${status.startedAt}`;
          if (!this.cloudTeardownFailureToastKeys.has(key)) {
            this.cloudTeardownFailureToastKeys.add(key);
            broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
              type: "error",
              title: "Cloud resource may still be running",
              message:
                "The teardown script didn't complete — your cloud resource may still be active and billing",
              // Dedicated bucket so an unrelated error burst can't absorb this
              // billing-critical notification into a generic overflow row.
              rateLimitKey: "cloud-teardown-failure",
            });
          }
        }
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
        // `linked` is the source of truth (#8452) — derive the canonical
        // provider/owner/repo from it rather than reintroducing empty
        // strings on this second hop (workspace-host → router → bus).
        const linkedRef = event.linked?.pr?.ref ?? event.linked?.issue?.ref;
        const providerId = event.linked?.providerId ?? event.providerId ?? "";
        const owner = linkedRef?.owner ?? "";
        const repo = linkedRef?.repo ?? "";
        const prPayload = {
          worktreeId: event.worktreeId,
          prNumber: event.prNumber,
          prUrl: event.prUrl,
          prState: event.prState,
          prCiStatus: event.prCiStatus,
          prTitle: event.prTitle,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          timestamp: Date.now(),
        };
        events.emit("sys:pr:detected", { ...prPayload, providerId, owner, repo });
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
        // `linked` is the source of truth (#8452) — derive the canonical
        // provider/owner/repo from it rather than reintroducing empty
        // strings on this second hop (workspace-host → router → bus).
        const linkedRef = event.linked?.issue?.ref ?? event.linked?.pr?.ref;
        const providerId = event.linked?.providerId ?? event.providerId ?? "";
        const owner = linkedRef?.owner ?? "";
        const repo = linkedRef?.repo ?? "";
        const issuePayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
        };
        events.emit("sys:issue:detected", {
          ...issuePayload,
          providerId,
          owner,
          repo,
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

      case "forge-rate-limit-changed": {
        // Route rate-limit state by provider. GitHub's provider updates the
        // existing `gitHubRateLimitService` singleton so the toolbar countdown
        // and main-process callers see limits triggered by workspace-host polling.
        // Unknown providers get cached locally for future inspection.
        if (event.providerId === BUILTIN_GITHUB_PROVIDER_ID) {
          const ghChangeAt = this.forgeCredentialChangeAt.get(BUILTIN_GITHUB_PROVIDER_ID) ?? 0;
          if (
            event.state.remaining === 0 &&
            ghChangeAt > 0 &&
            Date.now() - ghChangeAt < WorkspaceHostEventRouter.RATE_LIMIT_TOKEN_CHANGE_GUARD_MS
          ) {
            break;
          }
          const payload = toGitHubRateLimitPayload(event.state);
          gitHubRateLimitService.applyRemoteState(payload);
        } else {
          this.forgeRateLimitStates.set(event.providerId, event.state);
        }
        break;
      }

      case "copytree:progress": {
        const callback = this.copyTreeProgressCallbacks.get(event.operationId);
        callback?.(event.progress);
        break;
      }

      case "inotify-limit-reached": {
        if (this.inotifyLimitToastSent) break;
        this.inotifyLimitToastSent = true;
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

      case "lifecycle-setup-error": {
        const err = new Error(event.message);
        if (event.details !== undefined) {
          err.stack = event.details;
        }
        notifyError(err, {
          source: "worktree-lifecycle",
          context: { worktreeId: event.worktreeId },
          retryability: "user-gated",
        });
        break;
      }

      case "emfile-limit-reached": {
        if (this.emfileLimitToastSent) break;
        this.emfileLimitToastSent = true;
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

      case "watcher-recovered": {
        // Recursive coverage restored. Reset the one-shot toast guards so a
        // subsequent relapse re-notifies. No toast — recovery is conveyed by
        // the persistent indicator disappearing (Tier-1 ambient signal).
        this.inotifyLimitToastSent = false;
        this.emfileLimitToastSent = false;
        break;
      }
    }
  }
}
