import type * as fs from "node:fs";

/**
 * Files at Windows paths (`C:\...`, `\\server\...`) for tests that simulate
 * win32 on another host, so PATH lookups and shim reads run the real code
 * against a known disk. Any other path goes to the real filesystem. Install with
 *
 *   vi.mock("node:fs", async (importOriginal) =>
 *     (await import("<relative>/helpers/virtualWindowsFs.js")).withVirtualWindowsFiles(
 *       await importOriginal()
 *     )
 *   );
 *
 * Covers the synchronous stat/lstat/readFile calls and the `fs.promises`
 * readdir/stat/lstat/readFile a PATH search and a shim read make. A directory
 * exists when a file sits somewhere under it. A directory in `hang` never
 * answers, the way one on a dropped network share waits out the SMB timeout.
 * Every synchronous call against a Windows path is recorded in `syncCalls`.
 */
const files = new Map<string, { path: string; contents: string }>();
const hung = new Set<string>();
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export const virtualWindowsFiles = {
  /** Replace the disk with `entries` (path → contents), matched case-insensitively. */
  set(entries: Record<string, string>, options: { hang?: readonly string[] } = {}): void {
    files.clear();
    hung.clear();
    for (const [file, contents] of Object.entries(entries)) {
      files.set(file.toLowerCase(), { path: file, contents });
    }
    for (const directory of options.hang ?? []) hung.add(directoryPrefix(directory));
  },
  clear(): void {
    files.clear();
    hung.clear();
  },
  /** Synchronous calls made against Windows paths (`<syscall> <path>`), in order. */
  syncCalls: [] as string[],
};

function isHung(file: string): boolean {
  const prefix = directoryPrefix(file);
  for (const directory of hung) if (prefix.startsWith(directory)) return true;
  return false;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function windowsPath(file: unknown): string | undefined {
  return typeof file === "string" && WINDOWS_PATH.test(file) ? file : undefined;
}

function notFound(syscall: string, file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${file}'`), {
    code: "ENOENT",
    syscall,
    path: file,
  });
}

const fileStats = {
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
};

const directoryStats = {
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
};

function directoryPrefix(directory: string): string {
  return `${directory.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()}\\`;
}

/** The names directly under `directory`, or undefined when no file sits beneath it. */
function listVirtualDirectory(
  directory: string
):
  | Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>
  | undefined {
  const prefix = directoryPrefix(directory);
  const entries = new Map<string, { name: string; isFile: boolean }>();
  for (const [key, { path }] of files) {
    if (!key.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const separator = rest.search(/[\\/]/);
    const name = separator < 0 ? rest : rest.slice(0, separator);
    if (!entries.has(name.toLowerCase())) {
      entries.set(name.toLowerCase(), { name, isFile: separator < 0 });
    }
  }
  if (entries.size === 0) return undefined;
  return [...entries.values()].map(({ name, isFile }) => ({
    name,
    ...(isFile ? fileStats : directoryStats),
  }));
}

function isVirtualDirectory(file: string): boolean {
  const prefix = directoryPrefix(file);
  for (const key of files.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

export function withVirtualWindowsFiles(actual: typeof fs): typeof fs {
  const stat =
    (syscall: "stat" | "lstat", real: typeof fs.statSync) =>
    (file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const win = windowsPath(file);
      if (win === undefined) return real(file, options);
      virtualWindowsFiles.syncCalls.push(`${syscall}Sync ${win}`);
      if (files.has(win.toLowerCase())) return fileStats;
      if (options?.throwIfNoEntry === false) return undefined;
      throw notFound(syscall, win);
    };
  const readFileSync = (file: fs.PathOrFileDescriptor, options?: unknown) => {
    const win = windowsPath(file);
    if (win === undefined) return actual.readFileSync(file, options as never);
    virtualWindowsFiles.syncCalls.push(`readFileSync ${win}`);
    const contents = files.get(win.toLowerCase())?.contents;
    if (contents === undefined) throw notFound("open", win);
    return contents;
  };
  const readFile = async (file: fs.PathLike, options?: unknown) => {
    const win = windowsPath(file);
    if (win === undefined) {
      return (actual.promises.readFile as (f: fs.PathLike, o?: unknown) => unknown)(file, options);
    }
    if (isHung(win)) return never();
    const contents = files.get(win.toLowerCase())?.contents;
    if (contents === undefined) throw notFound("open", win);
    return contents;
  };
  const asyncStat =
    (syscall: "stat" | "lstat", real: (file: fs.PathLike) => Promise<unknown>) =>
    async (file: fs.PathLike, options?: unknown) => {
      const win = windowsPath(file);
      if (win === undefined)
        return (real as (f: fs.PathLike, o?: unknown) => unknown)(file, options);
      if (isHung(win)) return never();
      if (files.has(win.toLowerCase())) return fileStats;
      if (isVirtualDirectory(win)) return directoryStats;
      throw notFound(syscall, win);
    };
  const readdir = async (directory: fs.PathLike, options?: unknown) => {
    const win = windowsPath(directory);
    if (win === undefined) {
      return (actual.promises.readdir as (d: fs.PathLike, o?: unknown) => unknown)(
        directory,
        options
      );
    }
    if (isHung(win)) return never();
    const entries = listVirtualDirectory(win);
    if (!entries) throw notFound("scandir", win);
    const withFileTypes = (options as { withFileTypes?: boolean } | undefined)?.withFileTypes;
    return withFileTypes ? entries : entries.map((entry) => entry.name);
  };
  const promises = {
    ...actual.promises,
    readdir,
    readFile,
    stat: asyncStat("stat", actual.promises.stat),
    lstat: asyncStat("lstat", actual.promises.lstat),
  } as unknown as typeof fs.promises;
  const overrides = {
    statSync: stat("stat", actual.statSync),
    lstatSync: stat("lstat", actual.lstatSync),
    readFileSync,
    promises,
  } as unknown as Pick<typeof fs, "statSync" | "lstatSync" | "readFileSync" | "promises">;
  const base = (actual as typeof fs & { default?: typeof fs }).default ?? actual;
  return { ...actual, ...overrides, default: { ...base, ...overrides } } as typeof fs;
}
