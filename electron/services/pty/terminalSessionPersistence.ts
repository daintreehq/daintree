import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { mkdir, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { resilientRename, resilientRenameSync } from "../../utils/fs.js";
import path from "node:path";
import type { Terminal as HeadlessTerminalType, IMarker } from "@xterm/headless";

export interface RestoreResult {
  restored: boolean;
  bannerStartMarker: IMarker | null;
  bannerEndMarker: IMarker | null;
}

export const TERMINAL_SESSION_PERSISTENCE_ENABLED: boolean =
  process.env.CANOPY_TERMINAL_SESSION_PERSISTENCE !== "0";
export const SESSION_SNAPSHOT_DEBOUNCE_MS = 5000;
export const SESSION_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

export const SESSION_EVICTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_EVICTION_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const EVICTION_TTL_BUFFER_MS = 30_000; // 30s clock-skew safety buffer
const STAT_CHUNK_SIZE = 10;

export function getSessionDir(): string | null {
  const userData = process.env.CANOPY_USER_DATA;
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

export function restoreSessionFromFile(
  headlessTerminal: HeadlessTerminalType,
  terminalId: string
): RestoreResult {
  const sessionPath = getSessionPath(terminalId);
  if (!sessionPath) return NULL_RESTORE;

  try {
    if (!existsSync(sessionPath)) return NULL_RESTORE;
    const content = readFileSync(sessionPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
      return NULL_RESTORE;
    }

    let sessionMtime: number | null = null;
    try {
      sessionMtime = statSync(sessionPath).mtimeMs;
    } catch {
      /* best-effort */
    }

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

    return { restored: true, bannerStartMarker, bannerEndMarker };
  } catch (error) {
    console.warn(
      `[terminalSessionPersistence] Failed to restore session for ${terminalId}:`,
      error
    );
    return NULL_RESTORE;
  }
}

export function persistSessionSnapshotSync(terminalId: string, state: string): void {
  const sessionPath = getSessionPath(terminalId);
  const dir = getSessionDir();
  if (!sessionPath || !dir) return;
  if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;

  mkdirSync(dir, { recursive: true });

  const tmpPath = `${sessionPath}.tmp`;
  try {
    writeFileSync(tmpPath, state, "utf8");
    resilientRenameSync(tmpPath, sessionPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

export async function persistSessionSnapshotAsync(
  terminalId: string,
  state: string
): Promise<void> {
  const sessionPath = getSessionPath(terminalId);
  const dir = getSessionDir();
  if (!sessionPath || !dir) return;
  if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;

  await mkdir(dir, { recursive: true });

  const tmpPath = `${sessionPath}.tmp`;
  try {
    await writeFile(tmpPath, state, "utf8");
    await resilientRename(tmpPath, sessionPath);
  } catch (error) {
    unlink(tmpPath).catch(() => {
      /* best-effort cleanup */
    });
    throw error;
  }
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath, "", "utf8");
  } catch {
    // best-effort
  }
}

export function readAndDeleteHibernatedMarker(terminalId: string): boolean {
  const markerPath = getHibernatedMarkerPath(terminalId);
  if (!markerPath) return false;
  try {
    if (!existsSync(markerPath)) return false;
    unlinkSync(markerPath);
    return true;
  } catch {
    return false;
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

  // Clean up orphaned .hibernated markers that have no matching .restore file
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
        }
      }
    } catch {
      // best-effort cleanup
    }
  }

  if (files.length === 0) return { deleted: 0, bytesFreed: 0 };

  const now = Date.now();
  const ttlCutoff = opts.ttlMs + EVICTION_TTL_BUFFER_MS;
  let deleted = 0;
  let bytesFreed = 0;
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
