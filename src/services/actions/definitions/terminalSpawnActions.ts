import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { flushOptimisticCloses } from "@/services/terminal/optimisticPanelClose";
import { getDefaultTitle } from "@/store/slices/panelRegistry/helpers";
import { TerminalSpawnSourceSchema } from "./schemas";
import type { TerminalSpawnSource } from "@shared/types/panel";
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
    argsSchema: z.object({ spawnedBy: TerminalSpawnSourceSchema.optional() }).optional(),
    run: async (args) => {
      const { spawnedBy } = args ?? {};
      const addPanel = usePanelStore.getState().addPanel;
      const terminalId = await addPanel({
        kind: "terminal",
        cwd: callbacks.getDefaultCwd(),
        location: "grid",
        worktreeId: callbacks.getActiveWorktreeId(),
        spawnedBy,
      });
      if (!terminalId) return;
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
    argsSchema: z
      .object({
        terminalId: z.string().optional(),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { terminalId, spawnedBy } =
        (args as { terminalId?: string; spawnedBy?: TerminalSpawnSource } | undefined) ?? {};
      const state = usePanelStore.getState();
      const nonTrashed = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((t) => t && t.location !== "trash");
      const focusedPanel = state.focusedId ? state.panelsById[state.focusedId] : undefined;
      const liveFocusedId =
        focusedPanel && focusedPanel.location !== "trash" ? state.focusedId : undefined;
      const targetId =
        terminalId ?? liveFocusedId ?? (nonTrashed.length === 1 ? nonTrashed[0]!.id : undefined);

      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal) return;

        const location =
          terminal.location === "grid" || terminal.location === "dock" ? terminal.location : "grid";
        const options = await buildPanelDuplicateOptions(terminal, location);
        if (options.title) {
          const defaultTitle = getDefaultTitle(terminal.kind, terminal);
          if (options.title !== defaultTitle) {
            options.title = `${options.title} (copy)`;
          }
        }
        if (spawnedBy) {
          options.spawnedBy = spawnedBy;
        }
        await state.addPanel(options);
      } else if (nonTrashed.length === 0) {
        const lastClosed = state.lastClosedConfig;
        if (lastClosed) {
          const baseOptions = lastClosed.launchAgentId
            ? await buildPanelDuplicateOptions(
                {
                  id: "last-closed",
                  title: lastClosed.title ?? "Terminal",
                  cwd: lastClosed.cwd ?? callbacks.getDefaultCwd(),
                  location: "grid",
                  ...lastClosed,
                },
                "grid"
              )
            : lastClosed;
          await state.addPanel({
            ...baseOptions,
            location: "grid",
            worktreeId: lastClosed.worktreeId ?? callbacks.getActiveWorktreeId(),
            ...(spawnedBy ? { spawnedBy } : {}),
          });
        } else {
          await state.addPanel({
            kind: "terminal",
            cwd: callbacks.getDefaultCwd(),
            location: "grid",
            worktreeId: callbacks.getActiveWorktreeId(),
            spawnedBy,
          });
        }
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
      // Commit any in-flight optimistic close first — until it flushes the
      // panel isn't in `trashedTerminals` yet and restore would no-op.
      flushOptimisticCloses();
      usePanelStore.getState().restoreLastTrashed();
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
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        const terminal = state.panelsById[targetId];
        if (!terminal || terminal.worktreeId === worktreeId) {
          return;
        }

        useLayoutUndoStore.getState().pushLayoutSnapshot();
        state.setFocused(null);
        state.moveTerminalToWorktree(targetId, worktreeId);
      }
    },
  }));

  actions.set("terminal.moveToNewWorktree", () => ({
    id: "terminal.moveToNewWorktree",
    title: "Move to New Worktree…",
    description: "Create a new worktree and transfer the agent session there",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      state.moveToNewWorktreeAndTransfer(targetId);
    },
  }));
}
