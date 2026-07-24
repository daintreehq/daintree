// eager-import-allow: performs sync fs checks while detecting and installing the Finder Quick Action
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { app } from "electron";
import { resilientRenameSync } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

// A Finder Quick Action cannot be declared by the app bundle itself: macOS
// routes a Services selection to a compiled `NSApp setServicesProvider:`
// object, which Electron does not expose. The supported shape is an Automator
// `.workflow` living in ~/Library/Services, so the bundle ships as an inert
// resource and is copied there on demand — the same on-demand install model as
// CliInstallService.
const WORKFLOW_BUNDLE_NAME = "Open in Daintree.workflow";

// The only two files inside the bundle that Daintree owns. Finder writes its
// own metadata alongside them once the Quick Action is registered, so freshness
// is judged on these and never on a whole-directory comparison.
const MANAGED_BUNDLE_FILES = [
  path.join("Contents", "Info.plist"),
  path.join("Contents", "document.wflow"),
];

const PBS_PATH = "/System/Library/CoreServices/pbs";
const PBS_FLUSH_TIMEOUT_MS = 5000;

const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const LSREGISTER_TIMEOUT_MS = 5000;

export interface QuickActionRemoval {
  /** False when nothing was installed at `path`. */
  removed: boolean;
  /** The location the Quick Action lives at, installed or not. */
  path: string;
}

function getTargetPath(): string {
  return path.join(os.homedir(), "Library", "Services", WORKFLOW_BUNDLE_NAME);
}

function getWorkflowSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, WORKFLOW_BUNDLE_NAME);
  }
  // Dev: app path points at project root when running `electron .`
  return path.join(app.getAppPath(), "build", "macos", WORKFLOW_BUNDLE_NAME);
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isInstallUpToDate(sourcePath: string, targetPath: string): boolean {
  return MANAGED_BUNDLE_FILES.every((relativePath) => {
    const sourceContent = readFileIfExists(path.join(sourcePath, relativePath));
    const targetContent = readFileIfExists(path.join(targetPath, relativePath));
    return sourceContent !== null && sourceContent === targetContent;
  });
}

function removeQuietly(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    /* cleanup is best-effort */
  }
}

// Every subprocess here only nudges a system cache — the bundle's presence on
// disk is the real state. A failure is logged and swallowed so it can never
// take down an install or a removal.
async function runQuietly(file: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err) => {
      if (err) {
        console.warn(
          `[FinderQuickActionService] ${path.basename(file)} ${args.join(" ")} failed:`,
          err.message
        );
      }
      resolve();
    });
  });
}

// Finder caches the Services menu, so a freshly copied workflow stays invisible
// until the cache is rebuilt — and a removed one stays visible, failing through
// Launch Services when picked.
async function flushServicesCache(): Promise<void> {
  await runQuietly(PBS_PATH, ["-flush"], PBS_FLUSH_TIMEOUT_MS);
}

// Launch Services keeps its own record of the bundle keyed by path. Without an
// explicit unregister it can keep dispatching to a workflow that no longer
// exists; `-u` targets exactly this path (never the whole database — a `-kill`
// rebuild is deprecated and corrupts unrelated system state).
async function unregisterFromLaunchServices(targetPath: string): Promise<void> {
  await runQuietly(LSREGISTER_PATH, ["-u", targetPath], LSREGISTER_TIMEOUT_MS);
}

/** Install the Finder Quick Action, returning the path it now lives at. */
export async function install(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The Finder Quick Action is only available on macOS.");
  }

  const sourcePath = getWorkflowSourcePath();
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Quick Action source not found: ${sourcePath}`);
  }

  const targetPath = getTargetPath();
  if (isInstallUpToDate(sourcePath, targetPath)) {
    // Still flush: an earlier install may have copied the bundle successfully
    // but failed to refresh Finder, and re-running the menu action is the only
    // retry a user has.
    await flushServicesCache();
    return targetPath;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagePath = `${targetPath}.${suffix}.tmp`;
  const backupPath = `${targetPath}.${suffix}.bak`;
  let backedUp = false;

  try {
    // Stage the complete bundle beside the target before touching it. Finder
    // reads ~/Library/Services continuously, so copying in place would expose a
    // half-written Quick Action, and a mid-copy failure would leave the
    // previous working one destroyed.
    fs.cpSync(sourcePath, stagePath, { recursive: true });

    if (fs.existsSync(targetPath)) {
      resilientRenameSync(targetPath, backupPath);
      backedUp = true;
    }
    resilientRenameSync(stagePath, targetPath);
  } catch (err) {
    removeQuietly(stagePath);
    if (backedUp && !fs.existsSync(targetPath)) {
      try {
        resilientRenameSync(backupPath, targetPath);
      } catch {
        // Restore failed too. The backup deliberately stays on disk, and its
        // location is surfaced so the previous Quick Action is recoverable by
        // hand rather than silently stranded under a random suffix.
        throw new Error(
          `Failed to install the Quick Action and could not restore the previous one. It is preserved at ${backupPath}. Original error: ${formatErrorMessage(err, "unknown error")}`
        );
      }
    }
    throw err;
  }

  if (backedUp) removeQuietly(backupPath);
  await flushServicesCache();

  return targetPath;
}

/**
 * Remove the Finder Quick Action. Uninstalling Daintree cannot do this — the
 * bundle lives in the user's home, outside anything the app installer owns — so
 * without this inverse a stale Quick Action keeps appearing in Finder and fails
 * through Launch Services with an Automator error for good.
 */
export async function remove(): Promise<QuickActionRemoval> {
  if (process.platform !== "darwin") {
    throw new Error("The Finder Quick Action is only available on macOS.");
  }

  const targetPath = getTargetPath();
  if (!fs.existsSync(targetPath)) {
    return { removed: false, path: targetPath };
  }

  // Unregister first: once the bundle is deleted there is no longer anything
  // at that path for Launch Services to be told about.
  await unregisterFromLaunchServices(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  await flushServicesCache();

  return { removed: true, path: targetPath };
}
