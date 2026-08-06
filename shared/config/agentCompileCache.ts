/**
 * Location and retention policy for the per-agent V8 compile caches written by
 * Node-based agent CLIs (`NODE_COMPILE_CACHE`).
 *
 * Shared because the write path and the reclaim path live in different
 * processes: `buildTerminalEnv` runs in the pty-host UtilityProcess, while the
 * cleanup sweep runs in Main. Both must agree on the directory name or the
 * sweep would silently prune nothing.
 *
 * Deliberately import-free so the pty-host can read it without dragging in
 * `electron` (which does not exist there).
 */

/** Directory under userData holding one subdirectory per agent id. */
export const AGENT_COMPILE_CACHE_DIRNAME = "agent-compile-cache";

/**
 * A Node-version subdirectory is evicted once its own mtime is older than this.
 * Node writes every blob for a given runtime directly into that directory, so
 * the directory's mtime tracks the last time the runtime compiled anything —
 * a usable freshness signal that costs one `stat` instead of walking the
 * hundreds of thousands of blobs inside. Matches `SCRATCH_CLEANUP_TTL_DAYS` so
 * the two disk-reclamation policies age work out on the same schedule.
 */
export const AGENT_COMPILE_CACHE_TTL_DAYS = 30;

/** TTL in milliseconds, for direct comparison against `stat().mtimeMs`. */
export const AGENT_COMPILE_CACHE_TTL_MS = AGENT_COMPILE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Ceiling on the retained cache across every agent, not per agent. A per-agent
 * reservation would let the total scale with the agent roster, which is exactly
 * how the unbounded growth in #11699 went unnoticed.
 *
 * The reported pathological cache averaged ~550 MB per Node-version directory,
 * so 1 GiB retains roughly the two most recent useful generations.
 */
export const AGENT_COMPILE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Companion ceiling on retained file count, also root-wide. Bytes alone do not
 * capture the cost of the reported 890K-file cache: inode pressure, slow
 * backup/indexing passes, and expensive directory walks are driven by count,
 * not size. It doubles as the bound on sweep work — the cap pass stops
 * measuring once this many entries have been admitted.
 */
export const AGENT_COMPILE_CACHE_MAX_ENTRIES = 100_000;
