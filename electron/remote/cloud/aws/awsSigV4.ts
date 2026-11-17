import crypto from "node:crypto";

/** The key pair (and, for temporary credentials, the session token) a request is signed with. */
export interface AwsSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
}

export interface AwsSignInput {
  method: string;
  url: URL;
  /** Headers to send and sign; `host` and `x-amz-date` are added. */
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: AwsSigningCredentials;
  now: Date;
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding as SigV4 defines it: everything but unreserved characters. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(pathname: string): string {
  // Every service but S3 encodes each segment of the already-encoded path again.
  return pathname
    .split("/")
    .map((segment) => awsUriEncode(segment))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20150830T123600Z`: the timestamp a SigV4 request is signed for. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Signs a request with AWS Signature Version 4 and returns every header to
 * send, the `Authorization` header among them. The secret never leaves this
 * function; only the access key id appears in what it returns.
 */
export function signAwsRequest(input: AwsSignInput): Record<string, string> {
  const stamp = amzDate(input.now);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    "x-amz-date": stamp,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lowered.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  const names = [...lowered.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url.pathname || "/"),
    canonicalQuery(input.url),
    names.map((name) => `${name}:${lowered.get(name)}\n`).join(""),
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
