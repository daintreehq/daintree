import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-ssh-e2e",
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

// The one injection into the ssh path: every ssh the product spawns by
// default (the port forwards' `-O forward`/`-O cancel`) gets `-F <private config>`.
vi.mock("../client/sshTransport.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/sshTransport.js")>();
  const { routedSshSpawner } = await import("./harness/privateSshd.js");
  return { ...original, defaultSshSpawner: () => routedSshSpawner() };
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
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { IpcContext } from "../../ipc/types.js";
import {
  broadcastToProjectRenderers,
  broadcastToRenderer,
  typedHandleWithContext,
} from "../../ipc/utils.js";
import { isWebviewSrcAllowed } from "../../window/webviewSrcGate.js";
import { stopRemoteHosts } from "../boot.js";
import { probeHost } from "../client/hostProbe.js";
import { createSshCommandChannel } from "../client/remoteShell.js";
import {
  buildCatArgs,
  buildProbeArgs,
  controlPathFor,
  parseProbeOutput,
  SshTransport,
} from "../client/sshTransport.js";
import { parseDiscoveryInfo } from "../host/discoveryFile.js";
import { remoteHostSocketLocation, type HostSocketLocation } from "../host/hostSocketPath.js";
import { requireRemoteService } from "../runtime.js";
import { getClientTerminalRelay } from "../terminal/clientAttach.js";
import type { FakeView, PortMessage } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import {
  listProcesses,
  makeShortTempRoot,
  sshRouting,
  SSH_ALIAS,
  startPrivateSshd,
  type PrivateSshd,
} from "./harness/privateSshd.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const ENABLED = process.env.DAINTREE_SSH_E2E === "1";
const TEST_TIMEOUT_MS = 90_000;
const VIEW_A = 21; // studio-01:proj-1
const VIEW_B = 22; // studio-01:proj-2

let root: string | null = null;
let sshd: PrivateSshd | null = null;
let h: RemoteHarness | null = null;
let location: HostSocketLocation;
let clientDir: string;
let controlPath: string;
let viewA: FakeView;
let viewB: FakeView;
let devServer: http.Server | null = null;
let devPort = 0;
let rttReport: Record<string, number> | null = null;

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

function eventsOn(view: FakeView, channel: string): unknown[][] {
  return view.events.filter((event) => event.channel === channel).map((event) => event.args);
}

function decode(message: PortMessage): string {
  return new TextDecoder().decode(message.data as Uint8Array);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function report(line: string): void {
  // vitest.config drops console output; the integrator reads this line from the run.
  process.stdout.write(`[ssh-e2e] ${line}\n`);
}

/** The ControlMaster's pid, from the master itself (`ssh -O check`), or null when none answers. */
async function masterPid(): Promise<number | null> {
  const result = await sshd!.runSsh(["-o", `ControlPath=${controlPath}`, "-O", "check", SSH_ALIAS]);
  if (result.code !== 0) return null;
  const match = /pid=(\d+)/.exec(result.stderr + result.stdout);
  return match ? Number(match[1]) : null;
}

/** ssh processes this run started, found by the run's directory in their command line. */
async function testSshProcesses() {
  return (await listProcesses()).filter(
    (row) => row.command.includes(root!) && row.pid !== sshd?.pid && !/\bps\b/.test(row.command)
  );
}

/** Pids listening on a local TCP port, by `lsof`. */
function listenersOn(port: number): Promise<number[]> {
  return new Promise((resolve) =>
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], (_err, stdout) =>
      resolve(
        stdout
          .split("\n")
          .filter((line) => line.startsWith("p"))
          .map((line) => Number(line.slice(1)))
      )
    )
  );
}

/** One GET on a fresh connection; the error code when nothing answers. */
function get(port: number): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/hello", agent: false, headers: { Connection: "close" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    request.setTimeout(5_000, () => request.destroy(new Error("ETIMEDOUT")));
    request.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ error: err.code ?? err.message })
    );
  });
}

