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
  const views: Views = { bound: new Set(), driving: true, holder: null };
  const authority: ProjectsHostAuthority = {
    boundEndpoints: (sessionId, projectId) =>
      sessionId === SESSION && views.bound.has(projectId)
        ? [{ endpointId: `remote:${sessionId}:${projectId}`, clientId: "shell" }]
        : [],
    isDriving: () => views.driving,
    holderEndpointId: () => views.holder,
  };
  const grants = new ProjectHostGrants();
  const link = async (): Promise<LinkSession> => {
    const pair = await openSessionPair(socketDir);
    sessions.push(pair.host, pair.client);
    attachProjectsHost(pair.host, studio.service, { sessionId: SESSION, authority, grants });
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

  it("checks out a branch it offered when it opened the project, unless someone else drives it", async () => {
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
    expect(opened).toMatchObject({ kind: "opened", canCheckOutBranch: true });
    // Only the exact branch target it offered.
    await expect(
      r.client.call(ProjectLinkMethod.CHECK_OUT, {
        ...checkout,
        branch: { name: branch.name, remoteBranch: "main" },
      })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    r.views.holder = "remote:another-session:view-1";
    await expect(r.client.call(ProjectLinkMethod.CHECK_OUT, checkout)).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    // A view of this same session holding it is no one else.
    r.views.holder = `remote:${SESSION}:another-view`;
    const result = await r.service.execute(ctx, {
      kind: "checkout",
      opId: opId(),
      toHostId: STUDIO,
      projectId: project.id,
      branch,
      branchRemoteUrl: URL,
    });
    expect(result).toMatchObject({ kind: "opened", worktreePath: expect.any(String) });
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

  it("stops the host's push when the link that asked for it drops", async () => {
    const r = await rig();
    r.from.hostId = STUDIO;
    const project = slowPushProject(r, "authz-drop");
    const started = hostPushStarted(r);
    const id = opId();
    const pushing = r.service.execute(ctx, pushStep(id, project));
    const signal = await started;
    await gitPushRunning(project.marker);
    expect(signal.aborted).toBe(false);
    r.client.close("link dropped");
    // The Shell can't report or cancel it any more, so the host doesn't carry on unseen.
    await expect(pushing).rejects.toMatchObject({
      code: expect.stringMatching(/^(HOST_DISCONNECTED|OUTCOME_UNKNOWN)$/),
    });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(r.service.status({ opId: id }).state).toBe("failed");
  });
});
