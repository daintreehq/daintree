import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { formatTimeAgo } from "@/utils/timeAgo";

/** Visual weight of a row's status line. Maps to status tokens, never the accent. */
export type ProjectRowTone = "blocked" | "waiting" | "working" | "running" | "muted";

export interface ProjectRowStatus {
  /** Status sentence, or the fallback time-ago when nothing is running. */
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

function pluralAgents(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/**
 * The one status line a switcher row shows.
 *
 * Ordered by what would make someone act: a blocked agent first (it has stopped
 * and input may not restart it), then agents waiting on the user, then work in
 * progress, then dormant states. Counts and ages are carried through rather than
 * collapsed to "Agent waiting…" — one waiting agent and eight are different
 * situations, and a wait that started forty minutes ago is a different situation
 * from one that started forty seconds ago.
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
    // Both halves carry their count. Eliding it from one of them produced lines
    // like "Needs input · 1 blocked", where the same number is spelled out on
    // one side and implied on the other.
    if (needingInput > 0) {
      parts.push(needingInput === 1 ? "1 needs input" : `${needingInput} need input`);
    }
    if (blocked > 0) parts.push(`${blocked} blocked`);
    // `oldestWaitingSince` is the earliest transition across ALL waits, blocked
    // or not, so it can only ever be labelled as the oldest wait. Attaching it
    // to a blocked count would date a fresh block by an older prompt's clock.
    if (age) parts.push(project.waitingAgentCount > 1 ? `oldest ${age}` : age);

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

  if (project.activeAgentCount > 0) {
    return withHint({
      text: pluralAgents(project.activeAgentCount, "Agent running", "agents running"),
      tone: "working",
    });
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

  if (project.lastOpened > 0) {
    return withHint({ text: formatTimeAgo(project.lastOpened), tone: "muted" });
  }

  return { text: project.displayPath, tone: "muted" };
}
