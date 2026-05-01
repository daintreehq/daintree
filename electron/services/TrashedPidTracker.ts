import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

const execFileAsync = promisify(execFile);

const TRASHED_PIDS_FILENAME = "trashed-pids.json";
const PROCESS_START_TIME_TIMEOUT_MS = 3000;

interface TrashedPidEntry {
  terminalId: string;
  pid: number;
  startTime: string;
  trashedAt: number;
}

async function getProcessStartTime(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-NoLogo",
          "-Command",
          "$ErrorActionPreference = 'SilentlyContinue'; " +
            "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" +
            pid +
            "'; if ($p -and $p.CreationDate) { $p.CreationDate.ToString('o') }",
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          shell: false,
          signal: AbortSignal.timeout(PROCESS_START_TIME_TIMEOUT_MS),
        }
      );
      const out = stdout.replace(/^\uFEFF/, "").trim();
      return out || null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      shell: false,
      signal: AbortSignal.timeout(PROCESS_START_TIME_TIMEOUT_MS),
    });
    const out = stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

async function verifyProcessStartTime(pid: number, expectedStartTime: string): Promise<boolean> {
  const currentStartTime = await getProcessStartTime(pid);
  if (!currentStartTime) return false;
  return currentStartTime === expectedStartTime;
}

export class TrashedPidTracker {
  private filePath: string;
  // Cancellation tokens for in-flight persistTrashed calls. Set by
  // removeTrashed so a restore that races a trash drops the pending file
  // write rather than ghosting a restored terminal into the orphan list.
  private cancelledPersists = new Set<string>();

  constructor(userDataPath?: string) {
    const userData = userDataPath ?? app.getPath("userData");
    this.filePath = path.join(userData, TRASHED_PIDS_FILENAME);
  }

  async persistTrashed(terminalId: string, pid: number | undefined): Promise<void> {
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;

    // Clear any stale cancellation marker before we start awaiting.
    this.cancelledPersists.delete(terminalId);

    try {
      const startTime = await getProcessStartTime(pid);

      // If removeTrashed ran while we awaited, it tagged this id for
      // cancellation. Drop the write so the restored terminal doesn't get
      // killed on next startup.
      if (this.cancelledPersists.has(terminalId)) return;

      if (!startTime) return;

      const entries = this.readEntries();
      const existing = entries.findIndex((e) => e.terminalId === terminalId);
      const entry: TrashedPidEntry = { terminalId, pid, startTime, trashedAt: Date.now() };

      if (existing >= 0) {
        entries[existing] = entry;
      } else {
        entries.push(entry);
      }

      this.writeEntries(entries);
    } finally {
      this.cancelledPersists.delete(terminalId);
    }
  }

  removeTrashed(terminalId: string): void {
    // Tag any concurrent in-flight persistTrashed for cancellation. The token
    // is consumed by persistTrashed's settle path; if no persist is in flight
    // it is cleared by the next persistTrashed for this id.
    this.cancelledPersists.add(terminalId);

    const entries = this.readEntries();
    const filtered = entries.filter((e) => e.terminalId !== terminalId);
    if (filtered.length === entries.length) return;

    if (filtered.length === 0) {
      this.deleteFile();
    } else {
      this.writeEntries(filtered);
    }
  }

  clearAll(): void {
    this.deleteFile();
  }

  async cleanupOrphans(): Promise<void> {
    if (!this.fileExists()) return;

    const initialEntries = this.readEntries();
    if (initialEntries.length === 0) {
      this.deleteFile();
      return;
    }

    // Snapshot the ids we are responsible for cleaning up. Any persistTrashed
    // call that lands during the await window writes a new entry; we must not
    // clobber it when we tear down the file at the end.
    const processedIds = new Set(initialEntries.map((e) => e.terminalId));

    console.log(
      `[TrashedPidTracker] Found ${initialEntries.length} trashed PID(s) from previous session`
    );

    await Promise.all(
      initialEntries.map(async (entry) => {
        if (!Number.isFinite(entry.pid) || entry.pid <= 0) return;
        if (entry.pid === process.pid) return;

        const matches = await verifyProcessStartTime(entry.pid, entry.startTime);
        if (!matches) {
          console.log(
            `[TrashedPidTracker] PID ${entry.pid} (terminal ${entry.terminalId}) no longer exists or was recycled, skipping`
          );
          return;
        }

        let killed = false;
        if (process.platform === "win32") {
          const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(entry.pid)], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 3000,
          });
          if (result.status === 0 || result.status === 128) {
            killed = true;
          }
        } else {
          try {
            process.kill(-entry.pid, "SIGKILL");
            killed = true;
          } catch {
            // fall back to direct kill
          }
        }

        if (!killed) {
          try {
            process.kill(entry.pid, "SIGKILL");
            killed = true;
          } catch {
            // process may already be gone
          }
        }

        if (killed) {
          console.log(
            `[TrashedPidTracker] Killed orphaned PTY pid=${entry.pid} (terminal ${entry.terminalId})`
          );
        } else {
          console.warn(
            `[TrashedPidTracker] Failed to kill orphaned PTY pid=${entry.pid} (terminal ${entry.terminalId})`
          );
        }
      })
    );

    // Re-read so any persistTrashed that landed during our await window is
    // preserved. Strip the ids we processed; if nothing else remains, delete
    // the file (preserves the original behavior of removing the artifact).
    const finalEntries = this.readEntries();
    const remaining = finalEntries.filter((e) => !processedIds.has(e.terminalId));
    if (remaining.length === 0) {
      this.deleteFile();
    } else {
      this.writeEntries(remaining);
    }
  }

  private fileExists(): boolean {
    return fs.existsSync(this.filePath);
  }

  private readEntries(): TrashedPidEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e: unknown): e is TrashedPidEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as TrashedPidEntry).terminalId === "string" &&
          typeof (e as TrashedPidEntry).pid === "number" &&
          typeof (e as TrashedPidEntry).startTime === "string" &&
          typeof (e as TrashedPidEntry).trashedAt === "number"
      );
    } catch {
      return [];
    }
  }

  private writeEntries(entries: TrashedPidEntry[]): void {
    try {
      resilientAtomicWriteFileSync(this.filePath, JSON.stringify(entries), "utf8");
    } catch (err) {
      console.warn("[TrashedPidTracker] Failed to write trashed PIDs:", err);
    }
  }

  private deleteFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // ignore
    }
  }
}

let instance: TrashedPidTracker | null = null;

export function getTrashedPidTracker(): TrashedPidTracker {
  if (!instance) {
    instance = new TrashedPidTracker();
  }
  return instance;
}

export function initializeTrashedPidCleanup(): void {
  const tracker = getTrashedPidTracker();
  tracker.cleanupOrphans().catch((err) => {
    console.warn("[TrashedPidTracker] cleanupOrphans failed:", err);
  });
}
