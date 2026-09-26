import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../terminal/TerminalStreamBridge.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../terminal/TerminalStreamBridge.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  class ObservedTerminalStreamBridge extends original.TerminalStreamBridge {
    constructor(options: ConstructorParameters<typeof original.TerminalStreamBridge>[0]) {
      super(options);
      harnessState.bridges.set(options.endpointId, this);
    }
  }
  return { ...original, TerminalStreamBridge: ObservedTerminalStreamBridge };
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

vi.mock("../../services/getSoundService.js", () => ({
  getSoundService: async () => ({ play: () => undefined }),
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: () => null,
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
import type { WorktreeCreateResult } from "../../../shared/types/worktree.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { getLocalClientRef } from "../../ipc/localEndpoint.js";
import { getClientTerminalRelay } from "../terminal/clientAttach.js";
import { registerAppStateHandlers } from "../../ipc/handlers/app/state.js";
import { registerProjectSwitchHandlers } from "../../ipc/handlers/projectCrud/switch.js";
import { registerWorktreeLifecycleHandlers } from "../../ipc/handlers/worktree/lifecycle.js";
import type { HandlerDependencies } from "../../ipc/types.js";
import { typedHandleWithContext } from "../../ipc/utils.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import { getOperationRegistry } from "../../services/operations/index.js";
import { ProjectAcrossHostsService } from "../../services/projectAcrossHosts/index.js";
import type { ProjectAcrossHostsDeps } from "../../services/projectAcrossHosts/types.js";
import { LocalHostGateway } from "../projects/gateways.js";
import { FakeView, liveViews, projectKeys } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
});

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

/** The refusal's code and the project it names (the message carries it across the link). */
function refusal(envelope: IpcEnvelope): { code: string | null; projectId: string | null } {
  if (envelope.ok) return { code: null, projectId: null };
  const named = /changes (proj-\d+)/.exec(envelope.error.message)?.[1] ?? null;
  return { code: envelope.error.code ?? null, projectId: named };
}

/** The projects are real repositories, so repository checks and path tracing see git. */
function initRepos(r: RemoteHarness): void {
  for (const project of r.projects.values()) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project.path, stdio: "ignore" });
  }
}

async function leaseOf(r: RemoteHarness, view: FakeView, projectId: string) {
  return unwrap<{ isHolderEndpoint: boolean; drivingHere: boolean }>(
    await r.invoke(CHANNELS.DRIVE_LEASE_GET, view, { projectId })
  );
}

function fakeWorktreeService() {
  harnessState.store.set("notificationSettings", { uiFeedbackSoundEnabled: false });
  const creates: string[] = [];
  const service = {
    async createWorktree(rootPath: string, options: { newBranch: string }) {
      creates.push(rootPath);
      return {
        worktreeId: path.join(rootPath, "..", `wt-${options.newBranch}`),
        branch: options.newBranch,
        setupState: "pending",
      } satisfies WorktreeCreateResult;
    },
    invalidatePulseCache: () => undefined,
  };
  return { service, creates };
}

function createIn(r: RemoteHarness, projectId: string, branch: string) {
  const rootPath = r.projects.get(projectId)!.path;
  return {
    rootPath,
    options: { baseBranch: "main", newBranch: branch, path: path.join(rootPath, "..", branch) },
  };
}

/** The host's endpoint for a Shell view, as the session host registered it. */
function hostEndpointOf(view: FakeView): ClientEndpoint {
  const relay = getClientTerminalRelay(view.id);
  const endpoint = getEndpointRegistry()
    .getRemote()
    .find((candidate) => relay && candidate.endpointId.endsWith(`:${relay.endpointId}`));
  if (!endpoint) throw new Error(`no host endpoint for view ${view.id}`);
  return endpoint;
}

/** A window on this machine, showing one of its own projects (no host-scoped key). */
function addLocalView(id: number, projectId: string): FakeView {
  const view = new FakeView(id);
  liveViews.set(id, view);
  projectKeys.set(id, projectId);
  return view;
}

