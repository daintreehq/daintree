import { execFile } from "child_process";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

// Given a bare program name, Windows process creation (and Node's spawn, which
// mirrors it) looks in the working directory before PATH, so a same-named file
// in a repository root would run in place of the tool. Everything here resolves
// executables from PATH only, hands spawn an absolute path, and never consults
// the working directory.

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

// What process creation starts directly, in libuv's search order.
const NATIVE_EXTENSIONS = [".com", ".exe"];
// What a shell (and `cliSpawnTarget`) can start; batch files need cmd.exe.
const LAUNCHABLE_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

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

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value);
}

/**
 * PATH's directories in order. A `;` inside double quotes is part of the
 * directory (`"C:\a;b"`), and the quotes themselves are dropped, which is how
 * cmd.exe and libuv read them. Empty entries are skipped.
 */
export function splitWindowsPath(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      if (current) entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** PATHEXT's launchable extensions (`.com`, `.exe`, `.bat`, `.cmd`) in its order and spelling. */
export function windowsLaunchExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const raw of (windowsEnvValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";")) {
    const extension = raw.trim();
    const key = extension.toLowerCase();
    if (!LAUNCHABLE_EXTENSIONS.has(key) || seen.has(key)) continue;
    seen.add(key);
    extensions.push(extension);
  }
  return extensions;
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
 * Paths are built the host's way, which is `path.win32` wherever this runs for
 * real; the POSIX branch is what lets tests search real temporary directories.
 */
function searchDirectories(env: NodeJS.ProcessEnv): {
  directories: string[];
  join: (directory: string, file: string) => string;
} {
  const isWindows = process.platform === "win32";
  const isAbsolute = isWindows ? isWindowsAbsolutePath : path.posix.isAbsolute;
  return {
    directories: splitWindowsPath(windowsEnvValue(env, "PATH") ?? "").filter((entry) =>
      isAbsolute(entry)
    ),
    join: isWindows ? path.win32.join : path.posix.join,
  };
}

function isPathLike(name: string): boolean {
  return /[\\/:]/.test(name);
}

/**
 * Every file a bare `name` could start as from PATH, in PATH order: each
 * directory's matches in PATHEXT order, limited to `.com`, `.exe`, `.bat` and
 * `.cmd` (npm and Scoop install agents as `.cmd` shims). A name that already
 * carries one of those extensions is looked up as given. Relative PATH entries
 * are skipped, so the working directory is never searched. A path, or a name
 * with characters no file name can hold, finds nothing.
 */
