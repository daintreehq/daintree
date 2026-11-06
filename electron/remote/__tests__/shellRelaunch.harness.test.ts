import crypto from "node:crypto";
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

// Both boot paths start the workspace client before Remote Hosts; the harness has none.
vi.mock("../../boot/hostServices.js", () => ({
  isWorkspaceClientStarting: () => false,
  ensureWorkspaceClient: async () => undefined,
}));

// Host mode advertises over mDNS; never on the test machine's network.
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

// Observe, not replace: the harness reads bridges and the booted client.
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
 * The host's help-session service, as far as a view's assistant crosses the
 * link: provisioned for a view's endpoint, left running and detached when that
 * endpoint goes, and handed to the next view that drives its project. The real
 * one's lanes, session folders and MCP are its own suite's.
 */
const assistants = vi.hoisted(() => {
  interface Lane {
    sessionId: string;
    projectId: string;
    slot: number;
    /** The view endpoint it is pinned to; null while it runs detached. */
    handle: number | null;
  }
  const state = {
    lanes: [] as Lane[],
    provisioned: [] as Array<Record<string, unknown>>,
    detachedFrom: [] as number[],
    adopted: [] as Array<{ sessionId: string; handle: number }>,
    onDetached: new Set<() => void>(),
    /** Each lane's saved conversation, as a restarted host reads it back from disk. */
    saved: new Map<string, { agentId: string; agentSessionId: string; cwd: string }>(),
    peeks: [] as Array<{ projectId: string; slot: number; viewHandle: number | undefined }>,
    claims: [] as Array<{ projectId: string; slot: number; owner: number; claimId: string }>,
  };
  const refsFor = (handle: number) =>
    state.lanes
      .filter((lane) => lane.handle === handle)
      .map((lane) => ({
        helpSessionId: lane.sessionId,
        terminalId: `terminal-${lane.sessionId}`,
        slot: lane.slot,
      }));
  const service = {
    async provisionSession(input: Record<string, unknown>) {
      state.provisioned.push(input);
      const lane: Lane = {
        sessionId: `help-${state.provisioned.length}`,
        projectId: input.projectId as string,
        slot: (input.slot as number | undefined) ?? 0,
        handle: input.projectViewWebContentsId as number,
      };
      state.lanes.push(lane);
      return {
        sessionId: lane.sessionId,
        sessionPath: "/host/userData/help-sessions/abc",
        token: "bearer-minted-on-the-host",
        tier: "action",
        mcpUrl: "http://127.0.0.1:45454/sse",
        windowId: input.windowId,
      };
    },
    async revokeByWebContentsId(handle: number) {
      state.lanes = state.lanes.filter((lane) => lane.handle !== handle);
    },
    async revokeSession(sessionId: string) {
      state.lanes = state.lanes.filter((lane) => lane.sessionId !== sessionId);
    },
    helpSessionRefsForWebContentsId: refsFor,
    async detachByWebContentsId(handle: number) {
      const pinned = state.lanes.filter((lane) => lane.handle === handle);
      if (pinned.length === 0) return;
      state.detachedFrom.push(handle);
      for (const lane of pinned) lane.handle = null;
      for (const listener of [...state.onDetached]) listener();
    },
    async adoptDetachedSession(projectId: string, slot: number, handle: number) {
      const lane = state.lanes.find(
        (candidate) =>
          candidate.projectId === projectId && candidate.slot === slot && candidate.handle === null
      );
      if (!lane) return { status: "absent" };
      lane.handle = handle;
      state.adopted.push({ sessionId: lane.sessionId, handle });
      return {
        status: "adopted",
        lane: {
          sessionId: lane.sessionId,
          terminalId: `terminal-${lane.sessionId}`,
          agentId: "claude",
          cwd: null,
          title: null,
          agentState: null,
          waitingReason: null,
          lastStateChange: null,
          cols: null,
          rows: null,
        },
      };
    },
    detachedProjectIds: () => [
      ...new Set(state.lanes.filter((lane) => lane.handle === null).map((lane) => lane.projectId)),
    ],
    detachedSlots: (projectId: string) =>
      state.lanes
        .filter((lane) => lane.handle === null && lane.projectId === projectId)
        .map((lane) => lane.slot),
    peekPendingHibernation(projectId: string, slot: number, options?: { viewHandle?: number }) {
      state.peeks.push({ projectId, slot, viewHandle: options?.viewHandle });
      const saved = state.saved.get(`${projectId}:${slot}`);
      return saved ? { ...saved, panelWasOpen: false } : null;
    },
    async takePendingHibernation(projectId: string, slot: number, owner: number) {
      const saved = state.saved.get(`${projectId}:${slot}`);
      if (!saved || state.claims.some((claim) => claim.projectId === projectId)) return null;
      const claimId = `claim-${state.claims.length + 1}`;
      state.claims.push({ projectId, slot, owner, claimId });
      return { ...saved, claimId };
    },
    addLaneDetachedListener(listener: () => void) {
      state.onDetached.add(listener);
      return () => state.onDetached.delete(listener);
    },
    addSessionEndedListener: () => () => {},
    addSessionReattachedListener: () => () => {},
    getRunningLaneSession: () => null,
    getAssistantBackends: () => [],
  };
  return {
    state,
    service,
    reset() {
      state.lanes = [];
      state.provisioned.length = 0;
      state.detachedFrom.length = 0;
      state.adopted.length = 0;
      state.onDetached.clear();
      state.saved.clear();
      state.peeks.length = 0;
      state.claims.length = 0;
    },
  };
});
vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: assistants.service,
}));

