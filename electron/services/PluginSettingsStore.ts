import path from "path";
import fs from "fs/promises";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import {
  safeStorageCipher,
  type SecretCipher,
  type SecretStorageTier,
} from "./plugin/secretCipher.js";

/** chmod applied to settings files on POSIX. Skipped on Windows by the writer. */
const SETTINGS_FILE_MODE = 0o600;

/**
 * Discriminator marking an at-rest value as an OS-keychain ciphertext envelope
 * rather than a plaintext setting. A plain plaintext-stored secret (or any
 * non-secret value) carries no such tag, so a value written before encryption
 * was available is transparently migrated on its next write (#9167).
 */
const SECRET_ENVELOPE_TAG = "daintree:secret:v1";

interface SecretEnvelope {
  __daintreeSecret: typeof SECRET_ENVELOPE_TAG;
  /** Base64 ciphertext from {@link SecretCipher.encrypt}. */
  cipher: string;
}

function isSecretEnvelope(value: unknown): value is SecretEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __daintreeSecret?: unknown }).__daintreeSecret === SECRET_ENVELOPE_TAG &&
    typeof (value as { cipher?: unknown }).cipher === "string"
  );
}

/** Per-call hint: when a key is declared `type: "secret"`, route it through the cipher. */
interface SecretOptions {
  secret?: boolean;
}

/**
 * JSON-backed key/value store for one plugin + scope, identified by its resolved
 * file path. Loads lazily on first access and caches the decoded object in
 * memory; writes go through {@link resilientAtomicWriteFile} with `chmod 0o600`
 * (POSIX only).
 *
 * Values for keys declared `type: "secret"` are routed through an injected
 * {@link SecretCipher} (Electron `safeStorage`) and persisted as a tagged
 * ciphertext envelope when an OS keychain is available; when it is not, they
 * fall back to the same plaintext-0600 path as ordinary settings (#9167). The
 * `secret` flag is supplied per call by the caller (the manager knows the
 * declared type), so a single store handles both tiers across its keys.
 *
 * Change subscriptions are intentionally NOT owned here — `PluginService` holds
 * them so they survive project-root switches that change the resolved path.
 */
export class PluginSettingsStore {
  private cache: Map<string, unknown> | null = null;
  private loadPromise: Promise<Map<string, unknown>> | null = null;
  /** Serializes writes so concurrent `set` calls can't interleave read-modify-write. */
  private writeChain: Promise<void> = Promise.resolve();
  private readonly cipher: SecretCipher;

  constructor(
    private readonly filePath: string,
    cipher: SecretCipher = safeStorageCipher
  ) {
    this.cipher = cipher;
  }

  /**
   * The at-rest tier a secret write would use right now (`keychain` when an OS
   * keychain is available, else `plaintext`). Disclosed in the settings UI.
   */
  secretTier(): SecretStorageTier {
    return this.cipher.tier();
  }

  /**
   * The at-rest tier the value currently stored at `key` is in. `keychain` when
   * it's an encrypted envelope, `plaintext` when stored unencrypted (keychain
   * unavailable at write time, or not yet migrated), `undefined` when unset.
   * Lets the UI flag a value still sitting in plaintext even though a keychain is
   * now available.
   */
  async storedSecretTier(key: string): Promise<SecretStorageTier | undefined> {
    const cache = await this.load();
    const raw = cache.get(key);
    if (raw === undefined) return undefined;
    return isSecretEnvelope(raw) ? "keychain" : "plaintext";
  }

  async get<T = unknown>(key: string, options?: SecretOptions): Promise<T | undefined> {
    const cache = await this.load();
    const raw = cache.get(key);
    if (raw === undefined) return undefined;
    if (options?.secret && isSecretEnvelope(raw)) {
      // Decrypt on read; the decrypted plaintext is the plugin-visible value.
      return this.cipher.decrypt(raw.cipher) as T;
    }
    // Return a detached copy so a caller mutating the result can't reach into
    // the in-memory cache and diverge it from disk. A secret stored as plaintext
    // (keychain unavailable, or pre-migration) falls through here unchanged.
    return cloneValue(raw) as T | undefined;
  }

