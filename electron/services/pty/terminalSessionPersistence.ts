import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";

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

export function restoreSessionFromFile(
  headlessTerminal: HeadlessTerminalType,
  terminalId: string
): void {
  const sessionPath = getSessionPath(terminalId);
  if (!sessionPath) return;

  try {
    if (!existsSync(sessionPath)) return;
    const content = readFileSync(sessionPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
      return;
    }
    headlessTerminal.write(content);
  } catch (error) {
    console.warn(
      `[terminalSessionPersistence] Failed to restore session for ${terminalId}:`,
      error
    );
  }
}

export function persistSessionSnapshotSync(terminalId: string, state: string): void {
  const sessionPath = getSessionPath(terminalId);
  const dir = getSessionDir();
  if (!sessionPath || !dir) return;
  if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;

  mkdirSync(dir, { recursive: true });

  const tmpPath = `${sessionPath}.tmp`;
  writeFileSync(tmpPath, state, "utf8");
  renameSync(tmpPath, sessionPath);
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
  await writeFile(tmpPath, state, "utf8");
  await rename(tmpPath, sessionPath);
}