/**
 * The Shell's windows, each with a ProjectViewManager keyed as the real one
 * is (`<host>:<id>` for a host's project). A view it makes is a FakeView,
 * registered where the webContents registry looks. A relaunch opens new
 * windows; the old ones close with the Shell they belonged to.
 */
/** Views on this machine that every Remote Hosts broadcast reaches, as `getAllAppWebContents` lists them. */
const localAppViews = vi.hoisted(() => new Set<{ webContents: unknown }>());

const shellWindows = vi.hoisted(() => {
  interface View {
    id: number;
    webContents: { id: number };
  }
  interface Disposable {
    dispose(): void;
  }
  interface ShellWindow {
    windowId: number;
    closed: boolean;
    browserWindow: { id: number; isDestroyed(): boolean; once(): void };
    services: { projectViewManager: ReturnType<typeof viewManager> };
    cleanup: { add(disposable: Disposable): void };
    close(): void;
  }
  const state = {
    windows: new Map<number, ShellWindow>(),
    nextWindowId: 1,
    makeView: null as null | ((key: string) => View),
  };
  function viewManager() {
    const views = new Map<string, View>();
    let active: string | null = null;
    const make = (key: string): View => {
      if (!state.makeView) throw new Error("no view factory");
      const view = state.makeView(key);
      views.set(key, view);
      return view;
    };
    return {
      disposed: false,
      views,
      async switchToHostProject(hostId: string, projectId: string) {
        const key = `${hostId}:${projectId}`;
        const existing = views.get(key);
        active = key;
        return { view: existing ?? make(key), isNew: !existing };
      },
      async restoreInBackground(key: string) {
        if (views.has(key)) return { status: "skipped", reason: "already-live" };
        make(key);
        return { status: "restored" };
      },
      getActiveProjectId: () => active,
      getActiveView: () => (active ? (views.get(active) ?? null) : null),
      getOutgoingBridgeProjectId: () => null,
      setPendingFocusIntent: () => undefined,
      getAllViews: () =>
        [...views.entries()].map(([projectId, view]) => ({
          projectId,
          webContents: view.webContents,
          state: projectId === active ? "active" : "cached",
        })),
      releaseCachedView: () => false,
      abandonBackgroundRestore: () => false,
      destroyView: (key: string) => views.delete(key),
    };
  }
  function open(): ShellWindow {
    const windowId = state.nextWindowId++;
    const disposables: Disposable[] = [];
    const window: ShellWindow = {
      windowId,
      closed: false,
      browserWindow: { id: windowId, isDestroyed: () => window.closed, once: () => undefined },
      services: { projectViewManager: viewManager() },
      cleanup: { add: (disposable) => void disposables.push(disposable) },
      close() {
        window.closed = true;
        window.services.projectViewManager.disposed = true;
        for (const disposable of disposables.splice(0)) disposable.dispose();
      },
    };
    state.windows.set(windowId, window);
    return window;
  }
  return {
    state,
    open,
    closeAll() {
      for (const window of state.windows.values()) window.close();
      state.windows.clear();
    },
    windowOf(webContentsId: number): ShellWindow | null {
      for (const window of state.windows.values()) {
        const views = window.services.projectViewManager.views.values();
        if ([...views].some((view) => view.id === webContentsId)) return window;
      }
      return null;
    },
  };
});

