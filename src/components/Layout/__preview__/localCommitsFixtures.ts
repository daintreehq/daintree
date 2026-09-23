import type {
  GitCommit,
  GitCommitListOptions,
  GitCommitListResponse,
  GitPushCommitPreview,
} from "@shared/types/git";

/**
 * Commit histories for the local commits dropdown, served through the same two
 * bridge reads the dropdown makes (`git.listCommits`, `git.listPushCommits`).
 * Selected with `?commits=<name>` on `forge-stats-preview.html`.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

interface Seed {
  message: string;
  body?: string;
  author?: string;
  ago: number;
}

const GREG = { name: "Greg Priday", email: "greg@daintree.dev" };
const JUSTIN = { name: "Justin Mercer", email: "justin@daintree.dev" };

function hashFor(i: number): string {
  const hex = (i * 2654435761 + 0x9e3779b9).toString(16).padStart(8, "0").slice(-8);
  return `${hex}${"a3f9c21e0b7d4568".repeat(2)}`.slice(0, 40);
}

function build(seeds: Seed[]): GitCommit[] {
  const now = Date.now();
  return seeds.map((seed, i) => {
    const hash = hashFor(i + 1);
    return {
      hash,
      shortHash: hash.slice(0, 7),
      message: seed.message,
      body: seed.body,
      author: seed.author === "justin" ? JUSTIN : GREG,
      date: new Date(now - seed.ago).toISOString(),
    };
  });
}

const HEAD_SEEDS: Seed[] = [
  {
    message: "fix(toolbar): keep the commits pill count in step with the worktree",
    body: "The pill read the project root's history while the dropdown listed the active\nworktree's branch, so the two disagreed as soon as a worktree was ahead of\ndevelop.\n\nRead both from the same cwd.\n\nFixes: #12640",
    ago: 4 * minute,
  },
  { message: "test(toolbar): pin the pill and dropdown to one cwd", ago: 11 * minute },
  {
    message: "feat(commits): show which commits have not been pushed yet",
    body: "Reads the push range the push dialog already measures and marks those rows.",
    ago: 2 * hour,
  },
  {
    message: "refactor(git): share the push-range read between the dialog and the list",
    author: "justin",
    ago: 5 * hour,
  },
  { message: "chore(deps): update root and plugin package dependencies", ago: 1 * day },
  {
    message:
      "fix(terminal): guard the poisoned xterm open() wedge that left a blank pane after a renderer crash during restore",
    body: "xterm 6.1's open() throws if the element was detached mid-restore, and the\nretry path reused the half-initialised instance.\n\n- dispose the instance on a failed open\n- rebuild from the restore snapshot\n\nCo-authored-by: Justin Mercer <justin@daintree.dev>",
    ago: 1 * day + 3 * hour,
  },
  { message: "Merge pull request #12651 from daintreehq/design/settings", ago: 2 * day },
  { message: "style(settings): align the row grammar on the agents page", ago: 2 * day + hour },
];

const TAIL_SUBJECTS = [
  "perf(renderer): shard the worktree port broker",
  "fix(compiler-budget): close the regeneration wedges",
  "feat(brand): rework the brand-mark ink model",
  "docs(themes): note the forced-colors outline fallback",
  "fix(mcp): drop the stale bearer on PTY exit",
  "refactor(panels): fold the forge slot view seam",
  "test(e2e): stop the palette flake on cold start",
  "chore(release): 0.42.0",
];

const LONG_SEEDS: Seed[] = [
  ...HEAD_SEEDS,
  ...Array.from({ length: 52 }, (_, i) => ({
    message: TAIL_SUBJECTS[i % TAIL_SUBJECTS.length]!,
    author: i % 3 === 0 ? "justin" : undefined,
    ago: 3 * day + i * 7 * hour,
  })),
];

interface CommitsFixture {
  what: string;
  commits: GitCommit[] | "pending" | { error: string };
  /** Overrides the pill's commit count (the dropdown's skeleton row hint). */
  commitCount?: number;
  push: { basis: GitPushCommitPreview["rangeBasis"]; count: number } | { error: string };
  /** Page 2 onwards fails with this message. */
  loadMoreError?: string;
}

