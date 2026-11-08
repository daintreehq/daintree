import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { HostHandshakeInfo } from "../../../shared/types/remoteHosts.js";
import { REMOTE_PROTOCOL_VERSION } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { lookupArtifactChecksum } from "../client/clientBuild.js";
import { HostSetupService } from "../client/HostSetupService.js";
import type { ClientBuild, ClientBundle } from "../client/installPlan.js";
import { LinkClient } from "../client/LinkClient.js";
import { SshTransport } from "../client/sshTransport.js";
import { Lane } from "../link/frames.js";
import { ControlKind, InteractiveKind } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import { TERMINAL_RESUME_METHOD } from "../terminal/protocol.js";
import {
  appImageArch,
  buildImages,
  dockerArch,
  makeFeedTls,
  readAppImageMarker,
  remainingContainers,
  repackAppImage,
  requireDocker,
  startContainerHost,
  type ContainerHost,
  type FeedTls,
} from "./harness/containerHost.js";
import { waitUntil } from "./harness/poll.js";
import { makeShortTempRoot } from "./harness/privateSshd.js";
import {
  feedEntryFor,
  sha512Base64Of,
  updateManifestFor,
  wrongSha512Base64,
} from "./harness/releaseFeed.js";

/**
 * The real install path onto a bare Linux machine: a container with sshd and no
 * Daintree, a release feed serving a packaged build, and the real AppImage
 * extracting and starting headless over ssh. Only systemd is stood in for (see
 * harness/linuxHost/standins/systemctl), as it needs to be PID 1. Everything on
 * this side is the product's own setup and link code, with the build it claims
 * to be injected, since this process isn't a packaged app.
 *
 * Opt-in with DAINTREE_CONTAINER_E2E=1 and DAINTREE_CONTAINER_E2E_APPIMAGE naming
 * a packaged Linux build of the Docker daemon's architecture. See
 * docs/development.md#host-install-end-to-end.
 */

const ENABLED = process.env.DAINTREE_CONTAINER_E2E === "1";
const APPIMAGE = process.env.DAINTREE_CONTAINER_E2E_APPIMAGE ?? "";
const SETUP_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_TIMEOUT_MS = 60_000;
const INSTALLED_PATH = "Applications/Daintree.AppImage";
const DEVICE_ID = crypto.randomUUID();

let root: string;
let tls: FeedTls;
let arch: "arm64" | "x64";
let version: string;
let commit: string;
/** The same build with a marker naming another commit (see linuxHost/repackAppImage.mjs). */
let secondBuild: string;
let secondCommit: string;
const hosts: ContainerHost[] = [];

