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

import { AppError } from "../../../utils/errorTypes.js";
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
  type TestHost,
} from "../../../services/projectAcrossHosts/__tests__/testService.js";
import { attachProjectsHost, type ProjectsHostAuthority } from "../hostInstall.js";
import { ProjectLinkMethod } from "../linkMethods.js";
import { HostSwitchService, type AssistantEnsureRequest } from "../HostSwitchService.js";

const STUDIO = "studio-01";
const SESSION = "session-1";
const URL = "https://example.test/daintreehq/ensure.git";
const BRANCH = "feature/ensure";

let root: string;
let bare: string;
let socketDir: string;
let sessions: LinkSession[] = [];

beforeAll(() => {
  root = tempRoot("pah-ensure-");
  bare = makeBare(root, "ensure-origin");
  aliasRemote(URL, bare);
  const seed = makeRepo(root, "seed", URL);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", BRANCH]);
  commit(seed, "feature");
  git(seed, ["push", "-q", "-u", "origin", BRANCH]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const session of sessions) session.close("test done");
  sessions = [];
  if (socketDir) await removeTempDir(socketDir);
});

let counter = 0;

interface Rig {
  local: TestHost;
  studio: TestHost;
  service: HostSwitchService;
  client: LinkSession;
  accepts: { value: boolean };
  views: { holder: string | null };
}

async function rig(options: { attach?: boolean } = {}): Promise<Rig> {
  socketDir = await makeTempDir();
  const n = ++counter;
  const local = createTestHost(root, `ens-local${n}`);
  const studio = createTestHost(root, `ens-studio${n}`);
  const accepts = { value: true };
  const views = { holder: null as string | null };
  const authority: ProjectsHostAuthority = {
    boundEndpoints: () => [],
    isDriving: () => false,
    holderEndpointId: () => views.holder,
    noteSessionChange: () => {},
  };
  const pair = await openSessionPair(socketDir);
  sessions.push(pair.host, pair.client);
  if (options.attach !== false) {
    attachProjectsHost(pair.host, studio.service, {
      sessionId: SESSION,
      authority,
      acceptsAssistants: () => accepts.value,
    });
  }
  const service = new HostSwitchService({
    local: local.service,
    resolveSession: async (hostId) => {
      if (hostId !== STUDIO) throw new AppError({ code: "NOT_FOUND", message: hostId });
      return pair.client;
    },
    openSession: async () => pair.client,
    hostOfSender: () => "local",
    isKnownHost: (hostId) => hostId === STUDIO,
    whenReconnected: async () => true,
    pollIntervalMs: 5,
  });
  return { local, studio, service, client: pair.client, accepts, views };
}

function sourceProject(host: TestHost, name: string): { id: string; path: string } {
  const dir = path.join(root, `${name}-${++counter}`);
  git(root, ["clone", "-q", "-b", BRANCH, URL, dir]);
  return host.addProject(dir);
}

function request(
  projectId: string,
  extra: Partial<AssistantEnsureRequest> = {}
): AssistantEnsureRequest {
  return {
    toHostId: STUDIO,
    projectId,
    worktreePath: null,
    worktree: true,
    copy: null,
    accept: [],
    ...extra,
  };
}

const WAIT = 30_000;

