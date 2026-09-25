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

// Any single symbol is accepted as the cursor here, so an option drawn with a
// glyph the selection regexes don't know still reads as part of the dialog
// (and surfaces as "no recognizable selection" rather than as "gone").
const TRUST_DIALOG_LINE =
  /^\s*(?:[^\w\s]\s*)?(?:\d+\.\s*)?(?:yes\b|no\b|enter to confirm|esc to (?:cancel|exit))/i;

const SELECTED_AFFIRMATIVE = /(?:^|\n)\s*[>❯›]\s*(?:\d+\.\s*)?yes\b/im;

// Some CLI releases draw the dialog inside a box. Blanking the U+2500-U+257F
// box-drawing range turns border rows into empty lines and strips the `│`
// gutter, so bordered and borderless renders read the same.
const BOX_DRAWING = /[─-╿]/g;

export type ClaudeTrustPrompt = {
  rejectionSelected: boolean;
  acceptanceSelected: boolean;
  /**
   * Which arrow key moves the cursor toward the affirmative option, read from
   * the rendered order; null when either row can't be located.
   */
  acceptanceDirection: "up" | "down" | null;
};

const SELECTED_ROW = /^\s*[>❯›]/;
const AFFIRMATIVE_ROW = /^\s*(?:[^\w\s]\s*)?(?:\d+\.\s*)?yes\b/i;

// Rows the current dialog prints between its question and its options, with
// headroom for wrapping in a narrow pane. A question followed by more than this
// and no options is an orphan in scrollback (the rest of its dialog was
// erased), not a dialog that is still rendering.
const MAX_TRUST_BODY_ROWS = 8;

/**
 * The Claude folder-trust dialog, if it is still live — the last content in
 * the buffer. Returns null when no dialog is present, or when anything other
 * than the dialog's own options and footer was printed after it (a shell
 * prompt after the CLI quit, the welcome banner after it was accepted). A
 * question whose options have not rendered yet is still live, with no
 * selection, so it holds off every other startup branch until it resolves.
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
  let firstDialogLine = -1;
  let bodyRows = 0;
  for (let i = 0; i < after.length; i++) {
    const line = after[i] ?? "";
    if (TRUST_DIALOG_LINE.test(line)) {
      firstDialogLine = i;
      break;
    }
    if (line.trim() !== "" && ++bodyRows > MAX_TRUST_BODY_ROWS) return null;
  }
  if (firstDialogLine === -1) {
    return { rejectionSelected: false, acceptanceSelected: false, acceptanceDirection: null };
  }

  // Explanatory text sits between the question and the options; from the first
  // option on, only options and the footer belong to the dialog. Checking the
  // whole run — not just what follows the last dialog-shaped line — matters
  // because the next startup dialog (the API-key prompt) has the same option
  // and footer shapes, and must not be read as more of this one.
  const dialog = after.slice(firstDialogLine);
  const isDialogOrBlank = (line: string) => line.trim() === "" || TRUST_DIALOG_LINE.test(line);
  if (!dialog.every(isDialogOrBlank)) return null;

  const selectedRow = dialog.findIndex((line) => SELECTED_ROW.test(line));
  const affirmativeRow = dialog.findIndex((line) => AFFIRMATIVE_ROW.test(line));
  const block = [lines[questionIndex], ...after].join("\n");
  return {
    rejectionSelected: isClaudeTrustRejectionSelected(block),
    acceptanceSelected: SELECTED_AFFIRMATIVE.test(block),
    acceptanceDirection: directionToward(selectedRow, affirmativeRow),
  };
}

function directionToward(from: number, to: number): "up" | "down" | null {
  if (from === -1 || to === -1 || from === to) return null;
  return to < from ? "up" : "down";
}

/**
 * One read of the backend terminal record: the record itself, `"missing"` when
 * the backend reported it not found, or null when the read failed outright.
 */
export type AgentStartupInfo = { hasPty?: boolean; agentState?: string } | "missing" | null;

export type AgentPresence = { seen: boolean; missingStreak: number };

// "Not found" is also what a timed-out backend read looks like — the PTY
// client maps any RPC rejection to null, which the IPC handler reports as not
// found — so one missing read proves nothing. A PTY that really died stays
// missing on every read after it.
export const MISSING_READS_BEFORE_EXIT = 3;

export function initialAgentPresence(): AgentPresence {
  return { seen: false, missingStreak: 0 };
}

/**
 * Fold one terminal-record read into the exit decision. `hasPty` alone is not
 * enough: an agent launched into a shell leaves that shell running after it
 * quits, so the backend's `exited` agent state is the signal for that case. A
 * PTY that dies abnormally is dropped from the backend registry instead, which
 * only counts once the terminal was seen and has stayed missing for a streak —
 * before it was ever seen, missing just means it has not registered yet.
 */
export function observeAgentStartupInfo(
  presence: AgentPresence,
  info: AgentStartupInfo
): { presence: AgentPresence; exited: boolean } {
  if (info === "missing") {
    const missingStreak = presence.seen ? presence.missingStreak + 1 : 0;
    return {
      presence: { seen: presence.seen, missingStreak },
      exited: missingStreak >= MISSING_READS_BEFORE_EXIT,
    };
  }
  if (!info) return { presence, exited: false };
  return {
    presence: { seen: true, missingStreak: 0 },
    exited: info.hasPty === false || info.agentState === "exited",
  };
}
