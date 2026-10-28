// The forge actions' run bodies, loaded on first dispatch by `runForgeAction` in
// forgeActions.ts, which keeps the metadata every view registers at boot (#14270).
// Nothing here may import forgeActions.ts at runtime.
import type { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { ForgeUser } from "@shared/types/forge";
import { forgeClient } from "@/clients";
import {
  requireWorktreePath,
  resolveProjectLocation,
  type WorktreeLocationArgs,
} from "./locationArgs";
import { useProjectStore } from "@/store/projectStore";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";
import { ForgePRResultSchema } from "@shared/types/forgeActionResults";
import {
  projectForgePage,
  projectIssueSummary,
  projectPRSummary,
} from "@shared/utils/forgeListProjection";
import {
  ForgeAssigneesResultSchema,
  ForgeCommentResultSchema,
  ForgeDisableAutoMergeResultSchema,
  ForgeEnableAutoMergeResultSchema,
  ForgeMergePRResultSchema,
  ForgePRDraftStateResultSchema,
  ForgeRequestedReviewersResultSchema,
  ForgeReviewResultSchema,
} from "./forgeActionResultSchemas";
import type {
  ForgeListOptionsSchema,
  ForgePRListOptionsSchema,
  addIssueCommentArgsSchema,
  addIssueLabelArgsSchema,
  approvePRArgsSchema,
  assignIssueArgsSchema,
  closeIssueArgsSchema,
  closePRArgsSchema,
  commentOnPRArgsSchema,
  convertPRToDraftArgsSchema,
  createIssueArgsSchema,
  createPRArgsSchema,
  disableAutoMergeArgsSchema,
  dismissReviewArgsSchema,
  editIssueArgsSchema,
  editPRArgsSchema,
  enableAutoMergeArgsSchema,
  getCIStatusArgsSchema,
  getChecksArgsSchema,
  getIssueArgsSchema,
  getPRArgsSchema,
  getPRsArgsSchema,
  getRepoStatsArgsSchema,
  listIssueCommentsArgsSchema,
  markPRReadyForReviewArgsSchema,
  mergePRArgsSchema,
  openCommitsArgsSchema,
  openIssueArgsSchema,
  openIssuesArgsSchema,
  openPRArgsSchema,
  openPRsArgsSchema,
  openRepoArgsSchema,
  removeIssueLabelArgsSchema,
  reopenIssueArgsSchema,
  reopenPRArgsSchema,
  requestChangesArgsSchema,
  requestReviewersArgsSchema,
  unassignIssueArgsSchema,
  validateTokenArgsSchema,
} from "./forgeActionArgs";

/**
 * Read an action's validated args as its schema's output type.
 *
 * `run` receives `unknown`, but ActionService has already parsed `argsSchema`
 * and hands over the parsed value, so the schema named here — the same one
 * forgeActions.ts registers — is the type the args actually have. The cast is
 * written once here rather than at each body, and takes the schema as a type so
 * this chunk never imports the args schemas at runtime.
 */
function argsOf<S extends z.ZodType>(args: unknown): z.output<S> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionService validated `argsSchema` before run()
  return args as z.output<S>;
}

/**
 * The cache keys on the PROJECT ROOT, but these actions resolve their forge
 * target from the caller's location argument — and a linked worktree path
 * matches no cache slot.
 *
 * So only an explicit PATH is honored as given, because only a path can name a
 * repo outside this project. Everything else — no location at all, or a
 * `worktreeId`, which necessarily resolves inside the current project and yields
 * a linked-worktree path — patches the current project root instead; otherwise
 * the optimistic assign/unassign update is silently dropped. If an explicit path
 * isn't a project root the patch simply finds nothing.
 */
function assigneeCachePath(location: WorktreeLocationArgs, resolvedCwd: string): string | null {
  if (location.worktreePath || location.cwd) return resolvedCwd;
  return useProjectStore.getState().currentProject?.path ?? null;
}

