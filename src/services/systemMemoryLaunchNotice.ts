import type {
  SystemMemoryEpisodeHost,
  SystemMemoryNoticeSurface,
  SystemMemoryWorkloads,
} from "@shared/types/ipc/system";
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
  /** The remote host the episode is on; absent for this machine (#18275). */
  host?: SystemMemoryEpisodeHost;
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

/** The bar's key for a machine: each machine's under one of its own (#18275). */
export function systemMemoryLaunchNoticeKey(host: SystemMemoryEpisodeHost | undefined): string {
  return host ? `${NOTICE_KEY}:${host.id}` : NOTICE_KEY;
}

/** The readings, then what the machine held when they were taken. Figures only (#12462). */
export function describeLaunchDuringMemoryEpisode(
  open: Pick<OpenEpisode, "reading" | "workloads" | "host">
): string {
  const agents = open.workloads?.agentsRunning ?? null;
  const total = open.workloads?.memoryTotalMb ?? null;
  // The machine the readings were taken on: a remote host by name (#18275).
  const where = open.host ? open.host.name : "this host";
  const subject = open.host ? open.host.name : "This host";
  const held =
    agents !== null && total !== null
      ? `When that was measured, ${pluralize(agents, "agent was", "agents were")} running on ${where}, which has ${formatTotal(total)} of memory.`
      : agents !== null
        ? `When that was measured, ${pluralize(agents, "agent was", "agents were")} running on ${where}.`
        : total !== null
          ? `${subject} has ${formatTotal(total)} of memory.`
          : null;
  return held ? `${open.reading} ${held}` : open.reading;
}

/**
 * Fed by `useSystemMemoryPressureNotice` on every publish. A worsening episode
 * refreshes the figures without re-arming the bar; recovery takes it down.
 */
export function setSystemMemoryEpisode(next: OpenEpisode | null): void {
  const previous = episode;
  episode = next;
  if (next !== null) {
    if (previous === null || previous.episodeId === next.episodeId) return;
    // A new episode re-arms the bar even if this view missed the last recovery.
    claiming = false;
    shownThisEpisode = false;
    // Another machine's episode doesn't inherit this one's bar.
    if (previous.host?.id === next.host?.id) return;
  } else {
    claiming = false;
    shownThisEpisode = false;
  }
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
    title: open.host ? `High memory use on ${open.host.name}` : "High system memory use",
    message,
    replaceKey: systemMemoryLaunchNoticeKey(open.host),
    supersedeKey: systemMemoryLaunchNoticeKey(open.host),
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
