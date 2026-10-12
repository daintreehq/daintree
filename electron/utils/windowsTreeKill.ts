import { execFile, spawnSync } from "child_process";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  identityMicros,
  isKillableWindowsPid,
  type WindowsTreeKillFailure,
} from "./windowsProcessTree.js";

/**
 * Process-tree kill for Windows that does not trust ParentProcessId or a bare
 * PID — the replacement for `taskkill /T` (see `windowsProcessTree.ts` for why
 * /T is unsafe). Never `/T`, not even as a fallback.
 *
 * One PowerShell process does all of it, so nothing it proves can go stale
 * before it acts:
 *
 * 1. Reads the process table (`Win32_Process`: PID, parent, CreationDate).
 * 2. Walks each root's tree by creation time (`walkVerifiedTree`'s rule).
 *    A root whose census identity differs from the caller's expected one is
 *    left alone entirely.
 * 3. Opens every member by PID (`Process.GetProcessById` + `.Handle`), which
 *    pins it — Windows does not reuse a PID while a handle to it is open — and
 *    compares the handle's StartTime with the census CreationDate, both as UTC
 *    microseconds. A mismatch means the PID was recycled since the census, and
 *    that process is not touched.
 * 4. Terminates each verified descendant through its own handle, deepest
 *    first, and waits for them; then the roots, and waits for those. A caller
 *    watching a root's exit (execFile's `close`) never sees it before the rest
 *    of the tree has gone.
 * 5. Reports each PID as killed (exit observed), already gone, still running
 *    when the shared wait budget ran out, failed, or reused since the census.
 *
 * The script text is constant. Every PID and identity reaches it as JSON in
 * {@link INPUT_ENV}, and it is passed with -EncodedCommand, so no caller value
 * is ever parsed as PowerShell.
 *
 * If the census fails, a root is ended alone: through a handle checked against
 * the caller's expected identity when there is one, by PID only when the
 * caller says the PID is its own live child (it holds the process handle, so
 * the PID cannot have been reused), and otherwise not at all.
 */

const INPUT_ENV = "DAINTREE_TREE_KILL_INPUT";
const INPUT_PARTS_ENV = "DAINTREE_TREE_KILL_PARTS";
/** Characters per input variable: Windows caps one environment variable at 32,767. */
const INPUT_PART_CHARS = 30_000;

/**
 * Keep in step with `walkVerifiedTree` and `sameProcessIdentity`
 * (windowsProcessTree.ts) and with {@link parseTreeKillOutput}. Windows
 * PowerShell 5.1. `$PID` is PowerShell's own PID, so no variable here is
 * named `$pid`. Output is buffered and written once at the end, so a
 * termination never waits on our end of the pipe.
 */
