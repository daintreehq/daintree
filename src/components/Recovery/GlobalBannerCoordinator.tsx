import { HostCrashBanner } from "./HostCrashBanner";
import { WatchdogDisabledBanner } from "./WatchdogDisabledBanner";
import { SafeModeBanner } from "./SafeModeBanner";
import { RestoreConfirmationBanner } from "./RestoreConfirmationBanner";
import { GitHubTokenBanner } from "./GitHubTokenBanner";
import { CloudSyncBanner } from "./CloudSyncBanner";
import { useGlobalBannerPriority } from "./useGlobalBannerPriority";

// Renders the single highest-priority active global banner at the top of the
// app. Suppressed banners are unmounted (not CSS-hidden) so any mount-driven
// effects — most notably RestoreConfirmationBanner's auto-dismiss timer — only
// run while the banner is actually visible to the user. Folding the GitHub
// token and cloud-sync warnings into this slot means at most one global banner
// ever shows; the priority order lives in useGlobalBannerPriority.
export function GlobalBannerCoordinator() {
  const slot = useGlobalBannerPriority();

  if (slot === "host-crash") return <HostCrashBanner />;
  if (slot === "watchdog-disabled") return <WatchdogDisabledBanner />;
  if (slot === "safe-mode") return <SafeModeBanner />;
  if (slot === "restore-confirmation") return <RestoreConfirmationBanner />;
  if (slot === "github-token") return <GitHubTokenBanner />;
  if (slot === "cloud-sync") return <CloudSyncBanner />;
  return null;
}
