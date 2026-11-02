import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-bring-back",
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

/**
 * The host's shell as setup's ssh reaches it: every script it runs, the probe
 * answered from what the host is doing, and a start of the app handed to the
 * host's own Host mode service, as LaunchServices would hand `open -n` to it.
 */
const remote = vi.hoisted(() => ({
  scripts: [] as string[],
  answer: (_script: string): Promise<string> => Promise.resolve(""),
}));
vi.mock("../client/remoteShell.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/remoteShell.js")>();
  const run = async (script: string) => {
    remote.scripts.push(script);
    return {
      code: 0,
      stdout: await remote.answer(script),
      stderr: "",
      spawnError: null,
      timedOut: false,
    };
  };
  return {
    ...original,
    createSshCommandChannel: () => ({
      exec: (script: string) => run(script),
      execWithInput: (script: string) => run(script),
      sendFile: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        spawnError: null,
        timedOut: false,
      }),
    }),
  };
});

import { waitUntil } from "./harness/poll.js";
import { makeShortTempRoot } from "./harness/privateSshd.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";
import { HostModeOffError, createDirectTransport } from "../client/transport.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import { hostSocketLocation } from "../host/hostSocketPath.js";
import { requireRemoteService } from "../runtime.js";

let h: RemoteHarness | null = null;
let root: string | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = null;
  remote.scripts = [];
  remote.answer = () => Promise.resolve("");
});

/** What the host is doing, as its Host mode record and listener say. */
interface HostSide {
  enabled: boolean;
  /** Quit there on purpose: what quitting writes before the listener goes. */
  stopped: boolean;
  listening: boolean;
}

/** The setup probe's answer for a Mac with Daintree installed, as it reads the host. */
function probeOutput(host: HostSide): string {
  const build = getLocalHandshakeInfo();
  const state = {
    daintreeHostMode: 1,
    pid: host.listening ? process.pid : 0,
    enabled: host.enabled,
    startAtLogin: true,
    startAtLoginInstalled: true,
    startAtLoginError: null,
    keychain: { state: "ok", detail: "Keychain answered", checked: true },
    ...(host.stopped ? { stopped: true } : {}),
  };
  return [
    "@@dt:uname Darwin arm64",
    "@@dt:install app-bundle /Applications/Daintree.app",
    `@@dt:version ${build.version}`,
    `@@dt:buildinfo ${JSON.stringify({ daintreeBuildInfo: 1, version: build.version, commit: build.commit })}`,
    "@@dt:download yes",
    `@@dt:hostmodestate ${JSON.stringify(state)}`,
    ...(host.listening
      ? [
          "@@dt:running yes",
          "@@dt:listening yes",
          `@@dt:hostpid ${process.pid}`,
          "@@dt:launchagent yes",
        ]
      : []),
    "@@dt:end",
  ].join("\n");
}

const isAppStart = (script: string) => script.includes("open -n -g -a");

/**
 * A harness whose transport behaves as ssh's does when it gets in: the
 * host's socket when Daintree serves there, and otherwise the Shell's own
 * start step, then the socket again; a link that may not start it hears that
 * Host mode is off.
 */
async function harnessFor(host: HostSide): Promise<RemoteHarness> {
  root = await makeShortTempRoot();
  const hostLocation = hostSocketLocation({
    platform: "darwin",
    userDataDir: path.join(root, "host-data"),
  });
  const harness = await startRemoteHarness({
    rootDir: root,
    hostLocation,
    createTransport: (_clientDir, ensureRunning) => {
      const direct = createDirectTransport({ discoveryPath: hostLocation.discoveryPath });
      return {
        async open(signal, options) {
          try {
            return await direct.open(signal);
          } catch {
            if (options?.mayStart !== false && (await ensureRunning(signal))) {
              return direct.open(signal);
            }
            throw new HostModeOffError("no Daintree listening there");
          }
        },
      };
    },
  });
  const hostMode = requireRemoteService("hostMode");
  remote.answer = async (script) => {
    if (isAppStart(script)) {
      await hostMode.startListening();
      host.listening = true;
      host.stopped = false;
      return "";
    }
    return script.includes("@@dt:uname") ? probeOutput(host) : "";
  };
  await harness.connect();
  // Daintree there goes; its Shell hears that it is shutting down.
  await hostMode.stopListening();
  host.listening = false;
  await waitUntil(() => !harness.isConnected(), "the Shell to see the host go");
  return harness;
}

describe("bringing a host back over the harness (#16170)", () => {
  it("starts Daintree in Host mode on a host quit there on purpose, once, and the link comes up", async () => {
    const host: HostSide = { enabled: true, stopped: true, listening: false };
    h = await harnessFor(host);
    // Said to be shutting down: the link's own retries never start it again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(remote.scripts.filter(isAppStart)).toEqual([]);

    const bringBack = requireRemoteService("hostBringBack");
    const first = bringBack.bringBack(HOST_ID);
    // The person's press and the assistant's call are one attempt.
    expect(bringBack.bringBack(HOST_ID)).toBe(first);
    const answer = await first;

    expect(answer).toMatchObject({
      status: "started",
      wake: "not_set_up",
      reached: true,
      startRequested: true,
    });
    expect(h.manager.connectionState(HOST_ID).status).toBe("connected");
    expect(remote.scripts.filter(isAppStart)).toHaveLength(1);
    // Started as it was set up: nothing switched on, saved or installed there.
    expect(remote.scripts.some((script) => script.includes("--enable-host-mode"))).toBe(false);
    // The attempt is over: a later call is a new one, and finds the link up.
    await expect(bringBack.bringBack(HOST_ID)).resolves.toMatchObject({ status: "connected" });
  }, 30_000);

  it("never starts a host whose Host mode is off, and says what it found", async () => {
    const host: HostSide = { enabled: false, stopped: false, listening: false };
    h = await harnessFor(host);

    const answer = await requireRemoteService("hostBringBack").bringBack(HOST_ID);

    expect(answer).toMatchObject({ status: "not_startable", reached: true, startRequested: false });
    expect(answer.observed).toContain("Host mode isn't on");
    expect(remote.scripts.filter(isAppStart)).toEqual([]);
    expect(h.isConnected()).toBe(false);
  }, 30_000);
});
