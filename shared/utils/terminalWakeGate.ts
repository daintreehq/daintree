import type { AgentState, WaitingReason } from "../types/agent.js";
import { getEffectiveAgentConfig } from "../config/agentRegistry.js";

/**
 * What the wake gate reads off a terminal (#12491). Main reads it over the
 * pty-host query and the host reads its own record, so both answer from the
 * same fields.
 */
export interface WakeGateSnapshot {
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  /** Last input that could have put text in the composer; see `lastTypedInputAt`. */
  lastTypedInputAt?: number;
  detectedAgentId?: string;
  isExited?: boolean;
  hasPty?: boolean;
  /** Closed to the trash: the PTY lives on for undo, but nobody is looking at it. */
  isTrashed?: boolean;
  /** Its agent is being quit: the PTY still runs, but the run is on its way out. */
  isClosing?: boolean;
}

/** Why a wake is held: it goes out at the pane's next settle. */
export type WakeHoldReason = "working" | "typing";

/** Why a wake cannot go out while the pane stays as it is. */
export type WakeBlockReason = "approval" | "question" | "error" | "no-agent" | "not-at-prompt";

export type WakeGateVerdict =
  | { kind: "ready" }
  | { kind: "hold"; reason: WakeHoldReason }
  | { kind: "blocked"; reason: WakeBlockReason };

export interface WakeGateOptions {
  /**
   * The agent queues a message submitted mid-turn
   * (`capabilities.queuesInputWhileWorking`), so a working agent with nothing
   * typed since its turn began may be typed into now.
   */
  acceptWorking?: boolean;
  /**
   * A question asked in prose (`waitingReason: "question"`) leaves the agent
   * at its own prompt, where a typed answer is what it waits for. Approval
   * selectors and errors are classified separately and still block.
   */
  acceptQuestion?: boolean;
}

/**
 * The gate a send from one assistant to another asks (#13496): never
 * mid-turn, and a question asked in prose is still its prompt (#14475).
 */
export const ASSISTANT_SEND_GATE: WakeGateOptions = { acceptWorking: false, acceptQuestion: true };

/**
 * The gate a Decisions answer asks (#16015): only an agent waiting at its own
 * prompt. Never mid-turn, whatever its CLI queues, and never at a question,
 * which an answer typed there would read as the reply to.
 */
export const EXACT_PROMPT_GATE: WakeGateOptions = { acceptWorking: false, acceptQuestion: false };

/** The gate options for the agent running in a terminal. */
export function wakeGateOptionsFor(agentId: string | undefined): WakeGateOptions {
  if (agentId === undefined) return {};
  return {
    acceptWorking: getEffectiveAgentConfig(agentId)?.capabilities?.queuesInputWhileWorking === true,
  };
}

/**
 * Whether the terminal's agent was last observed waiting on a choice dialog
 * (#16209): a selector, not its prompt, so a line typed there picks an option
 * or is lost. Only a live agent pane can be; a shell, or a pane whose agent
 * has gone, takes a send as it always has.
 */
export function isAtChoiceDialog(snapshot: WakeGateSnapshot): boolean {
  return (
    snapshot.detectedAgentId !== undefined &&
    snapshot.isExited !== true &&
    snapshot.hasPty !== false &&
    snapshot.agentState === "waiting" &&
    snapshot.waitingReason === "approval"
  );
}

/** What a refused send says, wherever it was refused. */
export function choiceDialogRefusalMessage(terminalId: string): string {
  return `Terminal '${terminalId}' was last observed waiting on a choice dialog, which would take the text. Nothing was sent. Read its screen and answer it with keys. A dialog closed into a draft reads this way until the input row is empty or the agent next settles.`;
}

/**
 * Whether a server-authored line may be submitted to this terminal now.
 *
 * Fails closed. Only an agent observed waiting at a `prompt` qualifies, and
 * only if nothing that could have typed into its composer arrived since it
 * settled there. `idle` is the state before an agent's first turn or after a
 * kill, and may be a bare shell that would run the line as a command, so it
 * never qualifies. A missing reading is never read as safe.
 */
export function evaluateWakeGate(
  snapshot: WakeGateSnapshot,
  options: WakeGateOptions = {}
): WakeGateVerdict {
  if (
    snapshot.isExited === true ||
    snapshot.hasPty === false ||
    snapshot.isTrashed === true ||
    snapshot.isClosing === true
  ) {
    return { kind: "blocked", reason: "no-agent" };
  }
  if (snapshot.detectedAgentId === undefined) {
    return { kind: "blocked", reason: "no-agent" };
  }
  if (snapshot.agentState === "working") {
    if (options.acceptWorking !== true || snapshot.lastStateChange === undefined) {
      return { kind: "hold", reason: "working" };
    }
    // Queued behind the turn: still never on top of something typed since
    // the turn began, which the Enter would submit along with the line.
    if (
      snapshot.lastTypedInputAt !== undefined &&
      snapshot.lastTypedInputAt > snapshot.lastStateChange
    ) {
      return { kind: "hold", reason: "typing" };
    }
    return { kind: "ready" };
  }
  if (snapshot.agentState !== "waiting") {
    return { kind: "blocked", reason: "not-at-prompt" };
  }
  const reason =
    snapshot.waitingReason === "question" && options.acceptQuestion === true
      ? "prompt"
      : snapshot.waitingReason;
  if (reason === "approval" || reason === "question" || reason === "error") {
    return { kind: "blocked", reason };
  }
  if (reason !== "prompt" || snapshot.lastStateChange === undefined) {
    return { kind: "blocked", reason: "not-at-prompt" };
  }
  // Only a later settle clears this. Time alone never does: a draft left in
  // the composer is exactly as occupied an hour later.
  if (
    snapshot.lastTypedInputAt !== undefined &&
    snapshot.lastTypedInputAt >= snapshot.lastStateChange
  ) {
    return { kind: "hold", reason: "typing" };
  }
  return { kind: "ready" };
}
