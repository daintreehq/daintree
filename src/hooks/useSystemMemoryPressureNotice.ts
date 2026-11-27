import { useEffect } from "react";
import type {
  SystemMemoryEpisodeHost,
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
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import {
  claimSystemMemoryNotice,
  releaseSystemMemoryNotice,
  setSystemMemoryEpisode,
  systemMemoryLaunchNoticeKey,
} from "@/services/systemMemoryLaunchNotice";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** The episode this renderer heard, while it is open. */
let heardEpisodeId: string | null = null;
/** The key of the machine that episode is on. */
let heardKey = SUPERSEDE_KEY;
/** The inbox row this renderer filed, so a repeat delivery refreshes it instead. */
let filedHistoryId: string | null = null;

/**
 * Each machine's notices under keys of their own (#18275): history persists
 * across views and supersedes by key, so one machine's must never retire
 * another's. A host's id, not its name, since two can share a name.
 */
function supersedeKeyFor(host: SystemMemoryEpisodeHost | undefined): string {
  return host ? `${SUPERSEDE_KEY}:${host.id}` : SUPERSEDE_KEY;
}

/** One row per episode and level, shared by every project view's inbox (#18274). */
function inboxHistoryId(supersedeKey: string, episodeId: string, critical: boolean): string {
  return `${supersedeKey}:${episodeId}:${critical ? "critical" : "warning"}`;
}

/**
 * A machine's episode rows still active in the shared inbox: its warnings and
 * the launch bar's copy.
 */
function activeEpisodeRowIds(host: SystemMemoryEpisodeHost | undefined): string[] {
  const supersedeKey = supersedeKeyFor(host);
  const launchKey = systemMemoryLaunchNoticeKey(host);
  return useNotificationHistoryStore
    .getState()
    .entries.filter(
      (e) =>
        !e.archivedAt &&
        ((e.supersedeKey === supersedeKey && e.type === "warning") || e.supersedeKey === launchKey)
    )
    .map((e) => e.id);
}

/**
 * Whether the machine the readings were taken on is a Mac: this one, or a
 * host this Shell has seen report macOS or that sent a reading only macOS has.
 */
function measuredOnMac(payload: SystemMemoryPressurePayload): boolean {
  if (!payload.host) return isMac();
  return (
    payload.host.platform === "darwin" ||
    payload.kernelPressureLevel !== null ||
    payload.fseventsdRssMb !== null
  );
}

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * States only what was measured over threshold — never a cause (#12462) — and,
 * for a remote host's readings, which host they were taken on (#18275). On
 * macOS swap is published only while it grows (#18273), so it says so rather
 * than presenting the occupancy of a dynamically sized swap as the reading.
 */
export function describeSystemMemoryReadings(
  payload: SystemMemoryPressurePayload,
  mac: boolean = measuredOnMac(payload)
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
  if (payload.host) return `On ${payload.host.name}, ${sentence}.`;
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
  if (payload.host) return `${text} Restarting ${payload.host.name} clears this.`;
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
  workloads: SystemMemoryPressurePayload["workloads"],
  host?: SystemMemoryEpisodeHost
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
    const app = host ? `Daintree on ${host.name}` : "Daintree itself";
    parts.push(`${app} uses ${formatMemory(workloads.appMemoryMb)}`);
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

/**
 * Takes down the notice this view raised, without saying anything recovered:
 * its machine sent standing state rather than a measured recovery, or this
 * view now shows another machine.
 */
function retireNotice(): void {
  setSystemMemoryEpisode(null);
  if (heardEpisodeId === null) return;
  heardEpisodeId = null;
  filedHistoryId = null;
  useSystemMemoryNoticeStore.getState().clearNotice();
  const notifications = useNotificationStore.getState();
  for (const notification of notifications.notifications) {
    if (notification.replaceKey === heardKey && !notification.dismissed) {
      notifications.dismissNotification(notification.id);
    }
  }
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
  const host = payload.host;
  const supersedeKey = supersedeKeyFor(host);
  // Another machine, or a new episode on this one that a dropped link hid the
  // recovery between: neither inherits the notice, its toast or its launch warning.
  const newEpisode = payload.status !== "normal" && payload.episodeId !== heardEpisodeId;
  if (heardEpisodeId !== null && (heardKey !== supersedeKey || newEpisode)) retireNotice();

  if (payload.status === "normal") {
    if (payload.replay) {
      retireNotice();
      return;
    }
    setSystemMemoryEpisode(null);
    // Recovery reaches every view. One that heard the episode answers, and so
    // does one that only holds its rows: a view that filed them and then
    // reloaded never heard the episode again, and nothing else would retire them.
    const held = activeEpisodeRowIds(host);
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
      replaceKey: supersedeKey,
      supersedeKey,
      // Every view that answers files the same row.
      ...(payload.episodeId ? { historyId: `${supersedeKey}:${payload.episodeId}:recovered` } : {}),
      title: host
        ? `Memory readings on ${host.name} recovered`
        : "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    // The recovery row supersedes one row; a sibling's recovery row this view
    // took up first supersedes none, and the launch bar's row has its own key.
    const history = useNotificationHistoryStore.getState();
    for (const id of held) history.archiveEntry(id);
    return;
  }

  const mac = measuredOnMac(payload);
  const reading = describeSystemMemoryReadings(payload, mac);
  const readingMessage = formatSystemMemoryPressureMessage(payload, mac);
  if (!reading || !readingMessage || !payload.episodeId) return;
  const episodeId = payload.episodeId;
  setSystemMemoryEpisode({
    episodeId,
    reading,
    workloads: payload.workloads,
    ...(host && { host }),
  });
  heardEpisodeId = episodeId;
  heardKey = supersedeKey;
  const workloads = describeSystemMemoryWorkloads(payload.workloads, host);
  const message = workloads ? `${readingMessage} ${workloads}` : readingMessage;
  const critical = payload.kernelPressureLevel === "critical";
  // The breakdown reads this machine's processes, so a host's notice has none.
  const action = host ? null : buildMemoryUseAction();
  // An ambient sidebar footer row (#13101), live in every view, and a quiet
  // inbox record, which a later level and the recovery row both supersede.
  useSystemMemoryNoticeStore.getState().setNotice({
    reading,
    detail: message,
    action,
    critical,
    ...(host && { hostName: host.name }),
  });
  const historyId = inboxHistoryId(supersedeKey, episodeId, critical);
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
  const title = critical
    ? host
      ? `Critical memory pressure on ${host.name}`
      : "Critical system memory pressure"
    : host
      ? `High memory use on ${host.name}`
      : "High system memory use";
  // Later publishes at this level only refresh the row, so the toast stays up
  // until recovery's replaceKey takes it down (#13639).
  const id = notify({
    type: "warning",
    priority: toast ? "high" : "low",
    urgent: false,
    countable: false,
    title,
    message,
    replaceKey: supersedeKey,
    supersedeKey,
    // A toast for a row another view filed stays out of the inbox, where the
    // row is, or was until the user dismissed it.
    ...(file ? { historyId } : { transient: true }),
    context: { eventKind: "host" },
    ...(action ? { actions: [action] } : {}),
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
