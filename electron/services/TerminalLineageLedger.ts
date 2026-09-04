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
  /** True when the last census showed this PID reparented away from our tree. */
  orphaned: boolean;
}

interface RootEntry {
  /**
   * `active` roots discover new descendants each sweep. `closing` roots have
   * had their terminal torn down: we stop discovering and only prune, so a
   * recycled root PID can never adopt a dead terminal's lineage.
   */
  state: "active" | "closing";
  pids: Map<number, TrackedPid>;
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
 * Batched process start-time lookup. One subprocess per chunk rather than one
 * per PID — a busy agent terminal can produce dozens of new descendants per
 * sweep, and a spawn each would cost more than the census itself.
 *
 * PIDs that no longer exist are simply absent from the result. `ps` exits
 * non-zero when *none* of the requested PIDs exist, which is a normal outcome
 * here, so a rejected call with usable stdout is not treated as a failure.
 */
export async function probeStartTimes(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  for (const group of chunk(pids, PROBE_CHUNK_SIZE)) {
    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", windowsStartTimeScript(group)],
          {
            windowsHide: true,
            encoding: "utf8",
            shell: false,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }
        );
        for (const [pid, startTime] of parsePsStartTimes(stdout.replace(/^﻿/, ""))) {
          result.set(pid, startTime);
        }
        continue;
      }
      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "pid=,lstart=", "-p", group.join(",")],
        { encoding: "utf8", shell: false, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
      );
      for (const [pid, startTime] of parsePsStartTimes(stdout)) {
        result.set(pid, startTime);
      }
    } catch (err) {
      // `ps` exits 1 when every requested PID is gone — the error still carries
      // stdout for any that survived. Anything else leaves the group unresolved,
      // which fails closed: unidentified PIDs are never signalled.
      const stdout = (err as { stdout?: string })?.stdout;
      if (typeof stdout === "string" && stdout.length > 0) {
        for (const [pid, startTime] of parsePsStartTimes(stdout)) {
          result.set(pid, startTime);
        }
      }
    }
  }

  return result;
}

/**
 * Synchronous counterpart of {@link probeStartTimes}. Required at kill time:
 * `ProcessTreeKiller.execute()` runs synchronously, and its `immediate` path
 * runs inside `process.on("exit")` where no async work can complete.
 */