  /**
   * Persist `value` at `key`. Resolves to `true` when the stored value actually
   * changed (so the caller can fire change subscribers), `false` for a no-op
   * write. On write failure the optimistic in-memory mutation is rolled back and
   * the error rethrown.
   */
  async set<T = unknown>(key: string, value: T, options?: SecretOptions): Promise<boolean> {
    const result = this.writeChain.then(() => this.doSet(key, value, options));
    // Keep the chain alive even when this write rejects, so queued writes run.
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async doSet<T>(key: string, value: T, options?: SecretOptions): Promise<boolean> {
    const cache = await this.load();
    const had = cache.has(key);
    const prev = cache.get(key);

    if (options?.secret) {
      return this.doSetSecret(cache, key, value, had, prev);
    }

    // Detect a no-op before touching disk: an idempotent set should neither
    // write nor fail (e.g. on a read-only directory).
    if (had && valuesEqual(prev, value)) return false;
    // Store a detached, JSON-faithful copy so (a) a caller mutating the original
    // object can't diverge the cache from disk, and (b) the cache reflects what
    // actually persists (e.g. NaN/Infinity coerce to null under JSON, in memory
    // and on disk alike).
    cache.set(key, cloneValue(value));
    try {
      await this.persist(cache);
    } catch (err) {
      if (had) cache.set(key, prev);
      else cache.delete(key);
      throw err;
    }
    return true;
  }

  /**
   * Persist a secret value at its at-rest tier. With an OS keychain it is stored
   * as a {@link SecretEnvelope} (base64 ciphertext); without one it falls back to
   * plaintext, exactly as a non-secret value would. Migration is implicit: a
   * value previously stored plaintext is rewritten as an envelope on this write
   * once a keychain becomes available, and never silently dropped.
   *
   * No-op detection decrypts the stored value first so an idempotent re-set of an
   * already-encrypted secret skips the write (ciphertext is non-deterministic, so
   * comparing raw envelopes would always look "changed").
   */
  private async doSetSecret<T>(
    cache: Map<string, unknown>,
    key: string,
    value: T,
    had: boolean,
    prev: unknown
  ): Promise<boolean> {
    const stored = cloneValue(value);
    // The plaintext that actually gets encrypted: strings as-is, everything else
    // JSON-encoded (mirrors how the manager stringifies non-string secrets).
    const plaintext = typeof stored === "string" ? stored : JSON.stringify(stored);
    const ciphertext = this.cipher.encrypt(plaintext);
    const next: unknown =
      ciphertext === null ? stored : { __daintreeSecret: SECRET_ENVELOPE_TAG, cipher: ciphertext };

    if (had) {
      const prevPlain = this.decodeSecretPlaintext(prev);
      // Skip only when the plaintext is unchanged AND the at-rest tier isn't
      // changing — a plaintext-stored secret migrating up to an envelope (or
      // back) must still write so the on-disk representation is corrected.
      const tierUnchanged = isSecretEnvelope(prev) === isSecretEnvelope(next);
      if (tierUnchanged && prevPlain === plaintext) return false;
    }

    cache.set(key, next);
    try {
      await this.persist(cache);
    } catch (err) {
      if (had) cache.set(key, prev);
      else cache.delete(key);
      throw err;
    }
    return true;
  }

  /**
   * Reduce a stored secret to the same plaintext form {@link doSetSecret} would
   * encrypt, for no-op comparison: an envelope decrypts; a plaintext-stored
   * string passes through; a plaintext-stored non-string is JSON-encoded.
   */
  private decodeSecretPlaintext(stored: unknown): string | undefined {
    if (isSecretEnvelope(stored)) return this.cipher.decrypt(stored.cipher);
    if (stored === undefined) return undefined;
    if (typeof stored === "string") return stored;
    return JSON.stringify(stored);
  }

  /**
   * Remove `key`. Resolves to `true` when a stored value was actually deleted
   * (so the caller can fire change subscribers with `undefined`), `false` when
   * the key was already absent. On write failure the optimistic in-memory delete
   * is rolled back and the error rethrown. Serialized through the same write
   * chain as {@link set} so a concurrent set/delete can't interleave.
   */
  async delete(key: string): Promise<boolean> {
    const result = this.writeChain.then(() => this.doDelete(key));
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async doDelete(key: string): Promise<boolean> {
    const cache = await this.load();
    if (!cache.has(key)) return false;
    const prev = cache.get(key);
    cache.delete(key);
    try {
      await this.persist(cache);
    } catch (err) {
      cache.set(key, prev);
      throw err;
    }
    return true;
  }

  private async load(): Promise<Map<string, unknown>> {
    if (this.cache) return this.cache;
    if (!this.loadPromise) {
      this.loadPromise = this.readFile();
    }
    try {
      this.cache = await this.loadPromise;
    } catch (err) {
      // Don't permanently poison the instance on a transient/corrupt read —
      // drop the failed promise so a later access (e.g. after the file is
      // repaired) re-reads from disk.
      this.loadPromise = null;
      throw err;
    }
    return this.cache;
  }

  private async readFile(): Promise<Map<string, unknown>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Plugin settings file is not valid JSON: ${this.filePath}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Plugin settings file must contain a JSON object: ${this.filePath}`);
    }
    return new Map(Object.entries(parsed as Record<string, unknown>));
  }

  private async persist(cache: Map<string, unknown>): Promise<void> {
    // Null-prototype target so a literal `__proto__` key (a valid storage key,
    // since storage keys are undeclared) becomes an own enumerable property
    // instead of silently mutating Object.prototype — which would drop the value
    // from JSON.stringify and lose it on the next reload.
    const obj: Record<string, unknown> = Object.create(null);
    for (const [k, v] of cache) obj[k] = v;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await resilientAtomicWriteFile(this.filePath, JSON.stringify(obj, null, 2), "utf-8", {
      mode: SETTINGS_FILE_MODE,
    });
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * JSON-faithful clone. Primitives pass through; objects are round-tripped so the
 * returned value shares no references with the caller's input. Values are always
 * JSON-serializable here (validated by the host before reaching the store).
 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
