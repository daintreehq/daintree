import PQueue from "p-queue";
import type { StateCreator } from "zustand";
import type { TerminalInstance } from "./panelRegistrySlice";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import type { AgentState } from "@/types";
import { isRuntimeAgentTerminal } from "../../utils/terminalType";
import { validateTerminals, type ValidationResult } from "@/utils/terminalValidation";
import { logError } from "@/utils/logger";

export interface BulkRestartValidation {
  valid: TerminalInstance[];
  invalid: Array<{ terminal: TerminalInstance; errors: ValidationResult }>;
}

export interface TerminalBulkActionsSlice {
  bulkCloseByState: (states: AgentState | AgentState[]) => void;
  bulkCloseByWorktree: (worktreeId: string, state?: AgentState) => void;
  bulkCloseAll: () => void;
  bulkTrashAll: () => void;
  bulkTrashSet: (ids: Iterable<string>) => void;
  bulkKillSet: (ids: Iterable<string>) => void;
  bulkRestartAll: () => Promise<void>;
  bulkRestartSet: (ids: Iterable<string>) => Promise<void>;
  bulkRestartPreflightCheck: () => Promise<BulkRestartValidation>;
  bulkRestartPreflightCheckSet: (ids: Iterable<string>) => Promise<BulkRestartValidation>;
  bulkMoveToDockByWorktree: (worktreeId: string) => void;
  bulkMoveToGridByWorktree: (worktreeId: string) => void;
  bulkTrashByWorktree: (worktreeId: string) => void;
  bulkRestartByWorktree: (worktreeId: string) => Promise<void>;
  bulkRestartPreflightCheckByWorktree: (worktreeId: string) => Promise<BulkRestartValidation>;
  bulkMoveToDock: () => void;
  bulkMoveToGrid: () => void;
  restartIdleAgents: () => Promise<void>;
  getCountByState: (state: AgentState) => number;
  getCountByWorktree: (worktreeId: string, state?: AgentState) => number;
  getGridCount: () => number;
  getDockedCount: () => number;
}

export const createTerminalBulkActionsSlice = (
  getTerminals: () => TerminalInstance[],
  removePanel: (id: string) => void,
  restartTerminal: (id: string) => Promise<void>,
  trashPanel: (id: string) => void,
  moveTerminalToDock: (id: string) => void,
  moveTerminalToGrid: (id: string) => void,
  getFocusedId: () => string | null,
  setFocusedId: (id: string | null) => void,
  getActiveWorktreeId: () => string | null
): StateCreator<TerminalBulkActionsSlice, [], [], TerminalBulkActionsSlice> => {
  const restartQueue = new PQueue({ concurrency: 4, timeout: 30_000 });

  const restartTerminals = async (terminalsToRestart: TerminalInstance[]) => {
    const ids = Array.from(new Set(terminalsToRestart.map((t) => t.id)));
    await restartQueue.addAll(
      ids.map((id) => async () => {
        try {
          await restartTerminal(id);
        } catch (error) {
          logError(`Failed to restart terminal ${id}`, error);
        }
      })
    );
  };

  return () => ({
    bulkCloseByState: (states) => {
      const stateArray = Array.isArray(states) ? states : [states];
      const terminals = getTerminals();
      const toRemove = terminals.filter((t) => t.agentState && stateArray.includes(t.agentState));
      toRemove.forEach((t) => removePanel(t.id));
    },

    bulkCloseByWorktree: (worktreeId, state) => {
      const terminals = getTerminals();
      const toRemove = terminals.filter(
        (t) => t.worktreeId === worktreeId && (!state || t.agentState === state)
      );
      toRemove.forEach((t) => removePanel(t.id));
    },

    bulkCloseAll: () => {
      const terminals = getTerminals();
      terminals.forEach((t) => removePanel(t.id));
    },

    bulkTrashAll: () => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => t.location !== "trash");
      activeTerminals.forEach((t) => trashPanel(t.id));
    },

    bulkTrashSet: (ids) => {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      if (idSet.size === 0) return;
      const terminals = getTerminals();
      const toTrash = terminals.filter((t) => idSet.has(t.id) && t.location !== "trash");
      toTrash.forEach((t) => trashPanel(t.id));
    },

    bulkKillSet: (ids) => {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      if (idSet.size === 0) return;
      const terminals = getTerminals();
      const toKill = terminals.filter((t) => idSet.has(t.id));
      toKill.forEach((t) => removePanel(t.id));
    },

    bulkRestartAll: async () => {
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => t.location !== "trash");
      await restartTerminals(activeTerminals);
    },

    bulkRestartSet: async (ids) => {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      if (idSet.size === 0) return;
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => idSet.has(t.id) && t.location !== "trash");
      if (activeTerminals.length === 0) return;
      try {
        const validationResults = await validateTerminals(activeTerminals);
        const valid = activeTerminals.filter((t) => !validationResults.get(t.id));
        await restartTerminals(valid);
      } catch (error) {
        logError("Failed to validate terminals for restart", error);
        await restartTerminals(activeTerminals);
      }
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

    bulkRestartPreflightCheckSet: async (ids) => {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      const terminals = getTerminals();
      const activeTerminals = terminals.filter((t) => idSet.has(t.id) && t.location !== "trash");

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
      const hasGridFocus =
        currentFocusedTerminal != null &&
        (currentFocusedTerminal.location === "grid" ||
          currentFocusedTerminal.location === undefined);

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
      activeTerminals.forEach((t) => trashPanel(t.id));
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
        logError("Failed to validate terminals for restart", error);
        await restartTerminals(activeTerminals);
      }
    },

    bulkMoveToDock: () => {
      const terminals = getTerminals();
      const activeWorktreeId = getActiveWorktreeId();
      const gridTerminals = terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      );
      gridTerminals.forEach((t) => moveTerminalToDock(t.id));
    },

    bulkMoveToGrid: () => {
      const terminals = getTerminals();
      const activeWorktreeId = getActiveWorktreeId();
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
      const hasGridFocus =
        currentFocusedTerminal != null &&
        (currentFocusedTerminal.location === "grid" ||
          currentFocusedTerminal.location === undefined);

      terminalsToMove.forEach((t) => moveTerminalToGrid(t.id));

      // Restore the original grid focus if it existed
      if (hasGridFocus && currentFocusId) {
        setFocusedId(currentFocusId);
      }
    },

    restartIdleAgents: async () => {
      const terminals = getTerminals();
      // Runtime predicate — include terminals that were promoted at runtime
      // (a plain shell where `claude` is currently the foreground process),
      // not just spawn-sealed agent terminals.
      const idleAgents = terminals.filter(
        (t) => t.agentState === "idle" && isRuntimeAgentTerminal(t)
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
      return terminals.filter((t) => t.location === "grid" || t.location === undefined).length;
    },

    getDockedCount: () => {
      const terminals = getTerminals();
      return terminals.filter((t) => t.location === "dock").length;
    },
  });
};
