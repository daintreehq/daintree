import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { copyTreeClient, systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";

export function registerWorktreeContextActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.copyTree", () =>
    defineAction({
      id: "worktree.copyTree",
      title: "Copy Worktree Context",
      description: "Generate and copy context for a worktree to clipboard",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
          modified: z.boolean().optional(),
        })
        .optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const explicitFormat = args?.format;
        const modified = args?.modified;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return null;

        const format = explicitFormat ?? DEFAULT_COPYTREE_FORMAT;

        const result = await copyTreeClient.generateAndCopyFile(targetWorktreeId, {
          format,
          modified,
        });

        if (result.error) {
          if (modified && result.error.includes("No valid files")) {
            throw new Error("No modified files to copy. Make some changes first.");
          }
          throw new Error(result.error);
        }

        return {
          worktreeId: targetWorktreeId,
          fileCount: result.fileCount,
          stats: result.stats ?? null,
          format,
        };
      },
    })
  );

  actions.set("worktree.copyContext", () =>
    defineAction({
      id: "worktree.copyContext",
      title: "Copy Worktree Context (Alias)",
      description: "Alias for worktree.copyTree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
          modified: z.boolean().optional(),
        })
        .optional(),
      run: async (args) => {
        const result = await actionService.dispatch("worktree.copyTree", args, { source: "user" });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.result as unknown;
      },
    })
  );

  actions.set("worktree.inject", () =>
    defineAction({
      id: "worktree.inject",
      title: "Inject Worktree Context into Focused Terminal",
      description: "Inject this worktree's context into the currently focused terminal",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
        })
        .optional(),
      isEnabled: (ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        return hasFocusedTerminal;
      },
      disabledReason: (ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        if (!hasFocusedTerminal) {
          return "No focused terminal to inject into";
        }
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const hasFocusedTerminal = Boolean(ctx.focusedTerminalId);
        if (!hasFocusedTerminal) {
          throw new Error("No focused terminal to inject into");
        }
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) {
          throw new Error("No worktree selected");
        }
        callbacks.onInject(targetWorktreeId);
      },
    })
  );

  actions.set("worktree.openEditor", () =>
    defineAction({
      id: "worktree.openEditor",
      title: "Open in Editor",
      description: "Open a worktree folder in the OS file manager / editor",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;

        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) return;

        await systemClient.openPath(worktree.path);
      },
    })
  );

  actions.set("worktree.openReviewHub", () =>
    defineAction({
      id: "worktree.openReviewHub",
      title: "Open Review Hub",
      description: "Open the Review Hub for a worktree to review uncommitted changes",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;
        useWorktreeSelectionStore.getState().setActiveWorktree(targetWorktreeId);
        useUIStore.getState().setPendingReviewHubWorktreeId(targetWorktreeId);
      },
    })
  );

  actions.set("worktree.reveal", () =>
    defineAction({
      id: "worktree.reveal",
      title: "Reveal Worktree",
      description: "Reveal a worktree folder in the OS file manager",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) return;
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) return;
        await systemClient.openPath(worktree.path);
      },
    })
  );

  actions.set("worktree.compareDiff", () =>
    defineAction({
      id: "worktree.compareDiff",
      title: "Compare Worktree Diff",
      description:
        "Compare two worktrees and return the list of files that differ between their branches. Args: `worktreeId` (optional — the left/base side; defaults to the focused or active worktree), `compareToWorktreeId` (required — the right side to compare against), `useMergeBase` (optional — three-dot/PR-accurate range), `ignoreWhitespace` (optional). Returns { branch1, branch2, files } where each file has path, oldPath?, status, insertions, deletions. Read-only; does not open any UI. For a single file's full diff, call `git.getFileDiff` afterwards.",
      category: "worktree",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string().optional(),
        compareToWorktreeId: z.string(),
        useMergeBase: z.boolean().optional(),
        ignoreWhitespace: z.boolean().optional(),
      }),
      resultSchema: z.object({
        branch1: z.string(),
        branch2: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            oldPath: z.string().optional(),
            status: z.string(),
            insertions: z.number().nullable(),
            deletions: z.number().nullable(),
          })
        ),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
      run: async (args, ctx: ActionContext) => {
        const leftId = args.worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId ?? null;
        if (!leftId) {
          throw new Error(
            "No base worktree to compare from. Pass `worktreeId` or focus a worktree first."
          );
        }
        const rightId = args.compareToWorktreeId;

        const worktrees = getCurrentViewStore().getState().worktrees;
        const left = worktrees.get(leftId);
        if (!left) {
          throw new Error(`Worktree not found: ${leftId}`);
        }
        const right = worktrees.get(rightId);
        if (!right) {
          throw new Error(`Worktree not found: ${rightId}`);
        }
        if (!left.branch) {
          throw new Error(`Worktree '${leftId}' has no branch (detached HEAD); cannot compare.`);
        }
        if (!right.branch) {
          throw new Error(`Worktree '${rightId}' has no branch (detached HEAD); cannot compare.`);
        }

        const res = await window.electron.git.compareWorktrees(
          left.path,
          left.branch,
          right.branch,
          undefined,
          args.useMergeBase,
          args.ignoreWhitespace
        );
        if (typeof res === "string") {
          throw new Error("Unexpected diff string from worktree comparison; expected a file list.");
        }
        return res;
      },
    })
  );
}
