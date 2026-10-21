import dns from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Error code for a resource endpoint whose address is outside the networks a
 * preview may reach. Surfaced through the proxy's failure classification so the
 * 502 can say why instead of "not responding".
 */
export const DEV_PREVIEW_PUBLIC_ADDRESS_CODE = "EDAINTREE_PUBLIC_ADDRESS";

export interface PreviewEndpoint {
  /** Hostname as the URL parser canonicalised it: lowercased, IPv6 without brackets, no trailing dot. */
  host: string;
  port: number;
  isHttps: boolean;
}

export type ParsePreviewEndpointResult =
  { ok: true; endpoint: PreviewEndpoint } | { ok: false; message: string };

/**
 * Parse a resource `status` endpoint into something the preview proxy can dial.
 * Only http(s) with no credentials; a literal address must already be private,
 * while a name is checked on every connect (see createPrivateNetworkLookup).
 */
export function parsePreviewEndpoint(raw: string): ParsePreviewEndpointResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "The resource endpoint isn't a valid URL." };
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && url.protocol !== "http:") {
    return { ok: false, message: "The resource endpoint must be an http or https URL." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "The resource endpoint can't include credentials." };
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return { ok: false, message: "The resource endpoint has no host." };
  if (ipaddr.isValid(host) && !isPrivateNetworkAddress(host)) {
    return { ok: false, message: publicAddressMessage() };
  }
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  return { ok: true, endpoint: { host, port, isHttps } };
}

export function publicAddressMessage(): string {
  return "The resource endpoint is on a public address. Previews only reach loopback, private network and tailnet addresses.";
}

/**
 * Loopback, RFC 1918, the 100.64.0.0/10 range Tailscale assigns, and IPv6
 * loopback/unique-local (Tailscale's fd7a:115c:a1e0::/48 sits in the latter).
 * Link-local is deliberately out: 169.254.169.254 is the cloud metadata service.
 */
export function isPrivateNetworkAddress(address: string): boolean {
  let literal = address.trim();
  if (literal.startsWith("[") && literal.endsWith("]")) literal = literal.slice(1, -1);
  const zone = literal.indexOf("%");
  if (zone !== -1) literal = literal.slice(0, zone);
  if (!ipaddr.isValid(literal)) return false;
  let parsed = ipaddr.parse(literal);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  const range = parsed.range();
  if (parsed.kind() === "ipv4") {
    return range === "loopback" || range === "private" || range === "carrierGradeNat";
  }
  return range === "loopback" || range === "uniqueLocal";
}

/**
 * A `lookup` for the proxy's upstream socket that drops every public answer.
 * It runs at connect time on the socket actually used, so the address checked
 * is the address dialled — a rebinding name can't swap in a public IP between
 * a check and the connect. Node skips `lookup` for literal hosts; those are
 * checked when the endpoint is parsed.
 */
export function createPrivateNetworkLookup(): LookupFunction {
  return (hostname, options, callback) => {
    // httpxy rebuilds the target as a URL, so an IPv6 literal arrives bracketed and
    // Node, not recognising it as an address, asks for it to be looked up.
    const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : null;
    if (bare !== null && ipaddr.isValid(bare)) {
      if (!isPrivateNetworkAddress(bare)) {
        callback(publicAddressError(hostname), options.all ? [] : "", undefined);
      } else if (options.all) {
        callback(null, [{ address: bare, family: 6 }]);
      } else {
        callback(null, bare, 6);
      }
      return;
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, options.all ? [] : "", undefined);
        return;
      }
      const allowed = addresses.filter((entry) => isPrivateNetworkAddress(entry.address));
      if (allowed.length === 0) {
        callback(publicAddressError(hostname), options.all ? [] : "", undefined);
        return;
      }
      if (options.all) {
        callback(null, allowed);
        return;
      }
      callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

function publicAddressError(hostname: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${hostname} resolves only to public addresses`);
  err.code = DEV_PREVIEW_PUBLIC_ADDRESS_CODE;
  return err;
}
