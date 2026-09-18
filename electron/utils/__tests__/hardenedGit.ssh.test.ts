import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-git coverage for the hardened profile's ssh transport (issue #12475).
 *
 * Deliberately no `simple-git` mock: the defect was what actual git does with
 * the `core.sshCommand` value we emit — it forked an empty program name — which
 * a mock cannot tell us.
 *
 * No network: a fake `ssh` first on PATH records its argv and serves a fixed
 * local repository through `git upload-pack`, exactly as a remote sshd would
 * after authentication. It never evaluates the command git asks it to run.
 */

/**
 * Deadline for each hardened git call, inside vitest's 15s test timeout: a
 * stalled transport then aborts and kills its child before the fixture is
 * removed, rather than outliving a timed-out test.
 */
const GIT_CALL_DEADLINE_MS = 10_000;

/**
 * Process env the hardened factory snapshots at creation. HOME and the
 * system-config switch keep the developer's own git config out of the run —
 * `buildHardenedGitEnv` strips `GIT_CONFIG_GLOBAL`, so that route is closed.
 */
const ISOLATED_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
] as const;
const priorEnv = new Map<string, string | undefined>();

let scratchDir: string;
let subDir: string;
let worktreeDir: string;
let sshLog: string;
let subSha: string;

/**
 * Fixture git, isolated from the developer's own config. The timeout keeps a
 * wedged git from blocking the suite — vitest cannot interrupt a synchronous
 * native call.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
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

function writeScript(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function sshArgv(): string[] {
  return fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").split("\n") : [];
}

/** Every `-o <option>` git passed to ssh — a bare option word would not count. */
function sshOptions(argv: readonly string[]): string[] {
  return argv.filter((_, i) => argv[i - 1] === "-o");
}

// The fake transport is a shell script found through PATH, which Git for
// Windows does not resolve for an extensionless file.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("hardened git ssh transport (real git)", () => {
  beforeAll(() => {
    scratchDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-ssh-repo-")));
    subDir = path.join(scratchDir, "sub");
    const superDir = path.join(scratchDir, "super");
    const binDir = path.join(scratchDir, "bin");
    worktreeDir = path.join(scratchDir, "wt");
    sshLog = path.join(scratchDir, "ssh.log");

    fs.mkdirSync(subDir);
    git(subDir, ["init", "-q"]);
    git(subDir, ["config", "user.email", "test@example.com"]);
    git(subDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(subDir, "file.txt"), "vendored\n");
    git(subDir, ["add", "file.txt"]);
    git(subDir, ["commit", "-qm", "sub"]);
    subSha = git(subDir, ["rev-parse", "HEAD"]).trim();

    // SCP-style URL, the shape the issue's `.gitmodules` used. The gitlink is
    // written straight into the index so building the fixture needs no clone.
    fs.mkdirSync(superDir);
    git(superDir, ["init", "-q"]);
    git(superDir, ["config", "user.email", "test@example.com"]);
    git(superDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(
      path.join(superDir, ".gitmodules"),
      '[submodule "build"]\n\tpath = build\n\turl = git@example.invalid:acme/build.git\n'
    );
    git(superDir, ["add", ".gitmodules"]);
    git(superDir, ["update-index", "--add", "--cacheinfo", `160000,${subSha},build`]);
    git(superDir, ["commit", "-qm", "super"]);
    git(superDir, ["worktree", "add", "-q", worktreeDir, "-b", "feature"]);

    fs.mkdirSync(binDir);
    writeScript(
      path.join(binDir, "ssh"),
      `printf '%s\\n' "$@" >> "${sshLog}"\nexec git upload-pack "${subDir}"`
    );

    for (const key of ISOLATED_ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.HOME = scratchDir;
    process.env.XDG_CONFIG_HOME = scratchDir;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_SSH;
    delete process.env.GIT_SSH_COMMAND;
  });

  afterAll(() => {
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  // Mirrors `initWorktreeSubmodules`: a fresh linked worktree, populated
  // through the hardened factory. A blank `core.sshCommand` fails this with
  // `cannot run :` / `unable to fork` before ssh is ever reached.
  it("populates an ssh-URL submodule in a new worktree", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");

    const client = await createHardenedGit(worktreeDir, AbortSignal.timeout(GIT_CALL_DEADLINE_MS));
    await client.raw([
      "submodule",
      "update",
      "--init",
      "--progress",
      "--recommend-shallow",
      "--",
      "build",
    ]);

    expect(fs.readFileSync(path.join(worktreeDir, "build", "file.txt"), "utf8")).toBe("vendored\n");
    expect(git(path.join(worktreeDir, "build"), ["rev-parse", "HEAD"]).trim()).toBe(subSha);

    // The flags are the point: without them an unknown host key or a locked
    // key blocks on a prompt no one can answer.
    const argv = sshArgv();
    expect(argv).toContain("git@example.invalid");
    expect(sshOptions(argv)).toEqual(
      expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=accept-new"])
    );
  });

  // The invariant the original blank existed for: repo config and inherited
  // env cannot choose the transport program.
  it("runs the pinned ssh, never a repo-configured or inherited one", async () => {
    const { createHardenedGit } = await import("../hardenedGit.js");
    const probeDir = path.join(scratchDir, "probe");
    const repoSentinel = path.join(scratchDir, "repo-ssh-fired");
    const envSentinel = path.join(scratchDir, "env-ssh-fired");
    const repoSsh = path.join(scratchDir, "repo-ssh");
    const envSsh = path.join(scratchDir, "env-ssh");
    writeScript(repoSsh, `echo fired > "${repoSentinel}"\nexit 1`);
    writeScript(envSsh, `echo fired > "${envSentinel}"\nexit 1`);

    fs.mkdirSync(probeDir);
    git(probeDir, ["init", "-q"]);
    git(probeDir, ["config", "core.sshCommand", repoSsh]);

    process.env.GIT_SSH_COMMAND = envSsh;
    process.env.GIT_SSH = envSsh;
    const client = await createHardenedGit(
      probeDir,
      AbortSignal.timeout(GIT_CALL_DEADLINE_MS)
    ).finally(() => {
      delete process.env.GIT_SSH_COMMAND;
      delete process.env.GIT_SSH;
    });

    const refs = await client.raw(["ls-remote", "ssh://git@example.invalid/acme/build.git"]);

    expect(refs).toContain(subSha);
    expect(fs.existsSync(repoSentinel)).toBe(false);
    expect(fs.existsSync(envSentinel)).toBe(false);
  });
});
