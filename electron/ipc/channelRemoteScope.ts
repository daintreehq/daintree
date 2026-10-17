import type { ClientEndpoint } from "./endpoint.js";
import type { LeaseArgPath, LeaseTarget } from "./channelLeasePolicy.js";
import {
  resolveLeaseTarget,
  type LeaseTargetResolution,
  type LeaseTargetResolvers,
} from "../services/driveLeaseTargets.js";
import { AppError } from "../utils/errorTypes.js";

/**
 * Host-side reads that name a project's terminal, worktree or repository by
 * an argument, and a few writes outside the lease (`git:mark-safe-directory`
 * edits global git config). A remote view is bound to one project, so on
 * these it may name only that project's: another project's scrollback,
 * transcripts, images or history is not its to read, whoever drives it. The
 * target is traced through this host's own records, as for the lease
 * (`CHANNEL_LEASE_TARGETS`), never from what the view says it shows; a path
 * two projects own (a worktree of one kept in the other's folder) is either's.
 *
 * This keeps a view to its project; it is not a wall between Shells, each of
 * which holds the host user's token. Inventories (terminal lists and info,
 * project lists and stats, run history) stay host-wide for the switcher, the
 * processes list and the overview.
 *
 * Terminals are named by `{ terminals: at }`, one id or (`list`) many: each
 * must be this project's. An id with no record passes, as the handler
 * answers null for a terminal that has gone and a restore names those; a
 * terminal that exists with no project is no view's.
 */
export type RemoteScopeTarget = LeaseTarget | { terminals: LeaseArgPath; list?: true };

const CWD_ARG: LeaseTarget = [{ from: "path", at: [0] }];
const CWD_FIELD: LeaseTarget = [{ from: "path", at: [0, "cwd"] }];
const TERMINAL_ARG: RemoteScopeTarget = { terminals: [0] };
const TERMINAL_FIELD: RemoteScopeTarget = { terminals: [0, "terminalId"] };
const ROOT_FIELD: LeaseTarget = [{ from: "path", at: [0, "rootPath"] }];
const PROJECT_FIELD: LeaseTarget = [{ from: "project", at: [0, "projectId"] }];

export const CHANNEL_REMOTE_SCOPE: Readonly<Record<string, RemoteScopeTarget>> = {
  "terminal:get-serialized-state": TERMINAL_ARG,
  "terminal:get-serialized-states": { terminals: [0], list: true },
  "terminal:replay-history": TERMINAL_FIELD,
  "claude:list-subagents": TERMINAL_FIELD,
  "claude:read-subagent-transcript": TERMINAL_FIELD,
  "codex:list-subagents": TERMINAL_FIELD,
  "codex:read-subagent-transcript": TERMINAL_FIELD,
  // A folder in no project is anyone's to ask about; another project's is not.
  "codex:find-sessions": [{ from: "path", at: [0, "cwd"], unowned: "allow" }],
  "codex:resolve-resume-latest-session": [{ from: "path", at: [0, "cwd"], unowned: "allow" }],
  "diff-media:read-file-versions": CWD_FIELD,
  // Its own roots also hold the host's clipboard inbox, which is in no project.
  "clipboard:thumbnail-from-path": [{ from: "path", at: [0], unowned: "allow" }],
  // Its recovery runs before the repository is a project (adding it is what
  // failed), as `project:init-git` does: a folder in no project is allowed,
  // another project's is not.
  "git:mark-safe-directory": [{ from: "path", at: [0], unowned: "allow" }],
  "git:get-file-diff": CWD_FIELD,
  "git:get-working-diff": CWD_FIELD,
  "git:get-staging-status": CWD_ARG,
  "git:get-username": CWD_ARG,
  "git:list-commits": CWD_FIELD,
  "git:list-push-commits": CWD_FIELD,
  "git:list-rebase-commits": CWD_FIELD,
  "git:list-remote-commits": CWD_FIELD,
  "git:list-base-integration-commits": CWD_FIELD,
  "git:compare-worktrees": CWD_FIELD,
  "git:scan-conflict-markers": CWD_FIELD,
  "git:get-project-pulse": [{ from: "worktree", at: [0, "worktreeId"] }],
  "worktree:list-branches": ROOT_FIELD,
  "worktree:get-recent-branches": ROOT_FIELD,
  "worktree:get-available-branch": ROOT_FIELD,
  "worktree:get-default-path": ROOT_FIELD,
  "project:list-remotes": CWD_ARG,
  "dev-preview:get-state": PROJECT_FIELD,
  "dev-preview:get-diagnostics": PROJECT_FIELD,
  "dev-preview:get-destructive-preview-meta": PROJECT_FIELD,
  "dev-preview:get-destructive-preview-sizes": PROJECT_FIELD,
  "dev-preview:get-by-worktree": [{ from: "worktree", at: [0, "worktreeId"] }],
};

