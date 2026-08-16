import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionSource } from "@shared/types/actions";
import { z } from "zod";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { flushOptimisticCloses, requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { fireWatchNotification } from "@/lib/watchNotification";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import {
  useTerminalPendingDestructiveActionStore,
  type TerminalPendingDestructiveActionKind,
} from "@/store/terminalPendingDestructiveActionStore";
import {
  collectRunningAgentTerminals,
  terminalHasRunningAgentSession,
} from "@/utils/destructiveSessionConfirm";
import { isEphemeralPanel } from "@/store/slices/panelRegistry/panelCount";
import { requireExplicitTerminalIdForAgentDispatch } from "./terminalTargetBinding";
import { isForegroundDispatch } from "./dispatchSource";

function parseConfirmed(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as { confirmed?: unknown }).confirmed === true;
}

function clearPendingIf(kind: TerminalPendingDestructiveActionKind): void {
  const pending = useTerminalPendingDestructiveActionStore.getState().pending;
  if (pending && pending.kind === kind) {
    useTerminalPendingDestructiveActionStore.getState().clear();
  }
}

const PanelCloseResultSchema = z.object({
  closedIds: z
    .array(z.string())
    .describe(
      "The panels this call closed. Empty means nothing closed: there was no panel to act on, the one named was already in the trash, or its teardown did not complete. Treat an empty array as a failed close rather than a quiet success."
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
export function registerTerminalLifecycleActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.close", () => ({
    id: "terminal.close",
    title: "Close Terminal",
    description:
      "Close a panel, usually moving it to the trash where it stays briefly recoverable before its process is killed. Recovery is not universal — panels set to remove on exit, and dialog panels, are discarded outright. This is not limited to terminals. Name the panel you mean; closing the wrong one discards someone's work. An untracked panel is rejected rather than reported closed, and the result names what actually closed — already gone from the listing when an automated caller sees it.",
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
            "The panel to close, as an `id` from the terminal listing. An automated caller must pass this; omitted, the close falls back to whatever the user has focused."
          ),
      })
      .optional(),
    resultSchema: PanelCloseResultSchema,
    mcpOutputSchema: true,
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
        throw new Error(
          `terminal.close: no panel with id "${terminalId}" — pass an \`id\` from the terminal listing.`
        );
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

  actions.set("terminal.trash", () => ({
    id: "terminal.trash",
    title: "Trash Terminal",
    description: "Move terminal to trash",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.trash", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const target = state.panelsById[targetId];
        if (target?.location === "grid" || target?.location === undefined) {
          requestPanelClose({
            hideIds: [targetId],
            commit: () => usePanelStore.getState().trashPanel(targetId),
          });
        } else {
          state.trashPanel(targetId);
        }
      }
    },
  }));

  actions.set("terminal.background", () => ({
    id: "terminal.background",
    title: "Send to Background",
    description: "Hide terminal from view while keeping its process alive",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hide", "minimize", "stash", "park"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      requireExplicitTerminalIdForAgentDispatch("terminal.background", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const group = state.getPanelGroup(targetId);
        if (group) {
          state.backgroundPanelGroup(targetId);
        } else {
          state.backgroundTerminal(targetId);
        }
      }
    },
  }));

  actions.set("terminal.kill", () => ({
    id: "terminal.kill",
    title: "Kill Terminal",
    description:
      "Permanently destroy a panel and any process behind it, with no trash step and no recovery. This is not limited to terminals — whatever panel the id names is removed. A panel running an agent session is left untouched unless the call itself is marked confirmed, so read back its state rather than assuming it went. Identify it explicitly: an automated caller cannot see what the user has focused. Close it instead when recoverability matters.",
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
          "Acknowledges losing a running agent session. Without it, a panel running an agent is left alone and a confirmation is staged for the user instead, so the call returns having changed nothing."
        ),
    }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      // Ahead of the pending-destructive request below: an unbound agent call
      // must not stage a confirm dialog asking the user to approve killing
      // whatever they happen to be looking at.
      requireExplicitTerminalIdForAgentDispatch("terminal.kill", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const terminal = state.panelsById[targetId];
      // Bare PTY stays D0 — only confirm when an agent session would lose
      // in-flight work. Mid-work is "working"; "waiting"/"directing" are
      // paused states where stopping is non-disruptive.
      if (!parseConfirmed(args) && terminalHasRunningAgentSession(terminal)) {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "kill",
          targetCount: 1,
          runningAgentCount: 1,
          terminalId: targetId,
        });
        return;
      }
      clearPendingIf("kill");
      state.removePanel(targetId);
    },
  }));

  actions.set("terminal.restart", () => ({
    id: "terminal.restart",
    title: "Restart Terminal",
    description:
      "Begin restarting a terminal's process in place, keeping the pane. This returns before the restart has finished, so the terminal is not ready yet when it does — watch its status before sending anything. A terminal running an agent session is left untouched unless the call itself is marked confirmed; otherwise whatever was running is terminated and unsaved in-process state is lost. A panel with no process is ignored rather than reported as an error.",
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
          "Acknowledges interrupting a running agent session. Without it, a terminal running an agent is left alone and a confirmation is staged for the user instead, so the call returns having changed nothing."
        ),
    }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      // See terminal.kill: guard before the confirm request is staged.
      requireExplicitTerminalIdForAgentDispatch("terminal.restart", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const terminal = state.panelsById[targetId];
      if (!parseConfirmed(args) && terminalHasRunningAgentSession(terminal)) {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "restart",
          targetCount: 1,
          runningAgentCount: 1,
          terminalId: targetId,
        });
        return;
      }
      clearPendingIf("restart");
      state.restartTerminal(targetId);
    },
  }));

  actions.set("terminal.redraw", () => ({
    id: "terminal.redraw",
    title: "Redraw Terminal",
    description: "Redraw terminal display to fix visual corruption",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["refresh", "render", "repair", "display"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      requireExplicitTerminalIdForAgentDispatch("terminal.redraw", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        // Only a PERSON gets the bypass (#11638). #10863's write-quiescence
        // deferral exists to stop an automatic out-of-band re-wrap landing
        // under a live cursor-relative repaint, and a busy agent never opens
        // the 300ms gap it waits for — so a human staring at a garbled pane
        // needs to skip it, but a plugin or agent driving this action on a
        // timer IS the automatic writer the guard was written for. Non-
        // foreground dispatch still gets the renderer repair, just with the
        // deferral intact.
        terminalInstanceService.resetRenderer(targetId, {
          force: isForegroundDispatch(ctx?.dispatchSource),
        });
      }
    },
  }));

  actions.set("terminal.rename", () => ({
    id: "terminal.rename",
    title: "Rename Terminal",
    description:
      "Change a terminal tab's title, or clear it back to the automatic default. Identify the terminal explicitly — an automated caller cannot see what the user has focused, and cannot answer the dialog that omitting a title would open. A title the user set by hand outranks automation, so renaming one of those is accepted and then quietly ignored.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["title", "label", "name", "edit"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      name: z
        .string()
        .optional()
        .describe("New name for the terminal. If omitted, opens the rename dialog."),
    }),
    run: async (args: unknown, ctx) => {
      const { terminalId, name } = args as { terminalId?: string; name?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.rename", terminalId, ctx);
      // Second, independent requirement: without a `name` this action defers to
      // the interactive rename dialog, which a headless caller can never answer
      // — it would hang a prompt in front of the user instead (#11532). Tested
      // against `undefined` rather than falsiness because "" is meaningful: it
      // restores the identity-derived default title.
      if (ctx.dispatchSource === "agent" && name === undefined) {
        throw new Error(
          "terminal.rename requires an explicit `name` when dispatched by an agent or MCP client — a headless caller cannot answer the rename dialog. Pass the new title in `name`, or an empty string to restore the default."
        );
      }
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) return;

      if (name !== undefined) {
        // Programmatic renames (MCP, assistant, plugins) are automation-tier:
        // they pin `titleMode: "custom"` and bounce off a user lock.
        usePanelStore.getState().updateTitle(targetId, name, "automation");
      } else {
        // Defer to a macrotask so menu/dropdown close handlers run before the
        // title input mounts. Do not use requestAnimationFrame here: CI Linux
        // windows can throttle rAF enough that the rename event never fires.
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("daintree:rename-terminal", { detail: { id: targetId } })
          );
        }, 0);
      }
    },
  }));

  actions.set("terminal.viewInfo", () => ({
    id: "terminal.viewInfo",
    title: "View Terminal Info",
    description: "View detailed terminal information",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["details", "metadata", "inspect", "status"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.viewInfo", terminalId, ctx);
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.open", () => ({
    id: "terminal.info.open",
    title: "Open Terminal Info",
    description: "Open terminal info dialog",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["details", "metadata", "inspect", "status"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.info.open", terminalId, ctx);
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:open-terminal-info", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("terminal.info.get", () => ({
    id: "terminal.info.get",
    title: "Get Terminal Info",
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
      spawnedAt: z.number(),
      lastInputTime: z.number(),
      lastOutputTime: z.number(),
      lastStateChange: z.number().optional(),
      activityTier: z.string(),
      outputBufferSize: z.number(),
      semanticBufferLines: z.number(),
      restartCount: z.number(),
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
    }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      // Supersedes the "No terminal selected" throw below for agent dispatch:
      // that one only fires when nothing is focused either, so an agent would
      // otherwise get a silent read of the wrong terminal whenever focus exists.
      requireExplicitTerminalIdForAgentDispatch("terminal.info.get", terminalId, ctx);
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (!targetId) {
        throw new Error("No terminal selected");
      }
      return await window.electron.terminal.getInfo(targetId);
    },
  }));

  actions.set("terminal.toggleInputLock", () => ({
    id: "terminal.toggleInputLock",
    title: "Toggle Input Lock",
    description: "Toggle terminal input lock",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["readonly", "typing", "disable", "keyboard"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.toggleInputLock", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.toggleInputLocked(targetId);
      }
    },
  }));

  actions.set("terminal.forceResume", () => ({
    id: "terminal.forceResume",
    title: "Force Resume",
    description: "Force resume an agent terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["wake", "unstick", "unpause", "stuck"],
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown, ctx) => {
      const { terminalId } = args as { terminalId?: string };
      requireExplicitTerminalIdForAgentDispatch("terminal.forceResume", terminalId, ctx);
      const targetId = terminalId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        await terminalClient.forceResume(targetId);
      }
    },
  }));

  actions.set("terminal.closeAll", () => ({
    id: "terminal.closeAll",
    title: "Close All Terminals",
    description:
      "Close every panel in the active worktree at once, not only terminals. Most move to the trash and stay briefly recoverable, but panels set to remove on exit are discarded outright. This takes the user's own shells and other agents' terminals with it, so prefer closing panels individually. Tooling-internal and dialog-hosted panels are spared.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "hide", "clear", "cleanup"],
    resultSchema: PanelCloseResultSchema,
    mcpOutputSchema: true,
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
    title: "Kill All Terminals",
    description:
      "Permanently destroy every panel in the project at once — across all worktrees, of every kind, including trashed and backgrounded ones — with no trash step and no recovery. This takes the user's own shells and other agents' running work with it; only tooling-internal and dialog-hosted panels are spared. While any agent session is running it destroys nothing unless the call itself is marked confirmed. There is essentially never a reason for an automated caller to use this.",
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
            "Acknowledges losing every running agent session. Without it, nothing is destroyed while any agent is running — a confirmation is staged for the user and the call returns having changed nothing."
          ),
      })
      .optional(),
    run: async (args: unknown) => {
      // Don't reuse bulkCloseAll() — it indiscriminately removes every panel,
      // including the tooling-internal assistant terminal. Filter those out
      // before issuing per-panel removes.
      const state = usePanelStore.getState();
      const targets = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((t): t is NonNullable<typeof t> => {
          if (t == null) return false;
          return !isEphemeralPanel(t);
        });
      if (targets.length === 0) return;
      const runningAgents = collectRunningAgentTerminals(targets);
      if (!parseConfirmed(args) && runningAgents.length > 0) {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "killAll",
          targetCount: targets.length,
          runningAgentCount: runningAgents.length,
        });
        return;
      }
      clearPendingIf("killAll");
      targets.forEach((t) => state.removePanel(t.id));
    },
  }));

  actions.set("terminal.restartAll", () => ({
    id: "terminal.restartAll",
    title: "Restart All Terminals",
    description: "Restart all terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts every non-trash terminal. All scrollback is lost across all terminals.",
    keywords: ["relaunch", "reset", "rerun", "processes"],
    argsSchema: z.object({ confirmed: z.boolean().optional() }).optional(),
    run: async (args: unknown) => {
      const state = usePanelStore.getState();
      // Location-only, deliberately narrower than `isEphemeralPanel`: this list
      // must match what `bulkRestartAll` actually restarts, and that still
      // includes `excludeFromPersistence` terminals like the assistant.
      // Excluding them here alone would confirm one set and restart another.
      const targets = state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t): t is NonNullable<typeof t> =>
            t != null && t.location !== "trash" && t.location !== "dialog"
        );
      if (targets.length === 0) return;
      const runningAgents = collectRunningAgentTerminals(targets);
      if (!parseConfirmed(args) && runningAgents.length > 0) {
        useTerminalPendingDestructiveActionStore.getState().request({
          kind: "restartAll",
          targetCount: targets.length,
          runningAgentCount: runningAgents.length,
        });
        return;
      }
      clearPendingIf("restartAll");
      await state.bulkRestartAll();
    },
  }));

  actions.set("terminal.restartService", () => ({
    id: "terminal.restartService",
    title: "Restart Terminal Service",
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
    run: async () => {
      await terminalClient.restartService();
    },
  }));

  actions.set("terminal.watch", () => ({
    id: "terminal.watch",
    title: "Watch This Terminal",
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
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      // Binds on the argument, not `ctx.focusedTerminalId`. A pinned help
      // session's context snapshot is ambient state captured at provision time,
      // not the caller naming a target, and unpinned external dispatch has no
      // snapshot at all — it falls straight through to live focus.
      requireExplicitTerminalIdForAgentDispatch("terminal.watch", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId = terminalId ?? ctx.focusedTerminalId ?? state.focusedId;
      if (!targetId) return;

      if (state.watchedPanels.has(targetId)) {
        state.unwatchPanel(targetId);
      } else {
        const terminal = state.panelsById[targetId];
        const agentState = terminal && isPtyPanel(terminal) ? terminal.agentState : undefined;
        if (agentState === "completed" || agentState === "waiting" || agentState === "exited") {
          fireWatchNotification(targetId, terminal?.title ?? targetId, agentState);
        } else {
          state.watchPanel(targetId);
        }
      }
    },
  }));
}
