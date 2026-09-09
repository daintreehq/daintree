import type { BuiltInAgentId } from "@shared/config/agentIds";
import { getAgentConfig, type AgentInterruptStrategy } from "@shared/config/agentRegistry";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
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
        `and can lag; read the terminal to see where it actually is.`
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
