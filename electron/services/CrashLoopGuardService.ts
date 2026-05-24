// eager-import-allow: reads/writes the crash-loop sentinel via sync fs before async IO is safe
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

const STATE_FILENAME = "crash-loop-state.json";
const CRASH_THRESHOLD = 3;
const HARD_STOP_THRESHOLD = 5;
// Sliding-window decay for the crash counter. Lazy-evaluated at boot and at
// crash-record-time — no setTimeout, no proactive reset. A wider window
// (compared to the prior 5-minute rapid-crash setting) closes the slow-flap
// blind spot where a crash every 6+ minutes accumulated no strikes because
// each entry expired before the next crash. Exported so the alignment test
// (`crashGuardAlignment.test.ts`) can assert the three guards share one value.
export const CRASH_WINDOW_MS = 30 * 60 * 1000;

// Grace window before a leftover `.tmp` from `resilientAtomicWriteFileSync` is
// swept. Matches the precedent in `terminalSessionPersistence.ts` — long enough
// to dodge concurrent boots, short enough to keep the userData dir tidy.
const TMP_ORPHAN_TTL_MS = 5 * 60 * 1000;
// Number of `.corrupted.*` siblings to retain for forensics. Older entries are
// pruned at boot so a chronic crash loop can't fill the userData directory.
const KEEP_CORRUPTED_SIBLINGS = 3;

const TMP_FILE_RE = /^crash-loop-state\.json\.(\d+)-[a-z0-9]+\.tmp$/;
const CORRUPTED_FILE_RE = /^crash-loop-state\.json\.corrupted\.(\d+)$/;

interface CrashLoopState {
  version: 1;
  crashes: number;
  launches: number[];
  cleanExit: boolean;
  lastReset: number;
}

function freshState(): CrashLoopState {
  return {
    version: 1,
    crashes: 0,
    launches: [],
    cleanExit: true,
    lastReset: Date.now(),
  };
}

// Tighten perms on the quarantined file — it inherits the original (potentially
// 0o644) mode but may contain partial state useful only for forensics. Mirrors
// `tightenFilePermissions` in `electron/store.ts`. Windows ignores POSIX mode
// bits, so the platform guard keeps it a no-op there.
function tightenFilePermissions(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn("[CrashLoopGuard] Failed to tighten file permissions:", filePath, err);
  }
}

export class CrashLoopGuardService {
  private userData: string;
  private statePath: string;
  private safeMode = false;
  private relaunchAllowed = true;
  private initialized = false;
  private crashCount = 0;
  private lastCrashAt: number | undefined;
  private quarantinedStatePath: string | null = null;

