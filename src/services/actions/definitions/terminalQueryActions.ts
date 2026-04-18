import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { stripAnsiCodes } from "@shared/utils/artifactParser";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalClient } from "@/clients";
import { usePanelStore, type TerminalInstance } from "@/store/panelStore";
export function registerTerminalQueryActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.list", () => ({
    id: "terminal.list",
    title: "List Terminals",
    description:
      "Get list of all terminals with metadata (id, kind, worktreeId, title, location, status)",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        location: z.enum(["grid", "dock", "trash", "background"]).optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { worktreeId, location } = (args ?? {}) as {
        worktreeId?: string;
        location?: "grid" | "dock" | "trash" | "background";
      };
      const state = usePanelStore.getState();
      let terminals = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((t): t is TerminalInstance => t !== undefined);

      // Filter by worktree if specified
      if (worktreeId) {
        terminals = terminals.filter((t) => t.worktreeId === worktreeId);
      }

      // Filter by location if specified
      if (location) {
        terminals = terminals.filter((t) => t.location === location);
      } else {
        // By default, exclude trashed and backgrounded terminals
        terminals = terminals.filter((t) => t.location !== "trash" && t.location !== "background");
      }

      // Return essential metadata only (avoid returning full PTY buffers)
      return terminals.map((t) => ({
        id: t.id,
        kind: t.kind,
        type: t.type,
        worktreeId: t.worktreeId ?? null,
        title: t.title ?? null,
        location: t.location ?? "grid",
        agentId: t.agentId ?? null,
        agentState: t.agentState ?? null,
        isInputLocked: t.isInputLocked ?? false,
      }));
    },
  }));

  actions.set("terminal.getOutput", () => ({
    id: "terminal.getOutput",
    title: "Get Terminal Output",
    description: "Get terminal output with optional line limit and ANSI stripping.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().describe("Terminal instance ID from terminal.list"),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum lines to return (default: 100, max: 1000)"),
      stripAnsi: z
        .boolean()
        .default(true)
        .describe("Remove ANSI escape codes from output (default: true)"),
    }),
    run: async (args: unknown) => {
      const {
        terminalId,
        maxLines = 100,
        stripAnsi = true,
      } = args as {
        terminalId: string;
        maxLines?: number;
        stripAnsi?: boolean;
      };

      // Validate maxLines bounds
      const effectiveMaxLines = Math.min(Math.max(maxLines, 1), 1000);

      // Get serialized terminal state via existing IPC method
      const serializedState = await window.electron.terminal.getSerializedState(terminalId);

      if (serializedState === null) {
        return {
          terminalId,
          content: null,
          lineCount: 0,
          truncated: false,
          error: "Terminal not found or has no output",
        };
      }

      // Split into lines and extract last N
      const allLines = serializedState.split("\n");
      const totalLines = allLines.length;
      const truncated = totalLines > effectiveMaxLines;
      const selectedLines = allLines.slice(-effectiveMaxLines);

      // Optionally strip ANSI codes
      let content = selectedLines.join("\n");
      if (stripAnsi) {
        content = stripAnsiCodes(content);
      }

      return {
        terminalId,
        content,
        lineCount: selectedLines.length,
        truncated,
      };
    },
  }));

  actions.set("terminal.sendCommand", () => ({
    id: "terminal.sendCommand",
    title: "Send Command to Terminal",
    description: "Send a shell command to a terminal for execution",
    category: "terminal",
    kind: "command",
    danger: "confirm", // Commands can have side effects
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().min(1).describe("Terminal instance ID from terminal.list"),
      command: z.string().min(1).describe("The command to execute"),
    }),
    run: async (args: unknown) => {
      const { terminalId, command } = args as { terminalId: string; command: string };

      // Verify terminal exists and is valid for command execution
      const terminal = usePanelStore.getState().panelsById[terminalId];

      if (!terminal) {
        throw new Error("Terminal not found");
      }

      // Check if terminal is trashed
      if (terminal.location === "trash") {
        throw new Error("Cannot send commands to trashed terminals");
      }

      // Check if terminal kind supports PTY (must have a shell to send commands to)
      const kind = terminal.kind ?? "terminal";
      if (!panelKindHasPty(kind)) {
        throw new Error(`Terminal kind "${kind}" does not support command execution`);
      }

      // Check if terminal has PTY capability
      if (terminal.hasPty === false) {
        throw new Error("Terminal does not have PTY capability");
      }

      // Send command via submit (handles bracketed paste)
      await terminalClient.submit(terminalId, command);

      // Return a clear message so the AI model knows not to repeat this action
      return {
        sent: true,
        terminalId,
        command,
        message: `Command sent to terminal. Do not send this command again to the same terminal.`,
      };
    },
  }));
}
