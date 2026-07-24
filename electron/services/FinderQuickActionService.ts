// eager-import-allow: performs sync fs checks while detecting and installing the Finder Quick Action
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { app } from "electron";
import { resilientRenameSync } from "../utils/fs.js";

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

// Finder caches the Services menu, so a freshly copied workflow stays invisible
// until the cache is rebuilt. Best-effort: the Quick Action is on disk either
// way, and a failed flush only delays it until the next login.
async function flushServicesCache(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(PBS_PATH, ["-flush"], { timeout: PBS_FLUSH_TIMEOUT_MS }, (err) => {
      if (err) {
        console.warn("[FinderQuickActionService] pbs -flush failed:", err.message);
      }
      resolve();
    });
  });
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
        // Restore failed too — the backup deliberately stays on disk so the
        // previous Quick Action is recoverable by hand rather than lost.
      }
    }
    throw err;
  }

  removeQuietly(backupPath);
  await flushServicesCache();

  return targetPath;
}
