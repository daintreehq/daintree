interface BlockedView {
  hostId: string;
  pluginId: string;
  retry: () => void;
  /** Reset since this view was refused; it loads (and asks) again once nothing holds it back. */
  owed: boolean;
}

const blockedViews = new Set<BlockedView>();
const holds = new Set<object>();

/**
 * A view this computer refused, waiting for Settings to reset that answer.
 * Only a view already blocked when the reset lands is retried, so one asked
 * again and refused again meanwhile isn't asked a third time.
 */
export function onPluginViewConsentReset(
  hostId: string,
  pluginId: string,
  retry: () => void
): () => void {
  const view: BlockedView = { hostId, pluginId, retry, owed: false };
  blockedViews.add(view);
  return () => {
    blockedViews.delete(view);
  };
}

/** Settings forgot this computer's answer for one of a host's plugins, or all of them. */
export function notePluginViewConsentReset(hostId: string, pluginId?: string): void {
  for (const view of blockedViews) {
    if (view.hostId === hostId && (pluginId === undefined || view.pluginId === pluginId)) {
      view.owed = true;
    }
  }
  if (holds.size === 0) retryOwed();
}

/**
 * Keep reset views from asking until the returned release: the question is a
 * native dialog, and Settings is still open over the view that would raise it.
 */
export function holdPluginViewRetries(): () => void {
  const hold = {};
  holds.add(hold);
  return () => {
    if (!holds.delete(hold)) return;
    if (holds.size === 0) retryOwed();
  };
}

function retryOwed(): void {
  for (const view of [...blockedViews]) {
    if (!view.owed) continue;
    view.owed = false;
    view.retry();
  }
}

export function _resetPluginViewConsentResetsForTesting(): void {
  blockedViews.clear();
  holds.clear();
}
