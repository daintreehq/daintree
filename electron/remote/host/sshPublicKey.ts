import { createHash, createPublicKey, type JsonWebKey } from "node:crypto";

/** An RSA key of 16384 bits is under 3 KB of base64; nothing real comes near this. */
export const MAX_PUBLIC_KEY_LENGTH = 16 * 1024;

export interface ParsedPublicKey {
  type: string;
  /** `type base64`, the comment dropped: a comment is the file's, not the key's. */
  publicKey: string;
  /** As `ssh-keygen -E sha256 -lf` prints it. */
  fingerprint: string;
}

/** Reads SSH wire fields (RFC 4251) off a key blob, failing on anything short. */
class WireReader {
  private offset = 0;
  constructor(private readonly blob: Buffer) {}

  bytes(): Buffer | null {
    if (this.offset + 4 > this.blob.length) return null;
    const length = this.blob.readUInt32BE(this.offset);
    const start = this.offset + 4;
    if (start + length > this.blob.length) return null;
    this.offset = start + length;
    return this.blob.subarray(start, start + length);
  }

  string(): string | null {
    return this.bytes()?.toString("latin1") ?? null;
  }

  /** A positive mpint: non-empty, no sign bit, no needless leading zero. */
  positiveMpint(): Buffer | null {
    const value = this.bytes();
    if (!value || value.length === 0 || (value[0]! & 0x80) !== 0) return null;
    if (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) return null;
    return value;
  }

  get done(): boolean {
    return this.offset === this.blob.length;
  }
}

const CURVES: Record<string, { crv: string; length: number }> = {
  nistp256: { crv: "P-256", length: 65 },
  nistp384: { crv: "P-384", length: 97 },
  nistp521: { crv: "P-521", length: 133 },
};

/** Whether OpenSSL takes `jwk` as a public key: a point on its curve, a well-formed modulus. */
function acceptedKey(jwk: JsonWebKey): boolean {
  try {
    createPublicKey({ key: jwk, format: "jwk" });
    return true;
  } catch {
    return false;
  }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

function ecPoint(reader: WireReader, curve: string): boolean {
  const spec = CURVES[curve];
  if (!spec || reader.string() !== curve) return false;
  const point = reader.bytes();
  if (!point || point.length !== spec.length || point[0] !== 0x04) return false;
  const half = (spec.length - 1) / 2;
  return acceptedKey({
    kty: "EC",
    crv: spec.crv,
    x: base64url(point.subarray(1, 1 + half)),
    y: base64url(point.subarray(1 + half)),
  });
}

/** OpenSSH refuses RSA keys under 1024 bits, and doesn't make any over 16384. */
function rsaKey(reader: WireReader): boolean {
  const e = reader.positiveMpint();
  const n = reader.positiveMpint();
  if (!e || !n) return false;
  const modulus = n[0] === 0 ? n.subarray(1) : n;
  const bits = modulus.length * 8 - Math.clz32(modulus[0]!) + 24;
  if (bits < 1024 || bits > 16384) return false;
  return acceptedKey({
    kty: "RSA",
    n: base64url(modulus),
    e: base64url(e[0] === 0 ? e.subarray(1) : e),
  });
}

/** A security key's application: a C string to OpenSSH, so no NUL in it. */
function application(reader: WireReader): boolean {
  const value = reader.bytes();
  return value !== null && value.length > 0 && !value.includes(0);
}

/** Each host key type's fields after its name, as OpenSSH encodes them. */
const BODY = new Map<string, (reader: WireReader) => boolean>([
  ["ssh-ed25519", (r) => r.bytes()?.length === 32],
  ["ssh-rsa", rsaKey],
  [
    "ssh-dss",
    (r) =>
      r.positiveMpint() !== null &&
      r.positiveMpint() !== null &&
      r.positiveMpint() !== null &&
      r.positiveMpint() !== null,
  ],
  ["ecdsa-sha2-nistp256", (r) => ecPoint(r, "nistp256")],
  ["ecdsa-sha2-nistp384", (r) => ecPoint(r, "nistp384")],
  ["ecdsa-sha2-nistp521", (r) => ecPoint(r, "nistp521")],
  ["sk-ssh-ed25519@openssh.com", (r) => r.bytes()?.length === 32 && application(r)],
  ["sk-ecdsa-sha2-nistp256@openssh.com", (r) => ecPoint(r, "nistp256") && application(r)],
]);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * One OpenSSH public key file's key, or null when the text isn't one: the
 * first non-blank, non-comment line must be `type base64 [comment]`, a known
 * host key type whose blob names that type and holds exactly its fields.
 */
export function parsePublicKeyFile(text: string): ParsedPublicKey | null {
  const line = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row !== "" && !row.startsWith("#"));
  if (!line) return null;
  // OpenSSH separates fields with spaces and tabs only.
  const [type, encoded] = line.split(/[ \t]+/);
  const body = type ? BODY.get(type) : undefined;
  if (!type || !body || !encoded) return null;
  if (encoded.length > MAX_PUBLIC_KEY_LENGTH || !BASE64.test(encoded)) return null;
  const blob = Buffer.from(encoded, "base64");
  if (blob.toString("base64") !== encoded) return null;
  const reader = new WireReader(blob);
  if (reader.string() !== type || !body(reader) || !reader.done) return null;
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { type, publicKey: `${type} ${encoded}`, fingerprint: `SHA256:${digest}` };
}
