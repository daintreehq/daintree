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

type LoopingMotionMode = "full" | "reduced" | "stopped";

/**
 * How looping motion (working spinner, activity pulses, the watched-panel bell,
 * skeleton shimmer) should run. A loop eased at display rate keeps the
 * compositor producing frames for as long as it runs, so main's power policy
 * (battery, blurred) and the `efficiency` profile drop it to a few discrete
 * steps per second. They never stop it: a window left visible beside other work
 * is still glanced at, and a frozen spinner reads as a hung agent. Motion stops
 * only where nothing can be seen at all — locked or hidden (`deep`), a hidden
 * document, or a cached view, which keeps reporting `visible` and so needs its
 * own signal (see viewCacheState).
 */
export function loopingMotionMode(signals: DecorativeMotionSignals): LoopingMotionMode {
  if (signals.powerLevel === "deep" || signals.viewCached || signals.documentHidden) {
    return "stopped";
  }
  if (signals.powerLevel === "saving" || signals.profile === "efficiency") return "reduced";
  return "full";
}

// Latest level from main, kept at module scope (one view per V8 context). The
// preload replays a pre-subscriber push to the first subscriber only, so an
// effect torn down and re-run (StrictMode, a remount) must not fall back to
// `active` and lose it.
let latestPowerLevel: PowerPolicyLevel = "active";

/**
 * Mirrors {@link loopingMotionMode} onto `body[data-power-saving]` (stopped) and
 * `body[data-motion-rate="reduced"]`, which the scoped loop lists in
 * `src/index.css` key off. Deliberately separate
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
      const mode = loopingMotionMode({
        powerLevel: latestPowerLevel,
        profile: useResourceProfileStore.getState().profile,
        viewCached: isProjectViewCached(),
        documentHidden: document.visibilityState === "hidden",
      });
      if (mode === "stopped") {
        document.body.dataset.powerSaving = "true";
      } else {
        delete document.body.dataset.powerSaving;
      }
      if (mode === "reduced") {
        document.body.dataset.motionRate = "reduced";
      } else {
        delete document.body.dataset.motionRate;
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
      delete document.body.dataset.motionRate;
    };
  }, []);
}

export function resetPowerSavingMotionForTests(): void {
  latestPowerLevel = "active";
}
