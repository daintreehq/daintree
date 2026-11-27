import { useEffect } from "react";
import type {
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { isElectronAvailable } from "@/hooks/useElectron";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import type { NotificationAction } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import {
  reportSystemMemoryNoticeShown,
  setSystemMemoryEpisode,
} from "@/services/systemMemoryLaunchNotice";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** This renderer heard the episode now open. */
let noticeRaised = false;
/** The inbox row this renderer filed, so a repeat delivery refreshes it instead. */
let filedHistoryId: string | null = null;

/** One row per episode and level, shared by every project view's inbox (#18274). */
function inboxHistoryId(episodeId: string, critical: boolean): string {
  return `${SUPERSEDE_KEY}:${episodeId}:${critical ? "critical" : "warning"}`;
}

/** An episode's warning row is still active in the shared inbox. */
function holdsActiveEpisodeRow(): boolean {
  return useNotificationHistoryStore
    .getState()
    .entries.some((e) => e.supersedeKey === SUPERSEDE_KEY && e.type === "warning" && !e.archivedAt);
}

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

export function handleSystemMemoryPressure(payload: SystemMemoryPressureDelivery): void {
  if (payload.status === "normal") {
    setSystemMemoryEpisode(null);
    // Recovery reaches every view. One that heard the episode answers, and so
    // does one that only holds its row: a view that filed it and then reloaded
    // never heard the episode again, and nothing else would retire the row.
    if (!noticeRaised && !holdsActiveEpisodeRow()) return;
    noticeRaised = false;
    filedHistoryId = null;
    useSystemMemoryNoticeStore.getState().clearNotice();
    notify({
      type: "success",
      priority: "low",
      urgent: false,
      countable: false,
      // Also dismisses a critical toast still showing.
      replaceKey: SUPERSEDE_KEY,
      supersedeKey: SUPERSEDE_KEY,
      // Every view that answers files the same row.
      ...(payload.episodeId ? { historyId: `${SUPERSEDE_KEY}:${payload.episodeId}:recovered` } : {}),
      title: "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    return;
  }

  const reading = describeSystemMemoryReadings(payload);
  const readingMessage = formatSystemMemoryPressureMessage(payload, isMac());
  if (!reading || !readingMessage || !payload.episodeId) return;
  const episodeId = payload.episodeId;
  setSystemMemoryEpisode({
    episodeId,
    reading,
    workloads: payload.workloads,
    launchNoticeShown: payload.launchNoticeShown,
  });
  noticeRaised = true;
  const workloads = describeSystemMemoryWorkloads(payload.workloads);
  const message = workloads ? `${readingMessage} ${workloads}` : readingMessage;
  const critical = payload.kernelPressureLevel === "critical";
  const action = buildMemoryUseAction();
  // An ambient sidebar footer row (#13101), live in every view, and a quiet
  // inbox record, which a later level and the recovery row both supersede.
  useSystemMemoryNoticeStore.getState().setNotice({ reading, detail: message, action, critical });
  const historyId = inboxHistoryId(episodeId, critical);
  if (!payload.fileInbox || filedHistoryId === historyId) {
    // A view already filed this level's row: refresh its figures in place. A
    // row the user dismissed or archived is left gone, here and in every other
    // project, until the episode reaches a new level or a new one opens.
    useNotificationHistoryStore.getState().updateEntryMessage(historyId, message);
    return;
  }
  filedHistoryId = historyId;
  // A move to the kernel's critical level is the one step that also toasts: it
  // is the last warning before macOS starts killing processes, Daintree's
  // terminals among them. Views asked together file one row under one id, and
  // only the focused one toasts. Later publishes at this level only refresh the
  // row, so the toast stays up until recovery takes it down (#13639).
  notify({
    type: "warning",
    priority: critical ? "high" : "low",
    urgent: false,
    countable: false,
    title: critical ? "Critical system memory pressure" : "High system memory use",
    message,
    replaceKey: SUPERSEDE_KEY,
    supersedeKey: SUPERSEDE_KEY,
    historyId,
    context: { eventKind: "host" },
    actions: [action],
  });
  reportSystemMemoryNoticeShown(episodeId, critical ? "inbox-critical" : "inbox-warning");
}

export function useSystemMemoryPressureNotice(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;
    window.electron.events.on("system:memory-pressure", handleSystemMemoryPressure);
    ipcListenerAttached = true;
  }, []);
}
