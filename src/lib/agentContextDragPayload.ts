import {
  AGENT_CONTEXT_DRAG_MIME,
  decodeAgentContextDragPayload,
  type AgentContextDragPayload,
} from "@shared/utils/agentContextDrag";

/**
 * The drop side of the agent-context drag (a plugin view handing a card, a
 * message, a row to an agent). The payload contract and its validation live in
 * `@shared/utils/agentContextDrag` because the plugin SDK ships them too; this
 * is only what a drop target needs from a `DataTransfer`.
 *
 * Unlike the in-app file drag, this one does carry `text/plain` alongside —
 * dropping the card on an editor should still paste something sensible. Every
 * agent-context drop target therefore has to claim the drag before a text-
 * accepting child (CodeMirror's own drop handler) inserts that text as well.
 */
export { AGENT_CONTEXT_DRAG_MIME };

/** Is this an agent-context drag? Safe during `dragover` — reads types only. */
export function hasAgentContextDrag(types: readonly string[]): boolean {
  return types.includes(AGENT_CONTEXT_DRAG_MIME);
}

/**
 * The payload of a drop, or `null` if it is not a valid one. Readable only at
 * `drop`: Chromium's protected mode blanks `getData` during `dragover`, so the
 * affordance is decided on the type alone and the contents are checked here.
 */
export function readAgentContextDrag(
  dataTransfer: Pick<DataTransfer, "getData">
): AgentContextDragPayload | null {
  return decodeAgentContextDragPayload(dataTransfer.getData(AGENT_CONTEXT_DRAG_MIME));
}
