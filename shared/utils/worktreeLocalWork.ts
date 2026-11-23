import type { WorktreeLocalWork } from "../types/worktreeLocalWork.js";
import { pluralize } from "./pluralize.js";

/**
 * What a close confirmation says of a panel's worktree (#18151): each thing
 * that exists only on this machine, or that git couldn't report. Empty for a
 * worktree that is clean and pushed, and for one that wasn't read.
 */
export function worktreeLocalWorkFacts(work: WorktreeLocalWork): string[] {
  if (work.kind === "not-applicable") return [];
  if (work.kind === "unreadable") return ["Worktree state unreadable"];
  const facts: string[] = [];
  if (work.unpushedCommits === null) facts.push("Branch has no commits yet");
  else if (work.unpushedCommits > 0) {
    facts.push(`${pluralize(work.unpushedCommits, "commit")} on no remote`);
  }
  // A path, not a file: an untracked directory is one entry however much it holds.
  if (work.changedEntries > 0) {
    facts.push(pluralize(work.changedEntries, "changed or untracked path"));
  }
  if (work.hiddenFromStatus > 0) {
    facts.push(
      pluralize(
        work.hiddenFromStatus,
        "tracked file git doesn't check",
        "tracked files git doesn't check"
      )
    );
  }
  return facts;
}
