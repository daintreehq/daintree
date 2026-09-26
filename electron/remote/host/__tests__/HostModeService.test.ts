import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostModeStatus } from "../../../../shared/types/ipc/hostMode.js";
import { LinkClient } from "../../client/LinkClient.js";
import { createDirectTransport } from "../../client/transport.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import type { AdvertiseState } from "../advertise.js";
import type { CommandResult, CommandRunner } from "../hostCommands.js";
import type { HostListener } from "../hostListener.js";
import {
  HostModeService,
  type HostModeServiceDeps,
  type HostModeSettings,
} from "../HostModeService.js";
import { HostServer } from "../HostServer.js";
import { hostSocketLocation, type HostSocketLocation } from "../hostSocketPath.js";
import type { KeychainProbe } from "../keychainPreflight.js";
import { NO_KEYRING_DETAIL } from "../keychainPreflight.js";
import {
  buildSystemdUnit,
  createSystemdUserController,
  type StartAtLoginFs,
} from "../startAtLogin.js";

let root: string;
let location: HostSocketLocation;
const services: HostModeService[] = [];
const clients: LinkClient[] = [];

beforeEach(async () => {
  root = await makeTempDir();
  location = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "ud") });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const s of services.splice(0)) await s.dispose();
  await removeTempDir(root);
});

/** A listener over a real socket: enough to prove what switching off does to it. */
async function realListener(signal: AbortSignal): Promise<HostListener> {
  const server = new HostServer({
    location,
    handshake: TEST_HANDSHAKE,
    hostName: "studio-01",
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
  });
  const listeners = new Set<() => void>();
  const off = server.onSession(() => listeners.forEach((l) => l()));
  const listener: HostListener = {
    socketPath: location.socketPath,
    isListening: () => server.isListening,
    attachedClients: () =>
      server.sessions.map((ctx) => ({
        clientId: ctx.client.clientId,
        clientName: ctx.client.clientName,
        connectedAt: 1,
        drivingProjectIds: [],
      })),
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop: async () => {
      off();
      await server.close();
    },
  };
  signal.addEventListener("abort", () => void listener.stop());
  await server.listen();
  return listener;
}

function memoryFs(): StartAtLoginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (file) => files.get(file) ?? null,
    writeFile: async (file, content) => void files.set(file, content),
    remove: async (file) => void files.delete(file),
  };
}

function scriptedRunner(outputs: Record<string, Partial<CommandResult>> = {}) {
  const calls: string[] = [];
  const run: CommandRunner = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    return { code: 0, stdout: "", stderr: "", ...outputs[line] };
  };
  return { run, calls };
}

function fakeKeychain(overrides: Partial<KeychainProbe> = {}): KeychainProbe {
  return {
    secretTier: () => "keychain",
    getSelectedStorageBackend: () => "gnome_libsecret",
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => Buffer.from(text),
    decryptStringAsync: async (buf) => ({ result: buf.toString() }),
    ...overrides,
  };
}

function makeService(overrides: Partial<HostModeServiceDeps> = {}, initial?: HostModeSettings) {
  let settings: HostModeSettings = initial ?? { enabled: false, startAtLogin: false };
  const pushes: HostModeStatus[] = [];
  const advertise: { state: AdvertiseState; calls: string[] } = {
    state: { status: "off" },
    calls: [],
  };
  const service = new HostModeService({
    platform: "linux",
    readSettings: () => settings,
    writeSettings: (next) => {
      settings = next;
    },
    socketPath: location.socketPath,
    startListener: realListener,
    startAtLogin: null,
    createAdvertiser: () => ({
      start: () => {
        advertise.calls.push("start");
        advertise.state = {
          status: "advertising",
          tool: "avahi-publish-service",
          instanceName: "studio-01",
        };
      },
      stop: () => {
        advertise.calls.push("stop");
        advertise.state = { status: "off" };
      },
      getState: () => advertise.state,
    }),
    keychain: fakeKeychain(),
    run: scriptedRunner().run,
    broadcast: (status) => pushes.push(status),
    pushDelayMs: 0,
    ...overrides,
  });
  services.push(service);
  return { service, pushes, advertise, settings: () => settings };
}

function row(status: HostModeStatus, id: string) {
  return status.rows.find((r) => r.id === id)!;
}

