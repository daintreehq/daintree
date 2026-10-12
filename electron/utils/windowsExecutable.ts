import { lstatSync, statSync } from "node:fs";
import path from "node:path";

// Given a bare program name, Windows process creation (and Node's spawn, which
// mirrors it) looks in the working directory before PATH, so a same-named file
// in a repository root would run in place of the tool. Everything here hands
// spawn an absolute path instead, and never consults the working directory.

const SYSTEM_TOOLS = {
  "cmd.exe": ["System32", "cmd.exe"],
  "powershell.exe": ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
  "reg.exe": ["System32", "reg.exe"],
  "where.exe": ["System32", "where.exe"],
  "wsl.exe": ["System32", "wsl.exe"],
} as const satisfies Record<string, readonly string[]>;

export type WindowsSystemTool = keyof typeof SYSTEM_TOOLS;

// Drive-qualified (`C:\tools`) or UNC (`\\server\share`). `C:tools` and
// `\tools` both depend on the working directory, so neither counts.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

const RESOLVED_CACHE_LIMIT = 64;
const resolved = new Map<string, string>();

/** The key Node forwards for `name`: matched case-insensitively, first in sort order. */
export function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  return Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === wanted);
}

export function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = windowsEnvKey(env, name);
  return key === undefined ? undefined : env[key];
}

export function isWindowsLaunchFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Windows Store execution aliases are reparse points: stat reports EACCES,
    // while CreateProcess can still launch the alias by its resolved file name.
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

export function windowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ["SYSTEMROOT", "WINDIR"]) {
    const value = windowsEnvValue(env, name);
    if (value && WINDOWS_ABSOLUTE.test(value)) return value;
  }
  return "C:\\Windows";
}

/** Absolute path of an in-box Windows tool under `%SystemRoot%`. */
export function windowsSystemTool(
  name: WindowsSystemTool,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.win32.join(windowsSystemRoot(env), ...SYSTEM_TOOLS[name]);
}

export interface WindowsExecutableOptions {
  isFile?: (file: string) => boolean;
}

/**
 * Absolute path of the first `name` found in the PATH directories, or `name`
 * unchanged when none has it (spawn then behaves as it always did). A name
 * without an extension is tried as `.exe`, then `.com`: the files process
 * creation starts directly. Empty, `.` and other relative PATH entries are
 * skipped, so the working directory is never searched.
 *
 * Paths are built the host's way, which is `path.win32` wherever this runs for
 * real; the POSIX branch is what lets tests search real temporary directories.
 */
export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsExecutableOptions = {}
): string {
  if (!name || /[\\/:]/.test(name)) return name;
  const searchPath = windowsEnvValue(env, "PATH") ?? "";
  const key = `${name.toLowerCase()}\0${searchPath}`;
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;

  const isWindows = process.platform === "win32";
  const paths = isWindows ? path.win32 : path.posix;
  const isFile = options.isFile ?? isWindowsLaunchFile;
  const files = paths.extname(name) ? [name] : [`${name}.exe`, `${name}.com`];
  for (const entry of searchPath.split(";")) {
    const directory =
      entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
    const absolute = isWindows ? WINDOWS_ABSOLUTE.test(directory) : paths.isAbsolute(directory);
    if (!absolute) continue;
    for (const file of files) {
      const candidate = paths.join(directory, file);
      if (!isFile(candidate)) continue;
      if (resolved.size >= RESOLVED_CACHE_LIMIT) resolved.clear();
      resolved.set(key, candidate);
      return candidate;
    }
  }
  return name;
}

/** `name` for spawn: its absolute PATH location on Windows, unchanged elsewhere. */
export function executableForSpawn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? resolveWindowsExecutable(name, env) : name;
}

/** Test seam: forget every resolved path. */
export function resetWindowsExecutableCache(): void {
  resolved.clear();
}
