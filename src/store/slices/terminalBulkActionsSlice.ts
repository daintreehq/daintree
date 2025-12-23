import PQueue from "p-queue";
import type { StateCreator } from "zustand";
import type { TerminalInstance } from "./terminalRegistrySlice";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
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
  bulkMoveToDockByWorktree: (worktreeId: string) => void;
  bulkMoveToGridByWorktree: (worktreeId: string) => void;
  bulkTrashByWorktree: (worktreeId: string) => void;
  bulkRestartByWorktree: (worktreeId: string) => Promise<void>;
  bulkRestartPreflightCheckByWorktree: (worktreeId: string) => Promise<BulkRestartValidation>;
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
  const restartQueue = new PQueue({ concurrency: 4, timeout: 30_000 });

  const restartTerminals = async (terminalsToRestart: TerminalInstance[]) => {
    const ids = Array.from(new Set(terminalsToRestart.map((t) => t.id)));
    await restartQueue.addAll(
      ids.map((id) => async () => {
        try {
          await restartTerminal(id);
        } catch (error) {
          console.error(`Failed to restart terminal ${id}:`, error);
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

    bulkMoveToDockByWorktree: (worktreeId) => {
      const terminals = getTerminals();
      const gridTerminals = terminals.filter(
        (t) => t.worktreeId === worktreeId && (t.location === "grid" || t.location === undefined)
      );
      gridTerminals.forEach((t) => moveTerminalToDock(t.id));
    },

    bulkMoveToGridByWorktree: (worktreeId) => {
      const terminals = getTerminals();
      const dockedTerminals = terminals.filter(
        (t) => t.worktreeId === worktreeId && t.location === "dock"
      );
      if (dockedTerminals.length === 0) return;

      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const gridCount = terminals.filter(
        (t) => (t.location === "grid" || t.location === undefined) && t.worktreeId === worktreeId
      ).length;
      const availableSlots = maxCapacity - gridCount;
      if (availableSlots <= 0) return;

      const terminalsToMove = dockedTerminals.slice(0, availableSlots);

      const currentFocusId = getFocusedId();
      const currentFocusedTerminal = currentFocusId
        ? terminals.find((t) => t.id === currentFocusId)
        : null;
      const hasGridFocus = currentFocusedTerminal?.location === "grid";

      terminalsToMove.forEach((t) => moveTerminalToGrid(t.id));

      if (hasGridFocus && currentFocusId) {
        setFocusedId(currentFocusId);
      }
    },

    bulkTrashByWorktree: (worktreeId) => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter(
        (t) => t.worktreeId === worktreeId && t.location !== "trash"
      );
      activeTerminals.forEach((t) => trashTerminal(t.id));
    },

    bulkRestartPreflightCheckByWorktree: async (worktreeId) => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter(
        (t) => t.worktreeId === worktreeId && t.location !== "trash"
      );

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

    bulkRestartByWorktree: async (worktreeId) => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter(
        (t) => t.worktreeId === worktreeId && t.location !== "trash"
      );
      if (activeTerminals.length === 0) return;

      try {
        const validationResults = await validateTerminals(activeTerminals);
        const valid = activeTerminals.filter((t) => !validationResults.get(t.id));
        await restartTerminals(valid);
      } catch (error) {
        console.error("Failed to validate terminals for restart:", error);
        await restartTerminals(activeTerminals);
      }
    },

    bulkMoveToDock: () => {
      const terminals = getTerminals();
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const gridTerminals = terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      gridTerminals.forEach((t) => moveTerminalToDock(t.id));
    },

    bulkMoveToGrid: () => {
      const terminals = getTerminals();
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const dockedTerminals = terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      if (dockedTerminals.length === 0) return;

      // Calculate available capacity (count both "grid" and undefined as grid)
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const gridCount = terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ).length;
      const availableSlots = maxCapacity - gridCount;
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
