import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type {
  DiagnosticsBundleMember,
  DiagnosticsTimeWindowId,
} from "../../shared/types/ipc/system.js";
import {
  applyReplacements,
  type ReplacementRule,
} from "../../shared/utils/diagnosticsTransform.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { sanitizePath } from "../utils/pathScrubber.js";

const MAX_ROTATED_LOGS = 5;
const MAX_BUNDLED_CRASH_RECORDS = 20;
const CRASH_RECORD_FILE = /^(crash|renderer-gone)-[\w-]+\.json$/;
// The default shard writes `pty-host.log`; other shards `pty-host-<suffix>.log`.
const PTY_HOST_LOG_FILE = /^pty-host(-[\w-]+)?\.log$/;
// The logger and the PTY host stamp entries with `toISOString()`. A stamp with
// no zone would parse as local time, so it doesn't count as a date.
const ENTRY_TIMESTAMP = /^\[(\d{4}-\d{2}-\d{2}T[^\]\s]*(?:Z|[+-]\d{2}:\d{2}))\]/;
// The PTY host draws a rule above each fatal block's dated header.
const BLOCK_RULE = /^=+\r?\n?$/;

export interface BundleDirs {
  logDir: string;
  logFile: string;
  /** `null` when the userData path is unavailable. */
  crashesDir: string | null;
}

/** Inclusive epoch-ms bounds; `null` leaves that side open. */
export interface BundleBounds {
  startMs: number | null;
  endMs: number | null;
}

interface LogEntry {
  timestamp: number | null;
  text: string;
}

interface CrashRecord {
  file: string;
  timestamp: number | null;
  /** The bundled JSON, before scrubbing. */
  content: string;
}

interface BundleSources {
  logs: Array<{ name: string; entries: LogEntry[] }>;
  crashes: CrashRecord[];
}

interface SelectedMember {
  name: string;
  parts: string[];
  outsideWindow: boolean;
}

function entryTimestamp(line: string): number | null {
  const match = ENTRY_TIMESTAMP.exec(line);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Split a log into entries. An entry starts at a dated line and carries the
 * undated lines after it (stack traces, the PTY host's fatal details); a rule
 * line directly above a dated line opens that line's entry. Lines before the
 * first dated line form one undated entry. Line endings are kept.
 */
export function parseLogEntries(raw: string): LogEntry[] {
  const lines = raw.split(/(?<=\n)/);
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    let timestamp = entryTimestamp(text);
    if (timestamp === null && BLOCK_RULE.test(text) && i + 1 < lines.length) {
      const next = entryTimestamp(lines[i + 1]);
      if (next !== null) {
        timestamp = next;
        text += lines[++i];
      }
    }
    if (timestamp !== null || !current) {
      current = { timestamp, text };
      entries.push(current);
    } else {
      current.text += text;
    }
  }
  return entries;
}

function inBounds(timestamp: number | null, { startMs, endMs }: BundleBounds): boolean {
  // An undated entry can't be placed inside a chosen window.
  if (timestamp === null) return startMs === null;
  return (startMs === null || timestamp >= startMs) && (endMs === null || timestamp <= endMs);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    // Missing or unreadable: the rest of the bundle is still useful.
    return null;
  }
}

/**
 * Breadcrumb args are dropped because action args can carry user-entered
 * text. Recency comes from each record's own `timestamp`, never mtime, which
 * copy-fallback paths can rewrite.
 */
