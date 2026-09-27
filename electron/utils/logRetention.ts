import { access, open } from "node:fs/promises";
import path from "node:path";

// Matches the rotated files writeBundleZip considers.
const MAX_ROTATED_LOG_INDEX = 5;
const PREFIX_BYTES = 64;
const LINE_TIMESTAMP = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/;

/** Reads the leading timestamp; `undefined` when the file doesn't exist. */
async function readFirstTimestampMs(filePath: string): Promise<number | null | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : null;
  }
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0);
    const match = LINE_TIMESTAMP.exec(buffer.toString("utf8", 0, bytesRead));
    if (!match) return null;
    const ms = Date.parse(match[1]);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Epoch ms of the first line in the oldest retained log file, or null when it
 * can't be determined. Rotation shifts files upward (`.1` → `.2` …), so the
 * highest-numbered file that exists holds the oldest retained line; mtime
 * would give its last write, not its first.
 */
export async function readOldestRetainedLogMs(
  logDir: string,
  activeLogFile: string
): Promise<number | null> {
  const files = [
    ...Array.from({ length: MAX_ROTATED_LOG_INDEX }, (_, i) =>
      path.join(logDir, `daintree.log.${MAX_ROTATED_LOG_INDEX - i}`)
    ),
    activeLogFile,
  ];
  // A rotation landing mid-scan can shift an older file into a slot already
  // checked, reporting a newer file as the oldest and wrongly widening the
  // window. Confirm the slot above is still empty; retry once, else unknown.
  for (let attempt = 0; attempt < 2; attempt++) {
    const index = await findFirstExisting(files);
    if (index === -1) return null;
    const result = await readFirstTimestampMs(files[index]);
    if (result === undefined) continue;
    if (index === 0 || (await readFirstTimestampMs(files[index - 1])) === undefined) {
      return result;
    }
  }
  return null;
}

async function findFirstExisting(files: string[]): Promise<number> {
  for (let i = 0; i < files.length; i++) {
    try {
      await access(files[i]);
      return i;
    } catch {
      // Missing (or unreadable) — keep looking further down.
    }
  }
  return -1;
}
