import fs from "node:fs/promises";

/**
 * Serializes everything that decides who owns a host socket path: probing and
 * unlinking a stale socket, binding the new one, publishing the discovery file,
 * and removing it at shutdown. Within a process the holders queue on a promise
 * chain; across processes (a dev and a packaged build share the Linux runtime
 * directory) they take an exclusive lock file next to the socket.
 *
 * A lock whose owner is gone, or that is older than any real holder would keep
 * it, is broken by one waiter at a time (an O_EXCL breaker file), which
 * re-checks it is still the inode judged stale before unlinking it, so a fresh
 * lock is never the one removed.
 */

export interface HostSocketLockOptions {
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number;
  /** A lock file older than this is abandoned whatever its pid says. */
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
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
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

function pidIsGone(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  // Our own pid can only be on a lock this process no longer holds: holders in
  // this process are queued on the chain, so the file outlived its holder.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
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
  let mtimeMs: number;
  try {
    const handle = await fs.open(lockPath, "r");
    try {
      const stat = await handle.stat();
      ino = stat.ino;
      mtimeMs = stat.mtimeMs;
      try {
        pid = (JSON.parse(await handle.readFile("utf8")) as { pid?: unknown }).pid;
      } catch {
        pid = undefined;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const old = Date.now() - mtimeMs > staleMs;
  return old || pidIsGone(pid) ? { ino } : null;
}
