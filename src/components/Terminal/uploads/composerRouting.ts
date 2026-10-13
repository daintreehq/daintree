import type { TransferSource } from "@/lib/transferSources";

/**
 * Composers that take files dropped on their terminal. With "Focus the input
 * bar first" on, a drop on an agent terminal goes to the pane's composer, the
 * pane's default target, so the upload shows its progress there and the path
 * can't collide with what the user types into the agent meanwhile.
 */

/** Takes the drop and returns true, or declines it so the terminal does. */
export type ComposerDropHandler = (sources: readonly TransferSource[]) => boolean;

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

/** Hand a drop to the terminal's composer; false when it has none or it declined. */
export function routeDropToComposer(
  terminalId: string,
  sources: readonly TransferSource[]
): boolean {
  const handler = handlers.get(terminalId);
  if (!handler) return false;
  return handler(sources);
}

/** @internal Tests only. */
export function _resetComposerDropTargetsForTests(): void {
  handlers.clear();
}
