import { useEffect, useState } from "react";

/**
 * Keeps a conditionally-rendered component mounted after its first open so exit
 * animations can run. Hosts that gate on `{isOpen && <Comp />}` unmount in the
 * same React commit that flips `isOpen` to false, which kills any exit
 * transition driven by `useAnimatedPresence` (the closed render never happens).
 *
 * Latches `true` on the first open and never resets, so `(isOpen || hasOpened)`
 * stays mounted for the lifetime of the host. The component's own
 * `useAnimatedPresence`/`shouldRender` gate handles DOM removal once the exit
 * animation completes. Pass `isOpen` through to the component unchanged.
 */
export function useKeepMounted(isOpen: boolean): boolean {
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);

  return isOpen || hasOpened;
}
