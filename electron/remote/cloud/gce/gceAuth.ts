import crypto from "node:crypto";
import { z } from "zod";
import { AppError } from "../../../utils/errorTypes.js";
import { GCE_PRODUCTION_API_URL } from "./GceClient.js";
import { GceApiError, redactGceText } from "./gceErrors.js";

/** The one token endpoint a packaged build signs assertions for. */
export const GCE_PRODUCTION_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Where a service account's assertions are exchanged for tokens: Google's own
 * endpoint for the production API, and a development override's own origin
 * for anything else, so a fake never sees an assertion signed for Google.
 */
export function gceTokenUrlFor(apiUrl: string): string {
  return apiUrl === GCE_PRODUCTION_API_URL
    ? GCE_PRODUCTION_TOKEN_URL
    : `${new URL(apiUrl).origin}/token`;
}

/** Compute Engine read and write, and nothing else the service account may hold. */
export const GCE_COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

const ASSERTION_LIFETIME_S = 3600;
/** A token is used until this little of its life is left. */
const TOKEN_MARGIN_MS = 60_000;
const MAX_CACHED_TOKENS = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * A project id as Compute Engine names one: 6 to 30 lowercase letters,
 * digits and hyphens, starting with a letter, with an optional legacy
 * `domain:` prefix.
 */
export const GCE_PROJECT_ID = /^(?:[a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const SERVICE_ACCOUNT_EMAIL = /^[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]{1,253}$/;

export interface GceServiceAccountKey {
  clientEmail: string;
  privateKeyId: string;
  /** PEM, as the key file holds it. */
  privateKey: string;
  /** The project the key was made in; null when the file doesn't say. */
  projectId: string | null;
}

function invalidKey(message: string): AppError {
  return new AppError({ code: "VALIDATION", message, userMessage: message });
}

const keyFileSchema = z
  .object({
    type: z.string().optional(),
    project_id: z.string().optional(),
    private_key_id: z.string().optional(),
    private_key: z.string().optional(),
    client_email: z.string().optional(),
  })
  .loose();

/**
 * A service-account key file's contents, checked for the shape Google issues:
 * JSON of `type: "service_account"` with an RSA private key. Its `token_uri`
 * is never read: assertions are only ever signed for the endpoint this build
 * pins, so a doctored file can't send one elsewhere.
 */
export function parseGceServiceAccountKey(text: string): GceServiceAccountKey {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalidKey("That isn't a service-account key file: it should be JSON.");
  }
  const parsed = keyFileSchema.safeParse(json);
  if (!parsed.success || Array.isArray(json)) {
    throw invalidKey("That isn't a service-account key file: it should be a JSON object.");
  }
  const file = parsed.data;
  if (file.type !== "service_account") {
    throw invalidKey(
      "That isn't a service-account key. Create a JSON key for a service account in the Google Cloud console."
    );
  }
  const clientEmail = file.client_email?.trim() ?? "";
  const privateKeyId = file.private_key_id?.trim() ?? "";
  const privateKey = file.private_key ?? "";
  if (!SERVICE_ACCOUNT_EMAIL.test(clientEmail) || !/^[A-Za-z0-9]{1,128}$/.test(privateKeyId)) {
    throw invalidKey("That key file is missing its service account or key id.");
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: privateKey, format: "pem" });
  } catch {
    throw invalidKey("That key file's private key can't be read.");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw invalidKey("That key file's private key isn't an RSA key.");
  }
  const projectId = file.project_id?.trim() ?? "";
  return {
    clientEmail,
    privateKeyId,
    privateKey,
    projectId: GCE_PROJECT_ID.test(projectId) ? projectId : null,
  };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** A JWT-bearer assertion for `tokenUrl`, signed with the service account's key (RS256). */
export function signGceAssertion(
  key: GceServiceAccountKey,
  tokenUrl: string,
  nowSeconds: number
): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.privateKeyId };
  const claims = {
    iss: key.clientEmail,
    scope: GCE_COMPUTE_SCOPE,
    aud: tokenUrl,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_S,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(input), key.privateKey);
  return `${input}.${base64url(signature)}`;
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().positive().optional(),
    token_type: z.string().optional(),
  })
  .loose();

