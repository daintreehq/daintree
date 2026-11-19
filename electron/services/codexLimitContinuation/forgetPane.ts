/**
 * How a pane or project closed for good, or a spawn the continuation doesn't
 * load for, reaches the continuation service (#17912) without loading it: the
 * service registers here once something creates it, so a session that never
 * armed anything pays nothing.
 */
export interface ContinuationForgetter {
  forgetPane(terminalId: string): void;
  forgetProject(projectId: string): void;
  noteSpawn(terminalId: string, projectId: string, launchGeneration: number): void;
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

export function noteContinuationSpawn(
  terminalId: string,
  projectId: string,
  launchGeneration: number
): void {
  forgetter?.noteSpawn(terminalId, projectId, launchGeneration);
}
