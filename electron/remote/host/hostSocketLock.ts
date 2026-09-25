import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

/**
 * Serializes everything that decides who owns a host socket path: probing and
 * unlinking a stale socket, binding the new one, publishing the discovery file,
 * and removing it at shutdown. Within a process the holders queue on a promise
 * chain; across processes (a dev and a packaged build share the Linux runtime
 * directory) they take an exclusive lock file next to the socket.
 *
 * A lock is broken only when its owner is verifiably gone: its pid no longer
 * exists, or (where the platform says cheaply) that pid now belongs to a
 * process started after the one that wrote the lock. Age never revokes a live
 * owner, since a suspended holder that resumes would then share the section
 * with whoever broke in. Age matters only for a lock that names no readable
 * owner at all (a writer that died between creating and filling it). Breaking
 * is done by one waiter at a time (an O_EXCL breaker file), which re-checks it
 * is still the inode judged stale before unlinking it, so a fresh lock is never
 * the one removed.
 */

export interface HostSocketLockOptions {
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number;
  /** A lock file naming no readable owner is abandoned once older than this. */
  staleMs?: number;
  retryMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 50;
const BREAKER_STALE_MS = 5_000;

export class HostSocketLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Another Daintree is starting or stopping Host mode (${lockPath} is held)`);
    this.name = "HostSocketLockTimeoutError";
  }
}

const chains = new Map<string, Promise<unknown>>();

export function hostSocketLockPath(socketPath: string): string {
  return `${socketPath}.lock`;
}

export async function withHostSocketLock<T>(
  socketPath: string,
  fn: () => Promise<T>,
  options: HostSocketLockOptions = {}
): Promise<T> {
  const previous = chains.get(socketPath) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => withLockFile(socketPath, fn, options));
  const tail = run.catch(() => {});
  chains.set(socketPath, tail);
  void tail.then(() => {
    if (chains.get(socketPath) === tail) chains.delete(socketPath);
  });
  return run;
}

async function withLockFile<T>(
  socketPath: string,
  fn: () => Promise<T>,
  options: HostSocketLockOptions
): Promise<T> {
  const lockPath = hostSocketLockPath(socketPath);
  const ino = await acquire(lockPath, options);
  try {
    return await fn();
  } finally {
    await release(lockPath, ino);
  }
}

async function acquire(lockPath: string, options: HostSocketLockOptions): Promise<number> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      let ino: number | null = null;
      try {
        ino = (await handle.stat()).ino;
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) })
        );
        return ino;
      } catch (err) {
        // Never leave a lock nobody holds for others to wait out.
        if (ino !== null) await release(lockPath, ino);
        else await fs.unlink(lockPath).catch(() => {});
        throw err;
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) throw new HostSocketLockTimeoutError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/** Unlink only the lock this holder created. */
async function release(lockPath: string, ino: number): Promise<void> {
  try {
    if ((await fs.lstat(lockPath)).ino === ino) await fs.unlink(lockPath);
  } catch {
    // Already gone (broken as stale by another process); nothing to release.
  }
}

/**
 * When `pid` started, as the kernel counts it, where that is cheap to read
 * (Linux's /proc). Null elsewhere: the pid alone then decides.
 */
export function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 counts from after the parenthesised command name, which may
    // itself contain spaces or parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the lock's recorded owner is verifiably gone. Unknown (no usable
 * pid) is not gone: the caller decides that case by age.
 */
function ownerIsGone(pid: unknown, start: unknown): boolean | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  // Our own pid can only be on a lock this process no longer holds: holders in
  // this process are queued on the chain, so the file outlived its holder.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  // Alive under that pid. It is still the owner unless the pid was reused.
  if (typeof start === "string") {
    const now = processStartTime(pid);
    if (now !== null && now !== start) return true;
  }
  return false;
}

async function breakIfStale(lockPath: string, staleMs: number): Promise<void> {
  const stale = await readStaleLock(lockPath, staleMs);
  if (stale === null) return;
  // One breaker at a time: acquirers only ever create the lock (O_EXCL) and
  // remove their own, so with breakers serialized the lock path can only still
  // hold the inode judged stale when it is unlinked below.
  const breakerPath = `${lockPath}.break`;
  let breaker: fs.FileHandle;
  try {
    breaker = await fs.open(breakerPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return;
    // A breaker that died mid-break; breaking takes milliseconds.
    try {
      if (Date.now() - (await fs.lstat(breakerPath)).mtimeMs > BREAKER_STALE_MS) {
        await fs.unlink(breakerPath);
      }
    } catch {
      // Gone already, or not ours to judge yet.
    }
    return;
  }
  try {
    const again = await readStaleLock(lockPath, staleMs);
    if (again !== null && again.ino === stale.ino) await fs.unlink(lockPath).catch(() => {});
  } finally {
    await breaker.close().catch(() => {});
    await fs.unlink(breakerPath).catch(() => {});
  }
}

/** The lock's inode when it is abandoned; null when it is held, gone or unreadable. */
async function readStaleLock(lockPath: string, staleMs: number): Promise<{ ino: number } | null> {
  let ino: number;
  let pid: unknown;
  let start: unknown;
  let mtimeMs: number;
  try {
    const handle = await fs.open(lockPath, "r");
    try {
      const stat = await handle.stat();
      ino = stat.ino;
      mtimeMs = stat.mtimeMs;
      try {
        const owner = JSON.parse(await handle.readFile("utf8")) as {
          pid?: unknown;
          start?: unknown;
        };
        pid = owner?.pid;
        start = owner?.start;
      } catch {
        pid = undefined;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const gone = ownerIsGone(pid, start);
  if (gone === null) return Date.now() - mtimeMs > staleMs ? { ino } : null;
  return gone ? { ino } : null;
}
