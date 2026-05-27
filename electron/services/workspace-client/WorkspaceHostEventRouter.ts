import path from "path";
import { events } from "../events.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { notifyError } from "../../ipc/errorHandlers.js";
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

  private forgeCredentialChangeAt = new Map<string, number>();
  private inotifyLimitToastSent = false;
  private emfileLimitToastSent = false;
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
        // Fallback signal for external removals (CLI `git worktree remove`,
        // IDE-driven cleanup). The UI-initiated delete path stops the dev
        // preview BEFORE removal via `window.electron.devPreview.stopByWorktree`
        // (#9084); this emit lets subscribers reconcile in the external case.
        events.emit("sys:worktree:remove", {
          worktreeId: event.worktreeId,
          timestamp: Date.now(),
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
        // Renderer payload MUST carry `linked` + `branchName` + `providerId`
        // (#8870 regression from #8452). After #8452 the renderer's pr-detected
        // handler reads `event.linked ?? existing.linked` and `branchesMatch`
        // uses `event.branchName`. Dropping these fields here meant the
        // renderer's `event.linked` was always undefined, so `linked.pr` never
        // landed in the store and the PR sub-row never rendered.
        const prPayload = {
          worktreeId: event.worktreeId,
          prNumber: event.prNumber,
          prUrl: event.prUrl,
          prState: event.prState,
          prCiStatus: event.prCiStatus,
          prTitle: event.prTitle,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          prLastUpdatedAt: event.prLastUpdatedAt,
          issueLastUpdatedAt: event.issueLastUpdatedAt,
          branchName: event.branchName,
          providerId: event.providerId,
          linked: event.linked,
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
        // Renderer payload MUST carry `linked` + `branchName` + `providerId`
        // (#8870 regression — see pr-detected case above for the full rationale).
        const issuePayload = {
          worktreeId: event.worktreeId,
          issueNumber: event.issueNumber,
          issueTitle: event.issueTitle,
          issueLastUpdatedAt: event.issueLastUpdatedAt,
          branchName: event.branchName,
          providerId: event.providerId,
          linked: event.linked,
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
        // Provider-agnostic routing: every forge provider (GitHub included)
        // flows through the same `forge:rate-limit-changed` broadcast keyed by
        // its canonical providerId. The renderer keys state per provider so
        // GitHub and any additional provider never cross-contaminate. There is
        // no GitHub fast-path and no per-provider dead-end cache anymore.
        const changeAt = this.forgeCredentialChangeAt.get(event.providerId) ?? 0;
        if (
          event.state.remaining === 0 &&
          changeAt > 0 &&
          Date.now() - changeAt < WorkspaceHostEventRouter.RATE_LIMIT_TOKEN_CHANGE_GUARD_MS
        ) {
          // Suppress a stale exhausted-quota response surfacing immediately
          // after a credential rotation — the old token's 403 is not the new
          // token's state. Applies to any provider, not just GitHub.
          break;
        }
        broadcastToRenderer(CHANNELS.FORGE_RATE_LIMIT_CHANGED, {
          providerId: event.providerId,
          state: event.state,
        });
        break;
      }

      case "forge-token-health-changed": {
        broadcastToRenderer(CHANNELS.FORGE_TOKEN_HEALTH_CHANGED, {
          providerId: event.providerId,
          isUnhealthy: event.isUnhealthy,
        });
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
