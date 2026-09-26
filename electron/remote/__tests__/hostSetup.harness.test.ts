import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-host-setup",
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
 * The host's home: start at login writes its LaunchAgent under it, so it must
 * never be the real one.
 */
const homeState = vi.hoisted(() => ({ home: null as string | null }));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  const homedir = () => homeState.home ?? original.tmpdir();
  return { ...original, homedir, default: { ...original, homedir } };
});

/** The host's own build, when it should differ from the Shell's. */
const hostBuild = vi.hoisted(() => ({ commit: null as string | null }));
vi.mock("../host/HostServer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../host/HostServer.js")>();
  class HostServerOnItsOwnBuild extends original.HostServer {
    constructor(options: ConstructorParameters<typeof original.HostServer>[0]) {
      super(
        hostBuild.commit
          ? { ...options, handshake: { ...options.handshake, commit: hostBuild.commit } }
          : options
      );
    }
  }
  return { ...original, HostServer: HostServerOnItsOwnBuild };
});

/** What the host's agents are doing, as its FSM would report them. */
const agents = vi.hoisted(() => ({ working: 0 as number | null, observed: 0 }));
vi.mock("../metrics/hostSources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metrics/hostSources.js")>()),
  observeAgents: async () => {
    agents.observed++;
    return agents.working === null ? null : { working: agents.working, waiting: 0, idle: 0 };
  },
}));

/** Setup's ssh, answering the probe as a Mac running an older build in Host mode. */
const probeAnswer = vi.hoisted(() => ({ stdout: "" }));
vi.mock("../client/remoteShell.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/remoteShell.js")>();
  const answer = (script: string) => ({
    code: 0,
    stdout: script.includes("@@dt:uname") ? probeAnswer.stdout : "",
    stderr: "",
    spawnError: null,
    timedOut: false,
  });
  return {
    ...original,
    createSshCommandChannel: () => ({
      exec: async (script: string) => answer(script),
      execWithInput: async (script: string) => answer(script),
      sendFile: async () => answer(""),
    }),
  };
});

import { electronMock } from "./harness/fakeElectron.js";
import { harnessState, memoryStore } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { makeShortTempRoot } from "./harness/privateSshd.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";
import { defaultCommandRunner, type CommandResult } from "../client/commandRunner.js";
import {
  bootstrapHostMode,
  hostModeConfirmed,
  MAC_ENABLE_SCRIPT,
} from "../client/hostModeBootstrap.js";
import { MAC_APP_PATH, probeHost } from "../client/hostProbe.js";
import type { HostCommandChannel } from "../client/remoteShell.js";
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
  homeState.home = null;
  hostBuild.commit = null;
  agents.working = 0;
  agents.observed = 0;
  electronMock.app.isPackaged = false;
});

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const OK: CommandResult = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };

/**
 * The host's shell, run here under `sh` with the test's HOME, and with the
 * app path pointed at a stand-in install. `open -n … --enable-host-mode` is
 * what LaunchServices would hand to the running Daintree: `onEnable`.
 */
function localHostChannel(home: string, app: string, onEnable: () => void): HostCommandChannel {
  const run = (script: string, options?: Parameters<HostCommandChannel["exec"]>[1]) =>
    defaultCommandRunner(
      "sh",
      ["-c", `HOME=${sq(home)}; export HOME; ${script.split(MAC_APP_PATH).join(app)}`],
      options
    );
  return {
    async exec(script, options) {
      if (script === MAC_ENABLE_SCRIPT) {
        onEnable();
        return OK;
      }
      return run(script, options);
    },
    execWithInput: (script, input, options) => run(script, { ...options, input }),
    sendFile: async () => OK,
  };
}