  constructor() {
    this.userData = app.getPath("userData");
    this.statePath = path.join(this.userData, STATE_FILENAME);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Sweep stale `.tmp` residue and prune old `.corrupted.*` siblings before
    // reading state. Both are best-effort — boot must proceed even if cleanup
    // throws. Pruning before quarantine guarantees the current boot's
    // quarantined file (if any) is never pruned in the same run.
    this.sweepStaleTmpFiles();
    this.pruneCorruptedSiblings();

    const state = this.readState();
    const now = Date.now();

    if (!state.cleanExit) {
      const recentLaunches = state.launches.filter((ts) => now - ts < CRASH_WINDOW_MS);
      state.crashes = recentLaunches.length;
    } else {
      state.crashes = 0;
      state.launches = [];
    }

    // The previous launch (if any) is the most recent crash — captured before
    // we append the current launch so launches[length - 1] becomes "now".
    this.lastCrashAt =
      state.launches.length > 0 ? state.launches[state.launches.length - 1] : undefined;

    state.launches.push(now);
    if (state.launches.length > HARD_STOP_THRESHOLD) {
      state.launches = state.launches.slice(-HARD_STOP_THRESHOLD);
    }

    state.cleanExit = false;

    this.crashCount = state.crashes;
    this.safeMode = state.crashes >= CRASH_THRESHOLD;
    this.relaunchAllowed = state.crashes < HARD_STOP_THRESHOLD;

    try {
      this.writeState(state);
    } catch (err) {
      console.error("[CrashLoopGuard] Failed to persist state during initialize:", err);
    }

    if (this.safeMode) {
      console.warn(`[CrashLoopGuard] Safe mode activated (${state.crashes} consecutive crashes)`);
    }
    if (!this.relaunchAllowed) {
      console.error(
        `[CrashLoopGuard] Relaunch disabled (${state.crashes} crashes reached hard stop)`
      );
    }

    console.log(
      `[CrashLoopGuard] Initialized — crashes: ${state.crashes}, safeMode: ${this.safeMode}, relaunchAllowed: ${this.relaunchAllowed}`
    );
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  shouldRelaunch(): boolean {
    return this.relaunchAllowed;
  }

  getCrashCount(): number {
    return this.crashCount;
  }

  getLastCrashTimestamp(): number | undefined {
    return this.lastCrashAt;
  }

  /**
   * Path of the corrupt state file that was quarantined during the most recent
   * `initialize()` call, or `null` when no corruption was detected. The IPC
   * layer gates the renderer notification on `isSafeMode() && this !== null`.
   */
  getQuarantinedStatePath(): string | null {
    return this.quarantinedStatePath;
  }

  /**
   * User-initiated reset: atomically clear the state file and reset in-memory
   * flags.
   *
   * Throws if the disk write fails. The caller (IPC handler) must propagate
   * the failure so the renderer can re-enable the restart button — silently
   * swallowing the error here would leave the unclean sentinel on disk and
   * boot the user straight back into safe mode after relaunch.
   */
  resetForNormalBoot(): void {
    this.writeState(freshState());
    this.safeMode = false;
    this.relaunchAllowed = true;
    this.crashCount = 0;
    this.lastCrashAt = undefined;
  }

  markCleanExit(): void {
    try {
      const state = this.readState();
      state.cleanExit = true;
      this.writeState(state);
    } catch (err) {
      console.error("[CrashLoopGuard] Failed to mark clean exit:", err);
    }
  }

  dispose(): void {
    // No resources held — kept for API stability with callers that pair
    // initialize()/dispose() out of habit.
  }

  private readState(): CrashLoopState {
    if (!fs.existsSync(this.statePath)) {
      return freshState();
    }
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CrashLoopState>;
      if (
        parsed.version === 1 &&
        typeof parsed.crashes === "number" &&
        Number.isFinite(parsed.crashes) &&
        Array.isArray(parsed.launches) &&
        parsed.launches.every((ts) => typeof ts === "number" && Number.isFinite(ts)) &&
        typeof parsed.cleanExit === "boolean" &&
        typeof parsed.lastReset === "number" &&
        Number.isFinite(parsed.lastReset)
      ) {
        return parsed as CrashLoopState;
      }
      console.warn("[CrashLoopGuard] Invalid state structure — quarantining and resetting");
      this.quarantineStateFile();
      return freshState();
    } catch (err) {
      console.warn("[CrashLoopGuard] Failed to parse state file — quarantining and resetting", err);
      this.quarantineStateFile();
      return freshState();
    }
  }

  /**
   * Rename the corrupt state file to a `.corrupted.<timestamp>` sibling so it
   * survives for forensics, then tighten perms (best-effort, POSIX only). The
   * rename is the authoritative quarantine event — if `chmod` fails the file
   * is still moved and `quarantinedStatePath` is set. `quarantinedStatePath`
   * is only set on the first successful rename per service instance, so a
   * second `initialize()` (already idempotent) can't overwrite the first.
   */
  private quarantineStateFile(): void {
    const quarantinePath = `${this.statePath}.corrupted.${Date.now()}`;
    try {
      fs.renameSync(this.statePath, quarantinePath);
    } catch (err) {
      console.warn("[CrashLoopGuard] Failed to quarantine corrupt state file:", err);
      return;
    }
    tightenFilePermissions(quarantinePath);
    if (this.quarantinedStatePath === null) {
      this.quarantinedStatePath = quarantinePath;
    }
    console.log(`[CrashLoopGuard] Quarantined corrupt state file to ${quarantinePath}`);
  }

