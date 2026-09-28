import type { Issue, ListOptions, Page, PR } from "@shared/types/forge";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

/**
 * Issue and pull-request lists for the GitHub plugin's forge dropdowns, served
 * through the same two bridge reads the list makes (`forge.listIssues`,
 * `forge.listPRs`). Selected with `?list=<name>` beside `?forge=github` on
 * `forge-stats-preview.html`.
 *
 * The Electron harness (`forge-dropdown-review`) can only show a list that
 * loaded. The states worth judging a list by — a cold read that never answers,
 * a failure with nothing cached, a missing token, a paused API — are the ones a
 * live session reaches rarely and never on demand.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const AVATAR_A =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#4a6b8a"/><circle cx="16" cy="12" r="6" fill="#c8d8e4"/><ellipse cx="16" cy="28" rx="11" ry="9" fill="#c8d8e4"/></svg>`
  );
const AVATAR_B =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#8a5a4a"/><circle cx="16" cy="12" r="6" fill="#e8d4c8"/><ellipse cx="16" cy="28" rx="11" ry="9" fill="#e8d4c8"/></svg>`
  );

const GREG = { login: "gregpriday", avatarUrl: AVATAR_A, rawData: {} };
const JUSTIN = { login: "jmercer", avatarUrl: AVATAR_B, rawData: {} };
const REPO = "https://github.com/daintreehq/daintree";

const L = (name: string, color: string) => ({ name, color });

function issue(n: number, title: string, ago: number, over: Partial<Issue> = {}): Issue {
  const at = Date.now() - ago;
  return {
    number: n,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `${REPO}/issues/${n}`,
    author: GREG,
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: at,
    updatedAt: at,
    rawData: {},
    ...over,
  };
}

function pr(n: number, title: string, ago: number, over: Partial<PR> = {}): PR {
  const at = Date.now() - ago;
  return {
    number: n,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: `${REPO}/pull/${n}`,
    author: GREG,
    baseRef: "develop",
    headRef: `feature/issue-${n}`,
    commentCount: 0,
    createdAt: at,
    updatedAt: at,
    rawData: {},
    ...over,
  };
}

const RICH_ISSUES: Issue[] = [
  issue(11958, "Restart into a scratch workspace restores an unnamed project shell", 4 * minute, {
    labels: [L("bug", "d73a4a"), L("backend", "e99695")],
  }),
  issue(11957, "Cmd+Alt+I falls back to the fleet view in most projects", 38 * minute, {
    labels: [L("bug", "d73a4a"), L("ui", "fbe1d5")],
    commentCount: 3,
  }),
  issue(11949, "Show Claude Code subagents as inspectable child terminals", 2 * hour, {
    labels: [L("enhancement", "a2eeef"), L("terminal", "5319e7")],
    assignees: [GREG],
  }),
  issue(
    11755,
    "Publish Daintree to winget, Scoop and Chocolatey so Windows users can install and update it without the setup wizard",
    5 * hour,
    {
      labels: [
        L("enhancement", "a2eeef"),
        L("infrastructure", "0e8a16"),
        L("windows", "0052cc"),
        L("packaging", "c2e0c6"),
      ],
      assignees: [GREG, JUSTIN],
      commentCount: 7,
    }
  ),
  issue(11745, "Bundle the assistant CLI into release builds", 1 * day, {
    labels: [L("infrastructure", "0e8a16"), L("future-work", "5aa9e6")],
    commentCount: 1,
    author: JUSTIN,
  }),
  issue(11244, "Fold the forge slot view seam into the panel contract", 3 * day, {
    labels: [L("architecture", "c5def5"), L("plugins", "7cd44a")],
    commentCount: 1,
    assignees: [GREG],
    linkedPR: { number: 11950, state: "open", url: `${REPO}/pull/11950`, ciStatus: "failure" },
  }),
  issue(11210, "Renderer memory climbs to 3.2GB across a long session", 6 * day, {
    labels: [L("bug", "d73a4a"), L("performance", "fbca04")],
    commentCount: 12,
    author: JUSTIN,
  }),
  issue(11158, "Remote SSH workspace mode", 12 * day, {
    labels: [L("epic", "3e4b9e")],
    assignees: [JUSTIN],
  }),
];

const RICH_PRS: PR[] = [
  pr(11956, "fix(compiler-budget): close the regeneration wedges", 9 * minute, {
    ciStatus: "success",
    reviewDecision: "APPROVED",
    commentCount: 2,
    headRef: "fix/compiler-budget-wedges",
  }),
  pr(11955, "feature(pilot): group a project's agents", 50 * minute, {
    ciStatus: "pending",
    headRef: "feature/pilot-agent-groups",
    author: JUSTIN,
  }),
  pr(
    11950,
    "refactor(panels): fold the forge slot view seam into the panel contract and retire the legacy registry",
    3 * hour,
    {
      isDraft: true,
      ciStatus: "failure",
      commentCount: 5,
      headRef: "refactor/forge-slot-view-seam-into-panel-contract",
    }
  ),
  pr(11940, "perf(renderer): shard the worktree port broker", 7 * hour, {
    ciStatus: "success",
    reviewDecision: "CHANGES_REQUESTED",
    headRef: "perf/shard-port-broker",
    author: JUSTIN,
  }),
  pr(11930, "chore(deps): hold vite at 8.0.14", 1 * day, {
    ciStatus: "success",
    commentCount: 1,
    headRef: "chore/hold-vite",
  }),
  pr(11920, "feat(brand): rework the brand-mark ink model", 2 * day, {
    ciStatus: "success",
    headRef: "feat/brand-ink",
  }),
  pr(11910, "fix(terminal): guard the poisoned xterm open() wedge", 4 * day, {
    ciStatus: "failure",
    headRef: "fix/xterm-open-wedge",
  }),
];

const LONG_TITLES = [
  "Terminal scrollback jumps to the top after a resize while an agent is streaming",
  "Worktree dashboard counts drift after a branch is force-pushed",
  "Fleet broadcast drops keystrokes when two panes share a PTY host",
  "Add a per-project default agent to the launcher",
  "Diff panel loses its scroll position on file switch",
  "MCP server rejects tools with nullable output schemas",
  "Dock popover resize handle ignores the minimum width",
  "Settings search misses keybinding rows",
];

function longIssues(): Issue[] {
  return Array.from({ length: 30 }, (_, i) =>
    issue(11800 - i * 7, LONG_TITLES[i % LONG_TITLES.length]!, (i + 1) * 3 * hour, {
      labels: i % 3 === 0 ? [L("bug", "d73a4a")] : [L("enhancement", "a2eeef")],
      commentCount: i % 4,
      assignees: i % 5 === 0 ? [GREG] : [],
    })
  );
}

export interface ListFixture {
  what: string;
  issues: Issue[] | "pending" | { reject: string };
  prs: PR[] | "pending" | { reject: string };
  hasMore?: boolean;
  /** `false` = the credential status reports no token. */
  hasToken?: boolean;
  /** Apply a primary rate-limit block before the list mounts. */
  rateLimited?: boolean;
}

