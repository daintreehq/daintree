import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execSync } from "child_process";

interface FixtureRepoOptions {
  name?: string;
  withFeatureBranch?: boolean;
  withMultipleFiles?: boolean;
  withImageFile?: boolean;
  withUncommittedChanges?: boolean;
  withSpreadCommits?: boolean;
  unstagedFileCount?: number;
}

export interface FixtureRepo {
  dir: string;
  cleanup: () => void;
}

function git(cmd: string, cwd: string) {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removePathSync(targetPath: string): void {
  const maxAttempts = process.platform === "win32" ? 12 : 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      waitSync(150 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to remove ${targetPath}`);
}

function makeFixtureCleanup(dir: string): () => void {
  return () => {
    const worktreeSibling = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
    if (existsSync(worktreeSibling)) {
      removePathSync(worktreeSibling);
    }
    removePathSync(dir);
  };
}

export function createFixtureRepo(options: FixtureRepoOptions = {}): FixtureRepo {
  const {
    name = "test-project",
    withFeatureBranch = false,
    withMultipleFiles = false,
    withImageFile = false,
    withUncommittedChanges = false,
    withSpreadCommits = false,
    unstagedFileCount = 0,
  } = options;

  if (!Number.isInteger(unstagedFileCount) || unstagedFileCount < 0) {
    throw new Error(`unstagedFileCount must be a non-negative integer, got ${unstagedFileCount}`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), `daintree-e2e-${name}-`));

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);

  if (withMultipleFiles) {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "index.ts"),
      'export const main = () => console.log("hello");\n'
    );
    writeFileSync(
      path.join(dir, "src", "utils.ts"),
      "export const add = (a: number, b: number) => a + b;\n"
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", private: true }, null, 2) + "\n"
    );
  }

  if (withImageFile) {
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    // 1x1 red PNG pixel (minimal valid PNG)
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64"
    );
    writeFileSync(path.join(dir, "assets", "logo.png"), pngBuffer);
  }

  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  if (withSpreadCommits) {
    const daysAgo = [50, 30, 10];
    for (const d of daysAgo) {
      const date = new Date(Date.now() - d * 86_400_000);
      date.setUTCHours(12, 0, 0, 0);
      const dateStr = date.toISOString();
      writeFileSync(path.join(dir, `file-${d}.md`), `# File ${d}\n`);
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      execSync(`git commit -m "commit ${d} days ago"`, {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr },
      });
    }
  }

  if (withFeatureBranch) {
    git("branch feature/test-branch", dir);
    const worktreeDir = path.join(
      dir,
      "..",
      path.basename(dir) + "-worktrees",
      "feature-test-branch"
    );
    mkdirSync(path.dirname(worktreeDir), { recursive: true });
    git(`worktree add ${JSON.stringify(worktreeDir)} feature/test-branch`, dir);
    writeFileSync(path.join(worktreeDir, "CHANGELOG.md"), "# Changelog\n\n- Feature branch\n");
    git("add -A", worktreeDir);
    git('commit -m "add changelog"', worktreeDir);
  }

  if (withUncommittedChanges) {
    writeFileSync(path.join(dir, "uncommitted.txt"), "This file is not committed.\n");
  }

  if (unstagedFileCount > 0) {
    const bulkDir = path.join(dir, "bulk-unstaged");
    mkdirSync(bulkDir, { recursive: true });
    const width = String(unstagedFileCount).length;
    for (let i = 1; i <= unstagedFileCount; i++) {
      const filename = `file-${String(i).padStart(width, "0")}.txt`;
      writeFileSync(path.join(bulkDir, filename), `# file ${i}\n`);
    }
  }

  return { dir, cleanup: makeFixtureCleanup(dir) };
}

