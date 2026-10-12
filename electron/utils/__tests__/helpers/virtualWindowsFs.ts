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
 */
const files = new Map<string, string>();
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export const virtualWindowsFiles = {
  /** Replace the disk with `entries` (path → contents), matched case-insensitively. */
  set(entries: Record<string, string>): void {
    files.clear();
    for (const [file, contents] of Object.entries(entries)) files.set(file.toLowerCase(), contents);
  },
  clear(): void {
    files.clear();
  },
};

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

export function withVirtualWindowsFiles(actual: typeof fs): typeof fs {
  const stat =
    (syscall: "stat" | "lstat", real: typeof fs.statSync) =>
    (file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const win = windowsPath(file);
      if (win === undefined) return real(file, options);
      if (files.has(win.toLowerCase())) return fileStats;
      if (options?.throwIfNoEntry === false) return undefined;
      throw notFound(syscall, win);
    };
  const readFileSync = (file: fs.PathOrFileDescriptor, options?: unknown) => {
    const win = windowsPath(file);
    if (win === undefined) return actual.readFileSync(file, options as never);
    const contents = files.get(win.toLowerCase());
    if (contents === undefined) throw notFound("open", win);
    return contents;
  };
  const overrides = {
    statSync: stat("stat", actual.statSync),
    lstatSync: stat("lstat", actual.lstatSync),
    readFileSync,
  } as unknown as Pick<typeof fs, "statSync" | "lstatSync" | "readFileSync">;
  const base = (actual as typeof fs & { default?: typeof fs }).default ?? actual;
  return { ...actual, ...overrides, default: { ...base, ...overrides } } as typeof fs;
}
