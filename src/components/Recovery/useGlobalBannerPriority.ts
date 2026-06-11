import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";

export type GlobalBannerSlot =
  | "host-crash"
  | "watchdog-disabled"
  | "safe-mode"
  | "restore-confirmation"
  | "forge-token"
  | "cloud-sync"
  | "rosetta"
  | null;

// Precedence (highest first):
//   host-crash         — backend is unusable right now (#8678 motivator)
//   watchdog-disabled  — deadlock detector is gone; protection layer down (#8674)
//   safe-mode          — panels weren't restored after a crash loop
//   restore-confirmation — informational "session recovered" toast-banner
//   forge-token        — a forge provider's credentials expired; auth failure, panel data broken
//   cloud-sync         — project sits in a synced folder; environmental warning
//   rosetta            — x64 build translated on Apple Silicon; permanent perf warning
// Watchdog sits below host-crash because a live host failure is more urgent
// than a downed monitor, and above safe-mode because the watchdog protects
// against the next crash whereas safe-mode is a consequence of the previous
// one. Any non-connected backend state — `"disconnected"` or `"recovering"` —
// wins the slot. HostCrashBanner internally gates the `"recovering"` variant
// behind the 400ms Doherty threshold and renders nothing under it; during
// that gate the coordinator shows nothing rather than flashing the
// lower-priority banner back in, matching the Doherty anti-flicker pattern
// used elsewhere in the app.
//
// forge-token and cloud-sync sit below the recovery block. restore-confirmation
// stays above forge-token because its auto-dismiss timer only runs while the
// banner is mounted, so it must keep that window when both conditions coexist.
// forge-token outranks cloud-sync because an expired token is an active
// failure (forge data is broken now) whereas cloud-sync is a persistent
// environmental condition with no acute failure. rosetta sits last: like
// cloud-sync it's environmental with no acute failure, but it's even more
// static — nothing in the app can change it, only reinstalling the native
// build — so any more actionable banner deserves the slot first.
export function useGlobalBannerPriority(): GlobalBannerSlot {
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const watchdogStatus = usePanelStore((s) => s.watchdogStatus);
  const safeMode = useSafeModeStore((s) => s.safeMode);
  const safeModeDismissed = useSafeModeStore((s) => s.dismissed);
  const restoreVisible = useRestoreConfirmationStore((s) => s.visible);
  const tokenUnhealthy = useForgeProviderHealthStore((s) =>
    Object.values(s.providers).some((p) => p.tokenUnhealthy)
  );
  const cloudSyncService = useCloudSyncBannerStore((s) => s.service);
  const rosettaVisible = useRosettaBannerStore((s) => s.visible);

  if (backendStatus !== "connected") return "host-crash";
  if (watchdogStatus === "disabled") return "watchdog-disabled";
  if (safeMode && !safeModeDismissed) return "safe-mode";
  if (restoreVisible) return "restore-confirmation";
  if (tokenUnhealthy) return "forge-token";
  if (cloudSyncService !== null) return "cloud-sync";
  if (rosettaVisible) return "rosetta";
  return null;
}
