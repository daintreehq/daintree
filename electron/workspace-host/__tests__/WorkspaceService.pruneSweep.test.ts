import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleGit } from "simple-git";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

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
  return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  });
}

type RetainedEvent = Extract<WorkspaceHostEvent, { type: "worktree-prune-retained" }>;

describe("WorkspaceService worktree cleanup keeps stranded submodule commits (#12790)", () => {
  let tmp: string;
  let root: string;
  let registry: string;
  let service: WorkspaceService;
  let sendEvent: ReturnType<typeof vi.fn>;

  /**
   * A linked worktree with a real, absorbed submodule, deleted outside
   * Daintree: the checkout goes, `.git/worktrees/<name>/modules/lib` stays —
   * with `core.worktree` still naming the vanished submodule checkout.
   */
  function phantomWithSubmodule(name: string, stranded?: string): void {
    const checkout = path.join(tmp, name);
    git(root, "worktree", "add", "-q", "-b", name, checkout);
    git(checkout, "submodule", "update", "--init", "-q");
    if (stranded) git(path.join(checkout, "lib"), "commit", "-q", "--allow-empty", "-m", stranded);
    rmSync(checkout, { recursive: true, force: true });
  }

  function retainedEvents(): RetainedEvent[] {
    return sendEvent.mock.calls
      .map(([event]) => event as WorkspaceHostEvent)
      .filter((event): event is RetainedEvent => event.type === "worktree-prune-retained");
  }

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "worktree-prune-sweep-"));
    const lib = path.join(tmp, "lib");
    git(tmp, "init", "-q", "-b", "main", lib);
    git(lib, "commit", "-q", "--allow-empty", "-m", "library");
    root = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", root);
    git(root, "submodule", "add", "-q", lib, "lib");
    git(root, "commit", "-q", "-m", "add submodule");
    registry = path.join(root, ".git", "worktrees");

    sendEvent = vi.fn();
    const { WorkspaceService } = await import("../WorkspaceService.js");
    service = new WorkspaceService(sendEvent);
    service["projectRootPath"] = root;
  });

  afterEach(() => {
    service.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the safe phantom entry and keeps the one whose store holds unique commits", async () => {
    phantomWithSubmodule("wt-safe");
    phantomWithSubmodule("wt-at-risk", "stranded submodule work");

    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-safe"))).toBe(false);
    expect(existsSync(path.join(registry, "wt-at-risk"))).toBe(true);
    // The stranded commit is still readable from the store that was kept.
    const store = path.join(registry, "wt-at-risk", "modules", "lib");
    expect(git(root, "--git-dir", store, "--work-tree", store, "log", "-1", "--format=%s")).toBe(
      "stranded submodule work\n"
    );

    const warnings = retainedEvents();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      adminDir: path.join(registry, "wt-at-risk"),
      worktreePath: path.join(tmp, "wt-at-risk"),
    });
    expect(warnings[0].message).toContain("stranded submodule work");
  });

  it("never touches a locked phantom entry", async () => {
    phantomWithSubmodule("wt-locked", "locked submodule work");
    git(root, "worktree", "lock", path.join(tmp, "wt-locked"));

    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-locked", "modules", "lib"))).toBe(true);
    expect(retainedEvents()).toHaveLength(0);
  });

  it("reports the kept entry on every sweep, then cleans it up once the commits reach a remote", async () => {
    phantomWithSubmodule("wt-at-risk", "stranded submodule work");

    await service["sweepPrunableWorktreeEntries"]();
    await service["sweepPrunableWorktreeEntries"]();
    // Main decides when a view has actually shown it; the host keeps reporting.
    expect(retainedEvents()).toHaveLength(2);
    sendEvent.mockClear();

    const store = path.join(registry, "wt-at-risk", "modules", "lib");
    git(
      root,
      "--git-dir",
      store,
      "--work-tree",
      store,
      "update-ref",
      "refs/remotes/origin/rescued",
      "HEAD"
    );
    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(registry, "wt-at-risk"))).toBe(false);
    expect(retainedEvents()).toHaveLength(0);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain("wt-at-risk");
  });

  it("leaves an entry alone while its pointer cannot be read", async () => {
    phantomWithSubmodule("wt-unreadable");
    const adminDir = path.join(registry, "wt-unreadable");
    // A pointer that is a directory: git would prune this, but a failed probe
    // establishes nothing, so the entry stays and nothing claims it at risk.
    const pointer = path.join(adminDir, "gitdir");
    rmSync(pointer);
    mkdirSync(pointer);

    await service["sweepPrunableWorktreeEntries"]();

    expect(existsSync(path.join(adminDir, "modules", "lib"))).toBe(true);
    expect(retainedEvents()).toHaveLength(0);
  });

  it("runs selectively through the refresh path, the way the 90s reconcile does", async () => {
    phantomWithSubmodule("wt-safe");
    phantomWithSubmodule("wt-at-risk", "stranded submodule work");
    const { createHardenedGit } = await import("../../utils/hardenedGit.js");
    const repoGit = (await createHardenedGit(root)) as SimpleGit;
    service["git"] = repoGit;
    service["gitBacked"] = true;
    service["listService"].setGit(repoGit, root);
    const synced: string[][] = [];
    vi.spyOn(service, "syncMonitors").mockImplementation(async (worktrees) => {
      synced.push(worktrees.map((wt) => wt.path));
    });

    await service["discoverAndSyncWorktrees"]();

    expect(existsSync(path.join(registry, "wt-safe"))).toBe(false);
    expect(existsSync(path.join(registry, "wt-at-risk", "modules", "lib"))).toBe(true);
    // The sync sees the cleaned topology: the safe phantom is gone from it.
    expect(synced).toHaveLength(1);
    expect(synced[0]).not.toContain(path.join(tmp, "wt-safe"));
    expect(retainedEvents()).toHaveLength(1);
  });
});
