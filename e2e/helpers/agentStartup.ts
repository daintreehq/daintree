// Pure decision logic for driving an agent CLI from launch to its ready screen
// (#12588). Everything here is decided from a terminal snapshot or a terminal
// info record alone, so it can be unit-tested without a credentialed E2E run.
//
// The terminal buffer reader returns every row including scrollback, so a
// startup dialog that was already answered — or one that made the agent quit —
// stays in the text indefinitely. Keystrokes must only ever be sent against a
// dialog that is still the last thing on screen.

import { isClaudeTrustRejectionSelected } from "./claudeAuth";

// The question line opens the dialog. Option text ("Yes, I trust this folder")
// is deliberately not an anchor: the options render below the question, and
// anchoring on one would cut the other options out of the block.
const TRUST_QUESTION = /quick safety check|do you trust|one you trust|trust the files/i;

const TRUST_DIALOG_LINE =
  /^\s*(?:[>❯›]\s*)?(?:\d+\.\s*)?(?:yes\b|no\b|enter to confirm|esc to (?:cancel|exit))/i;

const SELECTED_AFFIRMATIVE = /(?:^|\n)\s*[>❯›]\s*(?:\d+\.\s*)?yes\b/im;

// Some CLI releases draw the dialog inside a box. Blanking the U+2500-U+257F
// box-drawing range turns border rows into empty lines and strips the `│`
// gutter, so bordered and borderless renders read the same.
const BOX_DRAWING = /[─-╿]/g;

export type ClaudeTrustPrompt = {
  rejectionSelected: boolean;
  acceptanceSelected: boolean;
};

/**
 * The Claude folder-trust dialog, if it is still live — the last content in
 * the buffer. Returns null when no dialog is present, or when anything other
 * than the dialog's own options and footer was printed after it (a shell
 * prompt after the CLI quit, the welcome banner after it was accepted).
 */
export function findLiveClaudeTrustPrompt(text: string): ClaudeTrustPrompt | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(BOX_DRAWING, " ").split("\n");

  let questionIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TRUST_QUESTION.test(lines[i] ?? "")) {
      questionIndex = i;
      break;
    }
  }
  if (questionIndex === -1) return null;

  const after = lines.slice(questionIndex + 1);
  let lastDialogLine = -1;
  for (let i = 0; i < after.length; i++) {
    if (TRUST_DIALOG_LINE.test(after[i] ?? "")) lastDialogLine = i;
  }
  // The question has rendered but the options have not — nothing to answer yet.
  if (lastDialogLine === -1) return null;

  if (after.slice(lastDialogLine + 1).some((line) => line.trim() !== "")) return null;

  const block = [lines[questionIndex], ...after].join("\n");
  return {
    rejectionSelected: isClaudeTrustRejectionSelected(block),
    acceptanceSelected: SELECTED_AFFIRMATIVE.test(block),
  };
}

export type AgentStartupInfo = {
  hasPty?: boolean;
  agentState?: string;
} | null;

/**
 * Whether the agent process is gone. `hasPty` alone is not enough: an agent
 * launched into a shell leaves that shell running after it quits, so the
 * backend's `exited` agent state is the signal for that case.
 */
export function isAgentStartupExited(info: AgentStartupInfo): boolean {
  if (!info) return false;
  return info.hasPty === false || info.agentState === "exited";
}
