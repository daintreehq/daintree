import { HostCrashBanner } from "./HostCrashBanner";
import { WatchdogDisabledBanner } from "./WatchdogDisabledBanner";
import { SafeModeBanner } from "./SafeModeBanner";
import { RestoreConfirmationBanner } from "./RestoreConfirmationBanner";
import { MissingPrerequisiteBanner } from "./MissingPrerequisiteBanner";
import { ForgeTokenBanner } from "./ForgeTokenBanner";
import { CloudSyncBanner } from "./CloudSyncBanner";
import { RosettaBanner } from "./RosettaBanner";
import { useEffect, useState } from "react";
import { useGlobalBannerPriority } from "./useGlobalBannerPriority";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import type { BannerSeverity } from "@shared/config/windowChrome";

// Chrome tinting is decoration: a rejected report (host without the bridge, a
// window torn down mid-flight) must not surface as an unhandled rejection.
function reportBannerSeverity(severity: BannerSeverity | null): void {
  window.electron?.windowChrome?.setBannerSeverity({ severity })?.catch(() => {});
}

function activeBanner(slot: ReturnType<typeof useGlobalBannerPriority>) {
  switch (slot) {
    case "host-crash":
      return <HostCrashBanner />;
    case "watchdog-disabled":
      return <WatchdogDisabledBanner />;
    case "safe-mode":
      return <SafeModeBanner />;
    case "restore-confirmation":
      return <RestoreConfirmationBanner />;
    case "missing-prerequisite":
      return <MissingPrerequisiteBanner />;
    case "forge-token":
      return <ForgeTokenBanner />;
    case "cloud-sync":
      return <CloudSyncBanner />;
    case "rosetta":
      return <RosettaBanner />;
    default:
      return null;
  }
}

// Renders the single highest-priority active global banner at the top of the
// app. Suppressed banners are unmounted (not CSS-hidden) so any mount-driven
// effects — most notably RestoreConfirmationBanner's auto-dismiss timer — only
// run while the banner is actually visible to the user. Folding the forge
// token and cloud-sync warnings into this slot means at most one global banner
// ever shows; the priority order lives in useGlobalBannerPriority.
//
// Every banner here is pinned to the very top of the window, where it would
// otherwise render under the OS window controls (macOS traffic lights, Windows
// caption buttons). WindowControlsInsetProvider reserves that space for all of
// them, on every platform.
export function GlobalBannerCoordinator() {
  const slot = useGlobalBannerPriority();

  // The native Windows caption strip is painted above all web content, so main
  // has to be told which banner colour sits under it. The severity comes from
  // the mounted banner rather than the slot: a slot can be claimed by a banner
  // that renders nothing (HostCrashBanner during its Doherty gate,
  // ForgeTokenBanner resolving to null), and tinting for an absent banner would
  // recreate the mismatch this fixes.
  //
  // Holding it in state rather than reporting straight from the banner also
  // coalesces a swap: React commits the outgoing banner's `null` and the
  // incoming banner's severity in one pass, so the strip goes warning→error
  // instead of flashing back through the canvas.
  const [severity, setSeverity] = useState<BannerSeverity | null>(null);

  useEffect(() => {
    // Also fires with `null` when no banner is up, which is what clears a tint
    // left behind by whichever view was presenting before this one.
    reportBannerSeverity(severity);
  }, [severity]);

  // Tearing this view down leaves main holding its last severity, which would
  // outlive the banner it described.
  useEffect(() => () => reportBannerSeverity(null), []);

  useEffect(() => {
    // A cached project view keeps this component mounted while hidden, so
    // becoming visible again produces no render and no report of its own —
    // main would still be showing the previously presenting view's tint.
    const republish = () => {
      if (document.visibilityState !== "visible") return;
      reportBannerSeverity(severity);
    };
    document.addEventListener("visibilitychange", republish);
    // A cached view is parked with `setVisible(false)`, which emits no DOM
    // lifecycle event at all — `visibilitychange` never fires for the warm
    // project switch this guards. `app:view-revealed` is main's explicit signal
    // for that reveal, and it lands after the cached-view drop, so it is the
    // one that actually re-asserts the tint.
    const offRevealed = window.electron?.app?.onViewRevealed?.(() => {
      reportBannerSeverity(severity);
    });
    return () => {
      document.removeEventListener("visibilitychange", republish);
      offRevealed?.();
    };
  }, [severity]);

  const banner = activeBanner(slot);
  if (!banner) return null;
  return (
    <WindowControlsInsetProvider onSeverityChange={setSeverity}>
      {banner}
    </WindowControlsInsetProvider>
  );
}
