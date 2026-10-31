// The workflow-creation actions' run bodies, loaded on first dispatch by
// `runWorkflowCreationAction` in workflowCreationActions.ts, which keeps the
// metadata every view registers at boot (#14275). Nothing here may import
// workflowCreationActions.ts at runtime.
import type { ActionCallbacks } from "../actionTypes";
import type { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { WorktreeBranchCollisionPolicy } from "@shared/types/git";
import { worktreeClient, forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
import { logError } from "@/utils/logger";
import { partialSuccessError, slugifyForBranch } from "./workflowHelpers";
import { issueBranchName } from "@shared/utils/issueBranchName";
import { linkProviderIssue } from "@/utils/linkProviderIssue";
import { resolveAgentLaunchKind } from "@/utils/agentLaunchValidation";
// The shared registry helper rather than `isRegisteredAgent` from
// `@/config/agents`: identical result (that one is a one-line delegation to
// this), but `@/config/agents` pulls the React icon map into the action module
// graph, which action registration has no business importing.
import { isEffectivelyRegisteredAgent } from "@shared/config/agentRegistry";
import type {
  CreateWithRecipeArgsSchema,
  StartWorkOnIssueArgsSchema,
} from "./workflowCreationActionArgs";

/**
 * Panel kinds `launchAgent` routes through its own non-PTY branches before it
 * ever classifies the id against the registry. A workflow that must inject
 * context into a running agent cannot use them, and the literal check has to be
 * explicit: a plugin may register an agent under one of these ids, which would
 * otherwise classify as a launchable agent and then still open a browser pane.
 */
const NON_TERMINAL_PANEL_IDS = new Set(["browser", "dev-preview"]);

/**
 * Read an action's validated args as its schema's output type.
 *
 * `run` receives `unknown`, but ActionService has already parsed `argsSchema`
 * and hands over the parsed value, so the schema named here — the same one
 * workflowCreationActions.ts registers — is the type the args actually have. The cast is
 * written once here rather than at each body, and takes the schema as a type so
 * this chunk never imports the args schemas at runtime.
 */
function argsOf<S extends z.ZodType>(args: unknown): z.output<S> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionService validated `argsSchema` before run()
  return args as z.output<S>;
}

export const workflowCreationActionRuns = {
  "worktree.createWithRecipe": async (args: unknown, ctx: ActionContext) => {
    const { source, recipeId, spawnedBy, focusPolicy } =
      argsOf<typeof CreateWithRecipeArgsSchema>(args);
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
        throw new Error(`Recipe ${recipeId} not found. Use recipe_list to see available recipes.`);
      }
    }

    const pullRequestNumber = source.kind === "pullRequest" ? source.pullRequestNumber : undefined;

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
      // Unlike the dialogs, which try a remote-tracking branch and a local
      // branch first and render a banner when the fetch fails, this path
      // fetches unconditionally and its caller is an agent. A raw
      // "couldn't find remote ref" tells it nothing about what to do next,
      // so name the branch and the way out. The original git message stays
      // in the text — it is the only part that says why.
      try {
        await worktreeClient.fetchPRBranch(rootPath, source.pullRequestNumber, pr.headRef);
      } catch (error) {
        throw new Error(
          `Couldn't fetch branch "${pr.headRef}" for pull request #${source.pullRequestNumber}. ` +
            `Fetch it yourself, then retry with source.kind="existingBranch" and source.branchName="${pr.headRef}". ` +
            `Details: ${formatErrorMessage(error, "the git fetch failed")}`,
          { cause: error }
        );
      }
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
        const mainWorktree = Array.from(getCurrentViewStore().getState().worktrees.values()).find(
          (w) => w.isMainWorktree
        );
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
          worktreeId,
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
  "workflow.startWorkOnIssue": async (
    args: unknown,
    ctx: ActionContext,
    callbacks: Pick<ActionCallbacks, "onLaunchAgent">
  ) => {
    const {
      issueNumber,
      agentId,
      branchName,
      baseBranch,
      recipeId,
      assignToSelf,
      injectContext,
      spawnedBy,
      focusPolicy,
    } = argsOf<typeof StartWorkOnIssueArgsSchema>(args);
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
      branchName ??
      issueBranchName(issue, `feature/issue-${issue.number}-${slugifyForBranch(issue.title)}`);

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
        throw new Error(`Recipe ${recipeId} not found. Use recipe_list to see available recipes.`);
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
    linkProviderIssue(worktreeId, issue);

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
          worktreeId,
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
        // Lazily, as in `copyTree.injectToTerminal`: the guard reads panelStore.
        const { injectContextUnlessLocked } = await import("@/services/contextInjectionGuard");
        const injection = await injectContextUnlessLocked({
          terminalId,
          worktreeId,
          source: "workflow",
        });
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
} satisfies Record<
  string,
  (
    args: unknown,
    ctx: ActionContext,
    callbacks: Pick<ActionCallbacks, "onLaunchAgent">
  ) => Promise<unknown>
>;

export type WorkflowCreationActionRunId = keyof typeof workflowCreationActionRuns;
