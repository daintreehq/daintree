import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports
import { worktreeClient, githubClient, copyTreeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { TerminalSpawnSourceSchema } from "./schemas";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { partialSuccessError, slugifyForBranch } from "./workflowHelpers";

export function registerWorkflowCreationActions(
  actions: ActionRegistry,
  callbacks: Pick<ActionCallbacks, "onLaunchAgent">
): void {
  actions.set("worktree.createWithRecipe", () =>
    defineAction({
      id: "worktree.createWithRecipe",
      title: "Create Worktree with Recipe",
      description:
        "Create a worktree with branch setup, optionally from a PR, with recipe and issue assignment.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          branchName: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Name for the new branch (will be sanitized for git compatibility). Required unless pullRequestNumber is provided — the PR's head branch is used in that case."
            ),
          baseBranch: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Branch to base the worktree on (defaults to main worktree's branch)"),
          recipeId: z.string().optional().describe("Recipe ID to run after creation"),
          fromRemote: z.boolean().optional().describe("Set true if baseBranch is a remote branch"),
          useExistingBranch: z
            .boolean()
            .optional()
            .describe("Use an existing branch instead of creating a new one"),
          issueNumber: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "GitHub issue number to link with the worktree. Mutually exclusive with pullRequestNumber."
            ),
          pullRequestNumber: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "GitHub pull request number to check out. Resolves the PR's head branch automatically and creates the worktree on it. Mutually exclusive with issueNumber."
            ),
          assignToSelf: z
            .boolean()
            .optional()
            .describe(
              "Assign the linked issue to the current user. Omit to use the user's persisted 'Assign issue to me' preference (mirrors the new-worktree dialog checkbox)."
            ),
          spawnedBy: TerminalSpawnSourceSchema.optional(),
        })
        .refine((d) => !(d.issueNumber !== undefined && d.pullRequestNumber !== undefined), {
          message: "issueNumber and pullRequestNumber are mutually exclusive",
        }),
      resultSchema: z.object({
        worktreeId: z.string(),
        worktreePath: z.string(),
        branch: z.string(),
        recipeLaunched: z.boolean(),
        assignedToSelf: z.boolean(),
        assignmentError: z.string().nullable(),
      }),
      run: async ({
        branchName,
        baseBranch,
        recipeId,
        fromRemote,
        useExistingBranch,
        issueNumber,
        pullRequestNumber,
        assignToSelf,
        spawnedBy,
      }) => {
        if (issueNumber !== undefined && pullRequestNumber !== undefined) {
          throw new Error("issueNumber and pullRequestNumber are mutually exclusive");
        }

        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }

        const effectiveAssignToSelf =
          assignToSelf ?? usePreferencesStore.getState().assignWorktreeToSelf;

        const rootPath = currentProject.path;

        if (recipeId) {
          const recipe = useRecipeStore.getState().getRecipeById(recipeId);
          if (!recipe) {
            throw new Error(
              `Recipe ${recipeId} not found. Use recipe_list to see available recipes.`
            );
          }
        }

        let effectiveBranch: string;
        let effectiveBase: string;
        let effectiveUseExisting: boolean;
        let effectiveFromRemote: boolean;

        if (pullRequestNumber !== undefined) {
          const pr = await githubClient.getPRByNumber(rootPath, pullRequestNumber);
          if (!pr) {
            throw new Error(`Pull request #${pullRequestNumber} not found in ${rootPath}`);
          }
          if (!pr.headRefName) {
            throw new Error(
              `Pull request #${pullRequestNumber} has no head branch — cannot create worktree`
            );
          }
          await worktreeClient.fetchPRBranch(rootPath, pullRequestNumber, pr.headRefName);
          effectiveBranch = pr.headRefName;
          effectiveBase = pr.headRefName;
          effectiveUseExisting = true;
          effectiveFromRemote = false;
        } else {
          if (!branchName) {
            throw new Error("branchName is required when pullRequestNumber is not provided");
          }
          let baseRef: string | undefined = baseBranch;
          if (!baseRef) {
            const mainWorktree = Array.from(
              getCurrentViewStore().getState().worktrees.values()
            ).find((w) => w.isMainWorktree);
            if (!mainWorktree) {
              throw new Error(
                "No base branch specified and no main worktree found. Please specify baseBranch parameter."
              );
            }
            baseRef = mainWorktree.branch;
          }
          if (!baseRef) {
            throw new Error("Base branch is required but was not determined");
          }
          effectiveBranch = await worktreeClient.getAvailableBranch(rootPath, branchName);
          effectiveBase = baseRef;
          effectiveUseExisting = useExistingBranch ?? false;
          effectiveFromRemote = fromRemote ?? false;
        }

        const path = await worktreeClient.getDefaultPath(rootPath, effectiveBranch);

        const worktreeId = await worktreeClient.create(
          {
            baseBranch: effectiveBase,
            newBranch: effectiveBranch,
            path,
            fromRemote: effectiveFromRemote,
            useExistingBranch: effectiveUseExisting,
          },
          rootPath
        );

        if (!worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }

        let recipeLaunched = false;
        if (recipeId) {
          try {
            const recipeContext = {
              worktreePath: path,
              branchName: effectiveBranch,
              issueNumber,
              prNumber: pullRequestNumber,
            };
            if (spawnedBy === undefined) {
              await useRecipeStore.getState().runRecipe(recipeId, path, worktreeId, recipeContext);
            } else {
              await useRecipeStore.getState().runRecipe(recipeId, path, worktreeId, recipeContext, {
                spawnedBy,
              });
            }
            recipeLaunched = true;
          } catch (err) {
            throw partialSuccessError(
              `Recipe ${recipeId} failed to run: ${formatErrorMessage(err, "unknown error")}`,
              {
                worktreeId,
                worktreePath: path,
                branch: effectiveBranch,
                recipeLaunched: false,
                assignedToSelf: false,
                assignmentError: null,
              }
            );
          }
        }

        let assignedToSelf = false;
        let assignmentError: string | null = null;
        if (issueNumber && effectiveAssignToSelf) {
          try {
            const username = (await githubClient.getConfig()).username;
            if (username) {
              try {
                await githubClient.assignIssue(rootPath, issueNumber, username);
                assignedToSelf = true;
              } catch (err) {
                assignmentError = formatErrorMessage(err, "Failed to assign issue");
              }
            } else {
              assignmentError = "No GitHub username configured";
            }
          } catch (err) {
            assignmentError = formatErrorMessage(err, "Failed to read GitHub config");
          }
        }

        return {
          worktreeId,
          worktreePath: path,
          branch: effectiveBranch,
          recipeLaunched,
          assignedToSelf,
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
        "Fetch a GitHub issue, create a worktree with a derived branch, launch an agent, and inject context.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        issueNumber: z.number().int().positive().describe("GitHub issue number to start work on"),
        agentId: z
          .string()
          .min(1)
          .describe("Agent CLI to launch in the new worktree (e.g. 'claude', 'codex', 'gemini')"),
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
        assignedToSelf: z.boolean(),
        assignmentError: z.string().nullable(),
        contextInjected: z.boolean(),
      }),
      run: async ({
        issueNumber,
        agentId,
        branchName,
        baseBranch,
        recipeId,
        assignToSelf,
        injectContext,
        spawnedBy,
      }) => {
        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }
        const rootPath = currentProject.path;
        const effectiveAssignToSelf =
          assignToSelf ?? usePreferencesStore.getState().assignWorktreeToSelf;

        const issue = await githubClient.getIssueByNumber(rootPath, issueNumber);
        if (!issue) {
          throw new Error(`GitHub issue #${issueNumber} not found in ${rootPath}`);
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
        const worktreeId = await worktreeClient.create(
          {
            baseBranch: baseRef,
            newBranch: availableBranch,
            path: worktreePath,
            fromRemote: false,
            useExistingBranch: false,
          },
          rootPath
        );
        if (!worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }

        let recipeLaunched = false;
        if (recipeId) {
          try {
            const recipeContext = {
              worktreePath,
              branchName: availableBranch,
              issueNumber: issue.number,
            };
            if (spawnedBy === undefined) {
              await useRecipeStore
                .getState()
                .runRecipe(recipeId, worktreePath, worktreeId, recipeContext);
            } else {
              await useRecipeStore
                .getState()
                .runRecipe(recipeId, worktreePath, worktreeId, recipeContext, { spawnedBy });
            }
            recipeLaunched = true;
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
                assignedToSelf: false,
                assignmentError: null,
                contextInjected: false,
              }
            );
          }
        }

        let terminalId: string | null;
        try {
          terminalId =
            (
              await callbacks.onLaunchAgent(agentId, {
                location: "grid",
                cwd: worktreePath,
                worktreeId,
                activateDockOnCreate: false,
                spawnedBy,
              })
            )?.terminalId ?? null;
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
              assignedToSelf: false,
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
            assignedToSelf: false,
            assignmentError: null,
            contextInjected: false,
          });
        }

        const shouldInject = injectContext ?? true;
        let contextInjected = false;
        if (shouldInject) {
          try {
            await copyTreeClient.injectToTerminal(terminalId, worktreeId);
            contextInjected = true;
          } catch {
            // Best-effort — agent is launched; user can re-inject manually.
          }
        }

        let assignedToSelf = false;
        let assignmentError: string | null = null;
        if (effectiveAssignToSelf) {
          try {
            const username = (await githubClient.getConfig()).username;
            if (username) {
              try {
                await githubClient.assignIssue(rootPath, issue.number, username);
                assignedToSelf = true;
              } catch (err) {
                assignmentError = formatErrorMessage(err, "Failed to assign issue");
              }
            } else {
              assignmentError = "No GitHub username configured";
            }
          } catch (err) {
            assignmentError = formatErrorMessage(err, "Failed to read GitHub config");
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
          assignedToSelf,
          assignmentError,
          contextInjected,
        };
      },
    })
  );
}
