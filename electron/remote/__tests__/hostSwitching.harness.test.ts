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

/** This machine's scratch table, in memory: the real store is SQLite behind Electron's build. */
const scratches = vi.hoisted(
  () => new Map<string, { id: string; name: string; path: string; lastOpened: number }>()
);
vi.mock("../../services/ScratchStore.js", () => ({
  scratchStore: {
    getAllScratches: () => [...scratches.values()],
    getCurrentScratch: () => null,
    getScratchById: (id: string) => scratches.get(id) ?? null,
  },
}));

/**
 * This Shell's MCP bridge into its views. The renderer that runs an action is
 * not in the harness; this stands in for it, answering a screenshot with real
 * PNG bytes and a manifest that includes actions a host must never see.
 */
const mcp = vi.hoisted(() => ({
  dispatched: [] as unknown[][],
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 254, 255]),
}));
vi.mock("../../services/McpServerService.js", () => ({
  mcpServerService: {
    async dispatchActionForHost(...args: unknown[]) {
      mcp.dispatched.push(args);
      const actionId = args[1];
      if (actionId === "browser.captureScreenshot") {
        return {
          result: {
            ok: true,
            result: {
              pngBase64: Buffer.from(mcp.png).toString("base64"),
              width: 2,
              height: 1,
            },
          },
          approvalScope: "session",
        };
      }
      if (actionId === "host.switch") {
        // Confirm-gated: what the view answers when the person declines.
        return {
          result: { ok: false, error: { code: "CONFIRMATION_DENIED", message: "declined" } },
          confirmationDecision: "rejected",
        };
      }
      return { result: { ok: true, result: null } };
    },
    async requestManifestForHost() {
      return ["browser.captureScreenshot", "host.switch", "project.openOnHost", "app.settings.open"]
        .concat(["terminal.paste", "terminal.list"])
        .map((id) => ({ id, name: id, title: id, description: id, kind: "command" }));
    },
  },
}));

/**
 * The Shell's one window and its ProjectViewManager, keyed exactly as the
 * real one is: a bare id for a local project, `<host>:<id>` for a remote one.
 * Each new view registers where the webContents registry looks it up.
 */
const shellWindow = vi.hoisted(() => ({ id: 1, isDestroyed: () => false, once: () => undefined }));
const pvmState = vi.hoisted(() => ({
  active: null as string | null,
  views: new Map<string, { webContents: unknown }>(),
  create: null as null | ((key: string) => { webContents: unknown }),
}));
const fakePvm = vi.hoisted(() => {
  // Serialized and slow to land, as the real manager's switch chain is.
  let chain: Promise<unknown> = Promise.resolve();
  function show(key: string) {
    const next = chain.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return land(key);
    });
    chain = next.catch(() => undefined);
    return next;
  }
  function land(key: string) {
    let view = pvmState.views.get(key);
    const isNew = !view;
    if (!view) {
      view = pvmState.create!(key);
      pvmState.views.set(key, view);
    }
    pvmState.active = key;
    return { view, isNew };
  }
  return {
    async switchToHostProject(hostId: string, projectId: string) {
      return show(`${hostId}:${projectId}`);
    },
    async switchTo(projectId: string) {
      return show(projectId);
    },
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

import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { ProjectHistoryTarget } from "../../../shared/types/ipc/project.js";
import { parseHostScopedKey, toHostScopedKey } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { registerProjectHistoryHandlers } from "../../ipc/handlers/projectHistory.js";
import type { IpcContext, HandlerDependencies } from "../../ipc/types.js";
import { getProjectHistory, resetProjectHistory } from "../../services/ProjectHistoryService.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
} from "../../services/mcp-server/driveTarget.js";
import { FakeView, liveViews, projectKeys } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const LOCAL_VIEW = 10; // this machine's proj-2, where the window starts
const TEST_TIMEOUT_MS = 60_000;
const REMOTE_KEY = toHostScopedKey(HOST_ID, "proj-1");

let h: RemoteHarness | null = null;
const cleanups: Array<() => void> = [];
let nextViewId = 20;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await h?.dispose();
  h = null;
  pvmState.active = null;
  pvmState.views.clear();
  pvmState.create = null;
  mcp.dispatched.length = 0;
  scratches.clear();
  resetProjectHistory(shellWindow.id);
});

function data<T>(envelope: IpcEnvelope): T {
  if (!envelope.ok) throw new Error(`call failed: ${envelope.error.message}`);
  return envelope.data as T;
}