export function findWindowsExecutables(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsExecutableOptions & { first?: boolean } = {}
): string[] {
  if (!name || isPathLike(name) || /[\0\r\n"*?<>|]/.test(name)) return [];
  const isFile = options.isFile ?? isWindowsLaunchFile;
  const { directories, join } = searchDirectories(env);
  // Lower-case extensions, as npm, Scoop and installers write them: the result
  // is shown to the user and compared across checks, the way `where` lists it.
  const files = LAUNCHABLE_EXTENSIONS.has(path.win32.extname(name).toLowerCase())
    ? [name]
    : windowsLaunchExtensions(env).map((extension) => `${name}${extension.toLowerCase()}`);
  const found: string[] = [];
  for (const directory of directories) {
    for (const file of files) {
      const candidate = join(directory, file);
      if (!isFile(candidate)) continue;
      found.push(candidate);
      if (options.first) return found;
    }
  }
  return found;
}

/** A directory as Windows compares it: any case, either slash, no trailing separator. */
function windowsDirectoryKey(directory: string): string {
  const normalized = directory.replace(/\//g, "\\").toLowerCase();
  const trimmed = normalized.replace(/\\+$/, "");
  return /^[a-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export type WindowsWhereResult = { ok: true; paths: string[] } | { ok: false; error: unknown };

/**
 * Every match `where.exe` lists for `name`, kept only when it sits in an
 * absolute PATH entry, and ordered as PATH lists those entries. `where` looks
 * in its own working directory before PATH, so it runs from System32 rather
 * than wherever Daintree was started, and anything it reports outside an
 * absolute PATH entry (that directory, or a relative entry resolved against
 * it) is dropped. Asynchronous and time-boxed, so a PATH entry on a stalled
 * network share cannot block the caller. `ok: false` carries the error from
 * `where` itself, which exits 1 when nothing matches.
 */
export function windowsWhere(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {}
): Promise<WindowsWhereResult> {
  const order = new Map<string, number>();
  splitWindowsPath(windowsEnvValue(env, "PATH") ?? "")
    .filter(isWindowsAbsolutePath)
    .forEach((directory, index) => {
      const key = windowsDirectoryKey(directory);
      if (!order.has(key)) order.set(key, index);
    });
  return new Promise((resolve) => {
    execFile(
      windowsSystemTool("where.exe", env),
      [name],
      {
        cwd: path.win32.join(windowsSystemRoot(env), "System32"),
        env,
        timeout: options.timeoutMs ?? 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error });
          return;
        }
        const ranked = String(stdout ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((file) => ({ file, rank: order.get(windowsDirectoryKey(path.win32.dirname(file))) }))
          .filter((entry): entry is { file: string; rank: number } => entry.rank !== undefined);
        // Stable: `where` lists a directory's matches in PATHEXT order.
        ranked.sort((a, b) => a.rank - b.rank);
        resolve({ ok: true, paths: ranked.map((entry) => entry.file) });
      }
    );
  });
}

/** The file a shell would start for a bare `name` from PATH, or null when PATH has none. */
export function resolveWindowsCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsExecutableOptions = {}
): string | null {
  return findWindowsExecutables(name, env, { ...options, first: true })[0] ?? null;
}

/**
 * Absolute path of the first `name` found in the PATH directories, or null when
 * none has it. Tried as libuv tries it: the name as given when it has an
 * extension, then with `.com`, then `.exe` appended (the files process creation
 * starts directly). Empty, `.` and other relative PATH entries are skipped, so
 * the working directory is never searched. A name that is already a path is
 * returned unchanged.
 *
 * Hits are cached per (name, PATH) and re-checked on every use, so a removed
 * file is searched for again; `invalidateWindowsExecutableCache` drops them all
 * when a PATH refresh may have put a new candidate ahead of a cached one.
 */
export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsExecutableOptions = {}
): string | null {
  if (!name || isPathLike(name)) return name || null;
  const isFile = options.isFile ?? isWindowsLaunchFile;
  const key = `${name.toLowerCase()}\0${windowsEnvValue(env, "PATH") ?? ""}`;
  const cached = resolved.get(key);
  if (cached !== undefined) {
    if (isFile(cached)) return cached;
    resolved.delete(key);
  }

  const { directories, join } = searchDirectories(env);
  const files = [
    ...(path.win32.extname(name) ? [name] : []),
    ...NATIVE_EXTENSIONS.map((extension) => `${name}${extension}`),
  ];
  for (const directory of directories) {
    for (const file of files) {
      const candidate = join(directory, file);
      if (!isFile(candidate)) continue;
      if (resolved.size >= RESOLVED_CACHE_LIMIT) resolved.clear();
      resolved.set(key, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * The error spawn reports for a program it cannot find, so a PATH miss reaches
 * callers in the shape they already handle (`code` and `syscall` are what the
 * missing-git classifier reads).
 */
export function windowsExecutableNotFound(name: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${name} ENOENT`), {
    errno: -4058,
    code: "ENOENT",
    syscall: `spawn ${name}`,
    path: name,
  });
}

/**
 * `name` for spawn: its absolute PATH location on Windows, unchanged elsewhere.
 * On Windows a name PATH does not hold throws spawn's ENOENT instead of being
 * handed to spawn bare, which would search the working directory first.
 */
export function executableForSpawn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return name;
  const file = resolveWindowsExecutable(name, env);
  if (file === null) throw windowsExecutableNotFound(name);
  return file;
}

/** Forget every resolved path; the runtime PATH refresh calls this. */
export function invalidateWindowsExecutableCache(): void {
  resolved.clear();
}

/** Test seam: forget every resolved path. */
export const resetWindowsExecutableCache = invalidateWindowsExecutableCache;
