import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { GitPluginError } from "simple-git";
import { GIT_BLOCK_TIMEOUT_MS, GIT_KILL_GRACE_MS, createHardenedGit } from "../hardenedGit.js";
import { _resetGitProcessLifecycleForTesting, hasStoppedGitChild } from "../gitProcessLifecycle.js";

// A real child through the real simple-git: simple-git's own timeout and abort
// only ever send SIGINT and then wait for `close`, so a git that ignores SIGINT
// (blocked on a File Provider download) kept its task pending forever.

const require = createRequire(import.meta.url);
const cjsCp = require("child_process") as typeof import("child_process");
const realSpawn = cjsCp.spawn;

const roots: string[] = [];
const children: ChildProcess[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** A `git` on PATH that ignores SIGINT and never answers; returns its ready file. */
function installStubbornGit(): string {
  const bin = tempDir("daintree-stubborn-git-");
  const ready = path.join(bin, "ready");
  // `exec` keeps the ignored disposition, so the process simple-git holds is
  // the one that ignores the signal. The ready file is written after the trap.
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ntrap '' INT\necho ready > '${ready}'\nexec sleep 120\n`,
    { mode: 0o755 }
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  // simple-git's ESM build binds `spawn` as a named import.
  vi.spyOn(cjsCp, "spawn").mockImplementation(((...args: Parameters<typeof cjsCp.spawn>) => {
    const child = (realSpawn as (...a: unknown[]) => ChildProcess)(...args);
    children.push(child);
    return child;
  }) as typeof cjsCp.spawn);
  syncBuiltinESMExports();
  return ready;
}

/** Real-time wait that leaves the fake clock where it is. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the child");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Settle the task: the child's exit is real I/O, simple-git's last 50ms is not. */
async function settle(task: { settled: unknown }): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (task.settled === "pending") {
    if (Date.now() > deadline) throw new Error("task never settled");
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10);
  }
}

beforeEach(() => {
  vi.stubEnv("DAINTREE_USER_DATA", tempDir("daintree-kill-userdata-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (exited(child)) return;
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    })
  );
  _resetGitProcessLifecycleForTesting();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("git child that ignores SIGINT", () => {
  it("is killed after the block timeout's SIGINT goes unanswered", async () => {
    const ready = installStubbornGit();
    const repo = tempDir("daintree-kill-repo-");
    const git = await createHardenedGit(repo);

    const task = { settled: "pending" as unknown };
    void git.raw(["status"]).then(
      () => (task.settled = "resolved"),
      (error: unknown) => (task.settled = error)
    );
    await until(() => children.length === 1 && fs.existsSync(ready));
    const [child] = children;

    await vi.advanceTimersByTimeAsync(GIT_BLOCK_TIMEOUT_MS);
    expect(child.killed).toBe(true);
    expect(hasStoppedGitChild(repo)).toBe(true);

    await vi.advanceTimersByTimeAsync(GIT_KILL_GRACE_MS - 1);
    expect(exited(child)).toBe(false);
    expect(task.settled).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    // Exactly at the deadline, with the clock held there.
    await until(() => exited(child));
    expect(child.signalCode).toBe("SIGKILL");

    await settle(task);
    expect(task.settled).toBeInstanceOf(GitPluginError);
    expect((task.settled as GitPluginError).message).toBe("block timeout reached");
    expect(hasStoppedGitChild(repo)).toBe(false);
  });

  it("is killed after an abort's SIGINT goes unanswered", async () => {
    const ready = installStubbornGit();
    const controller = new AbortController();
    const repo = tempDir("daintree-kill-repo-");
    const git = await createHardenedGit(repo, controller.signal);

    const task = { settled: "pending" as unknown };
    void git.raw(["status"]).then(
      () => (task.settled = "resolved"),
      (error: unknown) => (task.settled = error)
    );
    await until(() => children.length === 1 && fs.existsSync(ready));
    const [child] = children;

    controller.abort();
    expect(child.killed).toBe(true);
    // Stopped but still running: no new git should start against its files.
    expect(hasStoppedGitChild(repo)).toBe(true);

    await vi.advanceTimersByTimeAsync(GIT_KILL_GRACE_MS - 1);
    expect(exited(child)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => exited(child));
    expect(child.signalCode).toBe("SIGKILL");

    await settle(task);
    expect(task.settled).toBeInstanceOf(GitPluginError);
    expect(hasStoppedGitChild(repo)).toBe(false);
  });
});
