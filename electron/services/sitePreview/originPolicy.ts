/**
 * Where a guest adapter may run.
 *
 * A dev preview can navigate. "This panel started on localhost" says nothing
 * about the document it shows a minute later — an OAuth hop, a link to the
 * production site, a redirect — and the runtime the host installs is code that
 * reads the page's DOM and talks back over a CDP binding. An adapter therefore
 * declares the origins it is for, and the bridge checks the guest's URL on
 * every install: at bind, and again on each committed navigation.
 */

export type GuestOriginPolicy =
  /** Loopback, `*.localhost`, `*.local` and RFC 1918 addresses: a dev server. */
  | "local-preview"
  /** Any document the preview shows. */
  | "any";

export const DEFAULT_GUEST_ORIGIN_POLICY: GuestOriginPolicy = "local-preview";

/** Schemes a preview shows before, or instead of, a site. Nothing to protect. */
const NO_SITE_SCHEMES = new Set(["about:", "chrome-error:"]);

const RFC1918 = [
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 168, 0, 0], bits: 16 },
];

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function inBlock(octets: number[], base: number[], bits: number): boolean {
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const network = ((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function isLocalHost(hostname: string): boolean {
  // WHATWG URL lower-cases hostnames and brackets IPv6 literals, but keeps a
  // fully-qualified trailing dot, which Chromium treats as the same host.
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host === "[::1]" || host === "[::]") return true;
  const octets = ipv4Octets(host);
  if (octets === null) return false;
  // 127/8 is loopback; 0.0.0.0 is what a dev server bound to every interface
  // prints, and the browser treats it as the local machine.
  if (octets[0] === 127 || host === "0.0.0.0") return true;
  return RFC1918.some(({ base, bits }) => inBlock(octets, base, bits));
}

/**
 * Whether a document at `url` counts as a local preview. An empty URL and the
 * pages a preview shows before any site loads are local: there is nothing
 * there yet, and installing on them is what puts the runtime in place for the
 * dev server's first document.
 */
export function isLocalPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (NO_SITE_SCHEMES.has(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isLocalHost(parsed.hostname);
}

export function originPolicyAllows(
  policy: GuestOriginPolicy,
  url: string | null | undefined
): boolean {
  return policy === "any" || isLocalPreviewUrl(url);
}