const tokenErrorSchema = z
  .object({ error: z.string().optional(), error_description: z.string().optional() })
  .loose();

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GceTokenSourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Access tokens for service-account keys, exchanged at one token endpoint and
 * kept in memory until shortly before they expire. Nothing here is written to
 * disk; a key whose file changes gets its own entry, so a replaced key never
 * reuses its predecessor's token.
 */
export class GceTokenSource {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<CachedToken>>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly tokenUrl: string,
    private readonly options: GceTokenSourceOptions = {}
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /**
   * An access token for this key, from memory while it is still good. `fresh`
   * always asks Google, so a key disabled since its last token was issued is
   * found out.
   */
  async token(key: GceServiceAccountKey, signal?: AbortSignal, fresh = false): Promise<string> {
    if (signal?.aborted || this.shutdown.signal.aborted) {
      throw new GceApiError("cancelled", "Cancelled", null, null);
    }
    const id = cacheKey(key);
    const cached = fresh ? undefined : this.cache.get(id);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;
    if (fresh) this.cache.delete(id);
    let pending = this.inFlight.get(id);
    if (!pending) {
      // Shared by every caller and bounded by its own timeout, so one caller giving up doesn't fail the rest.
      pending = this.exchange(key).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, pending);
    }
    const exchanged = await raceSignal(pending, signal);
    this.remember(id, exchanged);
    return exchanged.token;
  }

  /** Cancels any exchange under way and forgets every token; nothing is asked for afterwards. */
  dispose(): void {
    this.shutdown.abort();
    this.cache.clear();
  }

  private remember(id: string, token: CachedToken): void {
    this.cache.delete(id);
    this.cache.set(id, token);
    const now = this.now();
    for (const [other, entry] of this.cache) {
      if (this.cache.size <= MAX_CACHED_TOKENS && entry.expiresAt > now) break;
      this.cache.delete(other);
    }
  }

  private async exchange(key: GceServiceAccountKey): Promise<CachedToken> {
    const issuedAt = this.now();
    const assertion = signGceAssertion(key, this.tokenUrl, Math.floor(issuedAt / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.any([timeout.signal, this.shutdown.signal]),
        redirect: "error",
      });
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof GceApiError) throw error;
      if (this.shutdown.signal.aborted) throw new GceApiError("cancelled", "Cancelled", null, null);
      if (timeout.signal.aborted) {
        throw new GceApiError("timeout", "Google's sign-in didn't answer in time", null, null);
      }
      throw new GceApiError("network", "Couldn't reach Google's sign-in", null, null);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const envelope = tokenErrorSchema.safeParse(json);
      const code = envelope.success ? (envelope.data.error ?? null) : null;
      const said = envelope.success ? envelope.data.error_description : undefined;
      const kind =
        response.status >= 500
          ? "server"
          : response.status === 429
            ? "rate-limited"
            : code === "invalid_grant" || code === "invalid_client" || response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "forbidden"
                : "invalid-request";
      throw new GceApiError(
        kind,
        redactGceText(said ?? `Google's sign-in answered ${response.status}`),
        response.status,
        code
      );
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new GceApiError(
        "bad-response",
        "Google's sign-in answered in a shape Daintree doesn't recognise",
        response.status,
        null
      );
    }
    const lifetimeMs = Math.min(parsed.data.expires_in ?? ASSERTION_LIFETIME_S, 24 * 3600) * 1000;
    return { token: parsed.data.access_token, expiresAt: issuedAt + lifetimeMs };
  }
}

function cacheKey(key: GceServiceAccountKey): string {
  return crypto
    .createHash("sha256")
    .update(`${key.clientEmail}\0${key.privateKeyId}\0${key.privateKey}`)
    .digest("hex");
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GceApiError("cancelled", "Cancelled", null, null));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function readBounded(response: Response): Promise<string> {
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new GceApiError(
      "bad-response",
      "Google's sign-in answer was too large",
      response.status,
      null
    );
  }
  return new TextDecoder().decode(body);
}
