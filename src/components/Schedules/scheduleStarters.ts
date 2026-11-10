/**
 * Starter schedules for an empty Schedules tab (#16394): fixed content shipped
 * with Daintree, never read from the repository. Each prompt is written for a
 * run nobody is watching, so it says what to do when there's nothing to
 * report, and asks for nothing that publishes or removes work. The launcher
 * appends the handback instruction itself, so none of them repeat it.
 */
export interface ScheduleStarter {
  id: string;
  /** The name the editor opens with. */
  name: string;
  /** What the schedule is for, shown on the starter's button. */
  description: string;
  /** Five-field cron, read in this machine's time zone when the schedule is created. */
  cron: string;
  prompt: string;
}

export const SCHEDULE_STARTERS: readonly ScheduleStarter[] = [
  {
    id: "nightly-bug-hunt",
    name: "Nightly bug hunt",
    description: "Every night at 2:00 AM",
    cron: "0 2 * * *",
    prompt: [
      "Look through the code changed in the last 24 hours (git log --since='24 hours ago' and the diffs behind it) for likely bugs: unhandled errors, off-by-one mistakes, missing null checks, race conditions and logic that contradicts its surrounding code.",
      "Read the code and run the existing tests where that helps confirm a suspicion. Do not edit files, commit, push, merge or delete anything.",
      "Report each suspected bug with the file and line, why it looks wrong, and how you'd confirm it. Rank them by how likely they are to matter.",
      "If nothing changed or you find nothing worth reporting, say so in one line and stop.",
    ].join("\n\n"),
  },
  {
    id: "daily-change-summary",
    name: "Daily summary of changes",
    description: "Every day at 8:00 AM",
    cron: "0 8 * * *",
    prompt: [
      "Summarize what changed in this repository over the last 24 hours: merged and pushed commits across all branches, grouped by theme, with who or what area each touched.",
      "Use git log and the diffs. Keep it short enough to read in a minute, and call out anything that looks risky, large or unfinished. Do not edit files, commit, push, merge or delete anything.",
      "If nothing changed, say so in one line and stop.",
    ].join("\n\n"),
  },
  {
    id: "weekly-missing-tests",
    name: "Weekly missing tests check",
    description: "Every Monday at 9:00 AM",
    cron: "0 9 * * 1",
    prompt: [
      "Find code added or changed in the last 7 days that has no test covering it. Compare the week's diffs against the test files that exist, and look at the behaviour that was added, not only the files.",
      "List each gap with the file, the function or branch left untested, and a sentence on the test that would cover it. Rank them by risk. Do not write or edit files, commit, push, merge or delete anything.",
      "If everything that changed is covered, or nothing changed, say so in one line and stop.",
    ].join("\n\n"),
  },
  {
    id: "weekly-dependency-check",
    name: "Weekly dependency check",
    description: "Every Monday at 7:00 AM",
    cron: "0 7 * * 1",
    prompt: [
      "Check this project's dependencies for ones that are outdated by a major version, deprecated, or flagged by the package manager's audit command. Use the project's own tooling in read-only mode.",
      "Report each one with its current and latest version and whether upgrading looks risky. Do not change any manifest or lockfile, install, commit, push, merge or delete anything.",
      "If everything is current and the audit is clean, say so in one line and stop.",
    ].join("\n\n"),
  },
];
