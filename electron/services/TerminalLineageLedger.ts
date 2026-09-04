// eager-import-allow: reads/writes the lineage ledger via sync fs
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

const LEDGER_VERSION = 1;
const LEDGER_FILE_PREFIX = "pty-lineage";
const REAPING_SUFFIX = ".reaping";
const PROBE_TIMEOUT_MS = 3000;
/**
 * Total wall-clock budget for one synchronous verification pass. Teardown runs
 * on the pty-host's only thread — and the `immediate` path runs inside
 * `process.on("exit")`, which Main force-kills after ~1s — so an unresponsive
 * `ps` must not be able to stall it for chunks x PROBE_TIMEOUT_MS. PIDs left
 * unverified when the budget runs out are simply not signalled.
 */
const SYNC_PROBE_BUDGET_MS = 2000;
/** Largest `-p` list handed to a single `ps`. Keeps us far under ARG_MAX. */
const PROBE_CHUNK_SIZE = 500;
/**
 * Ceiling on tracked PIDs across all roots in one host. A runaway build can
 * fork thousands of short-lived processes; the ledger keeps every one it has
 * seen until the OS reports it gone, so the set needs a hard bound. At the cap
 * we stop admitting new PIDs rather than evicting known ones — an evicted PID
 * is a leak we can no longer reach, which is the bug this file exists to fix.
 */
const MAX_TRACKED_PIDS = 4096;
/**
 * Boot-time tolerance for the persisted anchor, in seconds. `os.uptime()` is
 * derived from `kern.boottime` / `/proc/uptime`, so the computed boot epoch is
 * stable to within a second or two across reads. A reboot always shifts it by
 * far more than this, so the check reliably discards ledgers whose PIDs belong
 * to a previous boot's numbering.
 */
const BOOT_EPOCH_TOLERANCE_SEC = 120;
/** Grace period between the reaper's SIGTERM and its SIGKILL escalation. */
const REAP_ESCALATION_DELAY_MS = 500;
/**
 * How many launches may fail to resolve a persisted ledger before it is
 * discarded. A blocked or missing `ps` makes "already gone" and "cannot tell"
 * look identical, and deleting on the first ambiguous read would throw away the
 * only record of a survivor. Retrying forever would leak a file just as surely,
 * so the ambiguity gets a bounded number of chances.
 */
const MAX_REAP_ATTEMPTS = 3;

/**
 * Pinned so the recorded identity string is reproducible. `lstart` renders
 * through `localtime()` with locale-dependent month and day names, and the
 * persisted ledger compares those strings across app launches — an unpinned
 * locale or a timezone change would silently invalidate every entry.
 */
const PROBE_ENV = {
  ...process.env,
  LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
  TZ: "UTC",
};

/**
 * The subset of {@link ProcessTreeCache} the ledger reads. Declared structurally
 * so this module never imports the cache (and the cache never imports the
 * ledger) — the two are wired together in pty-host.ts.
 */
export interface LineageCensus {
  getProcess(pid: number): { pid: number; ppid: number; startTime?: string } | undefined;
  getDescendantPids(rootPid: number): number[];
}

interface TrackedPid {
  /**
   * OS-reported process start time, the pid-reuse guard. `null` until the
   * identity probe lands. An unidentified PID is never signalled — we cannot
   * prove it is still the process we observed.
   */
  startTime: string | null;
  /**
   * When the census that established this PID's ancestry was folded in. A
   * process whose start time is *newer* than this cannot be the descendant we
   * saw, so it is dropped rather than anchored.
   */
  observedAtMs: number;
  /** True when the last census showed this PID outside the root's live tree. */
  orphaned: boolean;
}

