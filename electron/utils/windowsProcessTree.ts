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
 * Pure apart from {@link terminateWindowsProcesses}; the census that feeds it
 * lives in `windowsTreeKill.ts`, and the pty-host feeds it its cached census.
 */

/** One `Win32_Process` row. `startTime` is `CreationDate.ToString('o')`, as `ProcessTreeCache` keeps it. */
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
 * TerminateProcess each PID in order, skipping any already ended in this
 * batch. On Windows `process.kill` is TerminateProcess for every signal but 0;
 * ESRCH means the process is already gone, which is the goal.
 */
export function terminateWindowsProcesses(
  pids: readonly number[],
  ended: Set<number> = new Set()
): WindowsTreeKillFailure[] {
  const failed: WindowsTreeKillFailure[] = [];
  for (const pid of pids) {
    if (ended.has(pid) || !isKillableWindowsPid(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      ended.add(pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (code === "ESRCH") ended.add(pid);
      else failed.push({ pid, code });
    }
  }
  return failed;
}
