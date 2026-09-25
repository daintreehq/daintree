import type { CommandManifestEntry } from "@shared/types/commands";

/**
 * Manifest entries shaped exactly as `CommandService.list()` returns them.
 *
 * The first two are the shipped built-ins, copied from
 * `electron/services/commands/github*.ts` — the picker never sees anything else
 * today, so those are the rows that matter. The rest exist only to exercise the
 * category bands and a list long enough to scroll; the manifest type allows all
 * five categories and plugins or project overrides are where more would come from.
 */

const NO_FORGE = "No forge provider is active. Enable one (e.g. GitHub) in Settings.";

export const CREATE_ISSUE: CommandManifestEntry = {
  id: "github:create-issue",
  label: "/github:create-issue",
  description:
    "Create a GitHub issue in the current repository. " +
    "Use structured sections, file links, and task lists to make issues self-contained for autonomous work.",
  category: "github",
  keywords: ["issue", "create", "new", "bug", "feature", "ticket", "task", "request"],
  hasBuilder: true,
  enabled: true,
};

export const WORK_ISSUE: CommandManifestEntry = {
  id: "github:work-issue",
  label: "/github:work-issue",
  description:
    "Start working on a GitHub issue by creating an isolated worktree. " +
    "Fetches issue details, generates a branch name, creates a worktree, and switches to it. " +
    "Perfect for parallel development without stashing changes.",
  category: "github",
  keywords: ["github", "issue", "worktree", "branch", "work", "parallel", "isolate"],
  hasBuilder: true,
  enabled: true,
};

const STRESS: CommandManifestEntry[] = [
  {
    id: "git:sync-branch",
    label: "/git:sync-branch",
    description: "Rebase the current branch onto its upstream and push the result.",
    category: "git",
    hasBuilder: false,
    enabled: true,
  },
  {
    id: "git:squash-wip",
    label: "/git:squash-wip",
    description: "Squash every WIP commit on this branch into the commit before it.",
    category: "git",
    hasBuilder: true,
    enabled: false,
    disabledReason: "Disabled for this project",
  },
  {
    id: "workflow:review-and-merge-pull-request-when-checks-pass",
    label: "/workflow:review-and-merge-pull-request-when-checks-pass",
    description:
      "Wait for the pull request's required checks, review the diff, and merge it when everything is green.",
    category: "workflow",
    hasBuilder: true,
    enabled: true,
  },
  {
    id: "project:run-setup",
    label: "/project:run-setup",
    description: "Run the project's setup recipe in a new terminal.",
    category: "project",
    hasBuilder: false,
    enabled: true,
  },
  {
    id: "system:collect-diagnostics",
    label: "/system:collect-diagnostics",
    description: "Bundle logs and a process snapshot for a bug report.",
    category: "system",
    hasBuilder: false,
    enabled: true,
  },
];

const FIXTURES = ["shipped", "no-forge", "wide", "loading", "empty"] as const;
export type CommandPickerFixture = (typeof FIXTURES)[number];

export function isCommandPickerFixture(value: string | null): value is CommandPickerFixture {
  return FIXTURES.some((f) => f === value);
}

export function commandsFor(fixture: CommandPickerFixture): CommandManifestEntry[] {
  switch (fixture) {
    case "shipped":
      return [CREATE_ISSUE, WORK_ISSUE];
    case "no-forge":
      return [CREATE_ISSUE, WORK_ISSUE].map((cmd) => ({
        ...cmd,
        enabled: false,
        disabledReason: NO_FORGE,
      }));
    case "wide":
      return [CREATE_ISSUE, { ...WORK_ISSUE, enabled: false, disabledReason: NO_FORGE }, ...STRESS];
    case "loading":
    case "empty":
      return [];
  }
}
