import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { worktreeClient } from "@/clients";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

function notifyWorktreeResourceError(err: unknown, title: string, fallbackMessage: string): void {
  const message = formatErrorMessage(err, fallbackMessage) || fallbackMessage;
  notify({
    type: "error",
    priority: "high",
    title,
    message,
    action: {
      label: "Copy details",
      successLabel: "Copied",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(message);
        } catch {
          // clipboard write is non-critical
        }
      },
    },
  });
}

export function registerWorktreeResourceActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.resource.provision", () =>
    defineAction({
      id: "worktree.resource.provision",
      title: "Provision Resource",
      description: "Run resource provisioning commands for a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return !!worktree?.hasProvisionCommand;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (!worktree?.hasProvisionCommand) return "Worktree has no provision command configured";
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        try {
          await worktreeClient.resourceAction(targetWorktreeId, "provision");
        } catch (err) {
          notifyWorktreeResourceError(err, "Provision failed", "Resource provisioning failed");
        }
      },
    })
  );

  actions.set("worktree.resource.teardown", () =>
    defineAction({
      id: "worktree.resource.teardown",
      title: "Teardown Resource",
      description: "Run resource teardown commands for a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return !!worktree?.hasTeardownCommand;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (!worktree?.hasTeardownCommand) return "Worktree has no teardown command configured";
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        try {
          await worktreeClient.resourceAction(targetWorktreeId, "teardown");
        } catch (err) {
          notifyWorktreeResourceError(err, "Teardown failed", "Resource teardown failed");
        }
      },
    })
  );

  actions.set("worktree.resource.resume", () =>
    defineAction({
      id: "worktree.resource.resume",
      title: "Resume Resource",
      description: "Resume the resource associated with a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return !!worktree?.hasResumeCommand;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (!worktree?.hasResumeCommand) return "Worktree has no resume command configured";
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        try {
          await worktreeClient.resourceAction(targetWorktreeId, "resume");
        } catch (err) {
          notifyWorktreeResourceError(err, "Resume failed", "Resource resume failed");
        }
      },
    })
  );

  actions.set("worktree.resource.pause", () =>
    defineAction({
      id: "worktree.resource.pause",
      title: "Pause Resource",
      description: "Pause the resource associated with a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return !!worktree?.hasPauseCommand;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (!worktree?.hasPauseCommand) return "Worktree has no pause command configured";
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        try {
          await worktreeClient.resourceAction(targetWorktreeId, "pause");
        } catch (err) {
          notifyWorktreeResourceError(err, "Pause failed", "Resource pause failed");
        }
      },
    })
  );

  actions.set("worktree.resource.status", () =>
    defineAction({
      id: "worktree.resource.status",
      title: "Check Resource Status",
      description: "Check the status of the resource associated with a worktree",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) throw new Error("Worktree not found");
        if (!worktree.hasStatusCommand) {
          return { configured: false, status: null } as const;
        }
        try {
          await worktreeClient.resourceAction(targetWorktreeId, "status");
        } catch (err) {
          notifyWorktreeResourceError(err, "Status check failed", "Resource status check failed");
        }
        const updated = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        return { configured: true, status: updated?.resourceStatus ?? null } as const;
      },
    })
  );

  actions.set("worktree.resource.connect", () =>
    defineAction({
      id: "worktree.resource.connect",
      title: "Connect to Resource",
      description: "Open a terminal session connected to the worktree's remote resource",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      isEnabled: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return false;
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        return !!worktree?.resourceConnectCommand;
      },
      disabledReason: (ctx: ActionContext) => {
        const worktreeId = ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!worktreeId) return "No worktree selected";
        const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
        if (!worktree?.resourceConnectCommand)
          return "Worktree has no resource connect command configured";
        return undefined;
      },
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) throw new Error("No worktree selected");
        const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
        if (!worktree) throw new Error("Worktree not found");
        const connectCommand = worktree.resourceConnectCommand;
        if (!connectCommand)
          throw new Error("No resource connect command configured for this worktree");

        await callbacks.onAddTerminal({
          kind: "terminal",
          cwd: worktree.path,
          command: connectCommand,
          title: `Connect: ${worktree.name}`,
          location: "grid",
          worktreeId: targetWorktreeId,
        });
      },
    })
  );
}
