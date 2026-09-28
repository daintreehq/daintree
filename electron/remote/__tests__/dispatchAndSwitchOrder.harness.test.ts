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

vi.mock("../../services/ScratchStore.js", () => ({
  scratchStore: {
    getAllScratches: () => [],
    getCurrentScratch: () => null,
    getScratchById: () => null,
  },
}));

/**
 * The Shell's one window and its ProjectViewManager, keyed as the real one is:
 * a bare id for a local project, `<host>:<id>` for a remote one.
 */
const shellWindow = vi.hoisted(() => ({
  id: 1,
  isDestroyed: () => false,
  isFocused: () => true,
  once: () => undefined,
}));
const pvmState = vi.hoisted(() => ({
  active: null as string | null,
  views: new Map<string, { webContents: unknown }>(),
  /** Every key the window was asked to show, in order. */
  requested: [] as string[],
  create: null as null | ((key: string) => { webContents: unknown }),
}));
const fakePvm = vi.hoisted(() => {
  let chain: Promise<unknown> = Promise.resolve();
  function show(key: string) {
    pvmState.requested.push(key);
    const next = chain.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      let view = pvmState.views.get(key);
      const isNew = !view;
      if (!view) {
        view = pvmState.create!(key);
        pvmState.views.set(key, view);
      }
      pvmState.active = key;
      return { view, isNew };
    });
    chain = next.catch(() => undefined);
    return next;
  }
  return {
    switchToHostProject: async (hostId: string, projectId: string) =>
      show(`${hostId}:${projectId}`),
    switchTo: async (projectId: string) => show(projectId),
    getActiveProjectId: () => pvmState.active,
    getActiveView: () => (pvmState.active ? (pvmState.views.get(pvmState.active) ?? null) : null),
    setPendingFocusIntent: () => undefined,
  };
});

vi.mock("../../window/windowRef.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../window/windowRef.js")>()),
  getWindowRegistry: () => ({
    getByWindowId: (id: number) =>
      id === shellWindow.id
        ? {
            windowId: shellWindow.id,
            browserWindow: shellWindow,
            services: { projectViewManager: fakePvm },
          }
        : undefined,
  }),
}));

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

import type { IpcContext } from "../../ipc/types.js";
import { CHANNELS } from "../../ipc/channels.js";
import { resetProjectHistory } from "../../services/ProjectHistoryService.js";
import { PluginRendererDispatcher } from "../../services/plugin/PluginRendererDispatcher.js";
import { FakeView, liveViews, projectKeys } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const PLUGIN_VIEW = 11; // studio-01:proj-1
const LOCAL_VIEW = 10; // this machine's proj-2
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];
let nextViewId = 20;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  pvmState.active = null;
  pvmState.views.clear();
  pvmState.requested.length = 0;
  pvmState.create = null;
  resetProjectHistory(shellWindow.id);
});

function eventsOn(view: FakeView, channel: string): unknown[][] {
  return view.events.filter((event) => event.channel === channel).map((event) => event.args);
}

function from(view: FakeView): IpcContext {
  return { webContentsId: view.id, senderWindow: null } as unknown as IpcContext;
}