export const LIST_FIXTURES: Record<string, ListFixture> = {
  rich: {
    what: "a working repo — labels, assignees, linked PRs, CI and review states",
    issues: RICH_ISSUES,
    prs: RICH_PRS,
  },
  long: {
    what: "a page of 30 with more to load",
    issues: longIssues(),
    prs: RICH_PRS,
    hasMore: true,
  },
  empty: { what: "nothing open", issues: [], prs: [] },
  loading: { what: "the first read never answers", issues: "pending", prs: "pending" },
  offline: {
    what: "the first read fails with nothing cached",
    issues: { reject: "Cannot reach GitHub. Check your network connection." },
    prs: { reject: "Cannot reach GitHub. Check your network connection." },
  },
  "bad-token": {
    what: "the stored token is rejected",
    issues: { reject: "Invalid GitHub token. Update it in Settings." },
    prs: { reject: "Invalid GitHub token. Update it in Settings." },
  },
  "no-token": { what: "no token stored", issues: [], prs: [], hasToken: false },
  "rate-limited": {
    what: "the API is paused with nothing cached",
    issues: [],
    prs: [],
    rateLimited: true,
  },
};

export function listFixture(name: string | null): ListFixture | null {
  if (!name) return null;
  const fixture = LIST_FIXTURES[name];
  if (!fixture) {
    throw new Error(
      `unknown list fixture "${name}" — one of ${Object.keys(LIST_FIXTURES).join(", ")}`
    );
  }
  return fixture;
}

/**
 * What the next read answers with, once, for the stale-banner states — a list
 * that loaded, then a refresh that failed.
 */
let failNext: string | null = null;
export function failNextListRead(message: string): void {
  failNext = message;
}

function matches(item: Issue | PR, opts: ListOptions | undefined): boolean {
  const q = opts?.search?.trim().toLowerCase();
  if (!q) return true;
  return item.title.toLowerCase().includes(q) || String(item.number).includes(q);
}

export function listFrom<T extends Issue | PR>(source: T[] | "pending" | { reject: string }) {
  return async ({ opts }: { cwd: string; opts?: ListOptions }): Promise<Page<T>> => {
    if (failNext) {
      const message = failNext;
      failNext = null;
      throw new Error(message);
    }
    if (source === "pending") return new Promise(() => undefined);
    if (!Array.isArray(source)) throw new Error(source.reject);
    const state = opts?.state ?? "open";
    const items = source.filter(
      (item) =>
        (state === "open" ? item.state === "open" : item.state !== "open") && matches(item, opts)
    );
    return { items, nextCursor: null, hasMore: false, totalCount: items.length };
  };
}

/**
 * A first page that says more exist, and a second that never answers, so the
 * list's tail can be photographed mid-load rather than already appended.
 */
export function listWithMore<T extends Issue | PR>(items: T[]) {
  return async ({ opts }: { cwd: string; opts?: ListOptions }): Promise<Page<T>> => {
    if (opts?.cursor) return new Promise(() => undefined);
    return { items, nextCursor: "cursor-2", hasMore: true, totalCount: items.length * 3 };
  };
}

/** Worktrees made for fixture resources, so the rows can show local state. */
export function forgeWorktrees(projectPath: string): WorktreeSnapshot[] {
  return [
    {
      id: "wt-issue-11949",
      worktreeId: "wt-issue-11949",
      path: `${projectPath}-worktrees/issue-11949`,
      name: "issue-11949",
      branch: "feature/issue-11949-subagent-terminals",
      isCurrent: false,
      issueNumber: 11949,
    },
    {
      id: "wt-issue-11244",
      worktreeId: "wt-issue-11244",
      path: `${projectPath}-worktrees/issue-11244`,
      name: "issue-11244",
      branch: "refactor/forge-slot-view-seam-into-panel-contract",
      isCurrent: false,
      issueNumber: 11244,
      prNumber: 11950,
    },
  ];
}
