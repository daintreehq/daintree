import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { formatTimeAgo } from "@/utils/timeAgo";

/** Visual weight of a row's status line. Maps to status tokens, never the accent. */
export type ProjectRowTone = "blocked" | "waiting" | "review" | "working" | "running" | "muted";

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
function agoPhrase(age: string): string {
  return age === "just now" ? age : `${age} ago`;
}

function pluralAgents(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/**
 * The one status line a switcher row shows.
 *
 * Ordered by what would make someone act: a blocked agent first (it has stopped
 * and input may not restart it), then agents waiting on the user, then finished
 * work awaiting review, then work in progress, then dormant states. Counts and
 * ages are carried through rather than collapsed to "Agent waiting…" — one
 * waiting agent and eight are different situations, and a wait that started
 * forty minutes ago is a different situation from one that started forty
 * seconds ago.
 */
export function getProjectRowStatus(
  project: SearchableProject,
  nowMs: number = Date.now()
): ProjectRowStatus {
  // Only surface the fragment when it actually disambiguates — a plain basename
  // is already the folder name shown beside it, so repeating it is noise.
  const pathHint = project.displayPath.includes("/") ? project.displayPath : undefined;
  const withHint = (status: Omit<ProjectRowStatus, "pathHint">): ProjectRowStatus =>
    pathHint ? { ...status, pathHint } : status;

  if (project.isMissing) {
    return withHint({ text: "Directory not found", tone: "blocked" });
  }

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

    return withHint({
      text: parts.join(" · "),
      tone: blocked > 0 ? "blocked" : "waiting",
    });
  }

  // Counts arrive from a single producer that keeps blocked a subset of
  // waiting, but a malformed payload must not silently render as idle.
  if (project.blockedAgentCount > 0) {
    return withHint({
      text: pluralAgents(project.blockedAgentCount, "Agent blocked", "agents blocked"),
      tone: "blocked",
    });
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
        return withHint({ text: "Ready for review", tone: "review" });
      }
      const finishedAge = formatWaitAge(at, nowMs);
      const text =
        nowMs - at < JUST_FINISHED_MS
          ? finishedAge === "just now"
            ? "Ready for review · just finished"
            : `Ready for review · just finished ${agoPhrase(finishedAge)}`
          : `Ready for review · finished ${agoPhrase(finishedAge)}`;
      return withHint({ text, tone: "review" });
    }

    const lead = `${count} agents ready for review`;
    if (latest === undefined || oldest === undefined) {
      return withHint({ text: lead, tone: "review" });
    }
    // Newest-to-oldest range; collapses when both round to the same value.
    const newestAge = formatRangeAge(latest, nowMs);
    const oldestAge = formatRangeAge(oldest, nowMs);
    const text =
      newestAge === oldestAge
        ? `${lead} · ${oldestAge} ago`
        : `${lead} · ${newestAge}–${oldestAge} ago`;
    return withHint({ text, tone: "review" });
  }

  if (project.activeAgentCount > 0) {
    return withHint({
      text: pluralAgents(project.activeAgentCount, "Agent running", "agents running"),
      tone: "working",
    });
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
    return withHint({ text, tone: "muted" });
  }

  if (project.processCount > 0) {
    return withHint({
      text: pluralAgents(project.processCount, "Process running", "processes running"),
      tone: "running",
    });
  }

  // Auto-closed by the background-idle sweep (#10830) — name the reason rather
  // than showing a bare time-ago that makes the project look merely stale.
  if (project.status === "closed" && project.autoParkedAt) {
    return withHint({ text: "Suspended to free memory", tone: "muted" });
  }

  // "Opened", explicitly: the browse band is frecency-ordered, so a bare
  // "13h ago" read as a sort key it isn't. The verb turns it back into what it
  // is — one useful fact about the row.
  if (project.lastOpened > 0) {
    return withHint({ text: `Opened ${formatTimeAgo(project.lastOpened)}`, tone: "muted" });
  }

  return withHint({ text: "Not opened yet", tone: "muted" });
}