interface RootEntry {
  /**
   * `active` roots discover new descendants each sweep. `closing` roots have
   * had their terminal torn down: we stop discovering from the root, so a
   * recycled root PID can never adopt a dead terminal's lineage.
   */
  state: "active" | "closing";
  pids: Map<number, TrackedPid>;
  /**
   * The root's parent PID as first seen by the census. A root is only keyed by
   * PID, and a PID outlives the process holding it — if this changes, the
   * number has been handed to something that is not our shell, and the root
   * must stop discovering before it adopts a stranger's process tree.
   */
  rootPpid: number | null;
}

export interface PersistedLineageEntry {
  pid: number;
  startTime: string;
  rootPid: number;
}

interface PersistedLineageFile {
  version: number;
  bootEpochSec: number;
  owner: string;
  updatedAt: number;
  entries: PersistedLineageEntry[];
  /** Launches that read this file but could not resolve its PIDs. */
  attempts?: number;
}

/** A probe result plus whether any chunk failed outright. */
interface ProbeResult {
  startTimes: Map<number, string>;
  /** True when a chunk produced no usable output because of an error. */
  failed: boolean;
}

/**
 * Seconds since the epoch at which this machine booted. Used as the persisted
 * ledger's validity anchor: PID numbering restarts at boot, so entries written
 * before a reboot address processes that no longer exist under those numbers.
 */
export function currentBootEpochSec(): number {
  return Math.round(Date.now() / 1000 - os.uptime());
}

function sanitizeShardSuffix(service: string | undefined): string {
  if (!service || service === "daintree-pty-host") return "";
  return service.replace(/^daintree-pty-host:?/, "").replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * Ledger file for one pty-host shard. Each shard is its own process with its
 * own terminals, and the write is a whole-file replace, so shards must not
 * share a path — mirrors the per-shard split in `pty-host/emergencyLog.ts`.
 */
export function lineageFilePath(userDataPath: string, shardService?: string): string {
  const suffix = sanitizeShardSuffix(shardService);
  const name = suffix ? `${LEDGER_FILE_PREFIX}-${suffix}.json` : `${LEDGER_FILE_PREFIX}.json`;
  return path.join(userDataPath, name);
}

function parsePsStartTimes(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // Regex captures are V8 sliced strings pinning the whole ps stdout for as
    // long as the ledger retains them, and ledger entries outlive many sweeps.
    // Buffer.from() is the only idiom that forces a flat copy (lesson #10410).
    out.set(pid, Buffer.from(match[2]).toString());
  }
  return out;
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function chunk(pids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < pids.length; i += size) {
    chunks.push(pids.slice(i, i + size));
  }
  return chunks;
}

