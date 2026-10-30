/**
 * How long main holds an MCP dispatch open, and how a confirm-gated one gets
 * longer than that while it waits on a person (#14989).
 *
 * A dispatch that never asks anyone keeps the plain deadline. One that raises
 * the approval dialog is held in phases, each granted by main when the view
 * reports it: waiting to reach the screen, then a full decision window from the
 * moment it is on screen, then the same run budget a dispatch that never asked
 * gets. Time spent queued behind another prompt never comes out of the decision
 * window, and main's own deadline stays the last word on every phase: the view
 * only offers what main has granted, and runs an approval only once main has
 * accepted it as still live.
 */

/** Main's deadline for a dispatch that is not waiting on a person. */
export const MCP_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * How long a prompt may wait to reach the screen, behind other prompts or in a
 * hidden view. Room for one prompt ahead of it to use its whole window.
 */
export const MCP_CONFIRM_QUEUE_HOLD_MS = 135_000;

/**
 * How long a person has to answer, from the moment the prompt is on screen:
 * enough to read a preview and type a name. There is still no countdown.
 */
export const MCP_CONFIRM_DECISION_MS = 120_000;

/**
 * Main's slack past the dialog's own window, so an answer given at its last
 * moment still arrives in time. The dialog closes this much before main's
 * deadline whenever it is the tighter of the two.
 */
export const MCP_CONFIRM_HOLD_GRACE_MS = 5_000;

/**
 * The longest one confirmation can hold a dispatch open: its first deadline,
 * by which its view must report it waiting, then the wait, the window and the
 * run its approval buys.
 */
export const MCP_CONFIRM_ASK_MAX_MS =
  MCP_DISPATCH_TIMEOUT_MS +
  MCP_CONFIRM_QUEUE_HOLD_MS +
  MCP_CONFIRM_DECISION_MS +
  MCP_CONFIRM_HOLD_GRACE_MS +
  MCP_DISPATCH_TIMEOUT_MS;

/**
 * The longest a confirm-gated tool call can stay open end to end. A call can
 * ask twice: an agent pane's call above its tier is approved first, and some
 * still raise their own dialog after (#12692). Every client timeout Daintree
 * sets on its own server must cover it, or the agent's CLI gives up on a call
 * the person is still answering.
 */
export const MCP_CONFIRMABLE_CALL_MAX_MS = 2 * MCP_CONFIRM_ASK_MAX_MS;