  /**
   * Sweep `.tmp` residue left by `resilientAtomicWriteFileSync` if the process
   * was SIGKILL'd between write and rename. The tmp name embeds `Date.now()`,
   * so we parse the timestamp from the filename (`statSync` fallback only when
   * the regex doesn't capture it). All errors are swallowed — boot must
   * proceed regardless.
   */
  private sweepStaleTmpFiles(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.userData);
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      const match = TMP_FILE_RE.exec(entry);
      if (!match) continue;
      const ts = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(ts)) continue;
      if (now - ts < TMP_ORPHAN_TTL_MS) continue;
      const tmpPath = path.join(this.userData, entry);
      try {
        fs.unlinkSync(tmpPath);
        console.log(`[CrashLoopGuard] Swept stale tmp file ${tmpPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[CrashLoopGuard] Failed to sweep tmp file ${tmpPath}:`, err);
        }
      }
    }
  }

  /**
   * Prune `.corrupted.<ts>` siblings beyond `KEEP_CORRUPTED_SIBLINGS` so a
   * chronic crash loop can't fill the userData directory. Sort by the
   * timestamp embedded in the filename (descending), retain the newest N,
   * unlink the rest. Best-effort — boot must proceed even if cleanup fails.
   */
  private pruneCorruptedSiblings(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.userData);
    } catch {
      return;
    }
    const corrupted: Array<{ entry: string; ts: number }> = [];
    for (const entry of entries) {
      const match = CORRUPTED_FILE_RE.exec(entry);
      if (!match) continue;
      const ts = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(ts)) continue;
      corrupted.push({ entry, ts });
    }
    if (corrupted.length <= KEEP_CORRUPTED_SIBLINGS) return;
    corrupted.sort((a, b) => b.ts - a.ts);
    for (const { entry } of corrupted.slice(KEEP_CORRUPTED_SIBLINGS)) {
      const corruptedPath = path.join(this.userData, entry);
      try {
        fs.unlinkSync(corruptedPath);
        console.log(`[CrashLoopGuard] Pruned old corrupted sibling ${corruptedPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[CrashLoopGuard] Failed to prune ${corruptedPath}:`, err);
        }
      }
    }
  }

  private writeState(state: CrashLoopState): void {
    const data = JSON.stringify(state);

    // Ensure the parent directory exists (e.g. first launch of dev userData).
    // resilientAtomicWriteFileSync does not create parent directories.
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    resilientAtomicWriteFileSync(this.statePath, data, "utf-8");
  }
}

export function isSafeModeActive(userDataPath?: string): boolean {
  const dir = userDataPath ?? app.getPath("userData");
  const statePath = path.join(dir, STATE_FILENAME);

  try {
    if (!fs.existsSync(statePath)) return false;
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CrashLoopState>;
    if (
      parsed.version === 1 &&
      typeof parsed.crashes === "number" &&
      Number.isFinite(parsed.crashes) &&
      Array.isArray(parsed.launches) &&
      parsed.launches.every((ts) => typeof ts === "number" && Number.isFinite(ts)) &&
      typeof parsed.cleanExit === "boolean" &&
      typeof parsed.lastReset === "number" &&
      Number.isFinite(parsed.lastReset)
    ) {
      if (parsed.cleanExit) return false;
      const now = Date.now();
      const recentLaunches = parsed.launches.filter((ts) => now - ts < CRASH_WINDOW_MS);
      return recentLaunches.length >= CRASH_THRESHOLD;
    }
    return false;
  } catch {
    return false;
  }
}

let instance: CrashLoopGuardService | null = null;

export function getCrashLoopGuard(): CrashLoopGuardService {
  if (!instance) {
    instance = new CrashLoopGuardService();
  }
  return instance;
}

export function initializeCrashLoopGuard(): CrashLoopGuardService {
  const service = getCrashLoopGuard();
  service.initialize();
  return service;
}
