// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import type { LinkSession } from "../../link/session.js";
import {
  EmptyPayloadSchema,
  LinkMethod,
  SshHostKeysAnswerSchema,
  type SshListenerReading,
} from "../linkMethods.js";
import {
  createSshHostKeysReader,
  readSshHostKeys,
  systemSshHostKeyReaderDeps,
  type ConfigDumpResult,
  type SshHostKeyReaderDeps,
} from "../sshHostKeys.js";
import { FIXTURE_KEYS, NOT_A_PRIVATE_KEY } from "./sshKeyFixtures.js";

const SSHD = "/usr/sbin/sshd";

function hasTool(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasKeygen = hasTool("sh", ["-c", "command -v ssh-keygen"]);

let root: string;
let proc: string;
let etc: string;

/** Every path the reader opened, read, listed or followed, by how. */
let touched: Array<{
  how: "open" | "readFile" | "readdir" | "readlink" | "stat" | "lstat";
  file: string;
}>;
let openFlags: number[];
let unreadable: Set<string>;
let dumps: Array<{ binary: string; args: string[] }>;
let dumpOverride: ((args: string[]) => ConfigDumpResult | null) | null;
let trusted: Set<string>;

/** One fixture process in the fake `/proc`. */
function processEntry(
  pid: number,
  options: {
    comm?: string;
    argv?: string[] | null;
    title?: string;
    ppid?: number;
    startTime?: string;
    nspid?: number[];
    exe?: string;
    /** The process's `mountinfo`; null leaves it unreadable. */
    mountinfo?: string | null;
  }
) {
  const dir = path.join(proc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comm"), `${options.comm ?? "sshd"}\n`);
  const fields = [
    "S",
    String(options.ppid ?? 1),
    ...Array(17).fill("0"),
    options.startTime ?? "4242",
  ];
  fs.writeFileSync(
    path.join(dir, "stat"),
    `${pid} (${options.comm ?? "sshd"}) ${fields.join(" ")} 0 0\n`
  );
  const cmdline =
    options.title !== undefined
      ? `${options.title}\0`
      : options.argv === null
        ? ""
        : `${(options.argv ?? [SSHD, "-D"]).join("\0")}\0`;
  fs.writeFileSync(path.join(dir, "cmdline"), cmdline);
  fs.writeFileSync(
    path.join(dir, "status"),
    `Name:\tsshd\nNSpid:\t${(options.nspid ?? [pid]).join("\t")}\n`
  );
  if (options.exe) fs.symlinkSync(options.exe, path.join(dir, "exe"));
  const mountinfo = options.mountinfo === undefined ? HOST_ROOT : options.mountinfo;
  if (mountinfo !== null) fs.writeFileSync(path.join(dir, "mountinfo"), mountinfo);
}

const DUMP_CWD = "/tmp/daintree-sshd-g-fixture";

/** This Host's root mount, and a container's overlay root. */
const HOST_ROOT = "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n";
const CONTAINER_ROOT = "601 512 0:52 / / rw,relatime master:9 - overlay overlay rw\n";

/** A key pair on disk: a stand-in private key and the fixture's public half. */
function keyPair(file: string, key: keyof typeof FIXTURE_KEYS, publicFile = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, NOT_A_PRIVATE_KEY, { mode: 0o600 });
  if (publicFile) fs.writeFileSync(`${file}.pub`, `${FIXTURE_KEYS[key].line}\n`);
}

function config(file: string, lines: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** As `sshd -G` prints a config: its host keys and listen addresses, after the command line's. */
function fakeConfigDump(args: string[]): ConfigDumpResult {
  const keys: string[] = [];
  let configFile = path.join(etc, "ssh/sshd_config");
  let port = "22";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f") configFile = args[++i]!;
    else if (args[i] === "-h") keys.push(args[++i]!);
    else if (args[i] === "-p") port = args[++i]!;
    else if (args[i] === "-o") {
      const match = /^HostKey[= ](.+)$/i.exec(args[++i]!);
      if (match) keys.push(match[1]!.replace(/^"(.*)"$/, "$1"));
    }
  }
  let text: string;
  try {
    text = configFile.toLowerCase() === "none" ? "" : fs.readFileSync(configFile, "utf8");
  } catch {
    return { ok: false, reason: "denied" };
  }
  for (const line of text.split("\n")) {
    const [keyword, value] = line.trim().split(/\s+/);
    // A relative HostKey comes out absolute against the dump's working directory.
    if (keyword?.toLowerCase() === "hostkey" && value) {
      keys.push(path.posix.isAbsolute(value) ? value : `${DUMP_CWD}/${value}`);
    }
    if (keyword?.toLowerCase() === "port" && value) port = value;
  }
  return {
    ok: true,
    stdout: [
      `port ${port}`,
      `listenaddress 0.0.0.0:${port}`,
      ...keys.map((k) => `hostkey ${k}`),
    ].join("\n"),
    cwd: DUMP_CWD,
  };
}

function deps(overrides: Partial<SshHostKeyReaderDeps> = {}): SshHostKeyReaderDeps {
  const record = <T>(how: (typeof touched)[number]["how"], file: string, run: () => Promise<T>) => {
    touched.push({ how, file });
    return run();
  };
  return {
    platform: "linux",
    procRoot: proc,
    readFile: (file) => record("readFile", file, () => fsp.readFile(file, "utf8")),
    readdir: (dir) => record("readdir", dir, () => fsp.readdir(dir)),
    readlink: (file) => record("readlink", file, () => fsp.readlink(file)),
    defaultConfigFile: path.join(etc, "ssh/sshd_config"),
    open: (file, flags) => {
      openFlags.push(flags);
      return record("open", file, () => fsp.open(file, flags));
    },
    stat: (file) => record("stat", file, () => fsp.stat(file)),
    lstat: (file) => record("lstat", file, () => fsp.lstat(file)),
    canRead: async (file) => !unreadable.has(file) && fs.existsSync(file),
    trustBinary: async (binary) => (trusted.has(binary) ? binary : null),
    runConfigDump: async (binary, args) => {
      dumps.push({ binary, args });
      return dumpOverride?.(args) ?? fakeConfigDump(args);
    },
    now: () => Date.now(),
    ...overrides,
  };
}

async function reading(overrides?: Partial<SshHostKeyReaderDeps>) {
  const answer = SshHostKeysAnswerSchema.parse(await readSshHostKeys(deps(overrides)));
  if (answer.status !== "reading") throw new Error(`expected a reading, got ${answer.status}`);
  return answer;
}

/** The standard daemon: OpenSSH 8.2+'s retitled listener on `/etc/ssh`, with two keys. */
function standardDaemon(pid = 100) {
  config(path.join(etc, "ssh/sshd_config"), [
    `HostKey ${etc}/ssh/ssh_host_ed25519_key`,
    `HostKey ${etc}/ssh/ssh_host_rsa_key`,
  ]);
  keyPair(path.join(etc, "ssh/ssh_host_ed25519_key"), "ed25519");
  keyPair(path.join(etc, "ssh/ssh_host_rsa_key"), "rsa");
  processEntry(pid, { title: `sshd: ${SSHD} -D [listener] 0 of 10-100 startups` });
}

function tunnelDaemon(pid = 200) {
  const tunnel = path.join(root, "opt/tunnel");
  config(path.join(tunnel, "sshd_config"), [`HostKey ${tunnel}/keys/host_ecdsa`, "Port 2222"]);
  keyPair(path.join(tunnel, "keys/host_ecdsa"), "ecdsa");
  processEntry(pid, { argv: [SSHD, "-D", "-f", path.join(tunnel, "sshd_config")] });
  return tunnel;
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "ssh-host-keys-"));
  proc = path.join(root, "proc");
  etc = path.join(root, "etc");
  fs.mkdirSync(path.join(proc, "self"), { recursive: true });
  fs.writeFileSync(path.join(proc, "self/status"), "Name:\tnode\nNSpid:\t1\n");
  fs.writeFileSync(path.join(proc, "self/mountinfo"), HOST_ROOT);
  touched = [];
  openFlags = [];
  unreadable = new Set();
  dumps = [];
  dumpOverride = null;
  trusted = new Set([SSHD]);
});

