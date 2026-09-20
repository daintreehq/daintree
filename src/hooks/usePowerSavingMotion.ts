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

// Latest level from main, kept at module scope (one view per V8 context). The
// preload replays a pre-subscriber push to the first subscriber only, so an
// effect torn down and re-run (StrictMode, a remount) must not fall back to
// `active` and lose it.
let latestPowerLevel: PowerPolicyLevel = "active";

/**
 * Mirrors {@link shouldSuspendDecorativeMotion} onto `body[data-power-saving]`,
 * which the scoped loop list in `src/index.css` keys off. Deliberately separate
 * from performance mode: that is a user preference that also strips one-shot
 * transitions and backdrop effects, while this only stops what loops.
 */
export function usePowerSavingMotion(): void {
  useEffect(() => {
    const synchronizeSpinner = (element: Element) => {
      for (const animation of element.getAnimations?.() ?? []) {
        if ("animationName" in animation && animation.animationName === "spin-slow") {
          const duration = animation.effect?.getTiming().duration;
          if (typeof duration === "number" && duration > 0) {
            // Translate the shared epoch into this document's timeline, so
            // separate project views/windows align too. No recurring JS timer.
            animation.startTime = -(performance.timeOrigin % duration);
          }
        }
      }
    };
    const onAnimationStart = (event: AnimationEvent) => {
      if (event.animationName === "spin-slow" && event.target instanceof Element) {
        synchronizeSpinner(event.target);
      }
    };
    document.addEventListener("animationstart", onAnimationStart);
    document.querySelectorAll(".animate-spin-slow").forEach(synchronizeSpinner);
    const apply = () => {
      const suspend = shouldSuspendDecorativeMotion({
        powerLevel: latestPowerLevel,
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
      latestPowerLevel = snapshot.level;
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
      document.removeEventListener("animationstart", onAnimationStart);
      delete document.body.dataset.powerSaving;
    };
  }, []);
}

export function resetPowerSavingMotionForTests(): void {
  latestPowerLevel = "active";
}
