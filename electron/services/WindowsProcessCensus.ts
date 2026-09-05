import { spawn, type ChildProcess } from "child_process";
import { logDebug } from "../utils/logger.js";

/**
 * The `Win32_Process` projection the census reads, as a PowerShell pipeline.
 *
 * Exported so the query is written once: the persistent helper embeds it in its
 * request loop, and PERF-409's baseline arm runs the identical pipeline through
 * a one-shot `powershell.exe` — so its before/after compares two TRANSPORTS and
 * not two differently shaped queries.
 *
 * NOTE: regular string concatenation, never template literals — JS would
 * interpolate PowerShell's `$_` pipeline variable.
 *
 * `KernelModeTime`/`UserModeTime` are cast to [string] to preserve UInt64
 * precision through JSON. `CreationDate` uses .ToString('o') for consistent
 * ISO 8601 across PS 5.1 and PS 7. `ExecutablePath` rides along because it is
 * already a `Win32_Process` property: fetching it here is what lets
 * `ImagePathProbe` stop starting its own PowerShell per PID (#12243).
 */
export const CENSUS_PIPELINE =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath," +
  "@{N='KernelModeTime';E={[string]$_.KernelModeTime}}," +
  "@{N='UserModeTime';E={[string]$_.UserModeTime}}," +
  "@{N='WorkingSetSize';E={[string]$_.WorkingSetSize}}," +
  "@{N='CreationDate';E={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }}} | " +
  "ConvertTo-Json -Compress";

/**
 * Line that terminates one response, suffixed with the id of the request it
 * answers. Correlating it means a late frame from a helper we already gave up
 * on cannot be read as the answer to the request that replaced it.
 */
export const CENSUS_SENTINEL_PREFIX = "__DAINTREE_CENSUS_END__:";

/**
 * The stdin/stdout loop the helper runs.
 *
 * `powershell.exe -Command -` is NOT a REPL — PS 5.1 reads stdin to EOF and
 * only then executes — so the loop has to be explicit. `[Console]::In.ReadLine()`
 * returns null on EOF, which is how closing our end of stdin retires the helper
 * without a signal.
 *
 * Every stream preference is silenced at startup rather than per request: this
 * process's stdout IS the protocol, and a stray warning or progress record on it
 * is a desynchronised frame, not cosmetic noise. Same reasoning for the encoding
 * bootstrap — PS 5.1 pipes stdout in the OEM codepage unless told otherwise, and
 * the UTF8Encoding must be BOM-less or every frame after the first carries a BOM
 * that breaks JSON.parse (#7955).
 */
const HELPER_SCRIPT =
  "$ErrorActionPreference = 'SilentlyContinue'; " +
  "$ProgressPreference = 'SilentlyContinue'; " +
  "$WarningPreference = 'SilentlyContinue'; " +
  "$InformationPreference = 'SilentlyContinue'; " +
  "$VerbosePreference = 'SilentlyContinue'; " +
  "$DebugPreference = 'SilentlyContinue'; " +
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "while ($true) { " +
  "$req = [Console]::In.ReadLine(); " +
  "if ($null -eq $req) { break } " +
  "if ($req.Length -eq 0) { continue } " +
  "$payload = " +
  CENSUS_PIPELINE +
  "; " +
  "if ($null -eq $payload) { $payload = '[]' } " +
  "[Console]::Out.WriteLine($payload); " +
  "[Console]::Out.WriteLine('" +
  CENSUS_SENTINEL_PREFIX +
  "' + $req); " +
  "[Console]::Out.Flush() " +
  "}";

/** Matches the one-shot path's old `timeout`, so a wedged CIM call is bounded the same way. */
export const CENSUS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Runaway guard on one response, deliberately looser than the one-shot path's
 * 10MB `maxBuffer`: that was a per-call allocation cap, this is a protocol
 * limit on a stream that should never grow past a single JSON line.
 */
const MAX_RESPONSE_CHARS = 32 * 1024 * 1024;

/**
 * Consecutive failures tolerated before launches are suppressed.
 *
 * The first two recover at the next scheduled poll — a helper that crashed once
 * should cost one census, not a cooldown. Only a repeating failure (PowerShell
 * missing, CIM broken, a machine policy we cannot see) earns the throttle, and
 * the throttle exists so that failure costs no process starts at all.
 */
export const CENSUS_FAILURES_BEFORE_COOLDOWN = 3;
export const CENSUS_COOLDOWN_BASE_MS = 15_000;
export const CENSUS_COOLDOWN_CEILING_MS = 60_000;

