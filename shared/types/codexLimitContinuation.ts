import type { CodexLimitUnknownReason } from "./codexLimitReset.js";

/**
 * Continuing a Codex pane once its usage limit resets (#17909). The user arms
 * a pane from its menu; main waits for the reset #17906 resolves and the pty
 * host types the line only if the pane is still where the limit left it.
 */

/** The line typed: `continue` for a plain turn, `/goal resume` for a `/goal` run that hit the limit. */
export type CodexLimitContinueLine = "continue" | "/goal resume";

/** Why a stop wasn't waited on, or why a due continuation typed nothing. */
export type CodexLimitContinueSkipReason =
  /** #17906 couldn't say when the limit resets (credit and spend-cap stops among them). */
  | CodexLimitUnknownReason
  /** The pane's own preset falls back on usage limits and a fallback is left. */
  | "falls-back"
  /** Whether a fallback is left couldn't be told: presets unread, or a chain the preset can't be placed in. */
  | "fallback-undetermined"
  /** This reset instant was already continued once. */
  | "already-continued"
  /** The pane's host didn't answer. */
  | "host-unanswered"
  /** The pane was disarmed before the line went in. */
  | "disarmed"
  /** The process that hit the limit is gone: the pane restarted, exited or moved. */
  | "process-changed"
  /** The pane's Codex left it, or the pane is in the trash. */
  | "agent-gone"
  /** The banner left the screen. */
  | "banner-gone"
  /** Something was typed or sent to the pane after the limit. */
  | "input-since"
  /** A choice dialog showed in the pane after the limit. */
  | "dialog-since"
  /** Input of Daintree's was still waiting to be written to the pane. */
  | "input-pending"
  | "input-locked"
  | "agent-working"
  /** The pane printed while it was being checked. */
  | "output-since"
  | "unreadable-screen"
  /** Something was printed below the banner. */
  | "banner-not-last"
  | "no-composer"
  /** The composer holds text. */
  | "draft"
  /** The footer shows a goal state, or a mode hiding it, that names no known line. */
  | "unrecognized-footer"
  /** The line was refused or interrupted on its way into the pane. */
  | "not-delivered";

/** A pane's continuation as it stands. */
export type CodexLimitContinueState =
  | { status: "armed" }
  | {
      status: "waiting";
      /** Epoch ms by which the spent window has reset, as #17906 answered. */
      resetsAt: number;
      /** When the pane is checked and the line typed. */
      continueAt: number;
    }
  | { status: "continued"; at: number; line: CodexLimitContinueLine }
  | { status: "skipped"; at: number; reason: CodexLimitContinueSkipReason };

/** An armed pane. `revision` orders a list reply against pushes. */
export interface CodexLimitContinueEntry {
  terminalId: string;
  revision: number;
  state: CodexLimitContinueState;
}

/** Main's push when an armed pane's state changes; `state: null` when it is no longer armed. */
export interface CodexLimitContinueChange {
  terminalId: string;
  revision: number;
  state: CodexLimitContinueState | null;
}

/** The stop a wait is for, as the pty host holds it: its process and its banner's sighting. */
export interface CodexLimitStopRef {
  run: string;
  seq: number;
}

/** What the pty host did at the reset. */
export type CodexLimitContinueResult =
  | { status: "continued"; line: CodexLimitContinueLine }
  | { status: "skipped"; reason: CodexLimitContinueSkipReason };

/**
 * Agents a pane can be armed for: those whose limit's reset Daintree can read
 * and whose CLI doesn't wait on its own (Claude Code continues by itself).
 */
const CONTINUABLE_AGENT_IDS: ReadonlySet<string> = new Set(["codex"]);

export function canContinueAtLimitReset(agentId: string | undefined): boolean {
  return agentId !== undefined && CONTINUABLE_AGENT_IDS.has(agentId);
}