function windowsStartTimeScript(pids: number[]): string {
  const filter = pids.map((p) => `ProcessId=${p}`).join(" or ");
  return (
    "$ErrorActionPreference = 'SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    "ForEach-Object { if ($_.CreationDate) { \"$($_.ProcessId) $($_.CreationDate.ToString('o'))\" } }"
  );
}

/**
 * Batched process start-time lookup, reporting whether the probe itself failed.
 *
 * "No entry for this PID" and "the probe could not run" are different facts:
 * the first means the process is gone, the second means we know nothing. Only
 * the first may be treated as permission to forget a tracked descendant.
 *
 * One subprocess per chunk rather than one per PID — a busy agent terminal can
 * produce dozens of new descendants per sweep, and a spawn each would cost more
 * than the census itself.
 */
async function probeStartTimesDetailed(pids: number[]): Promise<ProbeResult> {
  const startTimes = new Map<number, string>();
  let failed = false;
  if (pids.length === 0) return { startTimes, failed };

  for (const group of chunk(pids, PROBE_CHUNK_SIZE)) {
    try {
      const { stdout } =
        process.platform === "win32"
          ? await execFileAsync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-NoLogo",
                "-Command",
                windowsStartTimeScript(group),
              ],
              {
                windowsHide: true,
                encoding: "utf8",
                shell: false,
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
              }
            )
          : await execFileAsync("ps", ["-o", "pid=,lstart=", "-p", group.join(",")], {
              encoding: "utf8",
              shell: false,
              env: PROBE_ENV,
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
      for (const [pid, startTime] of parsePsStartTimes(stripBom(stdout))) {
        startTimes.set(pid, startTime);
      }
    } catch (err) {
      // `ps` exits non-zero when every requested PID is gone, and the error
      // still carries stdout for any that survived — that is a successful probe
      // with a short answer, not a failure.
      const stdout = (err as { stdout?: string })?.stdout;
      if (typeof stdout === "string" && stdout.length > 0) {
        for (const [pid, startTime] of parsePsStartTimes(stripBom(stdout))) {
          startTimes.set(pid, startTime);
        }
        continue;
      }
      failed = true;
    }
  }

  return { startTimes, failed };
}

/** {@link probeStartTimesDetailed} without the failure flag. */
export async function probeStartTimes(pids: number[]): Promise<Map<number, string>> {
  return (await probeStartTimesDetailed(pids)).startTimes;
}

/**
 * Synchronous counterpart of {@link probeStartTimes}. Required at kill time:
 * `ProcessTreeKiller.execute()` runs synchronously, and its `immediate` path
 * runs inside `process.on("exit")` where no async work can complete.
 *
 * Bounded by {@link SYNC_PROBE_BUDGET_MS} in total, not per chunk. PIDs in a
 * chunk that is never reached stay unverified, and unverified means unsignalled.
 */
export function probeStartTimesSync(
  pids: number[],
  budgetMs: number = SYNC_PROBE_BUDGET_MS
): Map<number, string> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  const deadline = Date.now() + budgetMs;

  for (const group of chunk(pids, PROBE_CHUNK_SIZE)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const timeout = Math.min(PROBE_TIMEOUT_MS, remaining);
      const spawned =
        process.platform === "win32"
          ? spawnSync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-NoLogo",
                "-Command",
                windowsStartTimeScript(group),
              ],
              { windowsHide: true, encoding: "utf8", timeout }
            )
          : spawnSync("ps", ["-o", "pid=,lstart=", "-p", group.join(",")], {
              encoding: "utf8",
              env: PROBE_ENV,
              timeout,
            });
      const stdout = typeof spawned?.stdout === "string" ? spawned.stdout : "";
      if (!stdout) continue;
      for (const [pid, startTime] of parsePsStartTimes(stripBom(stdout))) {
        result.set(pid, startTime);
      }
    } catch {
      // Fail closed — unidentified PIDs are not signalled.
    }
  }

  return result;
}

/**
 * True when a process with this start time could be the descendant observed at
 * `observedAtMs`. A process born *after* we saw the ancestry is a different
 * process that inherited the PID, so anchoring to it would make the ledger
 * "verify" a stranger for the rest of the terminal's life.
 *
 * Unparseable start times (an unexpected `ps` format, despite {@link PROBE_ENV})
 * skip the check rather than disabling tracking outright — kill-time
 * re-verification still applies.
 */
function couldPredateObservation(startTime: string, observedAtMs: number): boolean {
  // PROBE_ENV pins TZ=UTC, so the zoneless `lstart` string denotes UTC. The
  // Windows form is already a zoned ISO timestamp, which the suffix would
  // break — fall back to parsing it as-is. (The guard is only load-bearing on
  // POSIX anyway: the Windows census carries ppid and CreationDate in the same
  // row, so there is no window between observing ancestry and learning
  // identity.)
  let parsed = Date.parse(`${startTime} UTC`);
  if (Number.isNaN(parsed)) parsed = Date.parse(startTime);
  if (Number.isNaN(parsed)) return true;
  // `lstart` has one-second granularity; allow a second of slack.
  return parsed <= observedAtMs + 1000;
}

