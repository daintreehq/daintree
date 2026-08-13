import { HostCrashBanner } from "./HostCrashBanner";
import { WatchdogDisabledBanner } from "./WatchdogDisabledBanner";
import { SafeModeBanner } from "./SafeModeBanner";
import { RestoreConfirmationBanner } from "./RestoreConfirmationBanner";
import { ForgeTokenBanner } from "./ForgeTokenBanner";
import { CloudSyncBanner } from "./CloudSyncBanner";
import { RosettaBanner } from "./RosettaBanner";
import { useCallback } from "react";
import { useGlobalBannerPriority } from "./useGlobalBannerPriority";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import type { BannerSeverity } from "@shared/config/windowChrome";

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

  // The native Windows caption strip is painted above all web content, so it
  // has to be told which banner colour it is sitting on. The report comes from
  // the mounted banner rather than the slot: a slot can be claimed by a banner
  // that renders nothing (HostCrashBanner during its Doherty gate,
  // ForgeTokenBanner resolving to null), and tinting for an absent banner would
  // recreate the mismatch this fixes.
  const reportSeverity = useCallback((severity: BannerSeverity | null) => {
    void window.electron?.windowChrome?.setBannerSeverity({ severity });
  }, []);

  const banner = activeBanner(slot);
  if (!banner) return null;
  return (
    <WindowControlsInsetProvider onSeverityChange={reportSeverity}>
      {banner}
    </WindowControlsInsetProvider>
  );
}
