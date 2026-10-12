import { execFile, spawnSync } from "child_process";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  identityMicros,
  isKillableWindowsPid,
  type WindowsTreeKillFailure,
} from "./windowsProcessTree.js";
import {
  TREE_KILL_SENTINEL_PREFIX,
  WindowsTreeKillService,
  type TreeKillBudget,
  type TreeKillEngine,
} from "./windowsTreeKillService.js";

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
 * The script text is constant. Every PID and identity reaches it as JSON — in
 * {@link INPUT_ENV} for the one-shot helper, as a stdin line for the
 * persistent one — and it is passed with -EncodedCommand, so no caller value
 * is ever parsed as PowerShell.
 *
 * If the census fails, a root is ended alone: through a handle checked against
 * the caller's expected identity when there is one, by PID only while the root
 * is the caller's own child and Node has not seen it exit (Node holds its
 * process handle until then, so the PID cannot have been reused), and
 * otherwise not at all. Liveness is read when the run starts and again right
 * before any by-PID kill, never remembered from when the kill was requested.
 *
 * Two ways to run it. Asynchronous kills, in every process that makes them
 * (Main, the pty-host, the workspace host), go through one persistent helper
 * per process (`windowsTreeKillService.ts`), which queues and coalesces them
 * and falls back to the one-shot helper when it cannot finish a run. The
 * blocking variant is always a one-shot `spawnSync`, for exit paths where
 * nothing asynchronous can complete.
 *
 * Neither helper outlives the process that started it: Node spawns them
 * without `detached`, so libuv puts them in that process's kill-on-close job.
 * A kill still queued or running when its process exits is abandoned, and a
 * caller that needs it finished must hand it on before exiting.
 */

const INPUT_ENV = "DAINTREE_TREE_KILL_INPUT";
const INPUT_PARTS_ENV = "DAINTREE_TREE_KILL_PARTS";
/** Characters per input variable: Windows caps one environment variable at 32,767. */
const INPUT_PART_CHARS = 30_000;

/** Settings and pure helpers both forms of the helper share. */
const SCRIPT_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "function Emit([string]$line) { [void]$out.AppendLine($line) }",
  "function Clean([string]$text) { ($text -replace '\\s+', ' ').Trim() }",
  "$epochTicks = [long]621355968000000000",
  "function Micros($date) { $rem = [long]0; [Math]::DivRem([long]($date.ToUniversalTime().Ticks - $epochTicks), [long]10, [ref]$rem) }",
  "function Same($a, $b) { ($null -ne $a) -and ($null -ne $b) -and ([Math]::Abs([long]$a - [long]$b) -le 1) }",
  "function ErrCode($err) { $e = $err.Exception; while ($e.InnerException) { $e = $e.InnerException }; if ($e -is [System.ComponentModel.Win32Exception]) { 'win32-' + $e.NativeErrorCode } else { $e.GetType().Name } }",
  "function Running([long]$id) { try { [void][System.Diagnostics.Process]::GetProcessById([int]$id); $true } catch { $false } }",
];

/**
 * One kill run over `$req`, reported through `Emit`. Keep in step with
 * `walkVerifiedTree` and `sameProcessIdentity` (windowsProcessTree.ts) and
 * with {@link parseTreeKillOutput}. Windows PowerShell 5.1. `$PID` is
 * PowerShell's own PID, so no variable here is named `$pid`.
 *
 * Every root's plan (`R` lines) goes out before anything is terminated,
 * followed by `K` and a `Publish`. The persistent helper flushes it there, so
 * a run cut short still says which roots may have been ended and under which
 * identity; the one-shot keeps it buffered with the rest.
 */
const SCRIPT_BODY = [
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
  "foreach ($plan in $plans) {",
  "  $rs = '-'",
  "  if ($null -ne $plan[2]) { $rs = [string]$plan[2] }",
  "  Emit ('R ' + $plan[0] + ' ' + $plan[1] + ' ' + $rs)",
  "}",
  "Emit 'K'",
  "Publish",
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
  "  foreach ($id in $plan[3]) { Emit ('P ' + $plan[0] + ' ' + $id + ' ' + $outcome[$id]) }",
  "  foreach ($id in $plan[4]) { Emit ('S ' + $plan[0] + ' ' + $id) }",
  "}",
  "Emit 'END'",
];

