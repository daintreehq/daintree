import path from "node:path";
import { vi } from "vitest";
import type { WindowsDirectoryEntry, WindowsPathFs } from "../../windowsExecutable.js";

export type FakeWindowsPathFs = WindowsPathFs & {
  readdir: ReturnType<typeof vi.fn<(directory: string) => Promise<WindowsDirectoryEntry[]>>>;
  stat: ReturnType<typeof vi.fn<(file: string) => Promise<{ isFile(): boolean }>>>;
};

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/**
 * The PATH search's view of a disk of Windows paths: each directory lists the
 * files directly in it. A directory in `hang` never answers, the way one on a
 * dropped network share waits out the SMB timeout; one in `denyListing` can be
 * traversed but not listed (EPERM from readdir, files still stat).
 */
export function fakeWindowsPathFs(
  files: Record<string, string> | readonly string[],
  options: { hang?: readonly string[]; denyListing?: readonly string[] } = {}
): FakeWindowsPathFs {
  const names = Array.isArray(files) ? [...files] : Object.keys(files);
  const trim = (value: string) => value.replace(/\\+$/, "").toLowerCase();
  const hang = new Set((options.hang ?? []).map(trim));
  const denied = new Set((options.denyListing ?? []).map(trim));
  const has = (file: string) => names.some((name) => trim(name) === trim(file));
  const inDirectory = (directory: string) =>
    names.filter((file) => trim(path.win32.dirname(file)) === trim(directory));
  return {
    readdir: vi.fn(async (directory: string) => {
      const key = trim(directory);
      if (hang.has(key)) return new Promise<WindowsDirectoryEntry[]>(() => {});
      if (denied.has(key)) throw fsError("EPERM");
      const entries = inDirectory(directory).map((file) => ({
        name: path.win32.basename(file),
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      }));
      if (entries.length === 0) throw fsError("ENOENT");
      return entries;
    }),
    stat: vi.fn(async (file: string) => {
      if (hang.has(trim(path.win32.dirname(file)))) {
        return new Promise<{ isFile(): boolean }>(() => {});
      }
      if (!has(file)) throw fsError("ENOENT");
      return { isFile: () => true };
    }),
    lstat: async () => {
      throw fsError("ENOENT");
    },
  };
}
