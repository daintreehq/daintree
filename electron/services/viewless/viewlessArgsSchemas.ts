import { z } from "zod";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds.js";
import { NotifyReplyLinesSchema } from "../../../shared/types/terminalNotify.js";
import {
  REPLY_WAIT_MAX_SECONDS,
  WaitForReplySchema,
  WaitSecondsSchema,
} from "../../../shared/types/replyWait.js";
import { SYSTEM_PROMPT_MAX_LENGTH } from "../../../shared/utils/agentSystemPrompt.js";
import { ForgeListViewSchema } from "../../../shared/utils/forgeListProjection.js";
import {
  LAUNCH_SETUP_WAIT_MAX_MS,
  launchWaitsExceedHold,
} from "../../../shared/utils/launchInNewWorktree.js";
import {
  MAX_WAIT_FOR_PR_TARGETS,
  MAX_WAIT_FOR_PR_TIMEOUT_MS,
} from "../../../shared/utils/worktreeSummary.js";

/**
 * The arguments of the actions the host parses itself rather than handing to
 * a handler that validates them (#13501), as their renderer actions take
 * them. Kept apart from the actions so `viewlessActionParity.test.ts` can hold
 * each to its renderer action's keys without pulling the host's services in.
 */

const selector = z.string().min(1).optional();

/** The worktree a read targets, with `cwd` kept as the legacy spelling these tools accept. */
const location = { worktreeId: selector, worktreePath: selector, cwd: selector };

const listPaging = {
  ...location,
  cursor: z.string().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  sort: z.enum(["created", "updated"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  bypassCache: z.boolean().optional(),
  view: ForgeListViewSchema,
};

export const VIEWLESS_FORGE_ARGS_SCHEMAS = {
  "forge.listIssues": z
    .object({
      ...listPaging,
      state: z.enum(["open", "closed", "all"]).optional(),
      search: z.string().optional(),
    })
    .strict(),
  "forge.listPRs": z
    .object({
      ...listPaging,
      state: z.enum(["open", "closed", "merged", "all"]).optional(),
      search: z.string().optional(),
    })
    .strict(),
  "forge.getIssue": z.object({ ...location, issueNumber: z.number().int().positive() }),
  "forge.listIssueComments": z.object({
    ...location,
    issueNumber: z.number().int().positive(),
    cursor: z.string().optional(),
    perPage: z.number().int().min(1).max(100).optional(),
  }),
  "forge.getPR": z.object({ ...location, prNumber: z.number().int().positive() }),
  // The renderer action's bounds and its refusal of repeats, which keep the
  // batch from answering what the singular lookup should.
  "forge.getPRs": z.object({
    ...location,
    prNumbers: z
      .array(z.number().int().positive())
      .min(2)
      .max(20)
      .refine((numbers) => new Set(numbers).size === numbers.length, {
        message: "prNumbers must not contain duplicates",
      }),
  }),
  "forge.getCIStatus": z.object({ ...location, prNumber: z.number().int().positive() }),
  "forge.getChecks": z.object({ ...location, prNumber: z.number().int().positive() }),
} as const;

const branchName = z.string().trim().min(1);
const issueNumber = z.number().int().positive().optional();

/** `worktree.createWithRecipe`'s arguments, arm for arm as its renderer action takes them. */
export const WorktreeCreateWithRecipeArgsSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("newBranch"),
        branchName,
        baseBranch: branchName.optional(),
        fromRemote: z.boolean().optional(),
        fetchBase: z.boolean().optional(),
        collisionPolicy: z.enum(["suffix", "error"]).optional(),
        issueNumber,
        assignToSelf: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("existingBranch"),
        branchName,
        issueNumber,
        assignToSelf: z.boolean().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("pullRequest"), pullRequestNumber: z.number().int().positive() })
      .strict(),
  ]),
  recipeId: z.string().optional(),
  spawnedBy: z.unknown().optional(),
  focusPolicy: z.unknown().optional(),
});

