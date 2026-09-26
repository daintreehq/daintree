import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { projects, pty } = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; path: string; name: string }>,
  pty: {
    tracked: new Map<string, string>(),
    recorded: new Map<string, string>(),
  },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: { getAllProjectIdentities: () => projects },
}));

vi.mock("../../window/serviceRefs.js", () => ({
  getPtyClient: () => ({
    getTerminalProjectId: (id: string) => pty.tracked.get(id) ?? null,
    getTerminalAsync: async (id: string) =>
      pty.recorded.has(id) ? { id, projectId: pty.recorded.get(id) } : null,
  }),
}));

import { resolveLeaseTarget, type LeaseTargetResolvers } from "../driveLeaseTargets.js";
import { createLeaseTargetResolvers } from "../driveLeaseTargetResolvers.js";
import { getChannelLeaseTarget } from "../../ipc/channelLeasePolicy.js";
import { getOperationRegistry } from "../operations/index.js";

function stubResolvers(overrides: Partial<LeaseTargetResolvers> = {}): LeaseTargetResolvers {
  return {
    projectForPath: (p) => (p.startsWith("/repo/a") ? "a" : p.startsWith("/repo/b") ? "b" : null),
    projectForTerminal: (id) => (id === "ta" ? "a" : id === "tb" ? "b" : null),
    projectsForOperation: () => [],
    projectsForDevPreviewPanel: () => [],
    projectsForHelpSession: () => [],
    currentProjectId: () => null,
    ...overrides,
  };
}

const target = (channel: string) => getChannelLeaseTarget(channel)!;

describe("resolveLeaseTarget", () => {
  it("names the project the arguments point at, whatever the caller shows", () => {
    expect(
      resolveLeaseTarget(target("worktree:create"), [{ rootPath: "/repo/b" }], "a", stubResolvers())
    ).toEqual({ kind: "projects", projectIds: ["b"] });
    expect(
      resolveLeaseTarget(
        target("project:set-terminals"),
        [{ projectId: "b" }],
        "a",
        stubResolvers()
      )
    ).toEqual({
      kind: "projects",
      projectIds: ["b"],
    });
    expect(
      resolveLeaseTarget(
        target("agent-session:prepare-bookmark"),
        [{ terminalId: "tb" }],
        "a",
        stubResolvers()
      )
    ).toEqual({ kind: "projects", projectIds: ["b"] });
  });

  it("is unresolved for a missing, malformed or untraceable target", () => {
    for (const args of [[], [{}], ["/repo/a"], [{ rootPath: 7 }], [{ rootPath: "/elsewhere" }]]) {
      expect(
        resolveLeaseTarget(target("worktree:create"), args, "a", stubResolvers()).valueOf(),
        JSON.stringify(args)
      ).toMatchObject({ kind: "unresolved" });
    }
    expect(
      resolveLeaseTarget(target("plugin:project-reload"), [], null, stubResolvers())
    ).toMatchObject({
      kind: "unresolved",
    });
    expect(
      resolveLeaseTarget(target("terminal:kill"), ["gone"], "a", stubResolvers())
    ).toMatchObject({
      kind: "unresolved",
    });
  });

  it("checks every project a call touches, and falls back only where declared", () => {
    expect(
      resolveLeaseTarget(
        target("terminal:spawn"),
        [{ cols: 80, rows: 24, projectId: "a", cwd: "/repo/b" }],
        "a",
        stubResolvers()
      )
    ).toEqual({ kind: "projects", projectIds: ["a", "b"] });
    expect(
      resolveLeaseTarget(
        target("terminal:spawn"),
        [{ cols: 80, rows: 24, projectId: "a", cwd: "/tmp/x" }],
        "a",
        stubResolvers()
      )
    ).toEqual({ kind: "projects", projectIds: ["a"] });
    expect(
      resolveLeaseTarget(
        target("commands:execute"),
        [{ commandId: "c", context: {} }],
        "a",
        stubResolvers()
      )
    ).toEqual({ kind: "projects", projectIds: ["a"] });
    expect(
      resolveLeaseTarget(
        target("copytree:inject"),
        [{ terminalId: "ta", worktreeId: "/repo/b/wt" }],
        null,
        stubResolvers()
      )
    ).toEqual({ kind: "projects", projectIds: ["a", "b"] });
    expect(
      resolveLeaseTarget(target("project:init-git"), ["/tmp/new"], null, stubResolvers())
    ).toEqual({
      kind: "projects",
      projectIds: [],
    });
    expect(
      resolveLeaseTarget(target("terminal:restart-service"), [], "a", stubResolvers())
    ).toEqual({
      kind: "every",
    });
  });

  it("checks the Host's current project for a spawn that names none, as its handler uses it", () => {
    const resolvers = stubResolvers({ currentProjectId: () => "b" });
    expect(
      resolveLeaseTarget(target("terminal:spawn"), [{ cols: 80, rows: 24 }], "a", resolvers)
    ).toEqual({ kind: "projects", projectIds: ["b"] });
    expect(
      resolveLeaseTarget(
        target("terminal:spawn"),
        [{ cols: 80, rows: 24, projectId: "a" }],
        "a",
        resolvers
      )
    ).toEqual({ kind: "projects", projectIds: ["a"] });
  });

  it("answers later when a record needs a lookup, and a failed lookup refuses", async () => {
    const slow = stubResolvers({ projectForTerminal: async (id) => (id === "tb" ? "b" : null) });
    const pending = resolveLeaseTarget(target("terminal:kill"), ["tb"], "a", slow);
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual({ kind: "projects", projectIds: ["b"] });
    const broken = stubResolvers({
      projectForTerminal: () => Promise.reject(new Error("pty-host gone")),
    });
    await expect(
      resolveLeaseTarget(target("terminal:kill"), ["tb"], "a", broken)
    ).resolves.toMatchObject({
      kind: "unresolved",
    });
  });
});

