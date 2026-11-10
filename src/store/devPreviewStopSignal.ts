type DevPreviewStopListener = (panelId: string) => void;

const listeners = new Set<DevPreviewStopListener>();

/**
 * Called when this view asks Main to stop a panel's dev server because the panel
 * is leaving the screen: sent to background, trashed or removed. The pane unmounts
 * before Main's stopped event lands, so no mounted hook is there to hear it.
 */
export function onDevPreviewStopRequested(listener: DevPreviewStopListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDevPreviewStopRequested(panelId: string): void {
  for (const listener of [...listeners]) listener(panelId);
}
