import { z } from "zod";
import { TerminalSpawnSourceSchema, AddPanelFocusPolicySchema } from "./schemas";

// The workflow-creation actions' input schemas, registered by
// workflowCreationActions.ts. Their runs in workflowCreationActions.impl.ts
// import them as types only, so this module stays out of the run bodies' chunk.

/**
 * Where the managed creator's branch comes from, as a discriminated union.
 *
 * The flat predecessor took `branchName`, `baseBranch`, `useExistingBranch`,
 * `fromRemote` and `pullRequestNumber` as five independently optional
 * top-level fields whose legal combinations lived only in `run()`. Two things
 * went wrong with that. The advertised JSON Schema accepted `{}` — Zod
 * refinements do not survive `z.toJSONSchema`, so the manifest told every
 * model an empty call was valid and only a dispatch could teach otherwise. And
 * the modes were not actually separable: `baseBranch` and `fromRemote` mean
 * nothing when an existing branch is being reused, but nothing said so.
 *
 * Each arm is `.strict()`, so a field borrowed from another mode — `baseBranch`
 * on an existing-branch reuse, a `branchName` beside a pull request — is a
 * validation error rather than a silently stripped key. Without it the
 * generated JSON Schema emits no `additionalProperties: false` on the arms
 * (production only closes the ROOT object), so the advertised contract was
 * looser than the real one and told callers those combinations were fine.
 *
 * The union is NESTED under a `source` key rather than being the root schema
 * deliberately: `buildToolInputSchema` forwards a generated schema only when
 * its root is `type: "object"`, and a root union emits `anyOf` — which would
 * advertise an empty schema and lose every field. Nested, the root stays an
 * object and `toWireSchema` preserves the combinator.
 */
const WorktreeCreationSourceSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z
          .literal("newBranch")
          .describe("Branch off a base; a taken name follows collisionPolicy."),
        branchName: z
          .string()
          .trim()
          .min(1)
          .describe("New branch name; an invalid git ref is rejected, not rewritten."),
        baseBranch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Base branch (default: the main worktree's branch)."),
        fromRemote: z
          .boolean()
          .optional()
          .describe("True if baseBranch is a remote branch, e.g. origin/develop."),
        fetchBase: z
          .boolean()
          .optional()
          .describe(
            "Fetch the base (a local one via its upstream) and branch from that commit, returned as startCommit. A failed fetch fails; a taken name is never reused."
          ),
        collisionPolicy: z
          .enum(["suffix", "error"])
          .optional()
          .describe(
            "If the name is taken: 'suffix' (default) reuses the branch when nothing has it checked out, else creates name-2, and reports which; 'error' fails."
          ),
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Issue this worktree is for, passed to the recipe and assignToSelf; not attached."
          ),
        assignToSelf: z
          .boolean()
          .optional()
          .describe(
            "Assign the issue to the current user. Omit for the saved 'Assign issue to me' preference."
          ),
      })
      .strict(),
    z
      .object({
        kind: z
          .literal("existingBranch")
          .describe("Check out an existing local branch exactly as named."),
        branchName: z
          .string()
          .trim()
          .min(1)
          .describe("Existing local branch, used verbatim: never suffixed or created."),
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Issue this worktree is for, passed to the recipe and assignToSelf; not attached."
          ),
        assignToSelf: z
          .boolean()
          .optional()
          .describe(
            "Assign the issue to the current user. Omit for the saved 'Assign issue to me' preference."
          ),
      })
      .strict(),
    z
      .object({
        kind: z
          .literal("pullRequest")
          .describe(
            "Check out a pull request's head branch; a closed or merged PR works while its head ref exists."
          ),
        pullRequestNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request to check out; its head branch is fetched for you."),
      })
      .strict(),
  ])
  .describe("Where the branch comes from; exactly one mode.");

export const CreateWithRecipeArgsSchema = z.object({
  source: WorktreeCreationSourceSchema,
  recipeId: z
    .string()
    .optional()
    .describe(
      "Recipe to launch in the new worktree. Omit for no terminals; setup starts either way and terminals do not wait for it."
    ),
  spawnedBy: TerminalSpawnSourceSchema.optional(),
  focusPolicy: AddPanelFocusPolicySchema.optional(),
});

export const StartWorkOnIssueArgsSchema = z.object({
  issueNumber: z.number().int().positive().describe("Issue number to start work on"),
  agentId: z
    .string()
    .min(1)
    .describe(
      "Agent CLI to launch, e.g. 'claude' or 'codex'; 'terminal' for a plain shell. Ids from the agent listing; an unknown one is rejected before anything is created."
    ),
  branchName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Defaults to 'feature/issue-<number>-<slug>' from the issue title."),
  baseBranch: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Base branch (default: the main worktree's branch)"),
  recipeId: z.string().optional().describe("Recipe ID to run after creation"),
  assignToSelf: z
    .boolean()
    .optional()
    .describe(
      "Assign the issue to the current user. Omit for the saved 'Assign issue to me' preference."
    ),
  injectContext: z
    .boolean()
    .optional()
    .describe("Inject worktree context into the terminal (default true)"),
  spawnedBy: TerminalSpawnSourceSchema.optional(),
  focusPolicy: AddPanelFocusPolicySchema.optional(),
});
