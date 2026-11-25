import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "../../client/commandRunner.js";
import type { SshSpawner, SshStreamSpawner } from "../../client/sshTransport.js";
import type { HostConnection } from "../../../../shared/types/remoteHosts.js";
import {
  docker,
  exec,
  installExitHook,
  loopbackPort,
  removeContainers,
  startContainer,
} from "./docker.js";
import { makeShortTempRoot } from "./privateSshd.js";
import { makeUserKey, writeSshRoute } from "./sshRoute.js";

/**
 * A bare Linux machine reachable over ssh, in a container, for the host install
 * end to end: sshd and an unprivileged user, the libraries Daintree's deb
 * declares, no Daintree. Beside it runs a release feed answering as
 * updates.daintree.org with a certificate only this machine and this process
 * trust, so the production feed URLs stay as they are and nothing about TLS or
 * https-only is relaxed. See linuxHost/Dockerfile.
 */

const CONTEXT = fileURLToPath(new URL("./linuxHost", import.meta.url));
const HOST_IMAGE = "daintree-e2e-linux-host";
const FEED_IMAGE = "daintree-e2e-release-feed";
export const FEED_HOSTNAME = "updates.daintree.org";
const HOST_USER = "daintree-e2e";
const HOST_HOME = `/home/${HOST_USER}`;
const ALIAS = "daintree-e2e-linux";

/** The architecture of an AppImage, from its ELF header. */
export async function appImageArch(file: string): Promise<"arm64" | "x64" | "unknown"> {
  const handle = await fs.open(file, "r");
  try {
    const { buffer } = await handle.read(Buffer.alloc(20), 0, 20, 0);
    if (buffer.toString("latin1", 0, 4) !== "\x7fELF") return "unknown";
    const machine = buffer.readUInt16LE(18);
    if (machine === 0xb7) return "arm64";
    if (machine === 0x3e) return "x64";
    return "unknown";
  } finally {
    await handle.close();
  }
}

export async function buildImages(): Promise<void> {
  for (const [target, tag] of [
    ["host", HOST_IMAGE],
    ["feed", FEED_IMAGE],
  ] as const) {
    await docker(["build", "--quiet", "--target", target, "--tag", tag, CONTEXT], 15 * 60_000);
  }
}

export interface FeedTls {
  dir: string;
  caCert: string;
}

/** A certificate authority for this run, and the feed's certificate from it. */
export async function makeFeedTls(dir: string): Promise<FeedTls> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (name: string) => path.join(dir, name);
  const openssl = async (args: string[]) => {
    const result = await exec("openssl", args, 60_000);
    if (result.code !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
  };
  await fs.writeFile(file("ca.cnf"), "basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign\n");
  await fs.writeFile(file("feed.cnf"), `subjectAltName=DNS:${FEED_HOSTNAME}\n`);
  // prettier-ignore
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca.key"), "-out", file("ca.csr"), "-subj", "/CN=Daintree e2e release feed CA"]);
  // prettier-ignore
  await openssl(["x509", "-req", "-in", file("ca.csr"), "-signkey", file("ca.key"), "-out", file("ca.crt"), "-days", "2", "-extfile", file("ca.cnf")]);
  // prettier-ignore
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", file("feed.key"), "-out", file("feed.csr"), "-subj", `/CN=${FEED_HOSTNAME}`]);
  // prettier-ignore
  await openssl(["x509", "-req", "-in", file("feed.csr"), "-CA", file("ca.crt"), "-CAkey", file("ca.key"), "-CAcreateserial", "-out", file("feed.crt"), "-days", "2", "-extfile", file("feed.cnf")]);
  return { dir, caCert: await fs.readFile(file("ca.crt"), "utf8") };
}

