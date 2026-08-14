import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-git coverage for `GIT_LITERAL_PATHSPECS` in the hardened env.
 *
 * Deliberately no `simple-git` mock: the value under test is what actual git
 * does with the env we emit, which a mock cannot tell us. Asserting the env var
 * itself would just restate the source.
 *
 * Everything Daintree passes to git as a pathspec is meant as a literal file or
 * directory path — never a glob the user authored. Git disagrees by default: it
 * parses those paths as pathspecs, so wildmatch metacharacters in a legal
 * filename select the wrong files. `pages/[...slug].tsx` is a character class
 * matching one of `.slug`, so it resolves to siblings like `pages/s.tsx` and
 * not to the file itself.
 *
 * Bracket names are the realistic case — Next.js and Nuxt route files ship them
 * routinely, and any repo Daintree opens may contain one. `*` and `?` are the
 * other metacharacters, but they are illegal in filenames on Windows, so they
 * are left out to keep this suite cross-platform.
 */

const TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-literal-pathspec-ud-"));
const PRIOR_USER_DATA = process.env.DAINTREE_USER_DATA;
process.env.DAINTREE_USER_DATA = TEST_USER_DATA;

/** The name from the bug report: a character class matching one of `.slug`. */
const GLOBBY = "pages/[...slug].tsx";
/** Matched by GLOBBY-as-a-glob (`s` is in the class), so it is the file that gets hit by mistake. */
const SIBLING = "pages/s.tsx";

/** Every scratch root created below — each test gets its own, and all are removed at the end. */
const scratchDirs: string[] = [];
let scratchDir: string;
let repoDir: string;

/**
 * Fixture git, isolated from the developer's own config: an inherited
 * `commit.gpgSign=true` would hang the setup commit on a passphrase prompt.
 *
 * `/dev/null` is hardcoded rather than taken from `os.devNull`. Git treats that
 * exact string as its "no config file" sentinel and special-cases it on every
 * platform, including Git for Windows. `os.devNull` would substitute the native
 * `\\.\nul` there, which git rejects outright ("fatal: unable to access
 * 'NUL'"), so the portable-looking option is the one that breaks — and this
 * suite does run on Windows in stabilize.
 */
function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function write(repo: string, relativePath: string, contents: string): void {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function read(repo: string, relativePath: string): string {
  return fs.readFileSync(path.join(repo, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

// Registered outside the suite: a skipped suite never runs its hooks, and
// cleanup declared inside one would leak every temp root it created.
afterAll(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (PRIOR_USER_DATA === undefined) delete process.env.DAINTREE_USER_DATA;
  else process.env.DAINTREE_USER_DATA = PRIOR_USER_DATA;
});

describe("hardened git treats file paths literally, not as globs (real git)", () => {
  // A fresh repo per test: two of these mutate the working tree, and a shared
  // fixture would let one test's discard decide another's starting state.
  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-literal-pathspec-"));
    scratchDirs.push(scratchDir);
    repoDir = path.join(scratchDir, "repo");
    fs.mkdirSync(repoDir);

    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    write(repoDir, GLOBBY, "committed\n");
    write(repoDir, SIBLING, "committed\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "init"]);

    write(repoDir, GLOBBY, "edited in the bracket file\n");
    write(repoDir, SIBLING, "edited in the sibling\n");
  });

  it("scopes a per-file diff to the named file rather than its glob matches", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const client = await createHardenedGit(repoDir);

    const selected = (await client.diff(["--name-only", "--", GLOBBY])).split("\n").filter(Boolean);

    expect(selected).toEqual([GLOBBY]);
  });

  it("returns the named file's own content in its diff", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const client = await createHardenedGit(repoDir);

    const diff = await client.diff(["--no-color", "--", GLOBBY]);

    expect(diff).toContain("edited in the bracket file");
    expect(diff).not.toContain("edited in the sibling");
  });

  it("discards only the named file's changes, leaving a glob-matched sibling intact", async () => {
    // The data-loss shape of this bug: the user discards changes on one file in
    // the UI and loses uncommitted work in a different file.
    const { createHardenedGit } = await import("../hardenedGit.js");
    const client = await createHardenedGit(repoDir);

    await client.raw(["checkout", "--", GLOBBY]);

    expect(read(repoDir, GLOBBY)).toBe("committed\n");
    expect(read(repoDir, SIBLING)).toBe("edited in the sibling\n");
  });

  it("stages only the named file, leaving a glob-matched sibling unstaged", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const client = await createHardenedGit(repoDir);

    await client.add(["--", GLOBBY]);

    const staged = (await client.diff(["--cached", "--name-only"])).split("\n").filter(Boolean);

    expect(staged).toEqual([GLOBBY]);
  });

  // Git refuses `literal` alongside GLOB or ICASE — "fatal: global 'literal'
  // pathspec setting is incompatible with all other global pathspec settings",
  // exit 128 — so a developer who exports either would otherwise have every
  // path-bearing git call in the app fail. NOGLOB is included to pin the
  // asymmetry: git accepts that one next to literal, so this case documents the
  // non-conflict rather than guarding a failure.
  describe.each(["GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"])(
    "with an inherited %s",
    (inheritedVar) => {
      let priorValue: string | undefined;

      beforeEach(() => {
        priorValue = process.env[inheritedVar];
        process.env[inheritedVar] = "1";
      });

      afterEach(() => {
        if (priorValue === undefined) delete process.env[inheritedVar];
        else process.env[inheritedVar] = priorValue;
      });

      it("still resolves the path literally instead of failing", async () => {
        const { createHardenedGit } = await import("../hardenedGit.js");
        const client = await createHardenedGit(repoDir);

        const selected = (await client.diff(["--name-only", "--", GLOBBY]))
          .split("\n")
          .filter(Boolean);

        expect(selected).toEqual([GLOBBY]);
      });
    }
  );
});