/** What the switch IPC hands the client: the sender's view, resolved to its window. */
function from(view: FakeView): IpcContext {
  return { webContentsId: view.id, senderWindow: null } as unknown as IpcContext;
}

/** A window on this machine's proj-2, with the views its manager creates registered as the real ones are. */
async function startWindowOnLocalProject(): Promise<{ harness: RemoteHarness; local: FakeView }> {
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
  return { harness, local };
}

function activeView(): FakeView {
  return pvmState.views.get(pvmState.active!) as FakeView;
}

describe("switching hosts (integration harness)", () => {
  it(
    "moves the window's view with its binding, returns to the host's remembered project, and toggles back across hosts",
    async () => {
      const { harness, local } = await startWindowOnLocalProject();
      const client = harnessState.client!;
      cleanups.push(registerProjectHistoryHandlers({} as HandlerDependencies));

      // First visit: this machine never showed anything there, so nothing moves
      // and the caller is asked to offer the host's project list.
      await expect(
        client.client.switchWindowHost(from(local), { hostId: HOST_ID, newWindow: false })
      ).resolves.toEqual({ outcome: "choose-project", hostId: HOST_ID });
      expect(pvmState.active).toBe("proj-2");
      expect(client.hostForView(LOCAL_VIEW)).toBeNull();

      // Picking proj-1 from that list opens it there, in a view keyed to the host.
      await expect(
        client.client.switchWindowHost(from(local), {
          hostId: HOST_ID,
          newWindow: false,
          projectId: "proj-1",
        })
      ).resolves.toEqual({ outcome: "switched", hostId: HOST_ID, projectId: "proj-1" });
      expect(pvmState.active).toBe(REMOTE_KEY);
      const remote = activeView();
      expect(client.hostForView(remote.id)).toBe(HOST_ID);
      // The host now remembers it for this machine, and says so over the link.
      const connection = harness.manager.get(HOST_ID)!;
      await vi.waitFor(async () =>
        expect((await connection.lastActiveProject())?.projectId).toBe("proj-1")
      );

      // Back to this machine with no project named: the window's own last one.
      await expect(
        client.client.switchWindowHost(from(remote), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: "proj-2" });
      expect(pvmState.active).toBe("proj-2");
      expect(client.hostForView(LOCAL_VIEW)).toBeNull();

      // "Switch to previous workspace" from the local view points across hosts.
      const back = data<ProjectHistoryTarget | null>(
        await harness.invoke(CHANNELS.PROJECT_HISTORY_PEEK, local)
      );
      expect(back).toEqual({ workspaceId: REMOTE_KEY });

      // Just switch host, as the chip's row does: the host's remembered project.
      await expect(
        client.client.switchWindowHost(from(local), { hostId: HOST_ID, newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: HOST_ID, projectId: "proj-1" });
      expect(pvmState.active).toBe(REMOTE_KEY);
      expect(activeView().id).toBe(remote.id);
      // Calls from the view it landed on reach the host.
      data(await harness.invoke(CHANNELS.OPERATIONS_LIST, remote, {}));

      // And from the remote view, the toggle leads home to this machine.
      const home = data<ProjectHistoryTarget | null>(
        await harness.invoke(CHANNELS.PROJECT_HISTORY_PEEK, remote)
      );
      expect(home).toEqual({ workspaceId: "proj-2" });
      expect(getProjectHistory(shellWindow.id).snapshot().entries.slice(0, 2)).toEqual([
        REMOTE_KEY,
        "proj-2",
      ]);
      expect(parseHostScopedKey(REMOTE_KEY)).toEqual({ hostId: HOST_ID, projectId: "proj-1" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "records overlapping switches in the order they landed",
    async () => {
      const { local } = await startWindowOnLocalProject();
      const client = harnessState.client!;
      await Promise.all([
        client.client.switchWindowHost(from(local), {
          hostId: HOST_ID,
          newWindow: false,
          projectId: "proj-1",
        }),
        client.client.switchWindowHost(from(local), {
          hostId: HOST_ID,
          newWindow: false,
          projectId: "proj-2",
        }),
      ]);
      expect(pvmState.active).toBe(toHostScopedKey(HOST_ID, "proj-2"));
      // The toggle from proj-2 leads back to proj-1, not past it.
      expect(getProjectHistory(shellWindow.id).snapshot().entries).toEqual([
        toHostScopedKey(HOST_ID, "proj-2"),
        REMOTE_KEY,
        "proj-2",
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "returns a window to the local scratch it left",
    async () => {
      const scratchId = "11111111-1111-4111-8111-111111111111";
      const { harness, local } = await startWindowOnLocalProject();
      scratches.set(scratchId, { id: scratchId, name: "Spike", path: harness.dir, lastOpened: 1 });
      const client = harnessState.client!;
      // The window moves from proj-2 into the scratch, then to the host.
      await client.client.switchWindowHost(from(local), {
        hostId: "local",
        newWindow: false,
        projectId: scratchId,
      });
      expect(pvmState.active).toBe(scratchId);
      await client.client.switchWindowHost(from(activeView()), {
        hostId: HOST_ID,
        newWindow: false,
        projectId: "proj-1",
      });
      await expect(
        client.client.switchWindowHost(from(activeView()), { hostId: "local", newWindow: false })
      ).resolves.toEqual({ outcome: "switched", hostId: "local", projectId: scratchId });
      expect(pvmState.active).toBe(scratchId);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "lets the host's MCP capture a browser screenshot and request host moves, on this Shell's terms",
    async () => {
      const { harness, local } = await startWindowOnLocalProject();
      const client = harnessState.client!;
      await client.client.switchWindowHost(from(local), {
        hostId: HOST_ID,
        newWindow: false,
        projectId: "proj-1",
      });
      const remote = activeView();
      data(await harness.invoke(CHANNELS.OPERATIONS_LIST, remote, {}));
      const endpoint = await waitForEndpoint();

      // The manifest the host sees carries the host-switch and screenshot
      // actions, and still nothing that reaches this machine's settings or clipboard.
      const manifest = (await endpoint.request(MCP_GET_MANIFEST_METHOD, null)) as Array<{
        id: string;
      }>;
      expect(manifest.map((entry) => entry.id).sort()).toEqual([
        "browser.captureScreenshot",
        "host.switch",
        "project.openOnHost",
        "terminal.list",
      ]);

      // PNG bytes from this Shell's browser panel reach the host intact.
      const shot = (await endpoint.request(MCP_DISPATCH_ACTION_METHOD, {
        actionId: "browser.captureScreenshot",
        args: { terminalId: "browser-1" },
        confirmed: true,
        sessionOrigin: "external",
      })) as { result: { ok: true; result: { pngBase64: string } }; approvalScope?: unknown };
      expect(Buffer.from(shot.result.result.pngBase64, "base64")).toEqual(Buffer.from(mcp.png));
      // No reusable approval goes back to the host.
      expect(shot).not.toHaveProperty("approvalScope");

      // A host switch is asked for, never pre-approved: the view raises its own
      // confirmation naming the host, and the person here declined it.
      const switchAnswer = (await endpoint.request(MCP_DISPATCH_ACTION_METHOD, {
        actionId: "host.switch",
        args: { hostId: "local" },
        confirmed: true,
        sessionOrigin: "external",
      })) as { result: { ok: boolean }; confirmationDecision?: string };
      expect(switchAnswer).toEqual({
        result: { ok: false, error: { code: "CONFIRMATION_DENIED", message: "declined" } },
        confirmationDecision: "rejected",
      });
      await endpoint.request(MCP_DISPATCH_ACTION_METHOD, {
        actionId: "project.openOnHost",
        args: { hostId: "local", projectId: "proj-1" },
        confirmed: false,
        sessionOrigin: "external",
      });

      expect(mcp.dispatched.map((call) => [call[0], call[1], call[3], call[5]])).toEqual([
        [remote.id, "browser.captureScreenshot", false, "external"],
        [remote.id, "host.switch", false, "external"],
        [remote.id, "project.openOnHost", false, "external"],
      ]);
      const requestedBy = mcp.dispatched[1]![7] as { userAgent: string };
      expect(requestedBy.userAgent).toContain(HOST_ID);

      // Still refused: this machine's clipboard.
      await expect(
        endpoint.request(MCP_DISPATCH_ACTION_METHOD, {
          actionId: "terminal.paste",
          args: {},
          confirmed: true,
          sessionOrigin: "external",
        })
      ).resolves.toMatchObject({ result: { ok: false, error: { code: "NOT_FOUND" } } });
      expect(mcp.dispatched).toHaveLength(3);
    },
    TEST_TIMEOUT_MS
  );
});

/** The host-side endpoint of the one remote view, once the Shell opened it. */
async function waitForEndpoint(): Promise<ClientEndpoint> {
  let endpoint: ClientEndpoint | undefined;
  await waitUntil(() => {
    endpoint = getEndpointRegistry().getRemote()[0];
    return endpoint !== undefined;
  }, "the host to open the view's endpoint");
  return endpoint!;
}
