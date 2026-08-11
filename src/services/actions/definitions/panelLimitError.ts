/**
 * The shared tail of every "the grid is full" action failure.
 *
 * `addPanel` already shows the actionable "Panel limit reached" warning before
 * it returns `null`, so an action that refuses for this reason has nothing new
 * to tell the user — but it must still throw, or `dispatch` reports `ok` with
 * nothing on screen (#8814). Callers that map a generic failure onto their own
 * purpose-written message use this to recognise the one refusal that is
 * already reported and stay quiet instead of contradicting it.
 *
 * A suffix on the message rather than a new `ActionErrorCode`: the code union
 * is the plugin-facing error contract, and one already-reported refusal is not
 * worth widening it. Lives in its own leaf module so the two renderer call
 * sites can import the string without pulling in the action definitions graph.
 */
export const PANEL_LIMIT_ERROR_SUFFIX = "panel limit reached";

/**
 * Whether a failed dispatch refused because the grid is at its ceiling.
 * `ActionService` passes a thrown `Error`'s message through verbatim, so the
 * suffix survives the trip through `dispatch`.
 */
export function isPanelLimitError(message: string | undefined): boolean {
  return message !== undefined && message.endsWith(PANEL_LIMIT_ERROR_SUFFIX);
}