/**
 * The one-shot helper: one run, its input from {@link INPUT_ENV}. Output is
 * buffered and written once at the end, so a termination never waits on our
 * end of the pipe.
 */
export const TREE_KILL_SCRIPT = [
  ...SCRIPT_PRELUDE,
  "$out = [System.Text.StringBuilder]::new()",
  "function Publish() { }",
  `$parts = [int]$env:${INPUT_PARTS_ENV}`,
  `$req = ConvertFrom-Json (-join (0..($parts - 1) | ForEach-Object { [Environment]::GetEnvironmentVariable('${INPUT_ENV}_' + $_) }))`,
  ...SCRIPT_BODY,
  "[Console]::Out.Write($out.ToString())",
].join("\n");

/**
 * The persistent helper (`windowsTreeKillService.ts`): one run per stdin line
 * `<id> <json>`, each answered by its report and a sentinel line carrying the
 * id. The JSON is read as data by ConvertFrom-Json and never becomes script.
 *
 * `[Console]::In.ReadLine()` returns null at EOF, so closing our end of stdin
 * — or this process dying — retires it. Each run's handles are disposed when
 * it ends: the process lives on, and a handle left open would keep its PID
 * from ever being reused. A run that throws ends the helper, after its `R`
 * lines if it got that far, which is exactly what recovery needs to read.
 * Every other output stream is silenced: stdout is the protocol.
 *
 * Writes never abort a run: a write to a pipe nobody reads any more fails, and
 * the run carries on to the end of its terminations instead of leaving the
 * tree half killed; the next read then sees EOF and the helper exits. That
 * does not make the helper outlive its host — it sits in the host's
 * kill-on-close job and dies with it.
 */
export const TREE_KILL_SERVER_SCRIPT = [
  ...SCRIPT_PRELUDE,
  "$WarningPreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  "$VerbosePreference = 'SilentlyContinue'",
  "$DebugPreference = 'SilentlyContinue'",
  "function Send([string]$text) { try { [Console]::Out.Write($text); [Console]::Out.Flush() } catch { } }",
  "function Publish() { Send ($out.ToString()); [void]$out.Clear() }",
  // Load CIM and open its WMI connection now, while the helper is idle, rather
  // than inside the first kill's census.
  "try { [void](Get-CimInstance -Query ('SELECT ProcessId FROM Win32_Process WHERE ProcessId = ' + [long]$PID)) } catch { }",
  "while ($true) {",
  "$reqLine = [Console]::In.ReadLine()",
  "if ($null -eq $reqLine) { break }",
  "$reqLine = $reqLine.Trim()",
  "$sp = $reqLine.IndexOf(' ')",
  "if ($sp -lt 1) { continue }",
  "$rid = $reqLine.Substring(0, $sp)",
  "if ($rid -notmatch '^[0-9]+$') { continue }",
  "$out = [System.Text.StringBuilder]::new()",
  "$handles = @{}",
  "try {",
  "$req = ConvertFrom-Json $reqLine.Substring($sp + 1)",
  ...SCRIPT_BODY,
  "} finally {",
  "foreach ($h in @($handles.Values)) { try { $h.Dispose() } catch { } }",
  "}",
  `Send ($out.ToString() + '${TREE_KILL_SENTINEL_PREFIX}' + $rid + [Environment]::NewLine)`,
  "}",
].join("\n");

const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"];
const HELPER_ARGS = [...POWERSHELL_FLAGS, encodeScript(TREE_KILL_SCRIPT)];
const SERVER_ARGS = [...POWERSHELL_FLAGS, encodeScript(TREE_KILL_SERVER_SCRIPT)];
const HELPER_MAX_BUFFER = 4 * 1024 * 1024;

