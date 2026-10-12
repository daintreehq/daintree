import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
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

// The host publishes how to start its build again; here that is the real
// bridge module as a Node script, since this process isn't Electron.
const launch = vi.hoisted(() => ({ command: undefined as string[] | undefined }));
vi.mock("../host/hostLocation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../host/hostLocation.js")>()),
  hostLaunchCommand: () => launch.command,
}));

import { CHANNELS } from "../../ipc/channels.js";
import { stopRemoteHosts } from "../boot.js";
import { SshTransport, controlPathFor } from "../client/sshTransport.js";
import { remoteHostSocketLocation, type HostSocketLocation } from "../host/hostSocketPath.js";
import { requireRemoteService } from "../runtime.js";
import { getClientTerminalRelay } from "../terminal/clientAttach.js";
import { buildAttachBridgeScript } from "./harness/attachBridgeScript.js";
import type { FakeView } from "./harness/fakeView.js";
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

/**
 * The stdio fallback over real ssh: a private sshd with
 * `AllowStreamLocalForwarding no` accepts `-O forward -L` (the local side binds)
 * but refuses every channel to the host socket, so the Shell must notice that
 * refusal in ssh's own words and carry the link over `ssh <target> --
 * <command> --attach-stdio` through the same ControlMaster instead. The
 * command is the one the Host published in its discovery file: here the real
 * bridge module as a Node script.
 */

const ENABLED = process.env.DAINTREE_SSH_E2E === "1";
const TEST_TIMEOUT_MS = 90_000;
const VIEW = 41; // studio-01:proj-1

let root: string | null = null;
let sshd: PrivateSshd | null = null;
let h: RemoteHarness | null = null;
let location: HostSocketLocation;
let clientDir: string;
let transport: SshTransport | null = null;
let view: FakeView;
let devServer: http.Server | null = null;

async function localForwardSockets(): Promise<string[]> {
  const names = await fs.readdir(clientDir).catch(() => [] as string[]);
  return names.filter((name) => /^l-.*\.sock$/.test(name));
}

