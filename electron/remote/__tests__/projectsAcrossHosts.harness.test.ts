import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-harness",
}));

vi.mock("../../store.js", async () => ({
  store: (await import("./harness/harnessState.js")).memoryStore,
}));

vi.mock("../../services/ProjectStore.js", async () => ({
  projectStore: (await import("./harness/harnessState.js")).memoryProjectStore,
}));

vi.mock("../../boot/hostServices.js", () => ({
  isWorkspaceClientStarting: () => false,
  ensureWorkspaceClient: async () => undefined,
}));

vi.mock("../host/hostCommands.js", async () => {
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    runCommand: async () => ({ code: 1, stdout: "", stderr: "not in the harness" }),
    spawnOwnedProcess: (file: string, args: readonly string[]) => {
      const record = { file, args, killed: false };
      harnessState.spawned.push(record);
      return { kill: () => (record.killed = true), onExit: () => undefined };
    },
  };
});

vi.mock("../client/initClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/initClient.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    ...original,
    initRemoteHostsClient: (...args: Parameters<typeof original.initRemoteHostsClient>) => {
      const client = original.initRemoteHostsClient(...args);
      harnessState.client = client;
      return client;
    },
  };
});

vi.mock("../../ipc/handlers/app/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/handlers/app/state.js")>()),
  readShellHydrateFields: () => ({ safeMode: false, crashCount: 0 }),
}));

vi.mock("../../services/PluginService.js", async () => ({
  pluginService: (await import("./harness/fakePluginService.js")).fakePluginService,
}));

/** The Shell's one window: a view with no host-scoped project key is on this machine. */
const shellWindow = vi.hoisted(() => ({ id: 1, isDestroyed: () => false, once: () => undefined }));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: (wc: { id: number } | null) =>
      wc && liveViews.has(wc.id) ? shellWindow : null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
    getAllAppWebContents: () => [],
    getWebContentsForProject: () => [],
    hasRegisteredProjectViews: () => false,
    isCachedViewWebContents: () => false,
    resolveLiveWebContents: (id: number) => liveViews.get(id)?.webContents ?? null,
    registerPortHolderWebContents: () => undefined,
    clearPortHolderWebContents: () => undefined,
    clearPortHolderWebContentsIfCurrent: () => undefined,
    getPortHolderWebContentsId: () => undefined,
  };
});

import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type {
  HostProjectPresence,
  HostSwitchExecuteResult,
} from "../../../shared/types/ipc/hostSwitch.js";
import type { HostDirectoryListing } from "../../../shared/types/ipc/hostFiles.js";
import type { DestinationCheck } from "../../../shared/types/ipc/projectMatch.js";
import { CHANNELS } from "../../ipc/channels.js";
import { registerHostSwitchHandlers } from "../../ipc/handlers/hostSwitch.js";
import { _resetProjectAcrossHostsServiceForTest } from "../../services/projectAcrossHosts/index.js";
import {
  aliasRemote,
  commit,
  git,
  makeBare,
  makeRepo,
  tempRoot,
} from "../../services/projectAcrossHosts/__tests__/gitFixtures.js";
import {
  createTestHost,
  type TestHost,
} from "../../services/projectAcrossHosts/__tests__/testService.js";
import { installHostSwitchService } from "../projects/clientInstall.js";
import { ProjectLinkMethod } from "../projects/linkMethods.js";
import { FakeView, liveViews } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const URL = "https://example.test/daintreehq/across.git";
const OTHER_URL = "https://example.test/someone/web.git";
const LOCAL_VIEW = 41;
const STUDIO_VIEW = 42;
const TEST_TIMEOUT_MS = 60_000;

let root: string;
let h: RemoteHarness | null = null;
const cleanups: Array<() => void> = [];
let opCounter = 0;
const nextOpId = () => `g1b-op-${++opCounter}`;

