import { execSync } from "child_process";
import path from "path";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { createDemoRepo, type DemoRepo } from "./screenshotFixtures";

/**
 * Documentation captures show the project path in the empty-state header and
 * the launcher, so the demo root has to read like a place a developer keeps
 * projects. The marketing default is `/tmp/daintree-demos`, which macOS
 * renders as `/private/tmp/daintree-demos/...` — unmistakably a temp dir, and
 * exactly the kind of detail the audit calls out as state hygiene. `/Users/
 * Shared` exists and is writable on every macOS install and carries no
 * username.
 */
export const DOCS_DEMO_ROOT =
  process.env.DAINTREE_DEMO_ROOT ??
  (process.platform === "win32" ? "C:\\Projects" : "/Users/Shared/Projects");

/**
 * A fixed creation time for every seeded recipe. `Date.now()` here would make
 * two capture runs order the Recipe Manager differently for no reason.
 */
const RECIPE_CREATED_AT = Date.UTC(2026, 5, 2, 9, 30);

/**
 * Give a demo repo a real `origin` so the UI reads "Ready to push" rather
 * than "No remote configured — Push is unavailable". The remote is a bare
 * repo beside the working copy: nothing leaves the machine, but every
 * branch-vs-remote signal in the sidebar and the Review Hub has something
 * to compare against.
 */