describe("HostModeService enable and disable", () => {
  it("listens and advertises when switched on, and drops every session when switched off", async () => {
    const { service, advertise, settings } = makeService();

    const on = await service.setEnabled({ enabled: true });
    expect(on).toMatchObject({ enabled: true, listening: true, socketPath: location.socketPath });
    expect(existsSync(location.socketPath)).toBe(true);
    expect(existsSync(location.discoveryPath)).toBe(true);
    expect(advertise.calls).toEqual(["start"]);
    expect(row(on, "socket")).toMatchObject({ state: "ok" });
    expect(row(on, "socket").detail).toContain(location.socketPath);
    expect(row(on, "socket").detail).toContain("advertised on the local network as studio-01");

    const client = new LinkClient({
      transport: createDirectTransport({ discoveryPath: location.discoveryPath }),
      handshake: TEST_HANDSHAKE,
      client: { clientId: "client-a", clientName: "greg-mbp", platform: "darwin" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      backoff: { initialMs: 10, maxMs: 50 },
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getState().status === "connected");
    const attached = await service.getStatus();
    expect(attached.attachedClients.map((c) => c.clientName)).toEqual(["greg-mbp"]);
    expect(row(attached, "drivers")).toMatchObject({ state: "ok", detail: "greg-mbp" });

    const off = await service.setEnabled({ enabled: false });
    expect(off).toMatchObject({ enabled: false, listening: false, attachedClients: [] });
    expect(settings()).toEqual({ enabled: false, startAtLogin: false });
    expect(existsSync(location.socketPath)).toBe(false);
    expect(existsSync(location.discoveryPath)).toBe(false);
    expect(advertise.calls).toEqual(["start", "stop"]);
    await waitFor(() => client.getState().status !== "connected");
  });

  it("reverts the setting and reports why when the socket can't listen", async () => {
    const { service, settings } = makeService({
      startListener: async () => {
        throw new Error("Another process is already listening on /x/host.sock");
      },
    });
    await expect(service.setEnabled({ enabled: true })).rejects.toThrow("already listening");
    expect(settings()).toEqual({ enabled: false, startAtLogin: false });
    const status = await service.getStatus();
    expect(row(status, "socket")).toMatchObject({
      state: "unavailable",
      detail: "Not listening: Another process is already listening on /x/host.sock",
    });
  });

  it("stops a start that is still in flight without treating it as a failure", async () => {
    let release!: () => void;
    const stopped = vi.fn(async () => {});
    const { service } = makeService({
      startListener: (signal) =>
        new Promise<HostListener>((resolve) => {
          release = () =>
            resolve({
              socketPath: "/x",
              isListening: () => !signal.aborted,
              attachedClients: () => [],
              onChange: () => () => {},
              stop: stopped,
            });
        }),
    });
    const starting = service.startListening();
    const stopping = service.stopListening();
    release();
    await expect(starting).resolves.toBeUndefined();
    await stopping;
    expect(stopped).toHaveBeenCalled();
    expect((await service.getStatus()).listening).toBe(false);
  });

  it("pushes status changes to the renderer", async () => {
    const { service, pushes } = makeService();
    await service.setEnabled({ enabled: true });
    await waitFor(() => pushes.some((p) => p.listening));
    await service.setEnabled({ enabled: false });
    await waitFor(() => pushes.at(-1)?.listening === false && pushes.at(-1)?.enabled === false);
  });

  it("dispose on quit closes the socket but keeps the setting and start at login", async () => {
    const fs = memoryFs();
    const { run } = scriptedRunner();
    const controller = createSystemdUserController({
      homeDir: "/home/greg",
      packaged: true,
      userName: "greg",
      target: { executable: "/opt/Daintree/daintree", appPath: null },
      run,
      fs,
    });
    const { service, settings } = makeService({ startAtLogin: controller });
    await service.setEnabled({ enabled: true, startAtLogin: true });
    await service.dispose();
    expect(existsSync(location.socketPath)).toBe(false);
    expect(settings()).toEqual({ enabled: true, startAtLogin: true });
    expect(fs.files.size).toBe(1);
  });
});

describe("HostModeService start at login consent", () => {
  const unitPath = "/home/greg/.config/systemd/user/daintree-host.service";

  function withSystemd(outputs: Record<string, Partial<CommandResult>> = {}) {
    const fs = memoryFs();
    const runner = scriptedRunner(outputs);
    const controller = createSystemdUserController({
      homeDir: "/home/greg",
      packaged: true,
      userName: "greg",
      target: { executable: "/opt/Daintree/daintree", appPath: null },
      run: runner.run,
      fs,
    });
    return { fs, runner, controller };
  }

  it("writes no unit unless the user said yes", async () => {
    const { fs, runner, controller } = withSystemd();
    const { service, settings } = makeService({ startAtLogin: controller, run: runner.run });
    const status = await service.setEnabled({ enabled: true });
    expect(fs.files.size).toBe(0);
    expect(
      runner.calls.filter((c) => c.includes("enable ") || c.includes("daemon-reload"))
    ).toEqual([]);
    expect(settings().startAtLogin).toBe(false);
    expect(status.startAtLogin).toBe(false);
  });

  it("installs the exact unit and enables it on consent, and removes it when Host mode goes off", async () => {
    const { fs, runner, controller } = withSystemd({
      "systemctl --user is-enabled daintree-host.service": { stdout: "enabled\n" },
      "loginctl show-user greg -p Linger": { stdout: "Linger=no\n" },
    });
    const { service } = makeService({ startAtLogin: controller, run: runner.run });

    const on = await service.setEnabled({ enabled: true, startAtLogin: true });
    expect(fs.files.get(unitPath)).toBe(
      buildSystemdUnit({ programArguments: ["/opt/Daintree/daintree", "--host-mode"] })
    );
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        "systemctl --user daemon-reload",
        "systemctl --user enable daintree-host.service",
      ])
    );
    // Never started from here (this process is the host), never with sudo.
    expect(runner.calls.some((c) => c.includes(" start ") || c.startsWith("sudo"))).toBe(false);
    expect(on.startAtLogin).toBe(true);
    expect(row(on, "start-at-login")).toMatchObject({
      state: "warning",
      command: "loginctl enable-linger greg",
    });

    // An omitted value keeps the earlier yes.
    await service.setEnabled({ enabled: true });
    expect(fs.files.has(unitPath)).toBe(true);

    runner.calls.length = 0;
    const off = await service.setEnabled({ enabled: false });
    expect(fs.files.has(unitPath)).toBe(false);
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        "systemctl --user disable daintree-host.service",
        "systemctl --user daemon-reload",
      ])
    );
    expect(runner.calls.some((c) => c.includes(" stop "))).toBe(false);
    expect(off.startAtLogin).toBe(false);

    // Turning back on asks again: the earlier yes was cleared with Host mode.
    await service.setEnabled({ enabled: true });
    expect(fs.files.has(unitPath)).toBe(false);
  });

  it("switching start at login off alone removes the unit and keeps listening", async () => {
    const { fs, runner, controller } = withSystemd();
    const { service } = makeService({ startAtLogin: controller, run: runner.run });
    await service.setEnabled({ enabled: true, startAtLogin: true });
    const status = await service.setEnabled({ enabled: true, startAtLogin: false });
    expect(fs.files.has(unitPath)).toBe(false);
    expect(status).toMatchObject({ enabled: true, listening: true, startAtLogin: false });
  });

  it("keeps Host mode on and says why when the unit can't be enabled", async () => {
    const { fs, runner, controller } = withSystemd({
      "systemctl --user daemon-reload": {
        code: 1,
        stderr: "Failed to connect to bus: No medium found\n",
      },
    });
    const { service, settings } = makeService({ startAtLogin: controller, run: runner.run });
    const status = await service.setEnabled({ enabled: true, startAtLogin: true });
    expect(status.listening).toBe(true);
    expect(settings()).toEqual({ enabled: true, startAtLogin: false });
    // No half-installed unit is left behind a setting that says off.
    expect(fs.files.has(unitPath)).toBe(false);
    expect(row(status, "start-at-login")).toMatchObject({
      state: "unavailable",
      detail:
        "Couldn't set up start at login: systemctl --user daemon-reload failed (exit 1): Failed to connect to bus: No medium found",
    });
  });
});

