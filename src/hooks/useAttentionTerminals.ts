import { useMemo } from "react";
import { useWaitingTerminals, useFailedTerminals } from "./useTerminalSelectors";
import type { TerminalInstance } from "@/store/terminalStore";

export interface AttentionTerminals {
  terminals: TerminalInstance[];
  waitingCount: number;
  failedCount: number;
  totalCount: number;
}

/**
 * Returns terminals that need attention (failed or waiting), prioritizing failed first.
 * Uses existing selector hooks to ensure stable references and avoid unnecessary re-renders.
 */
export function useAttentionTerminals(): AttentionTerminals {
  const failedTerminals = useFailedTerminals();
  const waitingTerminals = useWaitingTerminals();

  return useMemo(() => {
    const terminals = [...failedTerminals, ...waitingTerminals];
    return {
      terminals,
      waitingCount: waitingTerminals.length,
      failedCount: failedTerminals.length,
      totalCount: terminals.length,
    };
  }, [failedTerminals, waitingTerminals]);
}
