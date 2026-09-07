import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { WorktreeBranchCollisionPolicy } from "@shared/types/git";

import { worktreeClient, copyTreeClient, forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { TerminalSpawnSourceSchema, AddPanelFocusPolicySchema } from "./schemas";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";
import { partialSuccessError, slugifyForBranch } from "./workflowHelpers";
import { resolveAgentLaunchKind } from "@/utils/agentLaunchValidation";
// The shared registry helper rather than `isRegisteredAgent` from
// `@/config/agents`: identical result (that one is a one-line delegation to
// this), but `@/config/agents` pulls the React icon map into the action module
// graph, which action registration has no business importing.
import { isEffectivelyRegisteredAgent } from "@shared/config/agentRegistry";
import { WorktreeSetupStateSchema } from "./schemas";

/**
 * Panel kinds `launchAgent` routes through its own non-PTY branches before it
 * ever classifies the id against the registry. A workflow that must inject
 * context into a running agent cannot use them, and the literal check has to be
 * explicit: a plugin may register an agent under one of these ids, which would
 * otherwise classify as a launchable agent and then still open a browser pane.
 */
const NON_TERMINAL_PANEL_IDS = new Set(["browser", "dev-preview"]);

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
          .describe(
            "Branch off a base branch. If the name is already taken, `collisionPolicy` decides what happens."
          ),
        branchName: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Name for the new branch. Rejected outright if it is not a valid git ref — nothing rewrites it for you."
          ),
        baseBranch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Branch to base the new branch on (defaults to the main worktree's branch)."),
        fromRemote: z
          .boolean()
          .optional()
          .describe("Set true if baseBranch names a remote branch, e.g. origin/develop."),
        collisionPolicy: z
          .enum(["suffix", "error"])
          .optional()
          .describe(
            "If the name is taken: 'suffix' (default) lets the host reuse that branch when nothing has it checked out, else create name-2, and reports which; 'error' fails instead."
          ),
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Issue this worktree is for. Given to the recipe and used by assignToSelf; it does not itself attach the issue."
          ),
        assignToSelf: z
          .boolean()
          .optional()
          .describe(
            "Assign the linked issue to the current user. Omit to use the persisted 'Assign issue to me' preference."
          ),
      })
      .strict(),
    z
      .object({
        kind: z
          .literal("existingBranch")
          .describe("Check out a local branch that already exists, exactly as named."),
        branchName: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The existing local branch to check out. Used verbatim — never suffixed, and never replaced by a new branch if it is missing."
          ),
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Issue this worktree is for. Given to the recipe and used by assignToSelf; it does not itself attach the issue."
          ),
        assignToSelf: z
          .boolean()
          .optional()
          .describe(
            "Assign the linked issue to the current user. Omit to use the persisted 'Assign issue to me' preference."
          ),
      })
      .strict(),
    z
      .object({
        kind: z
          .literal("pullRequest")
          .describe(
            "Check out a pull request's head branch. State is not checked, so a closed or merged PR is accepted as long as its head ref still exists."
          ),
        pullRequestNumber: z
          .number()
          .int()
          .positive()
          .describe(
            "Pull request to check out. Its head branch is fetched and resolved for you; do not also pass a branch name."
          ),
      })
      .strict(),
  ])
  .describe("Where the worktree's branch comes from. Required — pick exactly one mode.");

