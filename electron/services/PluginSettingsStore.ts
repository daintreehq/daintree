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
 * non-secret value) carries no such tag, so a legacy secret written before
 * encryption was available is transparently migrated on its next write (#9167).
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
 * The at-rest form of a secret already on disk. `"plaintext"` only ever
 * describes a legacy value — no secret is written in plaintext any more.
 */
export type StoredSecretTier = "keychain" | "plaintext";

/**
 * JSON-backed key/value store for one plugin + scope, identified by its resolved
 * file path. Loads lazily on first access and caches the decoded object in
 * memory; writes go through {@link resilientAtomicWriteFile} with `chmod 0o600`
 * (POSIX only).
 *
 * Values for keys declared `type: "secret"` are routed through an injected
 * {@link SecretCipher} (Electron `safeStorage`) and persisted as a tagged
 * ciphertext envelope (#9167). When no OS keychain is available the write is
 * refused — a secret is never written in plaintext (#12613). The `secret` flag
 * is supplied per call by the caller (the manager knows the declared type), so
 * a single store holds secret and ordinary keys side by side.
 *
 * Change subscriptions are intentionally NOT owned here — `PluginService` holds
 * them so they survive project-root switches that change the resolved path.
 */
export class PluginSettingsStore {
  /** The decoded file, and the identity of the file it was read from or written as. */
  private snapshot: { map: Map<string, unknown>; signature: string } | null = null;
  /** The one read in flight; every caller that needs a fresh snapshot shares it. */
  private loading: Promise<Map<string, unknown>> | null = null;
  /**
   * True while a write persists a map it already mutated. The file on disk
   * differs from the map for exactly that window, and re-reading it then
   * would swap in the pre-write contents under the write.
   */
  private persisting = false;
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
   * keychain is available, else `unavailable`). Disclosed in the settings UI.
   */
  secretTier(): SecretStorageTier {
    return this.cipher.tier();
  }

  /**
   * The at-rest tier the value currently stored at `key` is in. `keychain` when
   * it's an encrypted envelope, `plaintext` when it's a legacy unencrypted value
   * not yet migrated, `undefined` when unset. Lets the UI flag a value still
   * sitting in plaintext.
   */
  async storedSecretTier(key: string): Promise<StoredSecretTier | undefined> {
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
    // the in-memory cache and diverge it from disk. A legacy secret stored as
    // plaintext falls through here unchanged.
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
   * Persist a secret value as a {@link SecretEnvelope} (base64 ciphertext).
   * Without an OS keychain the write is refused before anything changes, in
   * memory or on disk: a plaintext secret written here would be
   * indistinguishable from an ordinary setting, and nothing would ever tell the
   * user it was exposed (#12613). Migration is implicit: a legacy plaintext
   * value is rewritten as an envelope on its next write, never silently dropped.
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
    if (ciphertext === null) {
      throw new Error(
        `Secure storage is unavailable on this device, so the secret "${key}" wasn't saved`
      );
    }
    const next: SecretEnvelope = { __daintreeSecret: SECRET_ENVELOPE_TAG, cipher: ciphertext };

    if (had) {
      const prevPlain = this.decodeSecretPlaintext(prev);
      // Skip only when the plaintext is unchanged AND it is already an
      // envelope — a legacy plaintext secret must still write so the on-disk
      // representation is corrected.
      if (isSecretEnvelope(prev) && prevPlain === plaintext) return false;
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

  /**
   * The snapshot stands only while the file is the one it came from. A project
   * settings file is git-tracked, so a pull or a branch switch rewrites it under
   * us; served from a stale snapshot, the next write would put the old values
   * back. The check is the file's identity, not its bytes: a same-length
   * rewrite that also keeps the nanosecond mtime would go unnoticed, which a
   * checkout or an editor save does not do.
   */
  private async load(): Promise<Map<string, unknown>> {
    const current = this.snapshot;
    if (current && !this.loading) {
      if (this.persisting) return current.map;
      const signature = await this.fileSignature();
      // Whatever moved on while we waited is at least as new: a read another
      // caller started, a write in progress, or a snapshot either installed.
      if (this.loading) return this.loading;
      if (this.snapshot !== current || this.persisting) return this.snapshot?.map ?? this.load();
      if (signature === current.signature) return current.map;
    }
    if (!this.loading) {
      const read = this.readFile().then(
        (next) => {
          if (this.loading === read) {
            this.snapshot = next;
            this.loading = null;
          }
          return next.map;
        },
        (err: unknown) => {
          // Don't poison the instance on a transient or corrupt read: the next
          // access (e.g. after the file is repaired) reads again.
          if (this.loading === read) this.loading = null;
          throw err;
        }
      );
      this.loading = read;
    }
    return this.loading;
  }

  /** Inode, size and mtime — enough to see a rename-over or an in-place rewrite. */
  private async fileSignature(): Promise<string> {
    try {
      const st = await fs.stat(this.filePath, { bigint: true });
      return `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw err;
    }
  }

  private async readFile(): Promise<{ map: Map<string, unknown>; signature: string }> {
    // Taken before the read: a change landing in between leaves the signature
    // behind the contents, which costs one extra re-read, never a stale snapshot.
    const signature = await this.fileSignature();
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { map: new Map(), signature };
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
    return { map: new Map(Object.entries(parsed as Record<string, unknown>)), signature };
  }

  private async persist(cache: Map<string, unknown>): Promise<void> {
    // Null-prototype target so a literal `__proto__` key (a valid storage key,
    // since storage keys are undeclared) becomes an own enumerable property
    // instead of silently mutating Object.prototype — which would drop the value
    // from JSON.stringify and lose it on the next reload.
    const obj: Record<string, unknown> = Object.create(null);
    for (const [k, v] of cache) obj[k] = v;
    const text = JSON.stringify(obj, null, 2);
    this.persisting = true;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await resilientAtomicWriteFile(this.filePath, text, "utf-8", {
        mode: SETTINGS_FILE_MODE,
      });
      // What was just written is now the snapshot — if the file is still what
      // was written. Something replacing it between the rename and the stat
      // would otherwise lend its identity to our values; read back after the
      // stat, and on any doubt drop the snapshot so the next access reads the
      // file. A read still in flight began before this write, so it may not
      // install its result either way.
      const signature = await this.fileSignature();
      const onDisk = await fs.readFile(this.filePath, "utf-8").catch(() => null);
      this.loading = null;
      this.snapshot = onDisk === text ? { map: cache, signature } : null;
    } finally {
      this.persisting = false;
    }
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