/**
 * Repo whose `origin` remote has advanced past the local branch, plus an
 * uncommitted local change. Pushing the local branch is rejected as
 * non-fast-forward (`push-rejected-outdated`), which surfaces the Review Hub
 * push-error banner with its "Pull and rebase" / "Force push" recovery CTAs.
 *
 * Layout (all under tmpdir, siblings of `dir`):
 *  - `dir`         — the working repo opened by the app
 *  - `${dir}-bare` — the `file://` origin (bare)
 *  - `${dir}-clone2` — throwaway clone used to advance the remote
 *
 * Local history holds two commits so commit-message history navigation has
 * more than one entry to cycle through. `refs/remotes/origin/main` is fetched
 * after the remote advances so the force-push preview (`HEAD..origin/main`)
 * and the captured lease SHA both resolve against an ahead remote.
 */
export function createDivergedRemoteFixture(name = "review-hub-diverged"): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), `daintree-e2e-${name}-`));
  const bareDir = `${dir}-bare`;
  const cloneDir = `${dir}-clone2`;

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  writeFileSync(path.join(dir, "baseline.txt"), "baseline scaffold\n");
  git("add -A", dir);
  git('commit -m "chore: scaffold baseline"', dir);

  // `-b main` keeps the bare HEAD on `main`; without it the bare defaults to
  // `master` on runners where init.defaultBranch is unset (Ubuntu/Windows CI),
  // so the clone below would check out nothing and its `push origin main` would
  // fail with "src refspec main does not match any". Local paths work directly
  // as git remotes cross-platform — no `file://` URL (which mangles Windows
  // backslash paths into a bogus host segment).
  git(`init --bare -b main "${bareDir}"`, dir);
  git(`remote add origin "${bareDir}"`, dir);
  git("push -u origin main", dir);

  // Second clone advances the remote so origin/main diverges from local.
  git(`clone "${bareDir}" "${cloneDir}"`, dir);
  git('config user.email "test@daintree.dev"', cloneDir);
  git('config user.name "Daintree Test"', cloneDir);
  writeFileSync(path.join(cloneDir, "remote-only.txt"), "added on the remote\n");
  git("add -A", cloneDir);
  git('commit -m "remote: add remote-only file"', cloneDir);
  git("push origin main", cloneDir);

  // Fetch so refs/remotes/origin/main is ahead of local HEAD — required for the
  // captured lease SHA and the force-push "commits to discard" preview.
  git("fetch origin", dir);

  // Leave an uncommitted change so the Review Hub shows a stageable file.
  writeFileSync(path.join(dir, "local-change.txt"), "local work in progress\n");

  const cleanup = () => {
    for (const sibling of [cloneDir, bareDir]) {
      if (existsSync(sibling)) removePathSync(sibling);
    }
    makeFixtureCleanup(dir)();
  };

  return { dir, cleanup };
}

/**
 * Repo left mid-conflict so the Review Hub renders the `ConflictPanel`.
 *
 * `mode: "merge"` leaves `main` in a MERGING state (a `git merge feature` that
 * hit a conflict). `mode: "rebase"` leaves `feature` in a REBASING state (a
 * `git rebase main` that hit a conflict), which also drives the rebase
 * progress chip and sequence rail. Both edit the same line of `conflict.txt`
 * on two branches so the conflict is deterministic.
 */
export function createConflictFixtureRepo(
  mode: "merge" | "rebase",
  name = "review-hub-conflict"
): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), `daintree-e2e-${name}-${mode}-`));

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(path.join(dir, "conflict.txt"), "line one\nshared base line\nline three\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  git("branch feature", dir);

  git("checkout feature", dir);
  writeFileSync(path.join(dir, "conflict.txt"), "line one\nfeature edit\nline three\n");
  git("add -A", dir);
  git('commit -m "feature: edit shared line"', dir);

  git("checkout main", dir);
  writeFileSync(path.join(dir, "conflict.txt"), "line one\nmain edit\nline three\n");
  git("add -A", dir);
  git('commit -m "main: edit shared line"', dir);

  try {
    if (mode === "merge") {
      git("merge feature", dir);
    } else {
      git("checkout feature", dir);
      git("rebase main", dir);
    }
  } catch {
    // Expected — the conflict leaves the repo mid-operation, which is the
    // state the ConflictPanel renders against.
  }

  return { dir, cleanup: makeFixtureCleanup(dir) };
}

