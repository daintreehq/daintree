// eager-import-allow: reads/writes terminal session snapshots via sync fs
import { readFileSync, statSync, unlinkSync, mkdirSync } from "fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import {
  resilientAtomicWriteFile,
  resilientAtomicWriteFileSync,
  tightenDirPermissions,
  tightenDirPermissionsSync,
  OWNER_RW_FILE_MODE,
  OWNER_RWX_DIR_MODE,
} from "../../utils/fs.js";
import path from "node:path";
import type { Terminal as HeadlessTerminalType, IMarker } from "@xterm/headless";
import type {
  SerializedTerminalSnapshot,
  TerminalGeometry,
} from "../../../shared/types/terminal.js";
import { isValidTerminalGeometry } from "../../../shared/types/terminal.js";

export interface RestoreResult {
  restored: boolean;
  bannerStartMarker: IMarker | null;
  bannerEndMarker: IMarker | null;
}

export const TERMINAL_SESSION_PERSISTENCE_ENABLED: boolean =
  process.env.DAINTREE_TERMINAL_SESSION_PERSISTENCE !== "0";
export const SESSION_SNAPSHOT_DEBOUNCE_MS = 5000;
export const SESSION_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

// Defence-in-depth reset before replaying a serialized snapshot. DECSTR (\x1b[!p)
// clears DEC private modes the parser holds (e.g. bracketed paste 2004, focus
// events 1004) without touching scrollback. The Kitty keyboard pop (\x1b[=0u) and
// DECSCUSR default (\x1b[0 q) cover the cursor and Kitty state, which neither
// DECSTR nor the serialize addon track. The serialize addon already replays the
// mouse-tracking and bracketed-paste modes that were active when the snapshot was
// taken, so the preamble's role is to clear whatever drift accumulated in the
// parser before the replay reapplies the captured state.
export const RESTORE_PARSER_RESET_PREAMBLE = "\x1b[!p\x1b[=0u\x1b[0 q";

let sessionPersistSuppressed = false;

export function setSessionPersistSuppressed(v: boolean): void {
  sessionPersistSuppressed = v;
}

export function isSessionPersistSuppressed(): boolean {
  return sessionPersistSuppressed;
}

export const SESSION_EVICTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_EVICTION_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const EVICTION_TTL_BUFFER_MS = 30_000; // 30s clock-skew safety buffer
const STAT_CHUNK_SIZE = 10;
// Grace period before sweeping orphaned atomic-write `.tmp` files. The atomic
// write retry budget is 10s; 5min gives generous headroom while still reclaiming
// crash artifacts on the next eviction sweep.
const TMP_ORPHAN_TTL_MS = 5 * 60 * 1000;

const SESSION_HEADER_V1 = "DAINTREE_SESSION_v1\n";
const SESSION_HEADER = "DAINTREE_SESSION_v2\n";
const SESSION_HEADER_BYTES = Buffer.byteLength(SESSION_HEADER, "utf8");
// v2 adds a `<cols>x<rows>\n` line after the version line. Four digits per
// dimension is well past MAX_TERMINAL_GRID_DIMENSION, so this bounds the whole
// preamble for the size gate.
const SESSION_GEOMETRY_LINE_MAX_BYTES = "9999x9999\n".length;
const SESSION_PREAMBLE_MAX_BYTES = SESSION_HEADER_BYTES + SESSION_GEOMETRY_LINE_MAX_BYTES;
const VERSION_PREFIX = "DAINTREE_SESSION_";

/**
 * A parsed session file: the replayable payload plus the grid it was captured
 * at, when the file records one (#11552).
 *
 * `geometry` is null for v1 and headerless legacy files — those predate the
 * contract and are replayed verbatim, exactly as before. A *v2* file that
 * fails to parse is rejected outright rather than downgraded: v2 asserts the
 * metadata is present, so a malformed line means a corrupt file, and sizing a
 * real xterm from garbage is worse than skipping the restore.
 */
interface ParsedSessionFile {
  content: string;
  geometry: TerminalGeometry | null;
}