/**
 * Records every descendant ever observed under a PTY shell, so teardown can
 * still reach the ones that have since reparented to PID 1.
 *
 * Every existing cleanup tier walks *down* from a live root at the moment of
 * teardown, which structurally cannot see a process that detached earlier
 * (#12203: 64 `zsh` loops left pinning 13 cores for three days). The ledger
 * inverts that: while a descendant is still reachable by the periodic census
 * it is written down, and it stays written down after its parent dies and the
 * OS reparents it away.
 *
 * Three invariants keep the wider kill set safe:
 *
 * - **Every entry is anchored to a start time taken no later than the census
 *   that established its ancestry.** A PID with no recorded start time, or
 *   whose start time differs at kill time, is never signalled — it is a
 *   different process now, not the one we observed (lesson #10950).
 * - **`closing` roots stop discovering.** Once a terminal is torn down its root
 *   PID can be recycled, so a recycled root must not be able to adopt the dead
 *   terminal's lineage. A root whose PID vanishes closes automatically.
 * - **Ambiguity never authorises a kill.** A probe that could not run is not
 *   evidence that a process is gone, and is never treated as such.
 *
 * This is a mitigation, not a containment primitive: a descendant that forks,
 * detaches, and is never sampled by the census is invisible to it. macOS offers
 * no public process-lifecycle event stream that would close that window
 * (`EVFILT_PROC` + `NOTE_TRACK` is `ENOTSUP`; EndpointSecurity is entitled), so
 * the sampling interval bounds — but does not eliminate — the miss.
 */
export class TerminalLineageLedger {
  private roots = new Map<number, RootEntry>();
  private trackedCount = 0;
  private loggedCapWarning = false;
  private pendingIdentification = new Set<number>();
  private identifyInFlight = false;
  private lastPersistedJson: string | null = null;
  private disposed = false;

  constructor(
    private readonly filePath: string | null,
    private readonly owner: string = "daintree-pty-host"
  ) {}

  /** Begin tracking a PTY shell's lineage. Called when its killer is built. */
  registerRoot(rootPid: number): void {
    if (this.disposed || !Number.isInteger(rootPid) || rootPid <= 1) return;
    if (this.roots.has(rootPid)) {
      // A recycled root PID must start from an empty lineage, never inherit the
      // previous terminal's descendants.
      this.dropRoot(rootPid);
    }
    this.roots.set(rootPid, { state: "active", pids: new Map(), rootPpid: null });
  }

  /**
   * Stop discovering new descendants for a root while keeping what we already
   * know. Called at teardown so the 500ms SIGKILL escalation and the persisted
   * ledger still see the survivors.
   */
  markRootClosing(rootPid: number): void {
    const entry = this.roots.get(rootPid);
    if (entry) entry.state = "closing";
  }

  /** Forget a root entirely. */
  unregisterRoot(rootPid: number): void {
    this.dropRoot(rootPid);
  }

  hasRoots(): boolean {
    return this.roots.size > 0;
  }

  /** Total tracked PIDs across every root. Exposed for tests and diagnostics. */
  getTrackedCount(): number {
    return this.trackedCount;
  }

  /**
   * Identified descendants of a root, with the root itself excluded. Entries
   * carry the start time recorded when they were first observed; callers that
   * intend to signal must go through {@link getVerifiedOrphanPids}.
   */
  getTrackedPids(rootPid: number): Array<{ pid: number; startTime: string }> {
    const entry = this.roots.get(rootPid);
    if (!entry) return [];
    const out: Array<{ pid: number; startTime: string }> = [];
    for (const [pid, tracked] of entry.pids) {
      if (pid === rootPid || !tracked.startTime) continue;
      out.push({ pid, startTime: tracked.startTime });
    }
    return out;
  }

