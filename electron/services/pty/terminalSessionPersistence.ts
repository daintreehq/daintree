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
import { headlessMirrorScheduler } from "./HeadlessMirrorScheduler.js";
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
// v2 adds a `<cols>x<rows>\n` line after the version line. The writer only ever
// emits a geometry `isValidTerminalGeometry` accepts (four digits per dimension
// is already past MAX_TERMINAL_GRID_DIMENSION), so this bounds the whole
// preamble for the size gate.
const SESSION_GEOMETRY_LINE_MAX_BYTES = "9999x9999\n".length;
const SESSION_PREAMBLE_MAX_BYTES = SESSION_HEADER_BYTES + SESSION_GEOMETRY_LINE_MAX_BYTES;
const VERSION_PREFIX = "DAINTREE_SESSION_";

/**
 * A parsed session file: the replayable payload plus the grid it was captured
 * at, when the file records one (#11552).
 *
 * `geometry` is null for v1 and headerless legacy files — those predate the
 * contract and are replayed verbatim, exactly as before. A v2 file whose
 * geometry line is unusable degrades to the SAME null: an unreadable grid costs
 * the alignment, never the scrollback, because replaying without alignment is
 * exactly what v1 did while dropping the file loses a session outright. Only a
 * v2 file with no geometry line at all is rejected — the writer always emits
 * one, so its absence means the preamble is truncated and there is no way to
 * tell where the payload starts (nor, at that length, any payload to save).
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
        `[terminalSessionPersistence] v2 session file has an unusable geometry line; ` +
          `replaying the session without width alignment`
      );
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

// Digit count is deliberately unbounded here: `isValidTerminalGeometry` is the
// single bound both ends of this format agree on, and a second, tighter one in
// the regex is how a grid the writer could emit came back unreadable.
function parseGeometryLine(line: string): TerminalGeometry | null {
  const match = /^(\d+)x(\d+)$/.exec(line);
  if (!match) return null;
  const geometry = { cols: Number(match[1]), rows: Number(match[2]) };
  return isValidTerminalGeometry(geometry) ? geometry : null;
}

/**
 * Serialize a snapshot to the on-disk session format.
 *
 * A grid the reader would refuse is written as v1 — the format that already
 * means "no capture geometry" — rather than as a v2 file the next restore would
 * choke on. Both ends therefore agree on exactly one bound
 * (`isValidTerminalGeometry`), and an unrepresentable grid costs the width
 * alignment while the scrollback still comes back.
 */
