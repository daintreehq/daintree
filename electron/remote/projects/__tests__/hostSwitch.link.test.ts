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
import {
  attachProjectsHost,
  HostOperationOwners,
  HostPushRecords,
  ProjectHostGrants,
  type ProjectsHostAuthority,
} from "../hostInstall.js";
import { ProjectLinkMethod } from "../linkMethods.js";
import { HostSwitchService } from "../HostSwitchService.js";

const STUDIO = "studio-01";
const SESSION = "session-1";
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

/** What the studio host knows of the Shell's views: which projects it has open, and who drives. */
interface Views {
  bound: Set<string>;
  driving: boolean;
  holder: string | null;
  /** The projects a change was noted on for a session no view of whose is on them. */
  noted: Array<[string, string | null]>;
}

interface Rig {
  local: TestHost;
  studio: TestHost;
  service: HostSwitchService;
  client: LinkSession;
  from: { hostId: string };
  drops: { armed: boolean; remaining: number };
  reconnects: number;
  views: Views;
  grants: ProjectHostGrants;
  pushRecords: HostPushRecords;
  operationOwners: HostOperationOwners;
  /** Runs when the Shell waits for the host to come back. */
  onReconnect: (() => Promise<void>) | null;
  /** Close the link and open a new one, the host serving it as it does a resumed session. */
  relink(): Promise<void>;
}

async function rig(): Promise<Rig> {
  socketDir = await makeTempDir();
  const n = ++hostCounter;
  const local = createTestHost(root, `local${n}`);
  const studio = createTestHost(root, `studio${n}`);
  const views: Views = { bound: new Set(), driving: true, holder: null, noted: [] };
  const authority: ProjectsHostAuthority = {
    boundEndpoints: (sessionId, projectId) =>
      sessionId === SESSION && views.bound.has(projectId)
        ? [{ endpointId: `remote:${sessionId}:${projectId}`, clientId: "shell" }]
        : [],
    isDriving: () => views.driving,
    holderEndpointId: () => views.holder,
    noteSessionChange: (projectId, sessionId) => views.noted.push([projectId, sessionId]),
  };
  const grants = new ProjectHostGrants();
  // Host-wide, as Host mode keeps them: a new link can still ask about a push.
  const pushRecords = new HostPushRecords();
  const operationOwners = new HostOperationOwners();
  const link = async (): Promise<LinkSession> => {
    const pair = await openSessionPair(socketDir);
    sessions.push(pair.host, pair.client);
    attachProjectsHost(pair.host, studio.service, {
      sessionId: SESSION,
      authority,
      grants,
      pushRecords,
      operationOwners,
    });
    // What the host file client does once wired: accept only bundles this Shell asked for.
    pair.client.transfers.setSinkFactory((begin) => {
      const sink = acceptClientBundleTransfer(begin);
      if (!sink) throw new Error("Unexpected transfer destination");
      return sink;
    });
    return pair.client;
  };
  const from = { hostId: "local" };
  const drops = { armed: false, remaining: 0 };
  const state: Rig = {
    local,
    studio,
    client: await link(),
    from,
    drops,
    reconnects: 0,
    views,
    pushRecords,
    operationOwners,
    grants,
    onReconnect: null,
    relink: async () => {
      state.client.close("link dropped");
      state.client = await link();
    },
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
      return state.client;
    },
    openSession: async (hostId) => {
      if (hostId !== STUDIO) throw new AppError({ code: "NOT_FOUND", message: hostId });
      return state.client;
    },
    hostOfSender: () => from.hostId,
    isKnownHost: (hostId) => hostId === STUDIO,
    whenReconnected: async () => {
      state.reconnects++;
      if (state.onReconnect) await state.onReconnect();
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
      sha: git(project.path, ["rev-parse", "HEAD"]),
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

describe("opening a folder picked on the host", () => {
  it("registers the repository there over the link and reports the opened project", async () => {
    const r = await rig();
    const folder = path.join(root, "open-folder-repo");
    git(root, ["clone", "-q", URL, folder]);
    const result = await r.service.execute(ctx, {
      kind: "open-folder",
      opId: opId(),
      toHostId: STUDIO,
      path: folder,
    });
    expect(result).toMatchObject({ kind: "opened", hostId: STUDIO, projectPath: folder });
    expect(r.studio.projects.map((p) => p.path)).toEqual([folder]);
    expect(r.local.projects).toEqual([]);
  });

  it("states the host's refusal for a folder that isn't a repository", async () => {
    const r = await rig();
    const plain = path.join(root, "open-folder-plain");
    fs.mkdirSync(plain, { recursive: true });
    await expect(
      r.service.execute(ctx, { kind: "open-folder", opId: opId(), toHostId: STUDIO, path: plain })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(r.studio.projects).toEqual([]);
  });
});

describe("a clone across a real reconnect", () => {
  it("follows the same operation on the host over a new link", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "relink-src");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cloning!: () => void;
    const started = new Promise<void>((resolve) => (cloning = resolve));
    r.studio.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      cloning();
      await gate;
      await plainClone(options);
    });
    r.onReconnect = async () => {
      await r.relink();
      release();
    };
    const id = opId();
    const running = r.service.execute(ctx, {
      kind: "clone",
      opId: id,
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "remote", url: URL },
      destination: path.join(root, "relink-dst"),
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    await started;
    const firstLink = r.client;
    firstLink.close("link dropped");
    const result = await running;
    expect(result).toMatchObject({ kind: "opened", projectPath: path.join(root, "relink-dst") });
    expect(r.client).not.toBe(firstLink);
    expect(r.reconnects).toBeGreaterThan(0);
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
    expect(r.studio.registry.status(id).status).toBe("succeeded");
  });
});

