import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostSetupService } from "../client/HostSetupService.js";
import { closeSshMaster } from "../client/sshTransport.js";
import { appImageArch, readAppImageMarker } from "./harness/containerHost.js";
import {
  createVolume,
  disarmWatchdog,
  dockerArch,
  exec,
  remainingContainers,
  remainingVolumes,
  removeVolumes,
  requireDocker,
} from "./harness/docker.js";
import {
  hostImageUnderTest,
  IMAGE_USER,
  makeHostKey,
  startImageHost,
  writeSecrets,
  type ImageHost,
  type ImageInputs,
} from "./harness/hostImage.js";
import { connectLink, expectWorkingTerminal } from "./harness/hostLink.js";
import { listProcesses, makeShortTempRoot } from "./harness/privateSshd.js";
import { makeUserKey } from "./harness/sshRoute.js";

/**
 * The published Host image (build/host-image, docs/host-image.md) as a
 * container cloud runs it: its own entrypoint, its keys from the environment
 * or a read-only secrets volume, no systemd, no FUSE, no `--privileged` and no
 * `--init`. The last scenario runs Daintree's own Host setup against it, from
 * a bare machine through to a started Host and a working terminal.
 *
 * Opt-in with DAINTREE_CONTAINER_E2E=1 and DAINTREE_CONTAINER_E2E_APPIMAGE
 * naming a packaged Linux build of the Docker daemon's architecture;
 * DAINTREE_HOST_IMAGE names an image already built (the publish workflow's),
 * else it's built here. See docs/development.md#host-install-end-to-end.
 */

const ENABLED = process.env.DAINTREE_CONTAINER_E2E === "1";
const APPIMAGE = process.env.DAINTREE_CONTAINER_E2E_APPIMAGE ?? "";
const SETUP_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const INSTALLED_PATH = "Applications/Daintree.AppImage";
/** Where a host with no init system listens (see host/hostSocketPath.ts). */
const HOST_DIR = ".cache/daintree/run";
const HOST_KEY = "/etc/ssh/daintree/ssh_host_key";
const DEVICE_ID = crypto.randomUUID();

let root: string;
let image: string;
let arch: "arm64" | "x64";
let version: string;
let commit: string;
const hosts: ImageHost[] = [];
const volumes: string[] = [];

function report(line: string): void {
  // vitest.config drops console output.
  process.stdout.write(`[host-image-e2e] ${line}\n`);
}

async function userKey(name: string): Promise<{ file: string; publicKey: string }> {
  const file = await makeUserKey(path.join(root, name));
  return { file, publicKey: (await fs.readFile(`${file}.pub`, "utf8")).trim() };
}

async function start(
  inputs: ImageInputs & { userKey: string; hostPublicKey?: string }
): Promise<ImageHost> {
  const host = await startImageHost(image, inputs);
  hosts.push(host);
  return host;
}

async function volume(files: Record<string, string>): Promise<string> {
  const name = await createVolume();
  volumes.push(name);
  await writeSecrets(image, name, files);
  return name;
}

/** known_hosts holding `publicKey` under the name the harness pins it by. */
async function pinning(publicKey: string): Promise<string> {
  const file = path.join(root, `known_hosts-${crypto.randomBytes(4).toString("hex")}`);
  await fs.writeFile(file, `daintree-host-image ${publicKey}\n`);
  return file;
}

/** sshd's settings as it applies them: `name` → every value it has. */
async function effectiveConfig(host: ImageHost): Promise<Map<string, string[]>> {
  const settings = new Map<string, string[]>();
  for (const line of (await host.rootShell("sshd -T")).split("\n")) {
    const [name, ...value] = line.trim().split(" ");
    if (!name) continue;
    settings.set(name, [...(settings.get(name) ?? []), value.join(" ")]);
  }
  return settings;
}

/** Prints what the machine saw when a scenario fails: the failure alone rarely says why. */
async function withDiagnostics(host: ImageHost, scenario: () => Promise<void>): Promise<void> {
  try {
    await scenario();
  } catch (err) {
    report(await host.diagnostics().catch((e: unknown) => `(no diagnostics: ${String(e)})`));
    throw err;
  }
}

