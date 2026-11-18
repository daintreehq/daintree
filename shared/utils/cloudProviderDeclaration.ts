import type {
  CloudCredentialField,
  CloudProviderCapabilities,
  CloudSshTunnelCommand,
} from "../types/cloudHosts.js";

/**
 * What a cloud provider declares about itself, checked the same way whether
 * Daintree compiles it in or a plugin's manifest names it. Pure, so the
 * manifest schema (which the standalone plugin CLI bundles) can run it too.
 */

export const MAX_CLOUD_CREDENTIAL_FIELDS = 16;
export const CLOUD_CREDENTIAL_FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const CLOUD_CREDENTIAL_FIELD_INPUTS = ["single-line", "multi-line", "key-file"] as const;

const FIELD_INPUTS: ReadonlySet<string> = new Set(CLOUD_CREDENTIAL_FIELD_INPUTS);

/**
 * Why a provider's declared fields can't be used, or null when they can.
 * Checked when it registers, so a malformed declaration never reaches a form.
 */
export function credentialFieldsProblem(fields: unknown): string | null {
  if (!Array.isArray(fields) || fields.length === 0) return "declares no credential fields";
  if (fields.length > MAX_CLOUD_CREDENTIAL_FIELDS) {
    return `declares more than ${MAX_CLOUD_CREDENTIAL_FIELDS} credential fields`;
  }
  const ids = new Set<string>();
  for (const raw of fields) {
    const field = raw as Partial<CloudCredentialField> | null;
    // A name every object already has would read through to Object.prototype wherever it's looked up.
    if (
      !field ||
      typeof field.id !== "string" ||
      !CLOUD_CREDENTIAL_FIELD_ID.test(field.id) ||
      field.id in Object.prototype
    ) {
      return `declares a credential field with an invalid id ${JSON.stringify(field?.id)}`;
    }
    if (ids.has(field.id)) return `declares the credential field ${field.id} twice`;
    ids.add(field.id);
    if (typeof field.label !== "string" || field.label.trim().length === 0) {
      return `declares the credential field ${field.id} without a label`;
    }
    if (typeof field.input !== "string" || !FIELD_INPUTS.has(field.input)) {
      return `declares the credential field ${field.id} with an unknown input`;
    }
    if (typeof field.secret !== "boolean" || typeof field.required !== "boolean") {
      return `declares the credential field ${field.id} without saying whether it's secret and required`;
    }
  }
  return null;
}

/**
 * A provider's tunnel runs as ssh's `ProxyCommand`, whose value ssh expands
 * for `%` tokens and then hands to the person's own `$SHELL -c` (sh, zsh or
 * fish alike). So nothing a provider declares reaches that line unless it
 * means the same in every one of them: a bare command name resolved to an
 * absolute path, plain words, and whole ssh tokens, each double-quoted.
 */
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const WORD = /^[A-Za-z0-9._:/=@+,-]{1,128}$/;
/** HostName, Port, User and the alias: values Daintree validated before writing them. */
const TOKENS: ReadonlySet<string> = new Set(["%h", "%p", "%r", "%n"]);
export const MAX_CLOUD_TUNNEL_ARGS = 16;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Why one tunnel argument can't go on a `ProxyCommand` line, or null when it can. */
export function tunnelArgProblem(arg: unknown): string | null {
  if (typeof arg === "string" && (TOKENS.has(arg) || WORD.test(arg))) return null;
  return `Tunnel argument ${JSON.stringify(arg)} isn't a plain word or one of ${[...TOKENS].join(", ")}`;
}

function tunnelProblem(tunnel: CloudSshTunnelCommand): string | null {
  if (typeof tunnel.command !== "string" || !COMMAND.test(tunnel.command)) {
    return "The tunnel's command must be a bare executable name";
  }
  if (!Array.isArray(tunnel.args) || tunnel.args.length > MAX_CLOUD_TUNNEL_ARGS) {
    return `The tunnel takes at most ${MAX_CLOUD_TUNNEL_ARGS} arguments`;
  }
  for (const arg of tunnel.args) {
    const problem = tunnelArgProblem(arg);
    if (problem) return problem;
  }
  if (!isHttpsUrl(tunnel.installUrl)) return "The tunnel's install URL must be https";
  return null;
}

/**
 * Why a provider's SSH declaration can't be used, or null when it can. Only
 * a provider's own tunnel can stand in for a pinned host key, so trust in the
 * tunnel needs one, a direct dial never declares one, and a key confirmed on
 * first connect is confirmed on a direct dial.
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
  if (sshTrust === "api-or-confirm") {
    return "Trusting the API's key or a confirmation needs a direct transport";
  }
  if (!tunnel) return "A provider-command transport needs a tunnel";
  // The lifecycle can't put a key in front of the person through a tunnel yet, so every dial would fail.
  if (sshTrust === "confirm-on-first-connect") {
    return "Confirming a host key on first connect needs a direct transport";
  }
  return tunnelProblem(tunnel);
}