function report(line: string): void {
  // vitest.config drops console output.
  process.stdout.write(`[host-install-e2e] ${line}\n`);
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function clientBuild(bundle: ClientBundle, buildCommit = commit): ClientBuild {
  return { platform: "linux", arch, version, commit: buildCommit, channel: "stable", bundle };
}

/** The product's setup service, as a client on `build` runs it against `host`. */
function setupFor(
  host: ContainerHost,
  build: ClientBuild
): { setup: HostSetupService; stages: string[] } {
  const stages: string[] = [];
  const setup = new HostSetupService({
    run: host.runCommand,
    clientDir: host.clientDir,
    platform: process.platform,
    knownConnections: () => [host.connection],
    clientBuild: () => build,
    // What a restart would end isn't this target's business: its scenarios proceed regardless.
    restartImpact: async () => ({ detail: null, agents: null }),
    download: async () => {
      throw new Error("This machine was asked to download a build the host should have fetched");
    },
    checksum: (url, signal) => lookupArtifactChecksum({ url, signal, fetchImpl: host.feedFetch }),
    emit: (event) => {
      if (event.type === "install-progress") stages.push(event.progress.stage);
    },
  });
  return { setup, stages };
}

function install(setup: HostSetupService, host: ContainerHost) {
  return setup.install({
    opId: crypto.randomUUID(),
    connection: host.connection,
    whileWorking: "proceed",
  });
}

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

/** Dial the host as a client on this build would and wait for the link. */
async function connect(
  host: ContainerHost,
  buildCommit = commit
): Promise<{ link: LinkClient; session: LinkSession; handshake: HostHandshakeInfo }> {
  const link = new LinkClient({
    transport: new SshTransport({
      target: host.target,
      clientDir: host.clientDir,
      spawn: host.spawnSsh,
    }),
    handshake: {
      version,
      commit: buildCommit,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      platform: "linux",
      arch,
    },
    client: {
      clientId: crypto.randomUUID(),
      clientName: "host-install-e2e",
      platform: "linux",
      // One install across its connections: it takes back the lease it left.
      deviceId: DEVICE_ID,
    },
  });
  try {
    const session = await new Promise<LinkSession>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No link: ${JSON.stringify(link.getState())}`)),
        TERMINAL_TIMEOUT_MS
      );
      link.onSession((established) => {
        clearTimeout(timer);
        resolve(established.session);
      });
      link.start();
    });
    const state = link.getState();
    if (state.status !== "connected") throw new Error(`Link is ${state.status}`);
    return { link, session, handshake: state.handshake };
  } catch (err) {
    await link.stop();
    throw err;
  }
}

/**
 * A real terminal on the host: the packaged app's pty-host running a shell in a
 * project, input through the link's stream, and output that only the shell's
 * arithmetic could have produced.
 */
async function expectWorkingTerminal(host: ContainerHost, session: LinkSession): Promise<void> {
  const endpointId = `e2e-${crypto.randomUUID()}`;
  const openId = crypto.randomUUID();
  session.post({
    lane: Lane.CONTROL,
    kind: ControlKind.ENDPOINT_OPEN,
    body: { endpointId, projectId: null, openId },
  });
  const projectPath = `${host.home}/e2e-project`;
  await host.shell(`mkdir -p "${projectPath}" && git -C "${projectPath}" init --quiet`);
  const project = unwrap<{ id: string; path: string }>(
    await session.invoke(endpointId, CHANNELS.PROJECT_ADD, [projectPath])
  );
  session.post({
    lane: Lane.CONTROL,
    kind: ControlKind.ENDPOINT_REBIND,
    body: { endpointId, projectId: project.id },
  });

  // What a view's relay says on every session: the host holds its stream until then.
  await session.call(TERMINAL_RESUME_METHOD, { endpointId, terminals: [] });

  const terminalId = `e2e-terminal-${crypto.randomUUID()}`;
  let output = "";
  const decoder = new TextDecoder();
  const stopListening = session.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => {
    if (body.endpointId !== endpointId || body.terminalId !== terminalId) return;
    const message = body.message as { type?: string; data?: Uint8Array; bytes?: number };
    if (message.type !== "data" || !message.data) return;
    output += decoder.decode(message.data);
    session.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_IN,
      body: { endpointId, message: { type: "ack", id: terminalId, bytes: message.bytes ?? 0 } },
    });
  });
  try {
    unwrap(
      await session.invoke(endpointId, CHANNELS.TERMINAL_SPAWN, [
        { id: terminalId, kind: "terminal", projectId: project.id, cols: 100, rows: 30 },
      ])
    );
    const nonce = crypto.randomBytes(6).toString("hex");
    const write = () =>
      session.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_IN,
        body: {
          endpointId,
          message: {
            type: "write",
            id: terminalId,
            // The echoed line reads "$((6*7))"; only the shell turns it into 42.
            data: `echo "${nonce}-$((6*7))-$(uname -s)"\r`,
          },
        },
      });
    write();
    await waitUntil(
      () => output.includes(`${nonce}-42-Linux`),
      `the terminal's answer (saw ${JSON.stringify(output.slice(-400))})`,
      TERMINAL_TIMEOUT_MS
    );
    unwrap(await session.invoke(endpointId, CHANNELS.TERMINAL_KILL, [terminalId]));
  } finally {
    stopListening();
    session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_CLOSE,
      body: { endpointId },
    });
  }
}

/** The fingerprint of what is installed and running there, to compare across an install. */
async function hostState(host: ContainerHost): Promise<{
  imageSha256: string;
  marker: string;
  stray: string;
  listeningPid: number | null;
}> {
  const [imageSha256, marker, stray, record] = await Promise.all([
    host.shell(`sha256sum "$HOME/${INSTALLED_PATH}" | cut -d' ' -f1`),
    host.shell(`cat "$HOME/${INSTALLED_PATH}.build-info.json"`),
    // Whatever an install left behind: staging folders, backups, half copies.
    host.shell(
      `ls -d /tmp/daintree-stage.* "$HOME/${INSTALLED_PATH}".old-* "$HOME/${INSTALLED_PATH}".build-info.json.old-* 2>/dev/null || true`
    ),
    host.shell(`cat "/run/user/$(id -u)/daintree/host.json" 2>/dev/null || true`),
  ]);
  const parsed = record ? (JSON.parse(record) as { pid?: number }) : null;
  return { imageSha256, marker, stray, listeningPid: parsed?.pid ?? null };
}

