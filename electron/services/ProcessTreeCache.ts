import { execFile, type ExecFileOptionsWithStringEncoding } from "child_process";
import os from "node:os";
import { logDebug } from "../utils/logger.js";

function execProbe(
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding
): Promise<{ stdout: string; pid: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout) => {
      // Native callbacks are asynchronous, but deferring also keeps this safe
      // under unit-test doubles that invoke the callback synchronously before
      // `execFile` has returned its ChildProcess.
      queueMicrotask(() => {
        if (error) reject(error);
        else resolve({ stdout, pid: child?.pid ?? null });
      });
    });
  });
}

const BACKOFF_MULTIPLIER = 1.5;
const BACKOFF_CEILING_MS = 15_000;
/**
 * Backoff ceiling while a lineage ledger is tracking roots. The ledger can only
 * record a descendant it actually sees, so the gap between sweeps is the window
 * in which a process can spawn, detach, and become unreachable forever (#12203).
 * The idle ceiling above is far too coarse for that; this keeps the window
 * bounded without pinning the census at its base interval all night.
 */
const LINEAGE_BACKOFF_CEILING_MS = 5_000;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  command: string;
  cpuPercent: number; // CPU usage percentage (0-100)
  rssKb: number; // Resident Set Size in KB
  /**
   * OS-reported process start time, when the platform census carries one.
   * Populated on Windows (`CreationDate` is already fetched for CPU deltas);
   * absent on Unix, where `ps -eo` would need a fixed-width `lstart` column and
   * the lineage ledger probes the handful of PIDs it cares about instead.
   */
  startTime?: string;
}

/**
 * Lineage tracking hook. Declared structurally so the cache never imports the
 * ledger — they are wired together in pty-host.ts.
 */
export interface LineageLedgerHook {
  hasRoots(): boolean;
  reconcile(census: ProcessTreeCache): void;
}

type RefreshCallback = () => void;
type RefreshOutcome = "changed" | "unchanged" | "error";

export class ProcessTreeCache {
  private cache: Map<number, ProcessInfo> = new Map();
  private childrenMap: Map<number, number[]> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed: boolean = false;
  private currentIntervalMs: number;
  private isRefreshing: boolean = false;
  private lastRefreshTime: number = 0;
  private isWindows: boolean = process.platform === "win32";
  private refreshCallbacks: Set<RefreshCallback> = new Set();
  private lastError: Error | null = null;
  private loggedZeroSubscriberSkip: boolean = false;
  private lineageLedger: LineageLedgerHook | null = null;
  private cpuSnapshots = new Map<
    string,
    { kernelTicks: bigint; userTicks: bigint; wallMs: number }
  >();

  constructor(private pollIntervalMs: number = 2500) {
    this.currentIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.pollTimer !== null || this.isRefreshing) {
      console.warn("[ProcessTreeCache] Already started");
      return;
    }

    this.disposed = false;
    this.currentIntervalMs = this.pollIntervalMs;

    console.log(`[ProcessTreeCache] Starting with ${this.pollIntervalMs}ms base poll interval`);

