import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostModeStatus } from "../../../shared/types/ipc/hostMode.js";
import {
  bootstrapHostMode,
  ENABLE_LINGER_SCRIPT,
  MAC_ENABLE_SCRIPT,
} from "../client/hostModeBootstrap.js";
import { remoteSha256Script } from "../client/hostInstaller.js";
import {
  buildHostProbeScript,
  parseHostProbe,
  probeHost,
  type ProbeOutcome,
} from "../client/hostProbe.js";
import { createSshCommandChannel, type HostCommandChannel } from "../client/remoteShell.js";
import { controlPathFor } from "../client/sshTransport.js";
import type { HostListener } from "../host/hostListener.js";
import { HostModeService } from "../host/HostModeService.js";
import { writeHostModeStatusFile } from "../host/hostModeStatusFile.js";
import { HostServer } from "../host/HostServer.js";
import { remoteHostSocketLocation } from "../host/hostSocketPath.js";
import { createLaunchAgentController, systemdUnitFor } from "../host/startAtLogin.js";
import { TEST_HANDSHAKE } from "../link/__tests__/linkTestUtils.js";
import {
  makeShortTempRoot,
  SSH_ALIAS,
  startPrivateSshd,
  type PrivateSshd,
} from "./harness/privateSshd.js";

/**
 * Host setup's commands over the real `ssh` into a private user-mode sshd
 * with a temp HOME: file delivery and its checksum, the Linux Host mode
 * bootstrap (with stand-ins for systemctl, loginctl and the AppImage on the
 * session's PATH, since this machine has no systemd), and on macOS the whole
 * enable-and-read-back against a real HostModeService writing its
 * LaunchAgent into the temp HOME. Opt-in with DAINTREE_SSH_E2E=1.
 */

const ENABLED = process.env.DAINTREE_SSH_E2E === "1";
const TEST_TIMEOUT_MS = 90_000;

let root: string;
let sshd: PrivateSshd | null = null;
let channel: HostCommandChannel;
let controlPath: string;
let callsLog: string;
let binDir: string;

/** A stand-in tool that records how it was called, and answers as told. */
async function standIn(name: string, body = "exit 0"): Promise<void> {
  const file = path.join(binDir, name);
  await fs.writeFile(
    file,
    `#!/bin/sh\nprintf '%s\\n' "${name} $* [extract=\${APPIMAGE_EXTRACT_AND_RUN:-}]" >> '${callsLog}'\n${body}\n`,
    { mode: 0o755 }
  );
}

/** State the systemctl stand-in keeps: a file present means active. */
function unitState(): string {
  return path.join(root, "sysd");
}