  /**
   * Tracked descendants the caller's live walk can no longer reach, filtered to
   * the ones the OS still reports with the exact start time we recorded.
   *
   * This is the safety boundary for the widened kill set, and it is the *only*
   * set callers may signal. Ledger entries are by construction old — that is
   * what lets them outlive reparenting — so a PID being present proves nothing;
   * only a matching start time proves it is still the process we observed
   * (lesson #10950). Verification is a live OS query on every platform, never a
   * cached census read: the census can be seconds stale, which is exactly long
   * enough for a PID to have been recycled.
   */
  getVerifiedOrphanPids(rootPid: number, alreadyCovered: readonly number[]): number[] {
    const covered = new Set(alreadyCovered);
    const candidates = this.getTrackedPids(rootPid).filter((c) => !covered.has(c.pid));
    if (candidates.length === 0) return [];

    const current = probeStartTimesSync(candidates.map((c) => c.pid));
    return candidates.filter((c) => current.get(c.pid) === c.startTime).map((c) => c.pid);
  }

  /**
   * Fold one process census into the ledger: admit newly seen descendants,
   * drop the ones the OS says are gone, and refresh orphan flags.
   *
   * Runs synchronously inside the cache's refresh so the ledger is current
   * before any subscriber reads it. Start-time identification for new PIDs is
   * kicked off asynchronously and lands on a later sweep; until it does, those
   * PIDs are tracked but not signallable.
   */
  reconcile(census: LineageCensus): void {
    if (this.disposed || this.roots.size === 0) return;

    for (const [rootPid, entry] of this.roots) {
      // A root that is gone — or whose PID now belongs to something else — can
      // never legitimately gain descendants again, and leaving it `active`
      // would let it adopt an unrelated process tree. Covers the terminal whose
      // construction failed after its killer registered, which reaches no
      // teardown path that would close it.
      if (entry.state === "active") {
        const rootProc = census.getProcess(rootPid);
        if (!rootProc) {
          entry.state = "closing";
        } else if (entry.rootPpid === null) {
          entry.rootPpid = rootProc.ppid;
        } else if (entry.rootPpid !== rootProc.ppid) {
          entry.state = "closing";
        }
      }

      // Prune first so the orphan flags below are current for *this* sweep.
      // Flagging after discovery would delay a freshly detached member's own
      // children by a full sweep.
      this.prune(entry, census);
      this.flagOrphans(entry, rootPid, census);

      if (entry.state === "active") {
        for (const pid of census.getDescendantPids(rootPid)) {
          this.admit(entry, pid);
        }
      }

      // Descendants a detached member spawned after it left our tree are still
      // this terminal's work — a wrapper that reparents and then forks a build
      // would otherwise leave that build unreachable. Only *identified* orphans
      // may adopt: an unidentified PID has no proof it is still ours, so it
      // must not be able to pull an unrelated subtree into the ledger. Only
      // orphans need their own walk at all — anything still attached is already
      // covered by the root walk, and walking every tracked PID would be
      // quadratic on a deep tree.
      for (const [pid, tracked] of [...entry.pids]) {
        if (!tracked.orphaned || !tracked.startTime) continue;
        for (const child of census.getDescendantPids(pid)) {
          this.admit(entry, child);
        }
      }

      // Second pass so anything just admitted is flagged (and so persisted)
      // without waiting for the next sweep.
      this.flagOrphans(entry, rootPid, census);
    }

    for (const [rootPid, entry] of [...this.roots]) {
      if (entry.state === "closing" && entry.pids.size === 0) {
        this.roots.delete(rootPid);
      }
    }

    this.scheduleIdentification();
    this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.roots.clear();
    this.pendingIdentification.clear();
    this.trackedCount = 0;
  }

  /** Drop entries the OS says are gone, or that a recycled PID now holds. */
  private prune(entry: RootEntry, census: LineageCensus): void {
    for (const [pid, tracked] of [...entry.pids]) {
      const proc = census.getProcess(pid);
      if (!proc) {
        entry.pids.delete(pid);
        this.trackedCount--;
        continue;
      }
      // Windows carries a start time in the census, so recycling is caught
      // here too. POSIX recycling is caught by the pre-signal re-verification.
      if (tracked.startTime && proc.startTime && proc.startTime !== tracked.startTime) {
        entry.pids.delete(pid);
        this.trackedCount--;
      }
    }
  }

