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

/**
 * The host's help-session service. The real one writes session folders and
 * probes the MCP server, both covered by its own suite; what crosses the link
 * here is which project, path and pin the host provisions for a remote view.
 */
const helpSessions = vi.hoisted(() => ({
  provisioned: [] as Array<Record<string, unknown>>,
  revoked: [] as number[],
}));
vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: async (input: Record<string, unknown>) => {
      helpSessions.provisioned.push(input);
      return {
        sessionId: "session-1",
        sessionPath: "/host/userData/help-sessions/abc",
        token: "bearer-minted-on-the-host",
        tier: "action",
        mcpUrl: "http://127.0.0.1:45454/sse",
        windowId: input.windowId,
      };
    },
    revokeByWebContentsId: async (id: number) => {
      helpSessions.revoked.push(id);
    },
  },
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
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { registerHelpHandlers } from "../../ipc/handlers/help.js";
import { registerWorktreeLifecycleHandlers } from "../../ipc/handlers/worktree/lifecycle.js";
import type { HandlerDependencies } from "../../ipc/types.js";
import { _resetHostResidencyForTesting } from "../../services/ProjectSwitchService.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import { PluginRendererDispatcher } from "../../services/plugin/PluginRendererDispatcher.js";
import { getWorktreePortBrokerRef, setWorkspaceClientRef } from "../../window/serviceRefs.js";
import { requireRemoteService } from "../runtime.js";
import { fakePluginService } from "./harness/fakePluginService.js";
import type { FakeView } from "./harness/fakeView.js";
import type { FakeWorkspaceHost } from "./harness/fakeWorkspaceHost.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW_A = 11; // studio-01:proj-1
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  _resetHostResidencyForTesting();
  helpSessions.provisioned.length = 0;
  helpSessions.revoked.length = 0;
});

async function harness(): Promise<RemoteHarness> {
  h = await startRemoteHarness();
  await h.connect();
  return h;
}

function data<T>(envelope: IpcEnvelope): T {
  if (!envelope.ok) throw new Error(`call failed: ${envelope.error.message}`);
  return envelope.data as T;
}

function eventsOn(view: FakeView, channel: string): unknown[][] {
  return view.events.filter((event) => event.channel === channel).map((event) => event.args);
}

/**
 * The renderer's worktree port receipt, as the preload sends it for every port
 * it attaches: counted, and acknowledged to the Shell's broker.
 */
function ackWorktreePorts(r: RemoteHarness, view: FakeView): { received: () => number } {
  let received = 0;
  const post = view.webContents.postMessage;
  view.webContents.postMessage = (channel, message, transfer) => {
    post(channel, message, transfer);
    if (channel !== "worktree-port") return;
    received++;
    const token = (message as { token: number }).token;
    queueMicrotask(() => r.send(CHANNELS.WORKTREE_PORT_ACK, view, { token }));
  };
  return { received: () => received };
}

/**
 * The host's workspace pool, over the harness's fake workspace hosts: a
 * project's host exists only once `loadProject` succeeded for it, and a load
 * can be made to fail, as a workspace host that couldn't start does.
 */
function gatedWorkspace(r: RemoteHarness) {
  const byPath = new Map<string, FakeWorkspaceHost>();
  for (const [id, host] of r.workspaceHosts) byPath.set(r.projects.get(id)!.path, host);
  const loaded = new Set<string>();
  const state = {
    failLoads: true,
    loads: [] as Array<[string, number]>,
    restarts: [] as string[],
  };
  const client = {
    getHostForProject: (projectPath: string) => {
      const host = loaded.has(projectPath) ? byPath.get(projectPath) : undefined;
      return host
        ? Object.assign(host, { manualRestart: () => state.restarts.push(projectPath) })
        : undefined;
    },
    async loadProject(projectPath: string, residentId: number) {
      state.loads.push([projectPath, residentId]);
      if (state.failLoads) throw new Error("workspace host failed to start");
      loaded.add(projectPath);
      return "cold";
    },
    resumeProject: () => undefined,
    unregisterWindow: () => undefined,
    prewarmProject: () => undefined,
    waitForReady: async () => undefined,
    isWorktreeOwnedByProject: async () => null,
  };
  setWorkspaceClientRef(client as unknown as WorkspaceClient);
  return { client, state };
}

