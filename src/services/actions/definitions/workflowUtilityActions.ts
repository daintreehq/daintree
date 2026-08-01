import type { ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { projectClient } from "@/clients";
import { withWorktreeLocation, requireWorktreePath } from "./locationArgs";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { selectOrderedTerminals } from "@/store/slices/panelRegistry";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { isPtyPanel } from "@shared/types/panel";

export function registerWorkflowUtilityActions(actions: ActionRegistry): void {
  actions.set("workflow.prepBranchForReview", () =>
    defineAction({
      id: "workflow.prepBranchForReview",
      // The id is stable (keybindings, plugins, and MCP clients reference it),
      // but the old "Prep" title promised work this never did — it reads git
      // status and detected runners and changes nothing (#11548).
      title: "Inspect Branch for Review",
      description:
        "Inspect a worktree and report a go/no-go verdict on whether review checks can start, naming what is blocking if not. Despite the name it prepares nothing and runs nothing — it is read-only, and running a detected check is a separate step. Use it to avoid launching checks against a dirty or conflicted tree.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: withWorktreeLocation(
        {
          projectId: z
            .string()
            .optional()
            .describe(
              "Project ID for runner detection. Defaults to the current project. Pass explicitly when the worktree belongs to a different project."
            ),
        },
        { legacy: ["cwd"] }
      ),
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
      run: async ({ projectId, ...location }, ctx: ActionContext) => {
        const resolvedCwd = requireWorktreePath(location, ctx);
        const resolvedProjectId =
          projectId ?? ctx.projectId ?? useProjectStore.getState().currentProject?.id ?? null;

        const status = await window.electron.git.getStagingStatus(resolvedCwd);

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
        "Move keyboard focus to the agent most in need of attention, preferring one blocked on the user over one merely working. Use this to triage a fleet by hand. It changes what the user sees and reports only counts — read an agent status snapshot for the actual state of each terminal.",
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

        const inScope = terminals.filter((t) =>
          isTerminalVisible(t, state.isInTrash, validWorktreeIds)
        );
        const waitingCount = inScope.filter(
          (t) => isPtyPanel(t) && t.agentState === "waiting"
        ).length;
        const workingCount = inScope.filter(
          (t) => isPtyPanel(t) && t.agentState === "working"
        ).length;

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