describe.skipIf(!ENABLED)(
  "the published Host image (skipped unless DAINTREE_CONTAINER_E2E=1)",
  () => {
    beforeAll(async () => {
      if (!APPIMAGE) {
        throw new Error(
          "DAINTREE_CONTAINER_E2E_APPIMAGE must name a packaged Linux AppImage (see docs/development.md#host-install-end-to-end)"
        );
      }
      await fs.access(APPIMAGE);
      await requireDocker();
      arch = await dockerArch();
      const imageArch = await appImageArch(APPIMAGE);
      if (imageArch !== arch) {
        throw new Error(`${APPIMAGE} is a ${imageArch} build, but containers here run as ${arch}`);
      }
      root = await makeShortTempRoot();
      image = await hostImageUnderTest();
      const marker = JSON.parse(await readAppImageMarker(APPIMAGE, image)) as {
        version: string;
        commit: string;
      };
      version = marker.version;
      commit = marker.commit;
      report(`image ${image}; build ${version} ${commit} on ${arch}`);
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await Promise.all(hosts.map((host) => host.dispose()));
      await removeVolumes(volumes);
      if ((await remainingContainers()).length === 0) disarmWatchdog();
      if (root) await fs.rm(root, { recursive: true, force: true });
    }, TEST_TIMEOUT_MS);

    it(
      "won't start without a public key to authorize, or with a host key it can't serve",
      async () => {
        const login = await userKey("refused");
        const privateLogin = await fs.readFile(login.file, "utf8");
        const encrypted = path.join(root, "encrypted");
        // prettier-ignore
        const keygen = await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret", "-C", "", "-f", encrypted]);
        expect(keygen.code).toBe(0);
        const encryptedWithPassphrase = await fs.readFile(encrypted, "utf8");

        const cases: Array<[string, Record<string, string>, RegExp]> = [
          ["nothing", {}, /no authorized key/],
          ["an empty key", { DAINTREE_AUTHORIZED_KEYS: "" }, /set but empty/],
          [
            "a key file that isn't there",
            { DAINTREE_AUTHORIZED_KEYS_FILE: "/run/secrets/missing" },
            /can't be read/,
          ],
          [
            "a private key to authorize",
            { DAINTREE_AUTHORIZED_KEYS: privateLogin },
            /no public key sshd can read/,
          ],
          [
            "an encrypted host key",
            {
              DAINTREE_AUTHORIZED_KEYS: login.publicKey,
              DAINTREE_SSH_HOST_KEY: encryptedWithPassphrase,
            },
            /isn't an unencrypted private key/,
          ],
          [
            "a host key that isn't one",
            { DAINTREE_AUTHORIZED_KEYS: login.publicKey, DAINTREE_SSH_HOST_KEY: "not a key" },
            /isn't an unencrypted private key/,
          ],
        ];
        for (const [label, env, refusal] of cases) {
          const attempt = startImageHost(image, { env, userKey: login.file });
          await expect(attempt, label).rejects.toThrow(/stopped \(exit [1-9]/);
          const message = await attempt.catch((err: Error) => err.message);
          expect(message, label).toMatch(refusal);
          // What it says about a key never includes the key.
          expect(message, label).not.toContain("PRIVATE KEY-----\n");
        }
      },
      TEST_TIMEOUT_MS
    );

    it(
      "serves exactly the host key from its environment, to its one login and that login's key",
      async () => {
        const login = await userKey("env-login");
        const stranger = await userKey("env-stranger");
        const hostKey = await makeHostKey(root, "env-host");
        // As an environment variable carries it: the key's lines, without the last newline.
        const host = await start({
          env: {
            DAINTREE_AUTHORIZED_KEYS: login.publicKey,
            DAINTREE_SSH_HOST_KEY: hostKey.privateKey.trimEnd(),
          },
          userKey: login.file,
          hostPublicKey: hostKey.publicKey,
        });
        await withDiagnostics(host, async () => {
          // It answered with that key already: the route holds it to the pin.
          const pinned = { identity: login.file, knownHosts: host.knownHosts };
          expect(await host.login(pinned)).toMatchObject({ code: 0 });

          const otherKey = await makeHostKey(root, "env-other-host");
          const wrongPin = await host.login({
            ...pinned,
            knownHosts: await pinning(otherKey.publicKey),
          });
          expect(wrongPin.code).not.toBe(0);
          expect(wrongPin.stderr).toMatch(
            /REMOTE HOST IDENTIFICATION HAS CHANGED|verification failed/
          );

          const asRoot = await host.login({ ...pinned, user: "root" });
          expect(asRoot.code).not.toBe(0);
          expect(asRoot.stderr).toMatch(/Permission denied/);
          const otherKeyLogin = await host.login({ ...pinned, identity: stranger.file });
          expect(otherKeyLogin.code).not.toBe(0);
          expect(otherKeyLogin.stderr).toMatch(/Permission denied/);

          const settings = await effectiveConfig(host);
          expect(settings.get("hostkey")).toEqual([HOST_KEY]);
          expect(settings.get("passwordauthentication")).toEqual(["no"]);
          expect(settings.get("kbdinteractiveauthentication")).toEqual(["no"]);
          expect(settings.get("permitemptypasswords")).toEqual(["no"]);
          expect(settings.get("permitrootlogin")).toEqual(["no"]);
          expect(settings.get("authenticationmethods")).toEqual(["publickey"]);
          expect(settings.get("allowusers")).toEqual([IMAGE_USER]);

          expect(await host.shell("id -un; id -u")).toBe(`${IMAGE_USER}\n1500`);
          expect(await host.shell(`cat ${HOST_KEY} 2>&1 || true`)).toMatch(/Permission denied/);
          // Nothing past the entrypoint was handed the keys: not tini, not sshd, not a
          // login. (`docker exec` is, from the container's settings, so it can't look.)
          expect(
            await host.rootShell(
              "for p in 1 $(pgrep -x sshd); do tr '\\0' '\\n' < /proc/$p/environ; done | grep -c '^DAINTREE_' || true"
            )
          ).toBe("0");
          const session = await host.runCommand(
            "ssh",
            [host.target, "env | grep -c '^DAINTREE_' || true"],
            { timeoutMs: 30_000 }
          );
          expect(session).toMatchObject({ code: 0, stdout: "0\n" });
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "takes its keys from mounted secrets, and a restart takes new ones or stops on a bad one",
      async () => {
        const first = await userKey("secret-first");
        const second = await userKey("secret-second");
        const hostKey = await makeHostKey(root, "secret-host");
        // One secret base64-encoded, as a store that keeps one line per value would hold it.
        const secrets = await volume({
          daintree_authorized_keys: `${first.publicKey}\n`,
          daintree_ssh_host_key: Buffer.from(hostKey.privateKey).toString("base64"),
        });
        const host = await start({
          secrets,
          userKey: first.file,
          hostPublicKey: hostKey.publicKey,
        });
        await withDiagnostics(host, async () => {
          expect(await host.shell("cat /run/secrets/daintree_ssh_host_key 2>&1 || true")).toMatch(
            /Permission denied/
          );

          await writeSecrets(image, secrets, {
            daintree_authorized_keys: `${second.publicKey}\n`,
            daintree_ssh_host_key: hostKey.privateKey,
          });
          // Held to the same host key throughout, by the route's pin.
          await host.restart(second.file);
          const pinned = { knownHosts: host.knownHosts };
          expect(await host.login({ ...pinned, identity: second.file })).toMatchObject({
            code: 0,
          });
          const replaced = await host.login({ ...pinned, identity: first.file });
          expect(replaced.code).not.toBe(0);
          expect(replaced.stderr).toMatch(/Permission denied/);

          // A bad key given now isn't covered for by the good one on disk from before.
          await writeSecrets(image, secrets, {
            daintree_authorized_keys: `${second.publicKey}\n`,
            daintree_ssh_host_key: "not a key",
          });
          await expect(host.restart()).rejects.toThrow(/isn't an unencrypted private key/);
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "makes a host key of its own when given none, and keeps it across a restart",
      async () => {
        const login = await userKey("generated-login");
        const env = { DAINTREE_AUTHORIZED_KEYS: login.publicKey };
        const [one, two] = await Promise.all([
          start({ env, userKey: login.file }),
          start({ env, userKey: login.file }),
        ]);
        await withDiagnostics(one, async () => {
          const publicKey = (host: ImageHost) => host.rootShell(`cat ${HOST_KEY}.pub`);
          const before = await publicKey(one);
          expect(before).toMatch(/^ssh-ed25519 /);
          expect(await publicKey(two)).not.toBe(before);
          // Its log names it, for a person checking a first connection.
          const fingerprint = (await one.rootShell(`ssh-keygen -l -f ${HOST_KEY}.pub`)).split(
            " "
          )[1]!;
          expect(await one.logs()).toContain(fingerprint);

          // The route trusted it on first use; a different key now would be refused.
          await one.restart();
          expect(await publicKey(one)).toBe(before);
          expect(
            await one.login({ identity: login.file, knownHosts: one.knownHosts })
          ).toMatchObject({ code: 0 });
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "runs Daintree's Host setup through to a started Host, with no systemd and no FUSE",
      async () => {
        const login = await userKey("setup-login");
        const hostKey = await makeHostKey(root, "setup-host");
        const host = await start({
          env: {
            DAINTREE_AUTHORIZED_KEYS: login.publicKey,
            DAINTREE_SSH_HOST_KEY: hostKey.privateKey,
          },
          userKey: login.file,
          hostPublicKey: hostKey.publicKey,
        });
        await withDiagnostics(host, async () => {
          expect(await host.rootShell("cat /proc/1/comm")).toBe("tini");
          expect(await host.rootShell("ps -o comm= --ppid 1")).toBe("sshd");
          // No FUSE device, no systemd booted, and no login session's runtime directory.
          expect(
            await host.rootShell("ls -d /dev/fuse /run/systemd/system /run/user/1500 2>&1 || true")
          ).not.toMatch(/^\/(dev|run)\//m);
          expect(await host.shell(`ls "$HOME/Applications" 2>/dev/null || true`)).toBe("");

          const stages: string[] = [];
          const setup = new HostSetupService({
            run: host.runCommand,
            clientDir: host.clientDir,
            platform: process.platform,
            knownConnections: () => [host.connection],
            clientBuild: () => ({
              platform: "linux",
              arch,
              version,
              commit,
              channel: "stable",
              bundle: { kind: "appimage", path: APPIMAGE },
            }),
            // What a restart would end isn't this target's business: its scenarios proceed regardless.
            restartImpact: async () => ({ detail: null, agents: null }),
            download: async () => {
              throw new Error("This machine was asked to download a build it pushes");
            },
            checksum: async () => {
              throw new Error(
                "This machine was asked for the feed's checksum of a build it pushes"
              );
            },
            emit: (event) => {
              if (event.type === "install-progress" && event.progress.stage) {
                stages.push(event.progress.stage);
              }
            },
          });

          const before = await setup.probe({ connection: host.connection });
          expect(before.advice).toMatchObject({ systemd: false, fuse: false });
          expect(await setup.planInstall({ connection: host.connection })).toMatchObject({
            kind: "install",
            delivery: "push-bundle",
            packaging: "appimage",
          });
          await expect(
            setup.install({
              opId: crypto.randomUUID(),
              connection: host.connection,
              whileWorking: "proceed",
            })
          ).resolves.toMatchObject({ status: "installed" });
          expect(stages).toContain("copying");
          expect(await host.shell(`test -x "$HOME/${INSTALLED_PATH}" && echo installed`)).toBe(
            "installed"
          );

          const { probe } = await setup.startHostMode({ connection: host.connection });
          expect(probe.hostModeListening).toBe(true);
          expect(probe.matchesClient).toBe(true);
          expect(probe.startsOnConnect).toBe(true);
          expect(probe.hostModeState).toMatchObject({
            enabled: true,
            startMethod: "on-connect",
            startAtLogin: false,
          });
          expect(probe.advice).toMatchObject({ systemd: false, fuse: false, hostModeUnit: false });

          const listening = async () => {
            const record = await host.shell(
              `cat "$HOME/${HOST_DIR}/host.json" 2>/dev/null || true`
            );
            return record ? ((JSON.parse(record) as { pid?: number }).pid ?? null) : null;
          };
          const pid = await listening();
          expect(pid).not.toBeNull();
          // Not a child of the login that started it: that login ending leaves it running.
          await closeSshMaster(host.runCommand, host.clientDir, host.target, 10_000, "ssh");
          expect(await host.shell(`ps -o sid= -p ${pid} | xargs ps -o comm= -p`)).not.toBe("sshd");
          expect(await listening()).toBe(pid);

          const build = { version, commit, arch };
          const first = await connectLink({
            host,
            build,
            clientName: "host-image-e2e",
            deviceId: DEVICE_ID,
          });
          try {
            expect(first.handshake).toMatchObject({ version, commit, platform: "linux", arch });
            // The forward, not the stdio fallback: the image allows socket forwarding.
            expect(first.transport.route).toBe("forward");
            await expectWorkingTerminal(host, first.session);
          } finally {
            await first.link.stop();
          }

          // A restart that keeps the disk, as a provider restarts a container in place:
          // the Host is gone, and a connection starts it again.
          await host.restart();
          expect(await host.shell("pgrep -x daintree || true")).toBe("");
          const again = await connectLink({
            host,
            build,
            clientName: "host-image-e2e",
            deviceId: DEVICE_ID,
            setup,
          });
          try {
            expect(again.handshake).toMatchObject({ version, commit });
            const restarted = await listening();
            expect(restarted).not.toBeNull();
            await expectWorkingTerminal(host, again.session);
          } finally {
            await again.link.stop();
          }
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "leaves nothing behind",
      async () => {
        await Promise.all(hosts.map((host) => host.dispose()));
        await removeVolumes(volumes);
        expect(await remainingContainers()).toEqual([]);
        expect(await remainingVolumes()).toEqual([]);
        const processes = await listProcesses();
        for (const host of hosts) {
          expect(processes.filter((row) => row.command.includes(host.root))).toEqual([]);
        }
      },
      TEST_TIMEOUT_MS
    );
  }
);
