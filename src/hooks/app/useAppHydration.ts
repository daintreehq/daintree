import { useEffect, useRef, useState } from "react";
import { restoreViewState } from "../../utils/stateHydration/restoreViewState";
import { isElectronAvailable } from "../useElectron";
import { setStartupQuietPeriod } from "@/lib/notify";
import { releaseBootPayload } from "@/lib/bootPromise";
import { logError } from "@/utils/logger";
import type { HydrateResult } from "@shared/types/ipc/app";

export { pickBootFocusPanelId } from "../../utils/stateHydration/restoreViewState";

export function useAppHydration(
  enabled: boolean = true,
  prefetchedHydrateResult?: HydrateResult | null
) {
  const [isStateLoaded, setIsStateLoaded] = useState(false);
  const hasRestoredState = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasRestoredState.current || !enabled) {
      return;
    }

    hasRestoredState.current = true;

    const restoreState = async () => {
      try {
        await restoreViewState(prefetchedHydrateResult ?? undefined);
      } catch (error) {
        logError("Failed to restore app state", error);
      } finally {
        // Hydration has copied the boot payload into Zustand; free its heavy
        // sub-objects so the cached `use()` thenable doesn't pin them for the
        // renderer's life. Crash fields are left intact (still read post-boot).
        releaseBootPayload();
        setIsStateLoaded(true);
        setStartupQuietPeriod(5000);
      }
    };

    restoreState();
  }, [enabled, prefetchedHydrateResult]);

  return { isStateLoaded };
}
