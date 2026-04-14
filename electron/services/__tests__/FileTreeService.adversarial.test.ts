import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import { FileTreeService } from "../FileTreeService.js";

const shared = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  checkIgnore: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  realpath: shared.realpath,
  stat: shared.stat,
  readdir: shared.readdir,
  lstat: shared.lstat,
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => ({
    checkIgnore: shared.checkIgnore,
  })),
}));

interface DirEntry {
  name: string;
}

interface MockStats extends Pick<Stats, "isDirectory" | "isSymbolicLink" | "size"> {
  size: number;
}

function createStats(options: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
}): MockStats {
  return {
    isDirectory: () => options.isDirectory ?? false,
    isSymbolicLink: () => options.isSymbolicLink ?? false,
    size: options.size ?? 0,
  };
}

function eacces(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FileTreeService adversarial", () => {
  let service: FileTreeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FileTreeService();

    shared.realpath.mockImplementation(async (target: string) => target);
    shared.stat.mockResolvedValue(createStats({ isDirectory: true }));
    shared.readdir.mockResolvedValue([]);
    shared.lstat.mockResolvedValue(createStats({ size: 0 }));
    shared.checkIgnore.mockResolvedValue([]);
  });

  it("READDIR_EACCES_WRAPPED_CLEANLY", async () => {
    shared.readdir.mockRejectedValueOnce(eacces("EACCES: permission denied, scandir '/repo/src'"));

    await expect(service.getFileTree("/repo", "src")).rejects.toThrow(
      "Failed to read directory tree: EACCES"
    );
  });

  it("UNREADABLE_CHILD_DOES_NOT_POISON_DIR", async () => {
    shared.readdir.mockResolvedValueOnce([
      { name: "good.txt" },
      { name: "secret.txt" },
    ] as DirEntry[]);
    shared.lstat.mockImplementation(async (target: string) => {
      if (target.endsWith("secret.txt")) {
        throw eacces("EACCES: permission denied");
      }
      return createStats({ size: 12 });
    });

    await expect(service.getFileTree("/repo")).resolves.toEqual([
      {
        children: undefined,
        isDirectory: false,
        name: "good.txt",
        path: "good.txt",
        size: 12,
      },
    ]);
  });

  it("SYMLINK_OMITTED_WITHOUT_FOLLOW", async () => {
    shared.readdir.mockResolvedValueOnce([{ name: "link" }] as DirEntry[]);
    shared.lstat.mockResolvedValueOnce(createStats({ isSymbolicLink: true }));

    await expect(service.getFileTree("/repo")).resolves.toEqual([]);
    expect(shared.stat).toHaveBeenCalledTimes(1);
  });

  it("GIT_IGNORE_FAILURE_FAILS_OPEN", async () => {
    shared.readdir.mockResolvedValueOnce([{ name: "visible.txt" }] as DirEntry[]);
    shared.lstat.mockResolvedValueOnce(createStats({ size: 4 }));
    shared.checkIgnore.mockRejectedValueOnce(new Error("git unavailable"));

    await expect(service.getFileTree("/repo")).resolves.toEqual([
      {
        children: undefined,
        isDirectory: false,
        name: "visible.txt",
        path: "visible.txt",
        size: 4,
      },
    ]);
  });

  it("CONCURRENT_CALLS_NO_SHARED_SNAPSHOT", async () => {
    const firstLstat = deferred<MockStats>();
    let readdirCall = 0;

    shared.readdir.mockImplementation(async () => {
      readdirCall += 1;
      if (readdirCall === 1) {
        return [{ name: "old.txt" }] as DirEntry[];
      }
      return [{ name: "new.txt" }] as DirEntry[];
    });

    shared.lstat.mockImplementation((target: string) => {
      if (target.endsWith("old.txt")) {
        return firstLstat.promise;
      }
      return Promise.resolve(createStats({ size: 9 }));
    });

    const firstPromise = service.getFileTree("/repo");
    const secondPromise = service.getFileTree("/repo");

    firstLstat.resolve(createStats({ size: 3 }));

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual([
      {
        children: undefined,
        isDirectory: false,
        name: "old.txt",
        path: "old.txt",
        size: 3,
      },
    ]);
    expect(second).toEqual([
      {
        children: undefined,
        isDirectory: false,
        name: "new.txt",
        path: "new.txt",
        size: 9,
      },
    ]);
    expect(first).not.toBe(second);
  });

  it("FILE_TYPE_CHANGE_NOT_CACHED", async () => {
    shared.readdir.mockResolvedValue([{ name: "src" }] as DirEntry[]);
    shared.lstat
      .mockResolvedValueOnce(createStats({ isDirectory: false, size: 10 }))
      .mockResolvedValueOnce(createStats({ isDirectory: true }));

    const first = await service.getFileTree("/repo");
    const second = await service.getFileTree("/repo");

    expect(first[0]).toMatchObject({ name: "src", isDirectory: false, size: 10 });
    expect(second[0]).toMatchObject({ name: "src", isDirectory: true, size: 0 });
  });

  it("SIZE_CHANGE_NOT_CACHED", async () => {
    shared.readdir.mockResolvedValue([{ name: "index.ts" }] as DirEntry[]);
    shared.lstat
      .mockResolvedValueOnce(createStats({ size: 10 }))
      .mockResolvedValueOnce(createStats({ size: 999 }));

    const first = await service.getFileTree("/repo");
    const second = await service.getFileTree("/repo");

    expect(first[0]?.size).toBe(10);
    expect(second[0]?.size).toBe(999);
  });

  it("WINDOWS_PATH_NORMALIZES_FOR_IGNORE", async () => {
    shared.readdir.mockResolvedValueOnce([
      { name: "ignored.txt" },
      { name: "visible.txt" },
    ] as DirEntry[]);
    shared.checkIgnore.mockImplementationOnce(async (paths: string[]) => {
      expect(paths).toEqual(["nested/dir/ignored.txt", "nested/dir/visible.txt"]);
      return ["nested/dir/ignored.txt"];
    });
    shared.lstat.mockResolvedValue(createStats({ size: 7 }));

    await expect(service.getFileTree("/repo", "nested\\dir")).resolves.toEqual([
      {
        children: undefined,
        isDirectory: false,
        name: "visible.txt",
        path: "nested/dir/visible.txt",
        size: 7,
      },
    ]);
  });
});
