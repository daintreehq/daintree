import { useEffect } from "react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { isElectronAvailable } from "@/hooks/useElectron";
import { useNotificationStore } from "@/store/notificationStore";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** This renderer raised the notice for the episode now open. */
let noticeRaised = false;
/** The live grid-bar entry; "" when quiet hours kept it to the inbox. */
let noticeId = "";

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** States only what was measured over threshold — never a cause (#12462). */
export function formatSystemMemoryPressureMessage(
  payload: SystemMemoryPressurePayload,
  mac: boolean
): string | null {
  const observed: string[] = [];
  if (payload.kernelPressureLevel !== null) {
    observed.push(
      `macOS reports memory pressure at its ${
        payload.kernelPressureLevel === "critical" ? "critical" : "warning"
      } level`
    );
  }
  if (payload.swapUsedPercent !== null) {
    observed.push(
      payload.swapKind === "commit"
        ? `committed memory is at ${payload.swapUsedPercent}% of its limit`
        : `swap is ${payload.swapUsedPercent}% full`
    );
  }
  if (payload.fseventsdRssMb !== null) {
    observed.push(`the fseventsd process is using ${formatGb(payload.fseventsdRssMb)} of memory`);
  }
  if (observed.length === 0) return null;
  const sentence = observed.join(" and ");
  // "macOS" keeps its own casing at the start of a sentence.
  const text = sentence.startsWith("macOS")
    ? `${sentence}.`
    : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
  // The restart advice covers what a reboot resets — swap and a grown
  // fseventsd — not a pressure level, which reflects whatever is running now.
  if (payload.swapUsedPercent === null && payload.fseventsdRssMb === null) return text;
  return `${text} Restarting your ${mac ? "Mac" : "computer"} clears this.`;
}

export function handleSystemMemoryPressure(payload: SystemMemoryPressurePayload): void {
  if (payload.status === "normal") {
    // Recovery reaches every view; only the one that raised the notice answers.
    if (!noticeRaised) return;
    noticeRaised = false;
    if (noticeId) useNotificationStore.getState().removeNotification(noticeId);
    noticeId = "";
    notify({
      type: "success",
      priority: "low",
      supersedeKey: SUPERSEDE_KEY,
      title: "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    return;
  }

  if (noticeRaised) return;
  const message = formatSystemMemoryPressureMessage(payload, isMac());
  if (!message) return;
  noticeRaised = true;
  // Main publishes once per episode. Grid-bar because the signal originates
  // outside the visible UI; `urgent: false` overrides the `host` policy default
  // so quiet hours still apply, and the bar stays until dismissed or recovered.
  noticeId = notify({
    type: "warning",
    priority: "low",
    urgent: false,
    placement: "grid-bar",
    duration: 0,
    title: "High system memory use",
    message,
    supersedeKey: SUPERSEDE_KEY,
    context: { eventKind: "host" },
  });
}

export function useSystemMemoryPressureNotice(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;
    window.electron.events.on("system:memory-pressure", handleSystemMemoryPressure);
    ipcListenerAttached = true;
  }, []);
}
