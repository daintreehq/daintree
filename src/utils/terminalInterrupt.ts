import type { BuiltInAgentId } from "@shared/config/agentIds";
import { getAgentConfig, type AgentInterruptStrategy } from "@shared/config/agentRegistry";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { WaitingReason } from "@shared/types/agent";
import { getBuiltInRuntimeAgentId } from "@/utils/terminalType";

/**
 * How much is known about the target's response to a double-Escape (#12338).
 *
 * `advertised` — the CLI prints an Escape-to-interrupt affordance while it
 * works, so the keystrokes address the key it named.
 * `unverified` — the CLI advertises nothing, so this is the sequence Daintree
 * sends everywhere and no more than that. The keystrokes still go out; what
 * must not happen is a caller reading the result as proof they landed.
 *
 * There is deliberately no third value for "known not to work": an agent whose
 * own footer names a different key is refused before anything is written, so it
 * never reaches a result at all.
 */
export type TerminalInterruptSupport = "advertised" | "unverified";

export interface TerminalInterruptTarget {
  eligible: true;
  terminalId: string;
  agentId: BuiltInAgentId;
  /** Passive observation at assessment time, never proof of an active turn. */
  agentState: "working" | "waiting";
  support: TerminalInterruptSupport;
}

export interface TerminalInterruptRefusal {
  eligible: false;
  /** Ready to throw: written for the caller that named this terminal. */
  reason: string;
}

export type TerminalInterruptAssessment = TerminalInterruptTarget | TerminalInterruptRefusal;

/**
 * The `waiting` reasons that mean a turn is still in flight, and so still has
 * something to cancel. Everything else — an empty prompt, or no reason recorded
 * at all — is treated as idle.
 */
const INTERRUPTIBLE_WAITING_REASONS = new Set<WaitingReason | undefined>([
  "question",
  "approval",
  "error",
]);

function refuse(reason: string): TerminalInterruptRefusal {
  return { eligible: false, reason };
}

/**
 * Decide whether a double-Escape should be written to one explicitly named
 * panel, and what is honestly knowable about the result (#12338).
 *
 * Deliberately not `isFleetInterruptAgentEligible`. That predicate serves a
 * bulk action over an armed set, so it also demands a grid location — the
 * collapsed dock has nowhere to paint the armed state that warns a user their
 * keystrokes are being broadcast. None of that applies to a caller that named
 * one panel it created: a docked or backgrounded agent is exactly as
 * interruptible, and refusing it would make the tool's reach depend on where
 * the user happened to park the pane. Trash and dead PTYs are still out.
 *
 * Pure: no store reads, no writes. The caller supplies the panel.
 */
export function assessTerminalInterrupt(
  panel: PanelInstance | undefined,
  terminalId: string
): TerminalInterruptAssessment {
  if (!panel || !isPtyPanel(panel)) {
    return refuse(
      `Panel "${terminalId}" is not a terminal with a process, so there is nothing to interrupt.`
    );
  }
  if (panel.location === "trash") {
    return refuse(`Terminal "${terminalId}" is in the trash and its process is being torn down.`);
  }
  if (panel.hasPty === false) {
    return refuse(`Terminal "${terminalId}" has no process attached, so there is nothing running.`);
  }
  if (panel.runtimeStatus === "exited" || panel.runtimeStatus === "error") {
    return refuse(`Terminal "${terminalId}" has already exited, so there is nothing to interrupt.`);
  }
  // Restart locks the *managed* terminal without touching the persisted
  // `isInputLocked`, and publishes `agentState: "working"` before the
  // replacement process is even spawned (`panelRegistry/restart.ts`). So a
  // restarting panel looks like a busy agent to every check below it, and the
  // keystrokes would land in the shutdown/startup window the transient lock
  // exists to protect.
  if (panel.isRestarting === true) {
    return refuse(
      `Terminal "${terminalId}" is restarting, so there is no turn to stop yet. Wait for the agent ` +
        `to come back up.`
    );
  }
  // A restart that failed after tearing down the old process clears
  // `isRestarting` and records the error, but leaves the synthetic `working`
  // state and the old process fields behind — so the panel reads as a busy
  // agent with nothing actually running under it.
  if (panel.restartError !== undefined) {
    return refuse(
      `Terminal "${terminalId}" has a failed restart on it, so there is no agent process to ` +
        `interrupt. Restart it again, or close the panel.`
    );
  }
  if (panel.isInputLocked === true) {
    return refuse(
      `Terminal "${terminalId}" has input locked, so keystrokes sent to it would be discarded. ` +
        `Unlock it first, or close the panel if the goal is to stop the work outright.`
    );
  }

  const agentId = getBuiltInRuntimeAgentId(panel);
  if (agentId === undefined) {
    return refuse(
      `Terminal "${terminalId}" is not running a recognised agent — it is a plain shell, or an ` +
        `agent Daintree has no interrupt convention for. A shell command is stopped from the ` +
        `terminal itself; there is no interrupt to send here.`
    );
  }

  const strategy: AgentInterruptStrategy | undefined =
    getAgentConfig(agentId)?.capabilities?.interrupt;
  if (strategy === "ctrl-c") {
    return refuse(
      `The agent in terminal "${terminalId}" (${agentId}) advertises Ctrl+C as its interrupt, not ` +
        `Escape. Daintree only sends Escape, so nothing was written — reporting this as sent ` +
        `would be a claim about a key that agent never bound. Stop it from the terminal itself, ` +
        `or close the panel if losing the session is acceptable.`
    );
  }

  // A heuristic, and one that is often wrong (`AgentStateService` reads it off
  // PTY output). It gates anyway: with no turn in flight there is nothing to
  // cancel, and a stray second Escape is not inert — in Claude's TUI it opens
  // the session rewind menu. Refusing beats writing into an idle prompt.
  const agentState = panel.agentState;
  if (agentState !== "working" && agentState !== "waiting") {
    return refuse(
      `The agent in terminal "${terminalId}" was last observed ${agentState ?? "in no known state"}, ` +
        `not mid-turn, so no interrupt was sent. This reading comes from the agent's own output ` +
        `and can lag; read the terminal's output to see where it actually is.`
    );
  }
  // `waiting` is several situations wearing one name, and only some are a turn
  // in flight. A question, an approval selector or a blocking error all still
  // have something to cancel; `"prompt"` is documented as an empty input prompt
  // — safe to auto-drive, which is to say idle. An absent reason is idle too
  // often to treat as a turn: the completion timer emits an unclassified idle,
  // and the state machine routes that `completed -> waiting` with no reason set,
  // so a finished agent arrives here looking interruptible.
  //
  // Hence a positive test rather than a denylist. Sending is the side-effecting
  // direction — a second Escape at an idle Claude prompt opens the session
  // rewind menu rather than doing nothing — so an unclassified wait is refused,
  // and a new `WaitingReason` added later is refused until someone decides it
  // means a turn is running.
  if (agentState === "waiting" && !INTERRUPTIBLE_WAITING_REASONS.has(panel.waitingReason)) {
    return refuse(
      `The agent in terminal "${terminalId}" is waiting rather than running a turn` +
        `${panel.waitingReason === undefined ? "" : ` (${panel.waitingReason})`}, so no interrupt ` +
        `was sent. Submit the next instruction instead of stopping it, or read the terminal's ` +
        `output to see what it is waiting on.`
    );
  }

  return {
    eligible: true,
    terminalId,
    agentId,
    agentState,
    support: strategy === "double-escape" ? "advertised" : "unverified",
  };
}
