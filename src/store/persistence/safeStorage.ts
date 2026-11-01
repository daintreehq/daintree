import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import { isRendererPerfCaptureEnabled, markRendererPerformance } from "@/utils/performance";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PersistWriteMerge } from "./persistWriteMerge";

export interface SafeJSONStorageOptions<T> {
  /**
   * Opt-in baseline-aware three-way write merge (issue #11351). When provided,
   * every write first reads the current shared value and reconciles it against
   * this writer's baseline and incoming snapshot, so a stale project view can't
   * clobber a sibling view's concurrent writes. Omit it for view-local stores —
   * the default full-replacement write is unchanged. See `persistWriteMerge.ts`.
   */
  mergeOnWrite?: PersistWriteMerge<T>;
}

const fallbackStorageData = new Map<string, string>();

const BACKUP_KEY_SUFFIX = ".__bak";

/** Where a persisted store's last known-good copy is kept. */
export const backupKeyFor = (name: string): string => `${name}${BACKUP_KEY_SUFFIX}`;

/**
 * Synchronous notifier for permanent storage fallback. Registered once at app
 * boot from `notify.ts`; tests register a spy directly. See
 * `notifyPermanentFallbackOnce` for the rationale (avoids dynamic-import
 * cross-test pollution).
 */
let permanentFallbackHandler: (() => void) | null = null;

// Stores hydrate during module evaluation, usually before notify.ts registers
// its handler, so a fallback hit then is latched and delivered on registration.
let pendingPermanentFallbackNotice = false;

function dispatchPermanentFallbackNotice(): void {
  const handler = permanentFallbackHandler;
  if (!handler) {
    pendingPermanentFallbackNotice = true;
    return;
  }
  pendingPermanentFallbackNotice = false;
  handler();
}

export function setPermanentFallbackHandler(handler: (() => void) | null): void {
  permanentFallbackHandler = handler;
  if (handler && pendingPermanentFallbackNotice) dispatchPermanentFallbackNotice();
}

/**
 * A `QuotaExceededError` (or its Firefox alias) is transient: the write was
 * too large, but storage is still healthy, so smaller subsequent writes can
 * succeed. We must NOT permanently route a store to in-memory storage on quota
 * — that would silently drop every later write for the session (issue #9170).
 */
function isQuotaExceededError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function shouldCollectPersistencePerf(): boolean {
  if (typeof window === "undefined") return false;
  return isRendererPerfCaptureEnabled() || Array.isArray(window.__DAINTREE_PERF_MARKS__);
}

const PERF_TEXT_ENCODER = new TextEncoder();