export function attachLocalOrigin(repo: DemoRepo): void {
  const bare = path.join(path.dirname(repo.dir), `${repo.slug}.git`);
  if (existsSync(bare)) rmSync(bare, { recursive: true, force: true });
  mkdirSync(path.dirname(bare), { recursive: true });
  const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "ignore" });
  run(`git init --bare ${JSON.stringify(bare)}`, path.dirname(bare));
  run(`git remote add origin ${JSON.stringify(bare)}`, repo.dir);
  run("git push -u origin main", repo.dir);
  const originalCleanup = repo.cleanup;
  repo.cleanup = () => {
    originalCleanup();
    try {
      rmSync(bare, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
}

/**
 * Point a demo repo's `origin` at a real GitHub repository without cloning it.
 *
 * The forge surfaces — the toolbar issue and PR counts, the issues dropdown,
 * bulk worktree creation — resolve their repository from the project's remote
 * URL, not from its contents. Setting the URL alone is therefore enough to
 * make those panels show real issues, and it means the documentation captures
 * never open, write to, or dirty an actual working checkout.
 *
 * No fetch and no push: the remote exists only so the forge provider can
 * identify the repository.
 */
export function attachGithubOrigin(repo: DemoRepo, remoteUrl: string): void {
  execSync(`git remote add origin ${JSON.stringify(remoteUrl)}`, {
    cwd: repo.dir,
    stdio: "ignore",
  });
}

/**
 * Fixture for the daintree.org documentation screenshots.
 *
 * The marketing reel in `screenshotFixtures.ts` builds one repo per scene,
 * each tuned for a single hero shot. The documentation needs the opposite:
 * ONE repo rich enough that a whole page's worth of states can be driven
 * off a single app launch — mixed worktree states, uncommitted work in
 * several shapes, recipes at more than one scope, and files the File
 * Browser and File Viewer can open without looking staged.
 *
 * Naming is deliberately stable. The audit's rule is that the same branch
 * should not be `feature-auth` on one page and `fix/login` on the next, so
 * every documentation page that shows a sidebar shows these five branches.
 */
export function createAtlasLedgerRepo(): DemoRepo {
  return createDemoRepo({
    slug: "atlas-ledger",
    files: {
      "README.md": `# 📒 atlas-ledger

Double-entry ledger service for multi-currency products.

- Immutable journal with append-only postings
- Currency-safe balances, no floating point anywhere
- Reconciliation against upstream statements
`,
      "package.json": JSON.stringify(
        {
          name: "atlas-ledger",
          version: "3.1.0",
          private: true,
          scripts: {
            dev: "node server.js",
            test: "node --test",
            lint: "eslint src",
          },
        },
        null,
        2
      ),
      "src/journal/posting.ts": `import type { Account, Money } from "../types";

/**
 * A posting is one half of a double-entry pair. Nothing in the ledger
 * mutates a posting once it is written — corrections are new postings
 * that reference the original.
 */
export interface Posting {
  id: string;
  account: Account;
  amount: Money;
  reference?: string;
}

export function balanceOf(postings: Posting[]): Money {
  return postings.reduce(
    (total, posting) => addMoney(total, posting.amount),
    zero(postings[0]?.amount.currency ?? "USD")
  );
}

function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(\`cannot add \${a.currency} to \${b.currency}\`);
  }
  return { currency: a.currency, minorUnits: a.minorUnits + b.minorUnits };
}

function zero(currency: string): Money {
  return { currency, minorUnits: 0 };
}
`,
      "src/journal/entry.ts": `import type { Posting } from "./posting";

export interface Entry {
  id: string;
  postedAt: string;
  postings: Posting[];
}

export function isBalanced(entry: Entry): boolean {
  const total = entry.postings.reduce((sum, p) => sum + p.amount.minorUnits, 0);
  return total === 0;
}
`,
      "src/reconcile/statement.ts": `// Reconciliation against an upstream bank statement.
export interface StatementLine {
  externalId: string;
  amountMinorUnits: number;
  bookedAt: string;
}

export function matchLines(_lines: StatementLine[]): void {
  // TODO: tolerate same-day ordering differences — see issue #218
}
`,
      "src/currency/rates.ts": `export const SUPPORTED = ["USD", "EUR", "GBP", "AUD", "NZD"] as const;

export function isSupported(code: string): boolean {
  return (SUPPORTED as readonly string[]).includes(code);
}
`,
      "src/types.ts": `export interface Money {
  currency: string;
  minorUnits: number;
}

export interface Account {
  code: string;
  name: string;
}
`,
      "docs/architecture.md": `# Architecture

The ledger is append-only. Everything else in the service is a projection
over the journal, rebuildable from scratch at any time.
`,
    },
    branches: ["release/3.2"],
    worktrees: [
      {
        // Committed work, clean tree — the "finished" reading in the sidebar.
        branch: "feature/multi-currency",
        files: {
          "src/currency/convert.ts": `import { isSupported } from "./rates";

export function convert(minorUnits: number, from: string, to: string): number {
  if (!isSupported(from) || !isSupported(to)) {
    throw new Error("unsupported currency pair");
  }
  return minorUnits;
}
`,
        },
      },
      {
        // Committed work plus uncommitted edits — the "changed" reading, and
        // the working tree the Review Hub shots are taken against.
        branch: "feature/reconciliation",
        files: {
          "src/reconcile/matcher.ts": "// Statement matcher, first pass\n",
        },
        uncommittedFiles: {
          "src/reconcile/statement.ts": `// Reconciliation against an upstream bank statement.
export interface StatementLine {
  externalId: string;
  amountMinorUnits: number;
  bookedAt: string;
}

export function matchLines(lines: StatementLine[]): StatementLine[] {
  // Same-day lines can arrive in any order, so sort before matching
  // rather than trusting the upstream sequence.
  return [...lines].sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
}
`,
          "src/reconcile/tolerance.ts": `export const SAME_DAY_TOLERANCE_MS = 86_400_000;
`,
        },
      },
      {
        // Uncommitted only — a worktree that has never had a commit of its own.
        branch: "bugfix/rounding-drift",
        uncommittedFiles: {
          "src/journal/posting.ts": `import type { Account, Money } from "../types";

export interface Posting {
  id: string;
  account: Account;
  amount: Money;
  reference?: string;
}

export function balanceOf(postings: Posting[]): Money {
  // Rounding drift fix: accumulate in minor units and never touch a float.
  const currency = postings[0]?.amount.currency ?? "USD";
  const minorUnits = postings.reduce((sum, p) => sum + p.amount.minorUnits, 0);
  return { currency, minorUnits };
}
`,
        },
      },
      {
        // Clean, no work at all — the "idle" reading.
        branch: "chore/dependency-bump",
      },
    ],
    recipes: [
      {
        filename: "review-and-test.json",
        content: {
          id: "inrepo-review-and-test",
          createdAt: RECIPE_CREATED_AT,
          name: "Review and test",
          showInEmptyState: true,
          terminals: [
            {
              type: "claude",
              title: "Reviewer",
              initialPrompt:
                "Review the diff on this worktree against src/journal/. Flag any posting that could be mutated after write, then stop.",
              exitBehavior: "keep",
            },
            {
              type: "terminal",
              title: "Tests",
              command: "npm test",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "reconcile-spike.json",
        content: {
          id: "inrepo-reconcile-spike",
          createdAt: RECIPE_CREATED_AT,
          name: "Reconciliation spike",
          showInEmptyState: true,
          terminals: [
            {
              type: "claude",
              title: "Spike",
              initialPrompt:
                "Sketch three approaches to same-day statement ordering in src/reconcile/. Compare them on correctness, then stop.",
              exitBehavior: "keep",
            },
          ],
        },
      },
      {
        filename: "dev-server.json",
        content: {
          id: "inrepo-dev-server",
          createdAt: RECIPE_CREATED_AT,
          name: "Dev server",
          showInEmptyState: true,
          terminals: [
            {
              type: "terminal",
              title: "Server",
              command: "npm run dev",
              exitBehavior: "keep",
            },
            {
              type: "terminal",
              title: "Lint watch",
              command: "npm run lint -- --watch",
              exitBehavior: "keep",
            },
          ],
        },
      },
    ],
  });
}

/**
 * Push commits to the demo repo's bare origin from a throwaway clone, so the
 * remote is ahead of the working copy.
 *
 * `createDivergedRemoteFixture` in `fixtures.ts` does the same job, but it
 * builds its repo under `mkdtemp`, and the resulting
 * `/private/var/folders/.../daintree-e2e-…` path is visible in the project
 * header and the Review Hub's own chrome. The documentation set keeps every
 * path under the demo root, so divergence is layered onto the shared fixture
 * instead of being a separate repo with a different name.
 *
 * Requires `attachLocalOrigin(repo)` to have run first.
 */
export function advanceRemote(
  repo: DemoRepo,
  commits: Array<{ file: string; content: string; message: string }>
): void {
  const bare = path.join(path.dirname(repo.dir), `${repo.slug}.git`);
  const scratch = path.join(path.dirname(repo.dir), `${repo.slug}-remote-scratch`);
  const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "ignore" });

  rmSync(scratch, { recursive: true, force: true });
  run(`git clone ${JSON.stringify(bare)} ${JSON.stringify(scratch)}`, path.dirname(repo.dir));
  run('git config user.email "avery@atlas-ledger.dev"', scratch);
  run('git config user.name "Avery Coelho"', scratch);
  for (const commit of commits) {
    const target = path.join(scratch, commit.file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, commit.content);
    run("git add -A", scratch);
    run(`git commit -m ${JSON.stringify(commit.message)}`, scratch);
  }
  run("git push origin main", scratch);
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * Leave the repo stopped in the middle of a rebase with a real conflict.
 *
 * Three commits on the topic branch rather than one, so the Review Hub's
 * rebase sequence rail reads as a sequence — a 1-of-1 rail photographs as a
 * progress bar with nothing to progress through.
 *
 * Only ONE file conflicts. The Review Hub stages everything unstaged when it
 * opens (`autoStageOnOpen`), and a second dirty file would be swept into the
 * index alongside the conflict and change what the panel shows.
 */
export function startConflictedRebase(repo: DemoRepo, branch: string): void {
  const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "ignore" });
  const ledger = path.join(repo.dir, "src/journal/posting.ts");
  const base = readFileSync(ledger, "utf8");

  run(`git checkout -b ${branch}`, repo.dir);
  const edits = [
    ["reconcile against the statement, not the balance", "fix: reconcile against the statement"],
    ["carry the currency through the posting pair", "fix: carry currency through the pair"],
    ["round once, at the boundary", "fix: round once, at the boundary"],
  ];
  edits.forEach(([line, message], i) => {
    writeFileSync(ledger, `// ${line}\n${base}`);
    writeFileSync(path.join(repo.dir, `src/journal/note-${i}.md`), `${message}\n`);
    run("git add -A", repo.dir);
    run(`git commit -m ${JSON.stringify(message)}`, repo.dir);
  });

  run("git checkout main", repo.dir);
  writeFileSync(ledger, `// settle in the ledger currency before rounding\n${base}`);
  run("git add -A", repo.dir);
  run('git commit -m "fix: settle before rounding"', repo.dir);

  run(`git checkout ${branch}`, repo.dir);
  try {
    // Expected to stop on the first conflicting commit.
    run("git rebase main", repo.dir);
  } catch {
    // The stop is the point.
  }
}

/**
 * Backdated commit history, for the Project Pulse shots.
 *
 * Pulse is not a stored record — it is recomputed from `git log` on every
 * fetch, bucketed by *local* calendar day. So the only way to stage it is to
 * write commits with the dates you want.
 *
 * Two details do the work. Days 0-3 are contiguous, which is what produces a
 * streak: the service walks back from today's local midnight and stops at the
 * first gap, and the flame only renders above one day. And the per-day counts
 * vary, because the heat scale is a p90 over the range — a history of exactly
 * one commit a day paints every cell at level 1 and the heatmap has no heat.
 *
 * `withSpreadCommits` in the shared fixtures cannot be used here: it writes
 * three commits at 50/30/10 days, which leaves the streak at zero and the
 * strip's 18-cell ribbon empty.
 */
export function seedPulseHistory(dir: string): void {
  const days = [45, 44, 38, 31, 30, 29, 22, 17, 16, 15, 9, 8, 7, 3, 2, 1, 0];
  mkdirSync(path.join(dir, "history"), { recursive: true });
  for (const d of days) {
    const perDay = d % 7 === 0 ? 4 : d % 3 === 0 ? 3 : d % 2 === 0 ? 2 : 1;
    for (let i = 0; i < perDay; i++) {
      const when = new Date(Date.now() - d * 86_400_000);
      // Local time, not UTC. Both the heatmap and the streak bucket by local
      // calendar day, so a UTC-noon stamp lands on the wrong day for a capture
      // machine far enough east or west.
      when.setHours(11, 10 * i, 0, 0);
      const stamp = when.toISOString();
      writeFileSync(path.join(dir, "history", `day-${d}-${i}.md`), `# ledger note ${d}.${i}\n`);
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      execSync(`git commit -m ${JSON.stringify(`chore: ledger notes (day -${d}, ${i})`)}`, {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
      });
    }
  }
}

/**
 * Backdate a repo's root commit.
 *
 * Pulse marks every cell older than the first commit as "before the project"
 * and the strip drops those cells entirely — so a fixture whose root commit is
 * dated now renders an empty ribbon however much history sits on top of it.
 * Amend before any worktree branches off, or they are orphaned.
 */
export function backdateRootCommit(dir: string, daysAgo: number): void {
  const stamp = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  execSync("git commit --amend --no-edit", {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
}
