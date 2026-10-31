import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { CreateWorktreeOptions } from "../../../shared/types/git.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
}));

// Inherited selectors would point the fixture's git at some other repository.
const {
  GIT_DIR: _gitDir,
  GIT_WORK_TREE: _gitWorkTree,
  GIT_INDEX_FILE: _gitIndexFile,
  ...inheritedEnv
} = process.env;
const GIT_ENV = {
  ...inheritedEnv,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

type CreateResult = Extract<WorkspaceHostEvent, { type: "create-worktree-result" }>;

/**
 * #15733 against real repositories: a worker clone whose `origin/main` lags the
 * remote by one commit, the shape a worker host is in when another host pushed
 * since it last fetched.
 */
describe("WorkspaceService.createWorktree with fetchBase (#15733)", () => {
  let parent: string;
  let worker: string;
  let producer: string;
  let staleCommit: string;
  let freshCommit: string;
  const services: WorkspaceService[] = [];
  let seq = 0;

  async function create(
    options: Omit<CreateWorktreeOptions, "path">
  ): Promise<{ result: CreateResult; worktreePath: string }> {
    const events: WorkspaceHostEvent[] = [];
    const { WorkspaceService } = await import("../WorkspaceService.js");
    const service = new WorkspaceService((event) => {
      events.push(event);
    });
    services.push(service);
    const requestId = `create-${++seq}`;
    const worktreePath = path.join(parent, "worker-wt", `${options.newBranch}-${seq}`);
    await service.createWorktree(requestId, worker, { ...options, path: worktreePath });
    const result = events.find(
      (e): e is CreateResult => e.type === "create-worktree-result" && e.requestId === requestId
    );
    expect(result).toBeDefined();
    return { result: result!, worktreePath };
  }

  beforeEach(() => {
    parent = realpathSync.native(
      mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "fetch-base-"))
    );
    const origin = path.join(parent, "origin.git");
    producer = path.join(parent, "producer");
    worker = path.join(parent, "worker");

    git(parent, "init", "-q", "--bare", "-b", "main", origin);
    git(parent, "clone", "-q", origin, producer);
    writeFileSync(path.join(producer, "README.md"), "one\n");
    git(producer, "add", ".");
    git(producer, "commit", "-q", "-m", "one");
    git(producer, "push", "-q", "origin", "HEAD:main");

    git(parent, "clone", "-q", origin, worker);
    staleCommit = git(worker, "rev-parse", "origin/main");

    writeFileSync(path.join(producer, "README.md"), "two\n");
    git(producer, "commit", "-q", "-am", "two");
    git(producer, "push", "-q", "origin", "HEAD:main");
    freshCommit = git(producer, "rev-parse", "HEAD");

    expect(freshCommit).not.toBe(staleCommit);
    expect(git(worker, "rev-parse", "origin/main")).toBe(staleCommit);
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    // Disposed monitors can still have exiting git processes holding the cwd on Windows.
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("starts a remote base's new branch at the commit the remote has now, and names it", async () => {
    const { result, worktreePath } = await create({
      baseBranch: "origin/main",
      newBranch: "topic",
      fromRemote: true,
      fetchBase: true,
    });

    expect(result).toMatchObject({ success: true, branch: "topic", startCommit: freshCommit });
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(freshCommit);
    expect(git(worker, "rev-parse", "origin/main")).toBe(freshCommit);
    // Started from a commit, so no upstream: `topic` is not origin/main's counterpart.
    expect(() => git(worker, "rev-parse", "--abbrev-ref", "topic@{upstream}")).toThrow();
  });

  it("fetches a local base through its upstream and leaves the local branch where it was", async () => {
    const { result, worktreePath } = await create({
      baseBranch: "main",
      newBranch: "topic",
      fetchBase: true,
    });

    expect(result).toMatchObject({ success: true, startCommit: freshCommit });
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(freshCommit);
    expect(git(worker, "rev-parse", "refs/heads/main")).toBe(staleCommit);
  });

  it("still branches from the last-fetched ref without the option, and reports no start commit", async () => {
    const { result, worktreePath } = await create({
      baseBranch: "origin/main",
      newBranch: "topic",
      fromRemote: true,
    });

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("startCommit");
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(staleCommit);
  });

  it("fails with the fetch's reason and creates nothing when the fetch fails", async () => {
    git(worker, "remote", "set-url", "origin", path.join(parent, "missing.git"));

    const { result, worktreePath } = await create({
      baseBranch: "origin/main",
      newBranch: "topic",
      fromRemote: true,
      fetchBase: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Couldn't fetch base 'origin/main' from 'origin'");
    expect(result.error).toContain("missing.git");
    expect(refExists(worker, "refs/heads/topic")).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(worker, "rev-parse", "origin/main")).toBe(staleCommit);
  });

  it("refuses a local base that has no upstream instead of branching from it", async () => {
    git(worker, "branch", "--no-track", "local-only", staleCommit);

    const { result } = await create({
      baseBranch: "local-only",
      newBranch: "topic",
      fetchBase: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("has no upstream branch on a remote");
    expect(refExists(worker, "refs/heads/topic")).toBe(false);
  });

  it("suffixes a taken name from the fetched commit rather than reusing the older branch", async () => {
    // Unchecked-out, and the base is local (no `fromRemote`), so without a
    // fresh base `suffix` would check this stale branch out as is.
    git(worker, "branch", "--no-track", "topic", staleCommit);

    const { result, worktreePath } = await create({
      baseBranch: "main",
      newBranch: "topic",
      fetchBase: true,
    });

    expect(result).toMatchObject({ success: true, branch: "topic-2", startCommit: freshCommit });
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(freshCommit);
    expect(git(worker, "rev-parse", "refs/heads/topic")).toBe(staleCommit);
  });
});