describe("createLeaseTargetResolvers", () => {
  let root: string;
  let repoA: string;
  let repoB: string;
  let linked: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "lease-targets-"));
    repoA = path.join(root, "a");
    repoB = path.join(root, "b");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      git(
        repo,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i"
      );
    }
    linked = path.join(root, "b-worktrees", "feature");
    git(repoB, "worktree", "add", "-q", "-b", "feature", linked);
    symlinkSync(repoA, path.join(root, "a-link"));
    // A link inside project A that leads into project B.
    symlinkSync(repoB, path.join(repoA, "into-b"));
    projects.push({ id: "a", path: repoA, name: "a" }, { id: "b", path: repoB, name: "b" });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    projects.length = 0;
  });

  it("traces a repository root, a folder inside it, a linked worktree elsewhere and a symlinked spelling to the registered project", async () => {
    const r = createLeaseTargetResolvers();
    await expect(Promise.resolve(r.projectForPath(repoB))).resolves.toBe("b");
    await expect(Promise.resolve(r.projectForPath(path.join(repoA, "src")))).resolves.toBe("a");
    await expect(Promise.resolve(r.projectForPath(linked))).resolves.toBe("b");
    await expect(Promise.resolve(r.projectForPath(path.join(root, "a-link")))).resolves.toBe("a");
    await expect(Promise.resolve(r.projectForPath(path.join(root, "nowhere")))).resolves.toBeNull();
    expect(r.projectForPath("relative/path")).toBeNull();
    // Git follows the link, so the project it leads into is the one changed.
    await expect(Promise.resolve(r.projectForPath(path.join(repoA, "into-b")))).resolves.toBe("b");
  });

  it("reads a terminal's owner from main's spawn record, then the pty-host's", async () => {
    pty.tracked.set("t1", "a");
    pty.recorded.set("t2", "b");
    const r = createLeaseTargetResolvers();
    expect(r.projectForTerminal("t1")).toBe("a");
    await expect(Promise.resolve(r.projectForTerminal("t2"))).resolves.toBe("b");
    await expect(Promise.resolve(r.projectForTerminal("t3"))).resolves.toBeNull();
  });

  it("reads an operation's project from the registry", async () => {
    const registry = getOperationRegistry();
    let release!: () => void;
    const run = registry.run(
      {
        opId: "op-lease-target-1",
        kind: "worktree-create",
        projectId: "b",
        dedupKey: "k",
        fingerprint: "f",
      },
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const r = createLeaseTargetResolvers();
    expect(r.projectsForOperation("op-lease-target-1")).toEqual(["b"]);
    expect(r.projectsForOperation("op-unknown")).toEqual([]);
    release();
    await run;
  });
});