export interface ContainerHost {
  /** This machine's directory on the client: its key, ssh_config and control sockets. */
  root: string;
  target: string;
  connection: HostConnection;
  home: string;
  /** A directory for this client's control sockets (see SshTransport). */
  clientDir: string;
  /** The product's `CommandRunner`, with `-F <private ssh_config>` the one injection. */
  runCommand: CommandRunner;
  spawnSsh: SshSpawner;
  spawnSshStream: SshStreamSpawner;
  /** Run a shell line on the machine as the ssh user, around the path under test. */
  shell(script: string, timeoutMs?: number): Promise<string>;
  /** A fetch that reaches this machine's feed under its real name, with TLS verified. */
  feedFetch: typeof fetch;
  /** Put a file on the feed. */
  publish(urlPath: string, local: string): Promise<void>;
  /** Replace a file on the feed with these contents. */
  publishText(urlPath: string, text: string): Promise<void>;
  /** The requests the feed has answered, oldest first, as `METHOD /path`. */
  feedRequests(): Promise<string[]>;
  /** What the service and sshd printed, for a failure's report. */
  diagnostics(): Promise<string>;
  /** Remove both containers and this machine's files; a call after a failed one tries again. */
  dispose(): Promise<void>;
}

function fetchThrough(hostPort: number, ca: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== FEED_HOSTNAME) {
        reject(new Error(`This feed only answers for ${FEED_HOSTNAME}: ${url.hostname}`));
        return;
      }
      const request = https.request(
        {
          host: "127.0.0.1",
          port: hostPort,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          servername: FEED_HOSTNAME,
          ca,
          headers: { host: FEED_HOSTNAME },
          signal: init?.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers.set(name, value);
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: response.statusCode ?? 0, headers })
            );
          });
        }
      );
      request.on("error", reject);
      request.end();
    })) as typeof fetch;
}

export async function startContainerHost(tls: FeedTls): Promise<ContainerHost> {
  installExitHook();
  const root = await makeShortTempRoot();
  let hostId: string | null = null;
  let feedId: string | null = null;
  let disposed = false;
  let closeMaster: () => Promise<unknown> = async () => {};
  const dispose = async () => {
    if (disposed) return;
    await closeMaster().catch(() => {});
    await removeContainers([feedId, hostId].filter((id): id is string => id !== null));
    await fs.rm(root, { recursive: true, force: true });
    disposed = true;
  };

  try {
    const userKey = await makeUserKey(path.join(root, "userkey"));
    const seed = path.join(root, "seed");
    await fs.mkdir(seed);
    await fs.copyFile(`${userKey}.pub`, path.join(seed, "authorized_keys"));
    await fs.copyFile(path.join(tls.dir, "ca.crt"), path.join(seed, "ca.crt"));
    const clientDir = path.join(root, "c");
    await fs.mkdir(clientDir, { mode: 0o700 });

    hostId = await startContainer([
      "--init",
      "--add-host",
      `${FEED_HOSTNAME}:127.0.0.1`,
      "--publish",
      "127.0.0.1:0:22",
      "--publish",
      "127.0.0.1:0:443",
      HOST_IMAGE,
    ]);
    await docker(["cp", `${seed}/.`, `${hostId}:/e2e-seed/`]);
    await docker(["exec", hostId, "touch", "/e2e-seed/ready"]);

    // Its 443 is the machine's own, so `updates.daintree.org` needs only a hosts line.
    feedId = await startContainer(["--network", `container:${hostId}`, FEED_IMAGE]);
    const feedRoot = path.join(root, "feed");
    await fs.mkdir(path.join(feedRoot, "tls"), { recursive: true });
    await fs.mkdir(path.join(feedRoot, "www"), { recursive: true });
    await fs.copyFile(path.join(tls.dir, "feed.key"), path.join(feedRoot, "tls", "feed.key"));
    await fs.copyFile(path.join(tls.dir, "feed.crt"), path.join(feedRoot, "tls", "feed.crt"));
    await fs.writeFile(path.join(feedRoot, "requests.log"), "");
    await docker(["cp", `${feedRoot}/.`, `${feedId}:/feed/`]);
    await docker(["exec", feedId, "touch", "/feed/ready"]);

    const sshPort = loopbackPort(await docker(["port", hostId, "22/tcp"]));
    const feedPort = loopbackPort(await docker(["port", hostId, "443/tcp"]));

    const route = await writeSshRoute({
      root,
      alias: ALIAS,
      port: sshPort,
      user: HOST_USER,
      identity: userKey,
      knownHosts: path.join(root, "known_hosts"),
      strictHostKeyChecking: "accept-new",
    });
    const { runCommand, spawnSsh, spawnSshStream } = route;
    closeMaster = () => route.closeMaster(clientDir);
    const started = hostId;
    await route.waitForLogin(
      60_000,
      async () => (await exec("docker", ["logs", started], 10_000)).stderr
    );

    const feed = feedId;
    const host = hostId;
    return {
      root,
      target: ALIAS,
      connection: { kind: "ssh", target: ALIAS },
      home: HOST_HOME,
      clientDir,
      runCommand,
      spawnSsh,
      spawnSshStream,
      async shell(script, timeoutMs = 120_000) {
        return docker(["exec", "--user", HOST_USER, host, "sh", "-c", script], timeoutMs);
      },
      feedFetch: fetchThrough(feedPort, tls.caCert),
      async publish(urlPath, local) {
        const dir = path.posix.dirname(`/feed/www/${urlPath}`);
        await docker(["exec", feed, "mkdir", "-p", dir]);
        await docker(["cp", local, `${feed}:/feed/www/${urlPath}`], 5 * 60_000);
      },
      async publishText(urlPath, text) {
        const local = path.join(root, "published.txt");
        await fs.writeFile(local, text);
        const dir = path.posix.dirname(`/feed/www/${urlPath}`);
        await docker(["exec", feed, "mkdir", "-p", dir]);
        await docker(["cp", local, `${feed}:/feed/www/${urlPath}`]);
      },
      async feedRequests() {
        const text = await docker(["exec", feed, "cat", "/feed/requests.log"]);
        return text.split("\n").filter(Boolean);
      },
      async diagnostics() {
        const parts = await Promise.all([
          exec("docker", ["logs", "--tail", "40", host], 10_000),
          exec(
            "docker",
            [
              "exec",
              "--user",
              HOST_USER,
              host,
              "sh",
              "-c",
              'tail -n 60 "$HOME/.cache/daintree/host.log" 2>/dev/null; ps -eo pid,ppid,comm,args | cut -c1-160',
            ],
            10_000
          ),
        ]);
        return parts.map((part) => `${part.stdout}${part.stderr}`).join("\n---\n");
      },
      dispose,
    };
  } catch (err) {
    await dispose().catch(() => {});
    throw err;
  }
}