const FEW = build(HEAD_SEEDS.slice(0, 5));
const LONG = build(LONG_SEEDS);

export const COMMITS_FIXTURES: Record<string, CommitsFixture> = {
  few: {
    what: "five commits, the two newest not pushed yet",
    commits: FEW,
    commitCount: 5,
    push: { basis: "tracked", count: 2 },
  },
  long: {
    what: "a long history, paged — three unpushed at the top",
    commits: LONG,
    commitCount: LONG.length,
    push: { basis: "tracked", count: 3 },
  },
  synced: {
    what: "everything pushed — the upstream has every commit",
    commits: FEW,
    commitCount: 5,
    push: { basis: "tracked", count: 0 },
  },
  unpublished: {
    what: "a branch that has never been pushed",
    commits: FEW,
    commitCount: 5,
    push: { basis: "creates", count: 5 },
  },
  "no-remote": {
    what: "no remote to push to — push status unknown",
    commits: FEW,
    commitCount: 5,
    push: { error: "No remote configured for branch 'develop'" },
  },
  empty: {
    what: "a repository with no commits yet",
    commits: [],
    commitCount: 0,
    push: { error: "No remote configured for branch 'develop'" },
  },
  loading: {
    what: "the history read has not answered",
    commits: "pending",
    commitCount: 6,
    push: { basis: "tracked", count: 2 },
  },
  error: {
    what: "the history read failed",
    commits: {
      error:
        "Error invoking remote method 'git:list-commits': Error: fatal: not a git repository (or any of the parent directories): .git",
    },
    commitCount: 5,
    push: { basis: "tracked", count: 0 },
  },
  "load-more-error": {
    what: "the first page landed, the second failed",
    commits: LONG,
    commitCount: LONG.length,
    push: { basis: "tracked", count: 3 },
    loadMoreError: "Error invoking remote method 'git:list-commits': Error: git log timed out",
  },
};

export function commitsFixture(name: string | null): CommitsFixture | null {
  if (name === null) return null;
  const fixture = COMMITS_FIXTURES[name];
  if (!fixture) {
    throw new Error(
      `unknown commits fixture "${name}" — one of ${Object.keys(COMMITS_FIXTURES).join(", ")}`
    );
  }
  return fixture;
}

export function listCommitsFrom(fixture: CommitsFixture) {
  return (options: GitCommitListOptions): Promise<GitCommitListResponse> => {
    const { commits } = fixture;
    if (commits === "pending") return new Promise(() => undefined);
    if (!Array.isArray(commits)) return Promise.reject(new Error(commits.error));
    const skip = options.skip ?? 0;
    const limit = options.limit ?? 30;
    if (skip > 0 && fixture.loadMoreError) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(fixture.loadMoreError)), 150)
      );
    }
    const query = options.search?.trim().toLowerCase();
    const matching = query
      ? commits.filter((c) => c.message.toLowerCase().includes(query) || c.hash.startsWith(query))
      : commits;
    const items = matching.slice(skip, skip + limit);
    return Promise.resolve({
      items,
      hasMore: skip + limit < matching.length,
      total: commits.length,
    });
  };
}

export function listPushCommitsFrom(fixture: CommitsFixture) {
  return (): Promise<GitPushCommitPreview> => {
    const { push, commits } = fixture;
    if ("error" in push) return Promise.reject(new Error(push.error));
    const all = Array.isArray(commits) ? commits : [];
    const range = all.slice(0, push.count);
    return Promise.resolve({
      destination: { remote: "origin", branch: "develop" },
      rangeBasis: push.basis,
      total: push.count,
      commits: range.map((c) => ({
        hash: c.hash,
        date: c.date,
        message: c.message,
        author: c.author.name,
      })),
    });
  };
}
