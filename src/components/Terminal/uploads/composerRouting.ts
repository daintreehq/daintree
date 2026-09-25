import type { TransferSource } from "@/lib/transferSources";

/**
 * Composers that take files dropped on their terminal. In a remote window a
 * drop on an agent terminal is routed into the pane's composer, so the upload
 * has somewhere to show its progress and the path can't collide with what the
 * user types into the agent meanwhile.
 */

export type ComposerDropHandler = (sources: readonly TransferSource[]) => void;

const handlers = new Map<string, ComposerDropHandler>();

export function registerComposerDropTarget(
  terminalId: string,
  handler: ComposerDropHandler
): () => void {
  handlers.set(terminalId, handler);
  return () => {
    if (handlers.get(terminalId) === handler) handlers.delete(terminalId);
  };
}

/** Hand a drop to the terminal's composer; false when it has none. */
export function routeDropToComposer(
  terminalId: string,
  sources: readonly TransferSource[]
): boolean {
  const handler = handlers.get(terminalId);
  if (!handler) return false;
  handler(sources);
  return true;
}

/** @internal Tests only. */
export function _resetComposerDropTargetsForTests(): void {
  handlers.clear();
}
