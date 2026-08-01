import type {
  SearchableProject,
  SearchableScratch,
  WorkspaceRowStatusFields,
} from "@/hooks/useProjectSwitcherPalette";
import { formatTimeAgo } from "@/utils/timeAgo";

/** Visual weight of a row's status line. Maps to status tokens, never the accent. */
export type ProjectRowTone = "blocked" | "waiting" | "review" | "working" | "running" | "muted";

/**
 * Text colour for a status line, by tone.
 *
 * Lives here rather than in the switcher that first used it because the fleet
 * overview renders the same sentences about the same states. Two surfaces
 * colouring "blocked" differently would be a worse bug than either colour being
 * individually wrong.
 */
export const ROW_TONE_CLASS: Record<ProjectRowTone, string> = {
  blocked: "text-status-danger/80",
  waiting: "text-activity-waiting",
  // Finished-awaiting-review: the completed-state hue, distinct from both the
  // warning of a wait and the success-green of a healthy process. Never danger
  // — completion is the desired outcome, not a fault.
  review: "text-activity-completed",
  working: "text-activity-working",
  running: "text-daintree-text/50",
  muted: "text-daintree-text/50",
};

export const ROW_DOT_CLASS: Record<ProjectRowTone, string> = {
  blocked: "bg-status-danger",
  waiting: "bg-status-warning",
  review: "bg-activity-completed",
  working: "bg-activity-active animate-activity-pulse",
  running: "bg-status-success",
  muted: "border border-daintree-text/20",
};

/**
 * Wording boundary between "just finished" and plain "finished" on a
 * ready-for-review line. Copy only — it never affects band membership,
 * ordering, or acknowledgement, so being wrong here costs a word, not an
 * event.
 */
export const JUST_FINISHED_MS = 15 * 60_000;

export interface ProjectRowStatus {
  /** Status sentence, or the fallback "Opened …" line when nothing is running. */
  text: string;
  tone: ProjectRowTone;
  /**
   * Disambiguating path fragment, present only when this project's folder name
   * collides with another registered project's. Rendered as a trailing segment
   * so identical-looking monorepo siblings can be told apart without giving
   * every row a second line of chrome it doesn't need.
   */
  pathHint?: string;
}

