import { GIT_SUBJECT_MAX_BYTES, PULSE_RECENT_COMMITS_MAX } from "../config/gitReadLimits.js";
import type { CommitItem, HeatCell, ProjectPulse } from "../types/pulse.js";
import { truncateUtf8 } from "./boundedOutput.js";

/**
 * A pulse as `git.getProjectPulse` hands it back. Hand-projected rather than
 * spread: dispatch parses against `resultSchema` now (#11539), but building the
 * object explicitly keeps an added upstream field from depending on that parse
 * to stay unannounced. The heatmap stays whole — it is what the renderer pulse
 * card charts, and `rangeDays` (<= 180) already bounds it.
 */
export function projectPulseForAction(pulse: ProjectPulse, rangeDays: number) {
  return {
    worktreeId: pulse.worktreeId,
    worktreePath: pulse.worktreePath,
    branch: pulse.branch,
    mainBranch: pulse.mainBranch,
    rangeDays: pulse.rangeDays,
    generatedAt: pulse.generatedAt,
    heatmap: (pulse.heatmap ?? []).slice(-rangeDays).map((cell: HeatCell) => ({
      date: cell.date,
      count: cell.count,
      level: cell.level,
      isToday: cell.isToday,
      isMostRecentActive: cell.isMostRecentActive,
      isBeforeProject: cell.isBeforeProject,
    })),
    commitsInRange: pulse.commitsInRange,
    activeDays: pulse.activeDays,
    projectAgeDays: pulse.projectAgeDays,
    currentStreakDays: pulse.currentStreakDays,
    recentCommits: (pulse.recentCommits ?? [])
      .slice(0, PULSE_RECENT_COMMITS_MAX)
      .map((commit: CommitItem) => ({
        sha: commit.sha,
        subject: truncateUtf8(commit.subject ?? "", GIT_SUBJECT_MAX_BYTES).text,
        authorName:
          commit.authorName === undefined
            ? undefined
            : truncateUtf8(commit.authorName, GIT_SUBJECT_MAX_BYTES).text,
        timestamp: commit.timestamp,
      })),
    uncommitted: pulse.uncommitted && {
      changedFiles: pulse.uncommitted.changedFiles,
      insertions: pulse.uncommitted.insertions,
      deletions: pulse.uncommitted.deletions,
      lastUpdated: pulse.uncommitted.lastUpdated,
    },
    deltaToMain: pulse.deltaToMain && {
      baseBranch: pulse.deltaToMain.baseBranch,
      headBranch: pulse.deltaToMain.headBranch,
      ahead: pulse.deltaToMain.ahead,
      behind: pulse.deltaToMain.behind,
      filesChanged: pulse.deltaToMain.filesChanged,
      // PulseSummary renders these; dropping them blanks the +/- churn.
      insertions: pulse.deltaToMain.insertions,
      deletions: pulse.deltaToMain.deletions,
    },
  };
}
