import { open } from "node:fs/promises";
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
  for (let i = MAX_ROTATED_LOG_INDEX; i >= 1; i--) {
    const result = await readFirstTimestampMs(path.join(logDir, `daintree.log.${i}`));
    if (result !== undefined) return result;
  }
  return (await readFirstTimestampMs(activeLogFile)) ?? null;
}
