import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../client/commandRunner.js";
import { closeSshMaster } from "../client/sshTransport.js";
import { sshExecutable, sshKeyscanExecutable } from "../client/sshExecutable.js";
import { isValidCloudBindingId } from "../../../shared/types/remoteHosts.js";
import {
  formatSshEndpoint,
  isSafeSshUser,
  isValidSshEndpoint,
  normalizeHostKey,
  parseKeyscanOutput,
  type SshEndpoint,
} from "./sshEndpoint.js";
import { isValidCloudAccountId } from "./CloudHostStore.js";
import { proxyCommandLine } from "./sshTunnel.js";

/**
 * How the system ssh reaches one cloud machine, without touching the user's
 * ~/.ssh: an application-owned config per machine, read by a tiny `ssh`
 * wrapper that adds `-F <that config>` to every invocation. Every call the
 * Remote Hosts transport makes (probe, install, scp, the ControlMaster, the
 * forward, the stdio bridge, `-O exit`) goes through the wrapper, so all of
 * them use the same port, key and pinned host key.
 *
 * The config pins the server key the provider's authenticated API returned,
 * or the one the person confirmed when the provider can't vouch for any
 * (`StrictHostKeyChecking yes` against an app-owned known_hosts keyed by an
 * alias, never the recycled address), uses a Daintree-generated key per
 * account and nothing from the user's agent, and turns off every forward.
 * A provider that reaches its machines through its own CLI gets that CLI as
 * the `ProxyCommand`; only when the provider vouches for the machine through
 * that tunnel, rather than with a key, is nothing pinned.
 */

const UNREADABLE = Symbol("unreadable");

export interface CloudSshRoute {
  /** The ssh destination: an alias only the route's config defines. */
  target: string;
  /** The wrapper to run as `ssh`. */
  sshPath: string;
  configPath: string;
}

/** A provider's tunnel as found on this device. */
export interface CloudSshResolvedTunnel {
  /** The absolute path the tunnel's command resolved to on PATH. */
  commandPath: string;
  args: readonly string[];
}

export interface CloudSshAccessRecord {
  user: string;
  endpoint: SshEndpoint;
  /** The server key to pin; null only when the provider's tunnel vouches for the machine. */
  hostKey: string | null;
  /** Null for a direct dial. */
  tunnel: CloudSshResolvedTunnel | null;
}

