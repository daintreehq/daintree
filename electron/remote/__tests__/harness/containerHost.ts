import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "../../client/commandRunner.js";
import { defaultCommandRunner } from "../../client/commandRunner.js";
import type { StreamCommandChild } from "../../client/commandStreamTransport.js";
import {
  controlPathFor,
  type SshChild,
  type SshSpawner,
  type SshStreamSpawner,
} from "../../client/sshTransport.js";
import type { HostConnection } from "../../../../shared/types/remoteHosts.js";
import { makeShortTempRoot } from "./privateSshd.js";

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
/** Names this run's containers, and only this run's: other runs may share the daemon. */
const RUN_LABEL = `org.daintree.e2e.host-install=${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
export const FEED_HOSTNAME = "updates.daintree.org";
const HOST_USER = "daintree-e2e";
const HOST_HOME = `/home/${HOST_USER}`;
const ALIAS = "daintree-e2e-linux";

function exec(
  file: string,
  args: string[],
  timeoutMs = 120_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: stderr || (err && code !== 0 ? err.message : "") });
      }
    );
  });
}

async function docker(args: string[], timeoutMs?: number): Promise<string> {
  const result = await exec("docker", args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Fails with what to do about it: with the flag on, nothing here may skip. */
export async function requireDocker(): Promise<void> {
  const result = await exec("docker", ["version", "--format", "{{.Server.Arch}}"], 20_000);
  if (result.code !== 0) {
    throw new Error(
      `This target needs a running Docker daemon (Docker Desktop, Colima, or Docker Engine): ${result.stderr.trim()}`
    );
  }
}

/** The architecture containers run as here, as Node names it. */
export async function dockerArch(): Promise<"arm64" | "x64"> {
  const arch = await docker(["version", "--format", "{{.Server.Arch}}"]);
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "amd64" || arch === "x86_64") return "x64";
  throw new Error(`Daintree ships no Linux build for ${arch}`);
}

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
  /** Remove both containers and this machine's files; safe to call twice. */
  dispose(): Promise<void>;
}

const live = new Set<string>();
let exitHookInstalled = false;

/** A worker going away without its teardown still takes the containers with it. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (live.size === 0) return;
    try {
      execFileSync("docker", ["rm", "--force", ...live], { stdio: "ignore", timeout: 20_000 });
    } catch {
      // Their own time limit removes them.
    }
  });
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

function loopbackPort(line: string): number {
  const port = Number(line.split("\n")[0]!.split(":").at(-1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`No published port in "${line}"`);
  return port;
}

export async function startContainerHost(tls: FeedTls): Promise<ContainerHost> {
  installExitHook();
  const root = await makeShortTempRoot();
  const userKey = path.join(root, "userkey");
  const keygen = await exec(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "daintree-e2e", "-f", userKey],
    30_000
  );
  if (keygen.code !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);
  const seed = path.join(root, "seed");
  await fs.mkdir(seed);
  await fs.copyFile(`${userKey}.pub`, path.join(seed, "authorized_keys"));
  await fs.copyFile(path.join(tls.dir, "ca.crt"), path.join(seed, "ca.crt"));
  const clientDir = path.join(root, "c");
  await fs.mkdir(clientDir, { mode: 0o700 });

  let hostId: string | null = null;
  let feedId: string | null = null;
  let disposed = false;
  let closeMaster: () => Promise<unknown> = async () => {};
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await closeMaster().catch(() => {});
    const ids = [feedId, hostId].filter((id): id is string => id !== null);
    if (ids.length > 0) await exec("docker", ["rm", "--force", ...ids], 60_000);
    for (const id of ids) live.delete(id);
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    hostId = await docker([
      "create",
      "--label",
      RUN_LABEL,
      "--rm",
      "--init",
      "--add-host",
      `${FEED_HOSTNAME}:127.0.0.1`,
      "--publish",
      "127.0.0.1:0:22",
      "--publish",
      "127.0.0.1:0:443",
      HOST_IMAGE,
    ]);
    live.add(hostId);
    await docker(["cp", `${seed}/.`, `${hostId}:/e2e-seed/`]);
    await docker(["start", hostId]);

    feedId = await docker([
      "create",
      "--label",
      RUN_LABEL,
      "--rm",
      // Its 443 is the machine's own, so `updates.daintree.org` needs only a hosts line.
      "--network",
      `container:${hostId}`,
      FEED_IMAGE,
    ]);
    live.add(feedId);
    const feedRoot = path.join(root, "feed");
    await fs.mkdir(path.join(feedRoot, "tls"), { recursive: true });
    await fs.mkdir(path.join(feedRoot, "www"), { recursive: true });
    await fs.copyFile(path.join(tls.dir, "feed.key"), path.join(feedRoot, "tls", "feed.key"));
    await fs.copyFile(path.join(tls.dir, "feed.crt"), path.join(feedRoot, "tls", "feed.crt"));
    await fs.writeFile(path.join(feedRoot, "requests.log"), "");
    await docker(["cp", `${feedRoot}/.`, `${feedId}:/feed/`]);
    await docker(["start", feedId]);

    const sshPort = loopbackPort(await docker(["port", hostId, "22/tcp"]));
    const feedPort = loopbackPort(await docker(["port", hostId, "443/tcp"]));

    const configPath = path.join(root, "ssh_config");
    await fs.writeFile(
      configPath,
      [
        `Host ${ALIAS}`,
        "  HostName 127.0.0.1",
        `  Port ${sshPort}`,
        `  User ${HOST_USER}`,
        `  IdentityFile ${userKey}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${path.join(root, "known_hosts")}`,
        "  StrictHostKeyChecking accept-new",
        "  BatchMode yes",
        "",
      ].join("\n")
    );

    const spawnSsh: SshSpawner = (args) =>
      spawn("ssh", ["-F", configPath, ...args], { stdio: ["ignore", "pipe", "pipe"] }) as SshChild;
    const spawnSshStream: SshStreamSpawner = (args) =>
      spawn("ssh", ["-F", configPath, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as StreamCommandChild;
    const runCommand: CommandRunner = (command, args, options) =>
      command === "ssh" || command === "scp"
        ? defaultCommandRunner(command, ["-F", configPath, ...args], options)
        : Promise.reject(new Error(`unexpected command ${command}`));

    closeMaster = () =>
      runCommand(
        "ssh",
        ["-o", `ControlPath=${controlPathFor(clientDir, ALIAS)}`, "-O", "exit", ALIAS],
        { timeoutMs: 10_000 }
      );

    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = await runCommand("ssh", ["-o", "ConnectTimeout=3", ALIAS, "true"], {
        timeoutMs: 10_000,
      });
      if (ready.code === 0) break;
      if (Date.now() > deadline) {
        const logs = await exec("docker", ["logs", hostId], 10_000);
        throw new Error(`The machine's sshd never answered: ${ready.stderr}\n${logs.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

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
              'tail -n 60 "/run/user/$(id -u)/standin-systemd/journal.log" 2>/dev/null; ps -eo pid,ppid,comm,args | cut -c1-160',
            ],
            10_000
          ),
        ]);
        return parts.map((part) => `${part.stdout}${part.stderr}`).join("\n---\n");
      },
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}

