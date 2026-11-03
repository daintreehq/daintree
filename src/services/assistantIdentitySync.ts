import type { AssistantIdentities } from "@shared/types/displayIdentity";
import { onHostResync } from "@/store/hostResyncSignal";
import { useAssistantIdentityStore } from "@/store/assistantIdentityStore";
import { logWarn } from "@/utils/logger";

/**
 * Keeps this view's copy of the assistant personas current (#16213): read
 * once, then replaced by every change main pushes, whichever view made it, and
 * read again when a remote view's link comes back with pushes possibly lost on
 * the way. A push is newer than any read in flight, so a read that a push
 * overtook is dropped rather than written over it, and of two reads in flight
 * only the later one lands.
 */
export function initAssistantIdentitySync(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.helpAssistant;
  if (!bridge?.getIdentities || !bridge.onIdentitiesChanged) return () => {};

  let disposed = false;
  let pushes = 0;
  let reads = 0;
  const apply = (identities: AssistantIdentities | undefined) => {
    if (disposed || !identities) return;
    useAssistantIdentityStore.getState().apply(identities);
  };

  const unsubscribe = bridge.onIdentitiesChanged((identities) => {
    pushes += 1;
    apply(identities);
  });

  const read = () => {
    if (disposed) return;
    const read = ++reads;
    const pushesAtRead = pushes;
    void bridge.getIdentities().then(
      (identities) => {
        if (read === reads && pushes === pushesAtRead) apply(identities);
      },
      (error: unknown) => {
        // A remote view whose host is unreachable keeps what it had; the
        // resync after the link returns reads it again.
        logWarn("[assistantIdentity] couldn't read the assistant personas", {
          error: String(error),
        });
      }
    );
  };

  const offResync = onHostResync(read);
  read();

  return () => {
    disposed = true;
    unsubscribe();
    offResync();
  };
}