/** Compact duration for a wait that is already minutes old. Sub-minute reads as "just now". */
export function formatWaitAge(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Age for one end of a "3m–2h ago" completion range. Sub-minute clamps to
 * "1m" rather than "just now" — a range needs two comparable durations, and
 * "just now–2h ago" doesn't parse as one.
 */
function formatRangeAge(sinceMs: number, nowMs: number): string {
  const age = formatWaitAge(sinceMs, nowMs);
  return age === "just now" ? "1m" : age;
}

/** "3m" → "3m ago", "just now" stays bare — "just now ago" is not a phrase. */
export function agoPhrase(age: string): string {
  return age === "just now" ? age : `${age} ago`;
}

function pluralAgents(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

type WorkspaceActivityStatus = Omit<ProjectRowStatus, "pathHint">;

/**
 * The activity half of a row's status line — everything derived purely from
 * agent counts, and so identical for a project and a scratch.
 *
 * Ordered by what would make someone act: a blocked agent first (it has stopped
 * and input may not restart it), then agents waiting on the user, then finished
 * work awaiting review, then work in progress, then dormant states. Counts and
 * ages are carried through rather than collapsed to "Agent waiting…" — one
 * waiting agent and eight are different situations, and a wait that started
 * forty minutes ago is a different situation from one that started forty
 * seconds ago.
 *
 * Returns null when nothing is running, leaving the caller to supply the
 * dormant line its own kind understands (a project can be auto-parked; a
 * scratch only ever has an opened time).
 */
function getWorkspaceActivityStatus(
  project: WorkspaceRowStatusFields,
  nowMs: number
): WorkspaceActivityStatus | null {
  const age =
    project.oldestWaitingSince !== undefined
      ? formatWaitAge(project.oldestWaitingSince, nowMs)
      : null;

  if (project.waitingAgentCount > 0) {
    // `blockedAgentCount` is a subset of `waitingAgentCount`, so the remainder
    // is still waiting on the user and has to be reported too — collapsing a
    // "3 waiting, 1 blocked" project to "Agent blocked" would hide two agents
    // that are asking for something.
    const blocked = Math.min(project.blockedAgentCount, project.waitingAgentCount);
    const needingInput = project.waitingAgentCount - blocked;

    const parts: string[] = [];
    if (needingInput > 0) {
      // The subject rides the sentence ("Agent needs input", "3 agents need
      // input") — a bare "1 needs input" made the reader supply the noun.
      parts.push(needingInput === 1 ? "Agent needs input" : `${needingInput} agents need input`);
      if (blocked > 0) parts.push(`${blocked} blocked`);
      // `oldestWaitingSince` is the earliest transition across ALL waits,
      // blocked or not, so it can only ever be labelled as the oldest wait.
      // Attaching it to a blocked count would date a fresh block by an older
      // prompt's clock.
      if (age) {
        parts.push(
          project.waitingAgentCount > 1
            ? `oldest waiting ${age}`
            : age === "just now"
              ? age
              : `waiting ${age}`
        );
      }
    } else {
      parts.push(blocked === 1 ? "Agent blocked" : `${blocked} agents blocked`);
      if (age) parts.push(blocked > 1 ? `oldest ${age}` : age);
    }

    return {
      text: parts.join(" · "),
      tone: blocked > 0 ? "blocked" : "waiting",
    };
  }

  // Counts arrive from a single producer that keeps blocked a subset of
  // waiting, but a malformed payload must not silently render as idle.
  if (project.blockedAgentCount > 0) {
    return {
      text: pluralAgents(project.blockedAgentCount, "Agent blocked", "agents blocked"),
      tone: "blocked",
    };
  }

  // Finished work the user hasn't seen — the hand-back the attention band
  // exists for. States the action ("ready for review") and how fresh the
  // hand-back is, so a 3-minute-old completion and a 2-hour-old one stop
  // rendering identically.
  if (project.unacknowledgedCompletedAgentCount > 0) {
    const count = project.unacknowledgedCompletedAgentCount;
    const latest = project.latestUnacknowledgedCompletionAt;
    const oldest = project.oldestUnacknowledgedCompletionAt;

    if (count === 1) {
      const at = latest ?? oldest;
      if (at === undefined) {
        return { text: "Ready for review", tone: "review" };
      }
      const finishedAge = formatWaitAge(at, nowMs);
      const text =
        nowMs - at < JUST_FINISHED_MS
          ? finishedAge === "just now"
            ? "Ready for review · just finished"
            : `Ready for review · just finished ${agoPhrase(finishedAge)}`
          : `Ready for review · finished ${agoPhrase(finishedAge)}`;
      return { text, tone: "review" };
    }

    const lead = `${count} agents ready for review`;
    if (latest === undefined || oldest === undefined) {
      return { text: lead, tone: "review" };
    }
    // Newest-to-oldest range; collapses when both round to the same value.
    // The producer keeps latest >= oldest, but this formatter is defensive
    // everywhere else — a swapped pair must not render as "2h–3m ago".
    const newestAge = formatRangeAge(Math.max(latest, oldest), nowMs);
    const oldestAge = formatRangeAge(Math.min(latest, oldest), nowMs);
    const text =
      newestAge === oldestAge
        ? `${lead} · ${oldestAge} ago`
        : `${lead} · ${newestAge}–${oldestAge} ago`;
    return { text, tone: "review" };
  }

  if (project.activeAgentCount > 0) {
    return {
      text: pluralAgents(project.activeAgentCount, "Agent running", "agents running"),
      tone: "working",
    };
  }

  // Everything completed has been seen: drop the action phrase and mute. The
  // fact is still worth a line — it explains why the shell is open.
  if (project.completedAgentCount > 0) {
    const age =
      project.latestCompletionAt !== undefined
        ? agoPhrase(formatWaitAge(project.latestCompletionAt, nowMs))
        : null;
    const text =
      project.completedAgentCount === 1
        ? age
          ? `Agent finished · ${age}`
          : "Agent finished"
        : age
          ? `${project.completedAgentCount} agents finished · latest ${age}`
          : `${project.completedAgentCount} agents finished`;
    return { text, tone: "muted" };
  }

  if (project.processCount > 0) {
    return {
      text: pluralAgents(project.processCount, "Process running", "processes running"),
      tone: "running",
    };
  }

  return null;
}

/**
 * Dormant fallback shared by both kinds.
 *
 * "Opened", explicitly: the browse band is frecency-ordered, so a bare "13h ago"
 * read as a sort key it isn't. The verb turns it back into what it is — one
 * useful fact about the row.
 */
function getOpenedStatus(lastOpened: number): WorkspaceActivityStatus {
  if (lastOpened > 0) {
    return { text: `Opened ${formatTimeAgo(lastOpened)}`, tone: "muted" };
  }
  return { text: "Not opened yet", tone: "muted" };
}

/** The one status line a project row shows. */
export function getProjectRowStatus(
  project: SearchableProject,
  nowMs: number = Date.now()
): ProjectRowStatus {
  // Only surface the fragment when it actually disambiguates — a plain basename
  // is already the folder name shown beside it, so repeating it is noise.
  const pathHint = project.displayPath.includes("/") ? project.displayPath : undefined;
  const withHint = (status: WorkspaceActivityStatus): ProjectRowStatus =>
    pathHint ? { ...status, pathHint } : status;

  if (project.isMissing) {
    return withHint({ text: "Directory not found", tone: "blocked" });
  }

  const activity = getWorkspaceActivityStatus(project, nowMs);
  if (activity) return withHint(activity);

  // Auto-closed by the background-idle sweep (#10830) — name the reason rather
  // than showing a bare time-ago that makes the project look merely stale.
  if (project.status === "closed" && project.autoParkedAt) {
    return withHint({ text: "Suspended to free memory", tone: "muted" });
  }

  return withHint(getOpenedStatus(project.lastOpened));
}

/**
 * The one status line a scratch row shows (#11518).
 *
 * Same activity sentences and tones a project gets — the point of the shared
 * core — minus the states a scratch has no concept of. There is no `isMissing`
 * (the folder is app-managed), no auto-parking (scratches are never swept into
 * a closed status), and no `pathHint`: scratch paths are UUIDs under the app's
 * own directory, so a fragment of one disambiguates nothing.
 */
export function getScratchRowStatus(
  scratch: SearchableScratch,
  nowMs: number = Date.now()
): ProjectRowStatus {
  return getWorkspaceActivityStatus(scratch, nowMs) ?? getOpenedStatus(scratch.lastOpened);
}