/** `agent.launch`'s arguments, as its renderer action takes them; the UI-only ones have no effect with no view. */
export const AgentLaunchArgsSchema = z.object({
  agentId: z.string().min(1),
  location: z.enum(["grid", "dock", "overlay", "background"]).optional(),
  cwd: z.string().optional(),
  worktreeId: z.string().optional(),
  prompt: z.string().optional(),
  handback: z.boolean().optional(),
  notify: z.boolean().optional(),
  replyLines: NotifyReplyLinesSchema,
  waitForReply: WaitForReplySchema,
  waitSeconds: WaitSecondsSchema,
  systemPrompt: z.string().max(SYSTEM_PROMPT_MAX_LENGTH).optional(),
  interactive: z.boolean().optional(),
  model: z.string().optional(),
  presetId: z.string().nullable().optional(),
  activateDockOnCreate: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  excludeFromPersistence: z.boolean().optional(),
  removeOnExit: z.boolean().optional(),
  agentLaunchFlags: z.array(z.string()).optional(),
  spawnedBy: z.unknown().optional(),
  focusPolicy: z.unknown().optional(),
  requestedId: z.string().optional(),
  force: z.boolean().optional(),
  name: z.string().max(200).optional(),
});

/**
 * `agent.launchInNewWorktree`'s arguments (#15738), which main parses before
 * anything is created: `createWithRecipe`'s source and every launch argument
 * but the worktree, which the call makes. Strict, so a `worktreeId` or a
 * `recipeId` is refused rather than dropped.
 */
export const AgentLaunchInNewWorktreeArgsSchema = AgentLaunchArgsSchema.omit({ worktreeId: true })
  .extend({
    source: WorktreeCreateWithRecipeArgsSchema.shape.source,
    setupTimeoutMs: z.number().int().min(0).max(LAUNCH_SETUP_WAIT_MAX_MS).optional(),
  })
  .strict()
  .refine((args) => !launchWaitsExceedHold(args), {
    message: `setupTimeoutMs and waitSeconds together can't exceed ${REPLY_WAIT_MAX_SECONDS} s, the longest a call is held`,
    path: ["setupTimeoutMs"],
  });

/** `slashCommands.list`'s arguments: a project selector, as a view takes it, and a built-in agent. */
export const SlashCommandsListArgsSchema = z
  .object({
    projectId: selector,
    projectPath: selector,
    agentId: z.enum(BUILT_IN_AGENT_IDS).optional(),
  })
  .optional();

/** `recipe.list`'s arguments. */
export const RecipeListArgsSchema = z.object({ worktreeId: z.string().optional() }).optional();

/**
 * `agent.listPresets`'s arguments. The id is any non-empty string, as the
 * renderer's is: a plugin agent's id is not known here.
 */
export const AgentListPresetsArgsSchema = z.object({
  agentId: z.string().min(1),
  projectId: z.string().min(1).optional(),
});

/** `agent.listModels`'s arguments. */
export const AgentListModelsArgsSchema = z
  .object({ agentId: z.string().min(1).optional() })
  .optional();

/** `worktree.waitForPullRequest`'s arguments, bounded as its renderer action bounds them. */
export const WorktreeWaitForPullRequestArgsSchema = z.object({
  worktreeIds: z.array(z.string().min(1)).min(1).max(MAX_WAIT_FOR_PR_TARGETS),
  timeoutMs: z.number().int().min(0).max(MAX_WAIT_FOR_PR_TIMEOUT_MS).optional(),
});

/** `agentSessionHistory.list`'s arguments, bounded as its renderer action bounds them. */
export const AgentSessionHistoryListArgsSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .optional();

/** `git.getProjectPulse`'s arguments, without the aliases its worktree location folds away. */
export const GitGetProjectPulseArgsSchema = z
  .object({
    worktreeId: selector,
    worktreePath: selector,
    rangeDays: z.union([z.literal(60), z.literal(120), z.literal(180)]).default(60),
    includeDelta: z.boolean().optional(),
    includeRecentCommits: z.boolean().optional(),
    forceRefresh: z.boolean().optional(),
  })
  .optional();