/** Prints what the machine saw when a scenario fails: the failure alone rarely says why. */
async function withDiagnostics(host: ContainerHost, scenario: () => Promise<void>): Promise<void> {
  try {
    await scenario();
  } catch (err) {
    report(await host.diagnostics().catch((e: unknown) => `(no diagnostics: ${String(e)})`));
    throw err;
  }
}

/** Host mode on for good, the link up on exactly this build, and a terminal that answers. */
async function expectHostUp(host: ContainerHost, setup: HostSetupService): Promise<void> {
  const { probe } = await setup.startHostMode({ connection: host.connection });
  expect(probe.hostModeListening).toBe(true);
  expect(probe.matchesClient).toBe(true);
  expect(probe.hostBuild).toEqual({ version, commit, order: "same" });
  expect(probe.hostModeState).toMatchObject({ enabled: true, startAtLogin: true });
  expect(probe.advice).toMatchObject({ hostModeUnit: true, startAtLoginInstalled: true });

  const { link, session, handshake } = await connect(host);
  try {
    expect(handshake).toMatchObject({ version, commit, platform: "linux", arch });
    await expectWorkingTerminal(host, session);
  } finally {
    await link.stop();
  }
}

describe.skipIf(!ENABLED)(
  "host install onto a bare Linux container (skipped unless DAINTREE_CONTAINER_E2E=1)",
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
      tls = await makeFeedTls(path.join(root, "tls"));
      await buildImages();
      const marker = JSON.parse(await readAppImageMarker(APPIMAGE)) as {
        version: string;
        commit: string;
      };
      version = marker.version;
      commit = marker.commit;
      // Same length: the marker is patched in place.
      secondCommit = [...commit].map((c) => (c === "0" ? "1" : "0")).join("");
      secondBuild = path.join(root, "second.AppImage");
      await repackAppImage(APPIMAGE, secondCommit, secondBuild);
      report(`build ${version} ${commit} on ${arch}; second build ${secondCommit}`);
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await Promise.all(hosts.map((host) => host.dispose()));
      if (root) await fs.rm(root, { recursive: true, force: true });
    }, TEST_TIMEOUT_MS);

    describe("a host that fetches its build", () => {
      let host: ContainerHost;

      beforeAll(async () => {
        host = await startContainerHost(tls);
        hosts.push(host);
        const entry = feedEntryFor(version, arch);
        await host.publish(entry.artifactPath, APPIMAGE);
        await host.publishText(
          entry.manifestPath,
          updateManifestFor({
            version,
            artifactName: entry.artifactName,
            sha512: await sha512Base64Of(APPIMAGE),
            size: (await fs.stat(APPIMAGE)).size,
          })
        );
      }, SETUP_TIMEOUT_MS);

      it(
        "starts with no Daintree there, and ends with Host mode on, a link and a working terminal",
        async () => {
          await withDiagnostics(host, async () => {
            expect(await host.shell(`ls "$HOME/Applications" 2>/dev/null || true`)).toBe("");
            expect(await host.shell(`pgrep -x daintree || true`)).toBe("");

            const { setup, stages } = setupFor(host, clientBuild({ kind: "none" }));
            const entry = feedEntryFor(version, arch);
            const plan = await setup.planInstall({ connection: host.connection });
            expect(plan).toMatchObject({
              kind: "install",
              delivery: "host-fetch",
              packaging: "appimage",
              artifactUrl: entry.url,
            });

            await expect(install(setup, host)).resolves.toMatchObject({ status: "installed" });
            expect(stages).toContain("downloading");
            expect(stages).not.toContain("copying");
            expect(await host.feedRequests()).toContain(`GET /${entry.artifactPath}`);
            expect((await hostState(host)).imageSha256).toBe(await sha256Of(APPIMAGE));

            await expectHostUp(host, setup);
          });
        },
        TEST_TIMEOUT_MS
      );

      it(
        "refuses a feed whose checksum doesn't match before anything is replaced",
        async () => {
          await withDiagnostics(host, async () => {
            const entry = feedEntryFor(version, arch);
            const sha512 = await sha512Base64Of(APPIMAGE);
            await host.publishText(
              entry.manifestPath,
              updateManifestFor({
                version,
                artifactName: entry.artifactName,
                sha512: wrongSha512Base64(sha512),
                size: (await fs.stat(APPIMAGE)).size,
              })
            );
            const before = await hostState(host);
            const fetchesBefore = (await host.feedRequests()).filter(
              (line) => line === `GET /${entry.artifactPath}`
            ).length;
            expect(before.listeningPid).not.toBeNull();

            // Another commit of this version: the running host isn't up to date for it.
            const { setup, stages } = setupFor(
              host,
              clientBuild({ kind: "none" }, secondCommit)
            );
            await expect(install(setup, host)).rejects.toThrow(
              /doesn't match the release feed's checksum/
            );

            // It was downloaded and read, and refused there: nothing went further.
            const fetchesAfter = (await host.feedRequests()).filter(
              (line) => line === `GET /${entry.artifactPath}`
            ).length;
            expect(fetchesAfter).toBe(fetchesBefore + 1);
            expect(stages).not.toContain("stopping");
            expect(stages).not.toContain("installing");
            expect(await hostState(host)).toEqual(before);

            const { link, session } = await connect(host);
            try {
              await expectWorkingTerminal(host, session);
            } finally {
              await link.stop();
            }
          });
        },
        TEST_TIMEOUT_MS
      );
    });

    describe("a host this machine pushes its build to", () => {
      let host: ContainerHost;

      beforeAll(async () => {
        host = await startContainerHost(tls);
        hosts.push(host);
      }, SETUP_TIMEOUT_MS);

      it(
        "starts with no Daintree there, and ends with Host mode on, a link and a working terminal",
        async () => {
          await withDiagnostics(host, async () => {
            expect(await host.shell(`ls "$HOME/Applications" 2>/dev/null || true`)).toBe("");

            const { setup, stages } = setupFor(
              host,
              clientBuild({ kind: "appimage", path: APPIMAGE })
            );
            const plan = await setup.planInstall({ connection: host.connection });
            expect(plan).toMatchObject({
              kind: "install",
              delivery: "push-bundle",
              packaging: "appimage",
            });

            await expect(install(setup, host)).resolves.toMatchObject({ status: "installed" });
            expect(stages).toContain("copying");
            expect(stages).not.toContain("downloading");
            expect(await host.feedRequests()).toEqual([]);
            expect((await hostState(host)).imageSha256).toBe(await sha256Of(APPIMAGE));

            await expectHostUp(host, setup);
          });
        },
        TEST_TIMEOUT_MS
      );

      it(
        "puts the previous build back and running when the second build fails verification",
        async () => {
          await withDiagnostics(host, async () => {
            const before = await hostState(host);
            expect(before.listeningPid).not.toBeNull();

            // Staging reads the marker and passes; the running process, restarted
            // on the second build, reports the commit compiled into it, and doesn't.
            const { setup, stages } = setupFor(
              host,
              clientBuild({ kind: "appimage", path: secondBuild }, secondCommit)
            );
            await expect(install(setup, host)).rejects.toThrow(
              /still reported a different build.*previous build was put back and is running again/s
            );
            expect(stages).toEqual(
              expect.arrayContaining(["copying", "verifying", "stopping", "installing", "restarting"])
            );

            const after = await hostState(host);
            expect(after.imageSha256).toBe(before.imageSha256);
            expect(after.marker).toBe(before.marker);
            expect(after.stray).toBe("");
            expect(after.listeningPid).not.toBeNull();
            expect(after.listeningPid).not.toBe(before.listeningPid);

            // The previous build reads as itself to a client on it, and serves.
            const original = setupFor(host, clientBuild({ kind: "none" }));
            const probe = await original.setup.probe({ connection: host.connection });
            expect(probe.matchesClient).toBe(true);
            expect(probe.hostModeListening).toBe(true);
            const { link, session, handshake } = await connect(host);
            try {
              expect(handshake).toMatchObject({ version, commit });
              await expectWorkingTerminal(host, session);
            } finally {
              await link.stop();
            }
          });
        },
        TEST_TIMEOUT_MS
      );
    });

    it(
      "tears the machines down",
      async () => {
        await Promise.all(hosts.map((host) => host.dispose()));
        expect(await remainingContainers()).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );
  }
);
