import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
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
    const label = wasInAlternateScreen
      ? `─── Restored · ${ts} · previous session was in a full-screen app ───`
      : `─── Session restored · ${ts} ───`;

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