function quoteConfig(value: string): string {
  // ssh_config takes double-quoted arguments; nothing we write has a quote.
  if (/["\n\r]/.test(value))
    throw new Error("Refusing to write an unusual path into an ssh config");
  return `"${value}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class CloudSshFiles {
  constructor(
    private readonly root: string,
    private readonly run: CommandRunner
  ) {}

  aliasFor(bindingId: string): string {
    return `dtc-${bindingId}`;
  }

  private dirFor(bindingId: string): string {
    if (!isValidCloudBindingId(bindingId)) throw new Error("Not a cloud binding id");
    return path.join(this.root, "machines", bindingId);
  }

  private keyPathFor(accountId: string): string {
    if (!isValidCloudAccountId(accountId)) throw new Error("Not a cloud account id");
    return path.join(this.root, "keys", `${accountId}_ed25519`);
  }

  route(bindingId: string): CloudSshRoute {
    const dir = this.dirFor(bindingId);
    return {
      target: this.aliasFor(bindingId),
      sshPath: path.join(dir, "ssh"),
      configPath: path.join(dir, "config"),
    };
  }

  private readonly generating = new Map<string, Promise<string>>();

  /** The account's public key, generated on first use: one Daintree identity per device and account. */
  publicKey(accountId: string): Promise<string> {
    // Two machines on one account dialled at once share one ssh-keygen.
    let pending = this.generating.get(accountId);
    if (!pending) {
      pending = this.readOrGenerate(accountId).finally(() => this.generating.delete(accountId));
      this.generating.set(accountId, pending);
    }
    return pending;
  }

  /**
   * Whether the account's private key, the one ssh signs in with, is on disk.
   * Asks nothing of ssh-keygen and makes nothing; a key being made now is
   * waited for.
   */
  async hasKey(accountId: string): Promise<boolean> {
    await this.generating.get(accountId)?.catch(() => {});
    return isPresent(this.keyPathFor(accountId));
  }

  private async readOrGenerate(accountId: string): Promise<string> {
    const keyPath = this.keyPathFor(accountId);
    // A public half whose private key is gone signs nothing: it is replaced with a new pair.
    if (await isPresent(keyPath)) {
      try {
        return (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Machines that took the key at create can't be given another: a private key
      // whose public half went missing gets it back instead of being replaced.
      // ssh-keygen refuses a key others can read; one that can't be made ours is kept as it is.
      await fs.chmod(keyPath, 0o600);
      const derived = await this.run("ssh-keygen", ["-y", "-P", "", "-f", keyPath], {
        timeoutMs: 20_000,
      });
      const publicKey = derived.code === 0 ? derived.stdout.trim() : "";
      if (publicKey) {
        await writeAtomic(`${keyPath}.pub`, `${publicKey}\n`, 0o644);
        return publicKey;
      }
      // Only a key ssh-keygen read and rejected is replaced; one it couldn't be asked about is kept.
      if (derived.code === null || derived.code === 0 || derived.spawnError || derived.timedOut) {
        throw new Error(derived.spawnError ?? "ssh-keygen didn't answer");
      }
    }
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // A private key it can't read back (an interrupted run) would make ssh-keygen prompt, and
    // an old public half must never sit beside a new private key a cut-short run left alone.
    await fs.rm(keyPath, { force: true });
    await fs.rm(`${keyPath}.pub`, { force: true });
    const made = await this.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `daintree-${accountId}`, "-f", keyPath],
      { timeoutMs: 20_000 }
    );
    if (made.code !== 0) {
      throw new Error(made.spawnError ?? (made.stderr.trim() || "ssh-keygen failed"));
    }
    await fs.chmod(keyPath, 0o600).catch(() => {});
    return (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
  }

  /** What the machine's files hold for this access: config, pinned key (null for none) and wrapper. */
  private render(
    bindingId: string,
    accountId: string,
    access: CloudSshAccessRecord
  ): { config: string; knownHosts: string | null; wrapper: string } {
    const route = this.route(bindingId);
    const knownHostsPath = path.join(path.dirname(route.configPath), "known_hosts");
    const alias = route.target;
    // Every value below lands in an ssh config, and %h, %p and %r in a shell.
    if (
      typeof access.user !== "string" ||
      !isSafeSshUser(access.user) ||
      !isValidSshEndpoint(access.endpoint)
    ) {
      throw new Error("Refusing to write an unusual ssh address into an ssh config");
    }
    const hostKey = access.hostKey === null ? null : normalizeHostKey(access.hostKey);
    if (access.hostKey !== null && hostKey === null) {
      throw new Error("Refusing to pin an unusual ssh host key");
    }
    if (hostKey === null && access.tunnel === null) {
      throw new Error("Refusing to reach a cloud machine with neither a pinned key nor a tunnel");
    }
    const proxy = access.tunnel
      ? [`  ProxyCommand ${proxyCommandLine(access.tunnel.commandPath, access.tunnel.args)}`]
      : [];
    const trust =
      hostKey !== null
        ? [
            `  HostKeyAlias ${alias}`,
            `  UserKnownHostsFile ${quoteConfig(knownHostsPath)}`,
            "  GlobalKnownHostsFile /dev/null",
            "  StrictHostKeyChecking yes",
            "  UpdateHostKeys no",
            "  CheckHostIP no",
          ]
        : [
            // The provider's tunnel vouches for a machine whose key changes when it
            // is rebuilt or moved. No known_hosts at all: a stale entry would let
            // ssh connect with port forwarding turned off. LogLevel ERROR drops the
            // "Permanently added" line every connection would print.
            "  UserKnownHostsFile /dev/null",
            "  GlobalKnownHostsFile /dev/null",
            "  StrictHostKeyChecking no",
            "  UpdateHostKeys no",
            "  CheckHostIP no",
            "  LogLevel ERROR",
          ];
    return {
      config: [
        `# Written by Daintree for one cloud machine; rewritten on every start.`,
        `Host ${alias}`,
        `  HostName ${access.endpoint.host}`,
        `  Port ${access.endpoint.port}`,
        `  User ${access.user}`,
        ...proxy,
        ...trust,
        `  IdentityFile ${quoteConfig(this.keyPathFor(accountId))}`,
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  BatchMode yes",
        "",
      ].join("\n"),
      knownHosts: hostKey === null ? null : `${alias} ${hostKey}\n`,
      // The real ssh is resolved now, as every other call does (DAINTREE_SSH or PATH).
      wrapper: `#!/bin/sh\nexec ${shellQuote(sshExecutable())} -F ${shellQuote(route.configPath)} "$@"\n`,
    };
  }

  /** Writes the machine's config, pinned host key and wrapper for the access just resolved. */
  async write(
    bindingId: string,
    accountId: string,
    access: CloudSshAccessRecord
  ): Promise<CloudSshRoute> {
    const route = this.route(bindingId);
    const dir = path.dirname(route.configPath);
    const knownHosts = path.join(dir, "known_hosts");
    const files = this.render(bindingId, accountId, access);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    if (files.knownHosts !== null) await writeAtomic(knownHosts, files.knownHosts, 0o600);
    await writeAtomic(route.configPath, files.config, 0o600);
    // Gone only once no config names it: an unpinned machine keeps no key on file.
    if (files.knownHosts === null) await fs.rm(knownHosts, { force: true });
    await writeAtomic(route.sshPath, files.wrapper, 0o700);
    return route;
  }

  /**
   * Whether the files on disk are exactly what {@link write} would write for
   * this access: a route left by an earlier run is only reused when they are,
   * so a provider that moved its tunnel or trust, or a write cut short, never
   * dials with what was there.
   */
  async isCurrent(
    bindingId: string,
    accountId: string,
    access: CloudSshAccessRecord
  ): Promise<boolean> {
    const route = this.route(bindingId);
    const knownHosts = path.join(path.dirname(route.configPath), "known_hosts");
    let files;
    try {
      files = this.render(bindingId, accountId, access);
    } catch {
      return false;
    }
    // Only a file that isn't there reads as absent; one that can't be read never matches.
    const read = (file: string) =>
      fs
        .readFile(file, "utf8")
        .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : UNREADABLE));
    const [config, pinned, wrapper] = await Promise.all([
      read(route.configPath),
      read(knownHosts),
      read(route.sshPath),
    ]);
    return config === files.config && pinned === files.knownHosts && wrapper === files.wrapper;
  }

  async exists(bindingId: string): Promise<boolean> {
    const route = this.route(bindingId);
    try {
      await fs.access(route.sshPath);
      await fs.access(route.configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The server keys the machine presents right now, strongest first, for a
   * provider whose API can't vouch for one. Nothing here trusts them: the
   * person confirms one, and ssh then pins it. Empty when the machine didn't
   * answer with any.
   */
  async scanHostKeys(
    endpoint: SshEndpoint,
    options: { types?: string; signal?: AbortSignal } = {}
  ): Promise<string[]> {
    const scanned = await this.run(
      sshKeyscanExecutable(),
      [
        "-T",
        "10",
        "-p",
        String(endpoint.port),
        "-t",
        options.types ?? "ed25519,ecdsa,rsa",
        endpoint.host,
      ],
      { timeoutMs: 20_000, signal: options.signal }
    );
    if (scanned.spawnError) throw new Error(`ssh-keyscan couldn't run: ${scanned.spawnError}`);
    return parseKeyscanOutput(scanned.stdout);
  }

  /** What an endpoint shows as, for diagnostics. */
  describe(access: CloudSshAccessRecord): string {
    return `${access.user}@${formatSshEndpoint(access.endpoint)}`;
  }

  /** Tells the machine's master to exit, through the config it was opened with. */
  async closeMaster(clientDir: string, bindingId: string): Promise<void> {
    const route = this.route(bindingId);
    if (await this.exists(bindingId)) {
      await closeSshMaster(this.run, clientDir, route.target, 5_000, route.sshPath);
    }
  }

  /** Closes the machine's master and removes its files. The account key stays for its other machines. */
  async forget(clientDir: string, bindingId: string): Promise<void> {
    const route = this.route(bindingId);
    await this.closeMaster(clientDir, bindingId);
    await fs.rm(path.dirname(route.configPath), { recursive: true, force: true }).catch(() => {});
  }

  /** Removes an account's key once nothing uses it. */
  async forgetAccount(accountId: string): Promise<void> {
    const keyPath = this.keyPathFor(accountId);
    // A key still being made or recovered would otherwise be written after it was removed.
    await this.generating.get(accountId)?.catch(() => {});
    await fs.rm(keyPath, { force: true }).catch(() => {});
    await fs.rm(`${keyPath}.pub`, { force: true }).catch(() => {});
  }
}

/** Only a file that isn't there reads as absent; any other failure to look is thrown. */
async function isPresent(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode });
  await fs.chmod(temp, mode);
  await fs.rename(temp, filePath);
}
