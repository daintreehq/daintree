import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { WorktreeResourceStatus } from "@shared/types/worktree";
import { worktreeClient } from "@/clients";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { TerminalSpawnSourceSchema, AddPanelFocusPolicySchema } from "./schemas";

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

const worktreeResourceStatusSchema = z.object({
  lastStatus: z.string().optional(),
  lastOutput: z.string().optional(),
  error: z.string().optional(),
  lastCheckedAt: z.number().optional(),
  endpoint: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  provider: z.string().optional(),
  resumedAt: z.number().optional(),
  pausedAt: z.number().optional(),
}) satisfies z.ZodType<WorktreeResourceStatus>;

/**
 * Kept a plain object rather than a discriminated union on `configured`: zod
 * emits a union as a top-level `oneOf` with no `type: "object"`, and
 * `buildToolOutputSchema` drops any schema that isn't an object type — so the
 * union would silently publish nothing. The description carries the stronger
 * configured/status relationship instead.
 */
const worktreeResourceStatusResultSchema = z.object({
  configured: z.boolean(),
  status: worktreeResourceStatusSchema.nullable(),
});

export function registerWorktreeResourceActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.resource.provision", () =>
    defineAction({
      id: "worktree.resource.provision",
      title: "Provision Resource",
      description:
        "Run the configured provisioning commands for a worktree's remote resource (e.g. spin up a cloud devbox). Args: `worktreeId` (optional) — a worktree id from `worktree.list`; defaults to the focused or active worktree. Returns no result on success. Errors when no worktree is selected or provisioning fails.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      mcpVisibility: "discoverable",
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
      selfNotifiesOnExecutionError: true,
      run: async (args, ctx: ActionContext) => {
        try {
          const worktreeId = args?.worktreeId;
          const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
          if (!targetWorktreeId) throw new Error("No worktree selected");
          await worktreeClient.resourceAction(targetWorktreeId, "provision");
        } catch (err) {
          notifyWorktreeResourceError(err, "Provision failed", "Resource provisioning failed");
          throw err;
        }
      },
    })
  );

  actions.set("worktree.resource.teardown", () =>
    defineAction({
      id: "worktree.resource.teardown",
      title: "Teardown Resource",
      description:
        "Run the configured teardown commands for a worktree's remote resource (e.g. destroy a cloud devbox). Args: `worktreeId` (optional) — a worktree id from `worktree.list`; defaults to the focused or active worktree. Destructive: recovery requires re-provisioning. Returns no result on success. Errors when no worktree is selected or teardown fails.",
      category: "worktree",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      mcpVisibility: "discoverable",
      dangerRationale:
        "Destroys the cloud resource associated with a worktree. Recovery requires re-provisioning.",
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
      selfNotifiesOnExecutionError: true,
      run: async (args, ctx: ActionContext) => {
        try {
          const worktreeId = args?.worktreeId;
          const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
          if (!targetWorktreeId) throw new Error("No worktree selected");
          await worktreeClient.resourceAction(targetWorktreeId, "teardown");
        } catch (err) {
          notifyWorktreeResourceError(err, "Teardown failed", "Resource teardown failed");
          throw err;
        }
      },
    })
  );

  actions.set("worktree.resource.resume", () =>
    defineAction({
      id: "worktree.resource.resume",
      title: "Resume Resource",
      description:
        "Run the configured resume commands for a worktree's paused remote resource. Args: `worktreeId` (optional) — a worktree id from `worktree.list`; defaults to the focused or active worktree. Returns no result on success. Errors when no worktree is selected or resume fails.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      mcpVisibility: "discoverable",
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
      selfNotifiesOnExecutionError: true,
      run: async (args, ctx: ActionContext) => {
        try {
          const worktreeId = args?.worktreeId;
          const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
          if (!targetWorktreeId) throw new Error("No worktree selected");
          await worktreeClient.resourceAction(targetWorktreeId, "resume");
        } catch (err) {
          notifyWorktreeResourceError(err, "Resume failed", "Resource resume failed");
          throw err;
        }
      },
    })
  );

  actions.set("worktree.resource.pause", () =>
    defineAction({
      id: "worktree.resource.pause",
      title: "Pause Resource",
      description:
        "Run the configured pause commands for a worktree's remote resource (e.g. stop a cloud devbox to save cost). Args: `worktreeId` (optional) — a worktree id from `worktree.list`; defaults to the focused or active worktree. Returns no result on success. Errors when no worktree is selected or pause fails.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      mcpVisibility: "discoverable",
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
      selfNotifiesOnExecutionError: true,
      run: async (args, ctx: ActionContext) => {
        try {
          const worktreeId = args?.worktreeId;
          const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
          if (!targetWorktreeId) throw new Error("No worktree selected");
          await worktreeClient.resourceAction(targetWorktreeId, "pause");
        } catch (err) {
          notifyWorktreeResourceError(err, "Pause failed", "Resource pause failed");
          throw err;
        }
      },
    })
  );

  actions.set("worktree.resource.status", () =>
    defineAction({
      id: "worktree.resource.status",
      title: "Check Resource Status",
      description:
        "Run the configured status command for a worktree's remote resource and report the result. Args: `worktreeId` (optional) — a worktree id from `worktree.list` (the `id` field); defaults to the focused or active worktree. Returns `{ configured: false, status: null }` when no status command is configured; otherwise `{ configured: true, status }`, where `status` is the resulting resource-status object or null. The status object may include `lastStatus`, `lastOutput`, `error`, `lastCheckedAt`, `endpoint`, `meta`, `provider`, `resumedAt`, and `pausedAt`. Errors when no worktree is selected, the worktree is not found, or the status command fails; failures never return cached status.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z
            .string()
            .optional()
            .describe(
              "Worktree id from `worktree.list` (the `id` field). Defaults to the focused or active worktree."
            ),
        })
        .optional(),
      resultSchema: worktreeResourceStatusResultSchema,
      mcpOutputSchema: true,
      selfNotifiesOnExecutionError: true,
      // The whole body sits inside the try so a failed status command can never
      // fall through to the store re-read below it — that read returns the
      // *previous* check's cached value, which a caller can't distinguish from
      // a fresh one. Failure now rejects instead (#11533).
      run: async (args, ctx: ActionContext) => {
        try {
          const worktreeId = args?.worktreeId;
          const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
          if (!targetWorktreeId) throw new Error("No worktree selected");
          const worktree = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
          if (!worktree) throw new Error("Worktree not found");
          if (!worktree.hasStatusCommand) {
            return { configured: false, status: null } as const;
          }
          await worktreeClient.resourceAction(targetWorktreeId, "status");
          const updated = getCurrentViewStore().getState().worktrees.get(targetWorktreeId);
          return { configured: true, status: updated?.resourceStatus ?? null } as const;
        } catch (err) {
          notifyWorktreeResourceError(err, "Status check failed", "Resource status check failed");
          throw err;
        }
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
      argsSchema: z
        .object({
          worktreeId: z.string().optional(),
          spawnedBy: TerminalSpawnSourceSchema.optional(),
          focusPolicy: AddPanelFocusPolicySchema.optional(),
        })
        .optional(),
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
        const spawnedBy = args?.spawnedBy;
        const focusPolicy = args?.focusPolicy;
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
          spawnedBy,
          focusPolicy,
        });
      },
    })
  );
}
