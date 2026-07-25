import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import { FileTreeService, _resetBaseRealpathCacheForTests } from "../FileTreeService.js";

const shared = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("a raw listing must not spawn a subprocess");
  }),
}));

vi.mock("fs/promises", () => ({
  realpath: shared.realpath,
  stat: shared.stat,
  readdir: shared.readdir,
  lstat: shared.lstat,
}));

// Poisoned so reintroducing a subprocess to this listing fails loudly rather
// than quietly costing a spawn per directory read.
vi.mock("node:child_process", () => ({
  spawn: shared.spawn,
  execFile: shared.spawn,
  exec: shared.spawn,
}));

interface DirEntry {
  name: string;
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
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

function d(name: string, opts?: { symlink?: boolean; dir?: boolean }): DirEntry {
  return {
    name,
    isSymbolicLink: () => opts?.symlink ?? false,
    isDirectory: () => opts?.dir ?? false,
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
    _resetBaseRealpathCacheForTests();
    service = new FileTreeService();

    shared.realpath.mockImplementation(async (target: string) => target);
    shared.stat.mockResolvedValue(createStats({ isDirectory: true }));
    shared.readdir.mockResolvedValue([]);
    shared.lstat.mockResolvedValue(createStats({ size: 0 }));
  });

  it("READDIR_EACCES_WRAPPED_CLEANLY", async () => {
    shared.readdir.mockRejectedValueOnce(eacces("EACCES: permission denied, scandir '/repo/src'"));

    await expect(service.getFileTree("/repo", "src")).rejects.toThrow(
      "Failed to read directory tree: EACCES"
    );
  });

  it("UNREADABLE_CHILD_DOES_NOT_POISON_DIR", async () => {
    shared.readdir.mockResolvedValueOnce([d("good.txt"), d("secret.txt")]);
    shared.lstat.mockImplementation(async (target: string) => {
      if (target.endsWith("secret.txt")) {
        throw eacces("EACCES: permission denied");
      }
      return createStats({ size: 12 });
    });

    await expect(service.getFileTree("/repo")).resolves.toEqual([
      {
        isDirectory: false,
        name: "good.txt",
        path: "good.txt",
        size: 12,
      },
    ]);
  });

  it("SYMLINK_OMITTED_WITHOUT_FOLLOW", async () => {
    shared.readdir.mockResolvedValueOnce([d("link", { symlink: true })]);

    await expect(service.getFileTree("/repo")).resolves.toEqual([]);
    expect(shared.stat).toHaveBeenCalledTimes(1);
    expect(shared.lstat).not.toHaveBeenCalled();
  });

  it("NO_SUBPROCESS_FOR_A_LISTING", async () => {
    // The listing used to spawn `git check-ignore` per directory, which made it
    // require a git repository and fail closed — an empty tree — on E2BIG or
    // ENOMEM in a large directory (#10003). It is now pure filesystem work, so
    // there is no subprocess left to fail and a non-repo folder lists normally.
    shared.readdir.mockResolvedValueOnce([d("visible.txt"), d("node_modules", { dir: true })]);
    shared.lstat.mockImplementation(async (target: string) =>
      createStats({ isDirectory: target.endsWith("node_modules"), size: 1 })
    );

    const result = await service.getFileTree("/not-a-repo");

    expect(result.map((node) => node.name)).toEqual(["node_modules", "visible.txt"]);
    expect(shared.spawn).not.toHaveBeenCalled();
  });

  it("CONCURRENT_CALLS_NO_SHARED_SNAPSHOT", async () => {
    const firstLstat = deferred<MockStats>();
    let readdirCall = 0;

    shared.readdir.mockImplementation(async () => {
      readdirCall += 1;
      if (readdirCall === 1) {
        return [d("old.txt")];
      }
      return [d("new.txt")];
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
        isDirectory: false,
        name: "old.txt",
        path: "old.txt",
        size: 3,
      },
    ]);
    expect(second).toEqual([
      {
        isDirectory: false,
        name: "new.txt",
        path: "new.txt",
        size: 9,
      },
    ]);
    expect(first).not.toBe(second);
  });

  it("FILE_TYPE_CHANGE_NOT_CACHED", async () => {
    shared.readdir.mockResolvedValue([d("src")]);
    shared.lstat
      .mockResolvedValueOnce(createStats({ isDirectory: false, size: 10 }))
      .mockResolvedValueOnce(createStats({ isDirectory: true }));

    const first = await service.getFileTree("/repo");
    const second = await service.getFileTree("/repo");

    expect(first[0]).toMatchObject({ name: "src", isDirectory: false, size: 10 });
    expect(second[0]).toMatchObject({ name: "src", isDirectory: true });
    expect("size" in second[0]).toBe(false);
  });

  it("SIZE_CHANGE_NOT_CACHED", async () => {
    shared.readdir.mockResolvedValue([d("index.ts")]);
    shared.lstat
      .mockResolvedValueOnce(createStats({ size: 10 }))
      .mockResolvedValueOnce(createStats({ size: 999 }));

    const first = await service.getFileTree("/repo");
    const second = await service.getFileTree("/repo");

    expect(first[0]?.size).toBe(10);
    expect(second[0]?.size).toBe(999);
  });

  it("WINDOWS_SEPARATORS_NORMALIZE_TO_POSIX_PATHS", async () => {
    // Emitted paths are POSIX on every platform: they are matched against a
    // CopyTree manifest, which is POSIX-relative to the root, and handed to
    // agents as `@`-references.
    shared.readdir.mockResolvedValueOnce([d("visible.txt")]);
    shared.lstat.mockResolvedValue(createStats({ size: 7 }));

    await expect(service.getFileTree("/repo", "nested\\dir")).resolves.toEqual([
      {
        isDirectory: false,
        name: "visible.txt",
        path: "nested/dir/visible.txt",
        size: 7,
      },
    ]);
  });

  it("DOT_GIT_IS_RETURNED_LIKE_ANY_OTHER_ENTRY", async () => {
    // Raw listing: `.git` is the caller's to hide. The file browser's junk list
    // does it (#11330), and the context listing drops it because CopyTree never
    // descends into it (#11439).
    shared.readdir.mockResolvedValueOnce([d(".git", { dir: true }), d("src", { dir: true })]);
    shared.lstat.mockResolvedValue(createStats({ isDirectory: true }));

    await expect(service.getFileTree("/repo")).resolves.toEqual([
      { name: ".git", path: ".git", isDirectory: true },
      { name: "src", path: "src", isDirectory: true },
    ]);
  });

  it("REALPATH_CACHE_SHARED_ACROSS_CALLS", async () => {
    let realpathCalls = 0;
    shared.realpath.mockImplementation(async (target: string) => {
      realpathCalls += 1;
      return target;
    });

    await service.getFileTree("/repo");
    await service.getFileTree("/repo");

    // 3 = 1 base-realpath (cached across calls) + 2 target-realpath (per-call)
    expect(realpathCalls).toBe(3);
  });

  it("REALPATH_CACHE_ERROR_EVICTED", async () => {
    // First call: base realpath fails, cache evicted, fallback returned
    shared.realpath.mockRejectedValueOnce(new Error("EACCES"));
    await expect(service.getFileTree("/repo")).resolves.toBeDefined();

    // Second call: base realpath retried (cache was evicted)
    await expect(service.getFileTree("/repo")).resolves.toBeDefined();

    // 4 = (1 base fail + 1 target ok) × 2 calls
    expect(shared.realpath).toHaveBeenCalledTimes(4);
  });
});