/** This run's containers still on the daemon, running or not. */
export async function remainingContainers(): Promise<string[]> {
  const out = await docker(["ps", "--all", "--quiet", "--filter", `label=${RUN_LABEL}`]);
  return out.split("\n").filter(Boolean);
}

/** The build marker packed in an AppImage, read by its own runtime in a throwaway container. */
export async function readAppImageMarker(appImage: string): Promise<string> {
  const id = await docker([
    "create",
    "--label",
    RUN_LABEL,
    "--rm",
    "--entrypoint",
    "sleep",
    FEED_IMAGE,
    "600",
  ]);
  live.add(id);
  try {
    await docker(["start", id]);
    await docker(["cp", appImage, `${id}:/tmp/in.AppImage`], 5 * 60_000);
    const script =
      'cd /tmp && chmod 755 in.AppImage && ./in.AppImage --appimage-extract resources/app.asar >/dev/null 2>&1; grep -a -o -m 1 -E \'[{]"daintreeBuildInfo":1,"version":"[^"]+","commit":"[0-9a-f]+"[}]\' squashfs-root/resources/app.asar | head -n 1';
    const marker = await docker(["exec", id, "sh", "-c", script], 5 * 60_000);
    if (!marker) throw new Error(`${appImage} carries no build marker`);
    return marker;
  } finally {
    await exec("docker", ["rm", "--force", id], 30_000);
    live.delete(id);
  }
}

/** A second build of an AppImage whose marker names `commit` (see linuxHost/repackAppImage.mjs). */
export async function repackAppImage(
  appImage: string,
  commit: string,
  output: string
): Promise<void> {
  const id = await docker([
    "create",
    "--label",
    RUN_LABEL,
    "--rm",
    "--entrypoint",
    "sleep",
    FEED_IMAGE,
    "1800",
  ]);
  live.add(id);
  try {
    await docker(["start", id]);
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
    await exec("docker", ["rm", "--force", id], 30_000);
    live.delete(id);
  }
}
