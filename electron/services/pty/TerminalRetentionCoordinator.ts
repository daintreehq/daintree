import { computeRetentionTier } from "../../../shared/config/terminalRetention.js";
import type { TerminalProcess } from "./TerminalProcess.js";

export const RETENTION_SWEEP_INTERVAL_MS = 5000;

export interface RetentionCoordinatorDeps {
  getTerminals: () => TerminalProcess[];
  isTrashed: (id: string) => boolean;
  /** UI-focused in any connected window. */
  isFocused: (id: string) => boolean;
}

/**
 * Periodically derives each terminal's retention tier from its observable
 * state (agent state, focus, activity tier, trash/preserve status) and applies
 * the tier's budgets to the terminal's host-side analysis buffers.
 *
 * A sweep is deliberately cheap: `applyRetentionTier` no-ops when the tier is
 * unchanged, so steady state costs one tier computation per terminal per tick.
 * The 5s cadence is a policy loop, not a reactive one — retention only needs
 * to track state transitions, and a few seconds of lag on a tier upgrade
 * merely delays raising a cap (no content is lost by a late grow; a late trim
 * just retains a little longer).
 */
export class TerminalRetentionCoordinator {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: RetentionCoordinatorDeps,
    private readonly intervalMs: number = RETENTION_SWEEP_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  sweep(): void {
    for (const terminal of this.deps.getTerminals()) {
      try {
        const state = terminal.getPublicState();
        const tier = computeRetentionTier({
          isAgentTerminal:
            state.launchAgentId !== undefined ||
            state.detectedAgentId !== undefined ||
            state.everDetectedAgent === true,
          agentState: state.agentState,
          isFocused: this.deps.isFocused(state.id),
          activityTier: terminal.getActivityTier(),
          isTrashed: this.deps.isTrashed(state.id),
          hasPreservedSnapshot: terminal.hasPreservedSnapshot(),
          isExited: state.isExited === true || state.wasKilled === true,
        });
        terminal.applyRetentionTier(tier);
      } catch (error) {
        console.warn("[TerminalRetentionCoordinator] sweep failed for terminal:", error);
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
