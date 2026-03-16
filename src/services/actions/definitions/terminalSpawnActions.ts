import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { TerminalTypeSchema } from "./schemas";
import { z } from "zod";
import { useTerminalStore } from "@/store/terminalStore";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
export function registerTerminalSpawnActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.new", () => ({
    id: "terminal.new",
    title: "New Terminal",
    description: "Create a new terminal in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const addTerminal = useTerminalStore.getState().addTerminal;
      const terminalId = await addTerminal({
        type: "terminal",
        cwd: callbacks.getDefaultCwd(),
        location: "grid",
        worktreeId: callbacks.getActiveWorktreeId(),
      });
      return { terminalId };
    },
  }));

  actions.set("terminal.duplicate", () => ({
    id: "terminal.duplicate",
    title: "Duplicate Panel",
    description: "Duplicate the focused panel, or create a new terminal if no panels exist",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = useTerminalStore.getState();
      const nonTrashed = state.terminals.filter((t) => t.location !== "trash");
      const targetId =
        terminalId ?? state.focusedId ?? (nonTrashed.length === 1 ? nonTrashed[0].id : undefined);

      if (targetId) {
        const terminal = state.terminals.find((t) => t.id === targetId);
        if (!terminal) return;

        const location =
          terminal.location === "grid" || terminal.location === "dock" ? terminal.location : "grid";
        const options = await buildPanelDuplicateOptions(terminal, location);
        if (terminal.title) {
          options.title = `${terminal.title} (copy)`;
        }
        await state.addTerminal(options);
      } else if (nonTrashed.length === 0) {
        await state.addTerminal({
          type: "terminal",
          cwd: callbacks.getDefaultCwd(),
          location: "grid",
          worktreeId: callbacks.getActiveWorktreeId(),
        });
      }
    },
  }));

  actions.set("terminal.reopenLast", () => ({
    id: "terminal.reopenLast",
    title: "Reopen Last Closed",
    description: "Restore the most recently trashed terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useTerminalStore.getState().restoreLastTrashed();
    },
  }));

  actions.set("terminal.moveToWorktree", () => ({
    id: "terminal.moveToWorktree",
    title: "Move to Worktree",
    description: "Move terminal to a different worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      worktreeId: z.string(),
    }),
    run: async (args: unknown) => {
      const { terminalId, worktreeId } = args as { terminalId?: string; worktreeId: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.terminals.find((t) => t.id === targetId);
        if (!terminal || terminal.worktreeId === worktreeId) {
          return;
        }

        state.setFocused(null);
        state.moveTerminalToWorktree(targetId, worktreeId);
      }
    },
  }));

  actions.set("terminal.convertType", () => ({
    id: "terminal.convertType",
    title: "Convert Terminal Type",
    description: "Convert terminal to a different type",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().optional(),
      type: TerminalTypeSchema,
    }),
    run: async (args: unknown) => {
      const { terminalId, type } = args as { terminalId?: string; type: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        state.convertTerminalType(
          targetId,
          type as "terminal" | "claude" | "gemini" | "codex" | "opencode"
        );
      }
    },
  }));
}