  /**
   * Refresh the "has this left our tree" flag, which decides both what gets its
   * own discovery walk and what gets persisted for the next launch to reap.
   *
   * Defined as *unreachable from the root in this census*, not "its parent is
   * missing". A detached wrapper's own children still have a live parent, so a
   * parent-based test would leave them out of the persisted set and let them
   * survive the very restart that reaps their wrapper.
   */
  private flagOrphans(entry: RootEntry, rootPid: number, census: LineageCensus): void {
    const reachable = new Set(census.getDescendantPids(rootPid));
    for (const [pid, tracked] of entry.pids) {
      const proc = census.getProcess(pid);
      if (!proc) continue;
      if (
        tracked.startTime === null &&
        proc.startTime &&
        couldPredateObservation(proc.startTime, tracked.observedAtMs)
      ) {
        tracked.startTime = proc.startTime;
      }
      tracked.orphaned = !reachable.has(pid);
    }
  }

  private admit(entry: RootEntry, pid: number): void {
    if (entry.pids.has(pid) || !Number.isInteger(pid) || pid <= 1) return;
    if (this.trackedCount >= MAX_TRACKED_PIDS) {
      if (!this.loggedCapWarning) {
        this.loggedCapWarning = true;
        console.warn(
          `[TerminalLineageLedger] Tracking cap of ${MAX_TRACKED_PIDS} PIDs reached — detached descendants beyond this point will not be reaped`
        );
      }
      return;
    }
    entry.pids.set(pid, { startTime: null, observedAtMs: Date.now(), orphaned: false });
    this.trackedCount++;
    this.pendingIdentification.add(pid);
  }

  private dropRoot(rootPid: number): void {
    const entry = this.roots.get(rootPid);
    if (!entry) return;
    this.trackedCount -= entry.pids.size;
    if (this.trackedCount < 0) this.trackedCount = 0;
    this.roots.delete(rootPid);
  }

  private scheduleIdentification(): void {
    if (this.identifyInFlight || this.pendingIdentification.size === 0) return;
    const pids = [...this.pendingIdentification];
    this.pendingIdentification.clear();
    this.identifyInFlight = true;
    void probeStartTimesDetailed(pids)
      .then(({ startTimes, failed }) => {
        if (this.disposed) return;
        for (const entry of this.roots.values()) {
          for (const [pid, tracked] of [...entry.pids]) {
            if (tracked.startTime !== null) continue;
            const startTime = startTimes.get(pid);
            if (!startTime) continue;
            if (couldPredateObservation(startTime, tracked.observedAtMs)) {
              tracked.startTime = startTime;
              continue;
            }
            // Born after we saw the ancestry: the PID was recycled between the
            // census and this probe, so this is not our descendant.
            entry.pids.delete(pid);
            this.trackedCount--;
          }
        }
        // A probe that could not run leaves those PIDs permanently
        // unsignallable unless they go back in the queue. Genuinely-dead PIDs
        // requeued alongside them cost one lookup and are dropped by the next
        // prune.
        if (failed) {
          for (const pid of pids) {
            if (!startTimes.has(pid)) this.pendingIdentification.add(pid);
          }
        }
      })
      .catch(() => {
        for (const pid of pids) this.pendingIdentification.add(pid);
      })
      .finally(() => {
        this.identifyInFlight = false;
      });
  }

