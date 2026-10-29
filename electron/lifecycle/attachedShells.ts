export interface AttachedShell {
  clientName: string;
}

type Provider = () => AttachedShell[];

let provider: Provider | null = null;
let confirming = false;

// The remote modules load only behind a build flag, so core code reads the
// attached machines through this seam instead of importing them.
export function setAttachedShellsProvider(next: Provider | null): void {
  provider = next;
}

export function getAttachedShells(): AttachedShell[] {
  try {
    return provider?.() ?? [];
  } catch (error) {
    console.warn("[MAIN] Reading attached Shells failed:", error);
    return [];
  }
}

/** One user-facing exit confirmation at a time: a second request never stacks a dialog. */
export function isExitConfirmationPending(): boolean {
  return confirming;
}

export function setExitConfirmationPending(pending: boolean): void {
  confirming = pending;
}