/**
 * Reflect an assign/unassign in the cached issue lists so the toolbar dropdown
 * updates immediately (#11087). Driven by the forge's own resulting assignee
 * list rather than the requested username: a forge silently drops an assignee
 * the account can't take, so trusting the request would show a membership that
 * never landed. The list also carries the account's avatar, which the request
 * alone never had.
 *
 * Best-effort by design: the forge mutation has already succeeded by the time
 * this runs, so a cache-layer throw must never surface as a failed action.
 */
function syncAssigneeCache(
  projectPath: string | null,
  issueNumber: number,
  username: string,
  assignees: readonly Pick<ForgeUser, "login" | "avatarUrl">[]
): void {
  if (!projectPath) return;
  const match = username.trim().toLowerCase();
  const landed = assignees.find((a) => a.login.trim().toLowerCase() === match);
  try {
    patchIssueAssigneeCache(
      projectPath,
      issueNumber,
      { login: landed?.login ?? username, avatarUrl: landed?.avatarUrl },
      landed !== undefined
    );
  } catch (err) {
    logError("Failed to patch issue cache after assignment change", err);
  }
}

// Provider-agnostic: each body calls forgeClient (the provider-agnostic IPC
// wrapper), and provider routing is resolved at the IPC layer in
// electron/ipc/handlers/forge.ts.
export const forgeActionRuns = {
  "forge.openIssues": async (rawArgs: unknown, ctx: ActionContext) => {
    const args = argsOf<typeof openIssuesArgsSchema>(rawArgs);
    // An explicit selector is resolved (or rejected) by the resolver, so this
    // fallback only applies when the caller named no project at all.
    const path =
      resolveProjectLocation(args, ctx).projectPath ??
      useProjectStore.getState().currentProject?.path;
    if (!path) {
      throw new Error("No project path available to open issues");
    }
    await forgeClient.openIssues(path, args?.query, args?.state);
  },

  "forge.openPRs": async (rawArgs: unknown, ctx: ActionContext) => {
    const args = argsOf<typeof openPRsArgsSchema>(rawArgs);
    // An explicit selector is resolved (or rejected) by the resolver, so this
    // fallback only applies when the caller named no project at all.
    const path =
      resolveProjectLocation(args, ctx).projectPath ??
      useProjectStore.getState().currentProject?.path;
    if (!path) {
      throw new Error("No project path available to open pull requests");
    }
    await forgeClient.openPRs(path, args?.query, args?.state);
  },

  "forge.openCommits": async (rawArgs: unknown, ctx: ActionContext) => {
    const args = argsOf<typeof openCommitsArgsSchema>(rawArgs);
    // An explicit selector is resolved (or rejected) by the resolver, so this
    // fallback only applies when the caller named no project at all.
    const path =
      resolveProjectLocation(args, ctx).projectPath ??
      useProjectStore.getState().currentProject?.path;
    if (!path) {
      throw new Error("No project path available to open commits");
    }
    await forgeClient.openCommits(path, args?.branch);
  },

  "forge.openRepo": async (rawArgs: unknown, ctx: ActionContext) => {
    const args = argsOf<typeof openRepoArgsSchema>(rawArgs);
    // An explicit selector is resolved (or rejected) by the resolver, so this
    // fallback only applies when the caller named no project at all.
    const path =
      resolveProjectLocation(args, ctx).projectPath ??
      useProjectStore.getState().currentProject?.path;
    if (!path) {
      throw new Error("No project path available to open the repository");
    }
    await forgeClient.openRepo(path);
  },

  "forge.openIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, ...location } = argsOf<typeof openIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    await forgeClient.openIssue(resolvedCwd, issueNumber);
  },

  "forge.openPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof openPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    await forgeClient.openPR(resolvedCwd, prNumber);
  },

  "forge.assignIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, username, ...location } = argsOf<typeof assignIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    const assignees = await forgeClient.assignIssue(resolvedCwd, issueNumber, username);
    const result = ForgeAssigneesResultSchema.parse({ issueNumber, assignees });
    syncAssigneeCache(
      assigneeCachePath(location, resolvedCwd),
      issueNumber,
      username,
      result.assignees
    );
    return result;
  },

  "forge.unassignIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, username, ...location } = argsOf<typeof unassignIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    const assignees = await forgeClient.unassignIssue(resolvedCwd, issueNumber, username);
    const result = ForgeAssigneesResultSchema.parse({ issueNumber, assignees });
    syncAssigneeCache(
      assigneeCachePath(location, resolvedCwd),
      issueNumber,
      username,
      result.assignees
    );
    return result;
  },

  "forge.approvePR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, body, ...location } = argsOf<typeof approvePRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeReviewResultSchema.parse(await forgeClient.approvePR(resolvedCwd, prNumber, body));
  },

  "forge.requestChanges": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, body, ...location } = argsOf<typeof requestChangesArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeReviewResultSchema.parse(
      await forgeClient.requestChanges(resolvedCwd, prNumber, body)
    );
  },

  "forge.dismissReview": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, reviewId, message, ...location } =
      argsOf<typeof dismissReviewArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeReviewResultSchema.parse(
      await forgeClient.dismissReview(resolvedCwd, prNumber, reviewId, message)
    );
  },

  "forge.requestReviewers": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, users, teams, ...location } =
      argsOf<typeof requestReviewersArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeRequestedReviewersResultSchema.parse(
      await forgeClient.requestReviewers(resolvedCwd, prNumber, { users, teams })
    );
  },

  "forge.validateToken": async (rawArgs: unknown) => {
    const { providerId, token } = argsOf<typeof validateTokenArgsSchema>(rawArgs);
    return await forgeClient.validateToken(providerId, token);
  },

  "forge.getRepoStats": async (rawArgs: unknown, ctx: ActionContext) => {
    const { bypassCache, ...location } = argsOf<typeof getRepoStatsArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.getRepoStats(resolvedCwd, bypassCache);
  },

  "forge.listIssues": async (rawArgs: unknown, ctx: ActionContext) => {
    const { search, state, cursor, perPage, sort, direction, bypassCache, view, ...location } =
      argsOf<typeof ForgeListOptionsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    const page = await forgeClient.listIssues(resolvedCwd, {
      search,
      state,
      cursor,
      perPage,
      sort,
      direction,
      bypassCache,
    });
    // `view` is action-local presentation: it never reaches the provider,
    // so it must not participate in provider cache identity either.
    return projectForgePage(page, view ?? "summary", projectIssueSummary);
  },

  "forge.listPRs": async (rawArgs: unknown, ctx: ActionContext) => {
    const { search, state, cursor, perPage, sort, direction, bypassCache, view, ...location } =
      argsOf<typeof ForgePRListOptionsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    const page = await forgeClient.listPRs(resolvedCwd, {
      search,
      state,
      cursor,
      perPage,
      sort,
      direction,
      bypassCache,
    });
    return projectForgePage(page, view ?? "summary", projectPRSummary);
  },

  "forge.getIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, ...location } = argsOf<typeof getIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.getIssue(resolvedCwd, issueNumber);
  },

  "forge.listIssueComments": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, cursor, perPage, ...location } =
      argsOf<typeof listIssueCommentsArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.listIssueComments(resolvedCwd, issueNumber, { cursor, perPage });
  },

  "forge.getPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof getPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return { pr: await forgeClient.getPR(resolvedCwd, prNumber) };
  },

  "forge.getPRs": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumbers, ...location } = argsOf<typeof getPRsArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return { results: await forgeClient.getPRsByNumbersDetailed(resolvedCwd, prNumbers) };
  },

  "forge.getCIStatus": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof getCIStatusArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return { ciStatus: await forgeClient.getCIStatus(resolvedCwd, prNumber) };
  },

  "forge.getChecks": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof getChecksArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    const result = await forgeClient.getChecks(resolvedCwd, prNumber);
    return { checks: result === null ? null : result.checks };
  },

  "forge.createPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { head, base, title, body, draft, ...location } =
      argsOf<typeof createPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.createPR(resolvedCwd, { head, base, title, body, draft });
  },

  "forge.closePR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof closePRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgePRResultSchema.parse(await forgeClient.closePR(resolvedCwd, prNumber));
  },

  "forge.reopenPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof reopenPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgePRResultSchema.parse(await forgeClient.reopenPR(resolvedCwd, prNumber));
  },

  "forge.mergePR": async (rawArgs: unknown, ctx: ActionContext) => {
    const {
      prNumber,
      mergeMethod,
      commitTitle,
      commitMessage,
      expectedHeadSha,
      expectedBaseRef,
      ...location
    } = argsOf<typeof mergePRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeMergePRResultSchema.parse(
      await forgeClient.mergePR(resolvedCwd, prNumber, {
        mergeMethod,
        commitTitle,
        commitMessage,
        ...(expectedHeadSha ? { expectedHeadSha } : {}),
        ...(expectedBaseRef ? { expectedBaseRef } : {}),
      })
    );
  },

  "forge.enableAutoMerge": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, mergeMethod, expectedHeadSha, expectedBaseRef, ...location } =
      argsOf<typeof enableAutoMergeArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeEnableAutoMergeResultSchema.parse(
      await forgeClient.enableAutoMerge(resolvedCwd, prNumber, {
        ...(mergeMethod ? { mergeMethod } : {}),
        expectedHeadSha,
        ...(expectedBaseRef ? { expectedBaseRef } : {}),
      })
    );
  },

  "forge.disableAutoMerge": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof disableAutoMergeArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeDisableAutoMergeResultSchema.parse(
      await forgeClient.disableAutoMerge(resolvedCwd, prNumber)
    );
  },

  "forge.createIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { title, body, labels, ...location } = argsOf<typeof createIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.createIssue(resolvedCwd, { title, body, labels });
  },

  "forge.convertPRToDraft": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof convertPRToDraftArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgePRDraftStateResultSchema.parse(
      await forgeClient.convertPRToDraft(resolvedCwd, prNumber)
    );
  },

  "forge.closeIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, stateReason, ...location } = argsOf<typeof closeIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.closeIssue(resolvedCwd, issueNumber, stateReason);
  },

  "forge.markPRReadyForReview": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, ...location } = argsOf<typeof markPRReadyForReviewArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgePRDraftStateResultSchema.parse(
      await forgeClient.markPRReadyForReview(resolvedCwd, prNumber)
    );
  },

  "forge.reopenIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, ...location } = argsOf<typeof reopenIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.reopenIssue(resolvedCwd, issueNumber);
  },

  "forge.commentOnPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, body, ...location } = argsOf<typeof commentOnPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return ForgeCommentResultSchema.parse(
      await forgeClient.commentOnPR(resolvedCwd, prNumber, body)
    );
  },

  "forge.editPR": async (rawArgs: unknown, ctx: ActionContext) => {
    const { prNumber, title, body, ...location } = argsOf<typeof editPRArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.editPR(resolvedCwd, prNumber, { title, body });
  },

  "forge.editIssue": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, title, body, ...location } = argsOf<typeof editIssueArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.editIssue(resolvedCwd, issueNumber, { title, body });
  },

  "forge.addIssueComment": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, body, ...location } = argsOf<typeof addIssueCommentArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.addIssueComment(resolvedCwd, issueNumber, body);
  },

  "forge.addIssueLabel": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, label, ...location } = argsOf<typeof addIssueLabelArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.addIssueLabel(resolvedCwd, issueNumber, label);
  },

  "forge.removeIssueLabel": async (rawArgs: unknown, ctx: ActionContext) => {
    const { issueNumber, label, ...location } = argsOf<typeof removeIssueLabelArgsSchema>(rawArgs);
    const resolvedCwd = requireWorktreePath(location, ctx);
    return await forgeClient.removeIssueLabel(resolvedCwd, issueNumber, label);
  },
} satisfies Record<string, (args: unknown, ctx: ActionContext) => Promise<unknown>>;

export type ForgeActionRunId = keyof typeof forgeActionRuns;
