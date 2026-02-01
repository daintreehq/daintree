import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import type { TerminalInstance } from "@/store/terminalStore";

export interface AttentionTerminals {
  terminals: TerminalInstance[];
  waitingCount: number;
  failedCount: number;
  totalCount: number;
}

function isTerminalOrphaned(terminal: TerminalInstance, worktreeIds: Set<string>): boolean {
  const worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId.trim() : "";
  if (!worktreeId) return false;
  return !worktreeIds.has(worktreeId);
}

function isTerminalVisible(
  terminal: TerminalInstance,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>
): boolean {
  if (isInTrash(terminal.id)) return false;
  if (terminal.location === "trash") return false;
  if (isTerminalOrphaned(terminal, worktreeIds)) return false;
  return true;
}

export function useAttentionTerminals(): AttentionTerminals {
  const worktreeIds = useWorktreeDataStore(
    useShallow((state) => {
      const ids = new Set<string>();
      for (const [id, wt] of state.worktrees) {
        ids.add(id);
        if (wt.worktreeId) ids.add(wt.worktreeId);
      }
      return ids;
    })
  );

  return useTerminalStore(
    useShallow((state) => {
      const failed: TerminalInstance[] = [];
      const waiting: TerminalInstance[] = [];

      for (const terminal of state.terminals) {
        if (!isTerminalVisible(terminal, state.isInTrash, worktreeIds)) continue;
        if (terminal.agentState === "failed") {
          failed.push(terminal);
        } else if (terminal.agentState === "waiting") {
          waiting.push(terminal);
        }
      }

      const terminals = [...failed, ...waiting];
      return {
        terminals,
        waitingCount: waiting.length,
        failedCount: failed.length,
        totalCount: terminals.length,
      };
    })
  );
}