export const TREE_KILL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$out = [System.Text.StringBuilder]::new()",
  "function Emit([string]$line) { [void]$out.AppendLine($line) }",
  "function Clean([string]$text) { ($text -replace '\\s+', ' ').Trim() }",
  "$epochTicks = [long]621355968000000000",
  "function Micros($date) { $rem = [long]0; [Math]::DivRem([long]($date.ToUniversalTime().Ticks - $epochTicks), [long]10, [ref]$rem) }",
  "function Same($a, $b) { ($null -ne $a) -and ($null -ne $b) -and ([Math]::Abs([long]$a - [long]$b) -le 1) }",
  "function ErrCode($err) { $e = $err.Exception; while ($e.InnerException) { $e = $e.InnerException }; if ($e -is [System.ComponentModel.Win32Exception]) { 'win32-' + $e.NativeErrorCode } else { $e.GetType().Name } }",
  "function Running([long]$id) { try { [void][System.Diagnostics.Process]::GetProcessById([int]$id); $true } catch { $false } }",
  `$parts = [int]$env:${INPUT_PARTS_ENV}`,
  `$req = ConvertFrom-Json (-join (0..($parts - 1) | ForEach-Object { [Environment]::GetEnvironmentVariable('${INPUT_ENV}_' + $_) }))`,
  "$self = [long]$req.self",
  "$parent = [long]$req.parent",
  "function Killable([long]$id) { ($id -gt 4) -and ($id -ne [long]$PID) -and ($id -ne $self) -and ($id -ne $parent) }",
  "$rows = $null",
  "$kids = @{}",
  "try {",
  "  $table = @{}",
  "  foreach ($p in (Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')) {",
  "    $id = [long]$p.ProcessId",
  "    if ($table.ContainsKey($id)) { continue }",
  "    $start = $null",
  "    if ($p.CreationDate) { $start = Micros $p.CreationDate }",
  "    $ppid = [long]$p.ParentProcessId",
  "    $table[$id] = @($ppid, $start)",
  "    if ($id -ne $ppid) {",
  "      if (-not $kids.ContainsKey($ppid)) { $kids[$ppid] = [System.Collections.Generic.List[long]]::new() }",
  "      $kids[$ppid].Add($id)",
  "    }",
  "  }",
  "  if (-not $table.ContainsKey([long]$PID)) { throw 'incomplete process table' }",
  "  $rows = $table",
  "} catch { $kids = @{}; Emit ('E ' + (Clean $_.Exception.Message)) }",
  "$owner = @{}",
  "$inner = @{}",
  "$handles = @{}",
  "$outcome = @{}",
  "function Open([long]$id, $expect) {",
  "  try { $proc = [System.Diagnostics.Process]::GetProcessById([int]$id) } catch { $outcome[$id] = 'gone'; return }",
  "  try { $null = $proc.Handle; $now = Micros $proc.StartTime } catch {",
  "    $err = $_",
  "    if (Running $id) { $outcome[$id] = 'failed ' + (ErrCode $err) } else { $outcome[$id] = 'gone' }",
  "    $proc.Dispose(); return",
  "  }",
  "  if (($null -ne $expect) -and -not (Same $now $expect)) { $outcome[$id] = 'mismatch'; $proc.Dispose(); return }",
  "  $handles[$id] = $proc",
  "}",
  "$plans = [System.Collections.Generic.List[object]]::new()",
  "for ($i = 0; $i -lt $req.roots.Count; $i++) {",
  "  $r = $req.roots[$i]",
  "  $root = [long]$r.pid",
  "  $expect = $null",
  "  if ($null -ne $r.start) { $expect = [long]$r.start }",
  "  $members = [System.Collections.Generic.List[long]]::new()",
  "  $stale = [System.Collections.Generic.List[long]]::new()",
  "  $mode = 'tree'",
  "  $rootStart = $null",
  "  if (-not (Killable $root)) { $mode = 'refused' }",
  "  elseif ($null -eq $rows) {",
  "    if (($null -ne $expect) -or $r.own) { $mode = 'root-only'; $members.Add($root) } else { $mode = 'untouched' }",
  "  } elseif (-not $rows.ContainsKey($root)) {",
  "    $mode = 'gone'",
  "    if ($kids.ContainsKey($root)) { foreach ($c in $kids[$root]) { $stale.Add($c) } }",
  "  } else {",
  "    $rootStart = $rows[$root][1]",
  "    if (($null -ne $expect) -and -not (Same $rootStart $expect)) { $mode = 'mismatch' } else {",
  "      $members.Add($root)",
  "      $seen = @{}",
  "      $seen[$root] = $true",
  "      if ($r.tree) {",
  "        for ($j = 0; $j -lt $members.Count; $j++) {",
  "          $up = $members[$j]",
  "          $upStart = $rows[$up][1]",
  "          if (-not $kids.ContainsKey($up)) { continue }",
  "          foreach ($c in $kids[$up]) {",
  "            if ($seen.ContainsKey($c)) { continue }",
  "            $seen[$c] = $true",
  "            $cStart = $rows[$c][1]",
  "            if (($null -eq $upStart) -or ($null -eq $cStart) -or ($cStart -lt $upStart)) { $stale.Add($c); continue }",
  "            if (-not (Killable $c)) { continue }",
  "            $members.Add($c)",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "  for ($q = 1; $q -lt $members.Count; $q++) { $inner[$members[$q]] = $true }",
  "  $mine = [System.Collections.Generic.List[long]]::new()",
  "  foreach ($m in $members) {",
  "    if ($owner.ContainsKey($m)) { continue }",
  "    $owner[$m] = $i",
  "    $mine.Add($m)",
  "    if ($null -eq $rows) { Open $m $expect }",
  "    elseif ($null -eq $rows[$m][1]) { $outcome[$m] = 'failed no-identity' }",
  "    else { Open $m $rows[$m][1] }",
  "  }",
  "  $plans.Add(@($i, $mode, $rootStart, $mine, $stale, $root))",
  "}",
  "$terminated = [System.Collections.Generic.List[long]]::new()",
  "function KillOne([long]$id) {",
  "  if (-not $handles.ContainsKey($id)) { return }",
  "  $proc = $handles[$id]",
  "  try { $proc.Kill(); $terminated.Add($id) } catch {",
  "    $err = $_",
  "    $exited = $false",
  "    try { $exited = $proc.HasExited } catch { }",
  "    if ($exited) { $outcome[$id] = 'gone' } else { $outcome[$id] = 'failed ' + (ErrCode $err) }",
  "  }",
  "}",
  "$deadline = [DateTime]::UtcNow.AddMilliseconds([double]$req.waitMs)",
  "function WaitAll() {",
  "  foreach ($id in $terminated) {",
  "    if ($outcome.ContainsKey($id)) { continue }",
  "    $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)",
  "    $done = $false",
  "    try { $done = $handles[$id].WaitForExit($left) } catch { }",
  "    if ($done) { $outcome[$id] = 'killed' } else { $outcome[$id] = 'timeout' }",
  "  }",
  "}",
  "function IsTop($plan) { $plan[3].Contains($plan[5]) -and -not $inner.ContainsKey($plan[5]) }",
  "foreach ($plan in $plans) {",
  "  $mine = $plan[3]",
  "  for ($k = $mine.Count - 1; $k -ge 0; $k--) {",
  "    if (($mine[$k] -ne $plan[5]) -or -not (IsTop $plan)) { KillOne $mine[$k] }",
  "  }",
  "}",
  "WaitAll",
  "foreach ($plan in $plans) { if (IsTop $plan) { KillOne $plan[5] } }",
  "WaitAll",
  "foreach ($plan in $plans) {",
  "  $i = $plan[0]",
  "  $rs = '-'",
  "  if ($null -ne $plan[2]) { $rs = [string]$plan[2] }",
  "  Emit ('R ' + $i + ' ' + $plan[1] + ' ' + $rs)",
  "  foreach ($id in $plan[3]) { Emit ('P ' + $i + ' ' + $id + ' ' + $outcome[$id]) }",
  "  foreach ($id in $plan[4]) { Emit ('S ' + $i + ' ' + $id) }",
  "}",
  "Emit 'END'",
  "[Console]::Out.Write($out.ToString())",
].join("\n");

