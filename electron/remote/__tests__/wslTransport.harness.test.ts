import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
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
import { CHANNELS } from "../../ipc/channels.js";
import type { CommandResult } from "../client/commandRunner.js";
import { WslTransport } from "../client/wslTransport.js";
import { hostSocketLocation, type HostSocketLocation } from "../host/hostSocketPath.js";
import { buildAttachBridgeScript } from "./harness/attachBridgeScript.js";
import { waitUntil } from "./harness/poll.js";
import { makeShortTempRoot } from "./harness/privateSshd.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

/**
 * A Windows Shell's link to a Linux Host in WSL, through the real
 * WslTransport: it reads the Host's discovery file, then runs
 * `wsl.exe -d <distro> --cd ~ --exec /usr/bin/env -u DISPLAY -u WAYLAND_DISPLAY
 * <the Host's command> --attach-stdio --ozone-platform=headless` and carries
 * the link over that process's stdio to the real harness Host.
 *
 * Only wsl.exe itself is stood in for: the spawn seam checks the options wsl
 * takes, strips them and runs the rest exactly as given, the way `--exec`
 * hands argv to the Linux program. The program is the real `/usr/bin/env` and
 * the real bridge module, bundled as a Node script and published as the
 * Host's launch command.
 */

const TEST_TIMEOUT_MS = 60_000;
const VIEW = 41; // studio-01:proj-1
const DISTRO = "Ubuntu-24.04";

let root: string;
let script: string;
let h: RemoteHarness | null = null;
let location: HostSocketLocation;
const children: ChildProcess[] = [];
const wslCalls: string[][] = [];
/** While false, the discovery read finds no Host listening, as the find script reports it. */
let hostListening = true;

beforeAll(async () => {
  root = await makeShortTempRoot();
  script = await buildAttachBridgeScript(root);
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await h?.dispose();
  h = null;
  hostListening = true;
  wslCalls.length = 0;
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function exitOf(child: ChildProcess): Promise<number | string | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? child.signalCode);
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal)));
}

/** What wsl.exe passes on after its own options: the Linux program's argv. */
function programArgv(args: readonly string[]): string[] {
  expect(args.slice(0, 5)).toEqual(["-d", DISTRO, "--cd", "~", "--exec"]);
  return args.slice(5);
}

async function harness(
  options: { ensureRunning?: (signal: AbortSignal) => Promise<boolean> } = {}
): Promise<RemoteHarness> {
  const runDir = await fs.mkdtemp(path.join(root, "h-"));
  location = hostSocketLocation({ platform: "darwin", userDataDir: path.join(runDir, "host") });
  h = await startRemoteHarness({
    rootDir: root,
    hostLocation: location,
    createTransport: () =>
      new WslTransport({
        distro: DISTRO,
        wslPath: "C:\\Windows\\System32\\wsl.exe",
        ensureRunning: options.ensureRunning,
        // The discovery read: the find script runs in the distro; here, its result.
        run: async (_wsl, args): Promise<CommandResult> => {
          wslCalls.push([...args]);
          const [program, flag] = programArgv(args);
          expect([program, flag]).toEqual(["/bin/sh", "-c"]);
          if (!hostListening) {
            return { code: 3, stdout: "", stderr: "", spawnError: null, timedOut: false };
          }
          const published = JSON.parse(await fs.readFile(location.discoveryPath, "utf8"));
          // The Host publishes how to run itself; here that is the bundled bridge.
          published.command = [process.execPath, script];
          return {
            code: 0,
            stdout: JSON.stringify(published),
            stderr: "",
            spawnError: null,
            timedOut: false,
          };
        },
        spawn: (_wsl, args) => {
          wslCalls.push([...args]);
          const [program, ...rest] = programArgv(args);
          const child = spawn(program!, rest, {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              DISPLAY: ":0",
              WAYLAND_DISPLAY: "wayland-0",
              DAINTREE_ATTACH_DISCOVERY: location.discoveryPath,
            },
          });
          children.push(child);
          return child;
        },
      }),
  });
  await h.connect();
  return h;
}

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

describe("a WSL distro's Host through the real WslTransport", () => {
  it(
    "runs the Host's own bridge headless and display-free, and carries the link: a host call, terminal I/O and a burst",
    async () => {
      const r = await harness();
      expect(children).toHaveLength(1);
      const attach = wslCalls.find((args) => args.includes("--attach-stdio"))!;
      expect(programArgv(attach)).toEqual([
        "/usr/bin/env",
        "-u",
        "DISPLAY",
        "-u",
        "WAYLAND_DISPLAY",
        process.execPath,
        script,
        "--attach-stdio",
        "--ozone-platform=headless",
      ]);

      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      expect(unwrap<unknown[]>(await r.invoke(CHANNELS.OPERATIONS_LIST, view, {}))).toEqual([]);

      view.write("t1", "uname -a\r");
      await waitUntil(() => r.pty.terminals.get("t1")!.writes.length === 1, "the write at the pty");
      expect(r.pty.terminals.get("t1")!.writes).toEqual(["uname -a\r"]);

      const expected: string[] = [];
      for (let i = 0; i < 24; i++) {
        const chunk = `${String(i).padStart(4, "0")}:${"é".repeat(16 * 1024)}\n`;
        expected.push(chunk);
        r.pty.emit("t1", chunk);
      }
      await waitUntil(
        () => view.text("t1") === expected.join(""),
        "every byte of the burst at the renderer",
        30_000
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "starts a Host that wasn't listening, then connects to it",
    async () => {
      hostListening = false;
      let starts = 0;
      await harness({
        ensureRunning: async () => {
          starts += 1;
          hostListening = true;
          return true;
        },
      });
      expect(starts).toBe(1);
      expect(children).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a dead bridge drops the link; a fresh one reconnects and replays what the view missed",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      r.pty.emit("t1", "before;");
      await waitUntil(() => view.text("t1") === "before;", "output before the kill");

      children[0]!.kill("SIGKILL");
      await waitUntil(() => !r.isConnected(), "the Shell to notice the bridge died");
      r.pty.emit("t1", "while-away;");
      r.manager.get(HOST_ID)!.retryNow();
      await waitUntil(r.isConnected, "the Shell to reconnect through a fresh bridge", 15_000);
      await waitUntil(() => r.streamsFlowing(view), "the terminal stream to resume", 15_000);
      r.pty.emit("t1", "after");
      await waitUntil(() => view.text("t1").endsWith("after"), "output after the resume");
      expect(view.text("t1")).toBe("before;while-away;after");
      expect(children.length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "the bridge exits once the Shell lets the link go",
    async () => {
      const r = await harness();
      const [child] = children;
      await r.manager.disconnect(HOST_ID);
      expect(await exitOf(child!)).toBe(0);
      await waitUntil(() => r.server().sessions.length === 0, "the host to drop the session");
    },
    TEST_TIMEOUT_MS
  );
});