vi.mock("../../window/windowRef.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../window/windowRef.js")>()),
  getWindowRegistry: () => ({
    getByWindowId: (id: number) => shellWindows.state.windows.get(id),
    all: () => [...shellWindows.state.windows.values()],
  }),
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: (wc: { id: number } | null) =>
      (wc && shellWindows.windowOf(wc.id)?.browserWindow) ?? null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
    getAllAppWebContents: () => [...localAppViews].map((view) => view.webContents),
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
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import type { TerminalReconnectResult } from "../../../shared/types/ipc.js";
import type { ProjectState } from "../../../shared/types/project.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { parseHostScopedKey, toHostScopedKey } from "../../../shared/types/remoteHosts.js";
import type { TerminalSnapshot } from "../../types/index.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { registerHelpHandlers } from "../../ipc/handlers/help.js";
import { HELP_METHOD_CHANNELS } from "../../ipc/handlers/help.preload.js";
import { registerTerminalSnapshotHandlers } from "../../ipc/handlers/terminal/snapshots.js";
import { registerTerminalLayoutHandlers } from "../../ipc/handlers/terminalLayout.js";
import { TERMINAL_LAYOUT_METHOD_CHANNELS } from "../../ipc/handlers/terminalLayout.preload.js";
import type { HandlerDependencies, IpcContext } from "../../ipc/types.js";
import { typedHandleWithContext } from "../../ipc/utils.js";
import {
  DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS,
  DEFAULT_RESTORED_RESERVATION_GRACE_MS,
  getDriveLeaseService,
} from "../../services/DriveLeaseService.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { resetProjectHistory } from "../../services/ProjectHistoryService.js";
import { getPendingRemoteBackgroundRestores } from "../../window/openWindowsTracker.js";
import {
  forgetRemoteWindowRestore,
  noteRemoteWindowRestore,
  remoteWindowReady,
  resetRemoteWindowRestoreForTests,
  restoreRemoteWindows,
  takeHostBackgroundRestores,
} from "../../window/remoteWindowRestore.js";
import { LinkClient, type LinkSessionEstablished } from "../client/LinkClient.js";
import { createDirectTransport } from "../client/transport.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import type { RemoteViewEndpoint } from "../host/RemoteViewEndpoint.js";
import { Lane } from "../link/frames.js";
import { ControlKind } from "../link/messages.js";
import { getRemoteService } from "../runtime.js";
import { FakeView } from "./harness/fakeView.js";
import { memoryProjectStore } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const TEST_TIMEOUT_MS = 60_000;
/** A drive lease grace short enough to wait out, where a test needs one to run out. */
const GRACE_MS = 3_000;
const LAPTOP = "Greg’s MacBook Air";

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];
let nextViewId = 100;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  localAppViews.clear();
  closeShellWindows();
  await h?.dispose();
  h = null;
  shellWindows.state.makeView = null;
  assistants.reset();
});

