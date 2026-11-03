import type { AssistantIdentities } from "@shared/types/displayIdentity";
import { useAssistantIdentityStore } from "@/store/assistantIdentityStore";
import { logWarn } from "@/utils/logger";

/**
 * Keeps this view's copy of the assistant personas current (#16213): read
 * once, then replaced by every change main pushes, whichever view made it. A
 * push is newer than any read in flight, so a read that a push overtook is
 * dropped rather than written over it.
 */
export function initAssistantIdentitySync(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.helpAssistant;
  if (!bridge?.getIdentities || !bridge.onIdentitiesChanged) return () => {};

  let disposed = false;
  let pushes = 0;
  const apply = (identities: AssistantIdentities | undefined) => {
    if (disposed || !identities) return;
    useAssistantIdentityStore.getState().apply(identities);
  };

  const unsubscribe = bridge.onIdentitiesChanged((identities) => {
    pushes += 1;
    apply(identities);
  });

  const pushesAtRead = pushes;
  void bridge.getIdentities().then(
    (identities) => {
      if (pushes === pushesAtRead) apply(identities);
    },
    (error: unknown) => {
      logWarn("[assistantIdentity] couldn't read the assistant personas", {
        error: String(error),
      });
    }
  );

  return () => {
    disposed = true;
    unsubscribe();
  };
}