interface PendingRequest {
  id: number;
  resolve: (payload: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One long-lived `powershell.exe` serving the Windows process census.
 *
 * Before #12243 every poll started a fresh PowerShell: a process start plus
 * .NET runtime warm-up plus the WMI enumeration, on a 1.5s-15s cadence for the
 * life of the app. Only the enumeration is inherent. This keeps one process
 * warm and writes it a request line per census instead.
 *
 * Owned solely by `ProcessTreeCache`; not a singleton and not wired into any
 * other consumer. Construction does NOT spawn — the first demanded census does.
 *
 * There is deliberately no one-shot fallback. A permanent one silently
 * reinstates the very cost this removes, and the failures that stop a
 * persistent helper (no PowerShell, restricted policy, broken CIM) stop a
 * one-shot the same way. Recovery is by cooldown-and-retry instead, so a
 * transient fault costs one census and a persistent one costs no starts.
 */
export class WindowsProcessCensus {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private pending: PendingRequest | null = null;
  private nextRequestId = 1;
  private consecutiveFailures = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  /** PID of the live helper, or null while none is running. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Whether a helper process is currently running. */
  get isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Ask the helper for one census, starting it if necessary.
   *
   * Resolves with the raw JSON line. One request may be outstanding at a time —
   * `ProcessTreeCache.refresh()` already serialises polls behind `isRefreshing`.
   */
  async request(): Promise<string> {
    if (this.disposed) {
      throw new Error("Windows census helper has been disposed");
    }
    if (this.pending) {
      throw new Error("Windows census helper is already serving a request");
    }

    if (this.cooldownTimer !== null) {
      // Deliberately a stable message with no remaining-time in it. The cache
      // deduplicates its probe-failure log by exact message, and the cache
      // retries at its BASE interval while this is throwing — a countdown in
      // the text would put roughly forty distinct lines a minute in the log
      // for one standing fault.
      throw new Error("Windows census helper is cooling down after consecutive failures");
    }

    let child: ChildProcess;
    try {
      child = this.child ?? this.launch();
    } catch (error) {
      // A synchronous spawn throw (ENOENT for powershell.exe on a stripped
      // image) is a failure of the same kind as a crash, and has to advance the
      // same ladder or a machine without PowerShell retries forever.
      this.noteFailure();
      throw error instanceof Error ? error : new Error(String(error));
    }

    const id = this.nextRequestId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(`Windows census request timed out after ${CENSUS_REQUEST_TIMEOUT_MS}ms`)
        );
      }, CENSUS_REQUEST_TIMEOUT_MS);

      // Registered BEFORE the write: a test double — and a real helper whose
      // answer is already buffered — can emit the response synchronously from
      // inside `write()`, and a response with no pending request is treated as
      // a protocol violation.
      this.pending = { id, resolve, reject, timer };

      try {
        child.stdin?.write(`${id}\n`);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Retire the helper if nothing is in flight. Returns whether a process was
   * actually stopped, so the caller can log only when it happened.
   */
  retireIfIdle(): boolean {
    if (this.pending || !this.child) return false;
    this.retire();
    return true;
  }

  /**
   * Tear down permanently. After this every request rejects and no helper is
   * started again.
   */
  dispose(): void {
    this.disposed = true;
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Windows census helper was disposed"));
    }
    this.retire();
  }

  private launch(): ChildProcess {
    // spawn, not execFile: the point is a process that outlives the call.
    // windowsHide keeps the console off screen, and the argv form means the
    // script needs no shell-level quoting — same reasoning as #12042, applied
    // to a process that is now started once instead of once per poll.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", HELPER_SCRIPT],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }
    );

    this.child = child;
    this.stdoutBuffer = "";

    child.stdout?.setEncoding("utf8");
    // Guarded on identity rather than detached at retirement: see retire().
    child.stdout?.on("data", (chunk: string) => {
      if (this.child === child) this.consume(chunk);
    });

    // Drained and dropped. The helper's stderr is not part of the protocol, and
    // an undrained pipe would eventually block the child.
    child.stderr?.resume();

    // EPIPE on a stdin whose reader has already died arrives as an event, not a
    // throw from `write()`. Unhandled it takes down the pty-host.
    child.stdin?.on("error", () => {});

    child.on("error", (error) => {
      if (this.child !== child) return;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.fail(
        new Error(`Windows census helper exited (code=${String(code)} signal=${String(signal)})`)
      );
    });