/** What -EncodedCommand takes: the script as UTF-16LE, base64. */
function encodeScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Budget for callers whose taskkill had no timeout of its own. */
export const DEFAULT_WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_MS = 1500;
/** What a run needs besides the exit wait: a PowerShell start and one CIM query. */
const HELPER_OVERHEAD_MS = 1500;

/**
 * Node's record of a child this process spawned — a `ChildProcess` qualifies.
 * Until Node has seen the child exit it holds the child's process handle, and
 * Windows does not reuse a PID while a handle to it is open.
 */
export interface OwnedChildProcess {
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}

function childStillRunning(child: OwnedChildProcess): boolean {
  return typeof child.exitCode !== "number" && typeof child.signalCode !== "string";
}

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
   * The root is this child of the caller's. While it is still running its PID
   * cannot have been reused, so a failed census may end it by PID without an
   * identity. Read when the run starts and again just before any by-PID kill:
   * a kill can wait in the queue past the child's exit, and once Node has seen
   * the exit the PID may name anything. A child that has exited by the time
   * its run starts is not sent at all.
   */
  ownChild?: OwnedChildProcess;
  /**
   * Withdraws this root while it is still waiting in this process's queue:
   * once aborted, it is never handed to a helper and resolves as `withdrawn`.
   * For a root whose PID the caller can no longer vouch for — a shell with no
   * identity whose pseudoconsole was released, or that has exited. No effect
   * once its run has started.
   */
  withdrawOn?: AbortSignal;
}

export interface WindowsTreeKillOptions {
  /** Upper bound on the whole run: PowerShell start, census, terminations and exit wait. */
  timeoutMs?: number;
  /** How long, of that, to wait for terminated processes to exit. */
  waitMs?: number;
  /**
   * Asynchronous kills only: called once the run carrying this request has
   * been handed to a helper process. Until then it waits in this process's
   * queue. Either way it is this process's: the helper dies with it.
   */
  onStart?: () => void;
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
  /** The caller withdrew the root before its run started ({@link WindowsTreeKillTarget.withdrawOn}): nothing was touched. */
  | "withdrawn"
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
  /** The caller owns the root; see {@link ownsLiveChild} for whether that still counts. */
  own: boolean;
  /** Whether the owned child is still running, read at the moment it matters. */
  alive?: () => boolean;
  withdrawOn?: AbortSignal;
}

export function normalizeTreeKillTarget(
  target: number | WindowsTreeKillTarget
): NormalizedTreeKillTarget {
  const spec: WindowsTreeKillTarget = typeof target === "number" ? { pid: target } : target;
  const start = identityMicros(spec.startTime);
  const child = spec.ownChild;
  return {
    pid: spec.pid,
    ...(start !== undefined ? { start } : {}),
    tree: spec.tree !== false,
    own: child !== undefined,
    ...(child !== undefined ? { alive: () => childStillRunning(child) } : {}),
    ...(spec.withdrawOn ? { withdrawOn: spec.withdrawOn } : {}),
  };
}

/** The root is the caller's child and is still running, so its PID is still its own. */
function ownsLiveChild(target: NormalizedTreeKillTarget): boolean {
  return target.own && target.alive?.() !== false;
}

/**
 * The result for a target that must not be sent after all, or null to send it:
 * one its caller withdrew, or an owned child that has exited since the kill was
 * requested — its PID is free for reuse, and a dead root's tree cannot be
 * walked anyway. Checked when a run starts.
 */
export function screenTreeKillTarget(
  target: NormalizedTreeKillTarget
): WindowsTreeKillResult | null {
  if (target.own && target.alive?.() === false) return { ...emptyResult("gone"), rootEnded: true };
  if (target.withdrawOn?.aborted) return emptyResult("withdrawn");
  return null;
}

/**
 * The helper's input, as JSON for {@link INPUT_ENV}. Identities travel as
 * decimal strings: Windows PowerShell's JSON reader turns large numbers into
 * doubles. Ownership is read now, as the run starts.
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
      own: ownsLiveChild(t),
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

/** A root's plan as announced before any termination. */
export interface TreeKillRootPlan {
  mode: string;
  rootStart?: number;
}

