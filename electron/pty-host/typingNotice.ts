import type { PtyHostEvent } from "../../shared/types/pty-host.js";
import { terminalAnswerOf } from "../../shared/utils/terminalSubmission.js";

/**
 * Tells Main when input that reached a PTY over a renderer's MessagePort —
 * where it never passes through Main — answered the terminal's screen: Return,
 * or a key that answers an approval menu by itself. Main reads each screen to
 * tell whether its agent is waiting on the user, and needs to know the moment
 * the user answers it. Other typing is not reported.
 */
export function createTypingNotifier(
  sendEvent: (event: PtyHostEvent) => void
): (id: string, data: string) => void {
  return (id, data) => {
    const answer = terminalAnswerOf(data);
    if (answer !== null) sendEvent({ type: "terminal-input", id, answer });
  };
}
