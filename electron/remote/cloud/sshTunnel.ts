import path from "node:path";
import type {
  CloudProviderCapabilities,
  CloudSshTunnelCommand,
} from "../../../shared/types/cloudHosts.js";

/**
 * A provider's tunnel runs as ssh's `ProxyCommand`, whose value ssh expands
 * for `%` tokens and then hands to the person's own `$SHELL -c` (sh, zsh or
 * fish alike). So nothing a provider declares reaches that line unless it
 * means the same in every one of them: a bare command name resolved to an
 * absolute path here, plain words, and whole ssh tokens, each double-quoted.
 */

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const WORD = /^[A-Za-z0-9._:/=@+,-]{1,128}$/;
/** HostName, Port, User and the alias: values Daintree validated before writing them. */
const TOKENS: ReadonlySet<string> = new Set(["%h", "%p", "%r", "%n"]);
const MAX_ARGS = 16;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function argProblem(arg: unknown): string | null {
  if (typeof arg === "string" && (TOKENS.has(arg) || WORD.test(arg))) return null;
  return `Tunnel argument ${JSON.stringify(arg)} isn't a plain word or one of ${[...TOKENS].join(", ")}`;
}

function tunnelProblem(tunnel: CloudSshTunnelCommand): string | null {
  if (typeof tunnel.command !== "string" || !COMMAND.test(tunnel.command)) {
    return "The tunnel's command must be a bare executable name";
  }
  if (!Array.isArray(tunnel.args) || tunnel.args.length > MAX_ARGS) {
    return `The tunnel takes at most ${MAX_ARGS} arguments`;
  }
  for (const arg of tunnel.args) {
    const problem = argProblem(arg);
    if (problem) return problem;
  }
  if (!isHttpsUrl(tunnel.installUrl)) return "The tunnel's install URL must be https";
  return null;
}

/**
 * Why a provider's SSH declaration can't be used, or null when it can. Only
 * a provider's own tunnel can stand in for a pinned host key, so trust in the
 * tunnel needs one, and a direct dial never declares one.
 */
export function sshDeclarationProblem(
  capabilities: Pick<CloudProviderCapabilities, "sshTrust" | "transport" | "tunnel">
): string | null {
  const { sshTrust, transport, tunnel } = capabilities;
  if (transport === "direct") {
    if (tunnel) return "A direct transport declares no tunnel";
    if (sshTrust === "provider-tunnel") return "Trusting the provider's tunnel needs a tunnel";
    return null;
  }
  if (transport !== "provider-command") return `Unknown SSH transport ${JSON.stringify(transport)}`;
  // Its key check scans the machine's own address, which a tunnel hides.
  if (sshTrust === "api-or-confirm")
    return "Trusting the API's key or a confirmation needs a direct transport";
  if (!tunnel) return "A provider-command transport needs a tunnel";
  return tunnelProblem(tunnel);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The `ProxyCommand` value for a tunnel found at `commandPath`. Double quotes
 * keep a path with spaces whole in every shell, and nothing that any of them
 * reads inside double quotes is let through; a literal `%` is doubled so ssh
 * doesn't take it for a token.
 */
export function proxyCommandLine(commandPath: string, args: readonly string[]): string {
  if (
    !path.isAbsolute(commandPath) ||
    /["$`\\]/.test(commandPath) ||
    hasControlCharacter(commandPath)
  ) {
    throw new Error("Refusing to run an unusual path as an ssh ProxyCommand");
  }
  const words = [`"${commandPath.replace(/%/g, "%%")}"`];
  for (const arg of args) {
    const problem = argProblem(arg);
    if (problem) throw new Error(problem);
    words.push(`"${arg}"`);
  }
  return words.join(" ");
}