const ENCODED_SCRIPT = Buffer.from(TREE_KILL_SCRIPT, "utf16le").toString("base64");
const HELPER_ARGS = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", ENCODED_SCRIPT];
const HELPER_MAX_BUFFER = 4 * 1024 * 1024;

/** Budget for callers whose taskkill had no timeout of its own. */
export const DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_MS = 1500;
/** What a run needs besides the exit wait: a PowerShell start and one CIM query. */
const HELPER_OVERHEAD_MS = 1500;

/** One tree to end. A bare number is `{ pid }`. */
export interface WindowsTreeKillTarget {
  pid: number;
  /**
   * The root's expected identity: `CreationDate.ToString('o')` as the trashed-PID
   * and lineage ledgers record it, or UTC microseconds as a previous kill's
   * {@link WindowsTreeKillResult.rootStartTime}. When the process now holding
   * the PID has a different creation time, nothing is killed.
   */
  startTime?: string | number;
  /** False ends the root alone, by handle. Default true. */
  tree?: boolean;
  /**
   * The caller holds this process's handle (a live `ChildProcess` it spawned),
   * so the PID cannot have been reused. Only then may a failed census end the
   * root by PID without an identity.
   */
  ownChild?: boolean;
}

export interface WindowsTreeKillOptions {
  /** Upper bound on the whole run: PowerShell start, census, terminations and exit wait. */
  timeoutMs?: number;
  /** How long, of that, to wait for terminated processes to exit. */
  waitMs?: number;
}

export type WindowsTreeKillMode =
  /** The census listed the root under the expected identity; its verified tree was processed. */
  | "tree"
  /** The census did not list the root: nothing was touched. */
  | "gone"
  /** The PID belongs to a process created at another time than the caller expected: nothing was touched. */
  | "identity-mismatch"
  /** The census failed, so the root alone was processed. */
  | "root-only"
  /** The census failed and the root could not be identified: nothing was touched. */
  | "untouched"
  /** Not Windows, or a PID never killed (system, this process, its parent). */
  | "skipped";