/** A stand-in for /Applications/Daintree.app: its version and build marker, nothing else. */
async function standInApp(dir: string): Promise<string> {
  const app = path.join(dir, "Daintree.app");
  const handshake = getLocalHandshakeInfo();
  await fs.mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
  await fs.writeFile(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${handshake.version}</string></dict></plist>\n`
  );
  await fs.writeFile(
    path.join(app, "Contents", "Resources", "app.asar"),
    `...${JSON.stringify({ daintreeBuildInfo: 1, version: handshake.version, commit: handshake.commit })}...`
  );
  return app;
}

describe("host setup over the harness", () => {
  it.runIf(process.platform === "darwin")(
    "turns Host mode on for good through the host's own service and reads it back with the real probe",
    async () => {
      root = await makeShortTempRoot();
      const home = path.join(root, "home");
      await fs.mkdir(home, { recursive: true });
      homeState.home = home;
      // Start at login uses the packaged app's LaunchAgent label, which the probe looks for.
      electronMock.app.isPackaged = true;
      const location = hostSocketLocation({
        platform: "darwin",
        userDataDir: path.join(home, "Library", "Application Support", "Daintree"),
      });
      h = await startRemoteHarness({ rootDir: root, hostLocation: location });
      const hostMode = requireRemoteService("hostMode");
      const app = await standInApp(root);
      let enables = 0;
      const channel = localHostChannel(home, app, () => {
        enables++;
        void hostMode.enableFromSetup();
      });
      const client = getLocalHandshakeInfo();
      const probe = () =>
        probeHost({ connection: { kind: "ssh", target: "studio" }, shell: channel, client });

      const before = await probe();
      expect(before.result).toMatchObject({ reachable: true, hostModeListening: true });
      // Listening for this run only: nothing saved, no start at login.
      expect(hostModeConfirmed(before)).toBe(false);
      expect(memoryStore.get("hostMode")).toBeUndefined();

      const result = await bootstrapHostMode({ kind: "ssh", target: "studio" }, before, {
        channel,
        probe,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 20)),
      });
      expect(enables).toBe(1);
      expect(result.probe.hostModeState).toEqual({
        pid: process.pid,
        enabled: true,
        startAtLogin: true,
        startAtLoginInstalled: true,
        startAtLoginError: null,
        keychain: {
          state: "unavailable",
          detail: "Keychain unavailable: plugin secrets can't be stored on this host",
          checked: true,
        },
      });
      expect(result.probe.advice.startAtLoginInstalled).toBe(true);
      // Saved as the Settings switch saves it, with the LaunchAgent in the host's home.
      expect(memoryStore.get("hostMode")).toEqual({ enabled: true, startAtLogin: true });
      const plist = await fs.readFile(
        path.join(home, "Library", "LaunchAgents", "org.daintree.app.host.plist"),
        "utf8"
      );
      expect(plist).toContain("<string>--host-mode</string>");
      expect(plist).toContain("<string>Aqua</string>");
    },
    30_000
  );

  it("tells a Shell on another build how many agents are working, so it can wait for idle", async () => {
    hostBuild.commit = "0123456789abcdef";
    agents.working = 2;
    // Short, so setup's ssh control socket path fits.
    root = await makeShortTempRoot();
    h = await startRemoteHarness({ rootDir: root });
    const booted = harnessState.client!;
    await expect(booted.client.connectAndWait(HOST_ID, 10_000)).resolves.toBe("version-mismatch");
    probeAnswer.stdout = [
      "@@dt:uname Darwin arm64",
      "@@dt:install app-bundle /Applications/Daintree.app",
      "@@dt:version 0.0.0-harness",
      '@@dt:buildinfo {"daintreeBuildInfo":1,"version":"0.0.0-harness","commit":"0123456789abcdef"}',
      "@@dt:running yes",
      "@@dt:listening yes",
      "@@dt:hostpid 4242",
      "@@dt:download yes",
      "@@dt:end",
    ].join("\n");

    // The metrics link is refused, so the count comes from the refusal itself.
    const setup = requireRemoteService("hostSetup");
    await expect(
      setup.install({
        opId: "op-idle-1",
        connection: { kind: "ssh", target: "studio.example" },
        hostId: HOST_ID,
      })
    ).resolves.toEqual({ status: "agents-working", working: 2 });

    // Waiting for idle asks again with a fresh handshake each time.
    agents.working = 0;
    const connection = h.manager.get(HOST_ID)!;
    const before = agents.observed;
    await expect(
      connection.workingAgentsWhileMismatched({ maxAgeMs: 0, timeoutMs: 10_000 })
    ).resolves.toBe(0);
    expect(agents.observed).toBeGreaterThan(before);
    expect(connection.linkState.status).toBe("version-mismatch");

    // A host that can't see all its agents is unknown, never idle.
    agents.working = null;
    await expect(
      connection.workingAgentsWhileMismatched({ maxAgeMs: 0, timeoutMs: 10_000 })
    ).resolves.toBeNull();
    await waitUntil(() => connection.linkState.status === "version-mismatch", "the refusal");
  });
});