/** A systemctl that links on enable as the real one does, remembers start/stop, and answers is-active. */
function statefulSystemctl(): string {
  const dir = unitState();
  return [
    `mkdir -p '${dir}'`,
    `case "$2" in`,
    `enable) mkdir -p "$HOME/.config/systemd/user/default.target.wants" && ln -sf ../daintree-host.service "$HOME/.config/systemd/user/default.target.wants/daintree-host.service" ;;`,
    `disable) rm -f "$HOME/.config/systemd/user/default.target.wants/daintree-host.service" ;;`,
    `start) touch '${dir}/active' ;;`,
    `stop) rm -f '${dir}/active' ;;`,
    `is-active) if [ -f '${dir}/active' ]; then echo active; else echo inactive; exit 3; fi ;;`,
    `esac`,
    `exit 0`,
  ].join("\n");
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

const BUILD_INFO = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';

/** A Linux probe as the host would answer it, for an AppImage without FUSE. */
function linuxOutcome(image: string, lines: string[]): ProbeOutcome {
  const parsed = parseHostProbe(
    [
      "@@dt:uname Linux x86_64",
      `@@dt:appimage ${image}`,
      `@@dt:appimageinfo ${BUILD_INFO}`,
      "@@dt:linger Linger=yes",
      "@@dt:fuse no",
      ...lines,
      "@@dt:end",
    ].join("\n")
  );
  return {
    parsed,
    result: {
      connection: { kind: "ssh", target: SSH_ALIAS },
      reachable: true,
      sshError: null,
      platform: parsed.platform,
      arch: parsed.arch,
      install: parsed.install,
      hostModeListening: parsed.hostModeListening,
      suggestedCommands: [],
      appRunning: parsed.appRunning,
      appImages: parsed.appImages,
      canDownload: false,
      matchesClient: true,
      advice: parsed.advice,
      hostModeState: parsed.hostModeState,
    },
  };
}

async function calls(): Promise<string[]> {
  const text = await fs.readFile(callsLog, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

describe.skipIf(!ENABLED)(
  "host setup over the real ssh transport and a private sshd (skipped unless DAINTREE_SSH_E2E=1)",
  () => {
    beforeAll(async () => {
      root = await makeShortTempRoot();
      binDir = path.join(root, "bin");
      callsLog = path.join(root, "calls.log");
      await fs.mkdir(binDir, { recursive: true });
      sshd = await startPrivateSshd(root, {
        env: { PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin` },
      });
      const clientDir = path.join(root, "c");
      await fs.mkdir(clientDir, { recursive: true, mode: 0o700 });
      controlPath = controlPathFor(clientDir, SSH_ALIAS);
      channel = createSshCommandChannel({
        target: SSH_ALIAS,
        controlPath,
        run: sshd.runCommand,
      });
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (sshd) {
        await sshd.runSsh(["-o", `ControlPath=${controlPath}`, "-O", "exit", SSH_ALIAS]);
        await sshd.stop();
      }
      if (root) await fs.rm(root, { recursive: true, force: true });
    }, TEST_TIMEOUT_MS);

    it(
      "delivers a build over ssh (stdin when scp can't) and its sha256 reads back the same",
      async () => {
        const local = path.join(root, "artifact.bin");
        const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17);
        await fs.writeFile(local, bytes);
        const remote = path.join(sshd!.home, "stage", "Daintree.AppImage");
        await fs.mkdir(path.dirname(remote), { recursive: true });

        const sent = await channel.sendFile(local, remote, { timeoutMs: 60_000 });
        expect(sent.code, sent.stderr).toBe(0);
        expect((await fs.readFile(remote)).equals(bytes)).toBe(true);

        const hashed = await channel.exec(remoteSha256Script(remote), { timeoutMs: 60_000 });
        expect(hashed.code, hashed.stderr).toBe(0);
        const expected = crypto.createHash("sha256").update(bytes).digest("hex");
        expect(hashed.stdout).toContain(`@@dt:sha256 ${expected}`);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "bootstraps a headless Linux AppImage host: unit written and enabled, linger asked for, started, then handed --enable-host-mode",
      async () => {
        await fs.rm(callsLog, { force: true });
        const image = path.join(root, "apps", "Daintree.AppImage");
        await fs.mkdir(path.dirname(image), { recursive: true });
        await standIn("systemctl");
        await standIn(
          "loginctl",
          "echo 'Could not enable linger: Interactive authentication required.' >&2; exit 1"
        );
        await fs.writeFile(
          image,
          `#!/bin/sh\nprintf '%s\\n' "appimage $* [extract=\${APPIMAGE_EXTRACT_AND_RUN:-}]" >> '${callsLog}'\nexit 0\n`,
          { mode: 0o755 }
        );
        const build = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';
        const linux = (lines: string[]) =>
          [
            "@@dt:uname Linux x86_64",
            `@@dt:appimage ${image}`,
            `@@dt:appimageinfo ${build}`,
            "@@dt:linger Linger=no",
            "@@dt:fuse no",
            ...lines,
            "@@dt:end",
          ].join("\n");
        const outcome = (lines: string[]): ProbeOutcome => {
          const parsed = parseHostProbe(linux(lines));
          return {
            parsed,
            result: {
              connection: { kind: "ssh", target: SSH_ALIAS },
              reachable: true,
              sshError: null,
              platform: parsed.platform,
              arch: parsed.arch,
              install: parsed.install,
              hostModeListening: parsed.hostModeListening,
              suggestedCommands: [],
              appRunning: parsed.appRunning,
              appImages: parsed.appImages,
              canDownload: false,
              matchesClient: true,
              advice: parsed.advice,
              hostModeState: parsed.hostModeState,
            },
          };
        };
        const state = JSON.stringify({
          daintreeHostMode: 1,
          pid: 77,
          enabled: true,
          startAtLogin: true,
          startAtLoginInstalled: true,
          startAtLoginError: null,
          keychain: { state: "unavailable", detail: "no keyring (headless)", checked: true },
        });
        // What the host would report as it comes up; the commands themselves go over ssh.
        const reports = [
          outcome([
            "@@dt:unit yes",
            "@@dt:unitenabled enabled",
            "@@dt:listening yes",
            "@@dt:hostpid 77",
          ]),
          outcome([
            "@@dt:unit yes",
            "@@dt:unitenabled enabled",
            "@@dt:listening yes",
            "@@dt:hostpid 77",
            `@@dt:hostmodestate ${state}`,
          ]),
        ];
        const result = await bootstrapHostMode(
          { kind: "ssh", target: SSH_ALIAS },
          outcome(["@@dt:unit no"]),
          {
            channel,
            probe: async () => (reports.length > 1 ? reports.shift()! : reports[0]!),
            sleep: async () => {},
          }
        );

        const target = { executable: image, appPath: null, appImageExtractAndRun: true };
        const unit = await fs.readFile(
          path.join(sshd!.home, ".config", "systemd", "user", "daintree-host.service"),
          "utf8"
        );
        expect(unit).toBe(systemdUnitFor(target));
        expect(unit).toContain("Environment=APPIMAGE_EXTRACT_AND_RUN=1");
        expect(await calls()).toEqual([
          `loginctl ${ENABLE_LINGER_SCRIPT.split(" ").slice(1).join(" ")} [extract=]`,
          "systemctl --user daemon-reload [extract=]",
          "systemctl --user enable daintree-host.service [extract=]",
          "systemctl --user start daintree-host.service [extract=]",
          "appimage --host-mode --enable-host-mode --host-mode-handoff [extract=1]",
        ]);
        expect(result.lingerRefused).toBe(
          "Could not enable linger: Interactive authentication required."
        );
      },
      TEST_TIMEOUT_MS
    );

    it.each([
      { enabled: false, active: false },
      { enabled: true, active: true },
    ])(
      "puts back the unit that was there, enabled=$enabled active=$active, when setup fails",
      async ({ enabled, active }) => {
        await fs.rm(callsLog, { force: true });
        await fs.rm(unitState(), { recursive: true, force: true });
        await fs.mkdir(unitState(), { recursive: true });
        if (active) await fs.writeFile(path.join(unitState(), "active"), "");
        await standIn("systemctl", statefulSystemctl());
        const image = path.join(root, "apps", "Daintree.AppImage");
        await fs.mkdir(path.dirname(image), { recursive: true });
        // The running Daintree refuses the request.
        await fs.writeFile(image, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const unitDir = path.join(sshd!.home, ".config", "systemd", "user");
        const unitFile = path.join(unitDir, "daintree-host.service");
        await fs.mkdir(unitDir, { recursive: true });
        const earlier =
          "[Unit]\nDescription=the user's own, kept as it was\n\n[Service]\nExecStart=/bin/true\n";
        await fs.writeFile(unitFile, earlier);
        await fs.chmod(unitFile, 0o600);
        const wantsLink = path.join(unitDir, "default.target.wants", "daintree-host.service");
        const manualLink = path.join(
          unitDir,
          "graphical-session.target.wants",
          "daintree-host.service"
        );
        await fs.rm(wantsLink, { force: true });
        await fs.rm(manualLink, { force: true });
        await fs.mkdir(path.dirname(wantsLink), { recursive: true });
        await fs.mkdir(path.dirname(manualLink), { recursive: true });
        if (enabled) await fs.symlink("../daintree-host.service", wantsLink);
        // Linked by hand elsewhere: setup has no business with it either way.
        await fs.symlink("../daintree-host.service", manualLink);
        // Left by an earlier setup whose undo never ran: kept, never overwritten.
        for (const name of await fs.readdir(unitDir)) {
          if (name.includes(".daintree-setup-backup.")) await fs.rm(path.join(unitDir, name));
        }
        await fs.writeFile(`${unitFile}.daintree-setup-backup`, "an earlier copy\n");

        const listening = linuxOutcome(image, [
          "@@dt:unit yes",
          "@@dt:listening yes",
          "@@dt:hostpid 77",
        ]);
        await expect(
          bootstrapHostMode(
            { kind: "ssh", target: SSH_ALIAS },
            linuxOutcome(image, ["@@dt:unit yes"]),
            {
              channel,
              probe: async () => listening,
              sleep: async () => {},
            }
          )
        ).rejects.toThrow(/didn't take the request/);

        expect(await fs.readFile(unitFile, "utf8")).toBe(earlier);
        expect((await fs.stat(unitFile)).mode & 0o777).toBe(0o600);
        expect(await exists(`${unitFile}.daintree-setup-backup`)).toBe(false);
        const kept = (await fs.readdir(unitDir)).filter((n) =>
          n.startsWith("daintree-host.service.daintree-setup-backup.")
        );
        expect(kept).toHaveLength(1);
        expect(await fs.readFile(path.join(unitDir, kept[0]!), "utf8")).toBe("an earlier copy\n");
        expect(
          await fs.lstat(wantsLink).then(
            () => true,
            () => false
          )
        ).toBe(enabled);
        expect(await fs.readlink(manualLink)).toBe("../daintree-host.service");
        expect(await exists(path.join(unitState(), "active"))).toBe(active);
        // Setup did replace, enable and start it before putting it back.
        const seen = await calls();
        expect(seen).toContain("systemctl --user enable daintree-host.service [extract=]");
        expect(seen).toContain("systemctl --user start daintree-host.service [extract=]");
      },
      TEST_TIMEOUT_MS
    );

    it(
      "doesn't count another user's Daintree as running on a Linux host",
      async () => {
        // pgrep sees a daintree, but only when asked about every user.
        await standIn("pgrep", `case " $* " in *" -u "*) exit 1 ;; esac\necho 4242\nexit 0`);
        await standIn(
          "uname",
          `case "$1" in -s) echo Linux ;; *) echo 'Linux x86_64' ;; esac\nexit 0`
        );
        try {
          const anyone = await channel.exec("pgrep -x daintree", { timeoutMs: 30_000 });
          expect(anyone.code).toBe(0);
          const ran = await channel.exec(buildHostProbeScript(), { timeoutMs: 60_000 });
          expect(ran.code, ran.stderr).toBe(0);
          const parsed = parseHostProbe(ran.stdout);
          expect(parsed.platform).toBe("linux");
          expect(parsed.complete).toBe(true);
          expect(parsed.appRunning).toBe(false);
        } finally {
          await fs.rm(path.join(binDir, "pgrep"), { force: true });
          await fs.rm(path.join(binDir, "uname"), { force: true });
        }
      },
      TEST_TIMEOUT_MS
    );

    it.runIf(process.platform === "darwin")(
      "switches a Mac host on for good and reads back the saved setting and its LaunchAgent over ssh",
      async (ctx) => {
        await fs.rm(callsLog, { force: true });
        await standIn("open");
        // The probe reads the real /Applications/Daintree.app, so the "client" is whatever is there.
        const first = await probeHost({
          connection: { kind: "ssh", target: SSH_ALIAS },
          shell: channel,
          client: TEST_HANDSHAKE,
        });
        expect(first.result.reachable, first.result.sshError ?? "").toBe(true);
        const install = first.result.install;
        if (!install?.version) {
          ctx.skip();
          return;
        }
        const client = { version: install.version, commit: install.commit ?? "" };

        const location = remoteHostSocketLocation({
          platform: "darwin",
          uid: process.getuid!(),
          home: sshd!.home,
        });
        let settings = { enabled: false, startAtLogin: false };
        const service = new HostModeService({
          platform: "darwin",
          readSettings: () => settings,
          writeSettings: (next) => {
            settings = next;
          },
          socketPath: location.socketPath,
          startListener: async (): Promise<HostListener> => {
            const server = new HostServer({
              location,
              handshake: TEST_HANDSHAKE,
              hostName: "e2e",
              session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
            });
            await server.listen();
            return {
              socketPath: location.socketPath,
              isListening: () => server.isListening,
              attachedClients: () => [],
              onChange: () => () => {},
              stop: () => server.close(),
            };
          },
          startAtLogin: createLaunchAgentController({
            homeDir: sshd!.home,
            packaged: true,
            bundleId: "org.daintree.app",
            target: {
              executable: "/Applications/Daintree.app/Contents/MacOS/Daintree",
              appPath: null,
            },
          }),
          createAdvertiser: () => ({
            start: () => {},
            stop: () => {},
            getState: () => ({ status: "off" }),
          }),
          keychain: {
            secretTier: () => "keychain",
            getSelectedStorageBackend: () => "keychain",
            isAsyncEncryptionAvailable: async () => true,
            encryptStringAsync: async (text) => Buffer.from(text),
            decryptStringAsync: async (buf) => ({ result: buf.toString() }),
          },
          run: async () => ({ code: 1, stdout: "", stderr: "" }),
          broadcast: (_status: HostModeStatus) => {},
          pushDelayMs: 0,
          writeStatus: (observation) =>
            writeHostModeStatusFile(location.dir, { pid: process.pid, ...observation }),
        });
        try {
          // Listening for this run only, as a bare --host-mode launch leaves it.
          await service.startListening();
          const probe = () =>
            probeHost({ connection: { kind: "ssh", target: SSH_ALIAS }, shell: channel, client });
          const before = await probe();
          expect(before.result.hostModeListening).toBe(true);

          // LaunchServices hands `open -n … --enable-host-mode` to the running app.
          const toHost: HostCommandChannel = {
            ...channel,
            async exec(script, options) {
              const ran = await channel.exec(script, options);
              if (script === MAC_ENABLE_SCRIPT && ran.code === 0) void service.enableFromSetup();
              return ran;
            },
          };
          const result = await bootstrapHostMode({ kind: "ssh", target: SSH_ALIAS }, before, {
            channel: toHost,
            probe,
            sleep: () => new Promise((resolve) => setTimeout(resolve, 100)),
          });

          expect(await calls()).toEqual([
            "open -n -g -a /Applications/Daintree.app --args --host-mode --enable-host-mode [extract=]",
          ]);
          expect(settings).toEqual({ enabled: true, startAtLogin: true });
          expect(result.probe.hostModeState).toMatchObject({
            pid: process.pid,
            enabled: true,
            startAtLogin: true,
            startAtLoginInstalled: true,
            keychain: { state: "ok", checked: true },
          });
          expect(result.probe.advice.startAtLoginInstalled).toBe(true);
          const plist = await fs.readFile(
            path.join(sshd!.home, "Library", "LaunchAgents", "org.daintree.app.host.plist"),
            "utf8"
          );
          expect(plist).toContain("<string>--host-mode</string>");
        } finally {
          await service.dispose();
        }
      },
      TEST_TIMEOUT_MS
    );
  }
);
