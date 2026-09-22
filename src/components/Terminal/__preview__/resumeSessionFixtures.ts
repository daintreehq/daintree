import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { Project } from "@shared/types/project";
import type { WorktreeSnapshot } from "@shared/types";

/**
 * Fixtures for the resume-sessions palette review harness.
 *
 * Modelled on a real journal: mostly one agent, several sessions whose agent
 * never produced a task title, a run of sessions whose worktree has since been
 * deleted, one long title and one long branch for the truncation cases, and a
 * couple of other agents so the row's agent identity has something to
 * distinguish. Timestamps are relative to page load so "5m ago" reads as it
 * would in the app.
 */

export const PROJECT_ID = "proj-daintree";

export const PROJECT: Project = {
  id: PROJECT_ID,
  path: "/Users/dev/daintree",
  name: "Daintree",
  emoji: "🌳",
  lastOpened: Date.now(),
};

function worktree(id: string, name: string, branch: string, extra: Partial<WorktreeSnapshot> = {}) {
  return {
    id,
    worktreeId: id,
    path: `/Users/dev/daintree-worktrees/${name}`,
    name,
    branch,
    isCurrent: false,
    ...extra,
  } as WorktreeSnapshot;
}

export const WORKTREES: WorktreeSnapshot[] = [
  worktree("wt-main", "daintree", "develop", {
    path: "/Users/dev/daintree",
    isMainWorktree: true,
    isCurrent: true,
  }),
  worktree(
    "wt-assistant",
    "feature-native-daintree-assistant",
    "feature/native-daintree-assistant"
  ),
  worktree("wt-video", "video-intro-video", "video/intro-video"),
  worktree(
    "wt-long",
    "fix-retry-backoff-jitter-across-every-forge-provider-with-exponential-caps",
    "fix/retry-backoff-jitter-across-every-forge-provider-with-exponential-caps"
  ),
];

const NOW = Date.now();
const minutes = (n: number) => NOW - n * 60_000;
const hours = (n: number) => minutes(n * 60);
const days = (n: number) => hours(n * 24);

let seq = 0;
function record(
  title: string | null,
  savedAt: number,
  extra: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  seq += 1;
  return {
    sessionId: `session-${seq}`,
    agentId: "claude",
    worktreeId: "wt-main",
    projectId: PROJECT_ID,
    title,
    savedAt,
    cwd: "/Users/dev/daintree",
    branch: "develop",
    ...extra,
  };
}

/** A session whose recorded worktree no longer resolves in the live map. */
function removed(title: string | null, savedAt: number, branch: string): AgentSessionRecord {
  return record(title, savedAt, {
    worktreeId: `wt-gone-${branch}`,
    cwd: `/Users/dev/daintree-worktrees/${branch.replace(/\//g, "-")}`,
    branch,
  });
}

const RESUMABLE: AgentSessionRecord[] = [
  record("✳ Pane resize scroll position bug", hours(1)),
  record("✳ Claude Code", hours(3)),
  record("✳ Claude Code", hours(3)),
  record(null, hours(6)),
  record("✳ 4K screencast with Inworld audio sync", days(1), {
    worktreeId: "wt-video",
    cwd: "/Users/dev/daintree-worktrees/video-intro-video",
    branch: "video/intro-video",
  }),
  record("✳ Rebase with develop", days(1), {
    worktreeId: "wt-assistant",
    cwd: "/Users/dev/daintree-worktrees/feature-native-daintree-assistant",
    branch: "feature/native-daintree-assistant",
    agentModelId: "anthropic/claude-opus-4-8",
  }),
  record(
    "Port the forge token banner onto the shared banner family and reconcile every consumer of the old primitive",
    days(2),
    {
      agentId: "codex",
      worktreeId: "wt-long",
      cwd: "/Users/dev/daintree-worktrees/fix-retry-backoff-jitter-across-every-forge-provider-with-exponential-caps",
      branch: "fix/retry-backoff-jitter-across-every-forge-provider-with-exponential-caps",
      agentModelId: "gpt-5.3-codex",
    }
  ),
  record("Agent terminal cursor flickering", days(2), { agentId: "gemini" }),
];

const REMOVED: AgentSessionRecord[] = [
  removed("✳ Delete work tree", minutes(5), "feature/worktree-delete-flow"),
  removed("✳ New worktree and branch", minutes(11), "feature/quick-create-branch"),
  removed("✳ Feature terminal arming design overlap", days(3), "design/fleet-arming"),
  removed("✳ CI failure", days(3), "fix/ci-shard-timeout"),
  removed("✳ Screenshots request", days(3), "design/screenshot-harness"),
  removed("✳ Image reference request", days(3), "design/screenshot-harness"),
  removed("✳ Show screenshots", days(3), "design/screenshot-harness"),
  removed("✳ Continue session", days(3), "feature/recently-closed-redesign"),
  removed("✳ Continue session", days(4), "feature/recently-closed-redesign"),
];

function byNewest(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return [...records].sort((a, b) => b.savedAt - a.savedAt);
}

/** Enough resumable rows to page: browse shows twenty and offers the rest. */
const MANY: AgentSessionRecord[] = byNewest([
  ...RESUMABLE,
  ...Array.from({ length: 26 }, (_, i) =>
    record(
      `Batch ${i + 1}: refactor the ${["pty host", "watchdog", "forge client", "theme loader"][i % 4]}`,
      days(3) - i * 3_600_000
    )
  ),
  ...REMOVED,
]);

export interface ResumeSessionFixture {
  what: string;
  sessions: AgentSessionRecord[];
}

export const FIXTURES = {
  populated: {
    what: "a real-looking journal: titled, untitled and placeholder-titled sessions, three agents, nine with a removed worktree",
    sessions: byNewest([...RESUMABLE, ...REMOVED]),
  },
  many: {
    what: "more resumable sessions than one page shows",
    sessions: MANY,
  },
  "removed-only": {
    what: "every session's worktree has been deleted",
    sessions: byNewest(REMOVED),
  },
  empty: {
    what: "nothing has been closed yet",
    sessions: [],
  },
} satisfies Record<string, ResumeSessionFixture>;

export type FixtureName = keyof typeof FIXTURES;
export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(isFixtureName);

export function isFixtureName(name: string): name is FixtureName {
  return Object.hasOwn(FIXTURES, name);
}

export function requireFixture(name: string): ResumeSessionFixture {
  if (!isFixtureName(name)) {
    throw new Error(
      `unknown resume-sessions fixture "${name}" (have: ${FIXTURE_NAMES.join(", ")})`
    );
  }
  return FIXTURES[name];
}
