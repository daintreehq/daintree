import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-git coverage for the `core.hooksPath` override (issue #11226).
 *
 * Deliberately no `simple-git` mock: the value under test is what actual git
 * does with the config we emit, which a mock cannot tell us.
 *
 * Not covered here: reproducing the original litter. That is git-lfs resolving
 * a relative `core.hooksPath` against its own CWD while self-installing, so it
 * needs a git-lfs binary. What is provable without one is the pair of
 * invariants that fix has to preserve — repo hooks stay blocked (#3742), and
 * hooks in the app-owned directory still dispatch (so git-lfs's `pre-push`
 * upload keeps working once it installs there).
 */

const TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hooks-userdata-"));
process.env.DAINTREE_USER_DATA = TEST_USER_DATA;

const HOOKS_DIR = path.join(TEST_USER_DATA, "git-hooks");

let repoDir: string;
let scratchDir: string;

/**
 * Fixture git, isolated from the developer's own config: an inherited
 * `commit.gpgSign=true` would hang the setup commit on a passphrase prompt, and
 * an inherited `core.hooksPath` would run their hooks against these temp repos.
 * The timeout keeps a wedged git from blocking the suite — vitest cannot
 * interrupt a synchronous native call.
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

function writeHook(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Registered outside the suite below: a skipped suite never runs its hooks, so
// cleanup declared inside it would leak the temp root on Windows.
afterAll(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

// Hooks are shell scripts; Windows git has no /bin/sh on the default PATH, and
// the WSL route carries its own POSIX hooks path that this suite cannot reach.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("hardened git core.hooksPath (real git)", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hooks-repo-"));
    repoDir = path.join(scratchDir, "repo");
    fs.mkdirSync(repoDir);

    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "contents\n");
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-qm", "init"]);
  });

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("does not execute a repo-supplied hook", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const sentinel = path.join(scratchDir, "repo-hook-fired");

    writeHook(path.join(repoDir, ".git", "hooks"), "post-checkout", `echo fired > "${sentinel}"`);

    const client = await createHardenedGit(repoDir);
    await client.raw(["checkout", "-q", "-b", "blocked-branch"]);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("executes a hook from the app-owned directory, keeping git-lfs pre-push viable", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const sentinel = path.join(scratchDir, "app-hook-fired");

    writeHook(HOOKS_DIR, "post-checkout", `echo fired > "${sentinel}"`);

    const client = await createHardenedGit(repoDir);
    await client.raw(["checkout", "-q", "-b", "app-hook-branch"]);

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  // `git worktree add` is the operation from the issue report: the CWD at
  // checkout-hook dispatch is the new worktree root, which is what git-lfs
  // resolved its relative hooks path against.
  //
  // Asserting the four hook files are absent from the worktree root would be
  // vacuous — nothing here installs them, so it passes against the empty value
  // too. Only git-lfs writes them, and it is not available in CI.
  it("dispatches hooks from the app-owned directory during worktree add", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const sentinel = path.join(scratchDir, "worktree-hook-fired");
    const worktreeDir = path.join(scratchDir, "wt");

    writeHook(HOOKS_DIR, "post-checkout", `echo fired > "${sentinel}"`);

    const client = await createHardenedGit(repoDir);
    await client.raw(["worktree", "add", "-q", worktreeDir, "-b", "wt-branch"]);

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it("reports the app-owned directory as the effective hooksPath", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");

    const client = await createHardenedGit(repoDir);
    const effective = (await client.raw(["config", "--get", "core.hooksPath"])).trim();

    expect(effective).toBe(HOOKS_DIR);
    expect(path.isAbsolute(effective)).toBe(true);
  });
});