function estimateStringBytes(value: string | null): number | null {
  if (value === null) return null;
  try {
    return PERF_TEXT_ENCODER.encode(value).length;
  } catch {
    return null;
  }
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const memoryStorage: StateStorage = {
  getItem: (name) => fallbackStorageData.get(name) ?? null,
  setItem: (name, value) => {
    fallbackStorageData.set(name, value);
  },
  removeItem: (name) => {
    fallbackStorageData.delete(name);
  },
};

function resolveLocalStorage(): StateStorage | undefined {
  let storage: unknown;

  try {
    storage = globalThis.localStorage;
  } catch {
    return undefined;
  }

  if (!storage) {
    return undefined;
  }

  const candidate = storage as Partial<StateStorage>;
  const hasStorageApi =
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function";

  return hasStorageApi ? (candidate as StateStorage) : undefined;
}

/**
 * Outcome of a resilient write, so the caller can keep the backup copy
 * consistent with what actually reached durable storage:
 * - `durable`  — written to real localStorage; the backup may advance.
 * - `quota`    — transient quota error; primary unchanged, backup must NOT advance.
 * - `memory`   — written only to the in-memory fallback; nothing durable to back up.
 */
export type ResilientWriteResult = "durable" | "quota" | "memory";

/**
 * Resilient storage augmented with best-effort backup operations. The backup
 * methods write/read a sibling `${key}.__bak` entry directly on the real
 * localStorage — bypassing the perf-marked primary path and skipping entirely
 * once a permanent in-memory fallback is active (a backup in memory buys
 * nothing and would needlessly re-hit broken localStorage).
 */
interface ResilientStorage {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => ResilientWriteResult;
  removeItem: (name: string) => void;
  writeBackup: (name: string, value: string) => void;
  readBackup: (name: string) => string | null;
  removeBackup: (name: string) => void;
  usesMemory: () => boolean;
}

function createResilientStorage(baseStorage: StateStorage | undefined): ResilientStorage {
  let activeStorage = baseStorage ?? memoryStorage;
  let hasNotifiedPermanentFallback = false;

  const switchToMemoryStorage = (): StateStorage => {
    activeStorage = memoryStorage;
    return activeStorage;
  };

  // Fire exactly once per storage instance when a structural failure forces a
  // permanent in-memory fallback. Until then writes never reach localStorage,
  // so changes this session are lost on restart — a degradation the user can't
  // otherwise observe. Quota errors are transient and never reach here.
  //
  // Dispatch is synchronous via a registered handler (see
  // `setPermanentFallbackHandler` below). This avoids a dynamic
  // `import("@/lib/notify").then(...)` whose late-resolving promise leaked
  // across test boundaries and produced the well-documented
  // persistenceBoundaryHardening notify-count flake. The handler is registered
  // once at app boot from `notify.ts`; tests register a spy directly via
  // `setPermanentFallbackHandler`, eliminating cross-test pollution entirely.
  const notifyPermanentFallbackOnce = (): void => {
    if (hasNotifiedPermanentFallback) return;
    hasNotifiedPermanentFallback = true;
    dispatchPermanentFallbackNotice();
  };

  return {
    getItem: (name) => {
      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf ? perfNow() : 0;
      const storage: "localStorage" | "memory" =
        activeStorage === memoryStorage ? "memory" : "localStorage";
      try {
        const value = activeStorage.getItem(name);
        if (collectPerf && !(value instanceof Promise)) {
          markRendererPerformance("persistence_localstorage_get", {
            key: name,
            payloadBytes: estimateStringBytes(value),
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: true,
            storage,
          });
        }
        return value;
      } catch {
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_get", {
            key: name,
            payloadBytes: null,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: false,
            storage,
          });
        }
        const fallbackValue = switchToMemoryStorage().getItem(name);
        notifyPermanentFallbackOnce();
        return fallbackValue;
      }
    },
    setItem: (name, value) => {
      const collectPerf = shouldCollectPersistencePerf();
      const startedAt = collectPerf ? perfNow() : 0;
      const payloadBytes = collectPerf ? estimateStringBytes(value) : null;
      const storage: "localStorage" | "memory" =
        activeStorage === memoryStorage ? "memory" : "localStorage";
      const wroteToMemory = activeStorage === memoryStorage;
      try {
        activeStorage.setItem(name, value);
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_set", {
            key: name,
            payloadBytes,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: true,
            storage,
          });
        }
        return wroteToMemory ? "memory" : "durable";
      } catch (error) {
        if (collectPerf) {
          markRendererPerformance("persistence_localstorage_set", {
            key: name,
            payloadBytes,
            durationMs: Number((perfNow() - startedAt).toFixed(3)),
            ok: false,
            storage,
          });
        }
        if (isQuotaExceededError(error)) {
          // Transient: storage is healthy but this write was too large. Keep
          // localStorage active so later (smaller) writes retry it. The value
          // still lives in the in-memory React store this session; it simply
          // isn't persisted, so we don't switch storages or notify.
          console.warn("[safeStorage] storage quota exceeded, skipping persistent write", {
            key: name,
            error: formatErrorMessage(error, "Storage quota exceeded"),
          });
          return "quota";
        }
        switchToMemoryStorage().setItem(name, value);
        notifyPermanentFallbackOnce();
        return "memory";
      }
    },
    removeItem: (name) => {
      try {
        activeStorage.removeItem(name);
      } catch (error) {
        if (isQuotaExceededError(error)) {
          memoryStorage.removeItem(name);
          return;
        }
        switchToMemoryStorage().removeItem(name);
        notifyPermanentFallbackOnce();
      }
    },
    writeBackup: (name, value) => {
      // Skip while in memory fallback: localStorage is known broken, so a write
      // here would just re-hit it (and a memory backup duplicates live state).
      if (activeStorage === memoryStorage || !baseStorage) return;
      try {
        baseStorage.setItem(backupKeyFor(name), value);
      } catch {
        // Backup is opportunistic — losing it is acceptable.
      }
    },
    readBackup: (name) => {
      // localStorage is known broken once we've fallen back — don't re-hit it.
      if (activeStorage === memoryStorage || !baseStorage) return null;
      try {
        const value = baseStorage.getItem(backupKeyFor(name));
        return value instanceof Promise ? null : value;
      } catch {
        return null;
      }
    },
    removeBackup: (name) => {
      if (!baseStorage) return;
      try {
        baseStorage.removeItem(backupKeyFor(name));
      } catch {
        // Best-effort cleanup.
      }
    },
    usesMemory: () => activeStorage === memoryStorage,
  };
}

