import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../../client/commandRunner.js";
import { defaultCommandRunner } from "../../client/commandRunner.js";
import type { StreamCommandChild } from "../../client/commandStreamTransport.js";
import {
  controlPathFor,
  type SshChild,
  type SshSpawner,
  type SshStreamSpawner,
} from "../../client/sshTransport.js";
import { exec } from "./docker.js";

/**
 * How this process reaches a container's sshd: a private ssh_config passed as
 * `-F`, the one injection into the product's own command runner and spawners,
 * so nothing reads or writes `~/.ssh`.
 */
export interface SshRoute {
  alias: string;
  runCommand: CommandRunner;
  spawnSsh: SshSpawner;
  spawnSshStream: SshStreamSpawner;
  /** Ends the control master a transport left for `clientDir`. */
  closeMaster(clientDir: string): Promise<unknown>;
  /** Waits for a login to answer, failing after `timeoutMs` with what `why` reports. */
  waitForLogin(timeoutMs: number, why: () => Promise<string>): Promise<void>;
}

/** A new ed25519 key pair at `file` and `file.pub`. */
export async function makeUserKey(file: string, comment = "daintree-e2e"): Promise<string> {
  const keygen = await exec(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file],
    30_000
  );
  if (keygen.code !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);
  return file;
}

export async function writeSshRoute(params: {
  root: string;
  alias: string;
  port: number;
  user: string;
  identity: string;
  knownHosts: string;
  /** `yes` holds the machine to keys already in `knownHosts`; `accept-new` trusts it on first use. */
  strictHostKeyChecking: "yes" | "accept-new";
  /** The name `knownHosts` files its key under, whatever port it's published on today. */
  hostKeyAlias?: string;
}): Promise<SshRoute> {
  const { alias } = params;
  const configPath = path.join(params.root, "ssh_config");
  await fs.writeFile(
    configPath,
    [
      `Host ${alias}`,
      "  HostName 127.0.0.1",
      `  Port ${params.port}`,
      `  User ${params.user}`,
      `  IdentityFile ${params.identity}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${params.knownHosts}`,
      `  StrictHostKeyChecking ${params.strictHostKeyChecking}`,
      // Pinned by name, and held to that file alone: no system-wide known_hosts.
      ...(params.hostKeyAlias
        ? [`  HostKeyAlias ${params.hostKeyAlias}`, "  GlobalKnownHostsFile /dev/null"]
        : []),
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

  return {
    alias,
    runCommand,
    spawnSsh,
    spawnSshStream,
    closeMaster: (clientDir) =>
      runCommand(
        "ssh",
        ["-o", `ControlPath=${controlPathFor(clientDir, alias)}`, "-O", "exit", alias],
        { timeoutMs: 10_000 }
      ),
    async waitForLogin(timeoutMs, why) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const ready = await runCommand("ssh", ["-o", "ConnectTimeout=3", alias, "true"], {
          timeoutMs: 10_000,
        });
        if (ready.code === 0) return;
        if (Date.now() > deadline) {
          throw new Error(`The machine's sshd never answered: ${ready.stderr}\n${await why()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  };
}
