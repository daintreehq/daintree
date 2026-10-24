import type { SystemMemoryWorkloads } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useNotificationStore } from "@/store/notificationStore";

const NOTICE_KEY = "system-memory-launch";

interface OpenEpisode {
  /** `describeSystemMemoryReadings` for the episode's latest publish. */
  reading: string;
  workloads: SystemMemoryWorkloads | null;
}

let episode: OpenEpisode | null = null;
/** The bar was raised for the episode now open; dismissing it never re-arms it. */
let shownThisEpisode = false;
let noticeId: string | null = null;

function formatTotal(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** The readings, then what the host held when they were taken. Figures only (#12462). */
export function describeLaunchDuringMemoryEpisode(open: OpenEpisode): string {
  const agents = open.workloads?.agentsRunning ?? null;
  const total = open.workloads?.memoryTotalMb ?? null;
  const host =
    agents !== null && total !== null
      ? `When that was measured, ${pluralize(agents, "agent was", "agents were")} running on this host, which has ${formatTotal(total)} of memory.`
      : agents !== null
        ? `When that was measured, ${pluralize(agents, "agent was", "agents were")} running on this host.`
        : total !== null
          ? `This host has ${formatTotal(total)} of memory.`
          : null;
  return host ? `${open.reading} ${host}` : open.reading;
}

/**
 * Fed by `useSystemMemoryPressureNotice` on every publish. A worsening episode
 * refreshes the figures without re-arming the bar; recovery takes it down.
 */
export function setSystemMemoryEpisode(next: OpenEpisode | null): void {
  episode = next;
  if (next !== null) return;
  shownThisEpisode = false;
  if (noticeId !== null) {
    useNotificationStore.getState().dismissNotification(noticeId);
    noticeId = null;
  }
}

/**
 * An agent the user can see was just launched in this view (#14309). While a
 * memory episode is open, say so once above the grid, with what was observed.
 * It never holds the launch: how many agents run is the user's call.
 */
export function noteVisibleAgentLaunch(): void {
  if (episode === null || shownThisEpisode) return;
  shownThisEpisode = true;
  const message = describeLaunchDuringMemoryEpisode(episode);
  noticeId =
    notify({
      type: "warning",
      placement: "grid-bar",
      priority: "low",
      urgent: false,
      countable: false,
      duration: 0,
      title: "High system memory use",
      message,
      replaceKey: NOTICE_KEY,
      supersedeKey: NOTICE_KEY,
      context: { eventKind: "host" },
    }) || null;
}

export function resetSystemMemoryLaunchNoticeForTesting(): void {
  episode = null;
  shownThisEpisode = false;
  noticeId = null;
}
