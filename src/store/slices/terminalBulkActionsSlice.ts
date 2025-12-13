import PQueue from "p-queue";
import type { StateCreator } from "zustand";
import type { TerminalInstance } from "./terminalRegistrySlice";
import { MAX_GRID_TERMINALS } from "./terminalRegistrySlice";
import type { AgentState } from "@/types";
import { isAgentTerminal } from "../../utils/terminalType";
import { validateTerminals, type ValidationResult } from "@/utils/terminalValidation";

export interface BulkRestartValidation {
  valid: TerminalInstance[];
  invalid: Array<{ terminal: TerminalInstance; errors: ValidationResult }>;
}

export interface TerminalBulkActionsSlice {
  bulkCloseByState: (states: AgentState | AgentState[]) => void;
  bulkCloseByWorktree: (worktreeId: string, state?: AgentState) => void;
  bulkCloseAll: () => void;
  bulkTrashAll: () => void;
  bulkRestartAll: () => Promise<void>;
  bulkRestartPreflightCheck: () => Promise<BulkRestartValidation>;
  bulkMoveToDock: () => void;
  bulkMoveToGrid: () => void;
  restartFailedAgents: () => Promise<void>;
  restartIdleAgents: () => Promise<void>;
  getCountByState: (state: AgentState) => number;
  getCountByWorktree: (worktreeId: string, state?: AgentState) => number;
  getGridCount: () => number;
  getDockedCount: () => number;
}

export const createTerminalBulkActionsSlice = (
  getTerminals: () => TerminalInstance[],
  removeTerminal: (id: string) => void,
  restartTerminal: (id: string) => Promise<void>,
  trashTerminal: (id: string) => void,
  moveTerminalToDock: (id: string) => void,
  moveTerminalToGrid: (id: string) => void,
  getFocusedId: () => string | null,
  setFocusedId: (id: string | null) => void
): StateCreator<TerminalBulkActionsSlice, [], [], TerminalBulkActionsSlice> => {
  const restartTerminals = async (terminalsToRestart: TerminalInstance[]) => {
    const queue = new PQueue({ concurrency: 4 });
    await queue.addAll(
      terminalsToRestart.map((terminal) => async () => {
        try {
          await restartTerminal(terminal.id);
        } catch (error) {
          console.error(`Failed to restart terminal ${terminal.id}:`, error);
        }
      })
    );
  };

  return () => ({
    bulkCloseByState: (states) => {
      const stateArray = Array.isArray(states) ? states : [states];
      const terminals = getTerminals();
      const toRemove = terminals.filter((t) => t.agentState && stateArray.includes(t.agentState));
      toRemove.forEach((t) => removeTerminal(t.id));
    },

    bulkCloseByWorktree: (worktreeId, state) => {
      const terminals = getTerminals();
      const toRemove = terminals.filter(
        (t) => t.worktreeId === worktreeId && (!state || t.agentState === state)
      );
      toRemove.forEach((t) => removeTerminal(t.id));
    },

    bulkCloseAll: () => {
      const terminals = getTerminals();
      terminals.forEach((t) => removeTerminal(t.id));
    },

    bulkTrashAll: () => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => t.location !== "trash");
      activeTerminals.forEach((t) => trashTerminal(t.id));
    },

    bulkRestartAll: async () => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => t.location !== "trash");
      await restartTerminals(activeTerminals);
    },

    bulkRestartPreflightCheck: async () => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => t.location !== "trash");

      const validationResults = await validateTerminals(activeTerminals);

      const valid: TerminalInstance[] = [];
      const invalid: Array<{ terminal: TerminalInstance; errors: ValidationResult }> = [];

      for (const terminal of activeTerminals) {
        const result = validationResults.get(terminal.id);
        if (result) {
          invalid.push({ terminal, errors: result });
        } else {
          valid.push(terminal);
        }
      }

      return { valid, invalid };
    },

    bulkMoveToDock: () => {
      const terminals = getTerminals();
      const gridTerminals = terminals.filter((t) => t.location === "grid");
      gridTerminals.forEach((t) => moveTerminalToDock(t.id));
    },

    bulkMoveToGrid: () => {
      const terminals = getTerminals();
      const dockedTerminals = terminals.filter((t) => t.location === "dock");
      if (dockedTerminals.length === 0) return;

      // Calculate available capacity (count both "grid" and undefined as grid)
      const gridCount = terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      ).length;
      const availableSlots = MAX_GRID_TERMINALS - gridCount;
      if (availableSlots <= 0) return;

      // Only move terminals that fit
      const terminalsToMove = dockedTerminals.slice(0, availableSlots);

      // Preserve existing grid focus if one exists
      const currentFocusId = getFocusedId();
      const currentFocusedTerminal = currentFocusId
        ? terminals.find((t) => t.id === currentFocusId)
        : null;
      const hasGridFocus = currentFocusedTerminal?.location === "grid";

      terminalsToMove.forEach((t) => moveTerminalToGrid(t.id));

      // Restore the original grid focus if it existed
      if (hasGridFocus && currentFocusId) {
        setFocusedId(currentFocusId);
      }
    },

    restartFailedAgents: async () => {
      const terminals = getTerminals();
      const failedAgents = terminals.filter(
        (t) => t.agentState === "failed" && isAgentTerminal(t.kind ?? t.type, t.agentId)
      );
      await restartTerminals(failedAgents);
    },

    restartIdleAgents: async () => {
      const terminals = getTerminals();
      const idleAgents = terminals.filter(
        (t) => t.agentState === "idle" && isAgentTerminal(t.kind ?? t.type, t.agentId)
      );
      await restartTerminals(idleAgents);
    },

    getCountByState: (state) => {
      const terminals = getTerminals();
      return terminals.filter((t) => t.agentState === state).length;
    },

    getCountByWorktree: (worktreeId, state) => {
      const terminals = getTerminals();
      return terminals.filter(
        (t) => t.worktreeId === worktreeId && (!state || t.agentState === state)
      ).length;
    },

    getGridCount: () => {
      const terminals = getTerminals();
      return terminals.filter((t) => t.location === "grid").length;
    },

    getDockedCount: () => {
      const terminals = getTerminals();
      return terminals.filter((t) => t.location === "dock").length;
    },
  });
};
