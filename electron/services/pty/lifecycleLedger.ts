import {
  AgentTerminalLifecycleLedger,
  computeEnvProvenance,
  type LedgerAnomaly,
  type LedgerLaunchFacts,
} from "../../../shared/utils/agentLifecycleLedger.js";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("pty:LifecycleLedger");

/**
 * Per-process lifecycle ledger singleton (Pattern C — see PtyManager). Main
 * and the pty-host each get their own instance; Main's is the authority for
 * journal dedupe and the diagnostics surface, the pty-host's guards buffered
 * resizes across incarnations.
 *
 * Anomalies are always recorded in the bounded ring buffer for diagnostics;
 * outside production they are also logged loudly so lifecycle races fail
 * visibly in development and tests.
 */
function logAnomaly(anomaly: LedgerAnomaly): void {
  if (process.env.NODE_ENV === "production") return;
  logger.warn(
    `Lifecycle invariant rejected: ${anomaly.op} on ${anomaly.terminalId} ` +
      `(gen ${anomaly.generation ?? "?"} vs current ${anomaly.currentGeneration ?? "?"}): ` +
      `${anomaly.reason}${anomaly.detail ? ` — ${anomaly.detail}` : ""}`
  );
}

let ledgerInstance: AgentTerminalLifecycleLedger | null = null;

export function getLifecycleLedger(): AgentTerminalLifecycleLedger {
  if (!ledgerInstance) {
    ledgerInstance = new AgentTerminalLifecycleLedger({ onAnomaly: logAnomaly });
  }
  return ledgerInstance;
}

export function disposeLifecycleLedger(): void {
  ledgerInstance?.clear();
  ledgerInstance = null;
}

/** Launch facts for the ledger from spawn options — env reduced to provenance. */
export function ledgerFactsFromSpawnOptions(options: PtyHostSpawnOptions): LedgerLaunchFacts {
  return {
    launchAgentId: options.launchAgentId,
    cwd: options.cwd,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    worktreeSource: options.worktreeId !== undefined ? "explicit" : undefined,
    agentModelId: options.agentModelId,
    agentPresetId: options.agentPresetId,
    originalPresetId: options.originalAgentPresetId ?? options.agentPresetId,
    agentLaunchFlags: options.agentLaunchFlags,
    env: computeEnvProvenance(options.env),
    initialCols: options.cols,
    initialRows: options.rows,
  };
}
