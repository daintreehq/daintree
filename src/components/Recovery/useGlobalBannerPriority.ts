import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import {
  useMissingPrerequisiteStore,
  selectMissingPrerequisiteVisible,
} from "@/store/missingPrerequisiteStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

export type GlobalBannerSlot =
  | "host-crash"
  | "watchdog-disabled"
  | "safe-mode"
  | "restore-confirmation"
  | "missing-prerequisite"
  | "forge-token"
  | "project-plugin-trust"
  | "cloud-sync"
  | "rosetta"
  | null;

// Precedence (highest first):
//   host-crash         — backend is unusable right now (#8678 motivator)
//   watchdog-disabled  — deadlock detector is gone; protection layer down (#8674)
//   safe-mode          — panels weren't restored after a crash loop
//   restore-confirmation — informational "session recovered" toast-banner
//   missing-prerequisite — a fatal tool (Git, Node) isn't installed (#11763)
//   forge-token        — a forge provider's credentials expired; auth failure, panel data broken
//   project-plugin-trust — this project ships plugins and has not been answered for
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
// missing-prerequisite, forge-token and cloud-sync sit below the recovery
// block. restore-confirmation stays above them all because its auto-dismiss
// timer only runs while the banner is mounted, so it must keep that window when
// the conditions coexist. missing-prerequisite outranks forge-token on blast
// radius: an expired token breaks one panel's data, whereas a missing Git
// breaks every git operation in the app. It sits below the recovery block
// because the backend being down is the more urgent read, and it self-clears —
// the banner re-checks on window focus, so installing the tool mid-session
// retires it without a restart. forge-token outranks cloud-sync because an expired token is an active
// failure (forge data is broken now) whereas cloud-sync is a persistent
// environmental condition with no acute failure. rosetta sits last: like
// cloud-sync it's environmental with no acute failure, but it's even more
// static — nothing in the app can change it, only reinstalling the native
// build — so any more actionable banner deserves the slot first.
// project-plugin-trust sits between forge-token and cloud-sync. It is a
// question rather than a fault, so it yields to every active failure above it;
// but it is the only banner here the user can actually answer, and nothing in
// the project's plugins folder runs until they do, so it outranks the two
// static environmental warnings below. It was a modal until #12212 — not
// blocking the terminal an agent is typing into is the whole point of moving it
// into this slot, and dismissing it records nothing because
// `ProjectPluginIndicator` keeps carrying the offer in the sidebar footer.
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
  const prerequisiteVisible = useMissingPrerequisiteStore(selectMissingPrerequisiteVisible);
  const projectPluginPrompt = useProjectPluginStore((s) => s.prompt);

  if (backendStatus !== "connected") return "host-crash";
  if (watchdogStatus === "disabled") return "watchdog-disabled";
  if (safeMode && !safeModeDismissed) return "safe-mode";
  if (restoreVisible) return "restore-confirmation";
  if (prerequisiteVisible) return "missing-prerequisite";
  if (tokenUnhealthy) return "forge-token";
  if (projectPluginPrompt !== null) return "project-plugin-trust";
  if (cloudSyncService !== null) return "cloud-sync";
  if (rosettaVisible) return "rosetta";
  return null;
}
