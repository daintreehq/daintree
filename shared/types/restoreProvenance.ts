import type { AgentState } from "./agent.js";

/**
 * What restore did with a pane it rebuilt from its saved snapshot (#14017): ran
 * the agent's resume command, started it without its conversation (a plain
 * shell always comes back this way), or held it. The route restore chose, not
 * a claim that the CLI reopened anything.
 */
export type TerminalRestoreDisposition = "resume" | "fresh" | "held";

/**
 * An agent state Daintree's detector reported for a pane, and when that state
 * began (#14017). Only what the host observed: never the renderer's
 * `directing` overlay or an optimistic guess made before the host confirmed.
 */
export interface TerminalAgentObservation {
  agentState: AgentState;
  /** Epoch ms; absent only on a snapshot saved before observations were kept. */
  at?: number;
}

/**
 * How the pane's current process, or its hold, came from restore (#14017).
 * Absent on a pane restore never rebuilt, and cleared once the pane is
 * restarted. Persisted, so a pane held across several restarts keeps the
 * last state Daintree saw before the first of them.
 */
export interface TerminalRestoreProvenance {
  /** When restore rebuilt the pane from its snapshot (epoch ms). */
  at: number;
  disposition: TerminalRestoreDisposition;
  /**
   * The last agent state observed for the pane before this restore. What the
   * screen last showed, never a verdict on whether the run had finished.
   */
  lastSeen?: TerminalAgentObservation;
}

/**
 * The `restored` field the terminal listing and info reads report (#14017).
 * A pane held right now reports `held` with its hold's reason, whatever the
 * record says, so the answer follows the hold rather than a stale copy of it.
 */
export interface RestoredSummary {
  at: number;
  disposition: TerminalRestoreDisposition;
  heldReason?: string;
  lastSeen?: TerminalAgentObservation;
}