describe("remotes with credentials in them", () => {
  const SECRET_URL = "https://greg:ghp_s3cret@example.test/daintreehq/switch.git";

  it("shows, matches and clones by the remote without its credentials", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "creds-src");
    git(project.path, ["remote", "set-url", "origin", SECRET_URL]);
    const existing = path.join(root, "creds-existing");
    git(root, ["clone", "-q", URL, existing]);
    git(existing, ["remote", "set-url", "origin", SECRET_URL]);
    r.studio.addProject(existing);

    const prepared = await r.service.prepare(ctx, {
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      worktreePath: null,
    });
    expect(JSON.stringify(prepared)).not.toMatch(/s3cret|greg@/);
    expect(prepared.cloneUrl).toBe(URL);
    expect(prepared.candidates.map((c) => c.path)).toEqual([existing]);

    // Even a renderer that hands back a credential-bearing URL doesn't send it on.
    const result = await r.service.execute(ctx, {
      kind: "clone",
      opId: opId(),
      fromHostId: "local",
      toHostId: STUDIO,
      projectId: project.id,
      source: { kind: "remote", url: SECRET_URL },
      destination: path.join(root, "creds-dst"),
      branch: null,
      options: { submodules: false, depth: "full" },
      setupRecipeId: null,
    });
    expect(result.kind).toBe("opened");
    expect(r.studio.clone).toHaveBeenCalledWith(expect.objectContaining({ url: URL }));
  });
});

