import fs from "fs/promises";
import path from "path";
import { isValidWorkspaceStateId } from "./projectStorePaths.js";
import { resilientUnlink } from "../utils/fs.js";
import { logInfo, logError } from "../utils/logger.js";

const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const QUARANTINE_PREFIXES = [
  "state.json.corrupted.",
  "state.json.future-v",
  "settings.json.corrupted.",
  "recipes.json.corrupted.",
  "recipes.json.future-v",
  "copy-tree-history.json.corrupted.",
  "copy-tree-history.json.future-v",
];

const GLOBAL_RECIPES_QUARANTINE_PREFIXES = ["recipes.json.corrupted."];
const ROOT_CONFIG_QUARANTINE_PREFIXES = ["config.json.corrupted."];

async function sweepDirectoryForPrefixes(
  dir: string,
  prefixes: readonly string[],
  now: number,
  logScope: string,
  projectId?: string
): Promise<number> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let deletedCount = 0;
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const matches = prefixes.some((prefix) => dirent.name.startsWith(prefix));
    if (!matches) continue;

    const filePath = path.join(dir, dirent.name);
    try {
      const stats = await fs.lstat(filePath);
      const ageMs = Math.max(0, now - stats.mtimeMs);
      if (ageMs > QUARANTINE_MAX_AGE_MS) {
        logInfo("quarantine-file-reaped", {
          filename: dirent.name,
          ageMs,
          ...(projectId ? { projectId } : {}),
        });
        await resilientUnlink(filePath);
        deletedCount++;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      logError(`[${logScope}] Failed to clean quarantine file: ${filePath}`, err);
    }
  }

  return deletedCount;
}

export async function cleanupQuarantinedProjectFiles(
  projectsConfigDir: string,
  now: number = Date.now()
): Promise<number> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(projectsConfigDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let deletedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidWorkspaceStateId(entry.name)) continue;

    const projectDir = path.join(projectsConfigDir, entry.name);
    try {
      deletedCount += await sweepDirectoryForPrefixes(
        projectDir,
        QUARANTINE_PREFIXES,
        now,
        "ProjectStore",
        entry.name
      );
    } catch (err) {
      logError(`[ProjectStore] Failed to sweep quarantine in ${projectDir}`, err);
    }
  }

  if (deletedCount > 0) {
    logInfo(`[ProjectStore] Cleaned up ${deletedCount} quarantined file(s)`);
  }

  return deletedCount;
}

export async function cleanupGlobalQuarantineFiles(
  globalConfigDir: string,
  now: number = Date.now()
): Promise<number> {
  const deletedCount = await sweepDirectoryForPrefixes(
    globalConfigDir,
    GLOBAL_RECIPES_QUARANTINE_PREFIXES,
    now,
    "GlobalFileStore"
  );

  if (deletedCount > 0) {
    logInfo(`[GlobalFileStore] Cleaned up ${deletedCount} quarantined file(s)`);
  }

  return deletedCount;
}

export async function cleanupUserDataRootQuarantineFiles(
  userDataDir: string,
  now: number = Date.now()
): Promise<number> {
  const deletedCount = await sweepDirectoryForPrefixes(
    userDataDir,
    ROOT_CONFIG_QUARANTINE_PREFIXES,
    now,
    "Store"
  );

  if (deletedCount > 0) {
    logInfo(`[Store] Cleaned up ${deletedCount} quarantined config file(s)`);
  }

  return deletedCount;
}
