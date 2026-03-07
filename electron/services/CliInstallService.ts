import fs from "fs";
import path from "path";
import os from "os";
import { app } from "electron";
import type { CliInstallStatus } from "../../shared/types/ipc/system.js";

const INSTALL_TARGETS_MACOS = ["/usr/local/bin/canopy", `${os.homedir()}/.local/bin/canopy`];
const INSTALL_TARGETS_LINUX = ["/usr/local/bin/canopy", `${os.homedir()}/.local/bin/canopy`];
const SYMLINK_FALLBACK_ERROR_CODES = new Set(["EINVAL", "ENOSYS", "EOPNOTSUPP", "EPERM"]);

function getInstallTargets(): string[] {
  if (process.platform === "darwin") return INSTALL_TARGETS_MACOS;
  if (process.platform === "linux") return INSTALL_TARGETS_LINUX;
  return [];
}

function getScriptSourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "canopy-cli.sh");
  }
  // Dev: app path points at project root when running `electron .`
  return path.join(app.getAppPath(), "scripts", "canopy-cli.sh");
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function getRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function asNodeError(err: unknown): NodeJS.ErrnoException {
  return err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err));
}

function canFallbackToCopy(err: unknown): boolean {
  const code = asNodeError(err).code;
  return typeof code === "string" && SYMLINK_FALLBACK_ERROR_CODES.has(code);
}

function isInstallUpToDate(targetPath: string, sourcePath: string): boolean {
  const sourceRealPath = getRealPath(sourcePath);
  if (!sourceRealPath) {
    return false;
  }

  try {
    const targetStats = fs.lstatSync(targetPath);
    if (targetStats.isSymbolicLink()) {
      return getRealPath(targetPath) === sourceRealPath;
    }
  } catch {
    return false;
  }

  const sourceContent = readFileIfExists(sourcePath);
  const targetContent = readFileIfExists(targetPath);
  return sourceContent !== null && targetContent !== null && sourceContent === targetContent;
}

function installAtTarget(targetPath: string, sourcePath: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(targetPath)) {
    if (isInstallUpToDate(targetPath, sourcePath)) {
      return;
    }
    fs.unlinkSync(targetPath);
  }

  try {
    fs.symlinkSync(sourcePath, targetPath);
  } catch (err) {
    if (!canFallbackToCopy(err)) {
      throw err;
    }

    const sourceContent = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(targetPath, sourceContent, { mode: 0o755 });
    fs.chmodSync(targetPath, 0o755);
  }
}

export async function install(): Promise<CliInstallStatus> {
  const sourcePath = getScriptSourcePath();

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`CLI script source not found: ${sourcePath}`);
  }

  const targets = getInstallTargets();
  if (targets.length === 0) {
    throw new Error("CLI installation is not supported on this platform.");
  }

  let lastError: Error | null = null;

  for (const target of targets) {
    try {
      installAtTarget(target, sourcePath);
      console.log(`[CliInstallService] Installed to ${target}`);
      return { installed: true, upToDate: true, path: target };
    } catch (err) {
      lastError = asNodeError(err);
      console.warn(`[CliInstallService] Could not write to ${target}:`, lastError.message);
    }
  }

  throw lastError ?? new Error("Failed to install CLI: no writable target found.");
}

export function getStatus(): CliInstallStatus {
  const sourcePath = getScriptSourcePath();
  const targets = getInstallTargets();

  for (const target of targets) {
    if (fs.existsSync(target)) {
      return {
        installed: true,
        upToDate: isInstallUpToDate(target, sourcePath),
        path: target,
      };
    }
  }

  return { installed: false, upToDate: false, path: targets[0] ?? "" };
}