describe("HostModeService on quit and failed removal", () => {
  it("installs nothing once disposed mid-change", async () => {
    const fs = memoryFs();
    const controller = createSystemdUserController({
      homeDir: "/home/greg",
      packaged: true,
      userName: "greg",
      target: { executable: "/opt/Daintree/daintree", appPath: null },
      run: scriptedRunner().run,
      fs,
    });
    let release!: () => void;
    const { service } = makeService({
      startAtLogin: controller,
      startListener: async (signal) => {
        await new Promise<void>((resolve) => (release = resolve));
        return realListener(signal);
      },
    });
    const enabling = service.setEnabled({ enabled: true, startAtLogin: true });
    await waitFor(() => typeof release === "function");
    const disposing = service.dispose();
    release();
    await enabling.catch(() => {});
    await disposing;
    expect(fs.files.size).toBe(0);
    expect(existsSync(location.socketPath)).toBe(false);
  });

  it("reports a unit it couldn't remove when switched off", async () => {
    const fs = memoryFs();
    const controller = createSystemdUserController({
      homeDir: "/home/greg",
      packaged: true,
      userName: "greg",
      target: { executable: "/opt/Daintree/daintree", appPath: null },
      run: scriptedRunner().run,
      fs: { ...fs, remove: async () => Promise.reject(new Error("EACCES")) },
    });
    const { service } = makeService({ startAtLogin: controller });
    await service.setEnabled({ enabled: true, startAtLogin: true });
    await expect(service.setEnabled({ enabled: false })).rejects.toThrow(
      "Start at login couldn't be removed from /home/greg/.config/systemd/user/daintree-host.service: EACCES"
    );
    expect(existsSync(location.socketPath)).toBe(false);
  });
});