/**
 * Single sanctioned `JSON.parse` boundary for this module. `JSON.parse` returns
 * `any`, so the cast to the caller's expected shape is inherently unchecked —
 * centralising it here keeps that one unsafe assertion auditable in one place
 * (callers always wrap this in try/catch and validate the result downstream).
 */
function parseJson<R>(raw: string): R {
  return JSON.parse(raw) as R;
}

/**
 * Parse a JSON string safely, returning a typed fallback and logging a warning
 * with caller-supplied context (store/key) when the parse fails. Null input is
 * treated as an absent value and returns the fallback without warning —
 * corruption is distinct from a cache miss.
 */
export function safeJSONParse<T>(
  raw: string | null,
  context: { store: string; key: string },
  fallback: T
): T {
  if (raw === null) return fallback;
  try {
    return parseJson<T>(raw);
  } catch (error) {
    console.warn("[safeStorage] JSON parse failed", {
      ...context,
      error: formatErrorMessage(error, "JSON parse failed"),
    });
    return fallback;
  }
}

/**
 * Parse a recovered backup blob, returning null when it is absent or itself
 * corrupt so the caller falls through to a clean reset.
 */
function parseBackup<T>(raw: string | null): StorageValue<T> | null {
  if (raw === null) return null;
  try {
    return parseJson<StorageValue<T>>(raw);
  } catch {
    return null;
  }
}

/**
 * Read and parse the persisted value for `name`, recovering from the sibling
 * `.__bak` copy when the live blob is present but corrupt (issue #9170/#9916),
 * and returning `null` when absent or unrecoverable. Shared by hydration reads
 * and the pre-write disk read that feeds the opt-in write merger, so both paths
 * get identical corruption/backup handling.
 */
function readPersistedValue<T>(
  raw: ResilientStorage,
  name: string,
  value: string | null | Promise<string | null> = raw.getItem(name)
): StorageValue<T> | null {
  if (value instanceof Promise) return null;
  if (value === null) return null;
  try {
    return parseJson<StorageValue<T>>(value);
  } catch (error) {
    // The live blob is corrupt but present — try the last known-good backup
    // before discarding the user's config to defaults (issue #9170).
    const recovered = parseBackup<T>(raw.readBackup(name));
    if (recovered !== null) {
      console.warn("[safeStorage] corrupt persisted state, recovered from backup", {
        key: name,
        error: formatErrorMessage(error, "Corrupt persisted state"),
      });
      return recovered;
    }
    console.warn("[safeStorage] corrupt persisted state, resetting to defaults", {
      key: name,
      error: formatErrorMessage(error, "Corrupt persisted state"),
    });
    return null;
  }
}

/**
 * The write half shared by both adapters, so the debounced flush and the plain
 * `setItem` dedup, merge and back up identically (issue #13601). `write` lands
 * one snapshot; `read` records a hydration read as the merge baseline; `forget`
 * drops everything remembered for a key.
 */