function extractSessionContent(raw: string): ParsedSessionFile | null {
  if (!raw) return { content: raw, geometry: null };

  if (raw.startsWith(SESSION_HEADER)) {
    const rest = raw.slice(SESSION_HEADER_BYTES);
    const newlineIndex = rest.indexOf("\n");
    if (newlineIndex === -1) {
      console.warn(`[terminalSessionPersistence] v2 session file has no geometry line, rejecting`);
      return null;
    }
    const geometry = parseGeometryLine(rest.slice(0, newlineIndex));
    if (!geometry) {
      console.warn(
        `[terminalSessionPersistence] v2 session file has an unparseable geometry line, rejecting`
      );
      return null;
    }
    return { content: rest.slice(newlineIndex + 1), geometry };
  }

  if (raw.startsWith(SESSION_HEADER_V1)) {
    return { content: raw.slice(Buffer.byteLength(SESSION_HEADER_V1, "utf8")), geometry: null };
  }

  if (raw.startsWith(VERSION_PREFIX)) {
    console.warn(`[terminalSessionPersistence] Unknown session file version, rejecting restore`);
    return null;
  }

  // A truncated write that only got as far as a prefix of the version marker
  // is not payload — reject rather than replaying "DAINTREE_SES" as content.
  if (raw.length < VERSION_PREFIX.length && VERSION_PREFIX.startsWith(raw)) {
    return null;
  }

  return { content: raw, geometry: null };
}

function parseGeometryLine(line: string): TerminalGeometry | null {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(line);
  if (!match) return null;
  const geometry = { cols: Number(match[1]), rows: Number(match[2]) };
  return isValidTerminalGeometry(geometry) ? geometry : null;
}

function formatSessionFile(snapshot: SerializedTerminalSnapshot): string {
  return `${SESSION_HEADER}${snapshot.cols}x${snapshot.rows}\n${snapshot.data}`;
}

export function getSessionDir(): string | null {
  const userData = process.env.DAINTREE_USER_DATA;
  if (!userData) return null;
  return path.join(userData, "terminal-sessions");
}