export function probeStartTimesSync(pids: number[]): Map<number, string> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  for (const group of chunk(pids, PROBE_CHUNK_SIZE)) {
    try {
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
              { windowsHide: true, encoding: "utf8", timeout: PROBE_TIMEOUT_MS }
            )
          : spawnSync("ps", ["-o", "pid=,lstart=", "-p", group.join(",")], {
              encoding: "utf8",
              timeout: PROBE_TIMEOUT_MS,
            });
      const stdout = typeof spawned?.stdout === "string" ? spawned.stdout : "";
      if (!stdout) continue;
      for (const [pid, startTime] of parsePsStartTimes(stdout.replace(/^﻿/, ""))) {
        result.set(pid, startTime);
      }
    } catch {
      // Fail closed — unidentified PIDs are not signalled.
    }
  }

  return result;
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
 * Two invariants keep the wider kill set safe:
 *
 * - **Every entry is anchored to a start time.** A PID with no recorded start
 *   time, or whose current start time differs, is never signalled — it is a
 *   different process now, not the one we observed (lesson #10950).
 * - **`closing` roots stop discovering.** Once a terminal is torn down its root
 *   PID can be recycled, so a recycled root must not be able to adopt the dead
 *   terminal's lineage.
 */
export class TerminalLineageLedger {
  private roots = new Map<number, RootEntry>();
  private trackedCount = 0;
  private loggedCapWarning = false;
  private pendingIdentification = new Set<number>();
  private identifyInFlight = false;
  private lastPersistedJson: string | null = null;
  private disposed = false;
  private lastCensus: LineageCensus | null = null;

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
    this.roots.set(rootPid, { state: "active", pids: new Map() });
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
   * This is the safety boundary for the widened kill set. Ledger entries are by
   * construction old — that is what lets them outlive reparenting — so a PID
   * being *present* proves nothing; only a matching start time proves it is
   * still the process we observed (lesson #10950). Verification is synchronous
   * because it runs inside teardown, including the `process.on("exit")` path
   * where nothing async can complete.
   */
  getVerifiedOrphanPids(rootPid: number, alreadyCovered: readonly number[]): number[] {
    const covered = new Set(alreadyCovered);
    const candidates = this.getTrackedPids(rootPid).filter((t) => !covered.has(t.pid));
    if (candidates.length === 0) return [];

    if (process.platform === "win32") {
      // The Windows census already carries CreationDate, so the last sweep's
      // snapshot answers this without spawning anything.
      return candidates
        .filter((c) => this.lastCensus?.getProcess(c.pid)?.startTime === c.startTime)
        .map((c) => c.pid);
    }

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
    if (this.disposed) return;
    this.lastCensus = census;
    if (this.roots.size === 0) return;

    for (const [rootPid, entry] of this.roots) {
      // Prune first so the orphan flags below are current for *this* sweep.
      // Flagging after discovery would delay a freshly detached member's own
      // children by a full sweep.
      this.prune(entry, census);
      this.flagOrphans(entry, census);

      if (entry.state === "active") {
        for (const pid of census.getDescendantPids(rootPid)) {
          this.admit(entry, pid);
        }
      }

      // Descendants a detached member spawned after it left our tree are still
      // this terminal's work — a wrapper that reparents and then forks a build
      // would otherwise leave that build unreachable. Only orphans need their
      // own walk: anything still attached is already covered by the root walk
      // above, and walking every tracked PID would be quadratic on a deep tree.
      for (const [pid, tracked] of [...entry.pids]) {
        if (!tracked.orphaned) continue;
        for (const child of census.getDescendantPids(pid)) {
          this.admit(entry, child);
        }
      }

      // Second pass so anything just admitted is flagged (and so persisted)
      // without waiting for the next sweep.
      this.flagOrphans(entry, census);
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
    this.lastCensus = null;
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
      // here. POSIX recycling is caught by the pre-signal re-verification.
      if (tracked.startTime && proc.startTime && proc.startTime !== tracked.startTime) {
        entry.pids.delete(pid);
        this.trackedCount--;
      }
    }
  }

  /**
   * Refresh the "has this left our tree" flag, which decides both what gets its
   * own discovery walk and what gets persisted for the next launch to reap.
   */
  private flagOrphans(entry: RootEntry, census: LineageCensus): void {
    for (const [pid, tracked] of entry.pids) {
      const proc = census.getProcess(pid);
      if (!proc) continue;
      if (tracked.startTime === null && proc.startTime) {
        tracked.startTime = proc.startTime;
      }
      tracked.orphaned = proc.ppid <= 1 || census.getProcess(proc.ppid) === undefined;
    }
  }

  private admit(entry: RootEntry, pid: number): void {
    if (entry.pids.has(pid) || !Number.isInteger(pid) || pid <= 1) return;
    if (this.trackedCount >= MAX_TRACKED_PIDS) {
      if (!this.loggedCapWarning) {
        this.loggedCapWarning = true;
        console.warn(
          `[TerminalLineageLedger] Tracking cap of ${MAX_TRACKED_PIDS} PIDs reached — new descendants will not be tracked`
        );
      }
      return;
    }
    entry.pids.set(pid, { startTime: null, orphaned: false });
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
    void probeStartTimes(pids)
      .then((startTimes) => {
        if (this.disposed) return;
        for (const entry of this.roots.values()) {
          for (const [pid, tracked] of entry.pids) {
            if (tracked.startTime !== null) continue;
            const startTime = startTimes.get(pid);
            if (startTime) tracked.startTime = startTime;
          }
        }
      })
      .catch(() => {
        // Unidentified PIDs stay unsignallable — degrades to the live-walk-only
        // behavior this ledger exists to widen.
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
    this.lastPersistedJson = signature;

    try {
      if (entries.length === 0) {
        if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
        return;
      }
      const payload: PersistedLineageFile = {
        version: LEDGER_VERSION,
        bootEpochSec: currentBootEpochSec(),
        owner: this.owner,
        updatedAt: Date.now(),
        entries,
      };
      resilientAtomicWriteFileSync(this.filePath, JSON.stringify(payload), "utf-8");
    } catch (err) {
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
 */
export function claimShardLineageFile(
  userDataPath: string,
  shardService?: string
): string | null {
  const source = lineageFilePath(userDataPath, shardService);
  const claimed = `${source}${REAPING_SUFFIX}`;
  try {
    if (!fs.existsSync(source)) return null;
    // An interrupted earlier reap leaves its own claim behind; it is picked up
    // by the startup sweep, so drop it rather than failing this rename.
    deleteQuietly(claimed);
    fs.renameSync(source, claimed);
    return claimed;
  } catch {
    return null;
  }
}

function killValidated(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      console.warn(`[TerminalLineageLedger] ${signal} pid=${pid}: ${(err as Error).message}`);
    }
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

async function reapEntries(entries: PersistedLineageEntry[]): Promise<number> {
  const candidates = entries.filter((e) => !isForbiddenTarget(e.pid));
  if (candidates.length === 0) return 0;

  const live = await probeStartTimes(candidates.map((e) => e.pid));
  const confirmed = candidates.filter((e) => live.get(e.pid) === e.startTime);
  if (confirmed.length === 0) return 0;

  console.log(
    `[TerminalLineageLedger] Reaping ${confirmed.length} orphaned descendant(s) from a previous session`
  );

  if (process.platform === "win32") {
    for (const entry of confirmed) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(entry.pid)], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 3000,
      });
    }
    return confirmed.length;
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
  const survivors = await probeStartTimes(confirmed.map((e) => e.pid));
  for (const entry of confirmed) {
    if (survivors.get(entry.pid) !== entry.startTime) continue;
    killValidated(entry.pid, "SIGKILL");
  }

  return confirmed.length;
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

  try {
    await reapEntries(parsed.entries);
  } catch (err) {
    console.warn("[TerminalLineageLedger] Reap failed:", err);
  }
  deleteQuietly(filePath);
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
    (n) =>
      n.startsWith(LEDGER_FILE_PREFIX) && (n.endsWith(".json") || n.endsWith(REAPING_SUFFIX))
  );
  if (files.length === 0) return;

  await Promise.all(files.map((name) => reapLineageFile(path.join(userDataPath, name))));
}

/**
 * Reap one shard's ledger after its pty-host exited. The in-memory ledger died
 * with the host, so the persisted orphan set is all that is left.
 */
export async function reapShardLineage(
  userDataPath: string,
  shardService?: string
): Promise<void> {
  const claimed = claimShardLineageFile(userDataPath, shardService);
  if (!claimed) return;
  await reapLineageFile(claimed);
}