function createPersistWriter<T>(
  raw: ResilientStorage,
  mergeOnWrite: PersistWriteMerge<T> | undefined
) {
  // The bytes this writer last landed per key, and whether they landed in the
  // in-memory fallback. A switch to memory after a durable write invalidates
  // the entry, so the repeat still populates the fallback.
  const lastWritten = new Map<string, { serialized: string; memory: boolean }>();
  // What this writer last knew, per key — its hydration read or last durable
  // write. Feeds the three-way merge so a stale snapshot can't clobber a
  // sibling view (issue #11351). Only tracked when a merger is configured.
  const baselines = new Map<string, StorageValue<T> | null>();
  // The last merge write this writer landed, per key: its serialized incoming
  // snapshot, the exact bytes it wrote, whether those bytes were backed up, and
  // whether that write was a verified fixed point (see write). Only tracked
  // with a merger.
  const lastMergeWrite = new Map<
    string,
    { incoming: string; written: string; backedUp: boolean; settled: boolean }
  >();

  const write = (name: string, value: StorageValue<T>, serializedValue?: string): void => {
    if (mergeOnWrite) {
      // Zustand calls setItem after every set(), including no-op and
      // transient-field sets, so most calls repeat the last snapshot. We must
      // NOT dedup on the incoming value or the merged output alone: identical
      // `value`s can merge differently as the shared disk changes, and
      // different disk states can merge to the same bytes (e.g. re-applying a
      // deletion the disk resurrected). Nor is one write enough to reach a
      // fixed point — a merger may resolve a baseline version mismatch by
      // deferring to disk, then apply the writer's own values on the next,
      // identical write. So a repeat is skipped only once a full merge has
      // already shown that merging this exact snapshot (as both baseline and
      // incoming) against these exact disk bytes reproduces them, and the
      // primary and backup still hold those bytes. Mergers are pure, so the
      // skipped write would have rewritten identical bytes.
      const incoming = JSON.stringify(value);
      const onDiskRaw = raw.getItem(name);
      const last = lastMergeWrite.get(name);
      if (
        last?.settled &&
        last.incoming === incoming &&
        last.written === onDiskRaw &&
        (!last.backedUp || raw.readBackup(name) === last.written)
      ) {
        return;
      }
      const merged = mergeOnWrite({
        baseline: baselines.get(name) ?? null,
        onDisk: readPersistedValue<T>(raw, name, onDiskRaw),
        incoming: value,
      });
      const serialized = JSON.stringify(merged);
      const result = raw.setItem(name, serialized);
      // Only advance the backup when the primary write actually reached durable
      // storage. On a quota failure the primary keeps its old value, so writing
      // a newer backup would leave the two inconsistent and recover stale state.
      if (result === "durable") raw.writeBackup(name, serialized);
      // Advance the baseline to the writer's own snapshot (never the merged
      // result, which may hold sibling-only keys this view never took into
      // memory). A transient quota failure keeps the old baseline so the next
      // retry still merges correctly.
      if (result !== "quota") {
        baselines.set(name, value);
        lastMergeWrite.set(name, {
          incoming,
          written: serialized,
          backedUp: result === "durable",
          // The baseline was already this snapshot and the merge left the
          // disk bytes unchanged: repeating it is a no-op.
          settled: last?.incoming === incoming && serialized === onDiskRaw,
        });
      } else {
        lastMergeWrite.delete(name);
      }
      return;
    }
    const serialized = serializedValue ?? JSON.stringify(value);
    const last = lastWritten.get(name);
    if (last?.serialized === serialized && last.memory === raw.usesMemory()) return;
    const result = raw.setItem(name, serialized);
    if (result === "durable") {
      lastWritten.set(name, { serialized, memory: false });
      raw.writeBackup(name, serialized);
    } else if (result === "memory") {
      lastWritten.set(name, { serialized, memory: true });
    }
  };

  return {
    write,
    read: (name: string, parsed: StorageValue<T> | null): void => {
      if (!mergeOnWrite) return;
      baselines.set(name, parsed);
      lastMergeWrite.delete(name);
    },
    forget: (name: string): void => {
      lastWritten.delete(name);
      baselines.delete(name);
      lastMergeWrite.delete(name);
    },
  };
}