describe("drive lease on the project a call targets (integration harness)", () => {
  it(
    "a view driving its own project can't create a worktree in another project someone else drives",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      initRepos(r);
      const worktrees = fakeWorktreeService();
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: worktrees.service as unknown as WorkspaceClient,
        } as HandlerDependencies)
      );
      const one = r.addView(11, "proj-1");
      await r.openStreams(one);
      const two = r.addView(12, "proj-2");
      await r.openStreams(two);
      expect((await leaseOf(r, one, "proj-1")).isHolderEndpoint).toBe(true);
      expect((await leaseOf(r, two, "proj-2")).isHolderEndpoint).toBe(true);

      // The view on proj-2 names proj-1's repository: proj-1's lease decides.
      const crossed = await r.invoke(
        CHANNELS.WORKTREE_CREATE,
        two,
        createIn(r, "proj-1", "from-two")
      );
      expect(refusal(crossed)).toEqual({ code: "DRIVEN_ELSEWHERE", projectId: "proj-1" });
      expect(worktrees.creates).toEqual([]);

      // Its own project it still drives.
      unwrap(await r.invoke(CHANNELS.WORKTREE_CREATE, two, createIn(r, "proj-2", "own")));
      expect(worktrees.creates).toEqual([r.projects.get("proj-2")!.path]);

      // A path that traces to no project is refused while anyone else drives here.
      const nowhere = await r.invoke(CHANNELS.WORKTREE_CREATE, two, {
        ...createIn(r, "proj-2", "nowhere"),
        rootPath: path.join(r.dir, "not-a-project"),
      });
      expect(refusal(nowhere).code).toBe("DRIVEN_ELSEWHERE");
      expect(worktrees.creates).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "bookmarking a live agent needs the lease of the project the terminal belongs to",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      const prepare = vi.fn(() => ({ record: { sessionId: "s-1" } }));
      cleanups.push(
        typedHandleWithContext(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK as never, prepare as never)
      );
      r.pty.spawn("agent-1", "proj-1");
      const driver = r.addView(11, "proj-1");
      await r.openStreams(driver);
      const displaced = r.addView(12, "proj-1");
      await r.openStreams(displaced);
      const elsewhere = r.addView(13, "proj-2");
      await r.openStreams(elsewhere);

      for (const view of [displaced, elsewhere]) {
        const refused = await r.invoke(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK, view, {
          terminalId: "agent-1",
        });
        expect(refusal(refused)).toEqual({ code: "DRIVEN_ELSEWHERE", projectId: "proj-1" });
      }
      expect(prepare).not.toHaveBeenCalled();

      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, displaced, { projectId: "proj-1" }));
      unwrap(
        await r.invoke(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK, displaced, {
          terminalId: "agent-1",
        })
      );
      expect(prepare).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a displaced view switching away leaves the driver's saved layout, drafts and active worktree alone",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      initRepos(r);
      cleanups.push(registerProjectSwitchHandlers({} as HandlerDependencies));
      const driverState = {
        projectId: "proj-1",
        sidebarWidth: 350,
        terminals: [{ id: "driver-pane", kind: "browser", title: "Driver", location: "grid" }],
        draftInputs: { "driver-pane": "the driver's half-typed prompt" },
        activeWorktreeId: "wt-driver",
      };
      harnessState.projectStates.set("proj-1", driverState);
      const driver = r.addView(11, "proj-1");
      await r.openStreams(driver);
      const displaced = r.addView(12, "proj-1");
      await r.openStreams(displaced);
      expect((await leaseOf(r, displaced, "proj-1")).drivingHere).toBe(false);

      const stale = {
        terminals: [],
        draftInputs: { "driver-pane": "" },
        activeWorktreeId: "wt-stale",
      };
      // The host half of a remote view's switch: what its Shell forwards once
      // it has swapped its own view.
      const switchOnHost = (view: FakeView) => {
        const endpoint = hostEndpointOf(view);
        return getIpcDispatcher().invokeForEndpoint(
          { endpoint, client: { ...getLocalClientRef(), clientId: endpoint.clientId } },
          CHANNELS.PROJECT_SWITCH,
          ["proj-2", stale]
        );
      };
      const switched = unwrap<{ outcome: string }>(await switchOnHost(displaced));
      // Navigation stays open to it; the driver's state doesn't move.
      expect(switched.outcome).toBe("switched");
      expect(harnessState.projectStates.get("proj-1")).toEqual(driverState);

      // The driver itself still saves on its way out.
      unwrap(await switchOnHost(driver));
      expect(harnessState.projectStates.get("proj-1")).toMatchObject({
        activeWorktreeId: "wt-stale",
        terminals: [],
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "this machine's own window keeps its screen fields but not the project's while a remote Shell drives it",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      cleanups.push(registerAppStateHandlers());
      harnessState.store.set("appState", { terminals: [], sidebarWidth: 350 });
      const remote = r.addView(11, "proj-1");
      await r.openStreams(remote);
      expect((await leaseOf(r, remote, "proj-1")).isHolderEndpoint).toBe(true);

      const local = addLocalView(51, "proj-1");
      unwrap(
        await r.invoke(CHANNELS.APP_SET_STATE, local, {
          sidebarWidth: 420,
          activeWorktreeId: "wt-from-local",
          panelGridConfig: { strategy: "fixed-columns", value: 3 },
        })
      );
      const written = harnessState.store.get("appState") as Record<string, unknown>;
      expect(written.sidebarWidth).toBe(420);
      expect(written).not.toHaveProperty("activeWorktreeId");
      expect(written).not.toHaveProperty("panelGridConfig");

      // A project nobody else drives takes the whole write, as it always has.
      const other = addLocalView(52, "proj-2");
      unwrap(
        await r.invoke(CHANNELS.APP_SET_STATE, other, {
          activeWorktreeId: "wt-proj-2",
        })
      );
      expect(harnessState.store.get("appState")).toMatchObject({
        activeWorktreeId: "wt-proj-2",
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "placing a worktree onto this computer is refused in a project a remote Shell drives",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      const remote = r.addView(11, "proj-1");
      await r.openStreams(remote);
      expect((await leaseOf(r, remote, "proj-1")).isHolderEndpoint).toBe(true);

      const createWorktree = vi.fn();
      const focusWorktree = vi.fn(async () => undefined);
      const service = new ProjectAcrossHostsService({
        getProject: (id: string) => harnessState.projects.get(id) ?? null,
        bundleDir: () => path.join(r.dir, "bundles"),
        operations: () => getOperationRegistry(),
        createWorktree,
        focusWorktree,
      } as unknown as ProjectAcrossHostsDeps);
      const gateway = new LocalHostGateway("local", service);
      const worktree = {
        newBranch: "feature/placed",
        baseBranch: "main",
        fromRemote: false,
        useExistingBranch: false,
        relativePath: null,
        recipeId: null,
      };

      await expect(
        gateway.startPlaceWorktree({ opId: "place-driven", projectId: "proj-1", worktree })
      ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
      expect(getOperationRegistry().get("place-driven")).toBeFalsy();
      expect(createWorktree).not.toHaveBeenCalled();
      expect(focusWorktree).not.toHaveBeenCalled();

      // Nobody drives proj-2: the placement starts.
      await gateway.startPlaceWorktree({ opId: "place-free", projectId: "proj-2", worktree });
      await waitUntil(
        () => Boolean(getOperationRegistry().get("place-free")),
        "the placement to be recorded"
      );
    },
    TEST_TIMEOUT_MS
  );
});