beforeAll(() => {
  root = tempRoot("pah-harness-");
  const bare = makeBare(root, "across-origin");
  aliasRemote(URL, bare);
  const seed = makeRepo(root, "seed", URL);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  const otherBare = makeBare(root, "web-origin");
  aliasRemote(OTHER_URL, otherBare);
  const otherSeed = makeRepo(root, "web-seed", OTHER_URL);
  commit(otherSeed, "web");
  git(otherSeed, ["push", "-q", "-u", "origin", "main"]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await h?.dispose();
  h = null;
  _resetProjectAcrossHostsServiceForTest(null);
});

function data<T>(envelope: IpcEnvelope): T {
  if (!envelope.ok) throw new Error(`call failed: ${envelope.error.message}`);
  return envelope.data as T;
}

let hostCounter = 0;

interface Rig {
  harness: RemoteHarness;
  local: TestHost;
  studio: TestHost;
  localView: FakeView;
}

/**
 * The harness's real boot, with each machine's project service over real git:
 * the host side of the link (Host mode) answers from `studio`, and the Shell's
 * switch service reaches `local` for this machine and `studio` only across
 * the Unix-socket link.
 */
async function rig(): Promise<Rig> {
  const n = ++hostCounter;
  const local = createTestHost(root, `h-local${n}`);
  const studio = createTestHost(root, `h-studio${n}`);
  _resetProjectAcrossHostsServiceForTest(studio.service);
  h = await startRemoteHarness();
  const harness = h;
  // Boot installed the Shell's switch service over the host's; give this machine its own.
  _resetProjectAcrossHostsServiceForTest(local.service);
  const booted = harnessState.client!;
  cleanups.push(installHostSwitchService({ client: booted.client, sessionFor: booted.sessionFor }));
  cleanups.push(registerHostSwitchHandlers());
  await harness.connect();
  const localView = new FakeView(LOCAL_VIEW);
  liveViews.set(LOCAL_VIEW, localView);
  cleanups.push(() => liveViews.delete(LOCAL_VIEW));
  return { harness, local, studio, localView };
}

function cloneInto(dir: string, url: string): string {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ["clone", "-q", url, dir]);
  return dir;
}

