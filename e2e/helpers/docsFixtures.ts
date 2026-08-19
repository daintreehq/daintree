import { execSync } from "child_process";
import path from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
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