/** Refuses a remote view's call whose target is outside its project; null lets it through. */
export type RemoteScopeGate = (
  channel: string,
  endpoint: ClientEndpoint,
  args: readonly unknown[]
) => AppError | null | Promise<AppError | null>;

function readArg(args: readonly unknown[], at: LeaseArgPath): unknown {
  const [index, ...keys] = at;
  let value: unknown = args[index];
  for (const key of keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}

function outOfScope(channel: string): AppError {
  return new AppError({
    code: "PERMISSION",
    message: `${channel} names something outside this window's project`,
    userMessage: "That belongs to another project on this host. Open that project to see it.",
    context: { channel },
  });
}

function judge(
  channel: string,
  resolution: LeaseTargetResolution,
  projectId: string | null
): AppError | null {
  if (resolution.kind !== "projects") return outOfScope(channel);
  // Nothing owns it (a source that allows that): nobody's to keep from this view.
  if (resolution.projectIds.length === 0) return null;
  return projectId !== null && resolution.projectIds.includes(projectId)
    ? null
    : outOfScope(channel);
}

/** What the host knows of a terminal: gone, or its project (null for none). */
export type TerminalRecord = "missing" | { projectId: string | null };

export function createRemoteScopeGate(
  resolvers: LeaseTargetResolvers,
  describeTerminal: (id: string) => TerminalRecord | Promise<TerminalRecord> = (id) => {
    const owner = resolvers.projectForTerminal(id);
    const toRecord = (projectId: string | null): TerminalRecord =>
      projectId === null ? "missing" : { projectId };
    return owner instanceof Promise ? owner.then(toRecord) : toRecord(owner);
  }
): RemoteScopeGate {
  return (channel, endpoint, args) => {
    if (endpoint.kind !== "remote-view" || !Object.hasOwn(CHANNEL_REMOTE_SCOPE, channel)) {
      return null;
    }
    const target = CHANNEL_REMOTE_SCOPE[channel]!;
    const projectId = endpoint.projectId;
    if ("terminals" in target) {
      const named = readArg(args, target.terminals);
      const ids = target.list ? named : [named];
      // An id a handler would trim into another is checked as itself only when it is itself.
      if (
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== "string" || id.length === 0 || id !== id.trim())
      ) {
        return outOfScope(channel);
      }
      const records = (ids as string[]).map((id) => describeTerminal(id));
      const verdict = (resolved: TerminalRecord[]) =>
        resolved.every(
          (record) => record === "missing" || (projectId !== null && record.projectId === projectId)
        )
          ? null
          : outOfScope(channel);
      return records.some((record) => record instanceof Promise)
        ? Promise.all(records).then(verdict, () => outOfScope(channel))
        : verdict(records as TerminalRecord[]);
    }
    const resolution = resolveLeaseTarget(target, args, projectId, resolvers);
    return resolution instanceof Promise
      ? resolution.then(
          (resolved) => judge(channel, resolved, projectId),
          () => outOfScope(channel)
        )
      : judge(channel, resolution, projectId);
  };
}
