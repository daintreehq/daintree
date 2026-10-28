/**
 * Lets a focused page that isn't an app view (a browser or dev-preview guest,
 * a portal tab) hand the dictation key to the live session. The voice input
 * handlers register the claim; the page key hooks only call it, so they never
 * load the voice handlers' module graph.
 */
type PageDictationKeyClaim = (input: Electron.Input) => boolean;

let claim: PageDictationKeyClaim | null = null;

export function registerPageDictationKey(next: PageDictationKeyClaim): () => void {
  claim = next;
  return () => {
    if (claim === next) claim = null;
  };
}

/** Whether the page gives this keystroke up: true means it was the live session's. */
export function claimPageDictationKey(input: Electron.Input): boolean {
  return claim?.(input) ?? false;
}
