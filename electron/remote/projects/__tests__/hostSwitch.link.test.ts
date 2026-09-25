import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../services/projectAcrossHosts/defaults.js", () => ({
  getProjectAcrossHostsService: vi.fn(() => {
    throw new Error("tests hand each host its own service");
  }),
  createDefaultProjectAcrossHostsDeps: vi.fn(),
  _resetProjectAcrossHostsServiceForTest: vi.fn(),
}));

import type { IpcContext } from "../../../ipc/types.js";
import type { ExecuteCloneOptions } from "../../../ipc/handlers/projectCrud/gitClone.js";
import { AppError, GitOperationError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import {
  aliasRemote,
  commit,
  git,
  makeBare,
  makeRepo,
  tempRoot,
} from "../../../services/projectAcrossHosts/__tests__/gitFixtures.js";
import {
  createTestHost,
  plainClone,
  type TestHost,
} from "../../../services/projectAcrossHosts/__tests__/testService.js";
import { acceptClientBundleTransfer } from "../bundleSinks.js";
import { attachProjectsHost } from "../hostInstall.js";
import { HostSwitchService } from "../HostSwitchService.js";

const STUDIO = "studio-01";
const URL = "https://example.test/daintreehq/switch.git";
const ctx = {} as IpcContext;

let root: string;
let bare: string;
let socketDir: string;
let sessions: LinkSession[] = [];

beforeAll(() => {
  root = tempRoot("pah-link-");
  bare = makeBare(root, "switch-origin");
  aliasRemote(URL, bare);
  const seed = makeRepo(root, "seed", URL);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", "feature/host-chip"]);
  commit(seed, "feature");
  git(seed, ["push", "-q", "-u", "origin", "feature/host-chip"]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const session of sessions) session.close("test done");
  sessions = [];
  if (socketDir) await removeTempDir(socketDir);
});

let hostCounter = 0;

interface Rig {
  local: TestHost;
  studio: TestHost;
  service: HostSwitchService;
  client: LinkSession;
  from: { hostId: string };
  drops: { armed: boolean; remaining: number };
  reconnects: number;
}

async function rig(): Promise<Rig> {
  socketDir = await makeTempDir();
  const pair = await openSessionPair(socketDir);
  sessions.push(pair.host, pair.client);
  const n = ++hostCounter;
  const local = createTestHost(root, `local${n}`);
  const studio = createTestHost(root, `studio${n}`);
  attachProjectsHost(pair.host, studio.service);
  // What the host file client does once wired: accept only bundles this Shell asked for.
  pair.client.transfers.setSinkFactory((begin) => {
    const sink = acceptClientBundleTransfer(begin);
    if (!sink) throw new Error("Unexpected transfer destination");
    return sink;
  });
  const from = { hostId: "local" };
  const drops = { armed: false, remaining: 0 };
  const state: Rig = {
    local,
    studio,
    client: pair.client,
    from,
    drops,
    reconnects: 0,
    service: null as unknown as HostSwitchService,
  };
  state.service = new HostSwitchService({
    local: local.service,
    resolveSession: async (hostId) => {
      if (hostId !== STUDIO) throw new AppError({ code: "NOT_FOUND", message: hostId });
      if (drops.armed && drops.remaining > 0) {
        drops.remaining--;
        throw new AppError({ code: "HOST_DISCONNECTED", message: "link dropped" });
      }
      return pair.client;
    },
    hostOfSender: () => from.hostId,
    isKnownHost: (hostId) => hostId === STUDIO,
    whenReconnected: async () => {
      state.reconnects++;
      return true;
    },
    pollIntervalMs: 5,
  });
  return state;
}

const branch = { name: "feature/host-chip", remoteBranch: "feature/host-chip" };
let opCounter = 0;
const opId = () => `switch-${++opCounter}`;

function sourceProject(host: TestHost, name: string): { id: string; path: string } {
  const dir = path.join(root, name);
  git(root, ["clone", "-q", "-b", "feature/host-chip", URL, dir]);
  return host.addProject(dir);
}

describe("preparing a switch", () => {
  it("reads the branch on the source and what the target already has", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "prep-src");
    const existing = path.join(root, "prep-existing");
    git(root, ["clone", "-q", URL, existing]);
    r.studio.addProject(existing);

    const prepared = await r.service.prepare(ctx, {
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      worktreePath: null,
    });
    expect(prepared.branchCheck).toMatchObject({ kind: "same-tip", remote: "origin" });
    expect(prepared.candidates.map((c) => c.path)).toEqual([existing]);
    expect(prepared.cloneUrl).toBe(URL);

    const plan = await r.service.plan(ctx, {
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      worktreePath: null,
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.branchState?.kind).toBe("same-tip");
  });

  it("only lets a window start from its own host", async () => {
    const r = await rig();
    await expect(
      r.service.prepare(ctx, {
        fromHostId: STUDIO,
        toHostId: "local",
        projectId: "p",
        worktreePath: null,
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cloning onto the target", () => {
  it("clones from the remote as the host and reports the opened project", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "clone-src");
    const id = opId();
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: id,
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "remote", url: URL },
      destination: path.join(root, "clone-dst"),
      branch,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result).toMatchObject({
      kind: "opened",
      hostId: STUDIO,
      projectPath: path.join(root, "clone-dst"),
      worktreePath: path.join(root, "clone-dst-worktrees", "feature-host-chip"),
    });
    expect(r.service.status({ opId: id }).state).toBe("succeeded");
  });

  it("keeps following the clone across a dropped link", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "drop-src");
    r.studio.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      r.drops.armed = true;
      r.drops.remaining = 2;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await plainClone(options);
    });
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: opId(),
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "remote", url: URL },
      destination: path.join(root, "drop-dst"),
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result.kind).toBe("opened");
    expect(r.reconnects).toBeGreaterThan(0);
  });

  it("names the host and keeps git's words when the host can't reach the repository", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "denied-src");
    r.studio.clone.mockRejectedValue(
      new GitOperationError("auth-failed", "git@github.com: Permission denied (publickey).")
    );
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: opId(),
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "remote", url: URL },
      destination: path.join(root, "denied-dst"),
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result).toEqual({
      kind: "git-failed",
      step: "clone",
      hostId: STUDIO,
      reason: "auth-failed",
      message: "git@github.com: Permission denied (publickey).",
    });
  });
});

