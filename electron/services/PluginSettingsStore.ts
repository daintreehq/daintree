import path from "path";
import fs from "fs/promises";
import { resilientAtomicWriteFile } from "../utils/fs.js";

/** chmod applied to settings files on POSIX. Skipped on Windows by the writer. */
const SETTINGS_FILE_MODE = 0o600;

/**
 * Plaintext, JSON-backed key/value store for one plugin + scope, identified by
 * its resolved file path. Loads lazily on first access and caches the decoded
 * object in memory; writes go through {@link resilientAtomicWriteFile} with
 * `chmod 0o600` (POSIX only). There is deliberately no OS keychain (#9167).
 *
 * Change subscriptions are intentionally NOT owned here — `PluginService` holds
 * them so they survive project-root switches that change the resolved path.
 */
export class PluginSettingsStore {
  private cache: Map<string, unknown> | null = null;
  private loadPromise: Promise<Map<string, unknown>> | null = null;
  /** Serializes writes so concurrent `set` calls can't interleave read-modify-write. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const cache = await this.load();
    // Return a detached copy so a caller mutating the result can't reach into
    // the in-memory cache and diverge it from disk.
    return cloneValue(cache.get(key)) as T | undefined;
  }

  /**
   * Persist `value` at `key`. Resolves to `true` when the stored value actually
   * changed (so the caller can fire change subscribers), `false` for a no-op
   * write. On write failure the optimistic in-memory mutation is rolled back and
   * the error rethrown.
   */
  async set<T = unknown>(key: string, value: T): Promise<boolean> {
    const result = this.writeChain.then(() => this.doSet(key, value));
    // Keep the chain alive even when this write rejects, so queued writes run.
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async doSet<T>(key: string, value: T): Promise<boolean> {
    const cache = await this.load();
    const had = cache.has(key);
    const prev = cache.get(key);
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
    const obj: Record<string, unknown> = {};
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