export interface WindowsTreeKillResult {
  mode: WindowsTreeKillMode;
  /** PIDs this root accounted for, root first. A PID shared with an earlier root in the batch is that root's. */
  targeted: number[];
  /** Terminated and observed to exit. */
  killed: number[];
  /** Not running by the time it was opened or terminated. */
  alreadyGone: number[];
  /** Terminated but still running when the wait budget ran out. */
  timedOut: number[];
  /**
   * Terminated by PID after the helper itself failed, with no handle to watch
   * the exit through: an owned root only (see {@link WindowsTreeKillTarget.ownChild}).
   */
  unconfirmed: number[];
  /** Could not be opened or terminated (access denied, for one). */
  failed: WindowsTreeKillFailure[];
  /** The PID was reused between census and termination; the new holder was left alone. */
  identityMismatch: number[];
  /** Processes left alone because they name a tree member as parent only through a reused PID. */
  stale: number[];
  /** Our root is gone: not listed, superseded by another holder of its PID, or ended here. */
  rootEnded: boolean;
  /** The root's creation time from the census, UTC microseconds, for a later kill to pass back. */
  rootStartTime?: number;
  /** Why the census or the helper failed. */
  error?: string;
}

/** A target with its identity in microseconds and its flags resolved. */
export interface NormalizedTreeKillTarget {
  pid: number;
  start?: number;
  tree: boolean;
  own: boolean;
}

export function normalizeTreeKillTarget(
  target: number | WindowsTreeKillTarget
): NormalizedTreeKillTarget {
  const spec = typeof target === "number" ? { pid: target } : target;
  const start = identityMicros(spec.startTime);
  return {
    pid: spec.pid,
    ...(start !== undefined ? { start } : {}),
    tree: spec.tree !== false,
    own: spec.ownChild === true,
  };
}

/**
 * The helper's input, as JSON for {@link INPUT_ENV}. Identities travel as
 * decimal strings: Windows PowerShell's JSON reader turns large numbers into
 * doubles.
 */
export function encodeTreeKillInput(
  targets: readonly NormalizedTreeKillTarget[],
  waitMs: number
): string {
  return JSON.stringify({
    self: process.pid,
    parent: process.ppid,
    waitMs: Math.max(0, Math.floor(waitMs)),
    roots: targets.map((t) => ({
      pid: t.pid,
      start: t.start === undefined ? null : String(t.start),
      tree: t.tree,
      own: t.own,
    })),
  });
}

type RawOutcome = "killed" | "gone" | "timeout" | "mismatch" | `failed ${string}`;

export interface ParsedTreeKillRoot {
  mode: string;
  rootStart?: number;
  pids: Array<{ pid: number; outcome: string }>;
  stale: number[];
}

export interface ParsedTreeKillOutput {
  roots: Map<number, ParsedTreeKillRoot>;
  censusError?: string;
}

/**
 * The helper's report, or null when it is not provably complete: one without
 * the closing `END` was cut short, and reading it as whole would call a live
 * tree handled.
 */
export function parseTreeKillOutput(stdout: string): ParsedTreeKillOutput | null {
  const roots = new Map<number, ParsedTreeKillRoot>();
  let censusError: string | undefined;
  let complete = false;
  for (const rawLine of stdout.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "END") {
      complete = true;
      break;
    }
    const [tag, first, ...rest] = line.split(" ");
    if (tag === "E") {
      censusError = [first, ...rest].join(" ").trim() || "census failed";
      continue;
    }
    const index = Number(first);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (tag === "R") {
      const start = rest[1] !== undefined && /^\d+$/.test(rest[1]) ? Number(rest[1]) : undefined;
      roots.set(index, {
        mode: rest[0] ?? "",
        ...(start !== undefined ? { rootStart: start } : {}),
        pids: [],
        stale: [],
      });
      continue;
    }
    const root = roots.get(index);
    const pid = Number(rest[0]);
    if (!root || !Number.isSafeInteger(pid)) continue;
    if (tag === "P") root.pids.push({ pid, outcome: rest.slice(1).join(" ") });
    else if (tag === "S") root.stale.push(pid);
  }
  return complete ? { roots, ...(censusError !== undefined ? { censusError } : {}) } : null;
}

