import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Base32 without the letters people misread (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 2 * 60_000;
/** Wrong codes a pairing window absorbs before it closes for good. */
export const PAIRING_MAX_ATTEMPTS = 3;

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Compares two hex digests in constant time; a malformed one never matches. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

/** Formats as `ABCD-EFGH` for reading aloud; `normalizePairingCode` undoes it. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type PairingAttempt = "ok" | "wrong" | "none";

/**
 * At most one pairing code exists at a time, in memory only. It is good for
 * one pairing within its TTL, and a few wrong guesses close it, so a code read
 * over a shoulder or guessed through the tunnel has a short, small window.
 */
export class PairingCodes {
  private current: { code: string; expiresAt: number; attempts: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  issue(): { code: string; expiresAt: number } {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++)
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.current = { code, expiresAt, attempts: 0 };
    return { code, expiresAt };
  }

  /** The open code's expiry, or null when none is open. */
  openUntil(): number | null {
    this.expire();
    return this.current?.expiresAt ?? null;
  }

  cancel(): void {
    this.current = null;
  }

  redeem(input: string): PairingAttempt {
    this.expire();
    const open = this.current;
    if (open === null) return "none";
    const given = Buffer.from(normalizePairingCode(input));
    const wanted = Buffer.from(open.code);
    if (given.length === wanted.length && timingSafeEqual(given, wanted)) {
      this.current = null;
      return "ok";
    }
    open.attempts += 1;
    if (open.attempts >= PAIRING_MAX_ATTEMPTS) this.current = null;
    return "wrong";
  }

  private expire(): void {
    if (this.current !== null && this.now() >= this.current.expiresAt) this.current = null;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Normalizes what the user typed as the tailnet name (`mac.tail1234.ts.net`,
 * with or without a scheme, port or trailing dot) to a bare lowercase host
 * name, or null when it is not one.
 */
export function normalizeTailnetHost(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let host = input.trim().toLowerCase();
  host = host
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (host === "" || host.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }
  return host;
}

/**
 * Whether a request's `Host` names this listener: loopback at its own port
 * (`ssh -L` to the same port), or the tailnet name the user gave, on any
 * port (`tailscale serve` terminates on 443 and keeps the name). Anything
 * else is a page that rebound some other name onto 127.0.0.1.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  port: number,
  tailnetHost: string | null
): boolean {
  if (typeof hostHeader !== "string" || hostHeader === "") return false;
  const header = hostHeader.trim().toLowerCase();
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header);
  if (!match) return false;
  const name = match[1]!.replace(/\.$/, "");
  const givenPort = match[2] === undefined ? null : Number(match[2]);
  if (LOOPBACK_HOSTNAMES.has(name)) return givenPort === port;
  return tailnetHost !== null && name === tailnetHost;
}

/**
 * Whether a request may act: a browser that says it came from another site,
 * or an `Origin` that is not this same host, is refused. Requests with
 * neither header (a script on the device) pass to the token check.
 */
export function isSameOriginRequest(headers: {
  host?: string;
  origin?: string;
  "sec-fetch-site"?: string;
}): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (
      url.host.toLowerCase() === (headers.host ?? "").trim().toLowerCase().replace(/:443$/, "")
    );
  } catch {
    return false;
  }
}