async function readCrashRecords(crashesDir: string): Promise<CrashRecord[]> {
  const records: CrashRecord[] = [];
  for (const file of await listDir(crashesDir)) {
    if (!CRASH_RECORD_FILE.test(file)) continue;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(crashesDir, file), "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const timestamp =
        typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
          ? record.timestamp
          : null;
      if (Array.isArray(record.recentActions)) {
        record.recentActions = record.recentActions
          .filter((crumb: unknown) => !!crumb && typeof crumb === "object")
          .map((crumb: unknown) => {
            const { args: _args, ...rest } = crumb as Record<string, unknown>;
            return rest;
          });
      } else {
        delete record.recentActions;
      }
      records.push({ file, timestamp, content: JSON.stringify(record, null, 2) });
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * Every file the bundle may carry beside `diagnostics.json`, read once: the
 * active and rotated app logs, the PTY host's emergency logs (process start
 * lines and fatal errors, no terminal output), and crash records.
 */
async function readBundleSources(dirs: BundleDirs): Promise<BundleSources> {
  const files = [
    { name: "daintree.log", file: dirs.logFile },
    ...Array.from({ length: MAX_ROTATED_LOGS }, (_, i) => ({
      name: `daintree.log.${i + 1}`,
      file: path.join(dirs.logDir, `daintree.log.${i + 1}`),
    })),
    ...(await listDir(dirs.logDir))
      .filter((name) => PTY_HOST_LOG_FILE.test(name))
      .sort()
      .map((name) => ({ name, file: path.join(dirs.logDir, name) })),
  ];
  const logs: BundleSources["logs"] = [];
  for (const { name, file } of files) {
    const raw = await readText(file);
    if (raw !== null) logs.push({ name, entries: parseLogEntries(raw) });
  }
  return { logs, crashes: dirs.crashesDir ? await readCrashRecords(dirs.crashesDir) : [] };
}

/**
 * Crash and renderer-gone records, newest first. The newest fatal crash
 * ignores the window's start: export usually follows the relaunch, so the
 * record of how the last session died is older than any short window, and it
 * is the one record the bundle exists to carry (#13527).
 */
function selectCrashRecords(records: CrashRecord[], bounds: BundleBounds): SelectedMember[] {
  let newestFatal: CrashRecord | null = null;
  for (const record of records) {
    if (!record.file.startsWith("crash-") || record.timestamp === null) continue;
    // A crash after the review was never listed in it.
    if (bounds.endMs !== null && record.timestamp > bounds.endMs) continue;
    if (!newestFatal || record.timestamp > (newestFatal.timestamp ?? 0)) newestFatal = record;
  }

  const inWindow = records.filter(({ timestamp }) => inBounds(timestamp, bounds));
  inWindow.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const selected = inWindow.slice(0, MAX_BUNDLED_CRASH_RECORDS);
  if (newestFatal && !selected.includes(newestFatal)) {
    if (selected.length >= MAX_BUNDLED_CRASH_RECORDS) selected.pop();
    selected.push(newestFatal);
    selected.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  return selected.map((record) => ({
    name: `crashes/${record.file}`,
    parts: [record.content],
    outsideWindow: !inBounds(record.timestamp, bounds),
  }));
}

/** The members a bundle with these bounds carries; a log with nothing in bounds is left out. */
function selectBundleMembers(sources: BundleSources, bounds: BundleBounds): SelectedMember[] {
  const members: SelectedMember[] = [];
  for (const { name, entries } of sources.logs) {
    const parts = entries.filter((e) => inBounds(e.timestamp, bounds)).map((e) => e.text);
    if (parts.length > 0) members.push({ name, parts, outsideWindow: false });
  }
  members.push(...selectCrashRecords(sources.crashes, bounds));
  return members;
}

/**
 * The scrubbing the preview's log entries get: the home directory and account
 * names, then known secret shapes. Paths go a line at a time because the
 * account-name patterns stop at separators and quotes but not at newlines, so
 * on a whole file one match could swallow the lines after it.
 */
function scrubMember(content: string): string {
  return scrubSecrets(content.split("\n").map(sanitizePath).join("\n"));
}

/**
 * What the bundle would carry for each window, read once at review time so
 * the dialog can list every file the save will write.
 */
export async function collectBundleManifests(
  dirs: BundleDirs,
  windows: Array<{ id: DiagnosticsTimeWindowId; startMs: number | null }>,
  endMs: number
): Promise<Partial<Record<DiagnosticsTimeWindowId, DiagnosticsBundleMember[]>>> {
  const sources = await readBundleSources(dirs);
  const manifests: Partial<Record<DiagnosticsTimeWindowId, DiagnosticsBundleMember[]>> = {};
  for (const { id, startMs } of windows) {
    manifests[id] = selectBundleMembers(sources, { startMs, endMs }).map(
      ({ name, parts, outsideWindow }) => ({
        name,
        bytes: parts.reduce((sum, part) => sum + Buffer.byteLength(part, "utf8"), 0),
        ...(outsideWindow ? { outsideWindow } : {}),
      })
    );
  }
  return manifests;
}

/** The files to save beside `diagnostics.json`, scrubbed and then run through the user's rules. */
export async function collectBundleMembers(
  dirs: BundleDirs,
  bounds: BundleBounds,
  replacements: ReplacementRule[]
): Promise<Array<{ name: string; content: string }>> {
  const sources = await readBundleSources(dirs);
  return selectBundleMembers(sources, bounds).map(({ name, parts }) => ({
    name,
    content: applyReplacements(scrubMember(parts.join("")), replacements),
  }));
}

export async function writeBundleZip(
  zipPath: string,
  jsonContent: string,
  members: Array<{ name: string; content: string }>
): Promise<void> {
  const { ZipArchive } = await import("archiver");

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath, { mode: 0o600 });
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on("close", () => {
      resolve();
    });
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.append(jsonContent, { name: "diagnostics.json" });

    for (const member of members) {
      archive.append(member.content, { name: member.name });
    }

    void archive.finalize();
  });

  // Belt-and-suspenders: createWriteStream's `mode` is only applied when the
  // file is freshly created. If the user picked an existing path, the prior
  // mode (e.g. 0o644) survives. POSIX-only — chmod is a no-op on Windows.
  if (process.platform !== "win32") {
    await fs.chmod(zipPath, 0o600);
  }
}