async function localForwardSockets(): Promise<string[]> {
  const names = await fs.readdir(clientDir).catch(() => [] as string[]);
  return names.filter((name) => /^l-.*\.sock$/.test(name));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killEverything(): Promise<void> {
  if (!root) return;
  for (const row of await listProcesses().catch(() => [])) {
    if (row.command.includes(root) && row.pid !== process.pid) {
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

describe.skipIf(!ENABLED)(
  "Remote Hosts over the real ssh transport and a private sshd (skipped unless DAINTREE_SSH_E2E=1)",
  () => {
    beforeAll(async () => {
      root = await makeShortTempRoot();
      // A failure to start sshd fails the suite: with the flag set nothing may skip.
      sshd = await startPrivateSshd(root);
      sshRouting.configPath = sshd.configPath;
      sshRouting.blocked = false;
      // Where the real client looks on this host: under the session's HOME on
      // macOS, the uid's runtime dir (in a directory of its own) on Linux.
      const linuxDirName = `daintree-e2e-${path.basename(root)}`;
      location = remoteHostSocketLocation({
        platform: process.platform === "linux" ? "linux" : "darwin",
        uid: process.getuid!(),
        home: sshd.home,
        linuxDirName,
      });
      const spawnSsh = sshd.spawnSsh;
      h = await startRemoteHarness({
        rootDir: root,
        hostLocation: location,
        sshTarget: SSH_ALIAS,
        createTransport: (dir) => {
          clientDir = dir;
          return new SshTransport({
            target: SSH_ALIAS,
            clientDir: dir,
            spawn: spawnSsh,
            linuxDirName,
          });
        },
      });
      controlPath = controlPathFor(clientDir, SSH_ALIAS);
      h.pty.spawn("t1", "proj-1");
      h.pty.spawn("t-echo", "proj-1", { echo: true });
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      sshRouting.blocked = false;
      await new Promise<void>((resolve) =>
        devServer ? devServer.close(() => resolve()) : resolve()
      );
      await h?.dispose().catch(() => {});
      h = null;
      if (sshd && controlPath) {
        await sshd.runSsh(["-o", `ControlPath=${controlPath}`, "-O", "exit", SSH_ALIAS], 5_000);
      }
      await sshd?.stop();
      await killEverything();
      sshRouting.configPath = null;
      if (root) {
        if (location && process.platform === "linux") {
          await fs.rm(location.dir, { recursive: true, force: true });
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }, TEST_TIMEOUT_MS);

    it(
      "1. probe through ssh: platform, uid and the session's HOME, and the host's discovery file",
      async () => {
        const probe = await sshd!.runSsh(buildProbeArgs(SSH_ALIAS, controlPath));
        expect(probe.code, probe.stderr).toBe(0);
        const remote = parseProbeOutput(probe.stdout);
        expect(remote).toEqual({
          platform: process.platform === "linux" ? "linux" : "darwin",
          uid: process.getuid!(),
          home: sshd!.home,
        });
        // The client derives the location the Host published to.
        expect(
          remoteHostSocketLocation({ ...remote!, linuxDirName: path.basename(location.dir) })
        ).toEqual(location);

        const cat = await sshd!.runSsh(
          buildCatArgs(SSH_ALIAS, controlPath, location.discoveryPath)
        );
        expect(cat.code, cat.stderr).toBe(0);
        const info = parseDiscoveryInfo(cat.stdout);
        expect(info).toMatchObject({
          version: 1,
          socketPath: location.socketPath,
          pid: process.pid,
        });
        expect(info!.token).toMatch(/^[0-9a-f]{64}$/);

        // The setup probe over the same master (macOS: it looks under $HOME).
        if (process.platform === "darwin") {
          const shell = createSshCommandChannel({
            target: SSH_ALIAS,
            controlPath,
            run: sshd!.runCommand,
          });
          const { result } = await probeHost({
            sshTarget: SSH_ALIAS,
            shell,
            client: { version: "0.0.0-harness", commit: "none" },
          });
          expect(result).toMatchObject({
            reachable: true,
            platform: "darwin",
            hostModeListening: true,
          });
        }
        expect(await masterPid()).not.toBeNull();
      },
      TEST_TIMEOUT_MS
    );

    it(
      "2. connect: ControlMaster plus -O forward -L to the host socket; handshake, hydrate, a typed invoke and events",
      async () => {
        const r = h!;
        await r.connect();
        const state = r.manager.get(HOST_ID)!.state();
        expect(state).toMatchObject({ status: "connected" });
        expect((state as { handshake: { platform: string } }).handshake.platform).toBe(
          process.platform
        );
        // The link rides a forwarded local socket, through the master.
        const master = await masterPid();
        expect(master).not.toBeNull();
        expect((await localForwardSockets()).length).toBeGreaterThanOrEqual(1);
        const attached = (await requireRemoteService("hostMode").getStatus()).attachedClients;
        expect(attached.length).toBeGreaterThanOrEqual(1);

        viewA = r.addView(VIEW_A, "proj-1");
        viewB = r.addView(VIEW_B, "proj-2");
        await r.openStreams(viewA);
        await r.openStreams(viewB);

        const disposers = [
          typedHandleWithContext(
            CHANNELS.APP_HYDRATE as never,
            ((ctx: IpcContext) => ({
              appState: { sidebarWidth: 999, activeWorktreeId: "wt-host", terminals: [] },
              terminalConfig: { fontSize: 30, scrollbackLines: 5000 },
              hostPlatform: process.platform,
              hostHomeDir: sshd!.home,
              project: { id: ctx.projectId },
            })) as never
          ),
          typedHandleWithContext(
            CHANNELS.WORKTREE_GET_ALL as never,
            ((ctx: IpcContext) => [
              {
                id: "wt-main",
                path: `/srv/${ctx.projectId}`,
                branch: "main",
                isMainWorktree: true,
              },
            ]) as never
          ),
        ];
        try {
          harnessState.store.set("appState", { sidebarWidth: 320, terminals: [] });
          const hydrate = unwrap<Record<string, unknown>>(
            await r.invoke(CHANNELS.APP_HYDRATE, viewA, {})
          );
          expect(hydrate).toMatchObject({
            hostHomeDir: sshd!.home,
            project: { id: "proj-1" },
            shellOnly: "from-the-shell",
            appState: { sidebarWidth: 320, activeWorktreeId: "wt-host" },
          });
          expect(await r.invoke(CHANNELS.WORKTREE_GET_ALL, viewA)).toEqual(
            wrapSuccess([
              { id: "wt-main", path: "/srv/proj-1", branch: "main", isMainWorktree: true },
            ])
          );
        } finally {
          for (const dispose of disposers) dispose();
        }

        const channel = CHANNELS.OPERATIONS_EVENT;
        broadcastToProjectRenderers("proj-1", channel, { type: "scoped" });
        broadcastToRenderer(channel, { type: "global" });
        await waitUntil(() => eventsOn(viewA, channel).length === 2, "view A's events");
        await waitUntil(() => eventsOn(viewB, channel).length === 1, "view B's event");
        expect(eventsOn(viewA, channel)).toEqual([[{ type: "scoped" }], [{ type: "global" }]]);
        expect(eventsOn(viewB, channel)).toEqual([[{ type: "global" }]]);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "3. terminal I/O and resize over the tunnel, and the keystroke round trip",
      async () => {
        const r = h!;
        const terminal = r.pty.terminals.get("t1")!;
        viewA.write("t1", "ls -la\r");
        await waitUntil(() => terminal.writes.length === 1, "the write at the pty");
        expect(terminal.writes).toEqual(["ls -la\r"]);

        r.pty.emit("t1", "hello ");
        r.pty.emit("t1", "wörld;");
        await waitUntil(() => viewA.text("t1") === "hello wörld;", "output at the renderer");
        await waitUntil(() => r.pty.unacked("t1") === 0, "the renderer's acks at the pty");

        viewA.resize("t1", 132, 43);
        await waitUntil(() => terminal.resizes.length === 1, "the resize");
        expect(terminal).toMatchObject({ cols: 132, rows: 43 });

        const keystroke = async (key: string): Promise<number> => {
          const echoed = viewA.nextMessage(
            (m) => m.type === "data" && m.id === "t-echo" && decode(m).includes(key)
          );
          const started = performance.now();
          viewA.write("t-echo", key);
          await echoed;
          return performance.now() - started;
        };
        for (let i = 0; i < 10; i++) await keystroke(`w${String(i).padStart(4, "0")}`);
        const samples: number[] = [];
        for (let i = 0; i < 300; i++)
          samples.push(await keystroke(`k${String(i).padStart(4, "0")}`));
        const sorted = samples.sort((x, y) => x - y);
        const round = (v: number) => Math.round(v * 1000) / 1000;
        rttReport = {
          samples: sorted.length,
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          p99: round(percentile(sorted, 99)),
          max: round(sorted.at(-1)!),
        };
        report(`keystroke RTT ms over ssh ${JSON.stringify(rttReport)}`);
        expect(rttReport.p95).toBeLessThan(100);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "4. killing the ControlMaster mid-session: the link notices, reconnect brings up a new master and forward, and the stream replays with nothing lost",
      async () => {
        const r = h!;
        const relay = getClientTerminalRelay(viewA.id)!;
        const expected: string[] = [viewA.text("t1")];
        const say = (text: string) => {
          r.pty.emit("t1", text);
          expected.push(text);
        };
        for (let i = 0; i < 20; i++) say(`a${i};`);
        await waitUntil(() => viewA.text("t1") === expected.join(""), "output before the kill");
        const before = await masterPid();
        expect(before).not.toBeNull();
        const socketsBefore = await localForwardSockets();

        for (let i = 0; i < 50; i++) say(`b${i};`);
        const killedAt = performance.now();
        process.kill(before!, "SIGKILL");
        for (let i = 0; i < 50; i++) say(`c${i};`);
        await waitUntil(() => !r.isConnected(), "the Shell to notice the master died", 15_000);
        const noticedMs = performance.now() - killedAt;
        for (let i = 0; i < 100; i++) say(`d${i};`);

        await waitUntil(r.isConnected, "the Shell to reconnect over a new master", 30_000);
        await waitUntil(() => r.streamsFlowing(viewA), "the terminal stream to resume", 15_000);
        const reconnectMs = performance.now() - killedAt;
        const after = await masterPid();
        expect(after).not.toBeNull();
        expect(after).not.toBe(before);
        expect(isAlive(before!)).toBe(false);
        // A new forward, not the dead master's.
        const socketsAfter = await localForwardSockets();
        expect(socketsAfter.some((name) => !socketsBefore.includes(name))).toBe(true);

        say("END");
        await waitUntil(() => viewA.text("t1").endsWith("END"), "output after the resume");
        expect(viewA.text("t1")).toBe(expected.join(""));
        expect(viewA.resets("t1")).toEqual([]);
        expect(relay.position("t1")!.lastSeq).toBe(viewA.dataFrames("t1").length);

        viewA.write("t1", "typed\r");
        await waitUntil(
          () => r.pty.terminals.get("t1")!.writes.includes("typed\r"),
          "input after recovery"
        );
        report(
          `master kill: noticed after ${Math.round(noticedMs)} ms, reconnected after ${Math.round(reconnectMs)} ms`
        );
      },
      TEST_TIMEOUT_MS
    );

    it(
      "5. port forward through the master: fetch through the forwarded port, and after Stop it no longer answers",
      async () => {
        devServer = http.createServer((_req, res) => {
          res.setHeader("Connection", "close");
          res.end("hello from the host's dev server");
        });
        await new Promise<void>((resolve) => devServer!.listen(0, "127.0.0.1", resolve));
        devPort = (devServer.address() as net.AddressInfo).port;

        const ports = requireRemoteService("portForwards");
        const forward = await ports.forward({
          hostId: HOST_ID,
          remotePort: devPort,
          origin: "manual",
        });
        // Host and Shell share a machine, so the host's port is taken here.
        expect(forward.localPort).not.toBe(devPort);
        expect(ports.list().map((f) => f.forwardId)).toEqual([forward.forwardId]);
        // ssh's master holds the local port: this is the `-O forward` path, not a link stream.
        expect(await listenersOn(forward.localPort)).toContain(await masterPid());

        expect(await get(forward.localPort)).toEqual({
          status: 200,
          body: "hello from the host's dev server",
        });
        expect(isWebviewSrcAllowed(viewA.id, `http://127.0.0.1:${forward.localPort}/`)).toBe(true);

        await ports.stop(forward.forwardId);
        expect(ports.list()).toEqual([]);
        expect(await listenersOn(forward.localPort)).not.toContain(await masterPid());
        expect(await get(forward.localPort)).toEqual({ error: "ECONNREFUSED" });
        expect(isWebviewSrcAllowed(viewA.id, `http://127.0.0.1:${forward.localPort}/`)).toBe(false);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "6. after the master dies a forward is not authorised until it is added again on the next session",
      async () => {
        const r = h!;
        const ports = requireRemoteService("portForwards");
        const first = await ports.forward({
          hostId: HOST_ID,
          remotePort: devPort,
          origin: "manual",
        });
        const firstUrl = `http://127.0.0.1:${first.localPort}/`;
        expect(isWebviewSrcAllowed(viewA.id, firstUrl)).toBe(true);
        expect(await get(first.localPort)).toMatchObject({ status: 200 });
        const master = await masterPid();

        // Keep the host unreachable while its master is gone, so what holds
        // in between is observable rather than a race with the redial.
        sshRouting.blocked = true;
        try {
          process.kill(master!, "SIGKILL");
          await waitUntil(() => !r.isConnected(), "the Shell to notice the master died", 15_000);
          await waitUntil(() => ports.list().length === 0, "the forward to be retired");
          expect(isWebviewSrcAllowed(viewA.id, firstUrl)).toBe(false);
          expect(await get(first.localPort)).toEqual({ error: "ECONNREFUSED" });
        } finally {
          sshRouting.blocked = false;
        }

        r.manager.get(HOST_ID)!.retryNow();
        await waitUntil(r.isConnected, "the Shell to reconnect", 30_000);
        await waitUntil(() => ports.list().length === 1, "the forward to be added again", 15_000);
        const [again] = ports.list();
        expect(again!.forwardId).toBe(first.forwardId);
        const newMaster = await masterPid();
        expect(newMaster).not.toBe(master);
        expect(await listenersOn(again!.localPort)).toContain(newMaster);
        expect(isWebviewSrcAllowed(viewA.id, `http://127.0.0.1:${again!.localPort}/`)).toBe(true);
        expect(await get(again!.localPort)).toEqual({
          status: 200,
          body: "hello from the host's dev server",
        });
        await waitUntil(() => r.streamsFlowing(viewA), "the terminal stream to resume", 15_000);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "7. teardown: forwards and link sockets go with the client, the master is the only ssh left and exits on request, sshd stops and the directory goes",
      async () => {
        const r = h!;
        const ports = requireRemoteService("portForwards");
        const [live] = ports.list();
        expect(live).toBeDefined();
        const master = await masterPid();
        expect(master).not.toBeNull();

        await stopRemoteHosts();
        // The port forward was cancelled on the master and the link's local sockets removed.
        expect(await listenersOn(live!.localPort)).toEqual([]);
        expect(await localForwardSockets()).toEqual([]);
        // ControlPersist keeps the master (and only it) for the next connection, as designed.
        const remaining = await testSshProcesses();
        expect(remaining.map((row) => row.pid)).toEqual([master]);

        // What forgetting the host does: close the master.
        const exit = await sshd!.runSsh([
          "-o",
          `ControlPath=${controlPath}`,
          "-O",
          "exit",
          SSH_ALIAS,
        ]);
        expect(exit.code, exit.stderr).toBe(0);
        await waitUntil(() => !isAlive(master!), "the master to exit");
        let leftovers = await testSshProcesses();
        for (let i = 0; i < 100 && leftovers.length > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          leftovers = await testSshProcesses();
        }
        expect(leftovers).toEqual([]);
        const controlEntries = (await fs.readdir(clientDir)).filter((name) =>
          name.startsWith("cm-")
        );
        expect(controlEntries).toEqual([]);

        // The host side: every session sshd started has ended.
        let sessions = await sshd!.sessionProcesses();
        for (let i = 0; i < 100 && sessions.length > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          sessions = await sshd!.sessionProcesses();
        }
        expect(sessions).toEqual([]);

        await new Promise<void>((resolve) => devServer!.close(() => resolve()));
        devServer = null;
        await r.dispose();
        h = null;
        const sshdPid = sshd!.pid;
        await sshd!.stop();
        expect(isAlive(sshdPid)).toBe(false);
        expect((await listProcesses()).filter((row) => row.command.includes(root!))).toEqual([]);

        const dir = root!;
        await fs.rm(dir, { recursive: true, force: true });
        await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
        if (rttReport) report(`summary ${JSON.stringify(rttReport)}`);
      },
      TEST_TIMEOUT_MS
    );
  }
);
