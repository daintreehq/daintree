import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecuteCloneOptions } from "../../../ipc/handlers/projectCrud/gitClone.js";
import { AppError, GitOperationError } from "../../../utils/errorTypes.js";
import { localPlacementAuthority, ProjectAcrossHostsService } from "../service.js";
import { aliasRemote, commit, git, makeBare, makeRepo, tempRoot } from "./gitFixtures.js";
import { createTestHost, listConfigRemotes, plainClone, settled } from "./testService.js";

let root: string;
let bare: string;
const URL = "https://example.test/daintreehq/daintree.git";

beforeAll(() => {
  root = tempRoot("pah-svc-");
  bare = makeBare(root, "origin");
  aliasRemote(URL, bare);
  const seed = makeRepo(root, "seed", bare);
  fs.mkdirSync(path.join(seed, ".daintree", "recipes"), { recursive: true });
  fs.writeFileSync(
    path.join(seed, ".daintree", "recipes", "setup.json"),
    JSON.stringify({ id: "inrepo-setup", name: "Setup" })
  );
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "recipes"]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", "feature/host-chip"]);
  commit(seed, "feature");
  git(seed, ["push", "-q", "-u", "origin", "feature/host-chip"]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const branch = { name: "feature/host-chip", remoteBranch: "feature/host-chip" };
let opCounter = 0;
const nextOpId = () => `op-${++opCounter}`;

const ALLOW_PLACEMENT = { assertMayPlace: () => undefined };

describe("cloneAndOpen", () => {
  it("clones, registers, creates the branch's worktree and keeps the outcome", async () => {
    const host = createTestHost(root, "studio-a");
    const destination = path.join(root, "studio-a-home", "Projects", "daintree");
    const opId = nextOpId();
    const outcome = await host.service.cloneAndOpen({
      opId,
      source: { kind: "remote", url: URL },
      destination,
      branch,
      options: { submodules: false, depth: "full" },
      setupRecipeId: "inrepo-setup",
    });
    expect(outcome).toMatchObject({
      ok: true,
      projectPath: destination,
      worktreePath: path.join(`${destination}-worktrees`, "feature-host-chip"),
      setupRecipeId: "inrepo-setup",
    });
    // Cloned from another machine's word: a fresh identity, never an old project's.
    expect(host.registerProject).toHaveBeenCalledWith(destination, { fresh: true });
    expect(host.projects.map((p) => p.path)).toEqual([destination]);
    expect(host.createWorktree).toHaveBeenCalledWith(
      destination,
      expect.objectContaining({
        baseBranch: "origin/feature/host-chip",
        newBranch: "feature/host-chip",
        fromRemote: true,
        collisionPolicy: "error",
      })
    );
    expect(host.focusWorktree).toHaveBeenCalled();
    const record = host.service.operationStatus(opId);
    expect(record.status).toBe("succeeded");
    const projectId = host.projects[0]!.id;
    expect(host.service.takePendingSetup(projectId)).toMatchObject({ recipeId: "inrepo-setup" });
    expect(host.service.takePendingSetup(projectId)).toBeNull();
  });

  it("lets a second client join a clone of the same repository into the same folder", async () => {
    const host = createTestHost(root, "studio-b");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      await gate;
      await plainClone(options);
    });
    const destination = path.join(root, "studio-b-home", "daintree");
    const request = {
      source: { kind: "remote" as const, url: URL },
      destination,
      branch: null,
      options: { submodules: false, depth: "full" as const },
      setupRecipeId: null,
    };
    const first = host.service.cloneAndOpen({ ...request, opId: "first" });
    const second = host.service.cloneAndOpen({
      ...request,
      opId: "second",
      source: { kind: "remote", url: "git@example.test:daintreehq/daintree.git" },
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(host.clone).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(host.service.operationStatus("second").status).toBe("succeeded");
  });

  it("cancels on request and leaves nothing registered", async () => {
    const host = createTestHost(root, "studio-c");
    host.clone.mockImplementation(
      (options: ExecuteCloneOptions) =>
        new Promise<void>((_, reject) => {
          const cancel = () =>
            reject(new AppError({ code: "CANCELLED", message: "Clone cancelled" }));
          // On a slow runner the cancel can land while the destination checks are
          // still on disk, so the clone starts with its signal already aborted.
          if (options.signal.aborted) cancel();
          else options.signal.addEventListener("abort", cancel);
        })
    );
    const opId = nextOpId();
    const running = host.service.cloneAndOpen({
      opId,
      source: { kind: "remote", url: URL },
      destination: path.join(root, "studio-c-home", "daintree"),
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.service.cancelOperation(opId)).toBe(true);
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(host.service.operationStatus(opId).status).toBe("cancelled");
    expect(host.projects).toEqual([]);
  });

  it("records git's reason and its own words when the host can't clone", async () => {
    const host = createTestHost(root, "studio-d");
    host.clone.mockRejectedValue(
      new GitOperationError("auth-failed", "git@github.com: Permission denied (publickey).", {
        op: "clone",
      })
    );
    const opId = nextOpId();
    await expect(
      host.service.cloneAndOpen({
        opId,
        source: { kind: "remote", url: "git@github.com:daintreehq/daintree.git" },
        destination: path.join(root, "studio-d-home", "daintree"),
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).rejects.toBeInstanceOf(GitOperationError);
    await settled(host.registry, opId);
    expect(host.service.operationStatus(opId)).toMatchObject({
      status: "failed",
      error: { code: "auth-failed", message: expect.stringContaining("Permission denied") },
    });
  });

  it("refuses a folder that holds something else, before cloning", async () => {
    const host = createTestHost(root, "studio-e");
    const destination = path.join(root, "studio-e-home", "busy");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "x"), "x");
    await expect(
      host.service.cloneAndOpen({
        opId: nextOpId(),
        source: { kind: "remote", url: URL },
        destination,
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(host.clone).not.toHaveBeenCalled();
  });

  it("passes the submodule and depth choices to the clone", async () => {
    const host = createTestHost(root, "studio-f");
    await host.service.cloneAndOpen({
      opId: nextOpId(),
      source: { kind: "remote", url: URL },
      destination: path.join(root, "studio-f-home", "daintree"),
      branch: null,
      options: { submodules: true, depth: "partial" },
      setupRecipeId: null,
    });
    expect(host.clone).toHaveBeenCalledWith(
      expect.objectContaining({ depth: "partial", recurseSubmodules: true })
    );
  });
});

describe("repository bundles", () => {
  it("won't clone into a folder another project is still registered at", async () => {
    const host = createTestHost(root, "studio-reg");
    const destination = path.join(root, "studio-reg-home", "Projects", "gone");
    host.addProject(destination);
    expect(() =>
      host.service.cloneAndOpen({
        opId: nextOpId(),
        source: { kind: "remote", url: URL },
        destination,
        branch,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).toThrow(/already registered/);
    expect(host.clone).not.toHaveBeenCalled();
  });

  it("never suggests home itself as the projects folder", async () => {
    const host = createTestHost(root, "studio-home");
    const check = await host.service.suggestDestination({
      homeRelativePath: null,
      repoName: "bin",
      remoteUrls: [URL],
    });
    expect(check.path).toBe(path.join(root, "studio-home-home", "Projects", "bin"));
  });

  it("clones from a bundle, keeps its branches, drops origin and deletes the bundle", async () => {
    const source = createTestHost(root, "bundle-src");
    const target = createTestHost(root, "bundle-dst");
    const repo = makeRepo(root, "local-only");
    git(repo, ["checkout", "-q", "-b", "topic"]);
    commit(repo, "topic work");
    const project = source.addProject(repo);

    const created = await source.service.createBundle({ projectId: project.id });
    const slot = await target.service.bundles.expect();
    fs.copyFileSync(created.path, slot.path);
    await source.service.bundles.discard(created.token);
    expect(fs.existsSync(created.path)).toBe(false);

    const destination = path.join(root, "bundle-dst-home", "local-only");
    const outcome = await target.service.cloneAndOpen({
      opId: nextOpId(),
      source: { kind: "bundle", token: slot.token },
      destination,
      branch: { name: "main", remoteBranch: "main" },
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(outcome.ok).toBe(true);
    expect(git(destination, ["remote"])).toBe("");
    expect(git(destination, ["branch", "--format=%(refname:short)"]).split("\n").sort()).toEqual([
      "main",
      "topic",
    ]);
    expect(fs.existsSync(slot.path)).toBe(false);
    expect(target.service.bundles.get(slot.token)).toBeNull();
  });

  it("refuses a token it never minted", async () => {
    const target = createTestHost(root, "bundle-bad");
    await expect(
      target.service.cloneAndOpen({
        opId: nextOpId(),
        source: { kind: "bundle", token: "0".repeat(32) },
        destination: path.join(root, "bundle-bad-home", "x"),
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("opening a folder picked on the host", () => {
  it("registers any repository's main folder, whatever its remotes, and reopens a registered one as it is", async () => {
    const host = createTestHost(root, "studio-of");
    const repo = makeRepo(
      path.join(root, "studio-of-home"),
      "notes",
      "git@github.com:else/where.git"
    );
    const opened = await host.service.openFolder(repo);
    expect(opened).toMatchObject({
      projectPath: repo,
      worktreePath: null,
      canCheckOutBranch: false,
    });
    expect(host.registerProject).toHaveBeenCalledWith(repo);
    expect(host.projects.map((p) => p.path)).toEqual([repo]);

    host.registerProject.mockClear();
    const again = await host.service.openFolder(`${repo}${path.sep}`);
    expect(again.projectId).toBe(opened.projectId);
    expect(host.registerProject).not.toHaveBeenCalled();
  });

  it("refuses a folder that isn't a repository's main folder, registering nothing", async () => {
    const host = createTestHost(root, "studio-og");
    const repo = makeRepo(path.join(root, "studio-og-home"), "app", bare);
    const subfolder = path.join(repo, "src");
    fs.mkdirSync(subfolder);
    const plain = path.join(root, "studio-og-home", "plain");
    fs.mkdirSync(plain);
    for (const folder of [subfolder, plain, path.join(root, "studio-og-missing")]) {
      await expect(host.service.openFolder(folder)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(host.service.openFolder("relative/app")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(host.projects).toEqual([]);
  });
});

describe("opening a project the host already has", () => {
  it("focuses the worktree that already has the branch instead of making a suffixed one", async () => {
    const host = createTestHost(root, "studio-g");
    const clone = path.join(root, "studio-g-clone");
    git(root, ["clone", "-q", URL, clone]);
    const existing = path.join(root, "studio-g-wt");
    git(clone, ["worktree", "add", "-q", existing, "feature/host-chip"]);
    const project = host.addProject(clone);
    const noteChange = vi.fn();

    const opened = await host.service.open(
      {
        projectId: project.id,
        path: clone,
        remoteUrls: [URL],
        branch,
        branchRemoteUrl: URL,
      },
      { assertMayPlace: () => undefined, noteChange }
    );
    expect(opened.worktreePath).toBe(existing);
    expect(host.createWorktree).not.toHaveBeenCalled();
    expect(host.focusWorktree).toHaveBeenCalledWith(project.id, existing);
    // Focusing it changes the project's saved active worktree (#15918).
    expect(noteChange).toHaveBeenCalledWith(project.id);
  });

  it("opens the branch in its own worktree when it is on the remote, with no second question", async () => {
    const host = createTestHost(root, "studio-h");
    const clone = path.join(root, "studio-h-clone");
    git(root, ["clone", "-q", "--single-branch", "-b", "main", URL, clone]);
    const project = host.addProject(clone);

    const opened = await host.service.open({
      projectId: project.id,
      path: clone,
      remoteUrls: [URL],
      branch,
      branchRemoteUrl: URL,
    });
    expect(opened).toMatchObject({
      worktreePath: path.join(`${clone}-worktrees`, "feature-host-chip"),
      canCheckOutBranch: false,
      branchNote: null,
    });
    expect(host.createWorktree).toHaveBeenCalledWith(
      clone,
      expect.objectContaining({ collisionPolicy: "error", newBranch: "feature/host-chip" })
    );
    expect(host.focusWorktree).toHaveBeenCalledWith(
      project.id,
      path.join(`${clone}-worktrees`, "feature-host-chip")
    );
  });

  it("adopts an unregistered clone only when it is the same repository", async () => {
    const host = createTestHost(root, "studio-i");
    const clone = path.join(root, "studio-i-home", "Projects", "daintree");
    git(root, ["clone", "-q", URL, clone]);
    const opened = await host.service.open({
      projectId: null,
      path: clone,
      remoteUrls: [URL],
      branch: null,
      branchRemoteUrl: null,
    });
    expect(host.projects.map((p) => p.path)).toEqual([clone]);
    expect(opened.projectPath).toBe(clone);

    const unrelated = makeRepo(
      path.join(root, "studio-i-home", "Projects"),
      "other",
      "git@github.com:else/where.git"
    );
    await expect(
      host.service.open({
        projectId: null,
        path: unrelated,
        remoteUrls: [URL],
        branch: null,
        branchRemoteUrl: null,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(host.projects).toHaveLength(1);
  });

  it("adopts a picked clone outside its scan once it has checked the folder itself", async () => {
    const host = createTestHost(root, "studio-p");
    // Nowhere the bounded scan looks: only a person with the picker finds it.
    const outside = path.join(root, "studio-p-elsewhere", "deep", "down", "daintree");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    git(root, ["clone", "-q", URL, outside]);
    await expect(host.service.scan({ remoteUrls: [URL] })).resolves.toEqual([]);
    const opened = await host.service.open({
      projectId: null,
      path: outside,
      remoteUrls: [URL],
      branch: null,
      branchRemoteUrl: null,
    });
    expect(opened.projectPath).toBe(outside);
    expect(host.projects.map((p) => p.path)).toEqual([outside]);
  });

  it("refuses a picked folder that isn't the top of its own clone", async () => {
    const host = createTestHost(root, "studio-r");
    const clone = path.join(root, "studio-r-elsewhere", "daintree");
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(root, ["clone", "-q", URL, clone]);
    const subfolder = path.join(clone, "sub");
    fs.mkdirSync(subfolder);
    const linked = path.join(root, "studio-r-elsewhere", "linked");
    git(clone, ["worktree", "add", "-q", "-b", "linked-branch", linked]);
    const symlink = path.join(root, "studio-r-elsewhere", "alias");
    fs.symlinkSync(clone, symlink);
    const open = (folder: string) =>
      host.service.open({
        projectId: null,
        path: folder,
        remoteUrls: [URL],
        branch: null,
        branchRemoteUrl: null,
      });
    for (const folder of [subfolder, linked, symlink, path.join(root, "studio-r-missing")]) {
      await expect(open(folder)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    // A clone with no remote named to match is never adopted.
    await expect(
      host.service.open({
        projectId: null,
        path: clone,
        remoteUrls: [],
        branch: null,
        branchRemoteUrl: null,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(host.projects).toEqual([]);
  });
});

describe("source side", () => {
  it("describes the branch, remotes and committed recipes of the project", async () => {
    const host = createTestHost(root, "source-a");
    const clone = path.join(root, "source-a-home", "Projects", "daintree");
    git(root, ["clone", "-q", "-b", "feature/host-chip", URL, clone]);
    const project = host.addProject(clone);
    fs.writeFileSync(path.join(clone, "dirty.txt"), "uncommitted");
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(described).toMatchObject({
      branch: "feature/host-chip",
      branchCheck: { kind: "same-tip", remote: "origin" },
      cloneUrl: URL,
      hasUncommittedChanges: true,
      homeRelativePath: "Projects/daintree",
      recipes: [{ id: "inrepo-setup", name: "Setup" }],
    });
  });

  it("lists the commits a push would publish", async () => {
    const host = createTestHost(root, "source-d");
    const clone = path.join(root, "source-d-clone");
    git(root, ["clone", "-q", "-b", "feature/host-chip", URL, clone]);
    commit(clone, "Unpushed work");
    const project = host.addProject(clone);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(described.branchCheck).toMatchObject({ kind: "ahead", ahead: 1 });
    expect(described.unpushedCommits.map((c) => c.subject)).toEqual(["Unpushed work"]);
  });

  it("refuses a worktree path that isn't one of the project's", async () => {
    const host = createTestHost(root, "source-b");
    const clone = path.join(root, "source-b-clone");
    git(root, ["clone", "-q", URL, clone]);
    const project = host.addProject(clone);
    await expect(
      host.service.describeSource({ projectId: project.id, worktreePath: root })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("counts every commit a push would publish while previewing the newest 20", async () => {
    const host = createTestHost(root, "source-many");
    const clone = path.join(root, "source-many-clone");
    git(root, ["clone", "-q", "-b", "feature/host-chip", URL, clone]);
    for (let i = 0; i < 25; i++) commit(clone, `Work ${i}`);
    const project = host.addProject(clone);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(described.pushDestination).toEqual({ remote: "origin", branch: "feature/host-chip" });
    expect(described.headSha).toBe(git(clone, ["rev-parse", "HEAD"]));
    expect(described.unpushedCommits).toHaveLength(20);
    expect(described.unpushedCommitCount).toBe(25);
  });

  it("offers no push for a topic that tracks its base branch", async () => {
    const host = createTestHost(root, "source-base-tracking");
    const clone = path.join(root, "source-base-tracking-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "topic", "origin/main"]);
    commit(clone, "Topic work");
    const project = host.addProject(clone);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(described.remoteBranch).toBe("topic");
    expect(described.pushDestination).toBeNull();
    expect(described.unpushedCommits).toEqual([]);
  });

  it("leaves the branch alone when asked to skip it", async () => {
    const host = createTestHost(root, "source-skip");
    const clone = path.join(root, "source-skip-clone");
    git(root, ["clone", "-q", "-b", "feature/host-chip", URL, clone]);
    commit(clone, "Unpushed work");
    const project = host.addProject(clone);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
      skipBranch: true,
    });
    expect(described.branch).toBe("feature/host-chip");
    expect(described.branchCheck).toBeNull();
    expect(described.pushDestination).toBeNull();
    expect(described.unpushedCommits).toEqual([]);
  });

  it("describes a folder that isn't a git repository as such", async () => {
    const host = createTestHost(root, "source-plain");
    const folder = path.join(root, "source-plain-folder");
    fs.mkdirSync(folder, { recursive: true });
    const project = host.addProject(folder);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(described.isGitRepository).toBe(false);
    expect(described.branchCheck).toBeNull();
    expect(described.headSha).toBeNull();
  });

  it("pushes exactly the reviewed commit and sets the upstream where there was none", async () => {
    const host = createTestHost(root, "source-c");
    const clone = path.join(root, "source-c-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "new-branch"]);
    const reviewed = commit(clone, "new");
    const project = host.addProject(clone);
    const payload = {
      projectId: project.id,
      worktreePath: clone,
      branch: "new-branch",
      remote: "origin",
      remoteBranch: "new-branch",
      sha: reviewed,
    };
    expect(await host.service.pushBranch(payload)).toEqual({ ok: true });
    expect(git(clone, ["config", "branch.new-branch.remote"])).toBe("origin");
    expect(git(clone, ["config", "branch.new-branch.merge"])).toBe("refs/heads/new-branch");
    expect(git(clone, ["ls-remote", "origin", "refs/heads/new-branch"])).toContain(reviewed);
  });

  it("pushes no tags or other refs along with the commit", async () => {
    const host = createTestHost(root, "source-tags");
    const clone = path.join(root, "source-tags-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "tagged-branch"]);
    const reviewed = commit(clone, "tagged");
    git(clone, ["tag", "-a", "-m", "release", "v-tagged", reviewed]);
    git(clone, ["config", "push.followTags", "true"]);
    // A branch named like the sha must not stand in for the commit.
    git(clone, ["branch", reviewed, "main"]);
    const project = host.addProject(clone);
    const outcome = await host.service.pushBranch({
      projectId: project.id,
      worktreePath: clone,
      branch: "tagged-branch",
      remote: "origin",
      remoteBranch: "tagged-branch",
      sha: reviewed,
    });
    expect(outcome).toEqual({ ok: true });
    expect(git(clone, ["ls-remote", "origin", "refs/heads/tagged-branch"])).toContain(reviewed);
    expect(git(clone, ["ls-remote", "--tags", "origin", "v-tagged"])).toBe("");
  });

  it("pushes nothing once the branch moved past the reviewed commit", async () => {
    const host = createTestHost(root, "source-moved");
    const clone = path.join(root, "source-moved-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "moved-branch"]);
    const reviewed = commit(clone, "reviewed");
    commit(clone, "added by an agent afterwards");
    const project = host.addProject(clone);
    const outcome = await host.service.pushBranch({
      projectId: project.id,
      worktreePath: clone,
      branch: "moved-branch",
      remote: "origin",
      remoteBranch: "moved-branch",
      sha: reviewed,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "branch-moved" });
    expect(git(clone, ["ls-remote", "origin", "refs/heads/moved-branch"])).toBe("");
  });

  it("refuses a push to any branch but the branch's own name, or where git doesn't push it", async () => {
    const host = createTestHost(root, "source-elsewhere");
    const clone = path.join(root, "source-elsewhere-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "topic", "origin/main"]);
    const reviewed = commit(clone, "topic work");
    const project = host.addProject(clone);
    const base = {
      projectId: project.id,
      worktreePath: clone,
      branch: "topic",
      remote: "origin",
      sha: reviewed,
    };
    await expect(host.service.pushBranch({ ...base, remoteBranch: "main" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await host.service.pushBranch({ ...base, remoteBranch: "topic" })).toMatchObject({
      ok: false,
      reason: "destination-changed",
    });
    expect(git(clone, ["ls-remote", "origin", "refs/heads/topic"])).toBe("");
  });

  it("hands back git's text when the remote refuses a non-fast-forward", async () => {
    const host = createTestHost(root, "source-rejected");
    const clone = path.join(root, "source-rejected-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["checkout", "-q", "-b", "rejected-branch"]);
    const first = commit(clone, "new");
    const project = host.addProject(clone);
    const payload = {
      projectId: project.id,
      worktreePath: clone,
      branch: "rejected-branch",
      remote: "origin",
      remoteBranch: "rejected-branch",
    };
    expect(await host.service.pushBranch({ ...payload, sha: first })).toEqual({ ok: true });
    git(clone, ["reset", "-q", "--hard", "HEAD~1"]);
    const rewritten = commit(clone, "rewritten");
    const refused = await host.service.pushBranch({ ...payload, sha: rewritten });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/rejected|non-fast-forward|fetch first/);
  });
});

describe("clones racing for one folder", () => {
  const stagingLeft = (parent: string) =>
    fs.readdirSync(parent).filter((name) => name.includes(".daintree-clone-"));

  it("refuses a second clone into a folder another clone is filling, whatever its source", async () => {
    const host = createTestHost(root, "race-a");
    const destination = path.join(root, "race-a-home", "daintree");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      await plainClone(options);
      await gate;
    });
    const first = host.service.cloneAndOpen({
      opId: nextOpId(),
      source: { kind: "remote", url: URL },
      destination,
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = host.service.cloneAndOpen({
      opId: nextOpId(),
      source: { kind: "remote", url: "git@example.test:someone-else/fork.git" },
      destination,
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    await expect(second).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Another clone is already going into this folder.",
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true, projectPath: destination });
    expect(fs.existsSync(path.join(destination, ".git"))).toBe(true);
    expect(stagingLeft(path.dirname(destination))).toEqual([]);
  });

  it("never replaces what appeared in the folder mid-clone, and removes only its own staging", async () => {
    const host = createTestHost(root, "race-b");
    const destination = path.join(root, "race-b-home", "daintree");
    host.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      await plainClone(options);
      // Another process (a clone from elsewhere, a person) fills the folder meanwhile.
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "theirs.txt"), "keep me");
    });
    await expect(
      host.service.cloneAndOpen({
        opId: nextOpId(),
        source: { kind: "remote", url: URL },
        destination,
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fs.readdirSync(destination)).toEqual(["theirs.txt"]);
    expect(fs.readFileSync(path.join(destination, "theirs.txt"), "utf8")).toBe("keep me");
    expect(stagingLeft(path.dirname(destination))).toEqual([]);
    expect(host.projects).toEqual([]);
  });

  it("leaves a folder another clone published alone when its own clone fails", async () => {
    const host = createTestHost(root, "race-c");
    const destination = path.join(root, "race-c-home", "daintree");
    host.clone.mockImplementation(async () => {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "theirs.txt"), "keep me");
      throw new GitOperationError("unknown", "fatal: something broke", { op: "clone" });
    });
    await expect(
      host.service.cloneAndOpen({
        opId: nextOpId(),
        source: { kind: "remote", url: URL },
        destination,
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
      })
    ).rejects.toBeInstanceOf(GitOperationError);
    expect(fs.readdirSync(destination)).toEqual(["theirs.txt"]);
    expect(stagingLeft(path.dirname(destination))).toEqual([]);
  });
});

describe("remotes with credentials in them", () => {
  const SECRET_URL = "https://greg:ghp_s3cret@example.test/daintreehq/daintree.git";

  it("never describes or matches a remote with its user info", async () => {
    const host = createTestHost(root, "creds-a");
    const clone = path.join(root, "creds-a-clone");
    git(root, ["clone", "-q", URL, clone]);
    git(clone, ["remote", "set-url", "origin", SECRET_URL]);
    const project = host.addProject(clone);
    const described = await host.service.describeSource({
      projectId: project.id,
      worktreePath: null,
    });
    expect(JSON.stringify(described)).not.toMatch(/s3cret|greg@/);
    expect(described.cloneUrl).toBe("https://example.test/daintreehq/daintree.git");
    expect(described.remotes).toEqual([
      { name: "origin", url: "https://example.test/daintreehq/daintree.git" },
    ]);

    const matches = await host.service.find({ remoteUrls: [URL], committedProjectId: null });
    expect(matches.map((m) => m.path)).toEqual([clone]);
    expect(JSON.stringify(matches)).not.toMatch(/s3cret|greg@/);
  });
});

describe("a push that doesn't finish", () => {
  function slowRemote(name: string): { clone: string; payload: Parameters<typeof pushOf>[1] } {
    const slowBare = makeBare(root, name);
    const hook = path.join(slowBare, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nsleep 20\n");
    fs.chmodSync(hook, 0o755);
    const clone = makeRepo(root, `${name}-clone`, slowBare);
    return {
      clone,
      payload: {
        projectId: "",
        worktreePath: clone,
        branch: "main",
        remote: "origin",
        remoteBranch: "main",
        sha: git(clone, ["rev-parse", "HEAD"]),
      },
    };
  }
  const pushOf = (
    host: ReturnType<typeof createTestHost>,
    payload: {
      projectId: string;
      worktreePath: string;
      branch: string;
      remote: string;
      remoteBranch: string;
      sha: string;
    },
    signal?: AbortSignal,
    timeoutMs?: number
  ) => host.service.pushBranch(payload, signal, timeoutMs);

  it("is cancelled on request, killing git", async () => {
    const host = createTestHost(root, "push-cancel");
    const { clone, payload } = slowRemote("push-cancel-origin");
    const project = host.addProject(clone);
    const controller = new AbortController();
    const started = Date.now();
    const pushing = pushOf(host, { ...payload, projectId: project.id }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(pushing).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is stopped and reported once it runs past its timeout", async () => {
    const host = createTestHost(root, "push-timeout");
    const { clone, payload } = slowRemote("push-timeout-origin");
    const project = host.addProject(clone);
    const outcome = await pushOf(host, { ...payload, projectId: project.id }, undefined, 300);
    expect(outcome).toEqual({
      ok: false,
      reason: "timeout",
      message: "git push took too long and was stopped.",
    });
  });
});

describe("placing a worktree asked for on another host", () => {
  function hostWithClone(name: string) {
    const host = createTestHost(root, name);
    const clone = path.join(root, `${name}-home`, "Projects", "daintree");
    git(root, ["clone", "-q", URL, clone]);
    return { host, clone, project: host.addProject(clone) };
  }

  const placed = {
    newBranch: "feature/placed",
    baseBranch: "main",
    fromRemote: false,
    useExistingBranch: false,
    relativePath: "../daintree-worktrees/feature-placed",
    recipeId: "inrepo-setup",
  };

  it("creates the exact branch at the carried path, keeps the outcome and leaves the recipe for the first view", async () => {
    const { host, clone, project } = hostWithClone("place-a");
    const opId = nextOpId();
    const outcome = await host.service.placeWorktree(
      {
        opId,
        projectId: project.id,
        worktree: placed,
      },
      ALLOW_PLACEMENT
    );
    const expected = path.join(
      root,
      "place-a-home",
      "Projects",
      "daintree-worktrees",
      "feature-placed"
    );
    expect(outcome).toMatchObject({
      ok: true,
      projectId: project.id,
      worktreePath: expected,
      setupRecipeId: "inrepo-setup",
      branchNote: null,
    });
    expect(host.createWorktree).toHaveBeenCalledWith(clone, {
      baseBranch: "main",
      newBranch: "feature/placed",
      path: expected,
      fromRemote: false,
      useExistingBranch: false,
      collisionPolicy: "error",
    });
    expect(git(expected, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/placed");
    expect(host.focusWorktree).toHaveBeenCalledWith(project.id, expected);
    // The outcome is retained by opId for a Shell whose link dropped.
    expect(host.service.operationStatus(opId)).toMatchObject({
      status: "succeeded",
      result: { worktreePath: expected },
    });
    expect(host.service.takePendingSetup(project.id)).toEqual({
      projectId: project.id,
      recipeId: "inrepo-setup",
      worktreePath: expected,
    });

    // Asking again for the same branch finds that worktree rather than suffixing a new one.
    const again = await host.service.placeWorktree(
      {
        opId: nextOpId(),
        projectId: project.id,
        worktree: { ...placed, recipeId: null },
      },
      ALLOW_PLACEMENT
    );
    expect(again).toMatchObject({ ok: true, worktreePath: expected });
    expect(host.createWorktree).toHaveBeenCalledTimes(1);
  });

  it("asks the caller's authority before it records or creates anything", async () => {
    const { host, project } = hostWithClone("place-refused");
    const opId = nextOpId();
    const refuse = {
      assertMayPlace: (projectId: string) => {
        expect(projectId).toBe(project.id);
        throw new AppError({ code: "DRIVEN_ELSEWHERE", message: "driven elsewhere" });
      },
    };
    expect(() =>
      host.service.placeWorktree({ opId, projectId: project.id, worktree: placed }, refuse)
    ).toThrow(/driven elsewhere/);
    expect(host.service.operationStatus(opId)).toEqual({ status: "unknown" });
    expect(host.createWorktree).not.toHaveBeenCalled();
    expect(host.focusWorktree).not.toHaveBeenCalled();
  });

  it("lets this machine's windows place only where no remote Shell drives", () => {
    const holder = (clientId: string) => ({
      leaseId: 1,
      endpointId: `${clientId}:1`,
      clientId,
      clientName: clientId === "local" ? "this-mac" : "greg-mbp",
      isHostLocal: clientId === "local",
      acquiredAt: 0,
    });
    const noteSessionChange = vi.fn();
    const lease = (held: ReturnType<typeof holder> | null) => ({
      getHolder: () => held,
      noteSessionChange,
    });
    expect(() => localPlacementAuthority(null).assertMayPlace("p")).not.toThrow();
    expect(() => localPlacementAuthority(lease(null)).assertMayPlace("p")).not.toThrow();
    expect(() => localPlacementAuthority(lease(holder("local"))).assertMayPlace("p")).not.toThrow();
    // A placement let through is this machine changing the project (#15918).
    expect(noteSessionChange.mock.calls).toEqual([
      ["p", null],
      ["p", null],
    ]);
    expect(() => localPlacementAuthority(lease(holder("client-b"))).assertMayPlace("p")).toThrow(
      expect.objectContaining({ code: "DRIVEN_ELSEWHERE" })
    );
    expect(noteSessionChange).toHaveBeenCalledTimes(2);
  });

  it("says a recipe the host's copy lacks won't run, and refuses an occupied or escaping path", async () => {
    const { host, clone, project } = hostWithClone("place-b");
    const noRecipe = await host.service.placeWorktree(
      {
        opId: nextOpId(),
        projectId: project.id,
        worktree: {
          ...placed,
          newBranch: "feature/b1",
          relativePath: null,
          recipeId: "local-only",
        },
      },
      ALLOW_PLACEMENT
    );
    expect(noRecipe).toMatchObject({ ok: true, setupRecipeId: null });
    expect((noRecipe as { branchNote: string | null }).branchNote).toMatch(/won't run/);

    const worktrees = `${path.basename(project.path)}-worktrees`;
    const occupied = path.join(path.dirname(project.path), worktrees, "taken");
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, "x"), "x");
    const opId = nextOpId();
    await expect(
      host.service.placeWorktree(
        {
          opId,
          projectId: project.id,
          worktree: {
            ...placed,
            newBranch: "feature/b2",
            relativePath: `../${worktrees}/taken`,
            recipeId: null,
          },
        },
        ALLOW_PLACEMENT
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(host.service.operationStatus(opId)).toMatchObject({ status: "failed" });

    // A path into a hidden folder, or a sibling not named after the project,
    // is the other machine's say-so: this host's own pattern is used instead.
    for (const [branch, relativePath] of [
      ["feature/b3", ".git/hooks"],
      ["feature/b4", "../bin"],
    ] as const) {
      const outcome = await host.service.placeWorktree(
        {
          opId: nextOpId(),
          projectId: project.id,
          worktree: { ...placed, newBranch: branch, relativePath, recipeId: null },
        },
        ALLOW_PLACEMENT
      );
      expect(outcome).toMatchObject({ ok: true });
      const placedAt = (outcome as { worktreePath: string }).worktreePath;
      expect(placedAt).not.toContain(`${path.sep}.git${path.sep}`);
      expect(path.basename(path.dirname(placedAt))).not.toBe(
        path.basename(path.dirname(project.path))
      );
    }
    expect(() =>
      host.service.placeWorktree(
        {
          opId: nextOpId(),
          projectId: project.id,
          worktree: { ...placed, relativePath: `${clone}/abs` },
        },
        ALLOW_PLACEMENT
      )
    ).toThrow(/relative/);
  });
});

describe("identify", () => {
  it("reports the project's remotes without credentials, offline", async () => {
    const host = createTestHost(root, "ident");
    const repo = makeRepo(
      root,
      "ident-repo",
      "https://user:secret@example.test/daintreehq/daintree.git"
    );
    const project = host.addProject(repo);
    const identity = await host.service.identify({ projectId: project.id });
    expect(identity.committedProjectId).toBeNull();
    expect(identity.remotes).toHaveLength(1);
    expect(identity.remotes[0]!.url).not.toContain("secret");
  });
});

describe("remote reads across lookups", () => {
  const OTHER_URL = "https://example.test/daintreehq/other.git";

  function countedHost(name: string) {
    const host = createTestHost(root, name);
    const reads: string[] = [];
    const service = new ProjectAcrossHostsService(host.deps, async (repoPath) => {
      reads.push(repoPath);
      return listConfigRemotes(repoPath);
    });
    return { host, service, reads };
  }

  it("reads each registered project's remotes once for lookups close together", async () => {
    const { host, service, reads } = countedHost("reads-a");
    const repos = [
      makeRepo(root, "reads-a-1", URL),
      makeRepo(root, "reads-a-2", URL),
      makeRepo(root, "reads-a-3", OTHER_URL),
    ];
    for (const repo of repos) host.addProject(repo);
    const payload = { remoteUrls: [URL], committedProjectId: null };

    const first = await service.find(payload);
    const second = await service.find(payload);
    const [third, fourth] = await Promise.all([service.find(payload), service.find(payload)]);

    expect(first.map((m) => m.path).sort()).toEqual([repos[0], repos[1]].sort());
    for (const later of [second, third, fourth]) expect(later).toEqual(first);
    expect(reads.sort()).toEqual([...repos].sort());
  });

  it("reflects a changed remote, a new project and a removed one on the next lookup", async () => {
    const { host, service, reads } = countedHost("reads-b");
    const kept = makeRepo(root, "reads-b-kept", URL);
    const changed = makeRepo(root, "reads-b-changed", URL);
    host.addProject(kept);
    host.addProject(changed);
    const payload = { remoteUrls: [URL], committedProjectId: null };
    expect((await service.find(payload)).map((m) => m.path).sort()).toEqual([kept, changed].sort());

    git(changed, ["remote", "set-url", "origin", OTHER_URL]);
    reads.length = 0;
    expect((await service.find(payload)).map((m) => m.path)).toEqual([kept]);
    expect(reads).toEqual([changed]);
    const moved = await service.find({ remoteUrls: [OTHER_URL], committedProjectId: null });
    expect(moved.map((m) => m.path)).toEqual([changed]);
    expect(reads).toEqual([changed]);

    const added = makeRepo(root, "reads-b-added", URL);
    host.addProject(added);
    host.projects.splice(
      host.projects.findIndex((p) => p.path === kept),
      1
    );
    reads.length = 0;
    expect((await service.find(payload)).map((m) => m.path)).toEqual([added]);
    expect(reads).toEqual([added]);
  });

  it("shares readings between identify and find, while acting on a remote reads it fresh", async () => {
    const { host, service, reads } = countedHost("reads-c");
    const repo = makeRepo(root, "reads-c-repo", URL);
    const project = host.addProject(repo);

    const identity = await service.identify({ projectId: project.id });
    await service.identify({ projectId: project.id });
    await service.find({ remoteUrls: [URL], committedProjectId: null });
    expect(identity.remotes.map((r) => r.url)).toEqual([URL]);
    expect(reads).toEqual([repo]);

    await service.describeSource({ projectId: project.id, worktreePath: null, skipBranch: true });
    expect(reads).toEqual([repo, repo]);
    expect(
      (await service.match({ remoteUrls: [URL], committedProjectId: null })).map((m) => m.path)
    ).toEqual([repo]);
    expect(reads).toEqual([repo, repo, repo]);
  });
});
