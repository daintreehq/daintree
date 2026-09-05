import path from "path";
import { createHash } from "crypto";
import { promises as fsp } from "fs";

/** Depth and file-count ceilings on a fingerprint walk. A `dist/` is small. */
const FINGERPRINT_MAX_DEPTH = 8;
const FINGERPRINT_MAX_FILES = 4_000;

/** Fingerprint of a directory that is not there at all. */
export const ABSENT_FINGERPRINT = "absent";

/**
 * A cheap "did this plugin's loadable artifact actually change?" stamp over
 * `plugin.json` + `dist/`: a hash of every file's path, size and mtime at
 * nanosecond resolution.
 *
 * This is not paranoia about redundant work — it is what makes a plugin watcher
 * usable at all. macOS FSEvents replays recent history to a new subscription, so
 * arming a watcher just after a load delivers `create` events for every file the
 * checkout (or the loader itself) had just touched. Without a before/after
 * comparison, every arm would immediately restart everything it had just loaded.
 *
 * Per file rather than aggregated: totalling sizes and taking the newest mtime
 * lets two rewritten chunks cancel each other out, which is exactly the shape a
 * rebuild produces — and the shape a plugin split across several output chunks
 * produces on every save. A missing directory stamps as
 * {@link ABSENT_FINGERPRINT}, which is what makes a deletion a change rather
 * than a silence.
 */
export async function fingerprintPluginDir(dir: string): Promise<string> {
  let files = 0;
  const parts: string[] = [];

  const account = async (relPath: string, filePath: string): Promise<void> => {
    try {
      const stat = await fsp.stat(filePath, { bigint: true });
      files++;
      parts.push(`${relPath}\u0000${stat.size}\u0000${stat.mtimeNs}`);
    } catch {
      // Raced with a delete mid-walk; the next settle sees the settled tree.
    }
  };

  const walk = async (dirPath: string, depth: number): Promise<void> => {
    if (depth > FINGERPRINT_MAX_DEPTH || files >= FINGERPRINT_MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    // Directory order is not stable across filesystems, and the hash is order
    // sensitive.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files >= FINGERPRINT_MAX_FILES) return;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        // Symlinks count too: `stat` follows them, so a repointed link is a
        // changed artifact.
        await account(path.relative(dir, full), full);
      }
    }
  };

  try {
    await fsp.stat(dir);
  } catch {
    return ABSENT_FINGERPRINT;
  }

  await account("plugin.json", path.join(dir, "plugin.json"));
  await walk(path.join(dir, "dist"), 0);
  return createHash("sha1").update(parts.join("\u0001")).digest("hex");
}
