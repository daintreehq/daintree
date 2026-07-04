import type { AgentState } from "../types/agent.js";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "./scrollback.js";

/**
 * Per-terminal retention tier for host-side analysis memory (headless mirror
 * scrollback, semantic buffer, forensics ring, agent-output mirror). The tier
 * bounds how much historical content the PTY host retains for a terminal — it
 * never affects the renderer's live xterm buffer, which remains the visual
 * source of truth, and it never pauses or drops live PTY output.
 *
 * - `foreground`: focused or visible working agent (or focused/visible plain
 *   terminal) — full retention.
 * - `working`: background working/directing agent — enough history for state
 *   detection and recent context.
 * - `settled`: waiting/idle/completed/exited terminals — recent context only.
 * - `archived`: trashed terminals and preserved exit snapshots — minimal,
 *   bounded, LRU-pruned.
 */
export type TerminalRetentionTier = "foreground" | "working" | "settled" | "archived";

export interface RetentionTierInputs {
  /** Launched with an agent hint, currently detected, or ever hosted an agent. */
  isAgentTerminal: boolean;
  agentState?: AgentState;
  /** UI-focused in some window (renderer-pushed focus). */
  isFocused: boolean;
  /** PTY-host activity tier: "active" = project foreground for some window. */
  activityTier: "active" | "background";
  isTrashed: boolean;
  /** Exited terminal whose final buffer was captured as a preserved snapshot. */
  hasPreservedSnapshot: boolean;
  /** Terminal process exited or was killed (terminal-level, not agent-level). */
  isExited: boolean;
}

export interface TerminalRetentionBudget {
  /**
   * Steady-state cap on the headless mirror scrollback (lines). Applied on
   * tier transitions; shrinking is destructive (xterm evicts oldest lines),
   * so downward moves are recorded as retention trims.
   */
  mirrorScrollbackLines: number;
  /**
   * Floor the resource governor's targeted pressure trim may take the mirror
   * down to (lines). Always ≤ mirrorScrollbackLines.
   */
  pressureMirrorFloorLines: number;
  /** Cap on the semantic line buffer (lines). */
  semanticBufferLines: number;
  /** Cap on the crash-forensics ring (chars). */
  forensicsChars: number;
  /** Cap on the rolling agent-output mirror (chars). */
  agentOutputChars: number;
}

/**
 * Budgets per tier. The `foreground` row matches the historical fixed caps
 * (DEFAULT_SCROLLBACK / SEMANTIC_BUFFER_MAX_LINES / forensics 4000 /
 * OUTPUT_BUFFER_SIZE in `electron/services/pty/types.ts` +
 * `TerminalForensicsBuffer`), so a terminal that never leaves the foreground
 * behaves exactly as before this policy existed — enforced by
 * `terminalRetention.contract.test.ts` on the electron side.
 *
 * The `working` mirror cap (5000) matches the renderer's AGENT_POLICY
 * maxLines, so nothing user-visible is lost across a view-eviction restore.
 * `settled` (2000) matches the renderer's PLAIN_POLICY maxLines.
 */
export const TERMINAL_RETENTION_BUDGETS: Record<TerminalRetentionTier, TerminalRetentionBudget> = {
  foreground: {
    mirrorScrollbackLines: SCROLLBACK_MAX,
    pressureMirrorFloorLines: 5000,
    semanticBufferLines: 50,
    forensicsChars: 4000,
    agentOutputChars: 2000,
  },
  working: {
    mirrorScrollbackLines: 5000,
    pressureMirrorFloorLines: 1000,
    semanticBufferLines: 50,
    forensicsChars: 4000,
    agentOutputChars: 2000,
  },
  settled: {
    mirrorScrollbackLines: 2000,
    pressureMirrorFloorLines: SCROLLBACK_MIN,
    semanticBufferLines: 50,
    forensicsChars: 4000,
    agentOutputChars: 2000,
  },
  archived: {
    mirrorScrollbackLines: SCROLLBACK_MIN,
    pressureMirrorFloorLines: SCROLLBACK_MIN,
    semanticBufferLines: 10,
    forensicsChars: 1000,
    agentOutputChars: 512,
  },
};

/**
 * Preserved-snapshot cap under memory pressure. The steady-state cap is
 * MAX_PRESERVED_TERMINAL_SNAPSHOTS (20, ~80MB worst case); when the resource
 * governor runs its pre-pause reclaim it prunes down to this instead —
 * preserved snapshots are pure retained memory with no live producer, so they
 * are the safest thing to reclaim first.
 */
export const PRESSURE_MAX_PRESERVED_TERMINAL_SNAPSHOTS = 5;

/**
 * Map a terminal's observable state to its retention tier.
 *
 * Focus keeps a terminal at `foreground` even when its agent has settled —
 * the user is interacting with that pane, and alternating waiting/working on
 * a focused agent must not churn destructive trims. Visibility alone is only
 * enough for working/directing agents and plain shells; a visible-but-
 * unfocused settled agent drops to `settled` retention (the renderer keeps
 * its full scrollback either way).
 */
export function computeRetentionTier(inputs: RetentionTierInputs): TerminalRetentionTier {
  if (inputs.isTrashed || inputs.hasPreservedSnapshot) {
    return "archived";
  }
  if (inputs.isExited) {
    return "settled";
  }
  const isFrontmost = inputs.isFocused || inputs.activityTier === "active";
  if (inputs.isAgentTerminal) {
    if (inputs.agentState === "working" || inputs.agentState === "directing") {
      return isFrontmost ? "foreground" : "working";
    }
    return inputs.isFocused ? "foreground" : "settled";
  }
  return isFrontmost ? "foreground" : "settled";
}
