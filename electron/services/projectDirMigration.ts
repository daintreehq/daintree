import fs from "fs/promises";
import path from "path";

const DAINTREE_DIR = ".daintree";
const LEGACY_CANOPY_DIR = ".canopy";

// Paths where migration has either succeeded OR has been definitively
// determined to be unnecessary (e.g. .daintree already exists, no legacy
// dir, or legacy is a symlink). Transient failures are NOT cached so a
// later call can retry after a filesystem blip.
const settledPaths = new Set<string>();

/**
 * One-shot migration from `.canopy/` to `.daintree/` for a project directory.
 *
 * If `.daintree/` is absent but `.canopy/` exists, rename. Safe to call
 * repeatedly — success and "nothing-to-do" outcomes are cached per process,
 * transient rename errors are not so retries remain possible.
 */
export async function ensureDaintreeDirMigrated(projectPath: string): Promise<void> {
  if (settledPaths.has(projectPath)) return;

  const daintreePath = path.join(projectPath, DAINTREE_DIR);
  const canopyPath = path.join(projectPath, LEGACY_CANOPY_DIR);

  try {
    await fs.access(daintreePath);
    settledPaths.add(projectPath); // Already migrated or fresh install.
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      // Unknown access error — don't cache; let caller retry.
      return;
    }
  }

  try {
    const stat = await fs.lstat(canopyPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      settledPaths.add(projectPath);
      return;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      settledPaths.add(projectPath); // No legacy dir — nothing to do.
    }
    return;
  }

  try {
    await fs.rename(canopyPath, daintreePath);
    settledPaths.add(projectPath);
    console.log(`[daintree] Migrated ${canopyPath} -> ${daintreePath}`);
  } catch (error) {
    // Transient failure — leave uncached so a subsequent call can retry.
    console.warn(`[daintree] Failed to migrate ${canopyPath}:`, error);
  }
}