/** ssh and bridge processes this run started, found by the run's directory in their command line. */
async function runProcesses() {
  return (await listProcesses()).filter(
    (row) =>
      row.command.includes(root!) &&
      row.pid !== sshd?.pid &&
      row.pid !== process.pid &&
      !/\bps\b/.test(row.command)
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

function get(port: number): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/", agent: false, headers: { Connection: "close" } },
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

async function masterPid(): Promise<number | null> {
  const controlPath = controlPathFor(clientDir, SSH_ALIAS);
  const result = await sshd!.runSsh(["-o", `ControlPath=${controlPath}`, "-O", "check", SSH_ALIAS]);
  if (result.code !== 0) return null;
  const match = /pid=(\d+)/.exec(result.stderr + result.stdout);
  return match ? Number(match[1]) : null;
}

describe.skipIf(!ENABLED)(
  "Remote Hosts over ssh when the server refuses socket forwarding (skipped unless DAINTREE_SSH_E2E=1)",
  () => {
    beforeAll(async () => {
      root = await makeShortTempRoot();
      const script = await buildAttachBridgeScript(root);
      launch.command = [process.execPath, script];
      const linuxDirName = `daintree-e2e-${path.basename(root)}`;
      const home = path.join(root, "home");
      location = remoteHostSocketLocation({
        platform: process.platform === "linux" ? "linux" : "darwin",
        uid: process.getuid!(),
        home,
        linuxDirName,
      });
      sshd = await startPrivateSshd(root, {
        allowStreamLocalForwarding: false,
        // How the stand-in bridge finds this host when started as `<command> --attach-stdio`.
        env: { DAINTREE_ATTACH_DISCOVERY: location.discoveryPath },
      });
      expect(sshd.home).toBe(home);
      sshRouting.configPath = sshd.configPath;
      sshRouting.blocked = false;
      h = await startRemoteHarness({
        rootDir: root,
        hostLocation: location,
        sshTarget: SSH_ALIAS,
        createTransport: (dir) => {
          clientDir = dir;
          transport = new SshTransport({
            target: SSH_ALIAS,
            clientDir: dir,
            spawn: sshd!.spawnSsh,
            spawnStream: sshd!.spawnSshStream,
            linuxDirName,
          });
          return transport;
        },
      });
      h.pty.spawn("t1", "proj-1");
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      sshRouting.blocked = false;
      await new Promise<void>((resolve) =>
        devServer ? devServer.close(() => resolve()) : resolve()
      );
      await h?.dispose().catch(() => {});
      h = null;
      await sshd?.stop();
      for (const row of await listProcesses().catch(() => [])) {
        if (root && row.command.includes(root) && row.pid !== process.pid) {
          try {
            process.kill(row.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      sshRouting.configPath = null;
      launch.command = undefined;
      if (root) {
        if (location && process.platform === "linux") {
          await fs.rm(location.dir, { recursive: true, force: true });
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }, TEST_TIMEOUT_MS);

    it(
      "1. the server refuses a channel to the host socket, in ssh's own words",
      async () => {
        const refused = await sshd!.runSsh(["-W", location.socketPath, SSH_ALIAS]);
        expect(refused.code).toBe(255);
        expect(refused.stderr).toMatch(/open failed|forwarding failed|refused/i);
        expect(await fs.readFile(sshd!.logPath, "utf8")).toContain(
          "refused streamlocal port forward"
        );
      },
      TEST_TIMEOUT_MS
    );

    it(
      "2. the Shell still connects, through the attach bridge over the master, and the link works end to end",
      async () => {
        const r = h!;
        await r.connect();
        expect(transport!.route).toBe("attach-stdio");
        // No socket forward was left behind: the link rides ssh's stdio.
        expect(await localForwardSockets()).toEqual([]);
        const bridges = (await runProcesses()).filter((row) =>
          row.command.includes("attach-bridge")
        );
        expect(bridges.length).toBeGreaterThanOrEqual(1);

        view = r.addView(VIEW, "proj-1");
        await r.openStreams(view);
        expect(await r.invoke(CHANNELS.OPERATIONS_LIST, view, {})).toMatchObject({ ok: true });
        view.write("t1", "echo over stdio\r");
        await waitUntil(
          () => r.pty.terminals.get("t1")!.writes.includes("echo over stdio\r"),
          "the write at the pty"
        );
        r.pty.emit("t1", "hello over ssh stdio;");
        await waitUntil(
          () => view.text("t1") === "hello over ssh stdio;",
          "output at the renderer"
        );
        await waitUntil(() => r.pty.unacked("t1") === 0, "the renderer's acks at the pty");
      },
      TEST_TIMEOUT_MS
    );

    it(
      "3. a TCP port forward still goes through the master with -O forward",
      async () => {
        devServer = http.createServer((_req, res) => {
          res.setHeader("Connection", "close");
          res.end("hello from the host");
        });
        await new Promise<void>((resolve) => devServer!.listen(0, "127.0.0.1", resolve));
        const devPort = (devServer.address() as net.AddressInfo).port;
        const ports = requireRemoteService("portForwards");
        const forward = await ports.forward({
          hostId: HOST_ID,
          remotePort: devPort,
          origin: "manual",
        });
        expect(await listenersOn(forward.localPort)).toContain(await masterPid());
        expect(await get(forward.localPort)).toEqual({ status: 200, body: "hello from the host" });
        await ports.stop(forward.forwardId);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "4. killing the master drops the link; reconnecting runs a fresh bridge and the stream replays",
      async () => {
        const r = h!;
        const expected = [view.text("t1")];
        const before = await masterPid();
        expect(before).not.toBeNull();
        process.kill(before!, "SIGKILL");
        await waitUntil(() => !r.isConnected(), "the Shell to notice the master died", 15_000);
        for (let i = 0; i < 20; i++) {
          r.pty.emit("t1", `gap${i};`);
          expected.push(`gap${i};`);
        }
        await waitUntil(r.isConnected, "the Shell to reconnect through the bridge", 30_000);
        await waitUntil(() => r.streamsFlowing(view), "the terminal stream to resume", 15_000);
        expect(transport!.route).toBe("attach-stdio");
        r.pty.emit("t1", "END");
        expected.push("END");
        await waitUntil(() => view.text("t1").endsWith("END"), "output after the resume");
        expect(view.text("t1")).toBe(expected.join(""));
        expect(view.resets("t1")).toEqual([]);
        expect(getClientTerminalRelay(view.id)!.position("t1")!.lastSeq).toBe(
          view.dataFrames("t1").length
        );
        const after = await masterPid();
        expect(after).not.toBeNull();
        expect(after).not.toBe(before);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "5. stopping: the bridge, its ssh and the master all go, and sshd's sessions end",
      async () => {
        const master = await masterPid();
        expect(master).not.toBeNull();
        await stopRemoteHosts();
        await waitUntil(() => !isAlive(master!), "the master to exit on stop");
        let leftovers = await runProcesses();
        for (let i = 0; i < 100 && leftovers.length > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          leftovers = await runProcesses();
        }
        expect(leftovers).toEqual([]);
        let sessions = await sshd!.sessionProcesses();
        for (let i = 0; i < 100 && sessions.length > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          sessions = await sshd!.sessionProcesses();
        }
        expect(sessions).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );
  }
);
