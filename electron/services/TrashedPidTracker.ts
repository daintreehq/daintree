import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TRASHED_PIDS_FILENAME = "trashed-pids.json";

interface TrashedPidEntry {
  terminalId: string;
  pid: number;
  startTime: string;
  trashedAt: number;
}

function getProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 3000,
        }
      ).toString("utf8");
      const match = out.match(/CreationDate=(\S+)/);
      return match?.[1] ?? null;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    })
      .toString("utf8")
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function verifyProcessStartTime(pid: number, expectedStartTime: string): boolean {
  const currentStartTime = getProcessStartTime(pid);
  if (!currentStartTime) return false;
  return currentStartTime === expectedStartTime;
}

export class TrashedPidTracker {
  private filePath: string;

  constructor(userDataPath?: string) {
    const userData = userDataPath ?? app.getPath("userData");
    this.filePath = path.join(userData, TRASHED_PIDS_FILENAME);
  }

  persistTrashed(terminalId: string, pid: number | undefined): void {
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;

    const startTime = getProcessStartTime(pid);
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
  }

  removeTrashed(terminalId: string): void {
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

  cleanupOrphans(): void {
    if (!this.fileExists()) return;

    const entries = this.readEntries();
    if (entries.length === 0) {
      this.deleteFile();
      return;
    }

    console.log(`[TrashedPidTracker] Found ${entries.length} trashed PID(s) from previous session`);

    for (const entry of entries) {
      if (!Number.isFinite(entry.pid) || entry.pid <= 0) continue;
      if (entry.pid === process.pid) continue;

      if (!verifyProcessStartTime(entry.pid, entry.startTime)) {
        console.log(
          `[TrashedPidTracker] PID ${entry.pid} (terminal ${entry.terminalId}) no longer exists or was recycled, skipping`
        );
        continue;
      }

      let killed = false;
      if (process.platform !== "win32") {
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
    }

    this.deleteFile();
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
    const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(entries), {
        encoding: "utf8",
        flush: true,
      } as Parameters<typeof fs.writeFileSync>[2]);
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
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
  tracker.cleanupOrphans();
}