  /**
   * Write the orphaned, identified subset so a crashed host or a hard-killed
   * app can still reap them on the next launch.
   *
   * Only orphans are persisted. Descendants still attached to a live pty shell
   * die with it — the shell's own teardown, or the process-group kill in
   * `PtyClient.cleanupOrphanedPtysForShard`, already reaches them — so writing
   * them would churn the file on every build without widening what the reaper
   * can actually save.
   */
  private persist(): void {
    if (!this.filePath) return;

    const entries: PersistedLineageEntry[] = [];
    for (const [rootPid, entry] of this.roots) {
      for (const [pid, tracked] of entry.pids) {
        if (!tracked.orphaned || !tracked.startTime) continue;
        entries.push({ pid, startTime: tracked.startTime, rootPid });
      }
    }
    entries.sort((a, b) => a.pid - b.pid);

    // Change-detection is the whole write gate. The orphan set only moves when
    // a descendant actually detaches or dies, so this settles to near-zero
    // writes on its own — and a time-based throttle on top would leave a fresh
    // orphan unrecorded across exactly the window a crash is most likely in.
    const signature = JSON.stringify(entries);
    if (signature === this.lastPersistedJson) return;

    try {
      if (entries.length === 0) {
        if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      } else {
        const payload: PersistedLineageFile = {
          version: LEDGER_VERSION,
          bootEpochSec: currentBootEpochSec(),
          owner: this.owner,
          updatedAt: Date.now(),
          entries,
        };
        resilientAtomicWriteFileSync(this.filePath, JSON.stringify(payload), "utf-8");
      }
      // Recorded only after the disk actually changed. Stamping it up front
      // would let a transient EBUSY or disk-full suppress every future retry
      // for an unchanged orphan set, silently leaving no recovery record.
      this.lastPersistedJson = signature;
    } catch (err) {
      this.lastPersistedJson = null;
      console.warn("[TerminalLineageLedger] Failed to persist lineage ledger:", err);
    }
  }
}

function readLineageFile(filePath: string): PersistedLineageFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedLineageFile;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== LEDGER_VERSION) return null;
    if (typeof parsed.bootEpochSec !== "number" || !Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries.filter(
      (e): e is PersistedLineageEntry =>
        typeof e === "object" &&
        e !== null &&
        Number.isInteger(e.pid) &&
        e.pid > 1 &&
        typeof e.startTime === "string" &&
        e.startTime.length > 0
    );
    return { ...parsed, entries };
  } catch {
    return null;
  }
}

function deleteQuietly(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort
  }
}

/**
 * Rename a shard's live ledger out of the way so it can be reaped without
 * racing that shard's replacement. A restarted host writes a fresh file at the
 * original path, which would otherwise clobber the crashed host's survivors
 * before we ever read them.
 *
 * The claim name is unique per call: an earlier interrupted claim is another
 * host's unreaped survivor list, and overwriting it would destroy the only
 * record of those processes. The startup sweep picks up every claim it finds.
 */
export function claimShardLineageFile(userDataPath: string, shardService?: string): string | null {
  const source = lineageFilePath(userDataPath, shardService);
  const claimed = `${source}${REAPING_SUFFIX}-${Date.now()}-${process.pid}`;
  try {
    if (!fs.existsSync(source)) return null;
    fs.renameSync(source, claimed);
    return claimed;
  } catch {
    return null;
  }
}