describe("sending a copy of a local-only repository", () => {
  it("carries a bundle from this machine to the host over the bulk lane", async () => {
    const r = await rig();
    const repo = makeRepo(root, "bundle-up-src");
    git(repo, ["checkout", "-q", "-b", "topic"]);
    commit(repo, "topic");
    const project = r.local.addProject(repo);
    const destination = path.join(root, "bundle-up-dst");
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: opId(),
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "bundle" },
      destination,
      branch: { name: "topic", remoteBranch: "topic" },
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result).toMatchObject({ kind: "opened", projectPath: destination });
    expect(git(destination, ["remote"])).toBe("");
    expect(fs.readdirSync(r.local.deps.bundleDir())).toEqual([]);
    expect(fs.readdirSync(r.studio.deps.bundleDir())).toEqual([]);
  });

  it("carries a bundle from the host to this machine going the other way", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const repo = makeRepo(root, "bundle-down-src");
    const project = r.studio.addProject(repo);
    const destination = path.join(root, "bundle-down-dst");
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: opId(),
      fromHostId: STUDIO,
      toHostId: "local",
      projectId: project.id,
      source: { kind: "bundle" },
      destination,
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result).toMatchObject({ kind: "opened", hostId: "local", projectPath: destination });
    expect(r.local.projects.map((p) => p.path)).toEqual([destination]);
    expect(fs.readdirSync(r.studio.deps.bundleDir())).toEqual([]);
    expect(fs.readdirSync(r.local.deps.bundleDir())).toEqual([]);
  });
});

describe("pushing from the source first", () => {
  it("reports git's refusal and changes nothing on the target", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "push-src");
    git(project.path, ["reset", "-q", "--hard", "HEAD~1"]);
    commit(project.path, "rewritten");
    const result = await r.service.execute(ctx, {
      kind: "push",
      opId: opId(),
      fromHostId: "local",
      projectId: project.id,
      worktreePath: project.path,
      branch: "feature/host-chip",
      remote: "origin",
      remoteBranch: "feature/host-chip",
    });
    expect(result).toMatchObject({ kind: "git-failed", step: "push", hostId: "local" });
    expect(r.studio.projects).toEqual([]);
  });
});

describe("opening what the target already has", () => {
  it("finds the branch's existing worktree on the host", async () => {
    const r = await rig();
    const existing = path.join(root, "open-existing");
    git(root, ["clone", "-q", URL, existing]);
    const worktree = path.join(root, "open-existing-wt");
    git(existing, ["worktree", "add", "-q", worktree, "feature/host-chip"]);
    const project = r.studio.addProject(existing);
    const result = await r.service.execute(ctx, {
      kind: "open",
      opId: opId(),
      toHostId: STUDIO,
      candidate: { projectId: project.id, path: existing },
      remoteUrls: [URL],
      branch,
      branchRemoteUrl: URL,
    });
    expect(result).toMatchObject({ kind: "opened", worktreePath: worktree });
    expect(r.studio.createWorktree).not.toHaveBeenCalled();
  });
});
