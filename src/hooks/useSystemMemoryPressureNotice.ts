import { useEffect } from "react";
import type {
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "@shared/types/ipc/system";
import { isWindowAttended, notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { logError } from "@/utils/logger";
import { isElectronAvailable } from "@/hooks/useElectron";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import type { NotificationAction } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import {
  claimSystemMemoryNotice,
  releaseSystemMemoryNotice,
  setSystemMemoryEpisode,
  SYSTEM_MEMORY_LAUNCH_NOTICE_KEY,
} from "@/services/systemMemoryLaunchNotice";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** The episode this renderer heard, while it is open. */
let heardEpisodeId: string | null = null;
/** The inbox row this renderer filed, so a repeat delivery refreshes it instead. */
let filedHistoryId: string | null = null;

/** One row per episode and level, shared by every project view's inbox (#18274). */
function inboxHistoryId(episodeId: string, critical: boolean): string {
  return `${SUPERSEDE_KEY}:${episodeId}:${critical ? "critical" : "warning"}`;
}

/** The episode's rows still active in the shared inbox: its warnings and the launch bar's copy. */
function activeEpisodeRowIds(): string[] {
  return useNotificationHistoryStore
    .getState()
    .entries.filter(
      (e) =>
        !e.archivedAt &&
        ((e.supersedeKey === SUPERSEDE_KEY && e.type === "warning") ||
          e.supersedeKey === SYSTEM_MEMORY_LAUNCH_NOTICE_KEY)
    )
    .map((e) => e.id);
}

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * States only what was measured over threshold — never a cause (#12462). On
 * macOS swap is published only while it grows (#18273), so it says so rather
 * than presenting the occupancy of a dynamically sized swap as the reading.
 */
export function describeSystemMemoryReadings(
  payload: SystemMemoryPressurePayload,
  mac: boolean = isMac()
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
        : mac
          ? `swap in use grew to ${payload.swapUsedPercent}% of the swap macOS had allocated`
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
  const text = describeSystemMemoryReadings(payload, mac);
  if (text === null) return null;
  // The restart advice covers what a reboot resets — swap in use and a grown
  // fseventsd — not a pressure level, which reflects whatever is running now.
  // Swap on macOS is reported for growing, which a restart does not stop.
  const swapResets = payload.swapUsedPercent !== null && !mac;
  if (!swapResets && payload.fseventsdRssMb === null) return text;
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

let deliveries: Promise<void> = Promise.resolve();

/**
 * Deliveries are handled one at a time: each may wait on Main to answer a
 * claim, and a later one (a worsening, the recovery) must never land before an
 * earlier one has filed what Main gave it.
 */
export function handleSystemMemoryPressure(payload: SystemMemoryPressureDelivery): Promise<void> {
  deliveries = deliveries
    .then(() => applySystemMemoryPressure(payload))
    .catch((error: unknown) => logError("System memory notice failed", error));
  return deliveries;
}

async function applySystemMemoryPressure(payload: SystemMemoryPressureDelivery): Promise<void> {
  if (payload.status === "normal") {
    setSystemMemoryEpisode(null);
    // Recovery reaches every view. One that heard the episode answers, and so
    // does one that only holds its rows: a view that filed them and then
    // reloaded never heard the episode again, and nothing else would retire them.
    const held = activeEpisodeRowIds();
    if (heardEpisodeId === null && held.length === 0) return;
    heardEpisodeId = null;
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
      ...(payload.episodeId
        ? { historyId: `${SUPERSEDE_KEY}:${payload.episodeId}:recovered` }
        : {}),
      title: "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    // The recovery row supersedes one row; a sibling's recovery row this view
    // took up first supersedes none, and the launch bar's row has its own key.
    const history = useNotificationHistoryStore.getState();
    for (const id of held) history.archiveEntry(id);
    return;
  }

  const mac = isMac();
  const reading = describeSystemMemoryReadings(payload, mac);
  const readingMessage = formatSystemMemoryPressureMessage(payload, mac);
  if (!reading || !readingMessage || !payload.episodeId) return;
  const episodeId = payload.episodeId;
  setSystemMemoryEpisode({ episodeId, reading, workloads: payload.workloads });
  heardEpisodeId = episodeId;
  const workloads = describeSystemMemoryWorkloads(payload.workloads);
  const message = workloads ? `${readingMessage} ${workloads}` : readingMessage;
  const critical = payload.kernelPressureLevel === "critical";
  const action = buildMemoryUseAction();
  // An ambient sidebar footer row (#13101), live in every view, and a quiet
  // inbox record, which a later level and the recovery row both supersede.
  useSystemMemoryNoticeStore.getState().setNotice({ reading, detail: message, action, critical });
  const historyId = inboxHistoryId(episodeId, critical);
  // A move to the kernel's critical level also toasts once, in whichever view
  // the user is looking at: it is the last warning before macOS starts killing
  // processes, Daintree's terminals among them. That needn't be the view that
  // files the row, which may be in a window behind.
  const [file, toast] = await Promise.all([
    payload.fileInbox && filedHistoryId !== historyId
      ? claimSystemMemoryNotice(episodeId, critical ? "inbox-critical" : "inbox-warning")
      : false,
    critical && isWindowAttended() ? claimSystemMemoryNotice(episodeId, "critical-toast") : false,
  ]);
  if (!file) {
    // Another view filed this level's row: refresh its figures in place. A row
    // the user dismissed or archived is left gone, here and in every other
    // project, until the episode reaches a new level or a new one opens.
    useNotificationHistoryStore.getState().updateEntryMessage(historyId, message);
  } else {
    filedHistoryId = historyId;
  }
  if (!file && !toast) return;
  // Later publishes at this level only refresh the row, so the toast stays up
  // until recovery's replaceKey takes it down (#13639).
  const id = notify({
    type: "warning",
    priority: toast ? "high" : "low",
    urgent: false,
    countable: false,
    title: critical ? "Critical system memory pressure" : "High system memory use",
    message,
    replaceKey: SUPERSEDE_KEY,
    supersedeKey: SUPERSEDE_KEY,
    // A toast for a row another view filed stays out of the inbox, where the
    // row is, or was until the user dismissed it.
    ...(file ? { historyId } : { transient: true }),
    context: { eventKind: "host" },
    actions: [action],
  });
  // Quiet hours or a mute held it back, so a later delivery may try again.
  if (toast && !id) releaseSystemMemoryNotice(episodeId, "critical-toast");
}

export function useSystemMemoryPressureNotice(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;
    window.electron.events.on("system:memory-pressure", handleSystemMemoryPressure);
    ipcListenerAttached = true;
  }, []);
}
