import { useEffect } from "react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { isElectronAvailable } from "@/hooks/useElectron";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import type { NotificationAction } from "@/store/notificationStore";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** This renderer raised the notice for the episode now open. */
let noticeRaised = false;
/** That notice has reported the kernel's critical level. */
let noticeCritical = false;

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** States only what was measured over threshold — never a cause (#12462). */
export function describeSystemMemoryReadings(payload: SystemMemoryPressurePayload): string | null {
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
  return sentence.startsWith("macOS")
    ? `${sentence}.`
    : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function formatSystemMemoryPressureMessage(
  payload: SystemMemoryPressurePayload,
  mac: boolean
): string | null {
  const text = describeSystemMemoryReadings(payload);
  if (text === null) return null;
  // The restart advice covers what a reboot resets — swap and a grown
  // fseventsd — not a pressure level, which reflects whatever is running now.
  if (payload.swapUsedPercent === null && payload.fseventsdRssMb === null) return text;
  return `${text} Restarting your ${mac ? "Mac" : "computer"} clears this.`;
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? formatGb(mb) : `${Math.round(mb)} MB`;
}

/**
 * Names what Daintree was hosting when the payload was published (#13529):
 * the heaviest projects' terminal trees, then Daintree's own processes. Figures
 * only — it never says which of them, if any, caused the pressure.
 */
export function describeSystemMemoryWorkloads(
  workloads: SystemMemoryPressurePayload["workloads"]
): string | null {
  if (!workloads) return null;
  const parts = workloads.projects.map((project) => {
    const owner =
      project.projectId === null
        ? "Terminals outside any project"
        : project.projectName
          ? `${project.projectName}'s terminals`
          : "A project's terminals";
    return `${owner} (${pluralize(project.terminalCount, "terminal")}) use ${formatMemory(project.memoryMb)}`;
  });
  if (workloads.appMemoryMb !== null) {
    parts.push(`Daintree itself uses ${formatMemory(workloads.appMemoryMb)}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join(". ")}.`;
}

function buildMemoryUseAction(): NotificationAction {
  return {
    label: "Show memory use",
    actionId: "diagnostics.openWhySlow",
    onClick: async () => {
      await actionService.dispatch("diagnostics.openWhySlow", undefined, { source: "user" });
    },
  };
}

export function handleSystemMemoryPressure(payload: SystemMemoryPressurePayload): void {
  if (payload.status === "normal") {
    // Recovery reaches every view; only the one that raised the notice answers.
    if (!noticeRaised) return;
    noticeRaised = false;
    noticeCritical = false;
    useSystemMemoryNoticeStore.getState().clearNotice();
    notify({
      type: "success",
      priority: "low",
      urgent: false,
      countable: false,
      // Also dismisses a critical toast still showing.
      replaceKey: SUPERSEDE_KEY,
      supersedeKey: SUPERSEDE_KEY,
      title: "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    return;
  }

  const reading = describeSystemMemoryReadings(payload);
  const readingMessage = formatSystemMemoryPressureMessage(payload, isMac());
  if (!reading || !readingMessage) return;
  // Main publishes when the episode opens and again each time it worsens, and
  // delivery dedupes per view, so a degraded payload for a raised notice is
  // always newer and replaces it rather than being dropped (#13529).
  noticeRaised = true;
  const workloads = describeSystemMemoryWorkloads(payload.workloads);
  const message = workloads ? `${readingMessage} ${workloads}` : readingMessage;
  const critical = payload.kernelPressureLevel === "critical";
  const action = buildMemoryUseAction();
  // An ambient sidebar footer row (#13101) and a quiet inbox record, which a
  // later publish and the recovery row both supersede. A move to the kernel's
  // critical level is the one step that also toasts: it is the last warning
  // before macOS starts killing processes, Daintree's terminals among them.
  useSystemMemoryNoticeStore.getState().setNotice({ reading, detail: message, action, critical });
  const toast = critical && !noticeCritical;
  noticeCritical ||= critical;
  notify({
    type: "warning",
    priority: toast ? "high" : "low",
    urgent: false,
    countable: false,
    title: critical ? "Critical system memory pressure" : "High system memory use",
    message,
    replaceKey: SUPERSEDE_KEY,
    supersedeKey: SUPERSEDE_KEY,
    context: { eventKind: "host" },
    actions: [action],
  });
}

export function useSystemMemoryPressureNotice(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;
    window.electron.events.on("system:memory-pressure", handleSystemMemoryPressure);
    ipcListenerAttached = true;
  }, []);
}
