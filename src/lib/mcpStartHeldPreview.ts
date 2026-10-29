/**
 * The confirm preview for `terminal.startHeld` (#15270).
 *
 * Which conversation a held pane continues is the choice restore left to the
 * user (#12434), so the approval has to show the one being made: the dialog's
 * collapsed argument summary carries `start` out of sight, and never the
 * conversation id at all. Read from the pane at modal-open, the same state
 * `run()` reads, so a pane that has left its hold says so before anyone
 * approves a start that will be refused.
 */

import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

export type StartHeldChoice = "resume" | "fresh";

/** What the pane showed at modal-open, or undefined when it isn't a held pane. */
export interface StartHeldPaneSnapshot {
  title: string | undefined;
  reason: string;
  sessionId: string | undefined;
}

const MAX_TITLE_CHARS = 200;
/** A dialog subject is one heading line, so it gets a tighter bound than the card. */
export const MAX_START_HELD_SUBJECT_CHARS = 80;

/**
 * One line, bounded by code point. The title is free text an agent can set, and
 * a line terminator inside it would let the text after it start a line of its
 * own, caution marker included; unbounded, it would push the dialog's buttons
 * out of reach as its subject.
 */
export function boundStartHeldTitle(title: string, maxChars = MAX_TITLE_CHARS): string {
  const flat = title.replace(/[\r\n]+/g, " ");
  const points = Array.from(flat);
  return points.length > maxChars ? `${points.slice(0, maxChars - 1).join("")}…` : flat;
}

export function formatStartHeldPreviewLines(
  start: StartHeldChoice,
  pane: StartHeldPaneSnapshot | undefined
): string[] {
  if (pane === undefined) {
    return [`${MCP_PREVIEW_CAUTION_PREFIX}This pane isn't held, so the start will be refused.`];
  }
  const lines = [
    ...(pane.title ? [`Pane: ${boundStartHeldTitle(pane.title)}`] : []),
    `Held: ${pane.reason}`,
  ];
  if (start === "fresh") {
    lines.push(
      pane.sessionId === undefined
        ? "Starts: a new conversation"
        : `Starts: a new conversation, not the recorded one (${pane.sessionId})`
    );
    return lines;
  }
  if (pane.sessionId === undefined) {
    lines.push(
      `${MCP_PREVIEW_CAUTION_PREFIX}No conversation was recorded, so the resume will be refused.`
    );
    return lines;
  }
  lines.push(`Resumes: the conversation its hold recorded (${pane.sessionId})`);
  return lines;
}
