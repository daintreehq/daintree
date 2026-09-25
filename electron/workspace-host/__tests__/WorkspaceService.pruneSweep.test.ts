import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
}));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

/**
 * A module store as a submodule checkout leaves one under
 * `<worktree gitdir>/modules/<name>`: a full repository with one commit, which
 * is at stake unless a remote-tracking ref already holds it.
 */
function moduleStore(tmp: string, name: string, subject: string, pushed: boolean): string {
  const source = path.join(tmp, `source-${name}`);
  git(tmp, "init", "-q", "-b", "main", source);
  writeFileSync(path.join(source, "file.txt"), subject);
  git(source, "add", "file.txt");
  git(source, "commit", "-q", "-m", subject);
  if (pushed) git(source, "update-ref", "refs/remotes/origin/main", "HEAD");
  return path.join(source, ".git");
}

describe("WorkspaceService worktree cleanup keeps stranded submodule commits (#12790)", () => {
  let tmp: string;
  let root: string;
  let registry: string;
  let service: WorkspaceService;
  const sendEvent = vi.fn();

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "worktree-prune-sweep-"));
    root = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", root);
    git(root, "commit", "-q", "--allow-empty", "-m", "root");
    git(root, "worktree", "add", "-q", "-b", "safe", path.join(tmp, "wt-safe"));
    git(root, "worktree", "add", "-q", "-b", "at-risk", path.join(tmp, "wt-at-risk"));
    git(root, "worktree", "add", "-q", "-b", "locked", path.join(tmp, "wt-locked"));
    git(root, "worktree", "lock", path.join(tmp, "wt-locked"));
    registry = path.join(root, ".git", "worktrees");

    cpSync(
      moduleStore(tmp, "safe", "already pushed", true),
      path.join(registry, "wt-safe", "modules", "lib"),
      { recursive: true }
    );
    cpSync(
      moduleStore(tmp, "at-risk", "stranded submodule work", false),
      path.join(registry, "wt-at-risk", "modules", "lib"),
      { recursive: true }
    );
    cpSync(
      moduleStore(tmp, "locked", "locked submodule work", false),
      path.join(registry, "wt-locked", "modules", "lib"),
      { recursive: true }
    );

    // Deleted outside Daintree: only the checkouts go, their metadata stays.
    for (const name of ["wt-safe", "wt-at-risk", "wt-locked"]) {
      rmSync(path.join(tmp, name), { recursive: true, force: true });
    }

    const { WorkspaceService } = await import("../WorkspaceService.js");
    service = new WorkspaceService(sendEvent);
    service["projectRootPath"] = root;
  });

  afterAll(() => {
    service?.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the safe phantom entry and keeps the one whose store holds unique commits", async () => {
    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-safe"))).toBe(false);
    expect(existsSync(path.join(registry, "wt-at-risk"))).toBe(true);
    expect(existsSync(path.join(registry, "wt-locked"))).toBe(true);

    // The stranded commit is still readable from the store that was kept.
    const storeLog = git(
      root,
      "--git-dir",
      path.join(registry, "wt-at-risk", "modules", "lib"),
      "log",
      "--format=%s"
    );
    expect(storeLog.trim()).toBe("stranded submodule work");

    const warnings = sendEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "worktree-prune-retained");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      adminDir: path.join(registry, "wt-at-risk"),
      worktreePath: path.join(tmp, "wt-at-risk"),
    });
    expect(warnings[0].message).toContain("stranded submodule work");
  });

  it("does not repeat the warning on a later sweep that finds the same loss", async () => {
    sendEvent.mockClear();
    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-at-risk"))).toBe(true);
    expect(
      sendEvent.mock.calls.filter(([event]) => event.type === "worktree-prune-retained")
    ).toHaveLength(0);
  });

  it("cleans the kept entry up once its commits reach a remote", async () => {
    const store = path.join(registry, "wt-at-risk", "modules", "lib");
    git(root, "--git-dir", store, "update-ref", "refs/remotes/origin/main", "HEAD");

    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-at-risk"))).toBe(false);
    expect(service["retainedPruneWarnings"].size).toBe(0);
    // Git agrees the registry now holds only the locked entry.
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("wt-at-risk");
  });
});
