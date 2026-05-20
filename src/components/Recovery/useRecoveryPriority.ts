import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";

export type RecoveryBannerSlot =
  | "host-crash"
  | "watchdog-disabled"
  | "safe-mode"
  | "restore-confirmation"
  | null;

// Precedence (highest first):
//   host-crash         — backend is unusable right now (#8678 motivator)
//   watchdog-disabled  — deadlock detector is gone; protection layer down (#8674)
//   safe-mode          — panels weren't restored after a crash loop
//   restore-confirmation — informational "session recovered" toast-banner
// Watchdog sits below host-crash because a live host failure is more urgent
// than a downed monitor, and above safe-mode because the watchdog protects
// against the next crash whereas safe-mode is a consequence of the previous
// one. A non-connected backendStatus always wins the slot — HostCrashBanner's
// internal 400ms Doherty gate produces a brief empty slot rather than a
// flicker through to a lower-priority banner.
export function useRecoveryPriority(): RecoveryBannerSlot {
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const watchdogStatus = usePanelStore((s) => s.watchdogStatus);
  const safeMode = useSafeModeStore((s) => s.safeMode);
  const safeModeDismissed = useSafeModeStore((s) => s.dismissed);
  const restoreVisible = useRestoreConfirmationStore((s) => s.visible);

  if (backendStatus !== "connected") return "host-crash";
  if (watchdogStatus === "disabled") return "watchdog-disabled";
  if (safeMode && !safeModeDismissed) return "safe-mode";
  if (restoreVisible) return "restore-confirmation";
  return null;
}
