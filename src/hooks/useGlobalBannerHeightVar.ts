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
 * There is no store value to read: the coordinator can hold a slot while still
 * rendering nothing (HostCrashBanner has a 400ms Doherty gate), so
 * `slot !== null` is not a height. `toolbarWrapEl`'s top edge IS the banner
 * height — the app root sits at viewport y=0 and never scrolls.
 *
 * Both elements are observed because neither alone catches every change. The
 * content row is `flex-1` with `overflow: hidden`, so its automatic minimum
 * height resolves to 0 and it absorbs banner growth. The toolbar wrapper's own
 * height moves when FleetArmingRibbon toggles — which would otherwise cancel
 * out an equal-and-opposite banner change and leave the row's size, and so the
 * published value, stale.
 *
 * rAF-coalesced per the house convention (see `rendererGlobalErrorHandlers.ts`).
 * The trade is one frame of stale offset when a banner mounts while an overlay
 * is already open; both overlays open on user action, long after the observers'
 * initial fire, so the common path is never stale.
 */
export function useGlobalBannerHeightVar(
  toolbarWrapEl: HTMLElement | null,
  contentRowEl: HTMLElement | null
): void {
  const publish = () => {
    const bannerHeight = toolbarWrapEl?.getBoundingClientRect().top ?? 0;
    document.documentElement.style.setProperty(
      GLOBAL_BANNER_HEIGHT_VAR,
      `${Math.max(0, bannerHeight)}px`
    );
  };

  useResizeObserverRaf(contentRowEl, publish);
  useResizeObserverRaf(toolbarWrapEl, publish);

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    return () => {
      rootStyle.removeProperty(GLOBAL_BANNER_HEIGHT_VAR);
    };
  }, []);
}
