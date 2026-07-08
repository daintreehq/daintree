import {
  AgentTerminalLifecycleLedger,
  type LedgerAnomaly,
} from "@shared/utils/agentLifecycleLedger";
import { logWarn } from "@/utils/logger";

/**
 * Renderer-side lifecycle ledger. The panel store has no generation counter of
 * its own — `spawnStatus` plus existence re-checks were the only guards — so
 * this ledger provides the per-panel launch epoch that async completions
 * (spawn resolve, hydration/reconnect merges, worktree inference) validate
 * against before touching panel state. Complements, not replaces, the
 * instance-scoped guards (`attachGeneration`, `restoreGeneration`), which die
 * with the ManagedTerminal while the panel row and its id survive.
 *
 * Per project view (one instance per renderer context), diagnostic-grade and
 * bounded; main's ledger remains the authority for journal dedupe.
 */
function logAnomaly(anomaly: LedgerAnomaly): void {
  if (import.meta.env?.PROD) return;
  logWarn(
    `[LifecycleLedger] ${anomaly.op} rejected on ${anomaly.terminalId} ` +
      `(gen ${anomaly.generation ?? "?"} vs current ${anomaly.currentGeneration ?? "?"}): ${anomaly.reason}` +
      (anomaly.detail ? ` — ${anomaly.detail}` : "")
  );
}

export const agentLifecycleLedger = new AgentTerminalLifecycleLedger({ onAnomaly: logAnomaly });
