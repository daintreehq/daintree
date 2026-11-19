/**
 * How a pane or project closed for good reaches the continuation service
 * (#17912) without loading it: the service registers here once something
 * creates it, so a close in a session that never armed anything costs nothing.
 */
export interface ContinuationForgetter {
  forgetPane(terminalId: string): void;
  forgetProject(projectId: string): void;
}

let forgetter: ContinuationForgetter | null = null;

export function setContinuationForgetter(next: ContinuationForgetter | null): void {
  forgetter = next;
}

export function forgetContinuationPane(terminalId: string): void {
  forgetter?.forgetPane(terminalId);
}

export function forgetContinuationProject(projectId: string): void {
  forgetter?.forgetProject(projectId);
}
