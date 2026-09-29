import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { useEffect, useSyncExternalStore } from "react";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";
import {
  useMissingPrerequisiteStore,
  selectMissingPrerequisiteVisible,
} from "@/store/missingPrerequisiteStore";

export type GlobalBannerSlot =
  | "host-crash"
  | "watchdog-disabled"
  | "host-memory-stall"
  | "safe-mode"
  | "restore-confirmation"
  | "missing-prerequisite"
  | "plugin-document"
  | "cloud-sync"
  | "rosetta"
  | null;

// Precedence (highest first):
//   host-crash         — backend is unusable right now (#8678 motivator)
//   watchdog-disabled  — deadlock detector is gone; protection layer down (#8674)
//   host-memory-stall  — a terminal host's memory pause isn't recovering (#12375)
//   safe-mode          — panels weren't restored after a crash loop
//   restore-confirmation — informational "session recovered" toast-banner
//   missing-prerequisite — a fatal tool (Git, Node) isn't installed (#11763)
//   plugin-document    — plugin registrations need document replacement
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
// host-memory-stall sits below both because its backend is still connected and
// protected, and above safe-mode and restore-confirmation because it is a live
// problem slowing terminal output now, while those two describe the previous
// session — and neither loses anything by waiting, since restore-confirmation's
// auto-dismiss timer only runs once it's mounted.
//
// missing-prerequisite and cloud-sync sit below the recovery block.
// restore-confirmation stays above them because its auto-dismiss timer only
// runs while the banner is mounted, so it must keep that window when the
// conditions coexist. missing-prerequisite sits below the recovery block
// because the backend being down is the more urgent read, and it self-clears —
// the banner re-checks on window focus, so installing the tool mid-session
// retires it without a restart. An expired forge token is not a global banner:
// it breaks one project's forge data, so it points at the forge pill instead
// (`ForgeTokenCallout`, #12831). rosetta sits last: like
// cloud-sync it's environmental with no acute failure, but it's even more
// static — nothing in the app can change it, only reinstalling the native
// build — so any more actionable banner deserves the slot first.
export function useGlobalBannerPriority(): GlobalBannerSlot {
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const watchdogStatus = usePanelStore((s) => s.watchdogStatus);
  const hostMemoryStalled = useHostMemoryPauseStore((s) => s.snapshot?.stalled ?? false);
  const safeMode = useSafeModeStore((s) => s.safeMode);
  const safeModeDismissed = useSafeModeStore((s) => s.dismissed);
  const restoreVisible = useRestoreConfirmationStore((s) => s.visible);
  // A banner that would render nothing must not claim the slot, or the band
  // sits empty while every lower banner stays suppressed. Watchdog and
  // plugin-document honour a session dismissal that clears with the condition.
  const dismissed = useGlobalBannerDismissalStore((s) => s.dismissed);
  const resetDismissal = useGlobalBannerDismissalStore((s) => s.reset);
  const cloudSyncService = useCloudSyncBannerStore((s) => s.service);
  const rosettaVisible = useRosettaBannerStore((s) => s.visible);
  const prerequisiteVisible = useMissingPrerequisiteStore(selectMissingPrerequisiteVisible);
  const documentDiagnostics = useSyncExternalStore(
    pluginDocumentRuntime.subscribe,
    pluginDocumentRuntime.getSnapshot
  );

  const watchdogDisabled = watchdogStatus === "disabled";
  const pluginsNeedReload = documentDiagnostics.length > 0;
  useEffect(() => {
    if (!watchdogDisabled) resetDismissal("watchdog-disabled");
    if (!pluginsNeedReload) resetDismissal("plugin-document");
  }, [watchdogDisabled, pluginsNeedReload, resetDismissal]);

  if (backendStatus !== "connected") return "host-crash";
  if (watchdogDisabled && !dismissed.has("watchdog-disabled")) return "watchdog-disabled";
  if (hostMemoryStalled) return "host-memory-stall";
  if (safeMode && !safeModeDismissed) return "safe-mode";
  if (restoreVisible) return "restore-confirmation";
  if (prerequisiteVisible) return "missing-prerequisite";
  if (pluginsNeedReload && !dismissed.has("plugin-document")) return "plugin-document";
  if (cloudSyncService !== null) return "cloud-sync";
  if (rosettaVisible) return "rosetta";
  return null;
}
