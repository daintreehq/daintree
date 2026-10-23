import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { idArgSchema, saveNamedFleetSchema } from "./fleetActionArgs";
import type { FleetActionRunId } from "./fleetActions.impl";

const confirmedArgsSchema = z.object({ confirmed: z.boolean().optional() }).optional();

// Mirrors `FleetRunTarget` (src/store/fleetRunStore.ts) plus a live-derived
// `lastCheckResult` (same shape as TerminalStatusEntrySchema's — parsed
// check summary, not an exit code). Advertised as the MCP outputSchema.
const fleetRunTargetStatusSchema = z.object({
  terminalId: z.string(),
  title: z.string(),
  worktreeId: z.string().nullable(),
  submission: z.enum(["pending", "sent", "failed", "skipped"]),
  failureKind: z.enum(["permanent", "transient"]).optional(),
  failureReason: z.string().optional(),
  agentState: z.string().nullable(),
  waitingReason: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  settled: z.boolean(),
  gone: z.boolean(),
  lastCheckResult: z
    .object({
      command: z.string().nullable(),
      passed: z.boolean(),
      ranAt: z.number(),
      failureSummary: z.string().nullable(),
      truncated: z.boolean(),
    })
    .optional(),
});

const fleetRunStatusResultSchema = z.object({
  run: z
    .object({
      runId: z.string(),
      status: z.enum(["submitting", "watching", "completed", "cancelled", "failed", "superseded"]),
      isRetry: z.boolean(),
      draftPreview: z.string(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      counts: z.object({
        total: z.number().int(),
        sent: z.number().int(),
        sendFailed: z.number().int(),
        skipped: z.number().int(),
        working: z.number().int(),
        waiting: z.number().int(),
        done: z.number().int(),
      }),
      targets: z.array(fleetRunTargetStatusSchema),
    })
    .nullable(),
  armedCount: z.number().int(),
});

/**
 * Run bodies load on first dispatch (#14272). Every view registers the fleet
 * actions at boot for menus, keybindings and the MCP manifest, but an empty
 * view runs none of them. A failed chunk load rejects inside `run`, which
 * ActionService turns into an error result like any other failure.
 */
async function runFleetAction(
  id: FleetActionRunId,
  args: unknown,
  ctx: ActionContext
): Promise<unknown> {
  const { fleetActionRuns } = await import("./fleetActions.impl");
  return fleetActionRuns[id](args, ctx);
}

export function registerFleetActions(actions: ActionRegistry): void {
  actions.set("fleet.accept", () => ({
    id: "fleet.accept",
    // Armed-fleet hotkey actions operate on the live armed/waiting snapshot and
    // no-op when nothing is armed. They're keybinding/Fleet-UI driven, not
    // palette commands.
    palette: { mode: "hidden" },
    title: "Fleet: accept",
    description:
      "Send 'y' + Enter to every armed agent that is waiting for input (accepts [y/N] prompts)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects keystrokes into agent terminals — closed to plugin dispatch so it
    // can't be an end-run around the `agent:input` capability (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.accept", args, ctx),
  }));

  actions.set("fleet.reject", () => ({
    id: "fleet.reject",
    palette: { mode: "hidden" },
    title: "Fleet: reject",
    description:
      "Send 'n' + Enter to every armed agent that is waiting for input (rejects [y/N] prompts; confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects keystrokes into agent terminals — closed to plugin dispatch (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.reject", args, ctx),
  }));

  actions.set("fleet.interrupt", () => ({
    id: "fleet.interrupt",
    palette: { mode: "hidden" },
    title: "Fleet: interrupt",
    description:
      "Send double-Escape to armed working/waiting full agent terminals. Confirms when 3+ targets.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Injects control keystrokes into agent terminals — closed to plugin dispatch (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: confirmedArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.interrupt", args, ctx),
  }));

  actions.set("fleet.restart", () => ({
    id: "fleet.restart",
    palette: { mode: "hidden" },
    title: "Fleet: restart",
    description: "Restart every armed agent terminal (always requires confirmation)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts every armed agent terminal. All scrollback and session state are lost.",
    argsSchema: confirmedArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.restart", args, ctx),
  }));

  actions.set("fleet.kill", () => ({
    id: "fleet.kill",
    palette: { mode: "hidden" },
    title: "Fleet: kill",
    description:
      "Remove every armed terminal panel. This destroys those terminals with no trash step: their running processes and scrollback are unrecoverable, though a journaled agent session can still be resumed afterwards. It always requires confirmation.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Removes every armed terminal panel. All scrollback and session state are lost.",
    argsSchema: confirmedArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.kill", args, ctx),
  }));

  actions.set("fleet.trash", () => ({
    id: "fleet.trash",
    palette: { mode: "hidden" },
    title: "Fleet: trash",
    description: "Move every armed terminal to trash (confirms when 5+ targets)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Moves every armed terminal to trash. Scrollback is lost for each trashed terminal.",
    argsSchema: confirmedArgsSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.trash", args, ctx),
  }));

  actions.set("fleet.scope.enter", () => ({
    id: "fleet.scope.enter",
    palette: { mode: "hidden" },
    title: "Fleet: enter scope mode",
    description:
      "Activate Fleet scope mode (primitive — gated by fleetScopeMode flag; no-op in legacy mode)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.scope.enter", args, ctx),
  }));

  actions.set("fleet.scope.exit", () => ({
    id: "fleet.scope.exit",
    palette: { mode: "hidden" },
    title: "Fleet: exit scope mode",
    description:
      "Exit Fleet scope mode, restoring the pre-scope active worktree (no-op in legacy mode)",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.scope.exit", args, ctx),
  }));

  actions.set("fleet.retryFailures", () => ({
    id: "fleet.retryFailures",
    palette: { mode: "hidden" },
    title: "Fleet: retry failed broadcast",
    description:
      "Re-fire the most recent broadcast against any panes that rejected it. No-op when no failures are recorded.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Re-broadcasts the last (arbitrary, often \r-terminated) payload into
    // terminals — closed to plugin dispatch so it can't inject commands (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.retryFailures", args, ctx),
  }));

  actions.set("fleet.armMatchingFilter", () => ({
    id: "fleet.armMatchingFilter",
    title: "Fleet: arm agents matching filter",
    description:
      "Arm all eligible agent terminals whose worktree is in the provided set — sidebar 'Arm N matching' affordance",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ worktreeIds: z.array(z.string()) }),
    run: (args: unknown, ctx: ActionContext) =>
      runFleetAction("fleet.armMatchingFilter", args, ctx),
  }));

  actions.set("fleet.armFocused", () => ({
    id: "fleet.armFocused",
    palette: { mode: "hidden" },
    title: "Fleet: toggle arm focused pane",
    description:
      "Toggle fleet membership on the focused terminal — keyboard equivalent of ⌘/⇧-clicking pane chrome",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.armFocused", args, ctx),
  }));

  actions.set("fleet.armAll", () => ({
    id: "fleet.armAll",
    title: "Fleet: arm all eligible",
    description: "Arm all fleet-eligible terminals in the current worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        scope: z.enum(["current", "all"]).optional().default("current"),
      })
      .optional(),
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.armAll", args, ctx),
  }));

  actions.set("fleet.saveNamedFleet", () => ({
    id: "fleet.saveNamedFleet",
    title: "Fleet: save named fleet",
    description:
      "Persist the current fleet selection (snapshot) or a state filter (predicate) under a name for later recall.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: saveNamedFleetSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.saveNamedFleet", args, ctx),
  }));

  actions.set("fleet.recallNamedFleet", () => ({
    id: "fleet.recallNamedFleet",
    title: "Fleet: recall named fleet",
    description:
      "Apply panes from a saved fleet. Snapshots drop missing IDs; predicates re-evaluate against current panes.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: idArgSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.recallNamedFleet", args, ctx),
  }));

  actions.set("fleet.getRunStatus", () => ({
    id: "fleet.getRunStatus",
    // Query with a structured result — nothing for a palette pick to show.
    palette: { mode: "hidden" },
    title: "Fleet: get run status",
    description:
      "Read the fleet broadcast the user is running, with per-terminal delivery and liveness. Observe only: it dispatches nothing. Agent state here is a passive heuristic and a parsed check result is not an exit code; confirm both before acting.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: fleetRunStatusResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.getRunStatus", args, ctx),
  }));

  actions.set("fleet.deleteNamedFleet", () => ({
    id: "fleet.deleteNamedFleet",
    title: "Fleet: delete named fleet",
    description: "Remove a saved fleet by id. Idempotent — unknown ids are silently ignored.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently deletes a saved fleet. The named fleet configuration cannot be recovered.",
    argsSchema: idArgSchema,
    run: (args: unknown, ctx: ActionContext) => runFleetAction("fleet.deleteNamedFleet", args, ctx),
  }));
}
