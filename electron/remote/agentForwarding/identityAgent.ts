import { execFile } from "node:child_process";
import path from "node:path";
import { sshExecutable } from "../client/sshExecutable.js";

/**
 * Which agent ssh uses for a destination. An `IdentityAgent` line in the ssh
 * config takes the place of `SSH_AUTH_SOCK` (1Password's setup puts one under
 * `Host *`), and it is also the agent ssh's own `ForwardAgent yes` would
 * forward. `ssh -G` prints the value with `~` and `%` tokens already
 * expanded, leaving only `none`, `SSH_AUTH_SOCK` and `$VAR` as written.
 */

const SSH_CONFIG_TIMEOUT_MS = 5_000;
const SSH_CONFIG_MAX_BYTES = 256 * 1024;

/** The `identityagent` value in `ssh -G` output; null when the config sets none. */
export function parseIdentityAgent(sshConfigDump: string): string | null {
  for (const line of sshConfigDump.split("\n")) {
    const match = /^identityagent\s+(.+?)\s*$/i.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/** Whether an IdentityAgent value still means the agent in `SSH_AUTH_SOCK`. */
export function namesAuthSockEnv(identityAgent: string): boolean {
  return identityAgent === "SSH_AUTH_SOCK" || identityAgent === "$SSH_AUTH_SOCK";
}

/** The socket ssh would talk to, given what `ssh -G` said; null for none. */
export function agentSocketFor(
  identityAgent: string | null,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const fromEnv = (name: string): string | null => {
    const value = env[name];
    return value && path.isAbsolute(value) ? value : null;
  };
  if (identityAgent === null || namesAuthSockEnv(identityAgent)) return fromEnv("SSH_AUTH_SOCK");
  if (identityAgent === "none") return null;
  if (identityAgent.startsWith("$")) return fromEnv(identityAgent.slice(1));
  return path.isAbsolute(identityAgent) ? identityAgent : null;
}

export type SshConfigReader = (destination: string, env?: NodeJS.ProcessEnv) => Promise<string>;

/** `ssh -G <destination>`: reads the config only, never connects. */
export const readSshConfig: SshConfigReader = (destination, env = process.env) =>
  new Promise((resolve, reject) => {
    execFile(
      sshExecutable(env),
      ["-G", destination],
      { env, timeout: SSH_CONFIG_TIMEOUT_MS, maxBuffer: SSH_CONFIG_MAX_BYTES, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
    );
  });

/**
 * `ssh -G` expands `${SSH_AUTH_SOCK}` in an IdentityAgent from its own
 * environment, so a Host reads its config with this in its place: a value
 * that comes back as this one names whatever socket a terminal is handed.
 */
export const AUTH_SOCK_PLACEHOLDER = "/daintree-forwarded-agent-placeholder.sock";

/** The Host's IdentityAgent for a destination as a terminal there would see it. */
export async function readTerminalIdentityAgent(
  destination: string,
  read: SshConfigReader = readSshConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const identityAgent = parseIdentityAgent(
    await read(destination, { ...env, SSH_AUTH_SOCK: AUTH_SOCK_PLACEHOLDER })
  );
  return identityAgent === AUTH_SOCK_PLACEHOLDER ? "SSH_AUTH_SOCK" : identityAgent;
}