/**
 * The build marker packed in an AppImage, read by its own runtime in a
 * throwaway container of `image`: any with sh, grep and head.
 */
export async function readAppImageMarker(appImage: string, image = FEED_IMAGE): Promise<string> {
  const id = await startContainer(["--entrypoint", "sleep", image, "600"]);
  try {
    await docker(["cp", appImage, `${id}:/tmp/in.AppImage`], 5 * 60_000);
    const script =
      'cd /tmp && chmod 755 in.AppImage && ./in.AppImage --appimage-extract resources/app.asar >/dev/null 2>&1; grep -a -o -m 1 -E \'[{]"daintreeBuildInfo":1,"version":"[^"]+","commit":"[0-9a-f]+"[}]\' squashfs-root/resources/app.asar | head -n 1';
    const marker = await docker(["exec", id, "sh", "-c", script], 5 * 60_000);
    if (!marker) throw new Error(`${appImage} carries no build marker`);
    return marker;
  } finally {
    await removeContainers([id]);
  }
}

/** A second build of an AppImage whose marker names `commit` (see linuxHost/repackAppImage.mjs). */
export async function repackAppImage(
  appImage: string,
  commit: string,
  output: string
): Promise<void> {
  const id = await startContainer(["--entrypoint", "sleep", FEED_IMAGE, "1800"]);
  try {
    await docker(["exec", id, "mkdir", "-p", "/work"]);
    await docker(["cp", appImage, `${id}:/work/in.AppImage`], 5 * 60_000);
    await docker(
      [
        "exec",
        id,
        "node",
        "/opt/e2e/repackAppImage.mjs",
        "/work/in.AppImage",
        "/work/out.AppImage",
        commit,
      ],
      15 * 60_000
    );
    await docker(["cp", `${id}:/work/out.AppImage`, output], 5 * 60_000);
  } finally {
    await removeContainers([id]);
  }
}