function formatSessionFile(snapshot: SerializedTerminalSnapshot): string {
  if (!isValidTerminalGeometry({ cols: snapshot.cols, rows: snapshot.rows })) {
    return `${SESSION_HEADER_V1}${snapshot.data}`;
  }
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

interface ReplayWindow {
  /** The grid this mirror must end up on once the replay has parsed. */
  target: TerminalGeometry;
}

/**
 * Mirrors with a session replay in flight, and the grid each owes its owner
 * when the replay lands. Keyed by the mirror itself rather than by terminal id
 * so a disposed mirror takes its window with it — the close is driven by an
 * xterm write callback, which a disposal silently cancels.
 */
const replayWindows = new WeakMap<HeadlessTerminalType, ReplayWindow>();

/**
 * The one way to resize a headless mirror (#11552).
 *
 * While a session replay is in flight the mirror is deliberately parked at the
 * snapshot's capture grid so SerializeAddon's wrap encoding decodes the way it
 * was written. A resize applied now would lay the rest of the payload out at
 * the wrong width AND be reverted by the reflow that ends the replay — leaving
 * the mirror on a grid the PTY has already moved off, with nothing to re-sync
 * it (`TerminalProcess.resize` early-returns once the pty dims match). Record
 * the intent instead: it becomes the grid the replay reflows to, so the newest
 * resize wins rather than losing to a value pinned before it arrived.
 *
 * Returns true when the mirror was resized now, false when the resize was
 * parked for the in-flight replay.
 */
export function resizeMirror(
  headlessTerminal: HeadlessTerminalType,
  cols: number,
  rows: number
): boolean {
  const window = replayWindows.get(headlessTerminal);
  if (window) {
    window.target = { cols, rows };
    return false;
  }
  headlessTerminal.resize(cols, rows);
  return true;
}

/**
 * Whether this mirror still owes a resize to reach `cols`x`rows` (#11719).
 *
 * The live grid alone is not the answer. While a replay window is open the
 * mirror is parked at the capture grid and the resize that matters is the
 * PARKED TARGET — the geometry the replay will reflow to when it lands. A
 * mirror whose visible grid happens to match while its parked target is stale
 * is about to diverge, so it needs the re-assert just as much as one whose
 * grid is already wrong.
 *
 * Lives here rather than at the call sites so `replayWindows` stays private.
 */
export function mirrorNeedsResize(
  headlessTerminal: HeadlessTerminalType,
  cols: number,
  rows: number
): boolean {
  const window = replayWindows.get(headlessTerminal);
  if (window) {
    return window.target.cols !== cols || window.target.rows !== rows;
  }
  return headlessTerminal.cols !== cols || headlessTerminal.rows !== rows;
}

/**
 * Whether a session replay currently owns this mirror's grid.
 *
 * Callers need this to tell a mirror that has DRIFTED off the PTY grid from one
 * deliberately parked on a capture grid: the parked mirror's live geometry is
 * expected to disagree, and treating that as divergence produces a false report
 * out of healthy behaviour. It also marks the resizes that will only record an
 * intent, so callers can skip work that only pays off for a resize applying now.
 */
export function mirrorReplayInFlight(headlessTerminal: HeadlessTerminalType): boolean {
  return replayWindows.has(headlessTerminal);
}

/**
 * Park `headlessTerminal` on the grid a snapshot was captured at for the
 * duration of its replay, remembering the grid to return to.
 *
 * The window opens even when there is nothing to align to (a v1/legacy file, or
 * a capture grid that already matches): a resize landing mid-replay would
 * garble the unparsed tail whatever the capture width was, and with the window
 * open it is applied once the payload is down instead. Legacy payloads still
 * replay verbatim, exactly as they did before — no worse than the status quo
 * and strictly better than dropping the session.
 */
function openReplayWindow(
  headlessTerminal: HeadlessTerminalType,
  captureGeometry: TerminalGeometry | null
): void {
  replayWindows.set(headlessTerminal, {
    target: { cols: headlessTerminal.cols, rows: headlessTerminal.rows },
  });
  if (!captureGeometry) return;
  if (
    captureGeometry.cols === headlessTerminal.cols &&
    captureGeometry.rows === headlessTerminal.rows
  ) {
    return;
  }
  headlessTerminal.resize(captureGeometry.cols, captureGeometry.rows);
}

/**
 * Close the replay window and put the mirror on the grid it owes: the one it
 * had when the window opened, or whichever resize landed while it was open.
 * Idempotent, and a no-op when the grid already matches.
 */
function closeReplayWindow(headlessTerminal: HeadlessTerminalType): void {
  const window = replayWindows.get(headlessTerminal);
  if (!window) return;
  replayWindows.delete(headlessTerminal);
  const { cols, rows } = window.target;
  if (cols === headlessTerminal.cols && rows === headlessTerminal.rows) return;

  // xterm leaves the cursor's own wrapped group unreflowed unless
  // `reflowCursorLine` is on, so normalizing to a narrower grid would TRUNCATE
  // that row's tail rather than wrap it. Enable it for this one corrective
  // resize and put the configured value straight back — the option is a
  // live-typing ergonomic, not something to change globally.
  const previous = headlessTerminal.options.reflowCursorLine;
  headlessTerminal.options.reflowCursorLine = true;
  try {
    headlessTerminal.resize(cols, rows);
  } catch (error) {
    console.warn(`[terminalSessionPersistence] Failed to restore session geometry:`, error);
  } finally {
    headlessTerminal.options.reflowCursorLine = previous;
  }
}

/** Queue the window close behind everything the replay put in flight. */
function scheduleReplayWindowClose(
  headlessTerminal: HeadlessTerminalType,
  terminalId: string
): void {
  // Order the reflow behind anything the mirror scheduler is holding for this
  // terminal, not just behind our own writes. Live PTY chunks reach the mirror
  // through that queue with no gate of their own, and resizing while xterm
  // still has queued entries makes its flushSync re-parse from the head of the
  // write buffer — the same duplication this fix exists to prevent. With no
  // queue registered (the usual cold-start case) flush() degrades to a plain
  // sentinel write.
  headlessMirrorScheduler.flush(terminalId, headlessTerminal, () => {
    // Hop out of the write callback before resizing: it runs inside xterm's
    // parser drain, and changing the grid there re-applies the chunk being
    // drained against the new geometry (a 4-cell write comes back as 8). A
    // microtask lands after the drain and before any live PTY output.
    queueMicrotask(() => closeReplayWindow(headlessTerminal));
  });
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
    // this mirror owes its owner (#11552). The mirror is brand new and empty
    // here, so aligning it up front costs nothing — and it must happen BEFORE
    // the writes, because xterm parses asynchronously: content queued now is
    // laid out at whatever cols the terminal has when the parser drains.
    openReplayWindow(headlessTerminal, captureGeometry);

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
      // Neutral wording: the marker is a bare flag with no room for a reason, and
      // the same one is written by the idle sweep, by memory pressure, and by a
      // user asking to sleep the project. "Auto-hibernated" read as a lie for
      // the deliberate case, so the copy names the outcome, not the trigger.
      label = wasInAlternateScreen
        ? `─── Restored · ${ts} · session was preserved while the project was asleep ───`
        : `─── Session restored · ${ts} · preserved while the project was asleep ───`;
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
    scheduleReplayWindowClose(headlessTerminal, terminalId);

    return { restored: true, bannerStartMarker, bannerEndMarker };
  } catch (error) {
    // A replay that died mid-flight still owns the grid and the resize gate —
    // close the window here or every later resize parks into a window nothing
    // will ever drain.
    closeReplayWindow(headlessTerminal);
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
