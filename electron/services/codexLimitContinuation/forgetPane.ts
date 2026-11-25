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
  checkpointForQuit(): Promise<void>;
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

/**
 * Daintree is quitting, before its terminals are stopped (#18193): what armed
 * panes hold is saved for a cold restore. Nothing to do when nothing was armed.
 */
export function checkpointContinuationForQuit(): Promise<void> {
  return forgetter?.checkpointForQuit() ?? Promise.resolve();
}

export function noteContinuationSpawn(
  terminalId: string,
  projectId: string,
  launchGeneration: number
): void {
  forgetter?.noteSpawn(terminalId, projectId, launchGeneration);
}
