import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { TerminalTypeSchema } from "./schemas";
import { z } from "zod";
import { useTerminalStore } from "@/store/terminalStore";
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
    title: "Duplicate Terminal",
    description: "Create a duplicate of the terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      const state = useTerminalStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.terminals.find((t) => t.id === targetId);
        if (!terminal) return;

        const location = terminal.location === "trash" ? "grid" : (terminal.location ?? "grid");

        await state.addTerminal({
          kind: terminal.kind,
          type: terminal.type,
          agentId: terminal.agentId,
          cwd: terminal.cwd,
          location,
          title: terminal.title ? `${terminal.title} (copy)` : undefined,
          worktreeId: terminal.worktreeId,
          command: terminal.command,
          isInputLocked: terminal.isInputLocked,
          browserUrl: terminal.browserUrl,
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
