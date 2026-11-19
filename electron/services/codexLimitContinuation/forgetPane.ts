/**
 * How a pane closed for good reaches the continuation service (#17912)
 * without loading it: the service registers itself here once something
 * creates it, so a close in a session that never armed anything costs nothing.
 */
let forgetter: ((terminalId: string) => void) | null = null;

export function setContinuationPaneForgetter(next: ((terminalId: string) => void) | null): void {
  forgetter = next;
}

export function forgetContinuationPane(terminalId: string): void {
  forgetter?.(terminalId);
}