export function registerWorkflowCreationActions(
  actions: ActionRegistry,
  callbacks: Pick<ActionCallbacks, "onLaunchAgent">
): void {
  actions.set("worktree.createWithRecipe", () =>
    defineAction({
      id: "worktree.createWithRecipe",
      title: "Create Managed Worktree",
      description:
        "Create a managed git worktree — Daintree's own creator, which also copies project config, initializes submodules and runs setup. Name the creation mode: a new branch, an existing branch checked out exactly as asked, or a pull request. A recipe is OPTIONAL; pass one only to also launch terminals. Project setup runs in the background and can still fail after this returns.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      // Headless/MCP tool: `source` names the creation mode and carries the
      // fields that mode actually needs, so the manifest schema can no longer
      // advertise `{}` as a valid call. Palette picks still redirect to the New
      // Worktree dialog, which collects branch/recipe/PR interactively.
      palette: { mode: "redirect", to: "worktree.createDialog.open" },
      argsSchema: z.object({
        source: WorktreeCreationSourceSchema,
        recipeId: z
          .string()
          .optional()
          .describe(
            "Recipe to launch in the new worktree. Omit for a worktree with no terminals — project setup is started either way, and terminals do not wait for it."
          ),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      }),
      resultSchema: z.object({
        worktreeId: z.string(),
        worktreePath: z.string(),
        /**
         * Kept for compatibility with callers written against the original
         * result shape. Always equal to `effectiveBranch` — read that one.
         */
        branch: z.string(),
        requestedBranch: z
          .string()
          .describe("The branch name this call asked for, before collision handling."),
        effectiveBranch: z
          .string()
          .describe(
            "The branch the worktree is actually on. Differs from requestedBranch only when a newBranch source hit a collision under collisionPolicy 'suffix'."
          ),
        recipeLaunched: z.boolean(),
        spawnedTerminalCount: z.number().int().nonnegative(),
        // The composite's child panels, by id. Without these the terminals this
        // call created are indistinguishable from every other panel in the
        // view, so neither the caller nor the MCP ownership ledger can act on
        // them (#11909).
        spawnedTerminalIds: z
          .array(z.string())
          .describe(
            "The recipe panels this call actually started, in spawn order. Use these ids to read output from or close the terminals it created."
          ),
        failedTerminalCount: z.number().int().nonnegative(),
        setupState: WorktreeSetupStateSchema.describe(
          "Setup state as of the moment git creation finished, which is BEFORE any recipe terminals or issue assignment this call also did — so it is a snapshot, not the state on return, and setup may since have advanced or failed. Re-read it from the worktree listing, or wait on it where a readiness wait is available, before running work that needs a fully initialized tree."
        ),
        assignedToSelf: z.boolean(),
        assignedUsername: z.string().nullable(),
        assignmentError: z.string().nullable(),
      }),
      run: async ({ source, recipeId, spawnedBy, focusPolicy }, ctx: ActionContext) => {
        // Read off the arm rather than the top level. A `.refine()` cannot
        // express this on the wire — Zod does not emit refinements — so the old
        // top-level `issueNumber` advertised itself as valid beside a
        // pull-request source and only a dispatch could teach otherwise. On the
        // arms the JSON Schema enforces it: the pull-request arm is `.strict()`
        // and simply has no such property.
        const issueNumber = source.kind === "pullRequest" ? undefined : source.issueNumber;
        const assignToSelf = source.kind === "pullRequest" ? undefined : source.assignToSelf;
        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }

        const effectiveAssignToSelf =
          assignToSelf ?? usePreferencesStore.getState().assignWorktreeToSelf;

        const rootPath = currentProject.path;

        // Plugins have no confirm bypass at all, so this stays a hard rejection
        // rather than a confirmation: there is no surface on which a plugin
        // dispatch could be approved. Agent dispatch is NOT rejected here — it
        // is elevated to an effective confirm tier in ActionService before
        // `run()` is ever entered (`resolveEffectiveActionDanger`, #11860), so
        // by the time this line runs an agent caller has already been approved.
        // User dispatch is unaffected.
        if (recipeId && ctx.dispatchSource === "plugin") {
          throw new Error(
            "Plugins cannot spawn recipe terminals through worktree creation. Dispatch recipe.run instead."
          );
        }

        if (recipeId) {
          const recipe = useRecipeStore.getState().getRecipeById(recipeId);
          if (!recipe) {
            throw new Error(
              `Recipe ${recipeId} not found. Use recipe_list to see available recipes.`
            );
          }
        }

        const pullRequestNumber =
          source.kind === "pullRequest" ? source.pullRequestNumber : undefined;

        // What we ASK the host for. The host owns collision handling and may
        // land on a different branch than this one, so nothing downstream may
        // treat it as the answer — see `effectiveBranch` below.
        let requestedBranch: string;
        let candidateBranch: string;
        let effectiveBase: string;
        let effectiveUseExisting: boolean;
        let effectiveFromRemote: boolean;
        let collisionPolicy: WorktreeBranchCollisionPolicy | undefined;

        if (source.kind === "pullRequest") {
          const pr = await forgeClient.getPR(rootPath, source.pullRequestNumber);
          if (!pr) {
            throw new Error(`Pull request #${source.pullRequestNumber} not found in ${rootPath}`);
          }
          if (!pr.headRef?.trim()) {
            throw new Error(
              `Pull request #${source.pullRequestNumber} has no head branch — cannot create worktree`
            );
          }
          await worktreeClient.fetchPRBranch(rootPath, source.pullRequestNumber, pr.headRef);
          requestedBranch = pr.headRef;
          candidateBranch = pr.headRef;
          effectiveBase = pr.headRef;
          effectiveUseExisting = true;
          effectiveFromRemote = false;
        } else if (source.kind === "existingBranch") {
          // The exact branch, never an available-name lookup. Suffixing here is
          // what broke reuse outright: the old flat shape resolved
          // `getAvailableBranch` BEFORE reading `useExistingBranch`, so reusing
          // an existing `topic` asked the host to check out `topic-2` — a
          // branch that by construction does not exist, since the whole point
          // of the lookup was to find a free name.
          requestedBranch = source.branchName;
          candidateBranch = source.branchName;
          effectiveBase = source.branchName;
          effectiveUseExisting = true;
          effectiveFromRemote = false;
        } else {
          let baseRef: string | undefined = source.baseBranch;
          if (!baseRef) {
            const mainWorktree = Array.from(
              getCurrentViewStore().getState().worktrees.values()
            ).find((w) => w.isMainWorktree);
            if (!mainWorktree) {
              throw new Error(
                "No base branch specified and no main worktree found. Please specify source.baseBranch."
              );
            }
            baseRef = mainWorktree.branch;
          }
          if (!baseRef) {
            throw new Error("Base branch is required but was not determined");
          }
          requestedBranch = source.branchName;
          effectiveBase = baseRef;
          effectiveUseExisting = false;
          effectiveFromRemote = source.fromRemote ?? false;
          collisionPolicy = source.collisionPolicy ?? "suffix";
          // Under `suffix` the available-name lookup survives, but only as a
          // NAMING HINT: the worktree directory is derived from the branch, and
          // deriving it from a name we already know is taken produces a
          // directory whose name doesn't match the branch. It is not the
          // collision gate — it reserves nothing, and the host re-resolves the
          // collision atomically against the `git worktree add` failure. Under
          // `error` it is skipped entirely, so the host sees the exact
          // requested name and refuses it.
          candidateBranch =
            collisionPolicy === "suffix"
              ? await worktreeClient.getAvailableBranch(rootPath, requestedBranch)
              : requestedBranch;
        }

        const path = await worktreeClient.getDefaultPath(rootPath, candidateBranch);

        const created = await worktreeClient.create(
          {
            baseBranch: effectiveBase,
            newBranch: candidateBranch,
            path,
            fromRemote: effectiveFromRemote,
            useExistingBranch: effectiveUseExisting,
            ...(collisionPolicy ? { collisionPolicy } : {}),
          },
          rootPath
        );

        if (!created?.worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }

        // The branch the HOST landed on, carried back with the create result.
        // It is not necessarily `candidateBranch`: the host owns collision
        // handling and can suffix further under a lost race or reuse a stale
        // local branch. Reading it out of the worktree store instead would be a
        // race — store rows travel over a different port than this response,
        // with no ordering between them.
        const { worktreeId, branch: effectiveBranch, setupState } = created;

        let recipeLaunched = false;
        let spawnedTerminalCount = 0;
        let spawnedTerminalIds: string[] = [];
        let failedTerminalCount = 0;
        if (recipeId) {
          try {
            const recipeContext = {
              worktreePath: path,
              branchName: effectiveBranch,
              issueNumber,
              prNumber: pullRequestNumber,
            };
            // Forward dispatchSource so runRecipeWithResults applies the
            // agent-source terminal cap to MCP-driven worktree+recipe combos,
            // and hostApprovedRecipeRun so an approval covers every terminal
            // the dialog listed — both matching recipe.run. This composite's
            // confirm dialog previews the same recipe through the same
            // formatter, so omitting the second would preview terminals it then
            // refused to start (#12263).
            const results = await useRecipeStore
              .getState()
              .runRecipeWithResults(recipeId, path, worktreeId, recipeContext, {
                spawnedBy,
                focusPolicy,
                dispatchSource: ctx.dispatchSource,
                hostApprovedRecipeRun: ctx.hostApprovedRecipeRun,
              });
            // "Launched" means at least one terminal actually spawned — a run
            // where every terminal was dropped (e.g. panel limit) must not
            // report success to agent callers.
            recipeLaunched = results.spawned.length > 0;
            spawnedTerminalCount = results.spawned.length;
            spawnedTerminalIds = results.spawned.map((s) => s.terminalId);
            failedTerminalCount = results.failed.length;
            notifyRecipeSpawnFailures(results, {
              recipeName: useRecipeStore.getState().getRecipeById(recipeId)?.name,
              projectId: currentProject.id,
            });
          } catch (err) {
            throw partialSuccessError(
              `Recipe ${recipeId} failed to run: ${formatErrorMessage(err, "unknown error")}`,
              {
                worktreeId,
                worktreePath: path,
                branch: effectiveBranch,
                requestedBranch,
                effectiveBranch,
                recipeLaunched: false,
                spawnedTerminalCount: 0,
                spawnedTerminalIds: [],
                failedTerminalCount: 0,
                setupState,
                assignedToSelf: false,
                assignedUsername: null,
                assignmentError: null,
              }
            );
          }
        }

        let assignedToSelf = false;
        let assignedUsername: string | null = null;
        let assignmentError: string | null = null;
        if (issueNumber && effectiveAssignToSelf) {
          try {
            const user = await forgeClient.getCurrentUser(rootPath);
            if (user) {
              try {
                await forgeClient.assignIssue(rootPath, issueNumber, user.login);
                assignedToSelf = true;
                assignedUsername = user.login;
              } catch (err) {
                assignmentError = formatErrorMessage(err, "Failed to assign issue");
              }
              if (assignedToSelf) {
                // Optimistically patch the cached issue lists so the toolbar
                // dropdown shows the assignment immediately (#11087). Sits
                // outside the assign try/catch: the server-side assign already
                // succeeded, so a cache-layer throw must not masquerade as an
                // assignment failure.
                try {
                  patchIssueAssigneeCache(rootPath, issueNumber, user, true);
                } catch (cacheErr) {
                  logError("Failed to patch issue cache after self-assign", cacheErr);
                }
              }
            } else {
              assignmentError = "No forge viewer available";
            }
          } catch (err) {
            assignmentError = formatErrorMessage(err, "Failed to read forge viewer");
          }
        }

        return {
          worktreeId,
          worktreePath: path,
          branch: effectiveBranch,
          requestedBranch,
          effectiveBranch,
          recipeLaunched,
          spawnedTerminalCount,
          spawnedTerminalIds,
          failedTerminalCount,
          setupState,
          assignedToSelf,
          assignedUsername,
          assignmentError,
        };
      },
    })
  );

  actions.set("workflow.startWorkOnIssue", () =>
    defineAction({
      id: "workflow.startWorkOnIssue",
      title: "Start Work on Issue",
      description:
        "Fetch an issue, create a worktree with a derived branch, launch a terminal-backed agent, and inject context. Returns the issue identity plus worktreeId, worktreePath, branch, terminalId, recipe spawn counts, assignment outcome, and contextInjected. An unknown or non-terminal agentId is rejected before the issue lookup, so no worktree is created.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        issueNumber: z.number().int().positive().describe("Issue number to start work on"),
        agentId: z
          .string()
          .min(1)
          .describe(
            "Which agent CLI to launch in the new worktree, such as 'claude' or 'codex'; pass 'terminal' for a plain shell. Discover the ids actually installed with the agent-listing capability. An unknown id is rejected before anything is created."
          ),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Branch name for the new worktree. Defaults to 'feature/issue-<number>-<slug>' derived from the issue title."
          ),
        baseBranch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Branch to base the worktree on (defaults to main worktree's branch)"),
        recipeId: z.string().optional().describe("Recipe ID to run after creation"),
        assignToSelf: z
          .boolean()
          .optional()
          .describe(
            "Assign the issue to the current user. Omit to use the user's persisted 'Assign issue to me' preference (mirrors the new-worktree dialog checkbox)."
          ),
        injectContext: z
          .boolean()
          .optional()
          .describe("Inject worktree context into the launched terminal (default: true)"),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      }),
      resultSchema: z.object({
        issueNumber: z.number(),
        issueTitle: z.string(),
        issueUrl: z.string(),
        worktreeId: z.string(),
        worktreePath: z.string(),
        branch: z.string(),
        terminalId: z.string().nullable(),
        recipeLaunched: z.boolean(),
        spawnedTerminalCount: z.number().int().nonnegative(),
        failedTerminalCount: z.number().int().nonnegative(),
        assignedToSelf: z.boolean(),
        assignedUsername: z.string().nullable(),
        assignmentError: z.string().nullable(),
        contextInjected: z.boolean(),
      }),
      // Already a top-level object, so the manifest schema passes tierAuth's
      // `type === "object"` gate and the result reaches callers as
      // structuredContent instead of a text blob only (#11547).
      mcpOutputSchema: true,
      run: async (
        {
          issueNumber,
          agentId,
          branchName,
          baseBranch,
          recipeId,
          assignToSelf,
          injectContext,
          spawnedBy,
          focusPolicy,
        },
        ctx: ActionContext
      ) => {
        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }

        // Plugins have no confirm bypass at all, so this stays a hard rejection
        // rather than a confirmation: there is no surface on which a plugin
        // dispatch could be approved. Agent dispatch is NOT rejected here — it
        // is elevated to an effective confirm tier in ActionService before
        // `run()` is ever entered (`resolveEffectiveActionDanger`, #11860), so
        // by the time this line runs an agent caller has already been approved.
        // User dispatch is unaffected.
        if (recipeId && ctx.dispatchSource === "plugin") {
          throw new Error(
            "Plugins cannot spawn recipe terminals through worktree creation. Dispatch recipe.run instead."
          );
        }

        // Validate the agent before any IPC. The launcher rejects an unknown id
        // too, but only at line-of-spawn — by then the worktree exists and any
        // recipe terminals have started, so a typo'd id from MCP left an orphan
        // worktree behind (#11547, deferred from #11500).
        if (NON_TERMINAL_PANEL_IDS.has(agentId)) {
          throw new Error(
            `'${agentId}' opens a panel with no PTY, so it cannot work on an issue or receive injected context. ` +
              `Discover registered agent ids with the agent-listing capability, or use 'terminal' for a plain shell.`
          );
        }
        resolveAgentLaunchKind(agentId, isEffectivelyRegisteredAgent(agentId));

        const rootPath = currentProject.path;
        const effectiveAssignToSelf =
          assignToSelf ?? usePreferencesStore.getState().assignWorktreeToSelf;

        const issue = await forgeClient.getIssue(rootPath, issueNumber);
        if (!issue) {
          throw new Error(`Issue #${issueNumber} not found in ${rootPath}`);
        }

        const derivedBranch =
          branchName ?? `feature/issue-${issue.number}-${slugifyForBranch(issue.title)}`;

        let baseRef: string | undefined = baseBranch;
        if (!baseRef) {
          const mainWorktree = Array.from(getCurrentViewStore().getState().worktrees.values()).find(
            (w) => w.isMainWorktree
          );
          if (!mainWorktree) {
            throw new Error(
              "No base branch specified and no main worktree found. Please specify baseBranch."
            );
          }
          baseRef = mainWorktree.branch;
        }
        if (!baseRef) {
          throw new Error("Base branch is required but was not determined");
        }

        if (recipeId) {
          const recipe = useRecipeStore.getState().getRecipeById(recipeId);
          if (!recipe) {
            throw new Error(
              `Recipe ${recipeId} not found. Use recipe_list to see available recipes.`
            );
          }
        }

        const availableBranch = await worktreeClient.getAvailableBranch(rootPath, derivedBranch);
        const worktreePath = await worktreeClient.getDefaultPath(rootPath, availableBranch);
        const created = await worktreeClient.create(
          {
            baseBranch: baseRef,
            newBranch: availableBranch,
            path: worktreePath,
            fromRemote: false,
            useExistingBranch: false,
          },
          rootPath
        );
        if (!created?.worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }
        const { worktreeId } = created;

        let recipeLaunched = false;
        let spawnedTerminalCount = 0;
        let failedTerminalCount = 0;
        if (recipeId) {
          try {
            const recipeContext = {
              worktreePath,
              branchName: availableBranch,
              issueNumber: issue.number,
            };
            // Forward dispatchSource so runRecipeWithResults applies the
            // agent-source terminal cap to MCP-driven worktree+recipe combos,
            // and hostApprovedRecipeRun so an approval covers every terminal
            // the dialog listed — both matching recipe.run. This composite's
            // confirm dialog previews the same recipe through the same
            // formatter, so omitting the second would preview terminals it then
            // refused to start (#12263).
            const results = await useRecipeStore
              .getState()
              .runRecipeWithResults(recipeId, worktreePath, worktreeId, recipeContext, {
                spawnedBy,
                focusPolicy,
                dispatchSource: ctx.dispatchSource,
                hostApprovedRecipeRun: ctx.hostApprovedRecipeRun,
              });
            // "Launched" means at least one terminal actually spawned — a run
            // where every terminal was dropped (e.g. panel limit) must not
            // report success to agent callers.
            recipeLaunched = results.spawned.length > 0;
            spawnedTerminalCount = results.spawned.length;
            failedTerminalCount = results.failed.length;
            notifyRecipeSpawnFailures(results, {
              recipeName: useRecipeStore.getState().getRecipeById(recipeId)?.name,
              projectId: currentProject.id,
            });
          } catch (err) {
            throw partialSuccessError(
              `Recipe ${recipeId} failed to run: ${formatErrorMessage(err, "unknown error")}`,
              {
                issueNumber: issue.number,
                issueTitle: issue.title,
                issueUrl: issue.url,
                worktreeId,
                worktreePath,
                branch: availableBranch,
                terminalId: null,
                recipeLaunched: false,
                spawnedTerminalCount: 0,
                failedTerminalCount: 0,
                assignedToSelf: false,
                assignedUsername: null,
                assignmentError: null,
                contextInjected: false,
              }
            );
          }
        }

        let terminalId: string | null;
        let launchSpawnStatus: "missing-cli" | undefined;
        try {
          const launchResult = await callbacks.onLaunchAgent(agentId, {
            location: "grid",
            cwd: worktreePath,
            worktreeId,
            activateDockOnCreate: false,
            spawnedBy,
            focusPolicy,
          });
          terminalId = launchResult?.terminalId ?? null;
          launchSpawnStatus = launchResult?.spawnStatus;
        } catch (err) {
          throw partialSuccessError(
            `Agent '${agentId}' failed to launch in new worktree: ${formatErrorMessage(err, "unknown error")}`,
            {
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              worktreeId,
              worktreePath,
              branch: availableBranch,
              terminalId: null,
              recipeLaunched,
              spawnedTerminalCount,
              failedTerminalCount,
              assignedToSelf: false,
              assignedUsername: null,
              assignmentError: null,
              contextInjected: false,
            }
          );
        }
        if (!terminalId) {
          throw partialSuccessError(`Agent '${agentId}' failed to launch in new worktree`, {
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.url,
            worktreeId,
            worktreePath,
            branch: availableBranch,
            terminalId: null,
            recipeLaunched,
            spawnedTerminalCount,
            failedTerminalCount,
            assignedToSelf: false,
            assignedUsername: null,
            assignmentError: null,
            contextInjected: false,
          });
        }
        // A missing CLI opens a setup-diagnostic panel with a real id but no PTY.
        // Injecting context into it (or reporting a launched agent) would be a
        // lie, so surface it as a partial result the caller can act on instead.
        if (launchSpawnStatus === "missing-cli") {
          throw partialSuccessError(
            `Agent '${agentId}' CLI is not available — Daintree opened a setup diagnostic instead of starting the agent`,
            {
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              worktreeId,
              worktreePath,
              branch: availableBranch,
              terminalId: null,
              recipeLaunched,
              spawnedTerminalCount,
              failedTerminalCount,
              assignedToSelf: false,
              assignedUsername: null,
              assignmentError: null,
              contextInjected: false,
            }
          );
        }

        const shouldInject = injectContext ?? true;
        let contextInjected = false;
        if (shouldInject) {
          try {
            // CopyTree reports the common failures (terminal gone, generation
            // failed) as a RESOLVED result carrying `error`, not a rejection —
            // the same check useContextInjection makes. Without it every
            // resolved call reported success, which now matters: the flag is
            // published as structuredContent rather than buried in text.
            const injection = await copyTreeClient.injectToTerminal(
              terminalId,
              worktreeId,
              undefined,
              undefined,
              "workflow"
            );
            contextInjected = !injection?.error;
          } catch {
            // Best-effort — agent is launched; user can re-inject manually.
          }
        }

        let assignedToSelf = false;
        let assignedUsername: string | null = null;
        let assignmentError: string | null = null;
        if (effectiveAssignToSelf) {
          try {
            const user = await forgeClient.getCurrentUser(rootPath);
            if (user) {
              try {
                await forgeClient.assignIssue(rootPath, issue.number, user.login);
                assignedToSelf = true;
                assignedUsername = user.login;
              } catch (err) {
                assignmentError = formatErrorMessage(err, "Failed to assign issue");
              }
              if (assignedToSelf) {
                // See worktree.createWithRecipe: optimistic dropdown patch
                // (#11087), isolated so a cache throw can't be reported as an
                // assignment failure.
                try {
                  patchIssueAssigneeCache(rootPath, issue.number, user, true);
                } catch (cacheErr) {
                  logError("Failed to patch issue cache after self-assign", cacheErr);
                }
              }
            } else {
              assignmentError = "No forge viewer available";
            }
          } catch (err) {
            assignmentError = formatErrorMessage(err, "Failed to read forge viewer");
          }
        }

        return {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          worktreeId,
          worktreePath,
          branch: availableBranch,
          terminalId,
          recipeLaunched,
          spawnedTerminalCount,
          failedTerminalCount,
          assignedToSelf,
          assignedUsername,
          assignmentError,
          contextInjected,
        };
      },
    })
  );
}