export interface InRepoRecipeSeed {
  /** Recipe name; the file is written as `.daintree/recipes/<slug>.json`. */
  name: string;
  /** Terminal definitions; defaults to a single terminal slot when omitted. */
  terminals?: Array<Record<string, unknown>>;
  showInEmptyState?: boolean;
}

interface FixtureRepoWithRecipesOptions extends FixtureRepoOptions {
  /** Team (in-repo) recipes to seed under `.daintree/recipes/` before opening. */
  inRepoRecipes?: InRepoRecipeSeed[];
  /** `package.json` scripts so RecipeRunner can surface suggestion pills. */
  packageScripts?: Record<string, string>;
}

function recipeSlug(name: string): string {
  // Mirrors safeRecipeFilename's slug rules (sans the diacritics strip, which
  // the ASCII recipe names used in E2E never need).
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase()
      .replace(/^[-.]+|[-.]+$/g, "") || "recipe"
  );
}

/**
 * Like createFixtureRepo, but seeds tracked `.daintree/recipes/*.json` team
 * recipes (and optional package.json scripts) and commits them, so the project
 * loads in-repo recipes on open. Used by recipe-coverage E2E to exercise the
 * Team scope section, shadowing badges, and RecipeRunner suggestion pills.
 */
export function createFixtureRepoWithRecipes(
  options: FixtureRepoWithRecipesOptions = {}
): FixtureRepo {
  const { inRepoRecipes = [], packageScripts, ...repoOptions } = options;
  const repo = createFixtureRepo(repoOptions);

  if (packageScripts) {
    writeFileSync(
      path.join(repo.dir, "package.json"),
      JSON.stringify(
        { name: repoOptions.name ?? "test-project", version: "1.0.0", scripts: packageScripts },
        null,
        2
      ) + "\n"
    );
  }

  if (inRepoRecipes.length > 0) {
    const recipesDir = path.join(repo.dir, ".daintree", "recipes");
    mkdirSync(recipesDir, { recursive: true });
    for (const seed of inRepoRecipes) {
      const slug = recipeSlug(seed.name);
      const recipe = {
        id: `inrepo-${slug}`,
        name: seed.name,
        terminals: seed.terminals ?? [{ type: "terminal", title: "", command: "", env: {} }],
        createdAt: 1_700_000_000_000,
        showInEmptyState: seed.showInEmptyState ?? false,
        autoAssign: "always",
      };
      writeFileSync(path.join(recipesDir, `${slug}.json`), JSON.stringify(recipe, null, 2) + "\n");
    }
  }

  if (packageScripts || inRepoRecipes.length > 0) {
    git("add -A", repo.dir);
    git('commit -m "seed recipes and scripts"', repo.dir);
  }

  return repo;
}

export function createFixtureRepos(count: number): FixtureRepo[] {
  const repos: FixtureRepo[] = [];
  for (let i = 0; i < count; i++) {
    const name = `project-${String.fromCharCode(65 + i)}`;
    repos.push(createFixtureRepo({ name }));
  }
  return repos;
}

export interface MultiProjectFixture {
  rootDir: string;
  repoA: string;
  repoB: string;
  cleanup: () => void;
}

export function createMultiProjectFixture(
  optsA?: FixtureRepoOptions,
  optsB?: FixtureRepoOptions
): MultiProjectFixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-multi-"));
  const { dir: repoA, cleanup: cleanupA } = createFixtureRepo({ name: "project-A", ...optsA });
  const { dir: repoB, cleanup: cleanupB } = createFixtureRepo({ name: "project-B", ...optsB });

  const cleanup = () => {
    cleanupA();
    cleanupB();
    removePathSync(rootDir);
  };

  return { rootDir, repoA, repoB, cleanup };
}
