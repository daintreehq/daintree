import { useEffect } from "react";
import type { PowerPolicyLevel } from "@shared/types/powerPolicy";
import type { ResourceProfile } from "@shared/types/resourceProfile";
import { useResourceProfileStore } from "@/store/resourceProfileStore";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

export interface DecorativeMotionSignals {
  powerLevel: PowerPolicyLevel;
  profile: ResourceProfile;
  viewCached: boolean;
  documentHidden: boolean;
}

/**
 * Whether looping decorative motion (working spinner, activity pulses, the
 * watched-panel bell, skeleton shimmer) should stop. One looping element keeps
 * the compositor producing frames at display rate for as long as it runs, so
 * it stops whenever main's power policy is saving (battery, blurred, locked,
 * hidden), the profile is `efficiency`, or this view can't be seen. A cached
 * view needs its own signal: it keeps reporting `visible` (see viewCacheState).
 */
export function shouldSuspendDecorativeMotion(signals: DecorativeMotionSignals): boolean {
  return (
    signals.powerLevel !== "active" ||
    signals.profile === "efficiency" ||
    signals.viewCached ||
    signals.documentHidden
  );
}

/**
 * Mirrors {@link shouldSuspendDecorativeMotion} onto `body[data-power-saving]`,
 * which the scoped loop list in `src/index.css` keys off. Deliberately separate
 * from performance mode: that is a user preference that also strips one-shot
 * transitions and backdrop effects, while this only stops what loops.
 */
export function usePowerSavingMotion(): void {
  useEffect(() => {
    let powerLevel: PowerPolicyLevel = "active";

    const apply = () => {
      const suspend = shouldSuspendDecorativeMotion({
        powerLevel,
        profile: useResourceProfileStore.getState().profile,
        viewCached: isProjectViewCached(),
        documentHidden: document.visibilityState === "hidden",
      });
      if (suspend) {
        document.body.dataset.powerSaving = "true";
      } else {
        delete document.body.dataset.powerSaving;
      }
    };

    const offPolicy = window.electron?.events?.on("system:power-policy-changed", (snapshot) => {
      powerLevel = snapshot.level;
      apply();
    });
    const offLifecycle = subscribeProjectViewLifecycle(apply);
    const offProfile = useResourceProfileStore.subscribe((state, previous) => {
      if (state.profile !== previous.profile) apply();
    });
    document.addEventListener("visibilitychange", apply);
    apply();

    return () => {
      offPolicy?.();
      offLifecycle();
      offProfile();
      document.removeEventListener("visibilitychange", apply);
      delete document.body.dataset.powerSaving;
    };
  }, []);
}
