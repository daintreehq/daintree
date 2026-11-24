/**
 * Dialog subjects for the MCP confirmation, kept apart from the preview
 * formatters so the bridge can name a request without loading them: those load
 * on the first dispatch that needs a confirmation.
 */

import type { AgentPresetMutation } from "@/services/actions/definitions/agentPresetMutation";

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

/** A dialog subject is one heading line. */
const MAX_SUBJECT_CHARS = 80;

/** The preset a write names, for the dialog title: one line, bounded. */
export function agentPresetPreviewSubject(mutation: AgentPresetMutation): string | undefined {
  const name = mutation.operation === "update" ? mutation.before.name : mutation.preset.name;
  if (typeof name !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim();
  if (flat.length === 0) return undefined;
  const points = Array.from(flat);
  return points.length > MAX_SUBJECT_CHARS
    ? `${points.slice(0, MAX_SUBJECT_CHARS - 1).join("")}…`
    : flat;
}
