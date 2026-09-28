import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

// The Shell half of a hydrate reads GPU, crash-loop and database state this
// process doesn't have; the split that merges it with the host's is real.
vi.mock("../../ipc/handlers/app/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/handlers/app/state.js")>()),
  readShellHydrateFields: () => ({ safeMode: false, crashCount: 0, shellOnly: "from-the-shell" }),
}));

vi.mock("../../services/PluginService.js", async () => ({
  pluginService: (await import("./harness/fakePluginService.js")).fakePluginService,
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: () => null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
    // Every view in the harness is remote-bound: none is a local app view.
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
import type { PluginUiPromptRequest } from "../../../shared/types/pluginUiPrompt.js";
import type {
  MaterializeFn,
  MaterializeSource,
  OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import type { RemoteHostsEvent } from "../../../shared/types/ipc/remoteHosts.js";
import type { PluginIpcContext } from "../../../shared/types/plugin.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { registerPluginHandlers } from "../../ipc/handlers/plugin.js";
import type { IpcContext } from "../../ipc/types.js";
import {
  broadcastToProjectRenderers,
  broadcastToRenderer,
  typedHandleWithContext,
} from "../../ipc/utils.js";
import { createRendererBridge } from "../../services/mcp-server/rendererBridge.js";
import { getOperationRegistry } from "../../services/operations/index.js";
import { PluginUIPromptDispatcher } from "../../services/plugin/PluginUIPromptDispatcher.js";
import {
  registerDaintreeFileProtocol,
  registerDaintreeMediaProtocol,
} from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import { requireRemoteService } from "../runtime.js";
import { getClientTerminalRelay } from "../terminal/clientAttach.js";
import { protocolHandlers } from "./harness/fakeElectron.js";
import { pluginHandlers, resetFakePlugins } from "./harness/fakePluginService.js";
import type { FakeView, PortMessage } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW_A = 11; // studio-01:proj-1
const VIEW_B = 12; // studio-01:proj-2, or a second view of proj-1
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

async function harness() {
  h = await startRemoteHarness();
  await h.connect();
  return h;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  resetFakePlugins();
});

/** What the preload's unwrapping invoke does with an envelope. */
function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  // The preload encodes the code into the message so it survives contextBridge.
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

function errorCode(envelope: IpcEnvelope): string | null {
  return envelope.ok ? null : (envelope.error.code ?? null);
}

function decode(message: PortMessage): string {
  return new TextDecoder().decode(message.data as Uint8Array);
}

function eventsOn(view: FakeView, channel: string): unknown[][] {
  return view.events.filter((event) => event.channel === channel).map((event) => event.args);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe("Remote Hosts end to end over a real socket, started by the real boot", () => {
  it(
    "boot: Host mode listens on the injected socket, advertises through the owned spawner, and the Shell reaches it",
    async () => {
      const r = await harness();
      expect(r.server().isListening).toBe(true);
      expect(r.isConnected()).toBe(true);
      const status = await requireRemoteService("hostMode").getStatus();
      expect(status).toMatchObject({
        listening: true,
        socketPath: path.join(r.dir, "host", "host.sock"),
      });
      expect(status.attachedClients).toHaveLength(1);
      // mDNS went through the process spawner the harness owns, never the network.
      expect(harnessState.spawned).toHaveLength(1);
      expect(harnessState.spawned[0]!.killed).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "hydrate: a remote view's app:hydrate goes through the real split; host-owned fields come from the host, device fields from this machine",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      harnessState.store.set("appState", {
        sidebarWidth: 320,
        activeWorktreeId: "wt-shell",
        terminals: [],
      });
      harnessState.store.set("terminalConfig", { fontSize: 14, scrollbackLines: 1000 });
      const hostCalls: IpcContext[] = [];
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.APP_HYDRATE as never,
          ((ctx: IpcContext) => {
            hostCalls.push(ctx);
            return {
              appState: { sidebarWidth: 999, activeWorktreeId: "wt-host", terminals: [] },
              terminalConfig: { fontSize: 30, scrollbackLines: 5000 },
              hostPlatform: "linux",
              hostHomeDir: "/home/greg",
              hostTmpDir: "/tmp",
              project: { id: ctx.projectId },
            };
          }) as never
        )
      );

      const hydrate = unwrap<Record<string, unknown>>(
        await r.invoke(CHANNELS.APP_HYDRATE, view, {})
      );

      // Only the host leg ran, on the host, for the view's endpoint.
      expect(hostCalls).toHaveLength(1);
      expect(hostCalls[0]!.endpoint.kind).toBe("remote-view");
      expect(hostCalls[0]!.projectId).toBe("proj-1");
      expect(hostCalls[0]!.webContentsId).toBeLessThan(0);
      expect(hostCalls[0]!.client).toMatchObject({ kind: "remote" });
      expect(hydrate).toMatchObject({
        hostPlatform: "linux",
        hostHomeDir: "/home/greg",
        project: { id: "proj-1" },
        shellOnly: "from-the-shell",
        appState: { sidebarWidth: 320, activeWorktreeId: "wt-host" },
        terminalConfig: { fontSize: 14, scrollbackLines: 5000 },
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "invoke: a typed host handler round-trips its envelope, and an AppError keeps its details",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.WORKTREE_GET_ALL as never,
          ((ctx: IpcContext, payload?: { fail?: boolean }) => {
            if (payload?.fail) {
              throw new AppError({
                code: "PLUGIN_NOT_ON_HOST",
                message: "plugin missing at /Users/greg/secret",
                context: { path: "/Users/greg/secret" },
                details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme", hostId: HOST_ID },
              });
            }
            return [
              {
                id: "wt-main",
                path: `/srv/${ctx.projectId}`,
                branch: "main",
                isMainWorktree: true,
              },
            ];
          }) as never
        )
      );

      const ok = await r.invoke(CHANNELS.WORKTREE_GET_ALL, view);
      expect(ok).toEqual(
        wrapSuccess([{ id: "wt-main", path: "/srv/proj-1", branch: "main", isMainWorktree: true }])
      );

      const failed = await r.invoke(CHANNELS.WORKTREE_GET_ALL, view, { fail: true });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      const error = failed.error as typeof failed.error & { details?: unknown };
      expect(error.code).toBe("PLUGIN_NOT_ON_HOST");
      expect(error.details).toEqual({
        code: "PLUGIN_NOT_ON_HOST",
        pluginId: "acme",
        hostId: HOST_ID,
      });
      expect(JSON.stringify(error)).not.toContain("/Users/greg/secret");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "events: a project broadcast reaches only the bound view; a global broadcast reaches it too",
    async () => {
      const r = await harness();
      const a = r.addView(VIEW_A, "proj-1");
      const b = r.addView(VIEW_B, "proj-2");
      await r.openStreams(a);
      await r.openStreams(b);
      const channel = CHANNELS.OPERATIONS_EVENT;

      broadcastToProjectRenderers("proj-1", channel, { type: "scoped" });
      broadcastToRenderer(channel, { type: "global" });

      await waitUntil(() => eventsOn(a, channel).length === 2, "view A's events");
      await waitUntil(() => eventsOn(b, channel).length === 1, "view B's event");
      // One session carries both views' events in order, so a misrouted
      // scoped event would have reached B before the global one.
      expect(eventsOn(a, channel)).toEqual([[{ type: "scoped" }], [{ type: "global" }]]);
      expect(eventsOn(b, channel)).toEqual([[{ type: "global" }]]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "terminal I/O: input reaches the pty, output reaches the renderer port unchanged, acks flow back",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      view.write("t1", "ls -la\r");
      await waitUntil(() => r.pty.terminals.get("t1")!.writes.length === 1, "the write at the pty");
      expect(r.pty.terminals.get("t1")!.writes).toEqual(["ls -la\r"]);

      view.autoAck = false;
      const sent = r.pty.emit("t1", "hello ") + r.pty.emit("t1", "wörld");
      await waitUntil(() => view.dataFrames("t1").length === 2, "two output frames");
      for (const frame of view.dataFrames("t1")) {
        expect(Object.keys(frame).sort()).toEqual(["bytes", "data", "id", "type"]);
        expect(frame.data).toBeInstanceOf(Uint8Array);
        expect(frame.bytes).toBe((frame.data as Uint8Array).byteLength);
      }
      expect(view.text("t1")).toBe("hello wörld");
      // Nothing has acked yet: the pty-host still counts the output against the port.
      expect(r.pty.unacked("t1")).toBe(sent);

      for (const frame of view.dataFrames("t1")) view.ack("t1", frame.bytes as number);
      await waitUntil(() => r.pty.unacked("t1") === 0, "the renderer's acks at the pty");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "resize: the driving view's resize reaches its pty and never a foreign project's",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      r.pty.spawn("t-foreign", "proj-2");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      view.resize("t-foreign", 200, 60);
      view.resize("t1", 132, 43);
      await waitUntil(() => r.pty.terminals.get("t1")!.resizes.length === 1, "the resize");

      expect(r.pty.terminals.get("t1")).toMatchObject({ cols: 132, rows: 43 });
      // Same port, sent first: had it been forwarded it would already be there.
      expect(r.pty.terminals.get("t-foreign")!.resizes).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "resize lease: a view that doesn't drive the project is ignored until it takes over, then the old driver is",
    async () => {
      const r = await harness();
      const terminal = r.pty.spawn("t1", "proj-1");
      const a = r.addView(VIEW_A, "proj-1");
      await r.openStreams(a);
      const b = r.addView(VIEW_B, "proj-1");
      await r.openStreams(b);
      const leaseOf = async (view: FakeView) =>
        unwrap<{ isHolderEndpoint: boolean; holder: { leaseId: number } | null }>(
          await r.invoke(CHANNELS.DRIVE_LEASE_GET, view, { projectId: "proj-1" })
        );
      expect((await leaseOf(a)).isHolderEndpoint).toBe(true);
      expect((await leaseOf(b)).isHolderEndpoint).toBe(false);

      // The non-holder's resize goes first on the same link, so had it been
      // applied it would be at the pty before the holder's.
      b.resize("t1", 100, 30);
      a.resize("t1", 120, 40);
      await waitUntil(() => terminal.resizes.length === 1, "the holder's resize");
      expect(terminal.resizes).toEqual([{ cols: 120, rows: 40 }]);

      const before = (await leaseOf(a)).holder!.leaseId;
      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, b, { projectId: "proj-1" }));
      const after = await leaseOf(b);
      expect(after.isHolderEndpoint).toBe(true);
      expect(after.holder!.leaseId).toBeGreaterThan(before);
      await waitUntil(
        () =>
          eventsOn(a, CHANNELS.DRIVE_LEASE_EVENT).some(
            ([event]) =>
              (event as { state: { isHolderEndpoint: boolean } }).state.isHolderEndpoint === false
          ),
        "the old driver to hear it was taken over"
      );

      a.resize("t1", 90, 20);
      b.resize("t1", 132, 43);
      await waitUntil(() => terminal.resizes.length === 2, "the new holder's resize");
      expect(terminal.resizes).toEqual([
        { cols: 120, rows: 40 },
        { cols: 132, rows: 43 },
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "worktree port: requests and replies cross the link to the project's workspace host, a foreign path is refused on the host, and events reach the view",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      const workspace = r.workspaceHosts.get("proj-1")!;
      await waitUntil(
        () => view.hasWorktreePort && workspace.portCount === 1,
        "the relayed worktree port at both ends"
      );

      const reply = await view.worktreeRequest("req-1", "get-all-states", {});
      expect(reply).toMatchObject({
        id: "req-1",
        result: { states: [{ path: r.projects.get("proj-1")!.path }], epoch: "epoch-1" },
      });

      // Validated on the host against this endpoint's project; it never reaches the workspace host.
      const refused = await view.worktreeRequest("req-2", "list-branches", { rootPath: "/etc" });
      expect(refused).toEqual({ id: "req-2", error: "Path is outside this project" });
      expect(workspace.requests.map((request) => request.id)).toEqual(["req-1"]);

      workspace.emit({ type: "worktree-removed", worktreeId: "wt-gone" });
      await waitUntil(
        () => view.worktreeMessages.some((message) => message.type === "event"),
        "the pushed worktree event"
      );
      expect(view.worktreeMessages.filter((message) => message.type === "event")).toEqual([
        { type: "event", event: { type: "worktree-removed", worktreeId: "wt-gone" } },
      ]);
      // The other project's workspace host was never connected to this view.
      expect(r.workspaceHosts.get("proj-2")!.portCount).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "host file preview: a host-scoped URL with the view's capability streams the host's file, and honours a Range",
    async () => {
      const r = await harness();
      registerDaintreeFileProtocol();
      registerDaintreeMediaProtocol();
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      const root = r.projects.get("proj-1")!.path;
      const filePath = path.join(root, "notes.txt");
      await fs.writeFile(filePath, "0123456789abcdefghij");
      const clip = crypto.randomBytes(256 * 1024);
      const clipPath = path.join(root, "clip.mp4");
      await fs.writeFile(clipPath, clip);
      const capability = unwrap<string>(
        await r.invoke(CHANNELS.FILE_TRANSFER_GET_PREVIEW_CAPABILITY, view)
      );
      expect(capability).toMatch(/^[0-9a-f]{32}$/);
      const handler = protocolHandlers.get("daintree-file")!;
      const query = (file: string) =>
        `path=${encodeURIComponent(file)}&root=${encodeURIComponent(root)}`;
      const urlFor = (cap: string, file: string) =>
        `daintree-file://host/${HOST_ID}/${cap}/load?${query(file)}`;

      const whole = await handler(new Request(urlFor(capability, filePath)));
      expect(whole.status).toBe(200);
      expect(await whole.text()).toBe("0123456789abcdefghij");

      // A seek in a video: the host's media handler answers the range, and
      // only that slice crosses the link.
      const media = protocolHandlers.get("daintree-media")!;
      const ranged = await media(
        new Request(`daintree-media://host/${HOST_ID}/${capability}/load/?${query(clipPath)}`, {
          headers: { Range: "bytes=1000-66535" },
        })
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(`bytes 1000-66535/${clip.byteLength}`);
      const slice = new Uint8Array(await ranged.arrayBuffer());
      expect(slice.byteLength).toBe(65536);
      expect(sha256(slice)).toBe(sha256(clip.subarray(1000, 66536)));

      // Nobody else's capability, and nothing outside the project.
      const forged = await handler(new Request(urlFor("f".repeat(32), filePath)));
      expect(forged.status).toBe(403);
      await fs.writeFile(path.join(r.dir, "outside.txt"), "secret");
      const escaped = await handler(
        new Request(urlFor(capability, path.join(root, "..", "..", "outside.txt")))
      );
      expect(escaped.status).toBeGreaterThanOrEqual(400);
      expect(await escaped.text()).not.toContain("secret");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "upload: a dropped local file goes through materialize into the host inbox, verified by sha256, and the same file again is deduplicated",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      const localDir = path.join(r.dir, "shell-files");
      await fs.mkdir(localDir, { recursive: true });
      const localPath = path.join(localDir, "report.bin");
      const bytes = crypto.randomBytes(300 * 1024);
      await fs.writeFile(localPath, bytes);

      // The renderer's own remote materializer, its window.electron calls
      // answered by this view's IPC.
      const modulePath = "../../../src/services/remoteMaterializer.ts";
      const { createRemoteMaterializer } = (await import(/* @vite-ignore */ modulePath)) as {
        createRemoteMaterializer: (deps: Record<string, unknown>) => MaterializeFn;
      };
      const call =
        (channel: string) =>
        async (payload: unknown): Promise<unknown> =>
          unwrap(await r.invoke(channel, view, payload));
      const failures: unknown[] = [];
      let opCount = 0;
      const materialize = createRemoteMaterializer({
        hostId: HOST_ID,
        hostLabel: () => "studio",
        localLabel: "This Mac",
        fileTransfer: {
          statLocalFile: call(CHANNELS.FILE_TRANSFER_STAT_LOCAL_FILE),
          uploadLocalFile: call(CHANNELS.FILE_TRANSFER_UPLOAD_LOCAL_FILE),
          uploadBytes: call(CHANNELS.FILE_TRANSFER_UPLOAD_BYTES),
          cancel: call(CHANNELS.FILE_TRANSFER_CANCEL),
          onEvent: () => () => undefined,
        },
        saveClipboardImage: () => Promise.reject(new Error("no clipboard in the harness")),
        confirmLargeUpload: async () => true,
        confirmReplace: async () => false,
        reportFailure: (failure: unknown) => failures.push(failure),
        mintOperationId: () => `op-upload-${++opCount}`,
      });
      const source: MaterializeSource = { kind: "local-file", path: localPath };

      // A path the page names on its own is refused: only a file the preload
      // saw the person drop in this view is readable.
      await expect(materialize(source)).rejects.toThrow();
      failures.length = 0;

      r.send(CHANNELS.FILE_TRANSFER_GRANT_LOCAL_SOURCES, view, [localPath]);
      const first = await materialize(source);
      const inbox = path.join(r.hostTmpDir, "daintree-inbox", "files");
      expect(first.hostPath.startsWith(inbox + path.sep)).toBe(true);
      expect(path.basename(first.hostPath)).toBe("report.bin");
      expect(first.bytes).toBe(bytes.byteLength);
      const placed = await fs.readFile(first.hostPath);
      expect(sha256(placed)).toBe(sha256(bytes));
      expect((await fs.stat(first.hostPath)).mode & 0o777).toBe(0o600);

      const second = await materialize(source);
      expect(second.hostPath).toBe(first.hostPath);
      const folders = await fs.readdir(inbox);
      expect(folders).toHaveLength(1);
      expect(failures).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "plugins: a view's plugin:invoke runs on the host for its project, the plugin's push reaches only that project's view, and its prompt is answered by the driving view",
    async () => {
      const r = await harness();
      cleanups.push(registerPluginHandlers());
      const prompts = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const a = r.addView(VIEW_A, "proj-1");
      const b = r.addView(VIEW_B, "proj-2");
      await r.openStreams(a);
      await r.openStreams(b);
      const calls: PluginIpcContext[] = [];
      pluginHandlers.set("acme.graph:summarize", async (ctx, n) => {
        calls.push(ctx);
        broadcastToProjectRenderers(ctx.projectId!, "plugin:acme.graph:update", {
          panelId: null,
          payload: { n },
        });
        const proceed = await prompts.requestPrompt(
          "acme.graph",
          { kind: "confirm", options: { title: "Summarize?" } },
          ctx.projectId!
        );
        return { project: ctx.projectId, proceed };
      });

      const reply = r.invoke(CHANNELS.PLUGIN_INVOKE, a, "acme.graph", "summarize", 7);
      await waitUntil(
        () => eventsOn(a, CHANNELS.PLUGIN_UI_PROMPT_REQUEST).length === 1,
        "the prompt on the driving view"
      );
      const [request] = eventsOn(a, CHANNELS.PLUGIN_UI_PROMPT_REQUEST)[0] as [
        PluginUiPromptRequest,
      ];
      expect(request.params).toMatchObject({ kind: "confirm" });
      r.send(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, a, { promptId: request.promptId, result: true });

      expect(unwrap(await reply)).toEqual({ project: "proj-1", proceed: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        projectId: "proj-1",
        origin: { kind: "remote", clientId: expect.any(String) },
      });
      expect(calls[0]!.webContentsId).toBeLessThan(0);
      await waitUntil(
        () => eventsOn(a, "plugin:acme.graph:update").length === 1,
        "the plugin's push"
      );
      expect(eventsOn(a, "plugin:acme.graph:update")).toEqual([
        [{ panelId: null, payload: { n: 7 } }],
      ]);
      expect(eventsOn(b, "plugin:acme.graph:update")).toEqual([]);
      expect(eventsOn(b, CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "plugins: with no frontend attached a prompt fails NO_FRONTEND_ATTACHED instead of guessing an answer",
    async () => {
      const r = await harness();
      cleanups.push(registerPluginHandlers());
      const prompts = new PluginUIPromptDispatcher({ isDisposed: () => false });
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      await r.dropLink();

      await expect(
        prompts.requestPrompt(
          "acme.graph",
          { kind: "confirm", options: { title: "Anyone there?" } },
          "proj-1"
        )
      ).rejects.toThrow(/NO_FRONTEND_ATTACHED/);
      // A project no Shell ever opened has nobody to ask either.
      await expect(
        prompts.requestPrompt(
          "acme.graph",
          { kind: "confirm", options: { title: "Anyone there?" } },
          "proj-2"
        )
      ).rejects.toThrow(/NO_FRONTEND_ATTACHED/);
      expect(eventsOn(view, CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "viewless: with every renderer detached, MCP terminal.new runs on the host through the real handler path; a UI-only action says no frontend is attached",
    async () => {
      const r = await harness();
      const spawns: Array<{
        ctx: IpcContext;
        request: { id: string; projectId: string; cwd: string };
      }> = [];
      // Stands in for the pty-host spawn behind terminal:spawn (the harness has no pty-host).
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.TERMINAL_SPAWN as never,
          ((ctx: IpcContext, request: { id: string; projectId: string; cwd: string }) => {
            spawns.push({ ctx, request });
            r.pty.spawn(request.id, request.projectId);
            return request.id;
          }) as never
        )
      );
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);
      await r.dropLink();
      const bridge = createRendererBridge(new Map(), new Map(), () => null);

      const created = await bridge.dispatchActionForWorkspace("proj-2", "terminal.new", {});
      expect(created.result).toMatchObject({
        ok: true,
        result: { terminalId: expect.any(String) },
      });
      const terminalId = (created.result as { result: { terminalId: string } }).result.terminalId;
      expect(spawns).toHaveLength(1);
      expect(spawns[0]!.request).toMatchObject({
        id: terminalId,
        projectId: "proj-2",
        cwd: r.projects.get("proj-2")!.path,
      });
      // The host acted for itself: no Shell endpoint is behind the call.
      expect(spawns[0]!.ctx.endpoint).toMatchObject({ kind: "local-view", handle: 0 });
      expect(r.pty.terminals.get(terminalId)?.projectId).toBe("proj-2");
      expect(harnessState.projectStates.get("proj-2")).toMatchObject({
        terminals: [{ id: terminalId, kind: "terminal" }],
      });

      await expect(
        bridge.dispatchActionForWorkspace("proj-2", "worktree.openInEditor", {})
      ).rejects.toMatchObject({ frontendCode: "NO_FRONTEND_ATTACHED" });
      // The project whose driver just dropped is held for it, not run behind its back.
      await expect(
        bridge.dispatchActionForWorkspace("proj-1", "terminal.new", {})
      ).rejects.toThrow();
      expect(spawns).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "reconnect (transport): missed output replays exactly once in order; an overflowed ring sends one snapshot RESET frame",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      const { relay } = await r.openStreams(view);
      const expected: string[] = [];
      const say = (text: string) => {
        r.pty.emit("t1", text);
        expected.push(text);
      };

      for (let i = 0; i < 20; i++) say(`a${i};`);
      await waitUntil(() => view.text("t1") === expected.join(""), "the first output");

      // Drop mid-output: frames are in flight at every stage when the socket dies.
      for (let i = 0; i < 50; i++) say(`b${i};`);
      const dropping = r.dropLink();
      for (let i = 0; i < 50; i++) say(`c${i};`);
      await dropping;
      for (let i = 0; i < 200; i++) say(`d${i};`);
      // At least everything said while away is still owed to the renderer.
      expect(view.dataFrames("t1").length).toBeLessThanOrEqual(expected.length - 200);

      await r.restoreLink();
      say("END");
      await waitUntil(() => view.text("t1").endsWith("END"), "the output after the resume");

      expect(view.text("t1")).toBe(expected.join(""));
      expect(view.dataFrames("t1")).toHaveLength(expected.length);
      expect(view.resets("t1")).toEqual([]);
      expect(relay.position("t1")).toEqual({ incarnation: 0, lastSeq: expected.length });
      const painted = view.text("t1");

      // Now more than the ring holds while the Shell is away.
      await r.dropLink();
      const chunk = "x".repeat(64 * 1024 - 16);
      let frames = expected.length;
      for (let i = 0; i < 96; i++) {
        r.pty.emit("t1", `${String(i).padStart(6, "0")}|${chunk}\n`);
        frames++;
      }
      r.pty.emit("t1", "TAIL-OF-OVERFLOW");
      frames++;
      const bridge = r.bridges.get(relay.endpointId)!;
      await waitUntil(() => bridge.position("t1")?.seq === frames, "the host to ring the overflow");

      await r.restoreLink();
      await waitUntil(() => view.resets("t1").length === 1, "the snapshot reset");

      const [reset] = view.resets("t1");
      const terminal = r.pty.terminals.get("t1")!;
      expect(reset!.snapshot).toEqual({ data: terminal.transcript, cols: 80, rows: 24 });
      expect((reset!.snapshot as { data: string }).data.endsWith("TAIL-OF-OVERFLOW")).toBe(true);
      // Transport only: no data frame carried the overflowed range, so the
      // RESET frame is its sole carrier. FakeView records frames and paints
      // nothing; the xterm repaint is TerminalInstanceService.remoteReset.test.ts.
      expect(view.text("t1")).toBe(painted);

      r.pty.emit("t1", "live-again");
      await waitUntil(() => view.text("t1").endsWith("live-again"), "live output after the reset");
      expect(view.text("t1")).toBe(painted + "live-again");
      expect(relay.position("t1")).toEqual({ incarnation: 0, lastSeq: frames + 1 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "fresh session: after the host's listener restarts, the Shell's view gets a new endpoint, is told to resync, and its terminal resumes",
    async () => {
      const r = await harness();
      const terminal = r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      const { relay: before } = await r.openStreams(view);
      r.pty.emit("t1", "before;");
      await waitUntil(() => view.text("t1") === "before;", "output before the restart");
      const sessionBefore = r.clientSession();

      // Host mode off and on: the host forgets every session and endpoint, but
      // its PTYs (in the pty-host, as in the app) carry on.
      const hostMode = requireRemoteService("hostMode");
      await hostMode.stopListening();
      await waitUntil(() => !r.isConnected(), "the Shell to see the host go");
      r.pty.emit("t1", "while-away;");
      await hostMode.startListening();
      r.manager.get(HOST_ID)!.retryNow();
      await waitUntil(r.isConnected, "the Shell to reconnect");
      expect(r.clientSession()).not.toBe(sessionBefore);

      await waitUntil(() => r.streamsFlowing(view), "the terminal stream on the new session");
      // The Shell reopened the view's endpoint on the new session: the same
      // relay rides it, and the host bound a new endpoint for it.
      expect(getClientTerminalRelay(view.id)).toBe(before);
      await waitUntil(
        () =>
          eventsOn(view, CHANNELS.REMOTE_HOSTS_EVENT).some(
            ([event]) =>
              (event as RemoteHostsEvent).type === "resync-required" &&
              (event as { reason?: string }).reason === "reconnected"
          ),
        "the view to be told to resync"
      );

      // The new endpoint's stream never carried this terminal, so what the
      // view missed while the host was away arrives as one snapshot.
      await waitUntil(() => view.resets("t1").length === 1, "the snapshot reset");
      const snapshot = view.resets("t1")[0]!.snapshot as { data: string };
      expect(snapshot.data).toBe("before;while-away;");
      expect(view.text("t1")).toBe("before;");
      r.pty.emit("t1", "after;");
      await waitUntil(() => view.text("t1").endsWith("after;"), "live output after recovery");
      expect(view.text("t1")).toBe("before;after;");
      view.write("t1", "typed\r");
      await waitUntil(() => terminal.writes.includes("typed\r"), "input after recovery");
      expect(getEndpointRegistry().getRemote()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "operation outcome (transport): a clone whose reply was lost resolves to succeeded over the reconnected link",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      // A stand-in for the clone handler with the production registry shape;
      // counted so the retry claim rests on executions, not on bookkeeping.
      let handlerCalls = 0;
      let cloneRuns = 0;
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.PROJECT_CLONE_REPO as never,
          ((ctx: IpcContext, payload: { opId: string; url: string }) => {
            handlerCalls++;
            return getOperationRegistry().run(
              { opId: payload.opId, kind: "git-clone", projectId: ctx.projectId },
              async (op) => {
                cloneRuns++;
                op.progress({ fraction: 0.5, stage: "receiving", message: null });
                await finished;
                return { success: true, clonedPath: `/srv/${payload.url.split("/").pop()}` };
              }
            );
          }) as never
        )
      );

      const opId = `op-${crypto.randomUUID()}`;
      const reply = r.invoke(CHANNELS.PROJECT_CLONE_REPO, view, {
        opId,
        url: "https://example.com/acme/widgets",
      });
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "running",
        "the clone to start on the host"
      );

      await r.dropLink();
      const lost = await reply;
      expect(["HOST_DISCONNECTED", "OUTCOME_UNKNOWN"]).toContain(errorCode(lost));

      finish();
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "succeeded",
        "the clone to finish on the host"
      );

      // The renderer's own recovery path, fed by this view's link.
      const modulePath = "../../../src/utils/resolveUnknownOutcome.ts";
      const { resolveUnknownOutcome } = (await import(/* @vite-ignore */ modulePath)) as {
        resolveUnknownOutcome: (
          opId: string,
          options: Record<string, unknown>
        ) => Promise<OperationOutcome>;
      };
      const restored = r.restoreLink();
      const outcome = await resolveUnknownOutcome(opId, {
        waitForConnected: () => restored,
        pollIntervalMs: 20,
        settleTimeoutMs: 10_000,
        client: {
          getStatus: async (id: string) =>
            unwrap<OperationOutcome>(
              await r.invoke(CHANNELS.OPERATIONS_GET_STATUS, view, { opId: id })
            ),
          onEvent: () => () => undefined,
        },
      });

      expect(outcome).toEqual({
        status: "succeeded",
        result: { success: true, clonedPath: "/srv/widgets" },
        settledAt: expect.any(Number),
      });
      // The retry by opId lands on the same record rather than cloning twice.
      const again = await r.invoke(CHANNELS.PROJECT_CLONE_REPO, view, {
        opId,
        url: "https://example.com/acme/widgets",
      });
      expect(again).toEqual(wrapSuccess({ success: true, clonedPath: "/srv/widgets" }));
      expect(handlerCalls).toBe(2);
      expect(cloneRuns).toBe(1);
      expect(getEndpointRegistry().getRemote()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "latency: a keystroke's echo stays interactive under real uploads into the host inbox and an output flood",
    async () => {
      const r = await harness();
      r.pty.spawn("t-echo", "proj-1", { echo: true });
      r.pty.spawn("t-flood", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      const keystroke = async (key: string): Promise<number> => {
        const echoed = view.nextMessage(
          (m) => m.type === "data" && m.id === "t-echo" && decode(m).includes(key)
        );
        const started = performance.now();
        view.write("t-echo", key);
        await echoed;
        return performance.now() - started;
      };

      const idle: number[] = [];
      for (let i = 0; i < 50; i++) idle.push(await keystroke(`i${String(i).padStart(4, "0")}`));

      // Bulk: back-to-back 32 MiB dropped files uploaded through the Shell's
      // upload client into the host inbox, each with fresh content so none is
      // deduplicated.
      const payload = crypto.randomBytes(32 * 1024 * 1024);
      const dropDir = path.join(r.dir, "drops");
      await fs.mkdir(dropDir, { recursive: true });
      let bulkBytes = 0;
      let uploads = 0;
      let loaded = true;
      let flooding: ReturnType<typeof setImmediate> | null = null;
      const stopLoad = () => {
        loaded = false;
        if (flooding) clearImmediate(flooding);
      };
      cleanups.push(stopLoad);
      const bulk = (async () => {
        while (loaded) {
          crypto.randomFillSync(payload, 0, 32);
          const localPath = path.join(dropDir, `bulk-${uploads}.bin`);
          await fs.writeFile(localPath, payload);
          r.send(CHANNELS.FILE_TRANSFER_GRANT_LOCAL_SOURCES, view, [localPath]);
          const result = unwrap<{ bytes: number; deduplicated: boolean }>(
            await r.invoke(CHANNELS.FILE_TRANSFER_UPLOAD_LOCAL_FILE, view, {
              hostId: HOST_ID,
              localPath,
              destination: { kind: "inbox", bucket: "files" },
              opId: `op-bulk-${uploads}`,
            })
          );
          expect(result).toMatchObject({ bytes: payload.byteLength, deduplicated: false });
          bulkBytes += result.bytes;
          uploads++;
          await fs.rm(localPath);
        }
      })();

      // Flood: as fast as the pty-host's flow control lets it (512 KiB unacked).
      const floodChunk = "y".repeat(32 * 1024);
      let floodFramesSent = 0;
      const flood = () => {
        flooding = null;
        if (!loaded || !r.pty.connections.size) return;
        while (r.pty.unacked("t-flood") < 512 * 1024) {
          r.pty.emit("t-flood", floodChunk);
          floodFramesSent++;
        }
        flooding = setImmediate(flood);
      };
      flood();
      const transfers = () => r.clientSession().transfers.activeOutgoing;
      try {
        await waitUntil(
          () => view.dataFrames("t-flood").length > 64 && transfers() > 0,
          "the flood and an upload to be under way"
        );

        const floodBefore = view.dataFrames("t-flood").length;
        const loadedStarted = performance.now();
        const underLoad: number[] = [];
        let duringTransfer = 0;
        for (let i = 0; i < 200; i++) {
          underLoad.push(await keystroke(`k${String(i).padStart(4, "0")}`));
          if (transfers() > 0) duringTransfer++;
        }
        const loadedMs = performance.now() - loadedStarted;
        const floodDelivered = view.dataFrames("t-flood").length - floodBefore;
        stopLoad();
        await bulk;

        const sortedIdle = [...idle].sort((x, y) => x - y);
        const sorted = [...underLoad].sort((x, y) => x - y);
        const report = {
          idle: {
            p50: percentile(sortedIdle, 50),
            p95: percentile(sortedIdle, 95),
            max: sortedIdle.at(-1)!,
          },
          loaded: {
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            max: sorted.at(-1)!,
          },
          keystrokes: underLoad.length,
          duringTransfer,
          uploads,
          bulkMiBps: bulkBytes / 1024 / 1024 / (loadedMs / 1000),
          floodMiBps: (floodDelivered * floodChunk.length) / 1024 / 1024 / (loadedMs / 1000),
          floodFramesSent,
        };
        const line = `[remote-harness] keystroke RTT ms ${JSON.stringify(
          report,
          (_k, v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)
        )}`;
        console.info(line);
        // vitest.config drops console output; the integrator reads this line from the run.
        process.stdout.write(`${line}\n`);

        // The measurement only means something if the load was really there.
        expect(duringTransfer).toBeGreaterThan(underLoad.length / 2);
        expect(floodDelivered).toBeGreaterThan(0);
        expect(report.loaded.p95).toBeLessThan(50);
      } finally {
        stopLoad();
        // An upload that hangs must not hold the test's cleanup hostage.
        await Promise.race([
          bulk.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 30_000).unref()),
        ]);
      }
    },
    TEST_TIMEOUT_MS * 2
  );
});
