import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  command: string;
  cpuPercent: number; // CPU usage percentage (0-100)
}

type RefreshCallback = () => void;

export class ProcessTreeCache {
  private cache: Map<number, ProcessInfo> = new Map();
  private childrenMap: Map<number, number[]> = new Map();
  private refreshInterval: NodeJS.Timeout | null = null;
  private isRefreshing: boolean = false;
  private lastRefreshTime: number = 0;
  private isWindows: boolean = process.platform === "win32";
  private refreshCallbacks: Set<RefreshCallback> = new Set();
  private lastError: Error | null = null;

  constructor(private pollIntervalMs: number = 2500) {} // 2.5 seconds (increased from 1s to reduce CPU load)

  start(): void {
    if (this.refreshInterval) {
      console.warn("[ProcessTreeCache] Already started");
      return;
    }

    console.log(`[ProcessTreeCache] Starting with ${this.pollIntervalMs}ms poll interval`);

    this.refresh();
    this.refreshInterval = setInterval(() => {
      this.refresh();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      console.log("[ProcessTreeCache] Stopped");
    }
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
    // Skip refresh if nobody is listening - saves CPU especially on Windows
    if (this.refreshCallbacks.size === 0) {
      return;
    }

    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    try {
      if (this.isWindows) {
        await this.refreshWindows();
      } else {
        await this.refreshUnix();
      }
      this.lastRefreshTime = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      if (process.env.CANOPY_VERBOSE) {
        console.error("[ProcessTreeCache] Refresh failed:", error);
      }
    } finally {
      this.isRefreshing = false;

      // Invoke callbacks after isRefreshing is reset
      for (const callback of this.refreshCallbacks) {
        try {
          callback();
        } catch (err) {
          console.error("[ProcessTreeCache] Refresh callback error:", err);
        }
      }
    }
  }

  private async refreshUnix(): Promise<void> {
    // Include %cpu for activity detection
    const { stdout } = await execAsync("ps -eo pid,ppid,%cpu,comm,command", {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024, // 10MB to handle systems with many processes
    });

    const newCache = new Map<number, ProcessInfo>();
    const newChildrenMap = new Map<number, number[]>();

    const lines = stdout.split("\n");
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parsed = this.parseUnixLine(line);
      if (parsed) {
        newCache.set(parsed.pid, parsed);

        const children = newChildrenMap.get(parsed.ppid) || [];
        children.push(parsed.pid);
        newChildrenMap.set(parsed.ppid, children);
      }
    }

    this.cache = newCache;
    this.childrenMap = newChildrenMap;

    // Sort children arrays for deterministic ordering
    for (const children of newChildrenMap.values()) {
      children.sort((a, b) => a - b);
    }
  }

  private parseUnixLine(line: string): ProcessInfo | null {
    // Format: PID PPID %CPU COMM COMMAND
    // PID and PPID are right-aligned numbers, %CPU is a decimal, COMM is the basename, COMMAND is the full command line
    // Example: "  123    1  0.5 bash /bin/bash --login"
    // Make command optional in case ps omits it
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const cpuPercent = parseFloat(match[3]) || 0;
    const comm = match[4];
    const command = match[5]?.trim() || comm;

    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) {
      return null;
    }

    return { pid, ppid, comm, command, cpuPercent };
  }

  private async refreshWindows(): Promise<void> {
    // Use PowerShell's Get-CimInstance for efficient batch query
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -NoLogo -Command "$ErrorActionPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"`,
      {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const trimmed = stdout.replace(/^\uFEFF/, "").trim();
    if (!trimmed || trimmed === "null") {
      this.cache = new Map();
      this.childrenMap = new Map();
      return;
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

    for (const p of processes) {
      const pid = parseInt(String(p?.ProcessId), 10);
      const ppid = parseInt(String(p?.ParentProcessId), 10);

      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) {
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

      newCache.set(pid, {
        pid,
        ppid,
        comm: name,
        command,
        cpuPercent: 0, // Windows CPU% requires performance counters; use 0 as fallback
      });

      const children = newChildrenMap.get(ppid) || [];
      children.push(pid);
      newChildrenMap.set(ppid, children);
    }

    this.cache = newCache;
    this.childrenMap = newChildrenMap;

    // Sort children arrays for deterministic ordering
    for (const children of newChildrenMap.values()) {
      children.sort((a, b) => a - b);
    }
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

  getProcess(pid: number): ProcessInfo | undefined {
    return this.cache.get(pid);
  }

  hasChildren(ppid: number): boolean {
    const children = this.childrenMap.get(ppid);
    return children !== undefined && children.length > 0;
  }

  /**
   * Get the total CPU usage of all descendants of a process.
   * Returns the sum of cpuPercent for all child processes recursively.
   * Useful for detecting if a process tree is actually doing work.
   */
  getDescendantsCpuUsage(ppid: number): number {
    let totalCpu = 0;
    const visited = new Set<number>();
    const queue = this.getChildPids(ppid);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const process = this.cache.get(pid);
      if (process) {
        totalCpu += process.cpuPercent;
        // Add grandchildren to queue
        queue.push(...this.getChildPids(pid));
      }
    }

    return totalCpu;
  }

  /**
   * Check if any descendant of a process has significant CPU activity.
   * @param ppid Parent process ID
   * @param threshold Minimum CPU% to consider as "active" (default 0.5%)
   */
  hasActiveDescendants(ppid: number, threshold: number = 0.5): boolean {
    const visited = new Set<number>();
    const queue = this.getChildPids(ppid);

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const process = this.cache.get(pid);
      if (process) {
        if (process.cpuPercent >= threshold) {
          return true;
        }
        // Add grandchildren to queue
        queue.push(...this.getChildPids(pid));
      }
    }

    return false;
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