function data<T>(envelope: IpcEnvelope): T {
  if (!envelope.ok)
    throw new Error(`[${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
  return envelope.data as T;
}

function refusal(envelope: IpcEnvelope): { code?: string; userMessage?: string } | null {
  return envelope.ok
    ? null
    : { code: envelope.error.code, userMessage: envelope.error.userMessage };
}

/** Every window the running Shell has goes, as at quit; a relaunch starts with none. */
function closeShellWindows(): void {
  for (const windowId of shellWindows.state.windows.keys()) {
    forgetRemoteWindowRestore(windowId);
    resetProjectHistory(windowId);
  }
  shellWindows.closeAll();
  resetRemoteWindowRestoreForTests();
}

/**
 * The host, with the real terminal snapshot handlers over its pty-host and a
 * stand-in for the spawn behind `terminal:spawn` (the harness has no pty-host
 * to start a process), recording what each spawn asked for.
 */
async function harness(options: Parameters<typeof startRemoteHarness>[0] = {}) {
  const r = (h = await startRemoteHarness(options));
  shellWindows.state.makeView = (key) => r.addView(nextViewId++, parseHostScopedKey(key).projectId);
  cleanups.push(
    registerTerminalSnapshotHandlers({
      ptyClient: r.pty.client as unknown as PtyClient,
    } as HandlerDependencies)
  );
  const spawns: Array<{ ctx: IpcContext; request: SpawnRequest }> = [];
  cleanups.push(
    typedHandleWithContext(
      CHANNELS.TERMINAL_SPAWN as never,
      ((ctx: IpcContext, request: SpawnRequest) => {
        spawns.push({ ctx, request });
        r.pty.spawn(request.id, request.projectId, {
          launchAgentId: request.launchAgentId,
          agentSessionId: request.agentSessionId,
        });
        return request.id;
      }) as never
    )
  );
  return { r, spawns };
}

interface SpawnRequest {
  id: string;
  projectId: string;
  cwd: string;
  kind: "terminal";
  launchAgentId?: string;
  agentSessionId?: string;
}

function spawnRequest(
  r: RemoteHarness,
  id: string,
  projectId = "proj-1",
  agent: Pick<SpawnRequest, "launchAgentId" | "agentSessionId"> = {}
): SpawnRequest {
  return { id, projectId, cwd: r.projects.get(projectId)!.path, kind: "terminal", ...agent };
}

/**
 * What main does for a window the manifest says was on the host when the app
 * quit: note it and its background host projects, mark the window set up, and
 * run the real restore once Remote Hosts is up. Resolves once the window shows
 * its project and every background one is back in its cache.
 */
async function restoreWindow(foreground: string, background: string[] = []) {
  const window = shellWindows.open();
  const views = window.services.projectViewManager;
  noteRemoteWindowRestore(window.windowId, toHostScopedKey(HOST_ID, foreground));
  takeHostBackgroundRestores(
    window.windowId,
    background.map((projectId) => toHostScopedKey(HOST_ID, projectId))
  );
  remoteWindowReady(window.windowId);
  await restoreRemoteWindows({
    isWindowWaiting: () => !window.closed,
    canRestoreInBackground: () => !window.closed,
    viewOf: () => null,
    onRestored: () => undefined,
  });
  await waitUntil(
    () => getPendingRemoteBackgroundRestores(window.windowId).length === 0,
    "the window's background host projects"
  );
  const view = (projectId: string) =>
    views.views.get(toHostScopedKey(HOST_ID, projectId)) as FakeView | undefined;
  return { window, views, view, shown: view(foreground)! };
}

/** The Shell quits (or crashes) and its windows go with it; the host stays up. */
async function quitShell(r: RemoteHarness, how: "quit" | "crash" = "quit") {
  await r.stopShell(how);
  closeShellWindows();
}

/**
 * Another Shell install on a link of its own to the harness host: a laptop
 * with its own device id, whose window opens a project and changes it.
 */
async function otherInstall(r: RemoteHarness) {
  const link = new LinkClient({
    transport: createDirectTransport({ discoveryPath: r.hostLocation.discoveryPath }),
    handshake: getLocalHandshakeInfo(),
    client: {
      clientId: crypto.randomUUID(),
      clientName: LAPTOP,
      platform: "darwin",
      deviceId: crypto.randomUUID(),
    },
    backoff: { initialMs: 10, maxMs: 50 },
  });
  const sessions: LinkSessionEstablished[] = [];
  link.onSession((established) => sessions.push(established));
  link.start();
  cleanups.push(() => link.stop());
  await waitUntil(() => sessions.at(-1)?.session.isOpen === true, "the laptop to connect");
  const { session } = sessions.at(-1)!;
  return {
    open(endpointId: string, projectId: string) {
      session.post({
        lane: Lane.CONTROL,
        kind: ControlKind.ENDPOINT_OPEN,
        body: { endpointId, projectId },
      });
    },
    call(endpointId: string, channel: string, ...args: unknown[]): Promise<IpcEnvelope> {
      return session.invoke(endpointId, channel, args);
    },
    spawn(endpointId: string, request: SpawnRequest): Promise<IpcEnvelope> {
      return session.invoke(endpointId, CHANNELS.TERMINAL_SPAWN, [request]);
    },
    quit: () => link.stop(),
  };
}

function holderName(projectId: string): string | null {
  return getDriveLeaseService().getHolder(projectId)?.clientName ?? null;
}

describe("a relaunch of the Shell against a host that stays up (integration harness)", () => {
  it(
    "quit and relaunch: the window comes back on its host project on a fresh endpoint, and its terminal carries on where the host kept it",
    async () => {
      const { r, spawns } = await harness();
      const expired: Array<{ sessionId: string; cause: string }> = [];
      cleanups.push(
        r.server().onSessionExpired(({ sessionId, cause }) => expired.push({ sessionId, cause }))
      );
      const server = r.server();
      const sessionHost = r.sessionHost();

      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(await r.invoke(CHANNELS.TERMINAL_SPAWN, first.shown, spawnRequest(r, "t1")));
      const terminal = r.pty.terminals.get("t1")!;
      r.pty.emit("t1", "before;");
      await waitUntil(() => first.shown.text("t1") === "before;", "output before the quit");
      const install = r.shellIdentity().client;
      let previous = r.shellIdentity();

      for (const launch of [2, 3]) {
        // Before the quit, so the grace it leaves can't have run out by any check below.
        const quitAt = Date.now();
        await quitShell(r);
        expect(expired).toContainEqual({ sessionId: previous.sessionId, cause: "goodbye" });
        // Held for the launch that left, inside its grace.
        expect(getDriveLeaseService().getDriveTarget("proj-1")).toMatchObject({
          kind: "reserved",
          holder: { clientId: previous.client.clientId },
        });
        expect(getEndpointRegistry().getRemote()).toEqual([]);
        r.pty.emit("t1", `while-away-${launch};`);

        await r.startShell();
        const restored = await restoreWindow("proj-1");
        const view = restored.shown;
        const identity = r.shellIdentity();
        // Still the last launch's until the restored view's first call opens its endpoint.
        expect(getDriveLeaseService().getDriveTarget("proj-1")).toMatchObject({
          kind: "reserved",
          holder: { clientId: previous.client.clientId },
        });
        expect(identity.client.clientId).not.toBe(previous.client.clientId);
        expect(identity.client.deviceId).toBe(install.deviceId);
        expect(identity.sessionId).not.toBe(previous.sessionId);
        // The same host throughout: its server, session host and terminals.
        expect(r.server()).toBe(server);
        expect(r.sessionHost()).toBe(sessionHost);
        expect(r.pty.terminals.get("t1")).toBe(terminal);

        // The restored pane finds its terminal alive and paints what it missed.
        const found = data<TerminalReconnectResult>(
          await r.invoke(CHANNELS.TERMINAL_RECONNECT, view, "t1")
        );
        expect(found).toMatchObject({ exists: true, id: "t1", projectId: "proj-1" });
        const painted = data<SerializedTerminalSnapshot>(
          await r.invoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, view, "t1")
        );
        expect(painted.data).toBe(terminal.transcript);
        expect(painted.data.endsWith(`while-away-${launch};`)).toBe(true);
        await r.openStreams(view);
        r.pty.emit("t1", `live-${launch};`);
        await waitUntil(() => view.text("t1").endsWith(`live-${launch};`), "live output");
        view.write("t1", `typed-${launch}\r`);
        await waitUntil(
          () => terminal.writes.includes(`typed-${launch}\r`),
          "input after relaunch"
        );

        // Its first change goes through, inside the grace the last launch left:
        // taken back as the same install's, not handed over when the grace ran out.
        const spawned = await r.invoke(
          CHANNELS.TERMINAL_SPAWN,
          view,
          spawnRequest(r, `t-launch-${launch}`)
        );
        expect(refusal(spawned)).toBeNull();
        expect(Date.now() - quitAt).toBeLessThan(DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS);
        expect(getDriveLeaseService().getHolder("proj-1")).toMatchObject({
          clientId: identity.client.clientId,
        });
        // One endpoint on the host, the restored view's.
        expect(
          getEndpointRegistry()
            .getRemote()
            .map((e) => e.linkSessionId)
        ).toEqual([identity.sessionId]);
        previous = identity;
      }
      expect(spawns.map((spawn) => spawn.request.id)).toEqual(["t1", "t-launch-2", "t-launch-3"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "relaunch: a view open before Remote Hosts start hears the saved hosts once the client is up, with no connection event (#15887)",
    async () => {
      const { r } = await harness();
      await quitShell(r);
      // A window restored ahead of Remote Hosts: its host list read found no client.
      expect(getRemoteService("remoteHostsClient")).toBeUndefined();
      const early = new FakeView(nextViewId++);
      localAppViews.add(early);
      cleanups.push(() => early.destroy());
      const heard: Array<{ event: RemoteHostsEvent; listedThen: string[] }> = [];
      const deliver = early.webContents.send;
      early.webContents.send = (channel, ...args) => {
        deliver(channel, ...args);
        if (channel !== CHANNELS.REMOTE_HOSTS_EVENT) return;
        // What a list read made on hearing the event would answer.
        const listedThen =
          getRemoteService("remoteHostsClient")
            ?.list()
            .map((entry) => entry.descriptor.id) ?? [];
        heard.push({ event: args[0] as RemoteHostsEvent, listedThen });
      };

      await r.startShell();

      expect(heard).toEqual([
        {
          event: {
            type: "hosts-changed",
            hosts: [
              expect.objectContaining({
                descriptor: expect.objectContaining({ id: HOST_ID }),
                connection: { status: "disconnected" },
              }),
            ],
          },
          listedThen: [HOST_ID],
        },
      ]);
      expect(r.isConnected()).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "crash and relaunch: the parked session keeps the window's endpoint until the new launch's HELLO replaces it",
    async () => {
      const { r } = await harness();
      const expired: Array<{ sessionId: string; cause: string }> = [];
      cleanups.push(
        r.server().onSessionExpired(({ sessionId, cause }) => expired.push({ sessionId, cause }))
      );
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(await r.invoke(CHANNELS.TERMINAL_SPAWN, first.shown, spawnRequest(r, "t1")));
      const crashed = r.shellIdentity();
      const [oldEndpoint] = getEndpointRegistry().getRemote() as RemoteViewEndpoint[];

      await quitShell(r, "crash");
      // Parked for its resume grace: nothing has ended it, and its view endpoint stays open.
      expect(expired).toEqual([]);
      expect(oldEndpoint!.isClosed()).toBe(false);

      await r.startShell();
      const restored = await restoreWindow("proj-1");
      await waitUntil(() => oldEndpoint!.isClosed(), "the parked session's endpoint to close");
      expect(expired).toEqual([{ sessionId: crashed.sessionId, cause: "session-replaced" }]);
      expect(oldEndpoint!.closeCause).toBe("session-replaced");
      await r.openStreams(restored.shown);
      const spawned = await r.invoke(
        CHANNELS.TERMINAL_SPAWN,
        restored.shown,
        spawnRequest(r, "t2")
      );
      expect(refusal(spawned)).toBeNull();
      expect(
        getEndpointRegistry()
          .getRemote()
          .map((e) => e.linkSessionId)
      ).toEqual([r.shellIdentity().sessionId]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "quit and relaunch: the window's background host projects come back to its cache behind the one it shows, and drive at once (#13932)",
    async () => {
      const { r } = await harness();
      const first = await restoreWindow("proj-1", ["proj-2"]);
      for (const projectId of ["proj-1", "proj-2"]) {
        const view = first.view(projectId)!;
        await r.openStreams(view);
        data(
          await r.invoke(
            CHANNELS.TERMINAL_SPAWN,
            view,
            spawnRequest(r, `t-${projectId}`, projectId)
          )
        );
      }
      const quitAt = Date.now();
      const before = r.shellIdentity().client;
      await quitShell(r);

      await r.startShell();
      const restored = await restoreWindow("proj-1", ["proj-2"]);
      expect(restored.views.getActiveProjectId()).toBe(toHostScopedKey(HOST_ID, "proj-1"));
      expect(getDriveLeaseService().getDriveTarget("proj-2")).toMatchObject({
        kind: "reserved",
        holder: { clientId: before.clientId },
      });
      const background = restored.view("proj-2");
      expect(background).toBeDefined();
      expect(background!.id).not.toBe(first.view("proj-2")!.id);
      // Each view opens its endpoint on the relaunched Shell's session as it loads.
      for (const projectId of ["proj-1", "proj-2"]) await r.openStreams(restored.view(projectId)!);
      const session = r.shellIdentity().sessionId;
      expect(
        getEndpointRegistry()
          .getRemote()
          .map((endpoint) => [endpoint.linkSessionId, endpoint.projectId])
          .sort()
      ).toEqual([
        [session, "proj-1"],
        [session, "proj-2"],
      ]);
      // The background view meets its project's reservation as the shown one
      // does, and takes it back as its own install's.
      const spawned = await r.invoke(
        CHANNELS.TERMINAL_SPAWN,
        background!,
        spawnRequest(r, "t-proj-2-again", "proj-2")
      );
      expect(refusal(spawned)).toBeNull();
      expect(Date.now() - quitAt).toBeLessThan(DEFAULT_DRIVE_LEASE_RELEASE_GRACE_MS);
      expect(getDriveLeaseService().getHolder("proj-2")).toMatchObject({
        clientId: r.shellIdentity().client.clientId,
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe("a relaunched Shell's restore while another install has the project (integration harness)", () => {
  it(
    "another install drives: the restored window watches until that install has left and its grace is out, then drives",
    async () => {
      const { r, spawns } = await harness({ lease: { releaseGraceMs: GRACE_MS } });
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(await r.invoke(CHANNELS.TERMINAL_SPAWN, first.shown, spawnRequest(r, "t1")));
      // The laptop takes control while the Shell drives.
      const laptop = await otherInstall(r);
      laptop.open("laptop-view", "proj-1");
      data(
        await laptop.call("laptop-view", CHANNELS.DRIVE_LEASE_TAKE_OVER, { projectId: "proj-1" })
      );
      expect(holderName("proj-1")).toBe(LAPTOP);
      data(await laptop.spawn("laptop-view", spawnRequest(r, "laptop-1")));

      await quitShell(r);
      await r.startShell();
      const restored = await restoreWindow("proj-1");
      const view = restored.shown;
      // Watching: the project reads and streams, and changes are refused with who has it.
      expect(
        data<TerminalReconnectResult>(await r.invoke(CHANNELS.TERMINAL_RECONNECT, view, "laptop-1"))
      ).toMatchObject({ exists: true, id: "laptop-1" });
      await r.openStreams(view);
      r.pty.emit("laptop-1", "from-the-laptop;");
      await waitUntil(() => view.text("laptop-1") === "from-the-laptop;", "the laptop's output");
      const refused = { code: "DRIVEN_ELSEWHERE", userMessage: expect.stringContaining(LAPTOP) };
      expect(
        refusal(await r.invoke(CHANNELS.TERMINAL_SPAWN, view, spawnRequest(r, "t2")))
      ).toMatchObject(refused);

      // The laptop quits: its project stays reserved for it through its grace.
      const quitAt = Date.now();
      await laptop.quit();
      await waitUntil(
        () => getDriveLeaseService().getDriveTarget("proj-1").kind === "reserved",
        "the laptop's reservation"
      );
      expect(holderName("proj-1")).toBe(LAPTOP);
      expect(
        refusal(await r.invoke(CHANNELS.TERMINAL_SPAWN, view, spawnRequest(r, "t3")))
      ).toMatchObject(refused);
      expect(Date.now() - quitAt).toBeLessThan(GRACE_MS);

      // Once it is out, the lease passes to the restored view on its own.
      const shell = r.shellIdentity().client.clientId;
      await waitUntil(
        () => getDriveLeaseService().getHolder("proj-1")?.clientId === shell,
        "the lease to pass to the restored view",
        GRACE_MS * 3
      );
      expect(
        refusal(await r.invoke(CHANNELS.TERMINAL_SPAWN, view, spawnRequest(r, "t4")))
      ).toBeNull();
      expect(spawns.map((spawn) => spawn.request.id)).toEqual(["t1", "laptop-1", "t4"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "host restart: the relaunched install takes its restored reservation back at once, while another install is refused it",
    async () => {
      const { r } = await harness();
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(await r.invoke(CHANNELS.TERMINAL_SPAWN, first.shown, spawnRequest(r, "t1")));
      const before = r.shellIdentity().client;
      await quitShell(r);
      // Before the restart, so the restored grace can't have run out by any check below.
      const restartAt = Date.now();
      await r.restartHost(() => r.pty.terminals.clear());
      expect(getDriveLeaseService().getDriveTarget("proj-1")).toMatchObject({
        kind: "reserved",
        holder: { clientId: before.clientId },
      });

      const laptop = await otherInstall(r);
      laptop.open("laptop-view", "proj-1");
      const refusedForShell = {
        code: "DRIVEN_ELSEWHERE",
        userMessage: expect.stringContaining(before.clientName),
      };
      expect(refusal(await laptop.spawn("laptop-view", spawnRequest(r, "laptop-1")))).toMatchObject(
        refusedForShell
      );

      await r.startShell();
      const restored = await restoreWindow("proj-1");
      expect(getDriveLeaseService().getDriveTarget("proj-1")).toMatchObject({
        kind: "reserved",
        holder: { clientId: before.clientId },
      });
      await r.openStreams(restored.shown);
      const spawned = await r.invoke(
        CHANNELS.TERMINAL_SPAWN,
        restored.shown,
        spawnRequest(r, "t-relaunched")
      );
      expect(refusal(spawned)).toBeNull();
      expect(Date.now() - restartAt).toBeLessThan(DEFAULT_RESTORED_RESERVATION_GRACE_MS);
      expect(getDriveLeaseService().getHolder("proj-1")).toMatchObject({
        clientId: r.shellIdentity().client.clientId,
      });
      expect(refusal(await laptop.spawn("laptop-view", spawnRequest(r, "laptop-2")))).toMatchObject(
        refusedForShell
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "host restart: a restored reservation nobody comes back for passes to another install once its grace is out",
    async () => {
      const { r } = await harness({ lease: { restoredReservationGraceMs: GRACE_MS } });
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(await r.invoke(CHANNELS.TERMINAL_SPAWN, first.shown, spawnRequest(r, "t1")));
      const before = r.shellIdentity().client;
      await quitShell(r);
      const restartAt = Date.now();
      await r.restartHost(() => r.pty.terminals.clear());

      const laptop = await otherInstall(r);
      laptop.open("laptop-view", "proj-1");
      expect(refusal(await laptop.spawn("laptop-view", spawnRequest(r, "laptop-1")))).toMatchObject(
        {
          code: "DRIVEN_ELSEWHERE",
          userMessage: expect.stringContaining(before.clientName),
        }
      );
      expect(Date.now() - restartAt).toBeLessThan(GRACE_MS);

      await waitUntil(() => holderName("proj-1") === LAPTOP, "the laptop to drive", GRACE_MS * 3);
      expect(refusal(await laptop.spawn("laptop-view", spawnRequest(r, "laptop-2")))).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});

describe("agent and assistant panes across a restart (integration harness)", () => {
  it(
    "Shell relaunch: a running agent's pane finds its terminal still on the host, on the same conversation",
    async () => {
      const { r } = await harness();
      const agent = r.pty.spawn("agent-1", "proj-1", {
        launchAgentId: "claude",
        agentSessionId: "sess-claude",
      });
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      await quitShell(r);
      r.pty.emit("agent-1", "worked-while-away;");

      await r.startShell();
      const restored = await restoreWindow("proj-1");
      const found = data<TerminalReconnectResult>(
        await r.invoke(CHANNELS.TERMINAL_RECONNECT, restored.shown, "agent-1")
      );
      expect(found).toMatchObject({
        exists: true,
        id: "agent-1",
        projectId: "proj-1",
        launchAgentId: "claude",
        agentSessionId: "sess-claude",
      });
      const painted = data<SerializedTerminalSnapshot>(
        await r.invoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, restored.shown, "agent-1")
      );
      expect(painted.data).toBe("worked-while-away;");
      await r.openStreams(restored.shown);
      r.pty.emit("agent-1", "still-going;");
      await waitUntil(
        () => restored.shown.text("agent-1").endsWith("still-going;"),
        "the agent's live output"
      );
      expect(r.pty.terminals.get("agent-1")).toBe(agent);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "host restart: the session its shutdown captured is what the relaunched pane reads through its new endpoint, and its respawn carries it to the host",
    async () => {
      const { r, spawns } = await harness();
      cleanups.push(registerTerminalLayoutHandlers({} as HandlerDependencies));
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      const agent = { launchAgentId: "claude" };
      data(
        await r.invoke(
          CHANNELS.TERMINAL_SPAWN,
          first.shown,
          spawnRequest(r, "agent-1", "proj-1", agent)
        )
      );
      // The renderer's save of its layout, over the link.
      const pane: TerminalSnapshot = {
        id: "agent-1",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: r.projects.get("proj-1")!.path,
        location: "grid",
      } as TerminalSnapshot;
      data(
        await r.invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.setTerminals, first.shown, {
          projectId: "proj-1",
          terminals: [pane],
        })
      );
      await quitShell(r);

      await r.restartHost(async () => {
        // What the host's graceful shutdown leaves: the agent's session
        // written onto its saved pane, and its process gone with the pty-host.
        await memoryProjectStore.enqueueProjectStateUpdate("proj-1", (existing) => {
          const state = existing as ProjectState;
          return {
            ...state,
            terminals: state.terminals.map((saved) =>
              saved.id === "agent-1" ? { ...saved, agentSessionId: "sess-claude" } : saved
            ),
          };
        });
        r.pty.terminals.clear();
      });
      await r.startShell();
      const restored = await restoreWindow("proj-1");
      const view = restored.shown;

      expect(
        data<TerminalReconnectResult>(await r.invoke(CHANNELS.TERMINAL_RECONNECT, view, "agent-1"))
      ).toMatchObject({ exists: false });
      const saved = data<TerminalSnapshot[]>(
        await r.invoke(TERMINAL_LAYOUT_METHOD_CHANNELS.getTerminals, view, "proj-1")
      );
      expect(saved).toEqual([
        expect.objectContaining({
          id: "agent-1",
          launchAgentId: "claude",
          agentSessionId: "sess-claude",
        }),
      ]);

      // The respawn the restore builds from it goes through at once, under the
      // install's restored reservation, and reaches the host with its session.
      const respawn = await r.invoke(
        CHANNELS.TERMINAL_SPAWN,
        view,
        spawnRequest(r, "agent-1", "proj-1", { ...agent, agentSessionId: saved[0]!.agentSessionId })
      );
      expect(refusal(respawn)).toBeNull();
      expect(spawns.at(-1)).toMatchObject({
        request: { id: "agent-1", launchAgentId: "claude", agentSessionId: "sess-claude" },
        ctx: { endpoint: { kind: "remote-view", linkSessionId: r.shellIdentity().sessionId } },
      });
      expect(r.pty.terminals.get("agent-1")?.agentSessionId).toBe("sess-claude");
    },
    TEST_TIMEOUT_MS
  );

  it.each(["quit", "crash"] as const)(
    "%s and relaunch: the window's running assistant leaves the old endpoint and is taken over by the restored one, on the same session",
    async (how) => {
      const { r } = await harness();
      cleanups.push(registerHelpHandlers());
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      const [before] = getEndpointRegistry().getRemote();
      data(
        await r.invoke(CHANNELS.HELP_PROVISION_SESSION, first.shown, {
          projectId: "proj-1",
          projectPath: r.projects.get("proj-1")!.path,
          agentId: "claude",
        })
      );
      expect(assistants.state.lanes).toEqual([
        { sessionId: "help-1", projectId: "proj-1", slot: 0, handle: before!.handle },
      ]);

      await quitShell(r, how);
      // A quit ends the session and its view at once; a crash parks them, and
      // the assistant stays pinned until the session ends.
      expect(assistants.state.detachedFrom).toEqual(how === "quit" ? [before!.handle] : []);

      await r.startShell();
      const restored = await restoreWindow("proj-1");
      await r.openStreams(restored.shown);
      const after = getEndpointRegistry()
        .getRemote()
        .find((endpoint) => endpoint.linkSessionId === r.shellIdentity().sessionId)!;
      await waitUntil(
        () => assistants.state.adopted.length === 1,
        "the restored view to take over the assistant"
      );
      expect(assistants.state.detachedFrom).toEqual([before!.handle]);
      expect(assistants.state.adopted).toEqual([{ sessionId: "help-1", handle: after.handle }]);
      expect(after.handle).not.toBe(before!.handle);
      expect(assistants.state.provisioned).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "host restart: the assistant's saved conversation is offered to the relaunched window's view for its own project, and only the view that drives may claim it",
    async () => {
      const { r } = await harness();
      const offHelp = registerHelpHandlers();
      const first = await restoreWindow("proj-1");
      await r.openStreams(first.shown);
      data(
        await r.invoke(CHANNELS.HELP_PROVISION_SESSION, first.shown, {
          projectId: "proj-1",
          projectPath: r.projects.get("proj-1")!.path,
          agentId: "claude",
        })
      );
      await quitShell(r);

      await r.restartHost(() => {
        // The assistant went with the host's app; what comes back is its
        // conversation, saved for the lane, and handlers registered afresh.
        offHelp();
        assistants.state.lanes = [];
        assistants.state.saved.set("proj-1:0", {
          agentId: "claude",
          agentSessionId: "conv-claude",
          cwd: "/host/userData/help-sessions/abc",
        });
      });
      cleanups.push(registerHelpHandlers());
      // Another install watching the project can't take the conversation.
      const laptop = await otherInstall(r);
      laptop.open("laptop-view", "proj-1");
      expect(
        refusal(
          await laptop.call("laptop-view", HELP_METHOD_CHANNELS.takePendingHibernation, "proj-1", 0)
        )
      ).toMatchObject({ code: "DRIVEN_ELSEWHERE" });

      await r.startShell();
      const restored = await restoreWindow("proj-1");
      const view = restored.shown;
      await r.openStreams(view);
      const endpoint = getEndpointRegistry()
        .getRemote()
        .find((candidate) => candidate.linkSessionId === r.shellIdentity().sessionId)!;
      expect(
        data(await r.invoke(HELP_METHOD_CHANNELS.peekPendingHibernation, view, "proj-1", 0))
      ).toEqual({
        agentId: "claude",
        agentSessionId: "conv-claude",
        cwd: "/host/userData/help-sessions/abc",
        panelWasOpen: false,
      });
      // Another project's is never read for this view.
      expect(
        data(await r.invoke(HELP_METHOD_CHANNELS.peekPendingHibernation, view, "proj-2", 0))
      ).toBeNull();
      expect(assistants.state.peeks).toEqual([
        { projectId: "proj-1", slot: 0, viewHandle: endpoint.handle },
      ]);

      expect(
        data(await r.invoke(HELP_METHOD_CHANNELS.takePendingHibernation, view, "proj-1", 0))
      ).toMatchObject({ agentSessionId: "conv-claude", claimId: "claim-1" });
      expect(assistants.state.claims).toEqual([
        { projectId: "proj-1", slot: 0, owner: endpoint.handle, claimId: "claim-1" },
      ]);
      // Nothing was running to take over: the conversation is resumed, not adopted.
      expect(assistants.state.adopted).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});