describe("bringing a project to a host for an assistant (#14140)", () => {
  it("clones a host's missing copy with its branch, then finds it the next time", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "bring");
    fs.writeFileSync(path.join(project.path, "dirty.txt"), "left here");

    const first = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.project.how).toBe("cloned");
    expect(first.project.leftHere).toEqual({ uncommittedChanges: 1, unpushedCommits: 0 });
    expect(first.project.worktreePath).not.toBeNull();
    expect(git(first.project.worktreePath!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
    expect(r.studio.clone.mock.calls[0]![0]).toMatchObject({ url: URL, depth: "full" });
    expect(r.studio.projects.map((p) => p.id)).toEqual([first.project.projectId]);

    const again = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(again).toMatchObject({
      status: "ready",
      project: {
        projectId: first.project.projectId,
        how: "existing",
        worktreePath: first.project.worktreePath,
      },
    });
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
    expect(r.studio.projects).toHaveLength(1);
  });

  it("joins a run still going instead of starting a second clone", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "join");

    const early = await r.service.ensureForAssistant(request(project.id), 0);
    const joined = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(early).toEqual({ status: "working" });
    expect(joined).toMatchObject({ status: "ready", project: { how: "cloned" } });
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
  });

  it("asks about commits only here instead of pushing, and goes past them once accepted", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "ahead");
    commit(project.path, "only here");
    const remoteTip = git(project.path, ["rev-parse", `origin/${BRANCH}`]);

    const asked = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(asked).toMatchObject({
      status: "question",
      questions: [{ reason: "unpushed", accept: "unpushed" }],
    });
    expect(r.studio.clone).not.toHaveBeenCalled();
    expect(r.studio.projects).toHaveLength(0);
    expect(git(project.path, ["rev-parse", `origin/${BRANCH}`])).toBe(remoteTip);

    const accepted = await r.service.ensureForAssistant(
      request(project.id, { accept: ["unpushed"] }),
      WAIT
    );

    expect(accepted).toMatchObject({
      status: "ready",
      project: { leftHere: { unpushedCommits: 1 } },
    });
    if (accepted.status !== "ready") return;
    expect(git(accepted.project.worktreePath!, ["rev-parse", "HEAD"])).toBe(remoteTip);
  });

  it("brings a branch nobody pushed only without its worktree", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "unpublished");
    git(project.path, ["checkout", "-q", "-b", "local-only"]);

    const asked = await r.service.ensureForAssistant(request(project.id), WAIT);
    const without = await r.service.ensureForAssistant(
      request(project.id, { worktree: false }),
      WAIT
    );

    expect(asked).toMatchObject({
      status: "question",
      questions: [{ reason: "branch_not_on_remote", accept: null }],
    });
    expect(without).toMatchObject({
      status: "ready",
      project: { how: "cloned", worktreePath: null, leftHere: { unpushedCommits: null } },
    });
  });

  it("asks instead of cloning when the project's remote is a folder on this machine", async () => {
    const r = await rig();
    const dir = path.join(root, `folder-origin-${++counter}`);
    git(root, ["clone", "-q", bare, dir]);
    commit(dir, "only here");
    const project = r.local.addProject(dir);

    const answer = await r.service.ensureForAssistant(
      request(project.id, { worktree: false }),
      WAIT
    );

    expect(answer).toMatchObject({
      status: "question",
      questions: [{ reason: "no_remote", accept: null }],
    });
    if (answer.status !== "question") return;
    expect(answer.questions[0]!.detail).toContain("HTTP(S) or SSH");
    expect(r.studio.clone).not.toHaveBeenCalled();
    expect(r.studio.projects).toHaveLength(0);
  });

  it("still takes a copy already in the host's default folder when the remote is a folder here", async () => {
    const r = await rig();
    const dir = path.join(root, `folder-default-${++counter}`);
    git(root, ["clone", "-q", bare, dir]);
    git(dir, ["remote", "add", "upstream", URL]);
    const project = r.local.addProject(dir);
    const source = await r.local.service.describeSource({
      projectId: project.id,
      worktreePath: null,
      skipBranch: true,
    });
    const destination = await r.studio.service.suggestDestination({
      homeRelativePath: source.homeRelativePath,
      repoName: source.repoName,
      remoteUrls: source.remotes.map((remote) => remote.url),
    });
    git(root, ["clone", "-q", URL, destination.path]);

    // A new copy asked for still lands on the folder's own clone, which needs no remote here.
    const answer = await r.service.ensureForAssistant(
      request(project.id, { worktree: false, copy: "new" }),
      WAIT
    );

    expect(answer).toMatchObject({
      status: "ready",
      project: { path: destination.path, how: "registered" },
    });
    expect(r.studio.clone).not.toHaveBeenCalled();
  });

  it("uses the host's one registered copy, and asks when it has two", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "copies");
    const one = path.join(root, `copy-one-${counter}`);
    git(root, ["clone", "-q", URL, one]);
    const registered = r.studio.addProject(one);

    const found = await r.service.ensureForAssistant(
      request(project.id, { worktree: false }),
      WAIT
    );
    expect(found).toMatchObject({
      status: "ready",
      project: { projectId: registered.id, how: "existing", path: one },
    });

    const two = path.join(root, `copy-two-${counter}`);
    git(root, ["clone", "-q", URL, two]);
    r.studio.addProject(two);
    const asked = await r.service.ensureForAssistant(
      request(project.id, { worktree: false }),
      WAIT
    );
    expect(asked).toMatchObject({ status: "question", questions: [{ reason: "multiple_copies" }] });
    if (asked.status !== "question") return;
    expect(asked.questions[0]!.copies?.map((c) => c.path).sort()).toEqual([one, two].sort());

    const chosen = await r.service.ensureForAssistant(
      request(project.id, { worktree: false, copy: two }),
      WAIT
    );
    expect(chosen).toMatchObject({ status: "ready", project: { path: two } });
    expect(r.studio.clone).not.toHaveBeenCalled();
  });

  it("changes nothing in a project another window on the host holds", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "held");
    const copy = path.join(root, `held-copy-${counter}`);
    git(root, ["clone", "-q", URL, copy]);
    r.studio.addProject(copy);
    r.views.holder = "local:window-1";

    const asked = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(asked).toMatchObject({
      status: "question",
      questions: [{ reason: "driven_elsewhere" }],
    });
    expect(r.studio.createWorktree).not.toHaveBeenCalled();
    expect(r.studio.focusWorktree).not.toHaveBeenCalled();
  });

  it("asks before checking out a branch in a copy already there when the host lacks LFS", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "lfs");
    fs.writeFileSync(path.join(project.path, ".gitattributes"), "*.bin filter=lfs diff=lfs\n");
    const copy = path.join(root, `lfs-copy-${counter}`);
    git(root, ["clone", "-q", URL, copy]);
    r.studio.addProject(copy);

    const asked = await r.service.ensureForAssistant(request(project.id), WAIT);
    const without = await r.service.ensureForAssistant(
      request(project.id, { worktree: false }),
      WAIT
    );

    expect(asked).toMatchObject({ status: "question", questions: [{ reason: "lfs_missing" }] });
    expect(r.studio.createWorktree).not.toHaveBeenCalled();
    expect(without).toMatchObject({ status: "ready", project: { how: "existing" } });
  });

  it("checks who holds a registered copy in the default folder, even for a worktree it already has", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "held-default");
    const first = await r.service.ensureForAssistant(request(project.id), WAIT);
    expect(first).toMatchObject({ status: "ready", project: { how: "cloned" } });
    r.views.holder = "local:window-1";
    r.studio.focusWorktree.mockClear();

    const asked = await r.service.ensureForAssistant(request(project.id, { copy: "new" }), WAIT);

    expect(asked).toMatchObject({
      status: "question",
      questions: [{ reason: "driven_elsewhere" }],
    });
    expect(r.studio.focusWorktree).not.toHaveBeenCalled();
    expect(r.studio.clone).toHaveBeenCalledTimes(1);
  });

  it("has the host refuse an assistant's branch in a held copy however its folder is named", async () => {
    const r = await rig();
    const copy = path.join(root, `held-path-${counter}`);
    git(root, ["clone", "-q", URL, copy]);
    git(copy, ["worktree", "add", "-q", `${copy}-wt`, "-b", BRANCH, `origin/${BRANCH}`]);
    r.studio.addProject(copy);
    r.views.holder = "local:window-1";

    const opened = await r.client.call(ProjectLinkMethod.OPEN, {
      projectId: null,
      path: copy,
      remoteUrls: [URL],
      branch: { name: BRANCH, remoteBranch: BRANCH },
      branchRemoteUrl: URL,
      assistant: true,
    });

    expect(opened).toMatchObject({ worktreePath: null, canCheckOutBranch: true });
    expect(r.studio.focusWorktree).not.toHaveBeenCalled();
  });

  it("never runs a setup recipe, and says which the project carries", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "recipes");
    const recipes = path.join(project.path, ".daintree", "recipes");
    fs.mkdirSync(recipes, { recursive: true });
    fs.writeFileSync(
      path.join(recipes, "install.json"),
      JSON.stringify({ id: "setup", name: "Install" })
    );
    git(project.path, ["add", "."]);
    git(project.path, ["commit", "-q", "-m", "recipe"]);
    git(project.path, ["push", "-q"]);

    const ready = await r.service.ensureForAssistant(request(project.id), WAIT);

    expect(ready).toMatchObject({ status: "ready", project: { setupRecipes: ["Install"] } });
    const op = r.studio.registry.list().find((record) => record.kind === "project-clone-and-open");
    expect(op?.outcome).toMatchObject({ status: "succeeded", result: { setupRecipeId: null } });
  });

  it("is refused by a host whose own setting turns other machines' assistants away", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "refused");
    r.accepts.value = false;

    await expect(r.service.ensureForAssistant(request(project.id), WAIT)).rejects.toMatchObject({
      code: "PERMISSION",
    });
    expect(r.studio.clone).not.toHaveBeenCalled();
  });

  it("has the host refuse an assistant's clone itself while its setting is off", async () => {
    const r = await rig();
    r.accepts.value = false;

    await expect(
      r.client.call(ProjectLinkMethod.START_CLONE, {
        opId: "assistant-clone-1",
        source: { kind: "remote", url: URL },
        destination: path.join(root, "never"),
        branch: null,
        options: { submodules: false, depth: "full" },
        setupRecipeId: null,
        assistant: true,
      })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(r.studio.clone).not.toHaveBeenCalled();
  });

  it("is unsupported by a host too old to check its own setting", async () => {
    const r = await rig({ attach: false });
    const project = sourceProject(r.local, "old-host");

    await expect(r.service.ensureForAssistant(request(project.id), WAIT)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("never brings a project to this machine itself", async () => {
    const r = await rig();
    const project = sourceProject(r.local, "local");

    await expect(
      r.service.ensureForAssistant(request(project.id, { toHostId: "local" }), WAIT)
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
