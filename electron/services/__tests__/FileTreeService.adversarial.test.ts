import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { FILE_TREE_METADATA_CONCURRENCY, FileTreeService } from "../FileTreeService.js";

const shared = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  readlink: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("a raw listing must not spawn a subprocess");
  }),
}));

vi.mock("fs/promises", () => ({
  realpath: shared.realpath,
  stat: shared.stat,
  readdir: shared.readdir,
  lstat: shared.lstat,
  readlink: shared.readlink,
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

// Every `lstat` parks until the test releases it, so the number of listing
// operations in flight at once is observable rather than inferred from timing.
function gateLstat() {
  const parked = new Map<string, { release: () => void; fail: () => void }>();
  let active = 0;
  let peak = 0;
  shared.lstat.mockImplementation(
    (target: string) =>
      new Promise<MockStats>((resolve, reject) => {
        active += 1;
        peak = Math.max(peak, active);
        const settle = () => {
          active -= 1;
          parked.delete(target);
        };
        parked.set(target, {
          release: () => {
            settle();
            resolve(createStats({ size: 1 }));
          },
          fail: () => {
            settle();
            reject(eacces("EACCES: permission denied"));
          },
        });
      })
  );
  return { parked, active: () => active, peak: () => peak };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drain(gate: ReturnType<typeof gateLstat>, failing = new Set<string>()) {
  await flush();
  while (gate.parked.size > 0) {
    for (const [target, op] of [...gate.parked]) {
      if (failing.has(target)) op.fail();
      else op.release();
    }
    await flush();
  }
}

function files(count: number) {
  return Array.from({ length: count }, (_, i) => d(`f${i}.txt`));
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
    shared.readlink.mockResolvedValue("./target");
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

  it("SYMLINK_LISTED_WITH_ITS_TARGET", async () => {
    // Was SYMLINK_OMITTED_WITHOUT_FOLLOW, which pinned the bug in #11939: a
    // link used to be dropped before it was ever stat'd, so the file browser
    // showed nothing and said nothing.
    shared.readdir.mockResolvedValueOnce([d("link", { symlink: true })]);
    shared.lstat.mockImplementation(async (target: string) =>
      createStats({ isSymbolicLink: target.endsWith("link"), size: 11 })
    );
    shared.readlink.mockResolvedValue("./target");

    await expect(service.getFileTree("/repo")).resolves.toEqual([
      {
        isDirectory: false,
        name: "link",
        path: "link",
        size: 11,
        symlink: { target: path.resolve("/repo", "target"), targetKind: "file" },
      },
    ]);
  });

  it("OUT_OF_ROOT_LINK_IS_NOT_DEREFERENCED", async () => {
    // The syscall-level half of the no-probe rule, which a real-filesystem
    // test cannot express: a link naming an outside path must be classified
    // from `readlink` ALONE. Any `realpath` or `lstat` aimed at that target
    // would be the external existence probe (and the dead-mount stall) the
    // lexical gate exists to avoid, so their absence is the assertion.
    shared.readdir.mockResolvedValueOnce([d("outward", { symlink: true })]);
    shared.lstat.mockResolvedValue(createStats({ isSymbolicLink: true, size: 15 }));
    shared.readlink.mockResolvedValue("/elsewhere/secret");

    const nodes = await service.getFileTree("/repo");

    expect(nodes).toEqual([
      {
        isDirectory: false,
        name: "outward",
        path: "outward",
        // No size: a link's own `lstat.size` is its target string's length.
        symlink: { target: path.resolve("/elsewhere/secret"), targetKind: "external" },
      },
    ]);
    expect(shared.readlink).toHaveBeenCalledWith(path.resolve("/repo", "outward"));
    // Only the entry's own `lstat` — never one aimed at the target.
    expect(shared.lstat.mock.calls.map(([target]) => target)).toEqual([
      path.resolve("/repo", "outward"),
    ]);
    // The two directory-level realpaths only; none for the link.
    expect(shared.realpath.mock.calls.map(([target]) => target)).toEqual([
      path.resolve("/repo"),
      path.resolve("/repo"),
    ]);
  });

  it("LINK_READ_FAILURE_DROPS_ONE_ENTRY_NOT_THE_LISTING", async () => {
    // A link deleted between `readdir` and `readlink` is an ordinary race, and
    // it must cost exactly that one row.
    shared.readdir.mockResolvedValueOnce([d("gone", { symlink: true }), d("good.txt")]);
    shared.lstat.mockImplementation(async (target: string) =>
      createStats({ isSymbolicLink: target.endsWith("gone"), size: 4 })
    );
    shared.readlink.mockRejectedValue(eacces("ENOENT: no such file"));

    const nodes = await service.getFileTree("/repo");

    expect(nodes.map((node) => node.name)).toEqual(["good.txt"]);
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

  it("WINDOWS_SEPARATORS_NORMALIZE_TO_POSIX_PATHS", async () => {
    // Emitted paths are POSIX on every platform: they are matched against a
    // CopyTree manifest, which is POSIX-relative to the root, and handed to
    // agents as `@`-references. A backslash is only a separator on Windows;
    // elsewhere it is part of the directory name and must survive (#13562).
    shared.readdir.mockResolvedValueOnce([d("visible.txt")]);
    shared.lstat.mockResolvedValue(createStats({ size: 7 }));

    await expect(service.getFileTree("/repo", "nested\\dir")).resolves.toEqual([
      {
        isDirectory: false,
        name: "visible.txt",
        path: process.platform === "win32" ? "nested/dir/visible.txt" : "nested\\dir/visible.txt",
        size: 7,
      },
    ]);
  });

  it("BASE_REALPATH_RESOLVED_PER_CALL", async () => {
    // A retargeted root symlink (#13561): the base and the target move
    // together, so a canonical base remembered from the first call would put
    // every later target outside it.
    let canonicalRoot = "/canonical/first";
    shared.realpath.mockImplementation(async () => canonicalRoot);

    await expect(service.getFileTree("/repo")).resolves.toEqual([]);
    canonicalRoot = "/canonical/second";
    await expect(service.getFileTree("/repo")).resolves.toEqual([]);

    expect(shared.realpath.mock.calls.map(([target]) => target)).toEqual([
      path.resolve("/repo"),
      path.resolve("/repo"),
      path.resolve("/repo"),
      path.resolve("/repo"),
    ]);
  });

  it("BASE_REALPATH_FAILURE_FALLS_BACK_TO_LEXICAL_BASE", async () => {
    shared.realpath.mockRejectedValueOnce(new Error("EACCES"));
    await expect(service.getFileTree("/repo")).resolves.toEqual([]);
    await expect(service.getFileTree("/repo")).resolves.toEqual([]);

    expect(shared.realpath).toHaveBeenCalledTimes(4);
  });
  it("WIDE_DIRECTORY_METADATA_FANOUT_IS_BOUNDED", async () => {
    // One `lstat` per entry used to start at once: 10,000 entries meant 10,000
    // pending filesystem requests queued ahead of every other fs call (#13600).
    shared.readdir.mockResolvedValueOnce(files(10_000));
    const gate = gateLstat();

    const listing = service.getFileTree("/repo");
    await flush();
    expect(gate.active()).toBe(FILE_TREE_METADATA_CONCURRENCY);

    await drain(gate);
    const nodes = await listing;

    expect(gate.peak()).toBe(FILE_TREE_METADATA_CONCURRENCY);
    expect(nodes).toHaveLength(10_000);
    expect(new Set(nodes.map((node) => node.name)).size).toBe(10_000);
    expect(nodes.slice(0, 3).map((node) => node.name)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(nodes.at(-1)?.name).toBe("f9999.txt");
  });

  it("FREED_SLOT_STARTS_THE_NEXT_ENTRY_WITHOUT_WAITING_FOR_ITS_BATCH", async () => {
    // A batch-of-N implementation would also cap the fan-out, but one slow
    // entry would then stall the other N-1 slots behind it.
    const entries = files(FILE_TREE_METADATA_CONCURRENCY * 2 + 3);
    shared.readdir.mockResolvedValueOnce(entries);
    const gate = gateLstat();

    const listing = service.getFileTree("/repo");
    await flush();
    gate.parked.get(path.resolve("/repo", "f3.txt"))?.release();
    await flush();

    expect(gate.active()).toBe(FILE_TREE_METADATA_CONCURRENCY);
    expect(shared.lstat).toHaveBeenCalledTimes(FILE_TREE_METADATA_CONCURRENCY + 1);
    expect(shared.lstat).toHaveBeenLastCalledWith(
      path.resolve("/repo", `f${FILE_TREE_METADATA_CONCURRENCY}.txt`)
    );

    await drain(gate);
    await expect(listing).resolves.toHaveLength(entries.length);
  });

  it("FAILURE_PAST_THE_FIRST_WINDOW_DROPS_ONLY_THAT_ENTRY", async () => {
    const count = FILE_TREE_METADATA_CONCURRENCY * 3;
    const failingName = `f${count - 2}.txt`;
    shared.readdir.mockResolvedValueOnce(files(count));
    const gate = gateLstat();

    const listing = service.getFileTree("/repo");
    await drain(gate, new Set([path.resolve("/repo", failingName)]));
    const names = (await listing).map((node) => node.name);

    expect(names).toHaveLength(count - 1);
    expect(names).not.toContain(failingName);
    expect(names).toContain(`f${count - 1}.txt`);
  });

  it("SLOW_SYMLINK_RESOLUTION_HOLDS_ITS_SLOT", async () => {
    // A link's slot covers its whole read (`lstat`, `readlink`, `realpath`,
    // target `lstat`), not just the first call, or slow link targets would
    // pile up unbounded behind a fast first `lstat`.
    const count = FILE_TREE_METADATA_CONCURRENCY + 4;
    shared.readdir.mockResolvedValueOnce(
      Array.from({ length: count }, (_, i) => d(`link${i}`, { symlink: true }))
    );
    shared.lstat.mockImplementation(async () => createStats({ isSymbolicLink: true, size: 7 }));
    const readlinks: Array<() => void> = [];
    shared.readlink.mockImplementation(
      () => new Promise<string>((resolve) => readlinks.push(() => resolve("./target")))
    );

    const listing = service.getFileTree("/repo");
    await flush();

    expect(shared.readlink).toHaveBeenCalledTimes(FILE_TREE_METADATA_CONCURRENCY);
    const firstWindow = new Set(
      Array.from({ length: FILE_TREE_METADATA_CONCURRENCY }, (_, i) =>
        path.resolve("/repo", `link${i}`)
      )
    );
    for (const [target] of shared.lstat.mock.calls) expect(firstWindow).toContain(target);

    while ((await Promise.race([listing.then(() => true), flush().then(() => false)])) === false) {
      readlinks.splice(0).forEach((release) => release());
    }
    await expect(listing).resolves.toHaveLength(count);
  });
});