/** Returns true when the process is gone or was successfully signalled. */
function killValidated(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH means it is already gone, which is the outcome we wanted.
    if (code === "ESRCH") return true;
    console.warn(`[TerminalLineageLedger] ${signal} pid=${pid}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * PIDs we must never signal regardless of what a ledger file claims: init, our
 * own process, and our parent. A ledger is only ever written with descendants
 * of a PTY shell, so hitting one of these means the file is stale or corrupt.
 */
function isForbiddenTarget(pid: number): boolean {
  return pid <= 1 || pid === process.pid || pid === process.ppid;
}

/**
 * Signal the entries whose identity still matches. Returns the entries that
 * could not be resolved or could not be killed — the caller must keep those,
 * because forgetting them is the leak this whole file exists to prevent.
 */
async function reapEntries(entries: PersistedLineageEntry[]): Promise<PersistedLineageEntry[]> {
  const candidates = entries.filter((e) => !isForbiddenTarget(e.pid));
  if (candidates.length === 0) return [];

  const { startTimes, failed } = await probeStartTimesDetailed(candidates.map((e) => e.pid));
  if (failed && startTimes.size === 0) {
    // We learned nothing — `ps` may be blocked by the utility-process sandbox.
    // "Absent" and "unknown" are not the same fact, so keep the record.
    return candidates;
  }

  const confirmed = candidates.filter((e) => startTimes.get(e.pid) === e.startTime);
  if (confirmed.length === 0) return [];

  console.log(
    `[TerminalLineageLedger] Reaping ${confirmed.length} orphaned descendant(s) from a previous session`
  );

  if (process.platform === "win32") {
    const survivors: PersistedLineageEntry[] = [];
    for (const entry of confirmed) {
      const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(entry.pid)], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 3000,
      });
      // 128 is "process not found", which is the outcome we wanted.
      if (result.status !== 0 && result.status !== 128) survivors.push(entry);
    }
    return survivors;
  }

  for (const entry of confirmed) {
    killValidated(entry.pid, "SIGTERM");
    // SIGTERM only queues while a process is stopped; SIGCONT lets the kernel
    // deliver it. Same ordering as ProcessTreeKiller (#9085).
    killValidated(entry.pid, "SIGCONT");
  }

  await new Promise((resolve) => setTimeout(resolve, REAP_ESCALATION_DELAY_MS));

  // Re-verify before escalating: a PID freed by the SIGTERM above may already
  // have been handed to an unrelated process.
  const after = await probeStartTimesDetailed(confirmed.map((e) => e.pid));
  const survivors: PersistedLineageEntry[] = [];
  for (const entry of confirmed) {
    if (after.startTimes.get(entry.pid) !== entry.startTime) continue;
    if (!killValidated(entry.pid, "SIGKILL")) survivors.push(entry);
  }
  return survivors;
}

async function reapLineageFile(filePath: string): Promise<void> {
  const parsed = readLineageFile(filePath);
  if (!parsed) {
    deleteQuietly(filePath);
    return;
  }

  // PID numbering restarts at boot, so entries from a previous boot address
  // whatever happens to hold those numbers now. Discard without signalling.
  if (Math.abs(parsed.bootEpochSec - currentBootEpochSec()) > BOOT_EPOCH_TOLERANCE_SEC) {
    deleteQuietly(filePath);
    return;
  }

  let survivors: PersistedLineageEntry[];
  try {
    survivors = await reapEntries(parsed.entries);
  } catch (err) {
    console.warn("[TerminalLineageLedger] Reap failed:", err);
    survivors = parsed.entries;
  }

  const attempts = (parsed.attempts ?? 0) + 1;
  if (survivors.length === 0 || attempts >= MAX_REAP_ATTEMPTS) {
    deleteQuietly(filePath);
    return;
  }

  try {
    const retained: PersistedLineageFile = { ...parsed, entries: survivors, attempts };
    resilientAtomicWriteFileSync(filePath, JSON.stringify(retained), "utf-8");
  } catch {
    deleteQuietly(filePath);
  }
}

/**
 * Kill descendants left behind by a previous session. Runs in Main before the
 * first pty-host fork; picks up both live ledger files (the app was killed
 * without a graceful teardown) and interrupted `.reaping` claims.
 */
export async function reapPersistedLineages(userDataPath: string): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(userDataPath);
  } catch {
    return;
  }

  const files = names.filter(
    (n) => n.startsWith(LEDGER_FILE_PREFIX) && (n.endsWith(".json") || n.includes(REAPING_SUFFIX))
  );
  if (files.length === 0) return;

  await Promise.all(files.map((name) => reapLineageFile(path.join(userDataPath, name))));
}

/**
 * Reap one shard's ledger after its pty-host exited. The in-memory ledger died
 * with the host, so the persisted orphan set is all that is left.
 */
export async function reapShardLineage(userDataPath: string, shardService?: string): Promise<void> {
  const claimed = claimShardLineageFile(userDataPath, shardService);
  if (!claimed) return;
  await reapLineageFile(claimed);
}
