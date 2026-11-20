import type { WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalInfo } from "./types.js";

/**
 * A run starts in this PTY (#18014): a launch, a respawn, another agent taking
 * over, a shell promoted to an agent, or Claude replaced in place by
 * `/restart` (#18018). Nothing read off the screen before `at` is its prompt.
 */
export function markPromptUnseen(terminal: TerminalInfo, at: number): void {
  terminal.promptUnseen = true;
  terminal.promptUnseenAt = at;
}

/**
 * Whether submitting `body` to `agentId` replaces the agent's process in the
 * pane (#18018): Claude Code's `/restart`, typed alone, starts a new run that
 * detection reads as the same agent, so nothing else marks it.
 */
export function restartsRunInPlace(agentId: string | undefined, body: string): boolean {
  return agentId === "claude" && body.trim() === "/restart";
}

/**
 * Whether a reading at `waitingReason` is the run's first sight of its
 * prompt: a prompt or question read off a screen that showed the agent's own
 * input row (`promptDrawnAt`, when that screen was read) after the run began
 * (#18018). A CLI that has drawn nothing yet, or a shell line with a prompt
 * glyph, settles as a prompt too, and a reading made for the previous run can
 * arrive after the swap.
 */
export function seesPromptFirst(
  terminal: TerminalInfo,
  waitingReason: WaitingReason | undefined,
  promptDrawnAt: number | undefined
): boolean {
  return (
    terminal.promptUnseen === true &&
    promptDrawnAt !== undefined &&
    (waitingReason === "prompt" || waitingReason === "question") &&
    (terminal.promptUnseenAt === undefined || promptDrawnAt > terminal.promptUnseenAt)
  );
}

/**
 * The run has been seen at the readings a guarded line may be typed at, so its
 * working from here on is a turn. Committed with the state, before the change
 * is announced, so a send gate reading the record at the announcement sees
 * both.
 */
export function notePromptSeen(terminal: TerminalInfo, promptDrawnAt: number | undefined): void {
  if (terminal.agentState !== "waiting") return;
  if (!seesPromptFirst(terminal, terminal.waitingReason, promptDrawnAt)) return;
  delete terminal.promptUnseen;
  delete terminal.promptUnseenAt;
}