describe("projects across hosts (integration harness)", () => {
  it(
    "finds the project on the other host by its remotes, never by a shared name, both ways",
    async () => {
      const { harness, local, studio, localView } = await rig();
      const mine = local.addProject(cloneInto(path.join(root, "hl-web", "web"), URL));
      // studio-01 has this repository under another name, and an unrelated "web".
      const renamed = studio.addProject(cloneInto(path.join(root, "hs-a", "site"), URL));
      studio.addProject(cloneInto(path.join(root, "hs-b", "web"), OTHER_URL));

      const found = data<HostProjectPresence[]>(
        await harness.invoke(CHANNELS.HOST_SWITCH_LOCATE, localView, {
          fromHostId: "local",
          projectId: mine.id,
          toHostIds: [HOST_ID],
        })
      );
      expect(found).toEqual([
        {
          hostId: HOST_ID,
          projects: [{ projectId: renamed.id, name: "site", path: renamed.path }],
        },
      ]);

      // From a window on studio-01: its project is identified across the link, matched here.
      const studioView = harness.addView(STUDIO_VIEW, renamed.id);
      const back = data<HostProjectPresence[]>(
        await harness.invoke(CHANNELS.HOST_SWITCH_LOCATE, studioView, {
          fromHostId: HOST_ID,
          projectId: renamed.id,
          toHostIds: ["local"],
        })
      );
      expect(back).toEqual([
        { hostId: "local", projects: [{ projectId: mine.id, name: "web", path: mine.path }] },
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "browses the other host's folders and adopts a picked clone its scan never reaches",
    async () => {
      const { harness, local, studio, localView } = await rig();
      local.addProject(cloneInto(path.join(root, "hl-adopt", "across"), URL));
      const picked = cloneInto(path.join(root, "hs-far", "deep", "down", "across"), URL);
      const unrelated = cloneInto(path.join(root, "hs-far", "web"), OTHER_URL);

      const listing = data<HostDirectoryListing>(
        await harness.invoke(CHANNELS.HOST_SWITCH_LIST_DIRECTORY, localView, {
          toHostId: HOST_ID,
          path: path.join(root, "hs-far"),
        })
      );
      expect(listing.entries.map((entry) => entry.name).sort()).toEqual(["deep", "web"]);

      const opened = data<HostSwitchExecuteResult>(
        await harness.invoke(CHANNELS.HOST_SWITCH_EXECUTE, localView, {
          kind: "open",
          opId: nextOpId(),
          toHostId: HOST_ID,
          candidate: { projectId: null, path: picked },
          remoteUrls: [URL],
          branch: null,
          branchRemoteUrl: null,
        })
      );
      expect(opened).toMatchObject({ kind: "opened", hostId: HOST_ID, projectPath: picked });
      expect(studio.projects.map((p) => p.path)).toContain(picked);

      // The host checks the folder itself: another repository is refused, and not registered.
      const refused = await harness.invoke(CHANNELS.HOST_SWITCH_EXECUTE, localView, {
        kind: "open",
        opId: nextOpId(),
        toHostId: HOST_ID,
        candidate: { projectId: null, path: unrelated },
        remoteUrls: [URL],
        branch: null,
        branchRemoteUrl: null,
      });
      expect(refused.ok).toBe(false);
      expect(studio.projects.map((p) => p.path)).not.toContain(unrelated);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "adds a project to the other host by URL: suggested folder, clone by operation id, registered there",
    async () => {
      const { harness, studio, localView } = await rig();
      const suggested = data<DestinationCheck>(
        await harness.invoke(CHANNELS.HOST_SWITCH_SUGGEST_CLONE_DESTINATION, localView, {
          toHostId: HOST_ID,
          url: URL,
        })
      );
      expect(suggested.status).toBe("free");
      expect(path.basename(suggested.path)).toBe("across");

      const destination = path.join(root, `hs-added-${hostCounter}`, "across");
      const opId = nextOpId();
      const result = data<HostSwitchExecuteResult>(
        await harness.invoke(CHANNELS.HOST_SWITCH_EXECUTE, localView, {
          kind: "clone-url",
          opId,
          toHostId: HOST_ID,
          url: URL,
          destination,
          options: { submodules: false, depth: "full" },
        })
      );
      expect(result).toMatchObject({ kind: "opened", hostId: HOST_ID, projectPath: destination });
      expect(fs.existsSync(path.join(destination, ".git"))).toBe(true);
      expect(studio.projects.map((p) => p.path)).toContain(destination);
      // The host kept the outcome under the Shell's operation id.
      expect(studio.service.operationStatus(opId)).toMatchObject({ status: "succeeded" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "creates the new-worktree dialog's worktree on the other host, only in a project the Shell opened there",
    async () => {
      const { harness, studio, localView } = await rig();
      const target = studio.addProject(
        cloneInto(path.join(root, `hs-place-${hostCounter}`, "across"), URL)
      );
      const untouched = studio.addProject(
        cloneInto(path.join(root, `hs-place-${hostCounter}`, "other"), URL)
      );
      const worktree = {
        newBranch: "feature/placed",
        baseBranch: "main",
        fromRemote: false,
        useExistingBranch: false,
        relativePath: "../across-worktrees/feature-placed",
        recipeId: null,
      };
      const opId = nextOpId();
      const result = data<HostSwitchExecuteResult>(
        await harness.invoke(CHANNELS.HOST_SWITCH_EXECUTE, localView, {
          kind: "create-worktree",
          opId,
          toHostId: HOST_ID,
          projectId: target.id,
          worktree,
        })
      );
      const expected = path.join(path.dirname(target.path), "across-worktrees", "feature-placed");
      expect(result).toMatchObject({
        kind: "opened",
        projectId: target.id,
        worktreePath: expected,
      });
      expect(git(expected, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/placed");
      // Retained on the host by the Shell's id, readable across the link after the fact.
      const session = harness.clientSession();
      await expect(
        session.call(ProjectLinkMethod.OPERATION_STATUS, { opId })
      ).resolves.toMatchObject({ status: "succeeded", result: { worktreePath: expected } });

      // The placement a session earns by opening a project is one worktree, in that project.
      const again = {
        opId: nextOpId(),
        projectId: target.id,
        worktree: { ...worktree, newBranch: "feature/second" },
      };
      await expect(
        session.call(ProjectLinkMethod.START_PLACE_WORKTREE, again)
      ).rejects.toMatchObject({
        code: "PERMISSION",
      });
      // Opening the project again doesn't earn a second one.
      await session.call(ProjectLinkMethod.OPEN, {
        projectId: target.id,
        path: target.path,
        remoteUrls: [],
        branch: null,
        branchRemoteUrl: null,
      });
      await expect(
        session.call(ProjectLinkMethod.START_PLACE_WORKTREE, { ...again, opId: nextOpId() })
      ).rejects.toMatchObject({ code: "PERMISSION" });
      const elsewhere = { opId: nextOpId(), projectId: untouched.id, worktree };
      await expect(
        session.call(ProjectLinkMethod.START_PLACE_WORKTREE, elsewhere)
      ).rejects.toMatchObject({ code: "PERMISSION" });
      expect(studio.createWorktree).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS
  );
});