describe("what the host checks for itself", () => {
  const pushPayload = (projectId: string, worktreePath: string) => ({
    projectId,
    worktreePath,
    branch: "feature/host-chip",
    remote: "origin",
    remoteBranch: "feature/host-chip",
    sha: git(worktreePath, ["rev-parse", "HEAD"]),
  });

  it("refuses a push that doesn't name the reviewed commit", async () => {
    const r = await rig();
    const project = sourceProject(r.studio, "authz-no-sha");
    r.views.bound.add(project.id);
    const { sha: _sha, ...withoutSha } = pushPayload(project.id, project.path);
    await expect(r.client.call(ProjectLinkMethod.PUSH_BRANCH, withoutSha)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("pushes only for a session with a view of the project that drives it", async () => {
    const r = await rig();
    const project = sourceProject(r.studio, "authz-push");
    const payload = pushPayload(project.id, project.path);
    await expect(r.client.call(ProjectLinkMethod.PUSH_BRANCH, payload)).rejects.toMatchObject({
      code: "PERMISSION",
    });
    r.views.bound.add(project.id);
    r.views.driving = false;
    await expect(r.client.call(ProjectLinkMethod.PUSH_BRANCH, payload)).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    r.views.driving = true;
    await expect(r.client.call(ProjectLinkMethod.PUSH_BRANCH, payload)).resolves.toEqual({
      ok: true,
    });
  });

  it("clones only into a folder it checked and granted to this session, once", async () => {
    const r = await rig();
    const destination = path.join(root, "authz-clone");
    const start = (id: string, dest: string, destinationGrant?: string) =>
      r.client.call(ProjectLinkMethod.START_CLONE, {
        opId: id,
        source: { kind: "remote", url: URL },
        destination: dest,
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
        ...(destinationGrant ? { destinationGrant } : {}),
      });
    await expect(start(opId(), destination)).rejects.toMatchObject({ code: "PERMISSION" });

    const check = (await r.client.call(ProjectLinkMethod.CHECK_DESTINATION, {
      path: destination,
      remoteUrls: [URL],
      mintGrant: true,
    })) as { status: string; grant: string };
    expect(check.status).toBe("free");
    await expect(start(opId(), path.join(root, "authz-other"), check.grant)).rejects.toMatchObject({
      code: "PERMISSION",
    });
    const first = opId();
    await expect(start(first, destination, check.grant)).resolves.toBeNull();
    // A resend of the same start is not a second use; another clone is.
    await expect(start(first, destination, check.grant)).resolves.toBeNull();
    await expect(start(opId(), destination, check.grant)).rejects.toMatchObject({
      code: "PERMISSION",
    });
    // START_CLONE answers once the operation is registered; the clone itself
    // runs after that, so wait for the operation rather than for a moment.
    await vi.waitFor(() => expect(r.studio.registry.status(first).status).not.toBe("running"), {
      timeout: 10_000,
      interval: 10,
    });
    expect(r.studio.registry.status(first).status).toBe("succeeded");
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
  });

  it("lets only the session that started a clone stop it, or reuse its id", async () => {
    const r = await rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    r.studio.clone.mockImplementation(async (options: ExecuteCloneOptions) => {
      await gate;
      await plainClone(options);
    });
    const destination = path.join(root, "owned-clone");
    const grantFor = async (client: LinkSession, dest: string) =>
      (
        (await client.call(ProjectLinkMethod.CHECK_DESTINATION, {
          path: dest,
          remoteUrls: [URL],
          mintGrant: true,
        })) as { grant: string }
      ).grant;
    const start = (client: LinkSession, id: string, dest: string, grant: string) =>
      client.call(ProjectLinkMethod.START_CLONE, {
        opId: id,
        source: { kind: "remote", url: URL },
        destination: dest,
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
        destinationGrant: grant,
      });
    const id = opId();
    await expect(
      start(r.client, id, destination, await grantFor(r.client, destination))
    ).resolves.toBeNull();

    // Another Shell on this host: its own session and grants, the same host-wide records.
    const pair = await openSessionPair(socketDir);
    sessions.push(pair.host, pair.client);
    attachProjectsHost(pair.host, r.studio.service, {
      sessionId: "other-session",
      grants: new ProjectHostGrants(),
      pushRecords: r.pushRecords,
      operationOwners: r.operationOwners,
    });
    await expect(
      pair.client.call(ProjectLinkMethod.OPERATION_CANCEL, { opId: id })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    // Nor learn how it went: its outcome names what it made.
    await expect(
      pair.client.call(ProjectLinkMethod.OPERATION_STATUS, { opId: id })
    ).resolves.toEqual({ status: "unknown" });
    // A placement the host refuses claims nothing.
    const refused = opId();
    await expect(
      pair.client.call(ProjectLinkMethod.START_PLACE_WORKTREE, {
        opId: refused,
        projectId: "no-such-project",
        branch: "x",
        path: path.join(root, "nowhere-wt"),
      })
    ).rejects.toBeDefined();
    expect(r.operationOwners.mayClaim(refused, r.grants)).toBe(true);
    const elsewhere = path.join(root, "owned-clone-2");
    await expect(
      start(pair.client, id, elsewhere, await grantFor(pair.client, elsewhere))
    ).rejects.toMatchObject({ code: "PERMISSION" });

    // Its own session may.
    await r.client.call(ProjectLinkMethod.OPERATION_CANCEL, { opId: id });
    release();
    await vi.waitFor(() => expect(r.studio.registry.status(id).status).not.toBe("running"), {
      timeout: 10_000,
      interval: 10,
    });
  });

  it("opens the branch's worktree as part of opening, and refuses a checkout it never offered", async () => {
    const r = await rig();
    const existing = path.join(root, "authz-checkout");
    git(root, ["clone", "-q", URL, existing]);
    const project = r.studio.addProject(existing);
    const checkout = {
      projectId: project.id,
      branch,
      branchRemoteUrl: URL,
    };
    await expect(r.client.call(ProjectLinkMethod.CHECK_OUT, checkout)).rejects.toMatchObject({
      code: "PERMISSION",
    });

    const opened = await r.service.execute(ctx, {
      kind: "open",
      opId: opId(),
      toHostId: STUDIO,
      candidate: { projectId: project.id, path: existing },
      remoteUrls: [URL],
      branch,
      branchRemoteUrl: URL,
    });
    expect(opened).toMatchObject({
      kind: "opened",
      worktreePath: expect.any(String),
      canCheckOutBranch: false,
    });
    // Its worktree changes a project no view of this session's is on (#15918).
    expect(r.views.noted).toContainEqual([project.id, SESSION]);
    // Nothing was offered, so a checkout call stays refused.
    await expect(r.client.call(ProjectLinkMethod.CHECK_OUT, checkout)).rejects.toMatchObject({
      code: "PERMISSION",
    });
  });

  it("makes no worktree for a project another session drives, and offers the checkout instead", async () => {
    const r = await rig();
    const existing = path.join(root, "authz-driven");
    git(root, ["clone", "-q", URL, existing]);
    const project = r.studio.addProject(existing);
    r.views.holder = "remote:another-session:view-1";

    const opened = await r.service.execute(ctx, {
      kind: "open",
      opId: opId(),
      toHostId: STUDIO,
      candidate: { projectId: project.id, path: existing },
      remoteUrls: [URL],
      branch,
      branchRemoteUrl: URL,
    });
    expect(opened).toMatchObject({ kind: "opened", worktreePath: null, canCheckOutBranch: true });
    // Taking the offer is held to the lease: the other session still drives.
    await expect(
      r.client.call(ProjectLinkMethod.CHECK_OUT, {
        projectId: project.id,
        branch,
        branchRemoteUrl: URL,
      })
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(r.views.noted).toEqual([]);
  });

  /**
   * A project on the studio whose remote holds every push in a hook for 20s;
   * the hook leaves `marker` behind once git push is really under way.
   */
  function slowPushProject(r: Rig, name: string): { id: string; path: string; marker: string } {
    const slowBare = makeBare(root, `${name}-origin`);
    const marker = path.join(root, `${name}.pushing`);
    const hook = path.join(slowBare, "hooks", "pre-receive");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nsleep 20\n`);
    fs.chmodSync(hook, 0o755);
    const repo = makeRepo(root, `${name}-src`, slowBare);
    const project = r.studio.addProject(repo);
    r.views.bound.add(project.id);
    return { ...project, marker };
  }

  /** Wait until git push on the host has reached the remote's hook. */
  const gitPushRunning = (marker: string) =>
    vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000, interval: 10 });

  /** Resolves with the signal the host's push runs under, once it has started. */
  function hostPushStarted(r: Rig): Promise<AbortSignal> {
    const original = r.studio.service.pushBranch.bind(r.studio.service);
    return new Promise((resolve) => {
      vi.spyOn(r.studio.service, "pushBranch").mockImplementation((payload, signal, timeout) => {
        resolve(signal!);
        return original(payload, signal, timeout);
      });
    });
  }

  const pushStep = (id: string, project: { id: string; path: string }) => ({
    kind: "push" as const,
    opId: id,
    fromHostId: STUDIO,
    projectId: project.id,
    worktreePath: project.path,
    branch: "main",
    remote: "origin",
    remoteBranch: "main",
    sha: git(project.path, ["rev-parse", "main"]),
  });

  it("cancels a push on the host when the Shell cancels it", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const project = slowPushProject(r, "authz-slow");
    const started = hostPushStarted(r);
    const id = opId();
    const pushing = r.service.execute(ctx, pushStep(id, project));
    const signal = await started;
    await gitPushRunning(project.marker);
    expect(r.service.status({ opId: id }).state).toBe("running");
    await expect(r.service.cancel({ opId: id })).resolves.toBe(true);
    // Settles well inside the test's time limit only because git was killed:
    // the hook would hold the push for 20s.
    await expect(pushing).rejects.toMatchObject({ code: "CANCELLED" });
    expect(signal.aborted).toBe(true);
    expect(r.service.status({ opId: id }).state).toBe("cancelled");
  });

  it("stops the host's push when the link drops, then reports what the remote shows once back", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const project = slowPushProject(r, "authz-drop");
    const started = hostPushStarted(r);
    r.onReconnect = () => r.relink();
    const id = opId();
    const pushing = r.service.execute(ctx, pushStep(id, project));
    const signal = await started;
    await gitPushRunning(project.marker);
    expect(signal.aborted).toBe(false);
    r.client.close("link dropped");
    // Nobody is left to see it finish, so the host doesn't carry on unseen;
    // the remote may still have moved, so the Shell looks rather than guesses.
    const result = await pushing;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    const localSha = git(project.path, ["rev-parse", "main"]);
    expect(result).toEqual({
      kind: "push-unconfirmed",
      hostId: STUDIO,
      branch: "main",
      remote: "origin",
      remoteBranch: "main",
      observed: { localSha, remoteSha: null, remoteReachable: true },
    });
    await expect(
      r.client.call(ProjectLinkMethod.PUSH_STATUS, { opId: id, projectId: project.id })
    ).resolves.toEqual({ state: "interrupted" });
    expect(r.service.status({ opId: id }).state).toBe("failed");
  });
});

describe("a push whose answer was lost with the link", () => {
  /** A studio project whose origin already has main, with one new commit to push. */
  function pushableProject(r: Rig, name: string) {
    const originBare = makeBare(root, `${name}-origin`);
    const repo = makeRepo(root, `${name}-src`, originBare);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    const tip = commit(repo, "to push");
    const project = r.studio.addProject(repo);
    r.views.bound.add(project.id);
    return { ...project, bare: originBare, tip };
  }

  const pushStepFor = (id: string, project: { id: string; path: string }) => ({
    kind: "push" as const,
    opId: id,
    fromHostId: STUDIO,
    projectId: project.id,
    worktreePath: project.path,
    branch: "main",
    remote: "origin",
    remoteBranch: "main",
    sha: git(project.path, ["rev-parse", "main"]),
  });

  it("takes the host's settled record over a new link instead of pushing again", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const project = pushableProject(r, "lost-reply");
    const original = r.studio.service.pushBranch.bind(r.studio.service);
    const push = vi
      .spyOn(r.studio.service, "pushBranch")
      .mockImplementation(async (payload, signal, timeout) => {
        const outcome = await original(payload, signal, timeout);
        // The push landed; the answer never makes it back.
        r.client.close("link dropped");
        return outcome;
      });
    r.onReconnect = () => r.relink();
    const id = opId();

    await expect(r.service.execute(ctx, pushStepFor(id, project))).resolves.toEqual({
      kind: "pushed",
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(r.reconnects).toBe(1);
    expect(git(project.bare, ["rev-parse", "main"])).toBe(project.tip);
    await expect(
      r.client.call(ProjectLinkMethod.PUSH_STATUS, { opId: id, projectId: project.id })
    ).resolves.toEqual({ state: "settled", outcome: { ok: true } });
    // Another project can't read it.
    await expect(
      r.client.call(ProjectLinkMethod.PUSH_STATUS, { opId: id, projectId: "other" })
    ).resolves.toEqual({ state: "unknown" });
  });

  it("sees the branch on the remote when the host has no settled record, and says it was pushed", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const project = pushableProject(r, "interrupted-landed");
    const original = r.studio.service.pushBranch.bind(r.studio.service);
    vi.spyOn(r.studio.service, "pushBranch").mockImplementation(
      async (payload, signal, timeout) => {
        await original(payload, signal, timeout);
        // The ref moved, then the link went before git could report it: the
        // host stops the push as its link closes, which is what git reports.
        r.client.close("link dropped");
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
      }
    );
    r.onReconnect = () => r.relink();
    const id = opId();

    await expect(r.service.execute(ctx, pushStepFor(id, project))).resolves.toEqual({
      kind: "pushed",
    });
    await expect(
      r.client.call(ProjectLinkMethod.PUSH_STATUS, { opId: id, projectId: project.id })
    ).resolves.toEqual({ state: "interrupted" });
  });

  it("observes where the branch and its remote branch stand without pushing", async () => {
    const r = await rig();
    const project = pushableProject(r, "observe");
    const remoteSha = git(project.bare, ["rev-parse", "main"]);
    await expect(
      r.client.call(ProjectLinkMethod.PUSH_OBSERVE, {
        projectId: project.id,
        worktreePath: project.path,
        branch: "main",
        remote: "origin",
        remoteBranch: "main",
      })
    ).resolves.toEqual({ localSha: project.tip, remoteSha, remoteReachable: true });
    expect(git(project.bare, ["rev-parse", "main"])).toBe(remoteSha);
  });
});

describe("HostOperationOwners", () => {
  it("lets one session start an id, and no other", () => {
    const owners = new HostOperationOwners();
    const a = {};
    const b = {};
    expect(owners.mayClaim("op-1", a)).toBe(true);
    owners.claim("op-1", a);
    expect(owners.mayClaim("op-1", a)).toBe(true);
    expect(owners.mayClaim("op-1", b)).toBe(false);
    expect(owners.owns("op-1", a)).toBe(true);
    expect(owners.owns("op-1", b)).toBe(false);
  });

  it("never forgets a running operation to make room, however many settled ones arrive", () => {
    const running = new Set(["victim"]);
    const owners = new HostOperationOwners((opId) => running.has(opId));
    const victim = {};
    const flood = {};
    owners.claim("victim", victim);
    for (let i = 0; i < 2000; i++) owners.claim(`spam-${i}`, flood);
    expect(owners.owns("victim", victim)).toBe(true);
    expect(owners.mayClaim("victim", flood)).toBe(false);
    // Settled ones go first: the oldest spam is gone.
    expect(owners.owns("spam-0", flood)).toBe(false);
    expect(owners.owns("spam-1999", flood)).toBe(true);
  });
});
