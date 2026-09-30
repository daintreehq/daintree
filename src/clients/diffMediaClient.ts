import type {
  DiffMediaFileVersions,
  DiffMediaKnownVersions,
  DiffMediaReadFileVersionsPayload,
  DiffMediaSide,
  DiffMediaWireSide,
} from "@shared/types";

type VersionedSide = Extract<DiffMediaSide, { ok: true }> & { version: string };

interface CacheEntry {
  head?: VersionedSide;
  working?: VersionedSide;
  bytes: number;
}

// Data URLs are ASCII, so V8 stores them one byte per char. Sized for a
// handful of revisited images; a single side is at most ~11 MB of base64.
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

// Insertion-ordered: re-inserting on hit keeps the oldest entry first.
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function cacheKey(cwd: string, filePath: string): string {
  return JSON.stringify([cwd, filePath]);
}

function sideBytes(side: VersionedSide | undefined): number {
  return side ? side.dataUrl.length : 0;
}

function deleteEntry(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cachedBytes -= entry.bytes;
}

function storeEntry(
  key: string,
  head: VersionedSide | undefined,
  working: VersionedSide | undefined
) {
  deleteEntry(key);
  const bytes = sideBytes(head) + sideBytes(working);
  if (bytes === 0 || bytes > CACHE_MAX_BYTES) return;
  cache.set(key, { head, working, bytes });
  cachedBytes += bytes;
  for (const oldest of cache.keys()) {
    if (cachedBytes <= CACHE_MAX_BYTES) break;
    deleteEntry(oldest);
  }
}

function asVersioned(side: DiffMediaSide): VersionedSide | undefined {
  return side.ok && side.version !== undefined ? (side as VersionedSide) : undefined;
}

/**
 * Resolve a wire side against what we sent as known. An `unchanged` reply for
 * a side we don't hold (or hold at another version) can't be honoured — it
 * would mean main and renderer disagree — so it throws rather than render
 * the wrong image.
 */
function resolveSide(side: DiffMediaWireSide, held: VersionedSide | undefined): DiffMediaSide {
  if (!("unchanged" in side)) return side;
  if (!held || held.version !== side.version) {
    throw new Error("diffMedia: unchanged reply for a version not held");
  }
  return held;
}

export const diffMediaClient = {
  readFileVersions: async (
    payload: DiffMediaReadFileVersionsPayload
  ): Promise<DiffMediaFileVersions> => {
    const key = cacheKey(payload.cwd, payload.filePath);
    // Captured now, so an eviction while the request is in flight can't strip
    // the bytes an `unchanged` reply points at.
    const held = cache.get(key);
    const known: DiffMediaKnownVersions | undefined =
      held && (held.head || held.working)
        ? { head: held.head?.version, working: held.working?.version }
        : undefined;

    const response = await window.electron.diffMedia.readFileVersions(
      known ? { ...payload, known } : payload
    );
    const result: DiffMediaFileVersions = {
      head: resolveSide(response.head, held?.head),
      working: resolveSide(response.working, held?.working),
    };
    storeEntry(key, asVersioned(result.head), asVersioned(result.working));
    return result;
  },
};

export function resetDiffMediaCacheForTests(): void {
  cache.clear();
  cachedBytes = 0;
}

export function getDiffMediaCacheBytesForTests(): number {
  return cachedBytes;
}