/**
 * The plan a report announced before its first termination, or null when the
 * report never reached `K` — in which case the run ended nothing.
 */
export function parseTreeKillPlan(stdout: string): Map<number, TreeKillRootPlan> | null {
  const roots = new Map<number, TreeKillRootPlan>();
  for (const rawLine of stdout.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "K") return roots;
    const [tag, first, mode, start] = line.split(" ");
    if (tag !== "R") continue;
    const index = Number(first);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    roots.set(index, {
      mode: mode ?? "",
      ...(start !== undefined && /^\d+$/.test(start) ? { rootStart: Number(start) } : {}),
    });
  }
  return null;
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
 * timed out, or killed. A root that is the caller's still-running child is
 * ended by PID — Node's handle pins the PID — and every other root is left
 * alone. Liveness is read right here, not when the kill was requested: a child
 * that exited meanwhile no longer pins anything.
 */
function fallbackResults(
  targets: readonly NormalizedTreeKillTarget[],
  error: string
): WindowsTreeKillResult[] {
  return targets.map((target) => {
    if (!target.own) return { ...emptyResult("untouched"), error };
    if (!ownsLiveChild(target)) return { ...emptyResult("gone"), rootEnded: true, error };
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

type UnavailableListener = (reason: string) => void;
const unavailableListeners = new Set<UnavailableListener>();
let unavailableReported = false;

/**
 * Be told, once per process, that PowerShell could not run a tree kill at all:
 * missing, blocked by AppLocker or WDAC, or held in Constrained Language Mode.
 * Fired the first time the one-shot helper — the last resort, reached after
 * the persistent helper has failed — ends without a report for any reason but
 * its own timeout. Returns an unsubscribe.
 */
export function onWindowsTreeKillUnavailable(listener: UnavailableListener): () => void {
  unavailableListeners.add(listener);
  return () => unavailableListeners.delete(listener);
}

/** Test-only: forget that the unavailable notice was given. */
export function resetWindowsTreeKillUnavailableForTest(): void {
  unavailableReported = false;
}

function noteHelperUnavailable(reason: string): void {
  if (unavailableReported) return;
  unavailableReported = true;
  console.warn(
    `[WindowsTreeKill] PowerShell could not run the process-tree kill (${reason}). Terminals still close, but programs started in them may keep running until Daintree quits.`
  );
  for (const listener of unavailableListeners) {
    try {
      listener(reason);
    } catch {
      // A listener's failure must not reach the kill path.
    }
  }
}

function settle(
  targets: readonly NormalizedTreeKillTarget[],
  stdout: unknown,
  failure: string | null,
  timedOut = false
): WindowsTreeKillResult[] {
  const text = typeof stdout === "string" ? stdout : "";
  const parsed = parseTreeKillOutput(text);
  const reason = failure ?? "tree-kill helper gave an incomplete report";
  // Not one line of the script's output: PowerShell never got as far as
  // running it. A report cut short mid-run is a failed run, not a blocked one.
  if (!parsed && !timedOut && text.replace(/^\uFEFF/, "").trim() === "") {
    noteHelperUnavailable(reason);
  }
  const results = parsed
    ? classifyTreeKillOutput(targets, parsed)
    : fallbackResults(targets, reason);
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
  let timedOut = false;
  try {
    const result = spawnSync("powershell.exe", HELPER_ARGS, {
      ...helperOptions(encodeTreeKillInput(targets, waitMs), timeoutMs),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result) {
      failure = "no result";
    } else {
      stdout = result.stdout;
      if (result.error) {
        failure = result.error.message;
        timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      } else if (result.status !== 0)
        failure = `exited ${result.status}: ${firstLine(result.stderr)}`.trim();
    }
  } catch (err) {
    failure = formatErrorMessage(err, "PowerShell did not start");
  }
  return settle(targets, stdout, failure, timedOut);
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
          // execFile sets `killed` when its own timeout ended the helper.
          const timedOut = (error as { killed?: boolean } | null)?.killed === true;
          resolve(settle(targets, stdout, failure, timedOut));
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

export interface TreeKillRecoveryPlan {
  /** Targets to finish through the one-shot helper, each pinned as far as the partial report allows. */
  rerun: Array<{ index: number; target: NormalizedTreeKillTarget }>;
  /** Results the partial report already settles. */
  settled: Map<number, WindowsTreeKillResult>;
}

/**
 * What may still be done about a run the persistent helper did not finish.
 * The helper announces every root's plan, then `K`, before it terminates
 * anything, so:
 *
 * - A report known to be complete that never reached `K` ended nothing: every
 *   root goes again exactly as the caller asked, on the same premise the
 *   first attempt had.
 * - After `K` a root may already be dead, and with it whatever pinned its PID.
 *   A root the census identified goes again pinned to that identity, so a
 *   reused PID is left alone. One the census saw gone, reused or refused is
 *   settled from the plan. One the census could not identify is retried only
 *   if it was left untouched or carries an identity of its own.
 * - A report that may be missing lines (the pipe never closed) may have lost
 *   its `K`: only roots with an identity of their own go again.
 *
 * A root retried after kills may have begun also loses `ownChild`: if it was
 * ended, its owner's handle no longer pins the PID, so a failed census must
 * not end it by PID.
 */
export function planTreeKillRecovery(
  targets: readonly NormalizedTreeKillTarget[],
  partial: string,
  complete: boolean,
  reason: string
): TreeKillRecoveryPlan {
  const announced = parseTreeKillPlan(partial);
  const rerun: TreeKillRecoveryPlan["rerun"] = [];
  const settled = new Map<number, WindowsTreeKillResult>();
  const notRetried = (index: number, target: NormalizedTreeKillTarget, mayHaveEnded: boolean) => {
    const error = `${reason}; not retried: its PID may no longer be its own`;
    settled.set(
      index,
      mayHaveEnded
        ? { ...emptyResult("root-only"), targeted: [target.pid], unconfirmed: [target.pid], error }
        : { ...emptyResult("untouched"), error }
    );
  };

  targets.forEach((target, index) => {
    const identified = target.start !== undefined;
    if (!announced) {
      if (complete) rerun.push({ index, target });
      else if (identified) rerun.push({ index, target: { ...target, own: false } });
      else notRetried(index, target, false);
      return;
    }
    const root = announced.get(index);
    switch (root?.mode) {
      case "gone":
        settled.set(index, { ...emptyResult("gone"), rootEnded: true });
        return;
      case "mismatch":
        settled.set(index, {
          ...emptyResult("identity-mismatch"),
          rootEnded: true,
          ...(root.rootStart !== undefined ? { rootStartTime: root.rootStart } : {}),
        });
        return;
      case "refused":
        settled.set(index, emptyResult("skipped"));
        return;
      case "untouched":
        rerun.push({ index, target });
        return;
      case "tree":
        if (root.rootStart !== undefined) {
          rerun.push({ index, target: { ...target, start: root.rootStart, own: false } });
          return;
        }
        break;
    }
    if (identified) rerun.push({ index, target: { ...target, own: false } });
    else notRetried(index, target, root?.mode === "root-only");
  });
  return { rerun, settled };
}

async function recoverTreeKillRun(
  targets: readonly NormalizedTreeKillTarget[],
  partial: string,
  complete: boolean,
  budget: TreeKillBudget,
  reason: string
): Promise<WindowsTreeKillResult[]> {
  const { rerun, settled } = planTreeKillRecovery(targets, partial, complete, reason);
  const results = targets.map((_target, index) => settled.get(index));
  if (rerun.length > 0) {
    const again = await runHelper(
      rerun.map((entry) => entry.target),
      budget.timeoutMs,
      budget.waitMs
    );
    rerun.forEach((entry, j) => (results[entry.index] = again[j]));
  }
  return results.map((result) => result ?? { ...emptyResult("untouched"), error: reason });
}

const TREE_KILL_ENGINE: TreeKillEngine = {
  serverArgs: SERVER_ARGS,
  encodeInput: encodeTreeKillInput,
  readReport(targets, report) {
    const parsed = parseTreeKillOutput(report);
    if (!parsed) return null;
    const results = classifyTreeKillOutput(targets, parsed);
    warnStale(targets, results);
    return results;
  },
  recover: recoverTreeKillRun,
  screen: screenTreeKillTarget,
};

/** This process's persistent helper, created by the first asynchronous kill. */
let sharedService: WindowsTreeKillService | null = null;

function treeKillService(): WindowsTreeKillService {
  sharedService ??= new WindowsTreeKillService({ engine: TREE_KILL_ENGINE });
  return sharedService;
}

/** Whether this process's persistent helper is running (warm, or still starting). */
export function isWindowsTreeKillHelperRunning(): boolean {
  return sharedService?.isRunning === true;
}

/**
 * Keep this process's persistent helper running while `warm` is true —
 * starting it now if it is not — instead of retiring it when idle. The
 * pty-host holds it warm while any terminal is open, because a close or a
 * quit is always the next request and a cold PowerShell start is most of a
 * kill. No-op off Windows.
 */
export function keepWindowsTreeKillHelperWarm(warm: boolean): void {
  if (process.platform !== "win32") return;
  if (!warm && !sharedService) return;
  treeKillService().setKeepWarm(warm);
}

/**
 * Stop this process's persistent helper. A run it was serving, and any kill
 * made afterwards, is finished by the one-shot helper.
 */
export function disposeWindowsTreeKillService(): void {
  sharedService?.dispose();
  sharedService = null;
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

/** A blocking run starts now: drop what {@link screenTreeKillTarget} says must not be sent. */
function screenNow(planned: Plan): void {
  planned.live = planned.live.filter((index) => {
    const screened = screenTreeKillTarget(planned.normalized[index]);
    if (screened) planned.results[index] = screened;
    return screened === null;
  });
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
 * loop until done — a cold PowerShell start, so seconds. Only for paths where
 * nothing can run afterwards and no persistent helper is warm: the host's exit
 * teardown and `process.on("exit")`. Everything else uses
 * {@link killWindowsProcessTrees}. Results are in input order.
 */
export function killWindowsProcessTreesSync(
  targets: readonly (number | WindowsTreeKillTarget)[],
  options: WindowsTreeKillOptions = {}
): WindowsTreeKillResult[] {
  const planned = plan(targets);
  screenNow(planned);
  if (planned.live.length === 0) return planned.results;
  const { timeoutMs, waitMs } = budgets(options);
  const helperTargets = planned.live.map((i) => planned.normalized[i]);
  return merge(planned, runHelperSync(helperTargets, timeoutMs, waitMs));
}

/**
 * {@link killWindowsProcessTreesSync} without blocking: resolves once every
 * terminated process has exited or the wait budget has run out, so a caller
 * that awaits it may rely on the result's `killed`/`timedOut` split.
 *
 * Runs on this process's persistent helper, together with every other kill
 * requested around the same time; the budget counts from when the run
 * starts, so a request queued behind a run in flight waits for that first.
 */
export async function killWindowsProcessTrees(
  targets: readonly (number | WindowsTreeKillTarget)[],
  options: WindowsTreeKillOptions = {}
): Promise<WindowsTreeKillResult[]> {
  const planned = plan(targets);
  if (planned.live.length === 0) return planned.results;
  const helperTargets = planned.live.map((i) => planned.normalized[i]);
  return merge(
    planned,
    await treeKillService().kill(helperTargets, budgets(options), options.onStart)
  );
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
 * descendants anyway. The target carries the child itself, so a kill that
 * waits in the queue re-reads that when its run starts.
 */
export function liveChildTreeTarget(
  child: OwnedChildProcess & { pid?: number | undefined }
): WindowsTreeKillTarget | null {
  if (typeof child.pid !== "number") return null;
  if (!childStillRunning(child)) return null;
  return { pid: child.pid, ownChild: child };
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