    logDebug(`[WindowsProcessCensus] Helper started (pid=${String(child.pid)})`);
    return child;
  }

  private consume(chunk: string): void {
    const pending = this.pending;
    if (!pending) {
      // Output with nothing outstanding means a duplicated response or a helper
      // writing on its own schedule. Either way the stream is desynchronised
      // and the next frame could not be trusted, so retire rather than buffer.
      this.retire();
      return;
    }

    const previousLength = this.stdoutBuffer.length;
    this.stdoutBuffer += chunk;

    if (this.stdoutBuffer.length > MAX_RESPONSE_CHARS) {
      this.fail(new Error(`Windows census response exceeded ${MAX_RESPONSE_CHARS} characters`));
      return;
    }

    const marker = `${CENSUS_SENTINEL_PREFIX}${pending.id}`;
    // Only the newly arrived region can complete the sentinel, minus an overlap
    // for a marker (or its CRLF terminator) split across two chunks. Rescanning
    // the whole buffer per chunk would be quadratic over a multi-MB payload.
    const from = Math.max(0, previousLength - marker.length - 2);
    let sentinelAt = -1;
    let at = this.stdoutBuffer.indexOf(marker, from);
    while (at !== -1) {
      if (at === 0 || this.stdoutBuffer[at - 1] === "\n") {
        // The sentinel is a whole LINE, and the frame is not complete until its
        // terminator has arrived. Both halves matter:
        //
        //  - matching the id as a PREFIX would let request 1 accept the answer
        //    to request 10;
        //  - resolving before the line ending would leave the trailing CRLF to
        //    arrive with nothing outstanding, which reads as a protocol
        //    violation and retires a perfectly healthy helper — restoring one
        //    PowerShell start per poll, and never earning a cooldown because
        //    every request "succeeded".
        const end = at + marker.length;
        const after = this.stdoutBuffer[end];
        if (after === undefined) return;
        if (after === "\n") {
          sentinelAt = at;
          break;
        }
        if (after === "\r") {
          const next = this.stdoutBuffer[end + 1];
          if (next === undefined) return;
          if (next === "\n") {
            sentinelAt = at;
            break;
          }
        }
      }
      // Not a sentinel line: a process command line inside the payload can
      // carry the literal, and that must not terminate the frame.
      at = this.stdoutBuffer.indexOf(marker, at + 1);
    }
    if (sentinelAt === -1) return;

    const frame = this.stdoutBuffer.slice(0, sentinelAt);
    // The sentinel line terminates the response, its terminator included:
    // anything after it was not asked for. Clearing is also what keeps #10410
    // off this path — the accumulated buffer is the only string here the
    // instance RETAINS, so it is the only one whose slices could pin a multi-MB
    // parent. On a SUCCESSFUL parse the payload below is handed straight to
    // JSON.parse and dropped, so it needs no flat copy; a parse failure is a
    // different story, but there the caller's SyntaxError is what carries the
    // source, and a flat copy here would not change that.
    this.stdoutBuffer = "";

    let payload: string | null = null;
    let lineCount = 0;
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (!line) continue;
      lineCount += 1;
      payload = line;
    }

    if (lineCount !== 1 || payload === null) {
      this.fail(
        new Error(
          `Windows census response carried ${lineCount} lines before its sentinel, expected 1`
        )
      );
      return;
    }

    this.pending = null;
    clearTimeout(pending.timer);
    this.consecutiveFailures = 0;
    pending.resolve(payload);
  }

  /**
   * Settle a failure: retire the helper, advance the restart ladder, reject the
   * caller. Reached from crash, spawn error, request timeout and protocol
   * violation alike, so no path can advance the ladder while another skips it.
   */
  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    this.retire();
    if (!pending) {
      // The helper died with nothing outstanding — the next demanded census
      // just starts a new one. Nothing failed, so nothing is charged.
      return;
    }
    clearTimeout(pending.timer);
    this.noteFailure();
    pending.reject(error);
  }

  private noteFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < CENSUS_FAILURES_BEFORE_COOLDOWN) return;
    const steps = this.consecutiveFailures - CENSUS_FAILURES_BEFORE_COOLDOWN;
    const delayMs = Math.min(CENSUS_COOLDOWN_BASE_MS * 2 ** steps, CENSUS_COOLDOWN_CEILING_MS);
    // A timer rather than a `Date.now()` deadline: the cooldown is an elapsed
    // duration, and a wall clock that steps backwards — an NTP correction, a
    // laptop waking in another timezone — would otherwise strand the census for
    // however far back it stepped.
    if (this.cooldownTimer !== null) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
    }, delayMs);
    // Nothing should stay alive just to end a cooldown: the cache owns a
    // referenced poll timer whenever a census is actually wanted, and this one
    // outliving it would only delay the host's exit.
    this.cooldownTimer.unref?.();
  }

  /**
   * Stop the current helper. Idempotent, and safe to call from an `exit`
   * handler for the process it is stopping.
   *
   * Closing stdin is the graceful path — `ReadLine()` returns null and the loop
   * breaks — but the kill follows immediately rather than after a grace period:
   * the pty-host's parent force-kills the host one second after asking it to
   * shut down, so teardown here cannot wait on the child noticing. The helper
   * starts no children of its own, so plain `kill()` leaves nothing behind.
   *
   * Every listener stays attached. `this.child` is nulled first and all of them
   * are guarded on it, so they are already inert — and detaching them would
   * drop the stdin `error` handler a beat before `end()`/`kill()`, which is
   * exactly when an EPIPE surfaces. An unhandled `error` on a stream reaches
   * the pty-host's `uncaughtException` handler, which exits the host: a routine
   * teardown race would take every terminal with it.
   */
  private retire(): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    if (!child) return;

    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}