describe("host handlers with no window here, over the real link", () => {
  it(
    "worktree Retry from a remote view reloads its project on the host and hands the view a working port",
    async () => {
      const r = await harness();
      const { client, state } = gatedWorkspace(r);
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: client,
          worktreePortBroker: getWorktreePortBrokerRef()!,
        } as unknown as HandlerDependencies)
      );
      const view = r.addView(VIEW_A, "proj-1");
      const ports = ackWorktreePorts(r, view);
      await r.openStreams(view);

      // The view's first activation failed: it holds a port with nothing behind it.
      await waitUntil(
        () => eventsOn(view, CHANNELS.PROJECT_WORKTREE_LOAD_STATUS).length > 0,
        "the failed load reported to the view"
      );
      expect(eventsOn(view, CHANNELS.PROJECT_WORKTREE_LOAD_STATUS)[0]![0]).toMatchObject({
        projectId: "proj-1",
        worktreeLoadError: expect.stringContaining("workspace host failed to start"),
      });
      await waitUntil(() => view.hasWorktreePort, "the view's relayed worktree port");
      const stuck = await view.worktreeRequest("before", "get-all-states");
      expect(stuck.error).toBe("Worktree host is not connected");
      const portsBefore = ports.received();

      state.failLoads = false;
      data(await r.invoke(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD, view));

      // Reloaded for this view's endpoint: its negative handle is the resident.
      const endpoint = getEndpointRegistry().getRemote()[0]!;
      expect(state.loads.at(-1)).toEqual([r.projects.get("proj-1")!.path, endpoint.handle]);
      // The Shell posted the view a fresh port, which the renderer confirmed…
      expect(ports.received()).toBe(portsBefore + 1);
      // …and it now reaches the reloaded workspace host.
      const answer = await view.worktreeRequest("after", "get-all-states");
      expect(answer.result).toMatchObject({ epoch: "epoch-1" });
      expect(r.workspaceHosts.get("proj-1")!.requests.map((q) => q.action)).toContain(
        "get-all-states"
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "worktree Retry still fails visibly when the reload fails again",
    async () => {
      const r = await harness();
      const { client } = gatedWorkspace(r);
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: client,
          worktreePortBroker: getWorktreePortBrokerRef()!,
        } as unknown as HandlerDependencies)
      );
      const view = r.addView(VIEW_A, "proj-1");
      ackWorktreePorts(r, view);
      await r.openStreams(view);

      const envelope = await r.invoke(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD, view);
      expect(envelope.ok).toBe(false);
      if (envelope.ok) return;
      expect(envelope.error.message).not.toMatch(/identify the window/);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "worktree restart from a remote view restarts its own project's workspace host",
    async () => {
      const r = await harness();
      const { client, state } = gatedWorkspace(r);
      state.failLoads = false;
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: client,
          worktreePortBroker: getWorktreePortBrokerRef()!,
        } as unknown as HandlerDependencies)
      );
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      await waitUntil(() => state.loads.length > 0, "the view's project activated on the host");

      data(await r.invoke(CHANNELS.WORKTREE_RESTART_SERVICE, view));
      expect(state.restarts).toEqual([r.projects.get("proj-1")!.path]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "help: a remote view's assistant is provisioned on the host for the view's own project and pinned to its endpoint",
    async () => {
      const r = await harness();
      cleanups.push(registerHelpHandlers());
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      const endpoint = getEndpointRegistry().getRemote()[0]!;

      const session = data<{ token: string; mcpUrl: string; windowId: number } | null>(
        await r.invoke(CHANNELS.HELP_PROVISION_SESSION, view, {
          projectId: "proj-1",
          // The Shell's idea of where the project lives is not the host's.
          projectPath: "/Users/someone-else/proj-1",
          agentId: "claude",
        })
      );
      expect(session).toMatchObject({
        token: "bearer-minted-on-the-host",
        mcpUrl: "http://127.0.0.1:45454/sse",
        windowId: endpoint.handle,
      });
      expect(helpSessions.provisioned).toEqual([
        expect.objectContaining({
          projectId: "proj-1",
          projectPath: r.projects.get("proj-1")!.path,
          windowId: endpoint.handle,
          projectViewWebContentsId: endpoint.handle,
        }),
      ]);

      // Another project than the view's is refused, not provisioned.
      const foreign = data<unknown>(
        await r.invoke(CHANNELS.HELP_PROVISION_SESSION, view, {
          projectId: "proj-2",
          projectPath: r.projects.get("proj-2")!.path,
          agentId: "claude",
        })
      );
      expect(foreign).toBeNull();
      expect(helpSessions.provisioned).toHaveLength(1);

      // The view going (its endpoint closes on the host) takes its sessions with it.
      view.destroy();
      await waitUntil(
        () => helpSessions.revoked.includes(endpoint.handle),
        "the remote view's help sessions revoked"
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "plugins: host.dispatch and the action catalog reach the driving remote view; with nobody attached dispatch is NO_FRONTEND_ATTACHED",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      // The plugin's main code runs on the host; its dispatcher is the host's.
      const dispatcher = new PluginRendererDispatcher({ isDisposed: () => false });
      cleanups.push(() => dispatcher.dispose());

      const dispatched = dispatcher.sendDispatchToRenderer(
        "worktree.refresh",
        { worktreeId: "wt-1" },
        "proj-1",
        "acme.graph"
      );
      await waitUntil(
        () => eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST).length === 1,
        "the dispatch in the driving view"
      );
      const [request] = eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)[0] as [
        { requestId: string; actionId: string; args: unknown },
      ];
      expect(request).toMatchObject({ actionId: "worktree.refresh", args: { worktreeId: "wt-1" } });
      r.send(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, view, {
        requestId: request.requestId,
        result: { ok: true, result: "refreshed" },
      });
      await expect(dispatched).resolves.toEqual({ ok: true, result: "refreshed" });

      const listed = dispatcher.sendActionsListToRenderer("proj-1", "acme.graph");
      await waitUntil(
        () => eventsOn(view, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST).length === 1,
        "the catalog request in the driving view"
      );
      const [listRequest] = eventsOn(view, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST)[0] as [
        { requestId: string },
      ];
      const entry = { id: "worktree.refresh", title: "Refresh", danger: "safe" };
      r.send(CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE, view, {
        requestId: listRequest.requestId,
        entries: [entry],
      });
      await expect(listed).resolves.toEqual([entry]);

      const got = dispatcher.sendActionsGetToRenderer("worktree.refresh", "proj-1", "acme.graph");
      await waitUntil(
        () => eventsOn(view, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST).length === 1,
        "the catalog lookup in the driving view"
      );
      const [getRequest] = eventsOn(view, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST)[0] as [
        { requestId: string; actionId: string },
      ];
      expect(getRequest.actionId).toBe("worktree.refresh");
      r.send(CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE, view, {
        requestId: getRequest.requestId,
        entry,
      });
      await expect(got).resolves.toEqual(entry);

      // A project nobody drives, then the only driver gone.
      await expect(
        dispatcher.sendDispatchToRenderer("worktree.refresh", {}, "proj-2", "acme.graph")
      ).resolves.toMatchObject({ ok: false, error: { code: "NO_FRONTEND_ATTACHED" } });
      await r.dropLink();
      await expect(
        dispatcher.sendDispatchToRenderer("worktree.refresh", {}, "proj-1", "acme.graph")
      ).resolves.toMatchObject({ ok: false, error: { code: "NO_FRONTEND_ATTACHED" } });
      await expect(dispatcher.sendActionsListToRenderer("proj-1", "acme.graph")).resolves.toEqual(
        []
      );
      expect(eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "site preview: the Shell asks the host, over the link, whether an adapter's plugin is loaded there",
    async () => {
      const loadedOnHost = new Set(["daintree.sveltekit-builder"]);
      const service = fakePluginService as typeof fakePluginService & {
        hasPlugin?: (pluginId: string) => boolean;
      };
      service.hasPlugin = (pluginId) => loadedOnHost.has(pluginId);
      cleanups.push(() => delete service.hasPlugin);
      await harness();
      const parity = requireRemoteService("pluginParityClient");

      await expect(
        parity.isPluginLoadedOnHost(HOST_ID, "daintree.sveltekit-builder")
      ).resolves.toBe(true);
      await expect(parity.isPluginLoadedOnHost(HOST_ID, "acme.absent")).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});
