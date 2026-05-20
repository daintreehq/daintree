import { HostCrashBanner } from "./HostCrashBanner";
import { WatchdogDisabledBanner } from "./WatchdogDisabledBanner";
import { SafeModeBanner } from "./SafeModeBanner";
import { RestoreConfirmationBanner } from "./RestoreConfirmationBanner";
import { useRecoveryPriority } from "./useRecoveryPriority";

// Renders the highest-priority active global recovery banner. Suppressed
// banners are unmounted (not CSS-hidden) so any mount-driven effects — most
// notably RestoreConfirmationBanner's auto-dismiss timer — only run while the
// banner is actually visible to the user.
export function RecoveryBannerCoordinator() {
  const slot = useRecoveryPriority();

  if (slot === "host-crash") return <HostCrashBanner />;
  if (slot === "watchdog-disabled") return <WatchdogDisabledBanner />;
  if (slot === "safe-mode") return <SafeModeBanner />;
  if (slot === "restore-confirmation") return <RestoreConfirmationBanner />;
  return null;
}