describe("HostModeService status rows", () => {
  it("reads macOS sleep settings from pmset and offers the command to copy", async () => {
    const { run } = scriptedRunner({
      "pmset -g": {
        stdout:
          "System-wide power settings:\nCurrently in use:\n standby              1\n disksleep            10\n sleep                1 (sleep prevented by coreaudiod)\n displaysleep         10\n",
      },
    });
    const { service } = makeService({ platform: "darwin", run });
    const status = await service.getStatus();
    expect(row(status, "sleep")).toEqual({
      id: "sleep",
      state: "warning",
      detail: "System sleep after 1 min, disk sleep after 10 min (pmset -g)",
      command: "sudo pmset -a sleep 0 disksleep 0",
    });
    // Nothing prompted on macOS until the check is run.
    expect(row(status, "keychain")).toMatchObject({ state: "unknown", detail: "Not checked yet" });
  });

  it("classifies a headless Linux keyring without touching it", async () => {
    const encrypt = vi.fn(async (text: string) => Buffer.from(text));
    const { service } = makeService({
      keychain: fakeKeychain({
        secretTier: () => "unavailable",
        getSelectedStorageBackend: () => "basic_text",
        encryptStringAsync: encrypt,
      }),
    });
    expect(row(await service.getStatus(), "keychain")).toMatchObject({
      state: "unavailable",
      detail: NO_KEYRING_DETAIL,
    });
    expect(row(await service.runKeychainPreflight(), "keychain").detail).toBe(NO_KEYRING_DETAIL);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("runs the keychain check when Host mode is first switched on", async () => {
    const { service, pushes } = makeService();
    await service.setEnabled({ enabled: true });
    await waitFor(() => pushes.some((p) => row(p, "keychain").state === "ok"));
  });

  it("reports no attached machines while nothing is connected", async () => {
    const { service } = makeService();
    await service.setEnabled({ enabled: true });
    expect(row(await service.getStatus(), "drivers")).toMatchObject({
      state: "unknown",
      detail: "No other machines attached",
    });
  });
});

describe("HostModeService enabling from host setup", () => {
  it("switches Host mode on for good: saved, start at login installed, keychain checked and recorded", async () => {
    const fs = memoryFs();
    const { run, calls } = scriptedRunner({
      "systemctl --user is-enabled daintree-host.service": { stdout: "enabled\n" },
      "loginctl show-user greg -p Linger": { stdout: "Linger=yes\n" },
    });
    const recorded: unknown[] = [];
    const { service, settings } = makeService({
      startAtLogin: createSystemdUserController({
        homeDir: "/home/greg",
        packaged: true,
        userName: "greg",
        target: { executable: "/opt/Daintree/daintree", appPath: null },
        run,
        fs,
      }),
      run,
      writeStatus: async (observation) => void recorded.push(observation),
    });

    await service.enableFromSetup();
    expect(settings()).toEqual({ enabled: true, startAtLogin: true });
    expect(fs.files.get("/home/greg/.config/systemd/user/daintree-host.service")).toBe(
      buildSystemdUnit({ programArguments: ["/opt/Daintree/daintree", "--host-mode"] })
    );
    expect(calls).toContain("systemctl --user enable daintree-host.service");
    await waitFor(() =>
      recorded.some((r) => (r as { keychain: { checked: boolean } }).keychain.checked)
    );
    expect(recorded.at(-1)).toEqual({
      enabled: true,
      startAtLogin: true,
      startAtLoginInstalled: true,
      startAtLoginError: null,
      keychain: {
        state: "ok",
        detail: "Keyring answered a test encrypt and decrypt",
        checked: true,
      },
    });
  });

  it("records a start-at-login failure in the host's words, and records nothing twice", async () => {
    const recorded: Array<{ startAtLoginError: string | null; startAtLogin: boolean }> = [];
    const { service } = makeService({
      startAtLogin: {
        kind: "systemd-user",
        path: "/home/greg/.config/systemd/user/daintree-host.service",
        install: async () => {
          throw new Error("systemctl --user daemon-reload failed: Failed to connect to bus");
        },
        remove: async () => {},
        isInstalled: async () => false,
        observe: async () => ({
          kind: "systemd-user",
          path: "/x",
          installed: false,
          current: false,
          unitState: null,
          linger: null,
          userName: "greg",
        }),
      },
      writeStatus: async (observation) => void recorded.push(observation),
    });
    await service.enableFromSetup();
    await waitFor(() => recorded.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const last = recorded.at(-1)!;
    expect(last.startAtLogin).toBe(false);
    expect(last.startAtLoginError).toContain("Failed to connect to bus");
    const texts = recorded.map((r) => JSON.stringify(r));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("records nothing for a user who never touches Host mode", async () => {
    const writeStatus = vi.fn(async () => {});
    const { service } = makeService({ writeStatus });
    await service.getStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeStatus).not.toHaveBeenCalled();
  });
});