function emptyResult(mode: WindowsTreeKillMode): WindowsTreeKillResult {
  return {
    mode,
    targeted: [],
    killed: [],
    alreadyGone: [],
    timedOut: [],
    unconfirmed: [],
    failed: [],
    identityMismatch: [],
    stale: [],
    rootEnded: false,
  };
}

const ROOT_MODES: Record<string, WindowsTreeKillMode> = {
  tree: "tree",
  gone: "gone",
  mismatch: "identity-mismatch",
  "root-only": "root-only",
  untouched: "untouched",
  refused: "skipped",
};

/**
 * Turn a complete report into one result per target, in input order. Each
 * PID's outcome is read from whichever root accounted for it, so a root that
 * sat inside an earlier root's tree still learns whether it ended.
 */
export function classifyTreeKillOutput(
  targets: readonly NormalizedTreeKillTarget[],
  parsed: ParsedTreeKillOutput
): WindowsTreeKillResult[] {
  const outcomeOf = new Map<number, string>();
  for (const root of parsed.roots.values()) {
    for (const { pid, outcome } of root.pids) outcomeOf.set(pid, outcome);
  }

  return targets.map((target, index) => {
    const root = parsed.roots.get(index);
    if (!root) {
      return { ...emptyResult("untouched"), error: "no report for this root" };
    }
    const mode = ROOT_MODES[root.mode] ?? "untouched";
    const result = emptyResult(mode);
    if (root.rootStart !== undefined) result.rootStartTime = root.rootStart;
    if (parsed.censusError !== undefined) result.error = parsed.censusError;
    result.stale = [...root.stale];
    for (const { pid, outcome } of root.pids) {
      result.targeted.push(pid);
      const raw = outcome as RawOutcome;
      if (raw === "killed") result.killed.push(pid);
      else if (raw === "gone") result.alreadyGone.push(pid);
      else if (raw === "timeout") result.timedOut.push(pid);
      else if (raw === "mismatch") result.identityMismatch.push(pid);
      else result.failed.push({ pid, code: raw.replace(/^failed\s*/, "") || "UNKNOWN" });
    }
    const rootOutcome = outcomeOf.get(target.pid);
    result.rootEnded =
      mode === "gone" ||
      mode === "identity-mismatch" ||
      ((mode === "tree" || mode === "root-only") &&
        (rootOutcome === "killed" || rootOutcome === "gone" || rootOutcome === "mismatch"));
    return result;
  });
}

/**
 * Results for a run whose helper never reported: PowerShell missing, blocked,
 * timed out, or killed. A root the caller owns is ended by PID — its handle
 * pins the PID — and every other root is left alone.
 */
function fallbackResults(
  targets: readonly NormalizedTreeKillTarget[],
  error: string
): WindowsTreeKillResult[] {
  return targets.map((target) => {
    if (!target.own) return { ...emptyResult("untouched"), error };
    const result: WindowsTreeKillResult = {
      ...emptyResult("root-only"),
      targeted: [target.pid],
      error,
    };
    try {
      process.kill(target.pid, "SIGKILL");
      // TerminateProcess was issued, but there is no handle here to watch the
      // exit through, so the root is not reported as ended.
      result.unconfirmed.push(target.pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (code === "ESRCH") {
        result.alreadyGone.push(target.pid);
        result.rootEnded = true;
      } else {
        result.failed.push({ pid: target.pid, code });
      }
    }
    return result;
  });
}

function warnStale(targets: readonly NormalizedTreeKillTarget[], results: WindowsTreeKillResult[]) {
  results.forEach((result, index) => {
    if (result.stale.length === 0) return;
    console.warn(
      `[WindowsTreeKill] pid=${targets[index].pid}: left ${result.stale.length} older process(es) naming a PID in this tree as parent through PID reuse: ${result.stale.join(", ")}`
    );
  });
}

function budgets(options: WindowsTreeKillOptions): { timeoutMs: number; waitMs: number } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS;
  const waitMs = Math.max(
    0,
    Math.min(options.waitMs ?? DEFAULT_WAIT_MS, timeoutMs - HELPER_OVERHEAD_MS)
  );
  return { timeoutMs, waitMs };
}

