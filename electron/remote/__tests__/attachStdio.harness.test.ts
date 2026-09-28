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
import { stopRemoteHosts } from "../boot.js";
import { createCommandStreamTransport } from "../client/commandStreamTransport.js";
import { hostSocketLocation, type HostSocketLocation } from "../host/hostSocketPath.js";
import { getClientTerminalRelay } from "../terminal/clientAttach.js";
import { buildAttachBridgeScript } from "./harness/attachBridgeScript.js";
import { waitUntil } from "./harness/poll.js";
import { makeShortTempRoot } from "./harness/privateSshd.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

/**
 * The stdio attach bridge against the real harness Host over its real Unix
 * socket: the Shell's link runs through a child process that is the real
 * bridge module (`host/attachStdio.ts`, bundled as a Node script), with the
 * real command stream transport reading its preamble and carrying the link
 * over its stdin and stdout. This is what `ssh <target> -- <daintree>
 * --attach-stdio` does once ssh has started the command.
 */

const TEST_TIMEOUT_MS = 60_000;
const VIEW = 31; // studio-01:proj-1

let root: string;
let script: string;
let h: RemoteHarness | null = null;
let location: HostSocketLocation;
const children: ChildProcess[] = [];
/** While set, new bridges read a discovery file that isn't there: no host answers. */
let hostGone = false;

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
  hostGone = false;
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function exitOf(child: ChildProcess): Promise<number | string | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? child.signalCode);
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? signal)));
}

async function harness(): Promise<RemoteHarness> {
  const runDir = await fs.mkdtemp(path.join(root, "h-"));
  location = hostSocketLocation({ platform: "darwin", userDataDir: path.join(runDir, "host") });
  h = await startRemoteHarness({
    rootDir: root,
    hostLocation: location,
    createTransport: () =>
      createCommandStreamTransport(() => {
        const discovery = hostGone ? path.join(runDir, "gone.json") : location.discoveryPath;
        const child = spawn(process.execPath, [script, discovery], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        return child;
      }),
  });
  await h.connect();
  return h;
}

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

describe("the --attach-stdio bridge against the harness Host", () => {
  it(
    "carries the whole link through a real bridge process: handshake, a host call, terminal I/O and a large burst",
    async () => {
      const r = await harness();
      expect(children).toHaveLength(1);
      expect(r.server().sessions).toHaveLength(1);

      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      expect(unwrap<unknown[]>(await r.invoke(CHANNELS.OPERATIONS_LIST, view, {}))).toEqual([]);

      view.write("t1", "ls -la\r");
      await waitUntil(() => r.pty.terminals.get("t1")!.writes.length === 1, "the write at the pty");
      expect(r.pty.terminals.get("t1")!.writes).toEqual(["ls -la\r"]);

      // Well past every pipe buffer on the way, so backpressure has to hold.
      const expected: string[] = [];
      // Under the bridge's 1 MiB unacked limit, so it stays a stream rather than a snapshot.
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
      await waitUntil(() => r.pty.unacked("t1") === 0, "the renderer's acks at the pty");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a dead bridge drops the link; the Shell reports what the next one said, then reconnects and replays what it missed",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      r.pty.emit("t1", "before;");
      await waitUntil(() => view.text("t1") === "before;", "output before the kill");

      hostGone = true;
      const first = children[0]!;
      first.kill("SIGKILL");
      await waitUntil(() => !r.isConnected(), "the Shell to notice the bridge died");
      r.pty.emit("t1", "while-away;");
      await waitUntil(
        () => {
          const state = r.manager.get(HOST_ID)!.state();
          return state.status === "unreachable" && (state.detail ?? "").includes("no host");
        },
        "the next bridge's own words",
        15_000
      );

      hostGone = false;
      r.manager.get(HOST_ID)!.retryNow();
      await waitUntil(r.isConnected, "the Shell to reconnect through a fresh bridge", 15_000);
      await waitUntil(() => r.streamsFlowing(view), "the terminal stream to resume", 15_000);
      r.pty.emit("t1", "after");
      await waitUntil(() => view.text("t1").endsWith("after"), "output after the resume");
      expect(view.text("t1")).toBe("before;while-away;after");
      expect(view.resets("t1")).toEqual([]);
      expect(getClientTerminalRelay(view.id)!.position("t1")!.lastSeq).toBe(
        view.dataFrames("t1").length
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "the bridge exits once the Shell lets the link go, and the host forgets the session",
    async () => {
      const r = await harness();
      const [child] = children;
      // Only the Shell lets go; the host keeps listening.
      await r.manager.disconnect(HOST_ID);
      expect(await exitOf(child!)).toBe(0);
      await waitUntil(() => r.server().sessions.length === 0, "the host to drop the session");
      expect(r.server().isListening).toBe(true);

      // And when the app stops, a live bridge goes with it.
      r.manager.get(HOST_ID)?.retryNow();
      await r.connect();
      const second = children.at(-1)!;
      expect(second).not.toBe(child);
      await stopRemoteHosts();
      expect(await exitOf(second)).toBe(0);
    },
    TEST_TIMEOUT_MS
  );
});