export function createSafeJSONStorage<T>(options?: SafeJSONStorageOptions<T>): PersistStorage<T> {
  const raw = createResilientStorage(resolveLocalStorage());
  const writer = createPersistWriter(raw, options?.mergeOnWrite);

  return {
    getItem: (name) => {
      const parsed = readPersistedValue<T>(raw, name);
      writer.read(name, parsed);
      return parsed;
    },
    setItem: (name, value) => writer.write(name, value),
    removeItem: (name) => {
      writer.forget(name);
      raw.removeItem(name);
      raw.removeBackup(name);
    },
  };
}

/**
 * Like `createSafeJSONStorage`, but coalesces rapid `setItem` calls per key
 * through a trailing-edge debounce. Reads stay synchronous so hydration is
 * unaffected; `removeItem` cancels any pending write for the same key so a
 * `clearAll` followed shortly by a tear-down can't be silently re-populated by
 * a stale write timer. Flushes share the plain adapter's write path, so a
 * snapshot that already landed is not rewritten by a later identical flush.
 */
export function createDebouncedSafeJSONStorage<T>(
  delayMs: number,
  options?: SafeJSONStorageOptions<T>
): PersistStorage<T> & {
  /** Writes the key's pending value now, through the same merge a timer's write takes. */
  flush(name: string): void;
} {
  const raw = createResilientStorage(resolveLocalStorage());
  const writer = createPersistWriter(raw, options?.mergeOnWrite);
  // Retain the typed incoming value (not just its serialized form) so a
  // merge-enabled flush can reconcile it against the freshest disk state read
  // at flush time (issue #11351). `serialized` coalesces identical enqueues.
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; value: StorageValue<T>; serialized: string }
  >();

  const flush = (name: string): void => {
    const entry = pending.get(name);
    if (!entry) return;
    // A read-triggered flush must disarm its timer, or the stale callback would
    // later flush a newer enqueue before its own debounce window elapsed.
    clearTimeout(entry.timer);
    pending.delete(name);
    writer.write(name, entry.value, entry.serialized);
  };

  return {
    flush,
    getItem: (name) => {
      // Flush any pending write so reads-after-writes are coherent.
      flush(name);
      const parsed = readPersistedValue<T>(raw, name);
      writer.read(name, parsed);
      return parsed;
    },
    setItem: (name, value) => {
      const serialized = JSON.stringify(value);
      const existing = pending.get(name);
      if (existing?.serialized === serialized) return;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => flush(name), delayMs);
      pending.set(name, { timer, value, serialized });
    },
    removeItem: (name) => {
      const existing = pending.get(name);
      if (existing) {
        clearTimeout(existing.timer);
        pending.delete(name);
      }
      writer.forget(name);
      raw.removeItem(name);
      raw.removeBackup(name);
    },
  };
}

export function readLocalStorageItemSafely(name: string): string | null {
  const storage = resolveLocalStorage();
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(name);
    return value instanceof Promise ? null : value;
  } catch {
    return null;
  }
}

export interface SafeStringStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => ResilientWriteResult;
  removeItem: (name: string) => void;
}

/**
 * Plain-string storage for renderer state kept under its own keys rather than
 * through zustand `persist`. It applies the same policy as the persisted
 * stores, so none of its calls throw: a quota error skips that write and leaves
 * storage active, and any other failure moves this adapter to memory for good
 * and raises the shared "Settings won't be saved" notice.
 */
export function createSafeStringStorage(): SafeStringStorage {
  const raw = createResilientStorage(resolveLocalStorage());
  return {
    getItem: (name) => {
      const value = raw.getItem(name);
      return value instanceof Promise ? null : value;
    },
    setItem: raw.setItem,
    removeItem: raw.removeItem,
  };
}
