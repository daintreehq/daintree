import type { PluginSetupStepUiStatus } from "@shared/types/plugin";
import { evaluateWhenClause, type WhenClauseContext } from "@shared/utils/whenClause";

export interface PluginSetupRow {
  step: PluginSetupStepUiStatus;
  /** What the host can see right now; a skip never makes a step done. */
  done: boolean;
}

export interface PluginSetupProgress {
  rows: PluginSetupRow[];
  /** Steps that need nothing more: done, or skipped by the user. */
  handled: number;
  total: number;
}

/**
 * Where a plugin's setup checklist stands (#13824). Main answers setting and
 * account steps; a context step's clause is evaluated here against the context
 * keys this view mirrors, so it moves the moment the plugin publishes a key.
 */
export function resolvePluginSetupProgress(
  steps: readonly PluginSetupStepUiStatus[],
  whenContext: WhenClauseContext
): PluginSetupProgress {
  const rows = steps.map((step) => ({
    step,
    done:
      step.check.kind === "observed"
        ? step.check.done
        : evaluateWhenClause(step.check.when, whenContext),
  }));
  return {
    rows,
    handled: rows.filter((row) => row.done || row.step.skipped).length,
    total: rows.length,
  };
}
