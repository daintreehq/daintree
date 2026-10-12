import { execFile, spawnSync } from "child_process";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  isKillableWindowsPid,
  terminateWindowsProcesses,
  walkVerifiedTree,
  type WindowsProcessRow,
  type WindowsTreeKillFailure,
} from "./windowsProcessTree.js";

/**
 * Process-tree kill for Windows that does not trust ParentProcessId — the
 * replacement for `taskkill /T` (see `windowsProcessTree.ts` for why /T is
 * unsafe). One PowerShell reads the process table; the creation-time walk runs
 * here; each verified PID is terminated on its own. Never `/T`, not even as a
 * fallback: if the census fails, only the root is terminated.
 *
 * The script is a constant. The PID being killed never enters it — the whole
 * table comes back and is walked here.
 */
const CENSUS_SCRIPT =
  "$ErrorActionPreference = 'Stop'; " +
  "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process' | " +
  "ForEach-Object { $c = '-'; if ($_.CreationDate) { $c = $_.CreationDate.ToString('o') }; " +
  "'{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $c }";

const CENSUS_ARGS = ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", CENSUS_SCRIPT];
const CENSUS_MAX_BUFFER = 16 * 1024 * 1024;

/** Census budget for callers whose taskkill had no timeout of its own. */
export const DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;

export interface WindowsTreeKillResult {
  /**
   * `tree`: the census ran and the verified tree was terminated.
   * `gone`: the census ran and did not list the root, so nothing was touched.
   * `root-only`: the census failed, so only the root was terminated.
   * `skipped`: not Windows, or not a PID this may kill (system PIDs, this
   * process, its parent).
   */
  mode: "tree" | "gone" | "root-only" | "skipped";
  /** Every PID a termination was attempted on, root first. */
  targeted: number[];
  /** Terminations that failed for a reason other than the process already being gone. */
  failed: WindowsTreeKillFailure[];
  /** Processes left alone because they only name a tree member as parent through a reused PID. */
  stale: number[];
  /** The root is gone: the census did not list it, or its termination succeeded. */
  rootEnded: boolean;
  /** Why the census failed, for `root-only`. */
  censusError?: string;
}

export interface WindowsTreeKillOptions {
  /** Budget for the PowerShell census; the terminations themselves are in-process. */
  timeoutMs?: number;
}

type CensusRead = { rows: WindowsProcessRow[] } | { error: string };

/**
 * Rows from the census script, or null when the table is not provably whole:
 * one without this process's own row was cut short, and reading it as
 * complete would call a live root gone.
 */
export function parseWindowsProcessRows(stdout: string): WindowsProcessRow[] | null {
  const rows: WindowsProcessRow[] = [];
  let sawSelf = false;
  for (const line of stdout.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    if (pid === process.pid) sawSelf = true;
    rows.push(match[3] === "-" ? { pid, ppid } : { pid, ppid, startTime: match[3] });
  }
  return sawSelf ? rows : null;
}

function censusFromStdout(stdout: unknown): CensusRead {
  const rows = parseWindowsProcessRows(typeof stdout === "string" ? stdout : "");
  return rows ? { rows } : { error: "incomplete process table" };
}

function readCensusSync(timeoutMs: number): CensusRead {
  try {
    const result = spawnSync("powershell.exe", CENSUS_ARGS, {
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: CENSUS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!result) return { error: "no result" };
    if (result.error) return { error: result.error.message };
    if (result.status !== 0) return { error: `exited ${result.status}` };
    return censusFromStdout(result.stdout);
  } catch (err) {
    return { error: formatErrorMessage(err, "PowerShell did not start") };
  }
}

function readCensus(timeoutMs: number): Promise<CensusRead> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        CENSUS_ARGS,
        { windowsHide: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: CENSUS_MAX_BUFFER },
        (error, stdout) => resolve(error ? { error: error.message } : censusFromStdout(stdout))
      );
    } catch (err) {
      resolve({ error: formatErrorMessage(err, "PowerShell did not start") });
    }
  });
}

function skipped(): WindowsTreeKillResult {
  return { mode: "skipped", targeted: [], failed: [], stale: [], rootEnded: false };
}

function killRoots(
  roots: readonly number[],
  census: CensusRead
): Map<number, WindowsTreeKillResult> {
  const results = new Map<number, WindowsTreeKillResult>();
  // Shared so a root inside another root's tree is not terminated twice.
  const ended = new Set<number>();
  for (const root of roots) {
    if (results.has(root)) continue;
    if (!isKillableWindowsPid(root)) {
      results.set(root, skipped());
      continue;
    }
    if ("error" in census) {
      const failed = terminateWindowsProcesses([root], ended);
      results.set(root, {
        mode: "root-only",
        targeted: [root],
        failed,
        stale: [],
        rootEnded: failed.length === 0,
        censusError: census.error,
      });
      continue;
    }
    const walk = walkVerifiedTree(census.rows, root);
    if (walk.pids.length === 0) {
      results.set(root, { mode: "gone", targeted: [], failed: [], stale: [], rootEnded: true });
      continue;
    }
    if (walk.stale.length > 0) {
      console.warn(
        `[WindowsTreeKill] pid=${root}: left ${walk.stale.length} older process(es) naming a PID in this tree as parent through PID reuse: ${walk.stale.join(", ")}`
      );
    }
    const failed = terminateWindowsProcesses(walk.pids, ended);
    results.set(root, {
      mode: "tree",
      targeted: walk.pids,
      failed,
      stale: walk.stale,
      rootEnded: !failed.some((f) => f.pid === root),
    });
  }
  return results;
}

function anyKillable(pids: readonly number[]): boolean {
  return process.platform === "win32" && pids.some(isKillableWindowsPid);
}

/**
 * Terminate each root's creation-time-verified tree from one census, blocking
 * until done. For callers that must finish before returning — quit paths, a
 * kill that has to precede the next statement. The census is a PowerShell
 * start, a few hundred milliseconds, so prefer {@link killWindowsProcessTree}
 * wherever an await fits.
 */
export function killWindowsProcessTreesSync(
  pids: readonly number[],
  options: WindowsTreeKillOptions = {}
): Map<number, WindowsTreeKillResult> {
  if (!anyKillable(pids)) return new Map(pids.map((pid) => [pid, skipped()]));
  return killRoots(pids, readCensusSync(options.timeoutMs ?? DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS));
}

/** {@link killWindowsProcessTreesSync} for one root. */
export function killWindowsProcessTreeSync(
  pid: number,
  options: WindowsTreeKillOptions = {}
): WindowsTreeKillResult {
  return killWindowsProcessTreesSync([pid], options).get(pid) ?? skipped();
}

/** {@link killWindowsProcessTreeSync} with a census that never blocks the event loop. */
export async function killWindowsProcessTree(
  pid: number,
  options: WindowsTreeKillOptions = {}
): Promise<WindowsTreeKillResult> {
  if (!anyKillable([pid])) return skipped();
  const census = await readCensus(options.timeoutMs ?? DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS);
  return killRoots([pid], census).get(pid) ?? skipped();
}

/** A log line for a kill that may have left part of the tree running, or null. */
export function describeWindowsTreeKillProblem(result: WindowsTreeKillResult): string | null {
  const parts: string[] = [];
  if (result.censusError !== undefined) {
    parts.push(`process census failed (${result.censusError}), ended the root alone`);
  }
  if (result.failed.length > 0) {
    parts.push(`could not end ${result.failed.map((f) => `${f.pid} (${f.code})`).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
