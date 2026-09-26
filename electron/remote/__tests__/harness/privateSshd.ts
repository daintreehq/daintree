import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CommandRunner } from "../../client/commandRunner.js";
import { defaultCommandRunner } from "../../client/commandRunner.js";
import type { SshChild, SshSpawner } from "../../client/sshTransport.js";

/**
 * A private, user-mode OpenSSH `sshd` on 127.0.0.1 for the real-ssh end to
 * end test. Everything it needs lives under one temp directory: host and user
 * keys, its config, its log, the client's ssh_config and known_hosts, and the
 * HOME its sessions get (`SetEnv`), so the remote side reads and writes only
 * there. Nothing touches ~/.ssh or the system's Remote Login.
 */

export const SSH_ALIAS = "daintree-e2e";
const SSHD_PATH = "/usr/sbin/sshd";

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface PrivateSshd {
  /** The run's directory (canonical); every path the test creates is under it. */
  root: string;
  port: number;
  /** The client ssh_config that defines `SSH_ALIAS`. */
  configPath: string;
  /** HOME for every session this sshd starts. */
  home: string;
  pid: number;
  logPath: string;
  /** `ssh -F <config> …args`, the one injection the product code gets. */
  spawnSsh: SshSpawner;
  /** The same prefix for the product's `CommandRunner` (probe, remote shell). */
  runCommand: CommandRunner;
  runSsh(args: string[], timeoutMs?: number): Promise<SshRunResult>;
  /** Processes sshd started (its session children), transitively. */
  sessionProcesses(): Promise<ProcessRow[]>;
  /** Stop sshd and wait for it to exit. */
  stop(): Promise<void>;
}

/**
 * Where the product's default spawner points while a suite runs (see the
 * test's `defaultSshSpawner` mock). Null means ssh is not routed, and the
 * spawner refuses rather than reach the user's own ssh config.
 */
export const sshRouting = {
  configPath: null as string | null,
  /** While set, every ssh spawn fails as if the host were unreachable. */
  blocked: false,
};

export function routedSshSpawner(): SshSpawner {
  return (args) => {
    const configPath = sshRouting.configPath;
    if (!configPath) throw new Error("ssh is not routed to the private sshd");
    if (sshRouting.blocked) throw new Error("host unreachable (blocked by the test)");
    return spawn("ssh", ["-F", configPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }) as SshChild;
  };
}

export async function listProcesses(): Promise<ProcessRow[]> {
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out)
    )
  );
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

function descendantsOf(rows: ProcessRow[], root: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const parents = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        found.push(row);
        grew = true;
      }
    }
  }
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(file, args, (err, _out, stderr) =>
      err ? reject(new Error(`${file} failed: ${stderr || err.message}`)) : resolve()
    )
  );
}

/** Resolves once sshd answers with its banner. */
function readBanner(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("data", (chunk) => done(chunk.toString("latin1").startsWith("SSH-")));
    socket.once("error", () => done(false));
  });
}

/**
 * A short root: sshd, the ControlMaster and the host socket are Unix sockets
 * under it, and macOS allows 104 bytes for one (its per-user temp dir alone is
 * about 50).
 */
export async function makeShortTempRoot(): Promise<string> {
  const parent = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  return fs.realpath(await fs.mkdtemp(path.join(parent, "dse-")));
}

export async function startPrivateSshd(
  root: string,
  options: {
    /** More environment for every session (e.g. a PATH with stand-in tools first). */
    env?: Record<string, string>;
  } = {}
): Promise<PrivateSshd> {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const hostKey = path.join(root, "hostkey");
  const userKey = path.join(root, "userkey");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "daintree-e2e", "-f", hostKey]);
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "daintree-e2e", "-f", userKey]);
  const authorizedKeys = path.join(root, "authorized_keys");
  await fs.copyFile(`${userKey}.pub`, authorizedKeys);

  const port = await freePort();
  const sshdConfig = path.join(root, "sshd_config");
  const logPath = path.join(root, "sshd.log");
  await fs.writeFile(
    sshdConfig,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      `PidFile ${path.join(root, "sshd.pid")}`,
      "AllowStreamLocalForwarding yes",
      "AllowTcpForwarding yes",
      // Never run the real user's ~/.ssh/rc.
      "PermitUserRC no",
      // Probe and discovery read the session's HOME: point it at the run's directory.
      `SetEnv HOME=${home}${Object.entries(options.env ?? {})
        .map(([name, value]) => ` "${name}=${value}"`)
        .join("")}`,
      "",
    ].join("\n")
  );
  const configPath = path.join(root, "ssh_config");
  await fs.writeFile(
    configPath,
    [
      `Host ${SSH_ALIAS}`,
      "  HostName 127.0.0.1",
      `  Port ${port}`,
      `  IdentityFile ${userKey}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${path.join(root, "known_hosts")}`,
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "",
    ].join("\n")
  );

  const child: ChildProcess = spawn(SSHD_PATH, ["-D", "-f", sshdConfig, "-E", logPath], {
    stdio: "ignore",
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve();
    });
    child.once("error", (err) => {
      spawnError = err;
      exited = { code: null, signal: null };
      resolve();
    });
  });
  const log = () => fs.readFile(logPath, "utf8").catch(() => "(no log)");
  const deadline = Date.now() + 10_000;
  while (!(await readBanner(port))) {
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill("SIGKILL");
      const reason = spawnError
        ? (spawnError as Error).message
        : exited
          ? `exited with ${JSON.stringify(exited)}`
          : "did not answer within 10 s";
      throw new Error(`private sshd failed to start (${reason}):\n${await log()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pid = child.pid!;

  const spawnSsh: SshSpawner = (args) =>
    spawn("ssh", ["-F", configPath, ...args], { stdio: ["ignore", "pipe", "pipe"] }) as SshChild;
  const runCommand: CommandRunner = (command, args, options) =>
    command === "ssh" || command === "scp"
      ? defaultCommandRunner(command, ["-F", configPath, ...args], options)
      : Promise.reject(new Error(`unexpected command ${command}`));

  return {
    root,
    port,
    configPath,
    home,
    pid,
    logPath,
    spawnSsh,
    runCommand,
    async runSsh(args, timeoutMs = 15_000) {
      const result = await defaultCommandRunner("ssh", ["-F", configPath, ...args], {
        timeoutMs,
      });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    async sessionProcesses() {
      return descendantsOf(await listProcesses(), pid);
    },
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exit;
      clearTimeout(timer);
    },
  };
}
