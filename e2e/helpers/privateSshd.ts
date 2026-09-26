import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * A private, user-mode OpenSSH `sshd` on 127.0.0.1 for the Remote Hosts E2E,
 * ported from the product's real-ssh harness
 * (`electron/remote/__tests__/harness/privateSshd.ts`) so the Playwright side
 * imports nothing from `electron/`. Everything lives under one short temp
 * root: host and user keys, the sshd config and log, the client ssh_config and
 * known_hosts, and the HOME every session gets (`SetEnv HOME=`). Nothing
 * touches ~/.ssh, the user's ssh config or macOS Remote Login.
 */

export const SSH_ALIAS = "daintree-e2e";
export const SSHD_PATH = "/usr/sbin/sshd";
export const SYSTEM_SSH = "/usr/bin/ssh";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface PrivateSshd {
  root: string;
  port: number;
  /** The client ssh_config that defines `SSH_ALIAS`. */
  configPath: string;
  /** HOME for every session this sshd starts. */
  home: string;
  pid: number;
  logPath: string;
  /** Run the system ssh with the private config, from the test process. */
  runSsh(
    args: string[],
    timeoutMs?: number
  ): Promise<{ code: number | null; stderr: string; stdout: string }>;
  /** Processes sshd started (its sessions), transitively. */
  sessionProcesses(): Promise<ProcessRow[]>;
  stop(): Promise<void>;
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

function run(
  file: string,
  args: string[],
  timeoutMs = 15_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      })
    )
  );
}

async function mustRun(file: string, args: string[]): Promise<void> {
  const result = await run(file, args);
  if (result.code !== 0) throw new Error(`${file} failed: ${result.stderr}`);
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
 * about 50). Canonical, so paths compare equal to what the processes report.
 */
export async function makeShortTempRoot(prefix = "dse-"): Promise<string> {
  const parent = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  return fs.realpath(await fs.mkdtemp(path.join(parent, prefix)));
}

export async function startPrivateSshd(root: string): Promise<PrivateSshd> {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const hostKey = path.join(root, "hostkey");
  const userKey = path.join(root, "userkey");
  await mustRun("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", SSH_ALIAS, "-f", hostKey]);
  await mustRun("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", SSH_ALIAS, "-f", userKey]);
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
      // The probe and discovery read the session's HOME: point it at the run's directory.
      `SetEnv HOME=${home}`,
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
  const deadline = Date.now() + 10_000;
  while (!(await readBanner(port))) {
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill("SIGKILL");
      const log = await fs.readFile(logPath, "utf8").catch(() => "(no log)");
      const reason = spawnError
        ? (spawnError as Error).message
        : exited
          ? `exited with ${JSON.stringify(exited)}`
          : "did not answer within 10 s";
      throw new Error(`private sshd failed to start (${reason}):\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pid = child.pid!;

  return {
    root,
    port,
    configPath,
    home,
    pid,
    logPath,
    runSsh: (args, timeoutMs) => run(SYSTEM_SSH, ["-F", configPath, ...args], timeoutMs),
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

export interface SshWrapper {
  /** The wrapper script: what the product runs as `ssh`. */
  path: string;
  /** Its directory, for putting it first on PATH too. */
  binDir: string;
  /** One line per invocation: `<pid> <args>`. */
  invocationsLog: string;
  /**
   * Hold every invocation that would open a new connection (anything but a
   * `-O` control command to a live master) until {@link release}: a host that
   * stays unreachable for as long as the test needs, with its master's own
   * control commands still answering.
   */
  hold(): Promise<void>;
  release(): Promise<void>;
  invocations(): Promise<string>;
}

/**
 * An `ssh` that is the system ssh with the private config: `exec`, so the
 * running process is `/usr/bin/ssh -F <config> …` and is found by the config
 * path in its command line.
 */
export async function writeSshWrapper(root: string, configPath: string): Promise<SshWrapper> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const wrapperPath = path.join(binDir, "ssh");
  const invocationsLog = path.join(root, "ssh-invocations.log");
  const holdFile = path.join(root, "ssh-hold");
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      `printf '%s %s\\n' "$$" "$*" >> ${q(invocationsLog)}`,
      `case " $* " in *" -O "*) ;; *) while [ -e ${q(holdFile)} ]; do sleep 0.1; done ;; esac`,
      `exec ${SYSTEM_SSH} -F ${q(configPath)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return {
    path: wrapperPath,
    binDir,
    invocationsLog,
    hold: () => fs.writeFile(holdFile, ""),
    release: () => fs.rm(holdFile, { force: true }),
    invocations: () => fs.readFile(invocationsLog, "utf8").catch(() => "(none)"),
  };
}

/** A ControlMaster's pid, from the master itself (`ssh -O check`), or null when none answers. */
export async function masterPidAt(sshd: PrivateSshd, controlPath: string): Promise<number | null> {
  const result = await sshd.runSsh(
    ["-o", `ControlPath=${controlPath}`, "-O", "check", SSH_ALIAS],
    5_000
  );
  if (result.code !== 0) return null;
  const match = /pid=(\d+)/.exec(result.stderr + result.stdout);
  return match ? Number(match[1]) : null;
}

/** Control sockets the Shell made under its userData (`<userData>/rh/cm-…`). */
export async function controlSocketsUnder(userDataDir: string): Promise<string[]> {
  const dir = path.join(userDataDir, "rh");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith("cm-")).map((name) => path.join(dir, name));
}
