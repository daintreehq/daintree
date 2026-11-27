import type { SystemMemoryNoticeSurface, SystemMemoryWorkloads } from "@shared/types/ipc/system";
import { systemClient } from "@/clients/systemClient";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useNotificationStore } from "@/store/notificationStore";

/** The bar's key, which its inbox row is filed under too. */
export const SYSTEM_MEMORY_LAUNCH_NOTICE_KEY = "system-memory-launch";
const NOTICE_KEY = SYSTEM_MEMORY_LAUNCH_NOTICE_KEY;

interface OpenEpisode {
  episodeId: string;
  /** `describeSystemMemoryReadings` for the episode's latest publish. */
  reading: string;
  workloads: SystemMemoryWorkloads | null;
}

let episode: OpenEpisode | null = null;
/**
 * The bar was raised, or Main gave it to another project view, for the episode
 * now open; dismissing it never re-arms it.
 */
let shownThisEpisode = false;
/** A claim to Main is in flight, so a second launch waits on it rather than asking again. */
let claiming = false;
let noticeId: string | null = null;

function formatTotal(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * Asks Main for one of the episode's once-only surfaces (#18274). A failed ask
 * is a refusal: a duplicate notice is worse than a missing one, and the
 * sidebar row still shows the episode.
 */
export async function claimSystemMemoryNotice(
  episodeId: string,
  surface: SystemMemoryNoticeSurface
): Promise<boolean> {
  try {
    return (await systemClient.claimMemoryNotice({ episodeId, surface })) === true;
  } catch {
    return false;
  }
}

export function releaseSystemMemoryNotice(
  episodeId: string,
  surface: SystemMemoryNoticeSurface
): void {
  try {
    void systemClient.releaseMemoryNotice({ episodeId, surface }).catch(() => {});
  } catch {
    // No bridge outside Electron.
  }
}

/** The readings, then what the host held when they were taken. Figures only (#12462). */
export function describeLaunchDuringMemoryEpisode(
  open: Pick<OpenEpisode, "reading" | "workloads">
): string {
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
  // A new episode re-arms the bar even if this view missed the last recovery.
  if (next !== null && episode !== null && next.episodeId !== episode.episodeId) {
    claiming = false;
    shownThisEpisode = false;
  }
  episode = next;
  if (next !== null) return;
  claiming = false;
  shownThisEpisode = false;
  if (noticeId !== null) {
    useNotificationStore.getState().dismissNotification(noticeId);
    noticeId = null;
  }
}

/**
 * An agent the user can see was just launched in this view (#14309). While a
 * memory episode is open, say so once above the grid, with what was observed:
 * once across every project view, so a bar closed in one project doesn't come
 * back in the next (#18274). It never holds the launch: how many agents run is
 * the user's call.
 */
export function noteVisibleAgentLaunch(): void {
  if (episode === null || shownThisEpisode || claiming) return;
  const { episodeId } = episode;
  claiming = true;
  void claimSystemMemoryNotice(episodeId, "launch-bar").then((granted) => {
    // Recovery, or a newer episode, landed while Main was answering.
    if (!claiming || episode?.episodeId !== episodeId) {
      if (granted) releaseSystemMemoryNotice(episodeId, "launch-bar");
      return;
    }
    claiming = false;
    if (!granted) {
      shownThisEpisode = true;
      return;
    }
    raiseLaunchNotice(episode, episodeId);
  });
}

function raiseLaunchNotice(open: OpenEpisode, episodeId: string): void {
  const message = describeLaunchDuringMemoryEpisode(open);
  const id = notify({
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
  });
  // A notice the quiet period or a mute swallowed leaves the next launch, in
  // any project, to try.
  if (!id) {
    releaseSystemMemoryNotice(episodeId, "launch-bar");
    return;
  }
  shownThisEpisode = true;
  noticeId = id;
}

export function resetSystemMemoryLaunchNoticeForTesting(): void {
  episode = null;
  shownThisEpisode = false;
  claiming = false;
  noticeId = null;
}
