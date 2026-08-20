import { useEffect } from "react";
import { useResizeObserverRaf } from "./useResizeObserverRaf";

export const GLOBAL_BANNER_HEIGHT_VAR = "--global-banner-height";

/**
 * Publishes the height of whatever `GlobalBannerCoordinator` is rendering above
 * the toolbar as `--global-banner-height` on `documentElement` — `0px` when no
 * banner is up. Body-portaled `position: fixed` overlays compose it with the
 * toolbar's own height so they still clear the `z-[60]` toolbar after a banner
 * has pushed it down (#11893).
 *
 * `bannerEl` must be the wrapper that holds the coordinator and nothing else, so
 * its height IS the banner height. Measuring the wrapper directly — rather than
 * inferring the offset from a neighbour's size — is what makes this correct in
 * the degenerate cases: a banner that grows while the ribbon shrinks by the same
 * amount, or one that grows after the content area has already collapsed to 0,
 * both leave every other element's size untouched.
 *
 * There is no store value to read instead: the coordinator can hold a slot while
 * still rendering nothing (HostCrashBanner has a 400ms Doherty gate), so
 * `slot !== null` is not a height.
 *
 * rAF-coalesced per the house convention (see `rendererGlobalErrorHandlers.ts`).
 * The trade is one frame of stale offset when a banner mounts while an overlay
 * is already open; both overlays open on user action, long after the observer's
 * initial fire, so the common path is never stale.
 */
export function useGlobalBannerHeightVar(bannerEl: HTMLElement | null): void {
  useResizeObserverRaf(bannerEl, () => {
    const height = bannerEl?.getBoundingClientRect().height ?? 0;
    document.documentElement.style.setProperty(
      GLOBAL_BANNER_HEIGHT_VAR,
      `${Math.max(0, height)}px`
    );
  });

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    return () => {
      rootStyle.removeProperty(GLOBAL_BANNER_HEIGHT_VAR);
    };
  }, []);
}