function normalizeTerminalId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    path.isAbsolute(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function getSessionPath(id: string): string | null {
  const dir = getSessionDir();
  if (!dir) return null;
  const safeId = normalizeTerminalId(id);
  if (!safeId) return null;
  return path.join(dir, `${safeId}.restore`);
}

const NULL_RESTORE: RestoreResult = {
  restored: false,
  bannerStartMarker: null,
  bannerEndMarker: null,
};

function formatRestoreTimestamp(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ReplayAlignment {
  /** Queue the reflow back to the pre-replay grid behind the replay writes. */
  scheduleRestore(): void;
}

const NO_ALIGNMENT: ReplayAlignment = { scheduleRestore: () => {} };

/**
 * Size `headlessTerminal` to the grid a snapshot was captured on, and hand back
 * the means to reflow it home once the replay has parsed (#11552).
 *
 * A no-op when the snapshot carries no geometry (a v1/legacy file) or already
 * matches — legacy payloads replay exactly as they did before, which is no
 * worse than the status quo and strictly better than dropping the session.
 */
function alignForReplay(
  headlessTerminal: HeadlessTerminalType,
  captureGeometry: TerminalGeometry | null
): ReplayAlignment {
  if (!captureGeometry) return NO_ALIGNMENT;

  const liveCols = headlessTerminal.cols;
  const liveRows = headlessTerminal.rows;
  if (captureGeometry.cols === liveCols && captureGeometry.rows === liveRows) {
    return NO_ALIGNMENT;
  }

  headlessTerminal.resize(captureGeometry.cols, captureGeometry.rows);

  return {
    scheduleRestore: () => {
      headlessTerminal.write("", () => {
        // Hop out of the write callback before resizing: it runs inside xterm's
        // parser drain, and changing the grid there re-applies the chunk being
        // drained against the new geometry (a 4-cell write comes back as 8).
        // A microtask lands after the drain and before any live PTY output.
        queueMicrotask(() => {
          // xterm leaves the cursor's own wrapped group unreflowed unless
          // `reflowCursorLine` is on, so normalizing to a narrower grid would
          // TRUNCATE that row's tail rather than wrap it. Enable it for this one
          // corrective resize and put the configured value straight back — the
          // option is a live-typing ergonomic, not something to change globally.
          const previous = headlessTerminal.options.reflowCursorLine;
          headlessTerminal.options.reflowCursorLine = true;
          try {
            headlessTerminal.resize(liveCols, liveRows);
          } catch (error) {
            console.warn(`[terminalSessionPersistence] Failed to restore session geometry:`, error);
          } finally {
            headlessTerminal.options.reflowCursorLine = previous;
          }
        });
      });
    },
  };
}

export function restoreSessionFromFile(
  headlessTerminal: HeadlessTerminalType,
  terminalId: string
): RestoreResult {
  const sessionPath = getSessionPath(terminalId);
  if (!sessionPath) return NULL_RESTORE;

  try {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(sessionPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return NULL_RESTORE;
      throw e;
    }
    if (stat.size > SESSION_SNAPSHOT_MAX_BYTES + SESSION_PREAMBLE_MAX_BYTES) {
      console.warn(
        `[terminalSessionPersistence] Session snapshot too large for ${terminalId} (${stat.size} bytes), skipping restore`
      );
      return NULL_RESTORE;
    }
    const raw = readFileSync(sessionPath, "utf8");
    const parsed = extractSessionContent(raw);
    if (parsed === null) return NULL_RESTORE;
    const { content, geometry: captureGeometry } = parsed;
    if (Buffer.byteLength(content, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
      // Belt-and-suspenders: file may have grown between statSync and readFileSync.
      console.warn(
        `[terminalSessionPersistence] Session snapshot grew past size limit for ${terminalId}, skipping restore`
      );
      return NULL_RESTORE;
    }
    const sessionMtime: number = stat.mtimeMs;

    // Replay at the grid the snapshot was captured on, then reflow to the grid
    // this process actually spawned at (#11552). The mirror is brand new and
    // empty here, so aligning it up front costs nothing — and it must happen
    // BEFORE the writes, because xterm parses asynchronously: content queued
    // now is laid out at whatever cols the terminal has when the parser drains.
    const alignment = alignForReplay(headlessTerminal, captureGeometry);

    headlessTerminal.write(RESTORE_PARSER_RESET_PREAMBLE);
    headlessTerminal.write(content);

    const wasInAlternateScreen = headlessTerminal.buffer.active.type === "alternate";
    if (wasInAlternateScreen) {
      headlessTerminal.write("\x1b[?1049l");
    }

    const ts = sessionMtime ? formatRestoreTimestamp(sessionMtime) : "";
    const wasHibernated = readAndDeleteHibernatedMarker(terminalId);
    let label: string;
    if (wasHibernated) {
      label = wasInAlternateScreen
        ? `─── Restored · ${ts} · session was auto-hibernated to save resources ───`
        : `─── Session hibernated · ${ts} · auto-suspended to save resources ───`;
    } else {
      label = wasInAlternateScreen
        ? `─── Restored · ${ts} · previous session was in a full-screen app ───`
        : `─── Session restored · ${ts} ───`;
    }

    headlessTerminal.write("\r\n");
    const bannerStartMarker = headlessTerminal.registerMarker(0) ?? null;
    headlessTerminal.write(`\x1b[2m\x1b[38;5;240m${label}\x1b[0m\r\n`);
    const bannerEndMarker = headlessTerminal.registerMarker(0) ?? null;

    // Queued behind the replay so it runs once the parser has laid the content
    // out at the capture grid. Live PTY output written after this point queues
    // behind the callback and therefore parses at the restored geometry.
    alignment.scheduleRestore();

    return { restored: true, bannerStartMarker, bannerEndMarker };
  } catch (error) {
    // Stat→read race: file vanished between size gate and read. Treat as the
    // normal "no prior session" path rather than logging restore noise.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NULL_RESTORE;
    console.warn(
      `[terminalSessionPersistence] Failed to restore session for ${terminalId}:`,
      error
    );
    return NULL_RESTORE;
  }
}

export function persistSessionSnapshotSync(
  terminalId: string,
  snapshot: SerializedTerminalSnapshot
): void {
  const sessionPath = getSessionPath(terminalId);
  const dir = getSessionDir();
  if (!sessionPath || !dir) return;
  const bytes = Buffer.byteLength(snapshot.data, "utf8");
  if (bytes > SESSION_SNAPSHOT_MAX_BYTES) {
    console.warn(
      `[terminalSessionPersistence] Snapshot for ${terminalId} exceeds cap (${bytes} > ${SESSION_SNAPSHOT_MAX_BYTES} bytes); skipping persist`
    );
    return;
  }

  mkdirSync(dir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
  tightenDirPermissionsSync(dir);
  resilientAtomicWriteFileSync(sessionPath, formatSessionFile(snapshot), "utf8", {
    mode: OWNER_RW_FILE_MODE,
  });
}

export async function persistSessionSnapshotAsync(
  terminalId: string,
  snapshot: SerializedTerminalSnapshot
): Promise<void> {
  const sessionPath = getSessionPath(terminalId);
  const dir = getSessionDir();
  if (!sessionPath || !dir) return;
  const bytes = Buffer.byteLength(snapshot.data, "utf8");
  if (bytes > SESSION_SNAPSHOT_MAX_BYTES) {
    console.warn(
      `[terminalSessionPersistence] Snapshot for ${terminalId} exceeds cap (${bytes} > ${SESSION_SNAPSHOT_MAX_BYTES} bytes); skipping persist`
    );
    return;
  }

  await mkdir(dir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
  await tightenDirPermissions(dir);
  await resilientAtomicWriteFile(sessionPath, formatSessionFile(snapshot), "utf8", {
    mode: OWNER_RW_FILE_MODE,
  });
}

export async function deleteSessionFile(terminalId: string): Promise<void> {
  const sessionPath = getSessionPath(terminalId);
  if (!sessionPath) return;
  await unlink(sessionPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  // Clean up any associated hibernation marker
  const markerPath = getHibernatedMarkerPath(terminalId);
  if (markerPath) {
    await unlink(markerPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}

export function getHibernatedMarkerPath(terminalId: string): string | null {
  const dir = getSessionDir();
  if (!dir) return null;
  const safeId = normalizeTerminalId(terminalId);
  if (!safeId) return null;
  return path.join(dir, `${safeId}.hibernated`);
}

export function writeHibernatedMarker(terminalId: string): void {
  const markerPath = getHibernatedMarkerPath(terminalId);
  if (!markerPath) return;
  const dir = getSessionDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
    tightenDirPermissionsSync(dir);
    resilientAtomicWriteFileSync(markerPath, "", "utf8", { mode: OWNER_RW_FILE_MODE });
  } catch {
    // best-effort
  }
}

export function readAndDeleteHibernatedMarker(terminalId: string): boolean {
  const markerPath = getHibernatedMarkerPath(terminalId);
  if (!markerPath) return false;
  try {
    unlinkSync(markerPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

interface SessionFileInfo {
  id: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

async function scanSessionFiles(): Promise<SessionFileInfo[]> {
  const dir = getSessionDir();
  if (!dir) return [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const restoreFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".restore"));
  const results: SessionFileInfo[] = [];

  for (let i = 0; i < restoreFiles.length; i += STAT_CHUNK_SIZE) {
    const chunk = restoreFiles.slice(i, i + STAT_CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        try {
          const s = await stat(filePath);
          return {
            id: entry.name.replace(/\.restore$/, ""),
            filePath,
            size: s.size,
            mtimeMs: s.mtimeMs,
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of chunkResults) {
      if (r) results.push(r);
    }
  }

  return results;
}

export async function evictSessionFiles(opts: {
  ttlMs: number;
  maxBytes: number;
  knownIds?: Set<string>;
}): Promise<{ deleted: number; bytesFreed: number }> {
  const files = await scanSessionFiles();
  const now = Date.now();
  let deleted = 0;
  let bytesFreed = 0;

  // Clean up orphaned .hibernated markers and stale `.tmp` files left by
  // crashed atomic writes. Both run before the .restore eviction passes so
  // their sweep is opportunistic even when no .restore files exist.
  const dir = getSessionDir();
  if (dir) {
    try {
      const allEntries = await readdir(dir);
      const restoreIds = new Set(files.map((f) => f.id));
      for (const entry of allEntries) {
        if (entry.endsWith(".hibernated")) {
          const id = entry.replace(/\.hibernated$/, "");
          if (!restoreIds.has(id)) {
            await unlink(path.join(dir, entry)).catch(() => {});
          }
          continue;
        }
        if (entry.includes(".restore.") && entry.endsWith(".tmp")) {
          const tmpPath = path.join(dir, entry);
          let size: number;
          let mtimeMs: number;
          try {
            const s = await stat(tmpPath);
            size = s.size;
            mtimeMs = s.mtimeMs;
          } catch {
            continue;
          }
          if (now - mtimeMs < TMP_ORPHAN_TTL_MS) continue;
          try {
            await unlink(tmpPath);
            deleted++;
            bytesFreed += size;
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn(`[sessionEviction] Failed to delete ${tmpPath}:`, e);
            }
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  if (files.length === 0) return { deleted, bytesFreed };

  const ttlCutoff = opts.ttlMs + EVICTION_TTL_BUFFER_MS;
  const survivors: SessionFileInfo[] = [];

  // Pass 1: TTL + orphan eviction
  for (const file of files) {
    const isExpired = now - file.mtimeMs > ttlCutoff;
    const isOrphan = opts.knownIds !== undefined && !opts.knownIds.has(file.id);

    if (isExpired || isOrphan) {
      try {
        await unlink(file.filePath);
        deleted++;
        bytesFreed += file.size;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[sessionEviction] Failed to delete ${file.filePath}:`, e);
        }
      }
    } else {
      survivors.push(file);
    }
  }

  // Pass 2: size cap enforcement (oldest first)
  let totalSize = survivors.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > opts.maxBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of survivors) {
      if (totalSize <= opts.maxBytes) break;
      try {
        await unlink(file.filePath);
        deleted++;
        bytesFreed += file.size;
        totalSize -= file.size;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[sessionEviction] Failed to delete ${file.filePath}:`, e);
        }
      }
    }
  }

  return { deleted, bytesFreed };
}
