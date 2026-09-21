import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, session } from "electron";
import { classifyPartition } from "../utils/webviewCsp.js";

/** Chromium's HTTP disk cache and V8 code cache, relative to a session's storage dir. */
const CACHE_DIR_NAMES = ["Cache", "Code Cache"] as const;
const DETACHED_MARKER = ".daintree-clearing-";
const DETACHED_DIR_PATTERN = /^(Cache|Code Cache)\.daintree-clearing-[0-9a-f]+$/;

export interface ClearSessionCachesResult {
  /**
   * Live sessions whose clear calls completed without rejecting, plus unopened
   * partitions whose cache dirs were removed. Electron resolves the Session
   * clears without a backend status, so completion is the strongest signal.
   */
  cleared: number;
  /**
   * Sessions, partitions, or discovery steps where any part of the clear
   * failed. Not disjoint from `cleared`: a live partition can count in both
   * when its API clear succeeds but a leftover sweep fails.
   */
  failed: number;
}

// Persistent sessions are never destroyed by Electron, so a strong reference
// adds no retention. In-memory sessions (paint surfaces) are skipped: their
// caches die with the session and they churn a nonce per surface.
const liveSessions = new Set<Electron.Session>();
let stopTracking: (() => void) | null = null;
let inFlight: Promise<ClearSessionCachesResult> | null = null;

export function trackSession(ses: Electron.Session): void {
  if (ses.storagePath) {
    liveSessions.add(ses);
  }
}

/**
 * Record every persistent session as Electron creates it. Electron has no
 * session enumeration API, and `session.fromPartition()` permanently creates a
 * BrowserContext, so this registry is the only safe way to know which
 * partitions have an open disk-cache backend. Must run before `app.whenReady`
 * so the eagerly created `persist:daintree` / `persist:portal` sessions are seen.
 */
export function startSessionCacheTracking(): () => void {
  if (stopTracking) return stopTracking;
  const listener = (ses: Electron.Session): void => trackSession(ses);
  app.on("session-created", listener);
  stopTracking = () => {
    app.removeListener("session-created", listener);
    stopTracking = null;
  };
  return stopTracking;
}

/**
 * Clear HTTP and code caches for every Daintree-owned session. Live sessions go
 * through the Session API; persisted partitions that are not open this run have
 * their `Cache` / `Code Cache` directories removed from disk instead, so no
 * historical session is instantiated. Cookies, storage, and auth are untouched.
 */
export function clearAllSessionCaches(): Promise<ClearSessionCachesResult> {
  inFlight ??= runClear().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runClear(): Promise<ClearSessionCachesResult> {
  const result: ClearSessionCachesResult = { cleared: 0, failed: 0 };
  const handled = new Set<Electron.Session>([session.defaultSession, ...liveSessions]);

  const outcomes = await Promise.all([...handled].map(clearLiveSession));
  for (const ok of outcomes) {
    if (ok) result.cleared++;
    else result.failed++;
  }

  await clearPartitionDirs(handled, result);
  return result;
}

async function clearLiveSession(ses: Electron.Session): Promise<boolean> {
  const [http, code] = await Promise.allSettled([
    Promise.resolve().then(() => ses.clearCache()),
    Promise.resolve().then(() => ses.clearCodeCaches({})),
  ]);
  const failures = [http, code].filter((r) => r.status === "rejected");
  for (const failure of failures) {
    console.warn(
      `[SessionCacheCleaner] Failed to clear cache for ${ses.storagePath ?? "(default)"}:`,
      failure.reason
    );
  }
  return failures.length === 0;
}

async function clearPartitionDirs(
  handled: Set<Electron.Session>,
  result: ClearSessionCachesResult
): Promise<void> {
  const partitionsRoot = path.join(app.getPath("sessionData"), "Partitions");

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(partitionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    console.warn("[SessionCacheCleaner] Failed to list partitions:", error);
    result.failed++;
    return;
  }

  for (const entry of entries) {
    const isSymlink = entry.isSymbolicLink();
    if (!entry.isDirectory() && !isSymlink) continue;
    if (classifyPartition(`persist:${entry.name}`) === "unknown") continue;

    const partitionDir = path.join(partitionsRoot, entry.name);
    const outcome = await clearPartitionDir(partitionDir, handled, isSymlink);
    if (outcome === "cleared") result.cleared++;
    else if (outcome === "failed") result.failed++;
  }
}

async function clearPartitionDir(
  partitionDir: string,
  handled: Set<Electron.Session>,
  isSymlink: boolean
): Promise<"cleared" | "failed" | "already-counted"> {
  let ok = true;
  let alreadyCounted = false;
  const doomed: string[] = [];

  // The liveness check and the renames run synchronously on the main thread,
  // where every session is created, so a session cannot open between them.
  // Once detached, the old dirs can be removed at leisure; a session opening
  // afterwards simply creates fresh cache dirs.
  const live = findLiveSession(partitionDir);
  if (live && handled.has(live)) {
    alreadyCounted = true;
  } else if (live) {
    // Opened after the API pass took its snapshot.
    handled.add(live);
    ok = await clearLiveSession(live);
  } else if (isSymlink) {
    // Never traverse an unopened symlinked partition: a recognized name doesn't
    // make the target Daintree's (it could be $HOME, or alias a live partition
    // whose backend is open). Report it rather than claim it was cleared.
    console.warn(`[SessionCacheCleaner] Skipped symlinked partition ${partitionDir}`);
    return "failed";
  } else {
    const nonce = randomBytes(6).toString("hex");
    for (const name of CACHE_DIR_NAMES) {
      const source = path.join(partitionDir, name);
      const detached = path.join(partitionDir, `${name}${DETACHED_MARKER}${nonce}`);
      try {
        fs.renameSync(source, detached);
        doomed.push(detached);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        console.warn(`[SessionCacheCleaner] Failed to detach ${source}:`, error);
        ok = false;
      }
    }
  }

  // Retry dirs a previous clear detached but could not remove.
  try {
    const names = isSymlink ? [] : await fs.promises.readdir(partitionDir);
    for (const name of names) {
      const candidate = path.join(partitionDir, name);
      if (DETACHED_DIR_PATTERN.test(name) && !doomed.includes(candidate)) {
        doomed.push(candidate);
      }
    }
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      console.warn(`[SessionCacheCleaner] Failed to scan ${partitionDir}:`, error);
      ok = false;
    }
  }

  const removals = await Promise.allSettled(
    doomed.map((dir) =>
      fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    )
  );
  for (const removal of removals) {
    if (removal.status === "rejected") {
      console.warn("[SessionCacheCleaner] Failed to remove detached cache:", removal.reason);
      ok = false;
    }
  }

  if (!ok) return "failed";
  return alreadyCounted ? "already-counted" : "cleared";
}

function findLiveSession(dir: string): Electron.Session | undefined {
  const target = normalizeForCompare(dir);
  for (const ses of liveSessions) {
    if (ses.storagePath && normalizeForCompare(ses.storagePath) === target) {
      return ses;
    }
  }
  return undefined;
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  // macOS and Windows default to case-insensitive volumes. Over-matching only
  // routes a partition to the API path, which is the safe direction.
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** @internal Reset module state for testing only. */
export function _resetSessionCacheCleanerForTesting(): void {
  stopTracking?.();
  liveSessions.clear();
  inFlight = null;
}
