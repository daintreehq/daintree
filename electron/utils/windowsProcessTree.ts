/**
 * Windows process-tree membership by creation time.
 *
 * Windows never clears a process's ParentProcessId when its parent exits, and
 * it recycles PIDs. An unrelated, older process whose launcher has exited can
 * therefore name one of our PIDs as its parent. `taskkill /T` follows that
 * link without checking creation times, so tree-killing our process ends that
 * program and everything under it (openai/codex#36258 took down its own desktop
 * host this way). A link is real only when the child was created no earlier
 * than the process that now holds its parent's PID.
 *
 * Pure. The kill itself runs inside one PowerShell process
 * (`windowsTreeKill.ts`), which repeats {@link walkVerifiedTree} and
 * {@link sameProcessIdentity} over its own census so that the census, the walk
 * and every termination happen in one process. These are the reference
 * definitions of those decisions; the script must stay in step with them.
 */

/** One `Win32_Process` row. `startTime` is `CreationDate.ToString('o')`, as the census helpers print it. */
export interface WindowsProcessRow {
  pid: number;
  ppid: number;
  startTime?: string;
}

export interface VerifiedTree {
  /** The root, then each descendant after its parent. Empty when the root is not listed. */
  pids: number[];
  /**
   * Listed processes whose ParentProcessId names a member of the tree but which
   * cannot be proven to be its children: created before it, or with a creation
   * time missing on either side. Left alone and not descended into. When the
   * root is not listed, every process naming it as parent lands here.
   */
  stale: number[];
}

export interface WindowsTreeKillFailure {
  pid: number;
  code: string;
}

/**
 * The most two readings of one process's creation time may differ by and still
 * name the same process. CIM reports `CreationDate` to the microsecond while
 * `Process.StartTime` carries 100 ns ticks; both are floored to whole
 * microseconds, and one microsecond of slack absorbs a CIM that rounds rather
 * than truncates. A recycled PID cannot hide inside it: the process that reuses
 * a PID is created after the previous holder has exited.
 */
export const IDENTITY_TOLERANCE_MICROS = 1;

/** Whether two creation times, in UTC microseconds, identify the same process. */
export function sameProcessIdentity(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= IDENTITY_TOLERANCE_MICROS;
}

/**
 * PIDs never terminated, whatever a table says: Idle (0) and System (4), this
 * process, and its parent. `process.kill(0)` on Windows ends the caller.
 */
export function isKillableWindowsPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 4 && pid !== process.pid && pid !== process.ppid;
}

/**
 * Microseconds since the epoch for a `CreationDate.ToString('o')` value.
 * `Date.parse` keeps only the milliseconds of the seven fractional digits, so
 * the next three are added back: a child started in the same millisecond as
 * its parent still compares correctly.
 */
export function creationTimeMicros(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const micros = fraction.length > 3 ? Number(fraction.slice(3, 6).padEnd(3, "0")) : 0;
  return ms * 1000 + micros;
}

/**
 * UTC microseconds for an identity a caller holds: a `CreationDate.ToString('o')`
 * string as the trashed-PID and lineage ledgers persist it, or a number that is
 * already microseconds (what a previous tree kill reported for its root).
 */
export function identityMicros(value: string | number | undefined): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  return creationTimeMicros(value);
}

/**
 * The tree under `rootPid` that creation times can prove: a process is a child
 * of a member only when it was created no earlier than that member, so equal
 * timestamps count. A missing or unparseable CreationDate proves nothing, and
 * that link is reported as stale rather than followed; in practice only Idle
 * and System lack one.
 */
export function walkVerifiedTree(rows: Iterable<WindowsProcessRow>, rootPid: number): VerifiedTree {
  const byPid = new Map<number, WindowsProcessRow>();
  const childrenOf = new Map<number, WindowsProcessRow[]>();
  for (const row of rows) {
    if (byPid.has(row.pid)) continue;
    byPid.set(row.pid, row);
    if (row.pid === row.ppid) continue;
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenOf.set(row.ppid, [row]);
  }

  if (!byPid.has(rootPid)) {
    return { pids: [], stale: (childrenOf.get(rootPid) ?? []).map((row) => row.pid) };
  }

  const pids = [rootPid];
  const stale: number[] = [];
  const seen = new Set<number>([rootPid]);
  for (let i = 0; i < pids.length; i++) {
    const parentStart = creationTimeMicros(byPid.get(pids[i])?.startTime);
    for (const child of childrenOf.get(pids[i]) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const childStart = creationTimeMicros(child.startTime);
      if (parentStart === undefined || childStart === undefined || childStart < parentStart) {
        stale.push(child.pid);
        continue;
      }
      if (!isKillableWindowsPid(child.pid)) continue;
      pids.push(child.pid);
    }
  }
  return { pids, stale };
}

/**
 * The order a verified tree is terminated in: deepest first, the root last, so
 * a caller waiting on the root's exit (execFile's `close`) never observes it
 * while a descendant holding its pipes is still alive.
 */
export function terminationOrder(pids: readonly number[]): number[] {
  return [...pids].reverse();
}