describe("a host plugin's dispatch into this Shell (integration harness)", () => {
  it(
    "runs only the actions this Shell allows a host's plugins, and filters the catalog to them",
    async () => {
      h = await startRemoteHarness();
      await h.connect();
      const view = h.addView(PLUGIN_VIEW, "proj-1");
      await h.openStreams(view);
      // The plugin's main code runs on the host; so does its dispatcher.
      const dispatcher = new PluginRendererDispatcher({ isDisposed: () => false });
      cleanups.push(() => dispatcher.dispose());

      // Clipboard and screen capture never go through an action: refused on
      // this Shell before the view is ever asked, whatever the arguments.
      for (const [actionId, args] of [
        ["browser.copyUrl", { url: "anything the host likes" }],
        ["browser.captureScreenshot", { terminalId: "browser-1" }],
        ["terminal.paste", { text: "rm -rf ~" }],
        ["host.switch", { hostId: "local" }],
        ["app.settings.open", {}],
      ] as const) {
        await expect(
          dispatcher.sendDispatchToRenderer(actionId, args, "proj-1", "acme.graph")
        ).resolves.toMatchObject({ ok: false, error: { code: "RESTRICTED" } });
      }
      expect(eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toHaveLength(0);

      // An audited project action still reaches the driving view, as a plugin dispatch.
      const dispatched = dispatcher.sendDispatchToRenderer(
        "worktree.refresh",
        undefined,
        "proj-1",
        "acme.graph"
      );
      await waitUntil(
        () => eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST).length === 1,
        "the allowed dispatch in the driving view"
      );
      const [request] = eventsOn(view, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)[0] as [
        { requestId: string; actionId: string },
      ];
      expect(request.actionId).toBe("worktree.refresh");
      h.send(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, view, {
        requestId: request.requestId,
        result: { ok: true, result: null },
      });
      await expect(dispatched).resolves.toEqual({ ok: true, result: null });

      // The catalog the host's plugin sees is the one it may dispatch from.
      const listed = dispatcher.sendActionsListToRenderer("proj-1", "acme.graph");
      await waitUntil(
        () => eventsOn(view, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST).length === 1,
        "the catalog request in the driving view"
      );
      const [listRequest] = eventsOn(view, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST)[0] as [
        { requestId: string },
      ];
      const entry = (id: string) => ({ id, title: id, danger: "safe" });
      h.send(CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE, view, {
        requestId: listRequest.requestId,
        entries: [
          entry("browser.copyUrl"),
          entry("browser.captureScreenshot"),
          entry("worktree.refresh"),
        ],
      });
      await expect(listed).resolves.toEqual([entry("worktree.refresh")]);

      // Looking up a refused action finds nothing, without asking the view.
      await expect(
        dispatcher.sendActionsGetToRenderer("browser.copyUrl", "proj-1", "acme.graph")
      ).resolves.toBeNull();
      expect(eventsOn(view, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST)).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});

describe("switch ordering with a slow host (integration harness)", () => {
  it(
    "lets the latest switch win: a slow host's earlier request resolves superseded and never moves the window",
    async () => {
      h = await startRemoteHarness();
      const harness = h;
      pvmState.create = (key) => {
        const view = new FakeView(nextViewId++);
        liveViews.set(view.id, view);
        projectKeys.set(view.id, key);
        return view;
      };
      const local = new FakeView(LOCAL_VIEW);
      liveViews.set(LOCAL_VIEW, local);
      projectKeys.set(LOCAL_VIEW, "proj-2");
      pvmState.views.set("proj-2", local);
      pvmState.active = "proj-2";
      await harness.connect();
      const client = harnessState.client!;

      // The host goes quiet: a switch to it waits on the link.
      await harness.dropLink();
      const slow = client.client.switchWindowHost(from(local), {
        hostId: HOST_ID,
        newWindow: false,
        projectId: "proj-1",
      });
      // Then the person picks a project on this machine, which is ready now.
      await expect(
        client.client.switchWindowHost(from(local), {
          hostId: "local",
          newWindow: false,
          projectId: "proj-1",
        })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "proj-1" });
      expect(pvmState.active).toBe("proj-1");

      // The host comes back; its stale request lands nowhere.
      await harness.restoreLink();
      await expect(slow).resolves.toEqual({ outcome: "superseded", hostId: HOST_ID });
      expect(pvmState.active).toBe("proj-1");
      expect(pvmState.requested).toEqual(["proj-1"]);
      // The binding stayed with the view: the window is on this machine.
      const landed = pvmState.views.get("proj-1") as FakeView;
      expect(client.hostForView(landed.id)).toBeNull();
      expect(client.client.getWindowHost(from(landed)).hostId).toBe("local");
    },
    TEST_TIMEOUT_MS
  );
});
