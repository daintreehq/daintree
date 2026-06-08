import { HostCrashBanner } from "./HostCrashBanner";
import { WatchdogDisabledBanner } from "./WatchdogDisabledBanner";
import { SafeModeBanner } from "./SafeModeBanner";
import { RestoreConfirmationBanner } from "./RestoreConfirmationBanner";
import { GitHubTokenBanner } from "./GitHubTokenBanner";
import { CloudSyncBanner } from "./CloudSyncBanner";
import { useGlobalBannerPriority } from "./useGlobalBannerPriority";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";

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
    case "github-token":
      return <GitHubTokenBanner />;
    case "cloud-sync":
      return <CloudSyncBanner />;
    default:
      return null;
  }
}

// Renders the single highest-priority active global banner at the top of the
// app. Suppressed banners are unmounted (not CSS-hidden) so any mount-driven
// effects — most notably RestoreConfirmationBanner's auto-dismiss timer — only
// run while the banner is actually visible to the user. Folding the GitHub
// token and cloud-sync warnings into this slot means at most one global banner
// ever shows; the priority order lives in useGlobalBannerPriority.
//
// Every banner here is pinned to the very top of the window, where it would
// otherwise render under the OS window controls (macOS traffic lights, Windows
// caption buttons). WindowControlsInsetProvider reserves that space for all of
// them, on every platform.
export function GlobalBannerCoordinator() {
  const slot = useGlobalBannerPriority();
  const banner = activeBanner(slot);
  if (!banner) return null;
  return <WindowControlsInsetProvider>{banner}</WindowControlsInsetProvider>;
}