    this.refresh();
  }

  stop(): void {
    this.disposed = true;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentIntervalMs = this.pollIntervalMs;
    console.log("[ProcessTreeCache] Stopped");
  }

  setPollInterval(ms: number): void {
    if (this.pollIntervalMs === ms) return;
    this.pollIntervalMs = ms;
    this.currentIntervalMs = ms;
    if (!this.disposed && this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.schedulePoll(ms);
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.disposed) return;
      this.refresh();
    }, delayMs);
  }

  private resetBackoff(): void {
    this.currentIntervalMs = this.pollIntervalMs;
  }

  private advanceBackoff(): void {
    // Never below the configured base interval — a tight lineage ceiling caps
    // how far we drift, it must not make the census poll faster than asked.
    const ceiling = this.hasLineageRoots()
      ? Math.max(LINEAGE_BACKOFF_CEILING_MS, this.pollIntervalMs)
      : BACKOFF_CEILING_MS;
    this.currentIntervalMs = Math.min(
      Math.ceil(this.currentIntervalMs * BACKOFF_MULTIPLIER),
      ceiling
    );
  }

  /**
   * Attach the lineage ledger. While it holds roots the census keeps sweeping
   * even with no subscribers, and backs off to a tighter ceiling — the ledger
   * can only record descendants it observes, and an unobserved descendant that
   * detaches is unreachable forever.
   */
  attachLineageLedger(ledger: LineageLedgerHook | null): void {
    this.lineageLedger = ledger;
  }

  private hasLineageRoots(): boolean {
    try {
      return this.lineageLedger?.hasRoots() ?? false;
    } catch {
      return false;
    }
  }

  getCurrentIntervalMs(): number {
    return this.currentIntervalMs;
  }

  onRefresh(callback: RefreshCallback): () => void {
    const wasEmpty = this.refreshCallbacks.size === 0;
    this.refreshCallbacks.add(callback);

    // Trigger immediate refresh when first subscriber is added
    if (wasEmpty && this.refreshCallbacks.size === 1) {
      this.refresh();
    }

    return () => {
      this.refreshCallbacks.delete(callback);
    };
  }

  async refresh(): Promise<void> {
    // Skip refresh if nobody is listening - saves CPU especially on Windows.
    // A lineage ledger with live roots counts as a listener: it is the only
    // record of descendants that have detached, and it can only be built from
    // sweeps that actually ran (#12203).
    if (this.refreshCallbacks.size === 0 && !this.hasLineageRoots()) {
      // Log once per lifecycle when we skip due to no subscribers. If
      // ProcessDetector instances aren't registering, detection goes silent —
      // this surfaces the cause instead of failing silently (#5813). Verbose-gated
      // because normal startup briefly has no subscribers between cache.start()
      // and the first ProcessDetector attaching.
      if (!this.loggedZeroSubscriberSkip) {
        this.loggedZeroSubscriberSkip = true;
        logDebug(
          "[ProcessTreeCache] refresh skipped — no subscribers (ProcessDetector not attached?)"
        );
      }
      if (!this.disposed) {
        this.schedulePoll(this.currentIntervalMs);
      }
      return;
    }
    this.loggedZeroSubscriberSkip = false;

    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    let outcome: RefreshOutcome = "error";
    try {
      if (this.isWindows) {
        outcome = (await this.refreshWindows()) ? "changed" : "unchanged";
      } else {
        outcome = (await this.refreshUnix()) ? "changed" : "unchanged";
      }
      this.lastRefreshTime = Date.now();
      this.lastError = null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Only log on transition into failure or each subsequent distinct error
      // message — don't spam once per poll while a persistent failure lasts.
      // This is always-on (not DAINTREE_VERBOSE-gated) because silent ps
      // failures have burned us before: the utility-process sandbox on
      // macOS can block `ps` and detection silently returns empty.
      const prevMsg = this.lastError?.message ?? null;
      if (prevMsg !== err.message) {
        console.error(
          "[ProcessTreeCache] ps refresh failed — detection will be blind until it recovers:",
          err
        );
      }
      this.lastError = err;
    } finally {
      this.isRefreshing = false;

      // Fold the fresh census into the lineage ledger before subscribers run,
      // so anything reading the ledger during a callback sees this sweep.
      //
      // Skipped when the sweep failed: `this.cache` still holds the previous
      // snapshot, and presenting that as current would let the ledger count a
      // just-registered root as missing — closing a healthy terminal's lineage
      // on evidence that predates it.
      //
      // Isolated from the census itself: a ledger fault must not blind
      // detection, which is what every other subscriber depends on.
      if (this.lineageLedger && outcome !== "error") {
        try {
          this.lineageLedger.reconcile(this);
        } catch (err) {
          console.error("[ProcessTreeCache] Lineage reconcile error:", err);
        }
      }

      // Invoke callbacks after isRefreshing is reset
      for (const callback of this.refreshCallbacks) {
        try {
          callback();
        } catch (err) {
          console.error("[ProcessTreeCache] Refresh callback error:", err);
        }
      }

      // Schedule next poll with adaptive backoff
      if (!this.disposed) {
        if (outcome === "changed" || outcome === "error") {
          this.resetBackoff();
        } else {
          this.advanceBackoff();
        }
        this.schedulePoll(this.currentIntervalMs);
      }
    }
  }

  private async refreshUnix(): Promise<boolean> {
    // Include %cpu for activity detection. execFile avoids the shell fork that
    // exec() introduces — ps takes no shell features, so the intermediate
    // /bin/sh -c is pure overhead on every poll.
    const { stdout, pid: probePid } = await execProbe(
      "ps",
      ["-eo", "pid,ppid,%cpu,rss,comm,command"],
      {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        env: { ...process.env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" },
      }
    );

    const newCache = new Map<number, ProcessInfo>();
    const newChildrenMap = new Map<number, number[]>();

    const lines = stdout.split("\n");
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parsed = this.parseUnixLine(line);
      // The probe appears in the census it produces. Retaining that short-lived
      // PID makes every otherwise-identical snapshot look changed and prevents
      // the idle backoff from ever advancing.
      if (parsed && parsed.pid !== probePid) {
        newCache.set(parsed.pid, parsed);

        const children = newChildrenMap.get(parsed.ppid) || [];
        children.push(parsed.pid);
        newChildrenMap.set(parsed.ppid, children);
      }
    }

    const changed = this.hasOwnedTreeChanged(this.childrenMap, newChildrenMap);

    this.cache = newCache;
    this.childrenMap = newChildrenMap;

    // Sort children arrays for deterministic ordering
    for (const children of newChildrenMap.values()) {
      children.sort((a, b) => a - b);
    }

    return changed;
  }

  private parseUnixLine(line: string): ProcessInfo | null {
    // Format: PID PPID %CPU RSS COMM COMMAND
    // PID and PPID are right-aligned numbers, %CPU is a decimal, RSS is an integer (KB),
    // COMM is the basename, COMMAND is the full command line
    // Example: "  123    1  0.5 12345 bash /bin/bash --login"
    // Make command optional in case ps omits it
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const cpuPercent = parseFloat(match[3]) || 0;
    const rssKb = parseInt(match[4], 10) || 0;
    // Regex captures are V8 sliced strings that pin the entire multi-MB ps
    // stdout in memory for as long as the cache retains them. Buffer.from()
    // round-trip is the only idiom that forces a flat copy — String(),
    // concatenation, and template literals all produce ConsStrings that still
    // reference the parent.
    const comm = Buffer.from(match[5]).toString();
    const command = match[6] ? Buffer.from(match[6]).toString().trim() || comm : comm;

    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) {
      return null;
    }

    return { pid, ppid, comm, command, cpuPercent, rssKb };
  }

  private async refreshWindows(): Promise<boolean> {
    // Use PowerShell's Get-CimInstance with calculated properties to fetch CPU timing fields.
    // KernelModeTime/UserModeTime are cast to [string] to preserve UInt64 precision in JSON.
    // CreationDate uses .ToString('o') for consistent ISO 8601 across PS 5.1 and PS 7.
    // NOTE: Use regular string concatenation — template literals would interpolate $_ as JS variables.
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'; " +
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
      "@{N='KernelModeTime';E={[string]$_.KernelModeTime}}," +
      "@{N='UserModeTime';E={[string]$_.UserModeTime}}," +
      "@{N='WorkingSetSize';E={[string]$_.WorkingSetSize}}," +
      "@{N='CreationDate';E={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }}} | " +
      "ConvertTo-Json -Compress";

    // execFile, not exec: exec routes through `cmd.exe /c`, so every poll spawned
    // an extra process AND the hide flag only covers that intermediary — the
    // grandchild powershell.exe could still flash its own console window
    // (#12042). Spawning powershell directly removes the cmd hop entirely and
    // puts windowsHide on the process that actually has a console. argv form
    // also means the script no longer needs a layer of cmd-level quoting.
    const { stdout, pid: probePid } = await execProbe(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", psScript],
      {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf-8",
      }
    );

    const trimmed = stdout.replace(/^\uFEFF/, "").trim();
    if (!trimmed || trimmed === "null") {
      const changed = this.cache.size > 0;
      this.cache = new Map();
      this.childrenMap = new Map();
      this.cpuSnapshots.clear();
      return changed;
    }

    let result;
    try {
      result = JSON.parse(trimmed);
    } catch (error) {
      console.warn("[ProcessTreeCache] PowerShell JSON parse failed:", {
        outputSample: trimmed.slice(0, 200),
      });
      throw error;
    }

    const processes = Array.isArray(result) ? result : [result];

    const newCache = new Map<number, ProcessInfo>();
    const newChildrenMap = new Map<number, number[]>();
    const now = Date.now();
    const numCpus = Math.max(os.availableParallelism(), 1);
    const activeSnapshotKeys = new Set<string>();

    for (const p of processes) {
      const pid = parseInt(String(p?.ProcessId), 10);
      const ppid = parseInt(String(p?.ParentProcessId), 10);

      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || pid === probePid) {
        continue;
      }

      const name = (p?.Name || "").replace(/\.exe$/i, "");
      if (!name) {
        continue;
      }

      const command =
        typeof p?.CommandLine === "string" && p.CommandLine.trim().length > 0
          ? p.CommandLine.trim()
          : name;

      // Compute delta-based CPU% from KernelModeTime/UserModeTime (100ns tick values)
      const snapshotKey = p.CreationDate ? `${pid}:${p.CreationDate}` : String(pid);
      activeSnapshotKeys.add(snapshotKey);

      const kernelTicks = BigInt(p.KernelModeTime ?? "0");
      const userTicks = BigInt(p.UserModeTime ?? "0");

      let cpuPercent = 0;
      const prior = this.cpuSnapshots.get(snapshotKey);
      if (prior && prior.wallMs < now) {
        const totalDelta = kernelTicks - prior.kernelTicks + (userTicks - prior.userTicks);
        if (totalDelta >= 0n) {
          const deltaWallMs = BigInt(now - prior.wallMs);
          const capacity = deltaWallMs * 10000n * BigInt(numCpus);
          if (capacity > 0n) {
            cpuPercent = Math.min(Number((totalDelta * 10000n) / capacity) / 100, 100);
          }
        }
      }

      this.cpuSnapshots.set(snapshotKey, { kernelTicks, userTicks, wallMs: now });

      // WorkingSetSize is in bytes; convert to KB
      const workingSetBytes = Number(p.WorkingSetSize ?? "0");
      const rssKb = Math.floor(workingSetBytes / 1024);

      newCache.set(pid, {
        pid,
        ppid,
        comm: name,
        command,
        cpuPercent,
        rssKb,
        // Already fetched for the CPU-delta snapshot key above, so the lineage
        // ledger gets its pid-reuse anchor on Windows for free.
        ...(typeof p?.CreationDate === "string" && p.CreationDate
          ? { startTime: p.CreationDate }
          : {}),
      });

      const children = newChildrenMap.get(ppid) || [];
      children.push(pid);
      newChildrenMap.set(ppid, children);
    }

    // Prune stale snapshot entries for processes that no longer exist
    for (const key of this.cpuSnapshots.keys()) {
      if (!activeSnapshotKeys.has(key)) {
        this.cpuSnapshots.delete(key);
      }
    }

    const changed = this.hasOwnedTreeChanged(this.childrenMap, newChildrenMap);

    this.cache = newCache;
    this.childrenMap = newChildrenMap;

    // Sort children arrays for deterministic ordering
    for (const children of newChildrenMap.values()) {
      children.sort((a, b) => a - b);
    }

    return changed;
  }

  private hasOwnedTreeChanged(
    oldChildrenMap: Map<number, number[]>,
    newChildrenMap: Map<number, number[]>
  ): boolean {
    const collectDescendants = (childrenMap: Map<number, number[]>): Set<number> => {
      const descendants = new Set<number>();
      const pending = [...(childrenMap.get(process.pid) ?? [])];

      while (pending.length > 0) {
        const pid = pending.pop()!;
        if (descendants.has(pid)) continue;
        descendants.add(pid);
        pending.push(...(childrenMap.get(pid) ?? []));
      }

      return descendants;
    };

    const oldPids = collectDescendants(oldChildrenMap);
    const newPids = collectDescendants(newChildrenMap);
    if (oldPids.size !== newPids.size) return true;
    for (const pid of newPids) {
      if (!oldPids.has(pid)) return true;
    }
    return false;
  }

  getChildren(ppid: number): ProcessInfo[] {
    const childPids = this.childrenMap.get(ppid) || [];
    return childPids
      .map((pid) => this.cache.get(pid))
      .filter((p): p is ProcessInfo => p !== undefined);
  }

  getChildPids(ppid: number): number[] {
    const childPids = this.childrenMap.get(ppid);
    return childPids ? [...childPids] : [];
  }

  /**
   * Get all descendant PIDs of a process in bottom-up (post-order) order.
   * Deepest descendants come first so callers can kill leaves before parents,
   * preventing OS reparenting to PID 1 which would break the tree snapshot.
   * The root PID itself is NOT included in the result.
   */
  getDescendantPids(rootPid: number): number[] {
    const result: number[] = [];
    const visited = new Set<number>();

    const visit = (pid: number): void => {
      if (visited.has(pid)) return;
      visited.add(pid);

      const children = this.childrenMap.get(pid);
      if (children) {
        for (const child of children) {
          visit(child);
        }
      }

      if (pid !== rootPid) {
        result.push(pid);
      }
    };

    visit(rootPid);
    return result;
  }

  getProcess(pid: number): ProcessInfo | undefined {
    return this.cache.get(pid);
  }

  hasChildren(ppid: number): boolean {
    const children = this.childrenMap.get(ppid);
    return children !== undefined && children.length > 0;
  }

  /**
   * Get the total CPU usage of all descendants of a process.
   * Returns the sum of cpuPercent for child processes recursively; the root
   * process itself is intentionally excluded.
   */
  getDescendantsCpuUsage(ppid: number): number {
    let totalCpu = 0;
    const visited = new Set<number>();
    const queue = this.getChildPids(ppid);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const processInfo = this.cache.get(pid);
      if (processInfo) {
        totalCpu += processInfo.cpuPercent;
        queue.push(...this.getChildPids(pid));
      }
    }

    return totalCpu;
  }

  /**
   * Check whether any descendant of a process has meaningful CPU activity.
   */
  hasActiveDescendants(ppid: number, threshold: number = 0.5): boolean {
    const visited = new Set<number>();
    const queue = this.getChildPids(ppid);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const processInfo = this.cache.get(pid);
      if (processInfo) {
        if (processInfo.cpuPercent >= threshold) {
          return true;
        }
        queue.push(...this.getChildPids(pid));
      }
    }

    return false;
  }

  /**
   * Get aggregated resource summary for a process tree.
   * Includes the root process and all descendants.
   * Breakdown is capped at 10 entries sorted by CPU descending.
   */
  getTreeResourceSummary(rootPid: number): {
    cpuPercent: number;
    memoryKb: number;
    breakdown: Array<{ pid: number; comm: string; cpuPercent: number; memoryKb: number }>;
  } | null {
    const rootProcess = this.cache.get(rootPid);
    if (!rootProcess) return null;

    let totalCpu = rootProcess.cpuPercent;
    let totalMemory = rootProcess.rssKb;
    const breakdown: Array<{ pid: number; comm: string; cpuPercent: number; memoryKb: number }> = [
      {
        pid: rootProcess.pid,
        comm: rootProcess.comm,
        cpuPercent: rootProcess.cpuPercent,
        memoryKb: rootProcess.rssKb,
      },
    ];

    const visited = new Set<number>([rootPid]);
    const queue = this.getChildPids(rootPid);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const proc = this.cache.get(pid);
      if (proc) {
        totalCpu += proc.cpuPercent;
        totalMemory += proc.rssKb;
        breakdown.push({
          pid: proc.pid,
          comm: proc.comm,
          cpuPercent: proc.cpuPercent,
          memoryKb: proc.rssKb,
        });
        queue.push(...this.getChildPids(pid));
      }
    }

    // Sort by CPU descending, cap at 10
    breakdown.sort((a, b) => b.cpuPercent - a.cpuPercent);
    return {
      cpuPercent: totalCpu,
      memoryKb: totalMemory,
      breakdown: breakdown.slice(0, 10),
    };
  }

  /**
   * Aggregate resident memory across a set of labeled process subtrees.
   *
   * Each root contributes its own RSS plus that of every descendant. PIDs are
   * deduplicated within a key (so nested or overlapping subtrees sharing a
   * project aren't summed twice) and globally (so the grand total never
   * double-counts a process reachable from two roots). RSS still counts
   * shared/copy-on-write pages, so these sums are a generous pressure
   * heuristic, not a unique-footprint measurement.
   */
  aggregateSubtreeMemory(
    roots: Array<{ key: string; rootPid: number }>,
    topPerKey: number = 5
  ): {
    byKey: Record<
      string,
      {
        memoryKb: number;
        processCount: number;
        topProcesses: Array<{ pid: number; comm: string; cpuPercent: number; memoryKb: number }>;
      }
    >;
    totalMemoryKb: number;
    totalProcessCount: number;
  } {
    type Bucket = {
      memoryKb: number;
      processCount: number;
      seen: Set<number>;
      procs: ProcessInfo[];
    };
    const buckets = new Map<string, Bucket>();
    const globalSeen = new Set<number>();
    let totalMemoryKb = 0;
    let totalProcessCount = 0;

    for (const { key, rootPid } of roots) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { memoryKb: 0, processCount: 0, seen: new Set(), procs: [] };
        buckets.set(key, bucket);
      }
      const pids = [rootPid, ...this.getDescendantPids(rootPid)];
      for (const pid of pids) {
        const proc = this.cache.get(pid);
        if (!proc) continue;
        if (!bucket.seen.has(pid)) {
          bucket.seen.add(pid);
          bucket.memoryKb += proc.rssKb;
          bucket.processCount += 1;
          bucket.procs.push(proc);
        }
        if (!globalSeen.has(pid)) {
          globalSeen.add(pid);
          totalMemoryKb += proc.rssKb;
          totalProcessCount += 1;
        }
      }
    }

    const byKey: Record<
      string,
      {
        memoryKb: number;
        processCount: number;
        topProcesses: Array<{ pid: number; comm: string; cpuPercent: number; memoryKb: number }>;
      }
    > = {};
    for (const [key, bucket] of buckets) {
      // Expose only comm (the process basename), never `command` — the full
      // command line can carry paths, tokens, and branch names.
      const topProcesses = [...bucket.procs]
        .sort((a, b) => b.rssKb - a.rssKb)
        .slice(0, topPerKey)
        .map((p) => ({
          pid: p.pid,
          comm: p.comm,
          cpuPercent: p.cpuPercent,
          memoryKb: p.rssKb,
        }));
      byKey[key] = { memoryKb: bucket.memoryKb, processCount: bucket.processCount, topProcesses };
    }

    return { byKey, totalMemoryKb, totalProcessCount };
  }

  getLastRefreshTime(): number {
    return this.lastRefreshTime;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