/**
 * The helper's input as environment variables: the JSON cut into parts that
 * each fit one Windows variable, and their count. The script joins them back.
 */
export function treeKillInputEnv(json: string): Record<string, string> {
  const env: Record<string, string> = {};
  let parts = 0;
  for (let offset = 0; offset < json.length || parts === 0; offset += INPUT_PART_CHARS) {
    env[`${INPUT_ENV}_${parts}`] = json.slice(offset, offset + INPUT_PART_CHARS);
    parts++;
  }
  env[INPUT_PARTS_ENV] = String(parts);
  return env;
}

function helperOptions(input: string, timeoutMs: number) {
  return {
    windowsHide: true,
    encoding: "utf8" as const,
    timeout: timeoutMs,
    maxBuffer: HELPER_MAX_BUFFER,
    env: { ...process.env, ...treeKillInputEnv(input) },
  };
}

function firstLine(text: unknown): string {
  return typeof text === "string" ? (text.trim().split(/\r?\n/)[0] ?? "") : "";
}

function settle(
  targets: readonly NormalizedTreeKillTarget[],
  stdout: unknown,
  failure: string | null
): WindowsTreeKillResult[] {
  const parsed = parseTreeKillOutput(typeof stdout === "string" ? stdout : "");
  const results = parsed
    ? classifyTreeKillOutput(targets, parsed)
    : fallbackResults(targets, failure ?? "tree-kill helper gave an incomplete report");
  warnStale(targets, results);
  return results;
}

function runHelperSync(
  targets: readonly NormalizedTreeKillTarget[],
  timeoutMs: number,
  waitMs: number
): WindowsTreeKillResult[] {
  let stdout: unknown = "";
  let failure: string | null = null;
  try {
    const result = spawnSync("powershell.exe", HELPER_ARGS, {
      ...helperOptions(encodeTreeKillInput(targets, waitMs), timeoutMs),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result) {
      failure = "no result";
    } else {
      stdout = result.stdout;
      if (result.error) failure = result.error.message;
      else if (result.status !== 0)
        failure = `exited ${result.status}: ${firstLine(result.stderr)}`.trim();
    }
  } catch (err) {
    failure = formatErrorMessage(err, "PowerShell did not start");
  }
  return settle(targets, stdout, failure);
}

function runHelper(
  targets: readonly NormalizedTreeKillTarget[],
  timeoutMs: number,
  waitMs: number
): Promise<WindowsTreeKillResult[]> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "powershell.exe",
        HELPER_ARGS,
        helperOptions(encodeTreeKillInput(targets, waitMs), timeoutMs),
        (error, stdout, stderr) => {
          const failure = error
            ? `${error.message.split(/\r?\n/)[0]} ${firstLine(stderr)}`.trim()
            : null;
          resolve(settle(targets, stdout, failure));
        }
      );
      // The input is in the environment; an open stdin pipe is only something
      // for Windows PowerShell to wait on.
      child?.stdin?.end();
    } catch (err) {
      resolve(settle(targets, "", formatErrorMessage(err, "PowerShell did not start")));
    }
  });
}

interface Plan {
  normalized: NormalizedTreeKillTarget[];
  results: WindowsTreeKillResult[];
  /** Indexes into `normalized` that go to the helper. */
  live: number[];
}

function plan(targets: readonly (number | WindowsTreeKillTarget)[]): Plan {
  const normalized = targets.map(normalizeTreeKillTarget);
  const results = normalized.map(() => emptyResult("skipped"));
  const live =
    process.platform === "win32"
      ? normalized.flatMap((t, i) => (isKillableWindowsPid(t.pid) ? [i] : []))
      : [];
  return { normalized, results, live };
}

/**
 * Every target goes to one helper run, so one census and one set of pinned
 * handles cover them all: a second run could census a PID the first had
 * already ended and freed. Results are in input order.
 */
function merge(planned: Plan, helperResults: WindowsTreeKillResult[]): WindowsTreeKillResult[] {
  planned.live.forEach((index, j) => (planned.results[index] = helperResults[j]));
  return planned.results;
}

