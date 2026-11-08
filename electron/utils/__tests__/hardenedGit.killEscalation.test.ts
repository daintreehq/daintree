import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitPluginError } from "simple-git";
import { GIT_BLOCK_TIMEOUT_MS, GIT_KILL_GRACE_MS, createHardenedGit } from "../hardenedGit.js";

// A real child through the real simple-git: simple-git's own timeout and abort
// only ever send SIGINT and then wait for `close`, so a git that ignores SIGINT
// (blocked on a File Provider download) kept its task pending forever.

const roots: string[] = [];
const pids: number[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A `git` on PATH that ignores SIGINT and never answers. */
function installStubbornGit(): string {
  const bin = tempDir("daintree-stubborn-git-");
  const pidFile = path.join(bin, "pid");
  // `exec` keeps the ignored disposition, so the pid simple-git holds is the
  // process that ignores the signal.
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ntrap '' INT\necho $$ > '${pidFile}'\nexec sleep 120\n`,
    { mode: 0o755 }
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  return pidFile;
}

async function spawnedPid(pidFile: string): Promise<number> {
  await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/), {
    timeout: 5_000,
  });
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  pids.push(pid);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.stubEnv("DAINTREE_USER_DATA", tempDir("daintree-kill-userdata-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("git child that ignores SIGINT", () => {
  it("is killed after the block timeout's SIGINT goes unanswered", async () => {
    const pidFile = installStubbornGit();
    const git = await createHardenedGit(tempDir("daintree-kill-repo-"));

    let settled: unknown = "pending";
    void git.raw(["status"]).then(
      () => (settled = "resolved"),
      (error: unknown) => (settled = error)
    );
    const pid = await spawnedPid(pidFile);

    await vi.advanceTimersByTimeAsync(GIT_BLOCK_TIMEOUT_MS);
    expect(isAlive(pid)).toBe(true);
    expect(settled).toBe("pending");

    await vi.advanceTimersByTimeAsync(GIT_KILL_GRACE_MS);
    await vi.waitFor(() => expect(settled).not.toBe("pending"), { timeout: 5_000 });

    expect(settled).toBeInstanceOf(GitPluginError);
    expect((settled as GitPluginError).message).toBe("block timeout reached");
    expect(isAlive(pid)).toBe(false);
  });

  it("is killed after an abort's SIGINT goes unanswered", async () => {
    const pidFile = installStubbornGit();
    const controller = new AbortController();
    const git = await createHardenedGit(tempDir("daintree-kill-repo-"), controller.signal);

    let settled: unknown = "pending";
    void git.raw(["status"]).then(
      () => (settled = "resolved"),
      (error: unknown) => (settled = error)
    );
    const pid = await spawnedPid(pidFile);

    controller.abort();
    await vi.advanceTimersByTimeAsync(GIT_KILL_GRACE_MS - 1);
    expect(isAlive(pid)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(settled).not.toBe("pending"), { timeout: 5_000 });

    expect(settled).toBeInstanceOf(GitPluginError);
    expect(isAlive(pid)).toBe(false);
  });
});
