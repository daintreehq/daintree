import net from "node:net";
import crypto from "node:crypto";

export interface SshEndpoint {
  /** A DNS name, an IPv4 address, or an IPv6 address without brackets. */
  host: string;
  port: number;
}

const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

function validHost(host: string): boolean {
  return net.isIP(host) !== 0 || HOSTNAME.test(host);
}

function validPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * An endpoint as a provider reports it: `host`, `host:port`, `[v6]` or
 * `[v6]:port`, or a bare IPv6 address (which has colons of its own and so
 * never carries a port). Null for anything else; never a naive split.
 */
export function parseSshEndpoint(
  value: string | null | undefined,
  defaultPort = 22
): SshEndpoint | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 300) return null;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    const host = text.slice(1, close);
    if (net.isIPv6(host) === false) return null;
    const rest = text.slice(close + 1);
    if (rest === "") return { host, port: defaultPort };
    if (!rest.startsWith(":")) return null;
    const port = validPort(rest.slice(1));
    return port === null ? null : { host, port };
  }
  if (net.isIPv6(text)) return { host: text, port: defaultPort };
  const colon = text.lastIndexOf(":");
  if (colon < 0) return validHost(text) ? { host: text, port: defaultPort } : null;
  if (text.indexOf(":") !== colon) return null;
  const host = text.slice(0, colon);
  const port = validPort(text.slice(colon + 1));
  return port !== null && validHost(host) ? { host, port } : null;
}

export function formatSshEndpoint(endpoint: SshEndpoint): string {
  const host = net.isIPv6(endpoint.host) ? `[${endpoint.host}]` : endpoint.host;
  return endpoint.port === 22 ? host : `${host}:${endpoint.port}`;
}

const HOST_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa|rsa-sha2-256|rsa-sha2-512) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;

/** A server public key as `type base64`, the comment dropped; null unless it is one. */
export function normalizeHostKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = HOST_KEY.exec(value.trim());
  if (!match) return null;
  const blob = Buffer.from(match[2], "base64");
  if (blob.length < 32) return null;
  return `${match[1]} ${match[2]}`;
}

/** `SHA256:…` as ssh-keygen -l prints it. */
export function hostKeyFingerprint(normalizedKey: string): string {
  const blob = Buffer.from(normalizedKey.split(" ")[1] ?? "", "base64");
  return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** A username ssh can be given without it being read as anything else. */
export function isSafeSshUser(user: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/i.test(user);
}
