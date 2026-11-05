import { decisionsClient } from "@/clients/decisionsClient";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { DisposableStore, toDisposable } from "@/utils/disposable";

/** The draft keys whose text is more than whitespace, in a stable order. */
export function draftKeysWithText(drafts: ReadonlyMap<string, string>): string[] {
  const keys: string[] = [];
  for (const [key, value] of drafts) {
    if (value.trim().length > 0) keys.push(key);
  }
  return keys.sort();
}

/**
 * Tell main which terminals this view's hybrid input holds a draft for
 * (#16282), so a Decisions answer waits for the person writing there. Sent
 * whole, once at the start (a reload replaces what the view said before) and
 * again only when a draft appears or empties, never per keystroke.
 */
export function setupComposerDraftListeners(): DisposableStore {
  const d = new DisposableStore();
  let sent: string | null = null;
  const report = (drafts: ReadonlyMap<string, string>) => {
    const keys = draftKeysWithText(drafts);
    const signature = JSON.stringify(keys);
    if (signature === sent) return;
    sent = signature;
    decisionsClient.reportComposerDrafts(keys).catch(() => {
      // Sent again with the next change rather than assumed received.
      if (sent === signature) sent = null;
    });
  };
  d.add(
    toDisposable(
      useTerminalInputStore.subscribe((next, prev) => {
        if (next.draftInputs !== prev.draftInputs) report(next.draftInputs);
      })
    )
  );
  report(useTerminalInputStore.getState().draftInputs);
  return d;
}