afterEach(async () => {
  await fsp.chmod(root, 0o700).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

describe("readSshHostKeys (#18257)", () => {
  it("reads a standard daemon and a nonstandard one at once, grouped by listener", async () => {
    standardDaemon();
    const tunnel = tunnelDaemon();
    // A connection's processes are never listeners: pre-9.8 retitled children, 9.8+ sshd-session.
    processEntry(101, { title: "sshd: alice [priv]", ppid: 100 });
    processEntry(102, { title: "sshd: alice@pts/0", ppid: 101 });
    processEntry(103, { comm: "sshd-session", argv: ["sshd-session: alice"], ppid: 100 });
    processEntry(104, { argv: [SSHD, "-D", "-R"], ppid: 100 });
    processEntry(300, { comm: "bash", argv: ["bash"] });

    const answer = await reading();
    expect(answer.complete).toBe(true);
    expect(answer.listeners.map((l) => l.pid)).toEqual([100, 200]);
    const [standard, other] = answer.listeners as [SshListenerReading, SshListenerReading];
    expect(standard.configFile).toBeNull();
    expect(standard.keys.map((k) => k.outcome === "read" && k.fingerprint)).toEqual([
      FIXTURE_KEYS.ed25519.fingerprint,
      FIXTURE_KEYS.rsa.fingerprint,
    ]);
    expect(other.configFile).toBe(path.join(tunnel, "sshd_config"));
    expect(other.listenAddresses).toEqual(["0.0.0.0:2222"]);
    expect(other.keys).toEqual([
      expect.objectContaining({
        outcome: "read",
        hostKeyPath: path.join(tunnel, "keys/host_ecdsa"),
        publicKeyPath: path.join(tunnel, "keys/host_ecdsa.pub"),
        fingerprint: FIXTURE_KEYS.ecdsa.fingerprint,
      }),
    ]);
    expect(standard.listenerId).not.toBeNull();
    expect(other.listenerId).not.toBeNull();
    expect(standard.listenerId).not.toBe(other.listenerId);
    expect(dumps.map((dump) => dump.args)).toEqual([
      ["-G"],
      ["-G", "-f", path.join(tunnel, "sshd_config")],
    ]);
  });

  it.skipIf(!hasKeygen)("gives each key the fingerprint ssh-keygen gives its .pub", async () => {
    standardDaemon();
    tunnelDaemon();
    const answer = await reading();
    const keys = answer.listeners.flatMap((listener) => listener.keys);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      if (key.outcome !== "read") throw new Error(`${key.publicKeyPath}: ${key.outcome}`);
      const printed = execFileSync("ssh-keygen", ["-E", "sha256", "-lf", key.publicKeyPath], {
        encoding: "utf8",
      });
      expect(printed.split(" ")[1]).toBe(key.fingerprint);
    }
  });

  it("never opens or reads a private key, only stats it", async () => {
    standardDaemon();
    tunnelDaemon();
    await reading();
    const privateKeys = new Set(
      ["ssh/ssh_host_ed25519_key", "ssh/ssh_host_rsa_key"]
        .map((file) => path.join(etc, file))
        .concat(path.join(root, "opt/tunnel/keys/host_ecdsa"))
    );
    const outsideProc = touched.filter((entry) => !entry.file.startsWith(proc));
    // Each private key is stat-ed, to tell it from its .pub, and nothing more.
    for (const key of privateKeys) {
      expect(outsideProc.filter((e) => e.file === key).map((e) => e.how)).toEqual(["stat"]);
    }
    const opened = outsideProc.filter((e) => e.how === "open").map((e) => e.file);
    expect(opened.sort()).toEqual([...privateKeys].map((file) => `${file}.pub`).sort());
    // Beyond its .pub siblings the reader reads only the configs it checks for includes.
    for (const entry of outsideProc.filter((e) => e.how !== "stat")) {
      expect(privateKeys.has(entry.file), `${entry.how} ${entry.file}`).toBe(false);
    }
    expect(openFlags.every((flags) => (flags & fs.constants.O_NOFOLLOW) !== 0)).toBe(true);
  });

  it("keeps the same listener id across a restart, and none for two listeners it can't tell apart", async () => {
    standardDaemon(100);
    const first = await reading();
    fs.rmSync(path.join(proc, "100"), { recursive: true });
    processEntry(150, { argv: [SSHD, "-D"], startTime: "9999" });
    const restarted = await reading();
    expect(restarted.listeners[0]!.listenerId).toBe(first.listeners[0]!.listenerId);

    processEntry(160, { argv: [SSHD, "-D", "-e"], ppid: 1 });
    const twins = await reading();
    expect(twins.listeners.map((l) => l.listenerId)).toEqual([null, null]);
  });

  it("says a .pub is missing, and marks the listener and the reading incomplete", async () => {
    standardDaemon();
    fs.rmSync(path.join(etc, "ssh/ssh_host_rsa_key.pub"));
    const answer = await reading();
    expect(answer.complete).toBe(false);
    expect(answer.listeners[0]!.complete).toBe(false);
    expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual(["read", "missing"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "says a .pub it may not read is permission-denied",
    async () => {
      standardDaemon();
      fs.chmodSync(path.join(etc, "ssh/ssh_host_rsa_key.pub"), 0o000);
      const answer = await reading();
      expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual([
        "read",
        "permission-denied",
      ]);
    }
  );

  it("refuses a .pub that is a symlink or a hard link to the private key", async () => {
    standardDaemon();
    const rsa = path.join(etc, "ssh/ssh_host_rsa_key");
    const ed = path.join(etc, "ssh/ssh_host_ed25519_key");
    fs.rmSync(`${rsa}.pub`);
    fs.symlinkSync(rsa, `${rsa}.pub`);
    fs.rmSync(`${ed}.pub`);
    fs.linkSync(ed, `${ed}.pub`);
    const answer = await reading();
    expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual([
      "not-a-public-file",
      "not-a-public-file",
    ]);
    // Refused from their entries, before anything was opened.
    expect(touched.filter((e) => e.how === "open")).toEqual([]);
  });

  it("refuses a .pub that is another configured key's private half, unopened", async () => {
    standardDaemon();
    const rsa = path.join(etc, "ssh/ssh_host_rsa_key");
    const ed = path.join(etc, "ssh/ssh_host_ed25519_key");
    fs.rmSync(`${ed}.pub`);
    fs.linkSync(rsa, `${ed}.pub`);
    const answer = await reading();
    expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual(["not-a-public-file", "read"]);
    expect(touched.filter((e) => e.how === "open").map((e) => e.file)).toEqual([`${rsa}.pub`]);
  });

  it.each([
    ["EACCES", "EPERM"],
    ["EPERM", "EACCES"],
  ])("says permission-denied for %s on the entry and %s on the open", async (onEntry, onOpen) => {
    standardDaemon();
    const denied = (code: string) => Object.assign(new Error(code), { code });
    const answer = await reading({
      lstat: async (file) => {
        if (file.endsWith("rsa_key.pub")) throw denied(onEntry);
        return fsp.lstat(file);
      },
      open: async (file, flags) => {
        if (file.endsWith("ed25519_key.pub")) throw denied(onOpen);
        return fsp.open(file, flags);
      },
    });
    expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual([
      "permission-denied",
      "permission-denied",
    ]);
  });

  it("refuses a .pub that is another listener's private key, unopened", async () => {
    standardDaemon();
    const tunnel = tunnelDaemon();
    const ecdsa = path.join(tunnel, "keys/host_ecdsa");
    fs.rmSync(`${ecdsa}.pub`);
    fs.linkSync(path.join(etc, "ssh/ssh_host_rsa_key"), `${ecdsa}.pub`);
    const answer = await reading();
    expect(answer.listeners[1]!.keys.map((k) => k.outcome)).toEqual(["not-a-public-file"]);
    expect(touched.some((e) => e.how === "open" && e.file === `${ecdsa}.pub`)).toBe(false);
  });

  it("leaves a daemon with its own mount over the key directory unread", async () => {
    standardDaemon();
    fs.rmSync(path.join(proc, "100"), { recursive: true });
    const bound = `${HOST_ROOT}77 22 259:2 /srv/provider-ssh ${etc}/ssh ro,relatime - ext4 /dev/nvme0n1p2 ro\n`;
    processEntry(100, { argv: [SSHD, "-D"], mountinfo: bound });
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({
      gaps: ["other-namespace"],
      keys: [],
      listenerId: null,
    });
    expect(touched.some((e) => e.how === "open")).toBe(false);
  });

  it("keeps a retitled listener whose parent is an sshd, as under a container's sshd PID 1", async () => {
    standardDaemon();
    processEntry(500, {
      title: `sshd: ${SSHD} -D -p 2500 [listener] 0 of 10-100 startups`,
      ppid: 100,
    });
    const answer = await reading();
    expect(answer.listeners.map((l) => l.pid)).toEqual([100, 500]);
  });

  it("reports a relative HostKey from the config as relative, not as the dump resolved it", async () => {
    config(path.join(etc, "ssh/sshd_config"), ["HostKey ssh_host_relative_key"]);
    processEntry(100, { argv: [SSHD, "-D"] });
    const answer = await reading();
    expect(answer.listeners[0]!.keys).toEqual([
      expect.objectContaining({ outcome: "relative-path", hostKeyPath: "ssh_host_relative_key" }),
    ]);
    expect(answer.listeners[0]!.complete).toBe(false);
  });

  it("reads a quoted -o HostKey with a space in its path", async () => {
    const key = path.join(etc, "ssh dir/quoted_key");
    keyPair(key, "ed25519");
    processEntry(100, { argv: [SSHD, "-D", "-f", "NONE", "-o", `HostKey "${key}"`] });
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({ gaps: [], complete: true });
    expect(dumps[0]!.args).toEqual(["-G", "-f", "NONE", "-o", `HostKey "${key}"`]);
  });

  it("says a .pub holding something else is invalid", async () => {
    standardDaemon();
    fs.writeFileSync(path.join(etc, "ssh/ssh_host_rsa_key.pub"), "not a key\n");
    const answer = await reading();
    expect(answer.listeners[0]!.keys.map((k) => k.outcome)).toEqual(["read", "invalid"]);
  });

  it("reads a HostKey that ends in .pub as its sibling, never the configured file", async () => {
    const agentKey = path.join(etc, "ssh/agent_key.pub");
    config(path.join(etc, "ssh/sshd_config"), [`HostKey ${agentKey}`]);
    keyPair(agentKey, "ed25519");
    processEntry(100, { argv: [SSHD, "-D"] });
    const answer = await reading();
    expect(answer.listeners[0]!.keys).toEqual([
      expect.objectContaining({ outcome: "read", publicKeyPath: `${agentKey}.pub` }),
    ]);
    expect(touched.filter((e) => e.how === "open").map((e) => e.file)).toEqual([`${agentKey}.pub`]);
  });

  it("names a listener whose command line couldn't be read or parsed", async () => {
    processEntry(100, { argv: null });
    // A retitled command line joins args by spaces, so a path with one can't be recovered.
    processEntry(200, {
      title: `sshd: ${SSHD} -D -f /opt/my tunnel/sshd_config [listener] 0 of 10-100 startups`,
    });
    const answer = await reading();
    expect(answer.listeners.map((l) => [l.pid, l.gaps, l.complete])).toEqual([
      [100, ["command-line-unreadable"], false],
      [200, ["command-line-unreadable"], false],
    ]);
    expect(dumps).toEqual([]);
  });

  it("leaves another container's daemon uninspected", async () => {
    standardDaemon();
    processEntry(400, { argv: [SSHD, "-D"], nspid: [400, 1] });
    const answer = await reading();
    expect(answer.listeners.find((l) => l.pid === 400)).toMatchObject({
      gaps: ["other-namespace"],
      keys: [],
      complete: false,
    });
  });

  it("leaves a daemon with another root uninspected, and one whose root it can't see unread", async () => {
    standardDaemon();
    processEntry(410, { argv: [SSHD, "-D", "-p", "2210"], mountinfo: CONTAINER_ROOT });
    processEntry(420, { argv: [SSHD, "-D", "-p", "2220"], mountinfo: null });
    const answer = await reading();
    expect(answer.listeners.map((l) => [l.pid, l.gaps, l.keys.length])).toEqual([
      [100, [], 2],
      [410, ["other-namespace"], 0],
      [420, ["namespace-unknown"], 0],
    ]);
    expect(answer.complete).toBe(false);
  });

  it("takes a daemon started with the ignored -Q as a listener", async () => {
    standardDaemon();
    fs.rmSync(path.join(proc, "100"), { recursive: true });
    processEntry(100, { argv: [SSHD, "-D", "-Q"] });
    const answer = await reading();
    expect(answer.listeners.map((l) => l.pid)).toEqual([100]);
  });

  it("replays the command line's options to sshd -G in the daemon's order", async () => {
    standardDaemon();
    fs.rmSync(path.join(proc, "100"), { recursive: true });
    const extra = path.join(etc, "ssh/extra_key");
    processEntry(100, {
      argv: [SSHD, "-Dp", "2202", "-o", "Port=2201", "-h", extra, "-E", "/var/log/sshd.log", "-4"],
    });
    await reading();
    expect(dumps[0]!.args).toEqual(["-G", "-p", "2202", "-o", "Port=2201", "-h", extra, "-4"]);
  });

  it("refuses a relative HostKey from -o as well as -h, and accepts -f none", async () => {
    processEntry(100, { argv: [SSHD, "-D", "-o", "HostKey=ssh_host_key"] });
    const key = path.join(etc, "ssh/only_key");
    keyPair(key, "ed25519");
    processEntry(200, { argv: [SSHD, "-D", "-f", "none", "-h", key] });
    const answer = await reading();
    expect(answer.listeners.map((l) => [l.pid, l.gaps])).toEqual([
      [100, ["relative-path"]],
      [200, []],
    ]);
    expect(answer.listeners[1]!.keys).toEqual([expect.objectContaining({ outcome: "read" })]);
  });

  it("marks a reading partial when an Include it names couldn't have been read", async () => {
    standardDaemon();
    const conf = path.join(etc, "ssh/sshd_config");
    fs.appendFileSync(conf, "Include sshd_config.d/*.conf\n");
    const included = path.join(etc, "ssh/sshd_config.d");
    fs.mkdirSync(included);
    // A comment, a quoted path, a literal that names nothing and `Include=` are all fine.
    fs.mkdirSync(path.join(etc, "ssh/more conf"));
    fs.appendFileSync(
      conf,
      `Include "${etc}/ssh/more conf/*.conf" # extra\nInclude=${etc}/ssh/absent.conf\n`
    );
    expect((await reading()).listeners[0]!.gaps).toEqual([]);
    unreadable.add(included);
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({ gaps: ["config-unreadable"], complete: false });
    // What it could read still shows.
    expect(answer.listeners[0]!.keys.every((k) => k.outcome === "read")).toBe(true);
  });

  it("says truncated past the addresses an answer carries", async () => {
    standardDaemon();
    dumpOverride = (args) => {
      const dump = fakeConfigDump(args);
      if (!dump.ok) return dump;
      const many = Array.from({ length: 65 }, (_, i) => `listenaddress 10.0.0.${i}:22`);
      return { ...dump, stdout: `${dump.stdout}\n${many.join("\n")}` };
    };
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({ gaps: ["truncated"], complete: false });
    expect(answer.listeners[0]!.listenAddresses).toHaveLength(64);
  });

  it("identifies a listener by all its addresses, not the ones an answer carries", async () => {
    standardDaemon();
    processEntry(110, { argv: [SSHD, "-D", "-p", "2110"] });
    const first64 = Array.from({ length: 64 }, (_, i) => `listenaddress 10.0.0.${i}:22`);
    dumpOverride = (args) => {
      const extra = args.includes("2110") ? first64 : [...first64, "listenaddress 10.0.1.0:22"];
      return { ok: true, stdout: extra.join("\n"), cwd: DUMP_CWD };
    };
    const answer = await reading();
    expect(answer.listeners.map((l) => l.listenAddresses.length)).toEqual([64, 64]);
    const [truncated, whole] = answer.listeners;
    expect(truncated!.gaps).toEqual(["truncated"]);
    expect(truncated!.listenerId).not.toBeNull();
    expect(whole!.listenerId).not.toBeNull();
    expect(truncated!.listenerId).not.toBe(whole!.listenerId);
  });

  it("gives no listener an id when some were left out, since one could share it", async () => {
    standardDaemon();
    for (let i = 0; i < 32; i++)
      processEntry(1000 + i, { argv: [SSHD, "-D", "-p", String(3000 + i)] });
    const answer = await reading();
    expect(answer.truncated).toBe(true);
    expect(answer.complete).toBe(false);
    expect(answer.listeners).toHaveLength(32);
    expect(answer.listeners.every((l) => l.listenerId === null)).toBe(true);
  });

  it("runs no binary it doesn't trust, and reads only the command line's own keys", async () => {
    const key = path.join(etc, "ssh/explicit_key");
    keyPair(key, "ed25519");
    processEntry(100, { argv: ["/home/eve/sshd", "-D", "-h", key] });
    const answer = await reading();
    expect(dumps).toEqual([]);
    expect(answer.listeners[0]).toMatchObject({
      listenerId: null,
      complete: false,
      gaps: ["untrusted-binary"],
      keys: [expect.objectContaining({ outcome: "read", hostKeyPath: key })],
    });
  });

  it("prefers the kernel's exe link, and falls back to the program name when it was replaced", async () => {
    standardDaemon();
    fs.rmSync(path.join(proc, "100"), { recursive: true });
    processEntry(100, { argv: ["sshd", "-D"], exe: "/usr/local/sbin/sshd" });
    processEntry(110, { argv: [SSHD, "-D", "-p", "2200"], exe: `${SSHD} (deleted)` });
    trusted.add("/usr/local/sbin/sshd");
    await reading();
    expect(dumps.map((dump) => dump.binary)).toEqual(["/usr/local/sbin/sshd", SSHD]);
  });

  it("falls back to the command line's keys on an sshd without -G, marked partial", async () => {
    const key = path.join(etc, "ssh/override_key");
    keyPair(key, "rsa");
    processEntry(100, { argv: [SSHD, "-D", "-o", `HostKey=${key}`] });
    dumpOverride = () => ({ ok: false, reason: "unsupported" });
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({
      listenerId: null,
      complete: false,
      gaps: ["config-dump-unavailable"],
      keys: [
        expect.objectContaining({ outcome: "read", fingerprint: FIXTURE_KEYS.rsa.fingerprint }),
      ],
    });
  });

  it("says a config sshd -G couldn't read is config-unreadable", async () => {
    processEntry(100, { argv: [SSHD, "-D", "-f", path.join(root, "nowhere/sshd_config")] });
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({
      gaps: ["config-unreadable"],
      keys: [],
      complete: false,
    });
  });

  it("refuses relative paths it can't resolve as the daemon did", async () => {
    processEntry(100, { argv: [SSHD, "-D", "-f", "sshd_config"] });
    const answer = await reading();
    expect(answer.listeners[0]!.gaps).toEqual(["relative-path"]);
    expect(dumps).toEqual([]);
  });

  it("drops what it read when the pid was reused mid-read", async () => {
    standardDaemon();
    dumpOverride = (args) => {
      fs.writeFileSync(
        path.join(proc, "100/stat"),
        `100 (sshd) S 1 ${Array(17).fill("0").join(" ")} 7777 0 0\n`
      );
      return fakeConfigDump(args);
    };
    const answer = await reading();
    expect(answer.listeners[0]).toMatchObject({ gaps: ["exited"], keys: [], listenerId: null });
  });

  it("stops at the deadline and says so", async () => {
    standardDaemon();
    let clock = 0;
    dumpOverride = (args) => {
      clock += 10_000;
      return fakeConfigDump(args);
    };
    tunnelDaemon();
    const answer = await reading({ now: () => clock });
    expect(answer.listeners.map((l) => l.gaps)).toEqual([[], ["timed-out"]]);
    expect(answer.complete).toBe(false);
  });

  it("says no sshd is visible when the process table shows none", async () => {
    processEntry(300, { comm: "bash", argv: ["bash"] });
    processEntry(101, { title: "sshd: alice [priv]", ppid: 1 });
    await expect(readSshHostKeys(deps())).resolves.toEqual({ status: "no-sshd-visible" });
  });

  it("says discovery failed when the process table can't be read", async () => {
    await expect(readSshHostKeys(deps({ procRoot: path.join(root, "missing") }))).resolves.toEqual({
      status: "discovery-failed",
    });
  });

  it("answers unsupported-platform off Linux, reading nothing", async () => {
    await expect(readSshHostKeys(deps({ platform: "darwin" }))).resolves.toEqual({
      status: "unsupported-platform",
      platform: "darwin",
    });
    expect(touched).toEqual([]);
  });

  it("answers timed-out on time when a read is stuck, without starting another", async () => {
    standardDaemon();
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    let lstats = 0;
    const read = createSshHostKeysReader(
      deps({
        lstat: async (file) => {
          lstats++;
          await stuck;
          return fsp.lstat(file);
        },
      }),
      50
    );
    await expect(read()).resolves.toEqual({ status: "timed-out" });
    await expect(read()).resolves.toEqual({ status: "timed-out" });
    expect(dumps).toHaveLength(1);
    expect(lstats).toBe(1);
    release();
    await expect.poll(async () => (await read()).status).toBe("reading");
  });

  it("shares one read among callers asking at once", async () => {
    standardDaemon();
    const read = createSshHostKeysReader(deps());
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toBe(b);
    expect(dumps).toHaveLength(1);
    await read();
    expect(dumps).toHaveLength(2);
  });
});

const realDump = (() => {
  if (process.platform === "win32" || !fs.existsSync(SSHD)) return false;
  try {
    execFileSync(SSHD, ["-G", "-f", "/dev/null"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!realDump)("readSshHostKeys against this machine's sshd -G", () => {
  it("resolves a fixture daemon's HostKeys and command-line overrides", async () => {
    const dir = path.join(root, "daemon");
    config(path.join(dir, "sshd_config"), [`HostKey ${dir}/host_ed25519`, "Port 2299"]);
    keyPair(path.join(dir, "host_ed25519"), "ed25519");
    keyPair(path.join(dir, "extra_rsa"), "rsa");
    processEntry(100, {
      argv: [SSHD, "-D", "-f", path.join(dir, "sshd_config"), "-h", path.join(dir, "extra_rsa")],
    });
    const answer = await reading({
      runConfigDump: systemSshHostKeyReaderDeps.runConfigDump,
      trustBinary: systemSshHostKeyReaderDeps.trustBinary,
    });
    const listener = answer.listeners[0]!;
    expect(listener.gaps).toEqual([]);
    expect(listener.listenAddresses.some((address) => address.endsWith(":2299"))).toBe(true);
    expect(
      listener.keys.map((k) => (k.outcome === "read" ? k.fingerprint : k.outcome)).sort()
    ).toEqual([FIXTURE_KEYS.ed25519.fingerprint, FIXTURE_KEYS.rsa.fingerprint].sort());
  });
});

describe("the host.ssh-host-keys link method", () => {
  let dir: string;
  const sessions: LinkSession[] = [];

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.close("test over");
    await removeTempDir(dir);
  });

  async function pair() {
    const linked = await openSessionPair(dir);
    sessions.push(linked.host, linked.client);
    return linked;
  }

  it("carries a reading to the Shell under its wire name, in the shape the Shell validates", async () => {
    standardDaemon();
    tunnelDaemon();
    const answer = await readSshHostKeys(deps());
    const { host, client } = await pair();
    host.registerCallHandler(LinkMethod.SSH_HOST_KEYS, EmptyPayloadSchema, async () => answer);
    const received = await client.call("host.ssh-host-keys", null);
    expect(SshHostKeysAnswerSchema.parse(received)).toEqual(answer);
    expect(answer).toMatchObject({ status: "reading", complete: true });
  });

  it("refuses an answer claiming completeness its evidence doesn't show", () => {
    const listener = {
      listenerId: "sshd:x",
      pid: 1,
      complete: true,
      gaps: [],
      configFile: null,
      listenAddresses: [],
      keys: [{ outcome: "missing", hostKeyPath: "/k", publicKeyPath: "/k.pub" }],
    };
    const answer = { status: "reading", complete: false, truncated: false, listeners: [listener] };
    expect(SshHostKeysAnswerSchema.safeParse(answer).success).toBe(false);
    const read = {
      outcome: "read",
      hostKeyPath: "/k",
      publicKeyPath: "/k.pub",
      type: "ssh-ed25519",
      publicKey: FIXTURE_KEYS.ed25519.line.split(" ").slice(0, 2).join(" "),
      fingerprint: FIXTURE_KEYS.ed25519.fingerprint,
    };
    const whole = { ...listener, keys: [read] };
    expect(
      SshHostKeysAnswerSchema.safeParse({ ...answer, complete: true, listeners: [whole] }).success
    ).toBe(true);
    expect(
      SshHostKeysAnswerSchema.safeParse({
        ...answer,
        complete: true,
        truncated: true,
        listeners: [whole],
      }).success
    ).toBe(false);
    const empty = { ...listener, keys: [] };
    expect(SshHostKeysAnswerSchema.safeParse({ ...answer, listeners: [empty] }).success).toBe(
      false
    );
    const honest = { ...listener, complete: false };
    expect(SshHostKeysAnswerSchema.safeParse({ ...answer, listeners: [honest] }).success).toBe(
      true
    );
    expect(
      SshHostKeysAnswerSchema.safeParse({ ...answer, complete: true, listeners: [honest] }).success
    ).toBe(false);
  });

  it("is UNSUPPORTED on a Host from before it, which a caller can tell from a failure", async () => {
    const { client } = await pair();
    await expect(client.call(LinkMethod.SSH_HOST_KEYS, null)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
