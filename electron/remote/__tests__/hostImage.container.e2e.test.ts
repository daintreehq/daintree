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
 * The published Host image (build/host-image, docs/distribution/host-image.md)
 * as a container cloud runs it: its own entrypoint, its keys from the environment
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

/** Starts every machine and settles every start, so none outlives teardown unrecorded. */
async function startAll(
  all: Array<ImageInputs & { userKey: string; hostPublicKey?: string }>
): Promise<ImageHost[]> {
  const settled = await Promise.allSettled(all.map((inputs) => start(inputs)));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ImageHost>).value);
}

/** `type base64` of a public key line, as `offeredKeys` lists one. */
const keyOf = (publicKey: string) => publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

/** A line from the middle of a key's body: what would show up wherever the key leaked. */
function needle(key: string): string {
  const lines = key.trim().split("\n");
  // A public key's blob, or a line of a private key's armored body.
  if (lines.length === 1) return lines[0]!.split(/\s+/)[1]!.slice(0, 40);
  return lines[Math.floor(lines.length / 2)]!.trim().slice(0, 40);
}

/** As `ssh-keygen -l` prints a key's fingerprint. */
const fingerprintOf = (publicKey: string) =>
  `SHA256:${crypto
    .createHash("sha256")
    .update(Buffer.from(publicKey.trim().split(/\s+/)[1]!, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;

/** What a login through the harness's route prints, as the login. */
async function inSession(host: ImageHost, script: string): Promise<string> {
  const result = await host.runCommand("ssh", [host.target, script], { timeoutMs: 30_000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
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
      // Every cleanup is tried, whatever fails before it; the watchdog stays
      // armed for anything left.
      await Promise.allSettled(hosts.map((host) => host.dispose()));
      await removeVolumes(volumes).catch((err: unknown) => report(String(err)));
      if (root) await fs.rm(root, { recursive: true, force: true });
      const left = await Promise.all([remainingContainers(), remainingVolumes()]);
      if (left.every((ids) => ids.length === 0)) disarmWatchdog();
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

        const badAuthorized =
          "daintree-host: DAINTREE_AUTHORIZED_KEYS isn't public keys sshd can read, one per line, as given or base64-decoded";
        const badHostKey =
          "daintree-host: DAINTREE_SSH_HOST_KEY isn't an unencrypted private key sshd can read, as given or base64-decoded";
        const cases: Array<[string, Record<string, string>, string]> = [
          [
            "nothing",
            {},
            "daintree-host: no authorized key: set DAINTREE_AUTHORIZED_KEYS or mount /run/secrets/daintree_authorized_keys",
          ],
          [
            "an empty key",
            { DAINTREE_AUTHORIZED_KEYS: "" },
            "daintree-host: DAINTREE_AUTHORIZED_KEYS is set but empty",
          ],
          [
            "a key file that isn't there",
            { DAINTREE_AUTHORIZED_KEYS_FILE: "/run/secrets/missing" },
            "daintree-host: DAINTREE_AUTHORIZED_KEYS_FILE names /run/secrets/missing, which isn't a file it can read",
          ],
          [
            "a key file that's a directory",
            { DAINTREE_AUTHORIZED_KEYS: login.publicKey, DAINTREE_SSH_HOST_KEY_FILE: "/etc" },
            "daintree-host: DAINTREE_SSH_HOST_KEY_FILE names /etc, which isn't a file it can read",
          ],
          ["a private key to authorize", { DAINTREE_AUTHORIZED_KEYS: privateLogin }, badAuthorized],
          [
            "a private key to authorize, base64-encoded",
            { DAINTREE_AUTHORIZED_KEYS: Buffer.from(privateLogin).toString("base64") },
            badAuthorized,
          ],
          [
            // ssh-keygen -l alone passes a file when any one line is a key.
            "a public key followed by the lines of a private one",
            {
              DAINTREE_AUTHORIZED_KEYS: `${login.publicKey}\n${privateLogin.split("\n").slice(1, -2).join("\n")}`,
            },
            badAuthorized,
          ],
          [
            "an encrypted host key",
            {
              DAINTREE_AUTHORIZED_KEYS: login.publicKey,
              DAINTREE_SSH_HOST_KEY: encryptedWithPassphrase,
            },
            badHostKey,
          ],
          [
            "a host key that isn't one",
            { DAINTREE_AUTHORIZED_KEYS: login.publicKey, DAINTREE_SSH_HOST_KEY: "not a key" },
            badHostKey,
          ],
        ];
        const secrets = [privateLogin, encryptedWithPassphrase];
        for (const [label, env, refusal] of cases) {
          const attempt = startImageHost(image, { env, userKey: login.file });
          const message = await attempt.then(
            () => "started",
            (err: Error) => err.message
          );
          expect(message, label).toMatch(/^The container stopped \(exit 1\): /);
          const printed = message.replace(/^The container stopped \(exit 1\): /, "");
          expect(printed.trim().split("\n"), label).toEqual([refusal]);
          // What it says about a key never includes the key, in any form.
          for (const secret of secrets) {
            expect(message, label).not.toContain(needle(secret));
            expect(message, label).not.toContain(
              Buffer.from(secret).toString("base64").slice(0, 40)
            );
          }
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

          // The listener offers that key and no other.
          expect(await host.offeredKeys()).toEqual([keyOf(hostKey.publicKey)]);

          // Turned away with public keys the only method offered: no password to try.
          const asRoot = await host.login({ ...pinned, user: "root" });
          expect(asRoot.code).not.toBe(0);
          expect(asRoot.stderr).toMatch(/Permission denied \(publickey\)\./);
          const otherKeyLogin = await host.login({ ...pinned, identity: stranger.file });
          expect(otherKeyLogin.code).not.toBe(0);
          expect(otherKeyLogin.stderr).toMatch(/Permission denied \(publickey\)\./);

          const settings = await effectiveConfig(host);
          expect(settings.get("hostkey")).toEqual([HOST_KEY]);
          expect(settings.get("passwordauthentication")).toEqual(["no"]);
          expect(settings.get("kbdinteractiveauthentication")).toEqual(["no"]);
          expect(settings.get("permitemptypasswords")).toEqual(["no"]);
          expect(settings.get("permitrootlogin")).toEqual(["no"]);
          expect(settings.get("authenticationmethods")).toEqual(["publickey"]);
          expect(settings.get("allowusers")).toEqual([IMAGE_USER]);

          expect(await inSession(host, 'id -un; id -u; id -g; echo "$SHELL"')).toBe(
            `${IMAGE_USER}\n1500\n1500\n/bin/bash`
          );
          expect(await inSession(host, `cat ${HOST_KEY} 2>&1 || true`)).toMatch(
            /Permission denied/
          );
          expect(
            await host.rootShell(
              `stat -c '%U %a %n' /etc/ssh/daintree ${HOST_KEY} /etc/ssh/daintree/authorized_keys`
            )
          ).toBe(
            [
              "root 755 /etc/ssh/daintree",
              `root 600 ${HOST_KEY}`,
              "root 644 /etc/ssh/daintree/authorized_keys",
            ].join("\n")
          );
          // Nothing past the entrypoint was handed the keys, under any name: not tini,
          // not the sshd listener, not a login. (`docker exec` is, from the
          // container's settings, so it reads them and searches nothing of its own.)
          const search = `-e '${needle(hostKey.privateKey)}' -e '${needle(login.publicKey)}'`;
          expect(
            await host.rootShell(
              `set -e; l=$(pgrep -o -x sshd); for p in 1 "$l"; do tr '\\0' '\\n' < /proc/$p/environ > /tmp/environ.$p; done; cat /tmp/environ.* | grep -cF ${search} || true`
            )
          ).toBe("0");
          expect(await inSession(host, `env | grep -cF ${search} || true`)).toBe("0");
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "takes its keys from mounted secrets, and a restart takes new ones or stops on a bad one",
      async () => {
        const first = await userKey("secret-first");
        const second = await userKey("secret-second");
        const third = await userKey("secret-third");
        // A PEM key, named by _FILE, base64-encoded as a store keeping one line per value holds it.
        const hostKey = await makeHostKey(root, "secret-host", "ecdsa-pem");
        const secrets = await volume({
          daintree_authorized_keys: `${first.publicKey}\n`,
          host_key_pem: Buffer.from(hostKey.privateKey).toString("base64"),
        });
        const host = await start({
          secrets,
          env: { DAINTREE_SSH_HOST_KEY_FILE: "/run/secrets/host_key_pem" },
          userKey: first.file,
          hostPublicKey: hostKey.publicKey,
        });
        await withDiagnostics(host, async () => {
          expect(await host.offeredKeys()).toEqual([keyOf(hostKey.publicKey)]);
          expect(await inSession(host, "cat /run/secrets/host_key_pem 2>&1 || true")).toMatch(
            /Permission denied/
          );

          // Two keys now, with a comment and a blank line between them, and the first gone.
          await writeSecrets(image, secrets, {
            daintree_authorized_keys: `# rotated\n${second.publicKey}\n\n${third.publicKey}\n`,
            host_key_pem: hostKey.privateKey,
          });
          // Held to the same host key throughout, by the route's pin.
          await host.restart(second.file);
          const pinned = { knownHosts: host.knownHosts };
          for (const now of [second, third]) {
            expect(await host.login({ ...pinned, identity: now.file })).toMatchObject({ code: 0 });
          }
          const replaced = await host.login({ ...pinned, identity: first.file });
          expect(replaced.code).not.toBe(0);
          expect(replaced.stderr).toMatch(/Permission denied \(publickey\)\./);

          // A bad key given now isn't covered for by the good one on disk from before.
          await writeSecrets(image, secrets, {
            daintree_authorized_keys: `${second.publicKey}\n`,
            host_key_pem: "not a key",
          });
          const refused = await host.restart().then(
            () => "restarted",
            (err: Error) => err.message
          );
          expect(refused).toMatch(/^The container stopped \(exit 1\): /);
          expect(refused).toContain(
            "daintree-host: DAINTREE_SSH_HOST_KEY isn't an unencrypted private key sshd can read"
          );
        });
      },
      TEST_TIMEOUT_MS
    );

    it(
      "makes a host key of its own when given none, and keeps it across a restart",
      async () => {
        const login = await userKey("generated-login");
        const env = { DAINTREE_AUTHORIZED_KEYS: login.publicKey };
        const [one, two] = await startAll([
          { env, userKey: login.file },
          { env, userKey: login.file },
        ]);
        await withDiagnostics(one!, async () => {
          const [offered] = await one!.offeredKeys();
          expect(await one!.offeredKeys()).toEqual([offered]);
          expect(offered).toMatch(/^ssh-ed25519 /);
          const [other] = await two!.offeredKeys();
          expect(other).toMatch(/^ssh-ed25519 /);
          expect(other).not.toBe(offered);
          // Its log names it, for a person checking a first connection.
          expect(await one!.logs()).toMatch(
            new RegExp(
              `^daintree-host: host key 256 ${fingerprintOf(offered!).replace(/[+/]/g, "\\$&")} .*\\(ED25519\\)$`,
              "m"
            )
          );

          // The route trusted it on first use; a different key now would be refused.
          await one!.restart();
          expect(await one!.offeredKeys()).toEqual([offered]);
          expect(
            await one!.login({ identity: login.file, knownHosts: one!.knownHosts })
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
          // tini at PID 1 with the sshd listener beneath it; no systemd running, no
          // FUSE device, and no login session's runtime directory.
          expect(await host.rootShell("cat /proc/1/comm")).toBe("tini");
          expect(await host.rootShell("ps -o ppid= -p $(pgrep -o -x sshd)")).toBe("1");
          const absent = () =>
            host.rootShell(
              'pgrep -x systemd || true; for p in /dev/fuse /run/systemd/system /run/user/1500; do [ ! -e "$p" ] || echo "$p"; done'
            );
          expect(await absent()).toBe("");
          const running = () => host.shell("pgrep -x daintree || true");
          expect(await host.shell(`ls -A "$HOME" | grep -v '^\\.' || true`)).toBe("");
          expect(await running()).toBe("");

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
          // Installed, and nothing has started it.
          expect(await running()).toBe("");

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
          expect(await absent()).toBe("");

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
          // the Host is gone, and the next connection is what starts it again.
          await host.restart();
          expect(await running()).toBe("");
          const ensured: string[] = [];
          const again = await connectLink({
            host,
            build,
            clientName: "host-image-e2e",
            deviceId: DEVICE_ID,
            setup: {
              ensureHostRunning: async (connection, signal) => {
                const outcome = await setup.ensureHostRunning(connection, signal);
                ensured.push(outcome);
                return outcome;
              },
            },
          });
          try {
            expect(ensured).toContain("started");
            expect(again.handshake).toMatchObject({ version, commit, platform: "linux", arch });
            expect(again.transport.route).toBe("forward");
            const restarted = await listening();
            expect(restarted).not.toBeNull();
            expect(await host.shell(`ps -o comm= -p ${restarted}`)).toBe("daintree");
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
