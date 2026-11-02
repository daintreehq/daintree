import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionSource } from "@shared/types/actions";
import { z } from "zod";
import { PanelCloseResultSchema } from "@shared/types/panelClose";
import { RunGenerationArgSchema } from "@shared/types/assistantControl";
import { flushOptimisticCloses, requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { usePanelStore } from "@/store/panelStore";
import { isEphemeralPanel } from "@/store/slices/panelRegistry/panelCount";
import { requireExplicitTerminalIdForAgentDispatch } from "./terminalTargetBinding";
import { isForegroundDispatch } from "./dispatchSource";
import { PanelPlacementResultSchema, throwTerminalMiss } from "./terminalPlacement";
import { TerminalRestoredSchema } from "./schemas";
import {
  RestartOnPresetArgsSchema,
  SetHoldOnRestartArgsSchema,
  StartHeldArgsSchema,
  TerminalKillBatchArgsSchema,
} from "./terminalLifecycleActionArgs";
import type { TerminalLifecycleActionRunId } from "./terminalLifecycleActions.impl";

const RestartOnPresetResultSchema = z.object({
  terminalId: z.string().describe("The pane, respawned in place."),
  agentPresetId: z.string().describe("Preset it now runs on."),
  agentSessionIdCleared: z
    .literal(true)
    .describe("A new conversation started: re-send anything the agent still needs."),
});

/**
 * What one batch kill did, per target.
 *
 * Buckets rather than a count, because the causes need different responses from
 * the caller and a bare success hides all of them: an excluded id was refused by
 * a human and must never be retried, a missing one was already gone, and a
 * skipped one is still alive and still working. Every id the call asked for
 * lands in exactly one bucket, in the order it was requested.
 */
const TerminalKillBatchResultSchema = z.object({
  killedIds: z
    .array(z.string())
    .describe("The panels this call destroyed. Their processes and scrollback are gone."),
  excludedIds: z
    .array(z.string())
    .describe(
      "Unchecked by the approver. A human refusal of these exact targets, not a transient failure: never retry them or re-ask on their behalf."
    ),
  notFoundIds: z
    .array(z.string())
    .describe(
      "No panel with this id existed when the kill ran. Already gone rather than spared; nothing to retry."
    ),
  skippedIds: z
    .array(z.string())
    .describe(
      "Started running an agent after the confirmation froze, so the approval described an idle panel these no longer are. Untouched and still working; check what the agent is doing before asking again."
    ),
  failedIds: z
    .array(z.string())
    .describe(
      "The teardown errored, so whether the panel survived is unknown. Check the listing; the rest of the batch still ran."
    ),
});

/**
 * Which of `ids` have actually left the open roster, read after the canonical
 * teardown ran. `trashPanel` keeps the record and moves it to `location:
 * "trash"`, but remove-on-exit and dialog panels bypass trash entirely and are
 * removed outright, so a missing record counts as closed too.
 */
function closedPanelIds(ids: readonly string[]): string[] {
  const { panelsById } = usePanelStore.getState();
  return ids.filter((id) => {
    if (!Object.hasOwn(panelsById, id)) return true;
    return panelsById[id]?.location === "trash";
  });
}

/**
 * Resolve a close before returning when nobody is watching the screen.
 *
 * The optimistic coordinator defers the canonical teardown past paint, which is
 * right for a click and wrong for an automated caller: it has no frame to
 * protect and it reads the roster straight after the ack, so a deferred commit
 * hands back the panel it just closed (#11805). Flushing drains *every* queued
 * close rather than just this one — the same trade `terminal.reopenLast`
 * already makes, and the reason a duplicate close still resolves truthfully:
 * `requestPanelClose` drops it as already-closing, but the flush commits the
 * earlier request that owns it.
 */
function settleCloseForDispatch(ids: readonly string[], ctx: { dispatchSource?: ActionSource }) {
  if (isForegroundDispatch(ctx?.dispatchSource)) {
    // The commit is still queued, so this names what was accepted for close.
    // A person watching the grid is the real feedback channel here.
    return { closedIds: [...ids] };
  }
  flushOptimisticCloses();
  return { closedIds: closedPanelIds(ids) };
}

/**
 * Run bodies load on first dispatch (#14273). Every view registers these at
 * boot for menus, keybindings and the MCP manifest, but an empty view runs
 * none of them. A failed chunk load rejects inside `run`, which ActionService
 * turns into an error result like any other failure.
 */
async function runTerminalLifecycleAction(
  id: TerminalLifecycleActionRunId,
  args: unknown,
  ctx: ActionContext
): Promise<unknown> {
  // The focus fallback is read at the keystroke, before the load: focus can
  // move while the chunk resolves, and a kill must not land on the new pane.
  const focusedAtDispatch = usePanelStore.getState().focusedId;
  const { terminalLifecycleActionRuns } = await import("./terminalLifecycleActions.impl");
  return terminalLifecycleActionRuns[id](args, ctx, focusedAtDispatch);
}

export function registerTerminalLifecycleActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.close", () => ({
    id: "terminal.close",
    title: "Close terminal",
    description:
      "Close a terminal or any other panel, usually to the trash, where it stays briefly recoverable; remove-on-exit and dialog panels are discarded outright. Name the panel: the wrong one discards someone's work. An untracked panel is rejected; the result names what closed.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "hide", "dismiss", "remove"],
    argsSchema: z
      .object({
        terminalId: z
          .string()
          .optional()
          .describe(
            "Panel `id` from the terminal listing. Automated callers must pass it; omitted, the focused panel closes."
          ),
      })
      .optional(),
    resultSchema: PanelCloseResultSchema,
    mcpOutputSchema: true,
    // Eager, unlike most runs here: the target is read from focus at the
    // keystroke, and the optimistic hide advances focus synchronously so a
    // rapid Cmd+W stream keeps closing fresh panels. A chunk load in between
    // could close whatever focus moved to instead.
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      // Guard before the store read: this chain falls past focus all the way to
      // "any visible panel", so an unbound agent call would trash something
      // essentially at random.
      requireExplicitTerminalIdForAgentDispatch("terminal.close", terminalId, ctx);
      const state = usePanelStore.getState();
      // A named panel that isn't tracked is a caller mistake, not a no-op:
      // `trashPanel` ignores an unknown id silently, so without this the call
      // reports success for a typo (#11805). `Object.hasOwn` rather than a
      // truthiness check: `panelsById` is a plain object, so an id like
      // "constructor" would otherwise resolve off the prototype and get trashed
      // as if it were a real panel.
      if (terminalId !== undefined && !Object.hasOwn(state.panelsById, terminalId)) {
        return throwTerminalMiss("terminal.close", terminalId);
      }
      const targetId =
        terminalId ??
        state.focusedId ??
        state.panelIds.find(
          (id) =>
            state.panelsById[id]?.location !== "trash" &&
            state.panelsById[id]?.location !== "background"
        );
      if (!targetId) return { closedIds: [] };
      const target = Object.hasOwn(state.panelsById, targetId)
        ? state.panelsById[targetId]
        : undefined;
      // A stale `focusedId`, or a panel already trashed. Re-trashing resets the
      // recovery TTL and rewrites the recorded restore location, so leave it be
      // and report that nothing closed.
      if (!target || target.location === "trash") return { closedIds: [] };
      // Optimistic close: hide the panel now, trash it after the removal has
      // painted. The coordinator advances focus synchronously so a rapid Cmd+W
      // stream keeps closing fresh panels instead of re-targeting this one.
      requestPanelClose({
        hideIds: [targetId],
        commit: () => usePanelStore.getState().trashPanel(targetId),
      });
      return settleCloseForDispatch([targetId], ctx);
    },
  }));

  // Registered here purely for manifest metadata — schema, description, tier
  // and audit registration. Execution lives in the MCP CallTool handler
  // (electron/services/mcp-server/sessionServer.ts) because the authorization
  // it needs is session state: the ownership ledger is keyed by MCP session id,
  // which the renderer cannot see and must never be told. Main checks ownership
  // first, then delegates to `terminal.close` for the actual close, so trash
  // recovery and the "reports the exact panel closed" contract are the ones
  // already shipped rather than a second implementation (#11909). `run()`
  // throws if the renderer ever invokes it directly.
  actions.set("terminal.closeOwned", () => ({
    id: "terminal.closeOwned",
    title: "Close owned terminal",
    description:
      "Close a panel this session created, usually to the trash, where it stays briefly recoverable. Panels opened by the user, another client or a plugin are refused, as are unknown ids. The result names what closed.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "dismiss", "cleanup", "owned"],
    // Hidden from the palette: it is dispatchable only through the MCP
    // main-process path, so a user picking it here would get the `run()` throw
    // below rather than a closed panel. `terminal.close` is the palette's
    // version of this.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe(
          "Panel `id` this session got when creating it. Required; there is no focus fallback."
        ),
    }),
    resultSchema: PanelCloseResultSchema,
    mcpOutputSchema: true,
    run: async () => {
      throw new Error(
        "terminal.closeOwned must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  // Registered here for manifest metadata only, for the same reason as
  // `terminal.closeOwned` above: the authorization is the ownership ledger,
  // which is main-process session state the renderer cannot see. Main checks
  // ownership, then delegates to `pilot.openRun` — the shipped operation that
  // switches the workspace and carries a one-shot focus intent the incoming
  // view applies once it has hydrated — so this tool reveals a panel exactly
  // the way clicking its row in the agent overview does (#12315).
  //
  // Deliberately NOT `panel.focus` on the external tier, which is the shape
  // that looks equivalent and is not. `rendererBridge` resolves a bound
  // workspace without attaching, thawing, activating, focusing or switching
  // anything, so `panel.focus` aimed at a workspace nobody is watching selects
  // a panel inside a cached view, moves DOM focus where it cannot be seen, and
  // returns success.
  actions.set("terminal.revealOwned", () => ({
    id: "terminal.revealOwned",
    title: "Reveal owned terminal",
    description:
      "Bring the user to a panel this session created or was handed (right-click > Hand to orchestrator), switching workspace and raising the window if needed. No other panel can be revealed. Use it when the user asked to be taken there, not to report progress.",
    category: "terminal",
    kind: "command",
    // Reversible navigation: nothing is destroyed and the user can switch back.
    // The band is also load-bearing for reachability — `isWithheldFromBoundSession`
    // withholds `confirm` entries from a workspace-bound external session, which
    // is precisely the caller this tool exists for.
    danger: "safe",
    scope: "renderer",
    keywords: ["focus", "attach", "show", "owned"],
    // Hidden for the same reason as `terminal.closeOwned`: only the MCP
    // main-process path can reach it, so a user picking it from the palette
    // would get the `run()` throw below. `pilot.openRun` is what the agent
    // overview dispatches.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      terminalId: z.string().min(1).describe("Panel `id` this session created or was handed."),
      generation: RunGenerationArgSchema,
    }),
    run: async () => {
      throw new Error(
        "terminal.revealOwned must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("terminal.trash", () => ({
    id: "terminal.trash",
    title: "Trash terminal",
    description: "Move terminal to trash",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.trash", args, ctx),
  }));

  actions.set("terminal.background", () => ({
    id: "terminal.background",
    title: "Send to background",
    description:
      "Hide a terminal from view while keeping its process alive; a grouped panel takes its group along. A panel not in this view, or one in the trash, an overlay or a dialog, is refused. The result names where the panel is now.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hide", "minimize", "stash", "park"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    resultSchema: PanelPlacementResultSchema,
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.background", args, ctx),
  }));

  actions.set("terminal.kill", () => ({
    id: "terminal.kill",
    title: "Kill terminal",
    description:
      "Permanently destroy a panel of any kind and its process: no trash, no recovery. A panel running an agent session is left alone unless confirmed, and the call then fails. Name the panel explicitly; close it instead when recovery matters.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale: "Permanently kills the PTY process. Scrollback and session state are lost.",
    keywords: ["terminate", "stop", "remove", "delete"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          "Confirms losing a running agent session; redundant once the host prompted. Otherwise the panel is left alone, a confirmation is staged and the call fails."
        ),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.kill", args, ctx),
  }));

  actions.set("terminal.killBatch", () => ({
    id: "terminal.killBatch",
    title: "Kill terminals",
    description:
      "Permanently destroy several named panels and their processes at once, with no trash step and no recovery. Raises one confirmation listing every target, each separately deselectable — one prompt for the whole batch rather than one per panel. Reports each id on its own: destroyed, deselected by the approver, already gone, newly busy, or errored.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently kills every named PTY process. Scrollback and session state are lost for each one.",
    keywords: ["terminate", "stop", "remove", "delete", "batch", "bulk"],
    // Hidden from the palette: it acts only on ids an automated caller supplies,
    // and its confirmation is the host modal the MCP bridge raises. A user
    // picking it here would have nothing to name; `terminal.kill` and
    // `terminal.killAll` are the palette's versions.
    palette: { mode: "hidden" },
    argsSchema: TerminalKillBatchArgsSchema,
    resultSchema: TerminalKillBatchResultSchema,
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.killBatch", args, ctx),
  }));

  actions.set("terminal.restart", () => ({
    id: "terminal.restart",
    title: "Restart terminal",
    description:
      "Restart a terminal's process in place, keeping the pane. Returns before the restart finishes; watch its status before sending. A running agent session is left alone unless confirmed; otherwise whatever ran is killed and unsaved state lost. Fails on a held pane.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts the terminal process. Scrollback is lost and the process is re-spawned.",
    keywords: ["relaunch", "reset", "rerun", "process"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          "Confirms interrupting a running agent session; redundant once the host prompted. Otherwise the terminal is untouched, a confirm is staged and the call fails."
        ),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.restart", args, ctx),
  }));

  // The MCP way out of a restore hold (#15270): a held pane has no process for
  // terminal.restart to restart, and launching a replacement beside it leaves
  // the original waiting in the grid. Confirm-gated, because which conversation
  // a held pane continues is the user's call (#12434).
  actions.set("terminal.startHeld", () => ({
    id: "terminal.startHeld",
    title: "Start held pane",
    description:
      "Start a held pane in place under its id, instead of launching a replacement beside it. Only the conversation its hold recorded can be resumed. Returns once the launch is queued; watch its status before sending.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Starts the held agent, resuming its recorded conversation or beginning a new one: the choice restore left to you.",
    keywords: ["resume", "recover", "held", "restore"],
    // Needs a held pane's id and a choice the palette has no way to ask for;
    // the pane carries its own buttons for both.
    palette: { mode: "hidden" },
    argsSchema: StartHeldArgsSchema,
    resultSchema: z.object({
      terminalId: z.string(),
      start: z.enum(["resume", "fresh"]),
      sessionId: z.string().optional().describe("The conversation asked for, on resume."),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.startHeld", args, ctx),
  }));

  actions.set("terminal.restartOnPreset", () => ({
    id: "terminal.restartOnPreset",
    title: "Restart agent on preset",
    description:
      "Respawn an agent terminal in place on another preset of the same agent. Always starts a new conversation and discards the scrollback, so it runs only when confirmed.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Ends the agent's conversation and respawns it on another preset. Scrollback is lost.",
    keywords: ["preset", "account", "switch", "relaunch", "rate limit"],
    // Needs a preset the palette has no way to ask for; the pane menu and the
    // rate-limit chip carry their own picker and confirm.
    palette: { mode: "hidden" },
    argsSchema: RestartOnPresetArgsSchema,
    resultSchema: RestartOnPresetResultSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.restartOnPreset", args, ctx),
  }));

  // Manifest-only, executed in the MCP main process like `terminal.closeOwned`
  // (#14369): main checks the session launched the pane, then dispatches
  // `terminal.restartOnPreset` with the preset alone, never `confirmed`, so the
  // approval is the host's prompt, grant or skip preference and not the model's.
  // `danger: "confirm"` matches the delegate: the conversation ends either way.
  actions.set("terminal.restartOnPresetOwned", () => ({
    id: "terminal.restartOnPresetOwned",
    title: "Move owned agent to another preset",
    description:
      "Respawn an agent panel this session launched on another preset of its agent, in place, after the user confirms: for an agent that hit a plan limit. Its conversation and scrollback are lost. Panels it was handed are refused.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    denyPluginDispatch: true,
    scope: "renderer",
    dangerRationale:
      "Ends the agent's conversation and respawns it on another preset. Scrollback is lost.",
    keywords: ["preset", "account", "rate limit", "owned"],
    // Hidden for the same reason as `terminal.closeOwned`: only the MCP
    // main-process path can reach it.
    palette: { mode: "hidden" },
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe("Panel `id` this session got when launching it. Required."),
      presetId: z.string().min(1).describe("A preset `id` of the panel's own agent."),
    }),
    resultSchema: RestartOnPresetResultSchema,
    mcpOutputSchema: true,
    run: async () => {
      throw new Error(
        "terminal.restartOnPresetOwned must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("terminal.redraw", () => ({
    id: "terminal.redraw",
    title: "Redraw terminal",
    description: "Redraw terminal display to fix visual corruption",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["refresh", "render", "repair", "display"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.redraw", args, ctx),
  }));

  actions.set("terminal.rename", () => ({
    id: "terminal.rename",
    title: "Rename terminal",
    description:
      "Set a terminal tab's title, or clear it to the default. Pass the terminal and the title: an omitted title opens a dialog an automated caller cannot answer. Returns the title now shown; `applied` is false when a title the user set by hand kept its place.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["title", "label", "name", "edit"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      name: z.string().optional().describe("New title; omitted, opens the rename dialog."),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.rename", args, ctx),
  }));

  actions.set("terminal.viewInfo", () => ({
    id: "terminal.viewInfo",
    title: "View terminal info",
    description: "View detailed terminal information",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["details", "metadata", "inspect", "status"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.viewInfo", args, ctx),
  }));

  actions.set("terminal.info.open", () => ({
    id: "terminal.info.open",
    title: "Open terminal info",
    description: "Open terminal info dialog",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["details", "metadata", "inspect", "status"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.info.open", args, ctx),
  }));

  actions.set("terminal.info.get", () => ({
    id: "terminal.info.get",
    title: "Get terminal info",
    description: "Get detailed terminal information for a terminal",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    resultSchema: z.object({
      id: z.string(),
      projectId: z.string().optional(),
      worktreeId: z.string().optional(),
      kind: z.string().optional(),
      launchAgentId: z.string().optional(),
      title: z.string().optional(),
      // Both are read straight off the payload by TerminalInfoDialog —
      // `resizeStrategy` drives its Resize Strategy row, which would otherwise
      // report "default" for every settled TUI agent once dispatch starts
      // stripping undeclared fields (#11539). Declared as strings rather than
      // enums to match `kind`/`agentState`/`activityTier` above: these values
      // come off persisted panel data, and a stale spelling should degrade the
      // one field, not fail the whole read.
      titleMode: z.string().optional().describe("'default', 'custom' or 'user'"),
      resizeStrategy: z
        .string()
        .optional()
        .describe("'default' (immediate) or 'settled' (batched for TUI agents)"),
      cwd: z.string(),
      shell: z.string().optional(),
      command: z.string().optional(),
      agentState: z.string().optional(),
      // The process measurements below are absent for a pane restore held
      // (#14017): it has no process, and zeros would read as real values.
      spawnedAt: z.number().optional(),
      lastInputTime: z.number().optional(),
      lastOutputTime: z.number().optional(),
      lastStateChange: z.number().optional(),
      activityTier: z.string().optional(),
      outputBufferSize: z.number().optional(),
      semanticBufferLines: z.number().optional(),
      restartCount: z.number().optional(),
      agentIncarnation: z.number().int().nonnegative().optional(),
      hasPty: z.boolean().optional(),
      agentSessionId: z.string().optional(),
      detectedAgentId: z.string().optional(),
      analysisEnabled: z.boolean().optional(),
      ptyPid: z.number().optional(),
      ptyCols: z.number().optional(),
      ptyRows: z.number().optional(),
      ptyForegroundProcess: z.string().optional(),
      ptyTty: z.string().optional(),
      spawnArgs: z.array(z.string()).optional(),
      agentLaunchFlags: z.array(z.string()).optional(),
      agentModelId: z.string().optional(),
      agentPresetId: z.string().optional(),
      agentPresetColor: z.string().optional(),
      originalAgentPresetId: z.string().optional(),
      exitCode: z.number().optional(),
      everDetectedAgent: z.boolean().optional(),
      restored: TerminalRestoredSchema.optional(),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.info.get", args, ctx),
  }));

  // The plugin-side half of "Resume agents after restart" (#13509, #14017): a
  // plugin that knows its run is over can keep the pane from resuming without
  // the user changing a setting that covers every agent.
  actions.set("terminal.setHoldOnRestart", () => ({
    id: "terminal.setHoldOnRestart",
    title: "Hold agent on restart",
    description:
      "Plugins only: hold or release one of this plugin's own agent terminals on restart. A held terminal comes back without starting, whatever the resume setting; the user starting it clears the hold.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: { mode: "hidden" },
    mcpVisibility: "hidden",
    argsSchema: SetHoldOnRestartArgsSchema,
    resultSchema: z.object({ terminalId: z.string(), holdOnRestart: z.boolean() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.setHoldOnRestart", args, ctx),
  }));

  actions.set("terminal.toggleInputLock", () => ({
    id: "terminal.toggleInputLock",
    title: "Toggle input lock",
    description: "Toggle terminal input lock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["readonly", "typing", "disable", "keyboard"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.toggleInputLock", args, ctx),
  }));

  actions.set("terminal.forceResume", () => ({
    id: "terminal.forceResume",
    title: "Force resume",
    description: "Force resume an agent terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["wake", "unstick", "unpause", "stuck"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.forceResume", args, ctx),
  }));

  actions.set("terminal.closeAll", () => ({
    id: "terminal.closeAll",
    title: "Close all terminals",
    description:
      "Close every panel in the active worktree, not just terminals, including the user's shells and other agents' terminals; prefer closing individually. Most go to the trash; remove-on-exit panels are discarded. Internal and dialog panels are spared.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "hide", "clear", "cleanup"],
    resultSchema: PanelCloseResultSchema,
    mcpOutputSchema: true,
    // Eager for the same reason as terminal.close: "the active worktree" is
    // the one at the keystroke, not the one after a chunk load.
    run: async (_args: unknown, ctx) => {
      const state = usePanelStore.getState();
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      // Skip tooling-internal panels — the Daintree Assistant's own dock
      // terminal shouldn't get swept up by a "close all" command.
      const idsToClose = state.panelIds.filter((id) => {
        const t = state.panelsById[id];
        if (!t) return false;
        const isToolingInternal = isEphemeralPanel(t);
        return (
          !isToolingInternal &&
          t.location !== "trash" &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
      });
      if (idsToClose.length === 0) return { closedIds: [] };
      requestPanelClose({
        hideIds: idsToClose,
        commit: () => {
          const latest = usePanelStore.getState();
          idsToClose.forEach((id) => latest.trashPanel(id));
        },
      });
      return settleCloseForDispatch(idsToClose, ctx);
    },
  }));

  actions.set("terminal.killAll", () => ({
    id: "terminal.killAll",
    title: "Kill all terminals",
    description:
      "Permanently destroy every panel in the project, across all worktrees and kinds, including trashed and backgrounded, with no trash step and no recovery. It takes the user's own shells and other agents' work with it; only tooling-internal and dialog-hosted panels are spared. While an agent session runs it destroys nothing unless the call is confirmed. Automated callers should never need this.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently kills every user-facing terminal. All scrollback and session state are lost.",
    keywords: ["terminate", "stop", "remove", "delete"],
    argsSchema: z
      .object({
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "Acknowledges losing every running agent session. Redundant once the host has prompted for approval. Without either, nothing is destroyed, a confirmation is staged, and the call fails rather than reporting success."
          ),
      })
      .optional(),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.killAll", args, ctx),
  }));

  actions.set("terminal.restartAll", () => ({
    id: "terminal.restartAll",
    title: "Restart all terminals",
    description: "Restart all terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts every non-trash terminal. All scrollback is lost across all terminals.",
    keywords: ["relaunch", "reset", "rerun", "processes"],
    argsSchema: z.object({ confirmed: z.boolean().optional() }).optional(),
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.restartAll", args, ctx),
  }));

  actions.set("terminal.restartService", () => ({
    id: "terminal.restartService",
    title: "Restart terminal service",
    description: "Restart the PTY host. Available only when the terminal backend is disconnected.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["pty", "backend", "recover", "host"],
    isEnabled: () => usePanelStore.getState().backendStatus === "disconnected",
    disabledReason: () => {
      if (usePanelStore.getState().backendStatus !== "disconnected") {
        return "Terminal backend is connected";
      }
      return undefined;
    },
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.restartService", args, ctx),
  }));

  actions.set("terminal.watch", () => ({
    id: "terminal.watch",
    title: "Watch this terminal",
    description:
      "Toggle a one-shot watch — notifies when the agent completes, exits, or waits for input.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["monitor", "observe", "notify", "alert"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    isEnabled: (ctx) => !!ctx.focusedTerminalId,
    disabledReason: (ctx) => {
      if (!ctx.focusedTerminalId) {
        return "No focused terminal to watch";
      }
      return undefined;
    },
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalLifecycleAction("terminal.watch", args, ctx),
  }));
}