/**
 * End each target's verified tree and wait for it to exit, blocking the event
 * loop until done — a PowerShell start, so hundreds of milliseconds. Only for
 * paths where nothing can run afterwards: the host's exit teardown and
 * `process.on("exit")`. Everything else uses {@link killWindowsProcessTrees}.
 * Results are in input order.
 */
export function killWindowsProcessTreesSync(
  targets: readonly (number | WindowsTreeKillTarget)[],
  options: WindowsTreeKillOptions = {}
): WindowsTreeKillResult[] {
  const planned = plan(targets);
  if (planned.live.length === 0) return planned.results;
  const { timeoutMs, waitMs } = budgets(options);
  const helperTargets = planned.live.map((i) => planned.normalized[i]);
  return merge(planned, runHelperSync(helperTargets, timeoutMs, waitMs));
}

/**
 * {@link killWindowsProcessTreesSync} without blocking: resolves once every
 * terminated process has exited or the wait budget has run out, so a caller
 * that awaits it may rely on the result's `killed`/`timedOut` split.
 */
export async function killWindowsProcessTrees(
  targets: readonly (number | WindowsTreeKillTarget)[],
  options: WindowsTreeKillOptions = {}
): Promise<WindowsTreeKillResult[]> {
  const planned = plan(targets);
  if (planned.live.length === 0) return planned.results;
  const { timeoutMs, waitMs } = budgets(options);
  const helperTargets = planned.live.map((i) => planned.normalized[i]);
  return merge(planned, await runHelper(helperTargets, timeoutMs, waitMs));
}

/** {@link killWindowsProcessTrees} for one target. */
export async function killWindowsProcessTree(
  target: number | WindowsTreeKillTarget,
  options: WindowsTreeKillOptions = {}
): Promise<WindowsTreeKillResult> {
  return (await killWindowsProcessTrees([target], options))[0];
}

/** {@link killWindowsProcessTreesSync} for one target. */
export function killWindowsProcessTreeSync(
  target: number | WindowsTreeKillTarget,
  options: WindowsTreeKillOptions = {}
): WindowsTreeKillResult {
  return killWindowsProcessTreesSync([target], options)[0];
}

/**
 * The tree-kill target for a child this process spawned, or null once it has
 * exited. Until then Node holds the child's process handle, so its PID cannot
 * be reused and the helper may fall back to it; afterwards the PID may already
 * name an unrelated process, and the walk could not reach a dead root's
 * descendants anyway.
 */
export function liveChildTreeTarget(child: {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}): WindowsTreeKillTarget | null {
  if (typeof child.pid !== "number") return null;
  if (typeof child.exitCode === "number" || typeof child.signalCode === "string") return null;
  return { pid: child.pid, ownChild: true };
}

/**
 * Fire-and-forget {@link killWindowsProcessTree} for callers that cannot
 * await, with any problem logged under `tag`. Never throws, never blocks.
 */
export function killWindowsProcessTreeInBackground(
  target: number | WindowsTreeKillTarget,
  tag: string,
  options: WindowsTreeKillOptions = {}
): Promise<WindowsTreeKillResult | null> {
  const pid = typeof target === "number" ? target : target.pid;
  return killWindowsProcessTree(target, options).then(
    (result) => {
      const problem = describeWindowsTreeKillProblem(result);
      if (problem) console.warn(`${tag} tree kill pid=${pid}: ${problem}`);
      return result;
    },
    (error: unknown) => {
      console.warn(`${tag} tree kill pid=${pid}: ${formatErrorMessage(error, "failed")}`);
      return null;
    }
  );
}

/** A log line for a kill that may have left part of the tree running, or null. */
export function describeWindowsTreeKillProblem(result: WindowsTreeKillResult): string | null {
  const parts: string[] = [];
  if (result.error !== undefined) {
    const handled =
      result.unconfirmed.length > 0
        ? "terminated the root alone by PID, exit not observed"
        : result.mode === "root-only"
          ? "ended the root alone"
          : result.mode === "untouched"
            ? "could not identify the root, ended nothing"
            : null;
    parts.push(`process census failed (${result.error})${handled ? `, ${handled}` : ""}`);
  }
  if (result.failed.length > 0) {
    parts.push(`could not end ${result.failed.map((f) => `${f.pid} (${f.code})`).join(", ")}`);
  }
  if (result.timedOut.length > 0) {
    parts.push(`still running after termination: ${result.timedOut.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
