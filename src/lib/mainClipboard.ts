/**
 * Writes through the main-process clipboard. `navigator.clipboard.writeText`
 * needs the renderer document to hold focus, which it does not while a guest
 * `<webview>` has it, so every copy in a pane hosting one goes through here.
 */
export const writeMainClipboard = (text: string): Promise<void> =>
  window.electron.clipboard.writeText(text);
