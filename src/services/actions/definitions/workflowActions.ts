import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { worktreeClient, githubClient, projectClient, copyTreeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import { usePanelStore } from "@/store/panelStore";
import { selectOrderedTerminals } from "@/store/slices/panelRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const PARTIAL_SUCCESS_PREFIX = "PARTIAL_SUCCESS:";

// Encode the message + partial result as a single JSON envelope so callers can
// parse unambiguously even when `message` itself contains `{`.
function partialSuccessError(message: string, partial: Record<string, unknown>): Error {
  const payload = JSON.stringify({ message, partialResult: partial });
  return new Error(`${PARTIAL_SUCCESS_PREFIX} ${payload}`);
}

function slugifyForBranch(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "work"
  );
}

export function registerWorkflowActions(
  actions: ActionRegistry,
  callbacks: Pick<ActionCallbacks, "onLaunchAgent">
): void {
  actions.set("worktree.createWithRecipe", () =>
    defineAction({
      id: "worktree.createWithRecipe",
      title: "Create Worktree with Recipe",
      description:
        "Create a worktree with branch and path setup, optionally run a recipe, and optionally assign the linked issue.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        branchName: z
          .string()
          .trim()
          .min(1)
          .describe("Name for the new branch (will be sanitized for git compatibility)"),
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
          .optional()
          .describe("GitHub issue number to link with the worktree"),
        assignToSelf: z
          .boolean()
          .optional()
          .describe("Explicitly assign the linked issue to the current user (default: false)"),
      }),
      resultSchema: z.object({
        worktreeId: z.string(),
        worktreePath: z.string(),
        branch: z.string(),
        recipeLaunched: z.boolean(),
        assignedToSelf: z.boolean(),
      }),
      run: async ({
        branchName,
        baseBranch,
        recipeId,
        fromRemote,
        useExistingBranch,
        issueNumber,
        assignToSelf,
      }) => {
        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }

        const rootPath = currentProject.path;

        let baseRef: string | undefined = baseBranch;
        if (!baseRef) {
          const mainWorktree = Array.from(getCurrentViewStore().getState().worktrees.values()).find(
            (w) => w.isMainWorktree
          );
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

        if (recipeId) {
          const recipe = useRecipeStore.getState().getRecipeById(recipeId);
          if (!recipe) {
            throw new Error(
              `Recipe ${recipeId} not found. Use recipe_list to see available recipes.`
            );
          }
        }

        const availableBranch = await worktreeClient.getAvailableBranch(rootPath, branchName);
        const path = await worktreeClient.getDefaultPath(rootPath, availableBranch);

        const worktreeId = await worktreeClient.create(
          {
            baseBranch: baseRef,
            newBranch: availableBranch,
            path,
            fromRemote: fromRemote ?? false,
            useExistingBranch: useExistingBranch ?? false,
          },
          rootPath
        );

        if (!worktreeId) {
          throw new Error("Failed to create worktree: no worktreeId returned from backend");
        }

        let recipeLaunched = false;
        if (recipeId) {
          await useRecipeStore.getState().runRecipe(recipeId, path, worktreeId, {
            worktreePath: path,
            branchName: availableBranch,
            issueNumber,
          });
          recipeLaunched = true;
        }

        let assignedToSelf = false;
        if (issueNumber && assignToSelf) {
          const username = useGitHubConfigStore.getState().config?.username;
          if (username) {
            try {
              await githubClient.assignIssue(rootPath, issueNumber, username);
              assignedToSelf = true;
            } catch {
              // Silent failure — assignment is best-effort
            }
          }
        }

        return {
          worktreeId,
          worktreePath: path,
          branch: availableBranch,
          recipeLaunched,
          assignedToSelf,
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
          .describe("Assign the issue to the current user (default: false)"),
        injectContext: z
          .boolean()
          .optional()
          .describe("Inject worktree context into the launched terminal (default: true)"),
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
      }) => {
        const currentProject = useProjectStore.getState().currentProject;
        if (!currentProject) {
          throw new Error("No active project");
        }
        const rootPath = currentProject.path;

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
            await useRecipeStore.getState().runRecipe(recipeId, worktreePath, worktreeId, {
              worktreePath,
              branchName: availableBranch,
              issueNumber: issue.number,
            });
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
                contextInjected: false,
              }
            );
          }
        }

        // Both null returns and thrown errors must be reported as PARTIAL_SUCCESS so the
        // caller knows the worktree is already created and not lost.
        let terminalId: string | null;
        try {
          terminalId = await callbacks.onLaunchAgent(agentId, {
            location: "grid",
            cwd: worktreePath,
            worktreeId,
            activateDockOnCreate: false,
          });
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
        if (assignToSelf) {
          const username = useGitHubConfigStore.getState().config?.username;
          if (username) {
            try {
              await githubClient.assignIssue(rootPath, issue.number, username);
              assignedToSelf = true;
            } catch {
              // Silent — assignment is best-effort, agent is already running
            }
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
          contextInjected,
        };
      },
    })
  );

  actions.set("workflow.prepBranchForReview", () =>
    defineAction({
      id: "workflow.prepBranchForReview",
      title: "Prep Branch for Review",
      description:
        "Inspect a worktree's staging status and detected runners; returns a typed verdict for what to run next.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        cwd: z.string().describe("Worktree path to inspect"),
        projectId: z
          .string()
          .optional()
          .describe(
            "Project ID for runner detection. Defaults to the current project. Pass explicitly when `cwd` belongs to a different project."
          ),
      }),
      resultSchema: z.object({
        verdict: z.enum([
          "ready",
          "blocked_uncommitted_changes",
          "blocked_merge_conflicts",
          "blocked_repo_busy",
          "no_runners_detected",
        ]),
        hasUncommittedChanges: z.boolean(),
        hasMergeConflicts: z.boolean(),
        stagedCount: z.number(),
        unstagedCount: z.number(),
        currentBranch: z.string().nullable(),
        repoState: z.string(),
        detectedRunners: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            command: z.string(),
          })
        ),
      }),
      run: async ({ cwd, projectId }) => {
        const resolvedProjectId =
          projectId ?? useProjectStore.getState().currentProject?.id ?? null;

        const status = await window.electron.git.getStagingStatus(cwd);

        const detectedRunners = resolvedProjectId
          ? (await projectClient.detectRunners(resolvedProjectId)).map((r) => ({
              id: r.id,
              name: r.name,
              command: r.command,
            }))
          : [];

        const stagedCount = status.staged.length;
        const unstagedCount = status.unstaged.length;
        const hasUncommittedChanges = stagedCount > 0 || unstagedCount > 0;
        const hasMergeConflicts = status.conflictedFiles.length > 0;

        let verdict:
          | "ready"
          | "blocked_uncommitted_changes"
          | "blocked_merge_conflicts"
          | "blocked_repo_busy"
          | "no_runners_detected";
        if (hasMergeConflicts) {
          verdict = "blocked_merge_conflicts";
        } else if (hasUncommittedChanges) {
          verdict = "blocked_uncommitted_changes";
        } else if (status.repoState !== "CLEAN" && status.repoState !== "DIRTY") {
          verdict = "blocked_repo_busy";
        } else if (detectedRunners.length === 0) {
          verdict = "no_runners_detected";
        } else {
          verdict = "ready";
        }

        return {
          verdict,
          hasUncommittedChanges,
          hasMergeConflicts,
          stagedCount,
          unstagedCount,
          currentBranch: status.currentBranch,
          repoState: status.repoState,
          detectedRunners,
        };
      },
    })
  );

  actions.set("workflow.focusNextAttention", () =>
    defineAction({
      id: "workflow.focusNextAttention",
      title: "Focus Next Attention",
      description:
        "Focus the next agent needing attention (waiting before working); returns focused state and counts.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      resultSchema: z.object({
        focused: z.boolean(),
        state: z.enum(["waiting", "working", "none"]),
        waitingCount: z.number(),
        workingCount: z.number(),
      }),
      run: async () => {
        const state = usePanelStore.getState();
        const terminals = selectOrderedTerminals(state.panelsById, state.panelIds);
        const worktreeData = getCurrentViewStore().getState();
        const validWorktreeIds = new Set<string>();
        for (const [id, wt] of worktreeData.worktrees) {
          validWorktreeIds.add(id);
          if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
        }

        // Mirror isTerminalVisible() in terminalFocusSlice — counts must match
        // what focusNextWaiting/focusNextWorking will actually consider, otherwise
        // the macro could report `focused: true` while the focus call is a no-op.
        const inScope = terminals.filter(
          (t) =>
            t.worktreeId !== undefined &&
            t.worktreeId !== null &&
            validWorktreeIds.has(t.worktreeId) &&
            t.location !== "trash" &&
            t.location !== "background" &&
            t.ephemeral !== true &&
            !state.isInTrash(t.id)
        );
        const waitingCount = inScope.filter((t) => t.agentState === "waiting").length;
        const workingCount = inScope.filter((t) => t.agentState === "working").length;

        if (waitingCount > 0) {
          state.focusNextWaiting(state.isInTrash, validWorktreeIds);
          return { focused: true, state: "waiting" as const, waitingCount, workingCount };
        }
        if (workingCount > 0) {
          state.focusNextWorking(state.isInTrash, validWorktreeIds);
          return { focused: true, state: "working" as const, waitingCount, workingCount };
        }
        return { focused: false, state: "none" as const, waitingCount, workingCount };
      },
    })
  );
}
