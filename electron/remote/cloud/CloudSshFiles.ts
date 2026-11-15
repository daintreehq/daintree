import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../client/commandRunner.js";
import { closeSshMaster } from "../client/sshTransport.js";
import { sshExecutable } from "../client/sshExecutable.js";
import { isValidCloudBindingId } from "../../../shared/types/remoteHosts.js";
import { formatSshEndpoint, type SshEndpoint } from "./sshEndpoint.js";
import { isValidCloudAccountId } from "./CloudHostStore.js";

/**
 * How the system ssh reaches one cloud machine, without touching the user's
 * ~/.ssh: an application-owned config per machine, read by a tiny `ssh`
 * wrapper that adds `-F <that config>` to every invocation. Every call the
 * Remote Hosts transport makes (probe, install, scp, the ControlMaster, the
 * forward, the stdio bridge, `-O exit`) goes through the wrapper, so all of
 * them use the same port, key and pinned host key.
 *
 * The config pins the server key the provider's authenticated API returned
 * (`StrictHostKeyChecking yes` against an app-owned known_hosts keyed by an
 * alias, never the recycled address), uses a Daintree-generated key per
 * account and nothing from the user's agent, and turns off every forward.
 */

export interface CloudSshRoute {
  /** The ssh destination: an alias only the route's config defines. */
  target: string;
  /** The wrapper to run as `ssh`. */
  sshPath: string;
  configPath: string;
}

export interface CloudSshAccessRecord {
  user: string;
  endpoint: SshEndpoint;
  hostKey: string;
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

  private async readOrGenerate(accountId: string): Promise<string> {
    const keyPath = this.keyPathFor(accountId);
    try {
      return (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
    } catch {
      // Not made yet.
    }
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // A private key without its public half (an interrupted run) would make ssh-keygen prompt.
    await fs.rm(keyPath, { force: true });
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

  /** Writes the machine's config, pinned host key and wrapper for the access just resolved. */
  async write(
    bindingId: string,
    accountId: string,
    access: CloudSshAccessRecord
  ): Promise<CloudSshRoute> {
    const route = this.route(bindingId);
    const dir = path.dirname(route.configPath);
    const knownHosts = path.join(dir, "known_hosts");
    const alias = route.target;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    await writeAtomic(knownHosts, `${alias} ${access.hostKey}\n`, 0o600);
    await writeAtomic(
      route.configPath,
      [
        `# Written by Daintree for one cloud machine; rewritten on every start.`,
        `Host ${alias}`,
        `  HostName ${access.endpoint.host}`,
        `  Port ${access.endpoint.port}`,
        `  User ${access.user}`,
        `  HostKeyAlias ${alias}`,
        `  UserKnownHostsFile ${quoteConfig(knownHosts)}`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  UpdateHostKeys no",
        "  CheckHostIP no",
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
      0o600
    );
    // The real ssh is resolved now, as every other call does (DAINTREE_SSH or PATH).
    await writeAtomic(
      route.sshPath,
      `#!/bin/sh\nexec ${shellQuote(sshExecutable())} -F ${shellQuote(route.configPath)} "$@"\n`,
      0o700
    );
    return route;
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
    await fs.rm(keyPath, { force: true }).catch(() => {});
    await fs.rm(`${keyPath}.pub`, { force: true }).catch(() => {});
  }
}

async function writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode });
  await fs.chmod(temp, mode);
  await fs.rename(temp, filePath);
}
