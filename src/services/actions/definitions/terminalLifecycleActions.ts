import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
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
export function registerTerminalLifecycleActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.close", () => ({
    id: "terminal.close",
    title: "Close Terminal",
    description:
      "Close a terminal (move to trash). Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "hide", "dismiss", "remove"],
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown, ctx) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      // Guard before the store read: this chain falls past focus all the way to
      // "any visible panel", so an unbound agent call would trash something
      // essentially at random.
      requireExplicitTerminalIdForAgentDispatch("terminal.close", terminalId, ctx);
      const state = usePanelStore.getState();
      const targetId =
        terminalId ??
        state.focusedId ??
        state.panelIds.find(
          (id) =>
            state.panelsById[id]?.location !== "trash" &&
            state.panelsById[id]?.location !== "background"
        );
      if (!targetId) return;
      // Optimistic close: hide the panel now, trash it after the removal has
      // painted. The coordinator advances focus synchronously so a rapid Cmd+W
      // stream keeps closing fresh panels instead of re-targeting this one.
      requestPanelClose({
        hideIds: [targetId],
        commit: () => usePanelStore.getState().trashPanel(targetId),
      });
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
      "Permanently kill and remove terminal. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale: "Permanently kills the PTY process. Scrollback and session state are lost.",
    keywords: ["terminate", "stop", "remove", "delete"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      confirmed: z.boolean().optional(),
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
      "Restart the terminal process. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field). REQUIRED for agent/MCP dispatch, which cannot see what is focused. Interactive dispatch may omit it and falls back to the focused terminal.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts the terminal process. Scrollback is lost and the process is re-spawned.",
    keywords: ["relaunch", "reset", "rerun", "process"],
    argsSchema: z.object({
      terminalId: z.string().optional(),
      confirmed: z.boolean().optional(),
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
        terminalInstanceService.resetRenderer(targetId);
      }
    },
  }));

  actions.set("terminal.rename", () => ({
    id: "terminal.rename",
    title: "Rename Terminal",
    description:
      "Rename the terminal tab. Args: `terminalId` — panel UUID from `terminal.list` (the `id` field); `name` — the new title, where an empty string restores the identity-derived default. Both are REQUIRED for agent/MCP dispatch: a headless caller cannot see what is focused, and cannot answer the rename dialog that an omitted `name` opens. Interactive dispatch may omit either — it falls back to the focused terminal and opens the dialog.",
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
    description: "Move all terminals in the active worktree to trash",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["trash", "hide", "clear", "cleanup"],
    run: async () => {
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
      if (idsToClose.length === 0) return;
      requestPanelClose({
        hideIds: idsToClose,
        commit: () => {
          const latest = usePanelStore.getState();
          idsToClose.forEach((id) => latest.trashPanel(id));
        },
      });
    },
  }));

  actions.set("terminal.killAll", () => ({
    id: "terminal.killAll",
    title: "Kill All Terminals",
    description: "Permanently remove all terminals (cannot be undone)",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently kills every user-facing terminal. All scrollback and session state are lost.",
    keywords: ["terminate", "stop", "remove", "delete"],
    argsSchema: z.object({ confirmed: z.boolean().optional() }).optional(),
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
