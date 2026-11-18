import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type GitClient = {
  checkIsRepo: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  revparse: ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>>;
  raw: ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>>;
};

const createStrictExitGitMock = vi.hoisted(() => vi.fn<(cwd: string) => GitClient>());

vi.mock("../../utils/hardenedGit.js", () => ({
  createStrictExitGit: createStrictExitGitMock,
}));

// Spying on the default export of `node:fs/promises` never reaches the service's
// namespace import, so the walker's `opendir` is intercepted by mocking the
// module. It calls through unless a test installs an override.
const opendirOverride = vi.hoisted(() => ({
  current: null as null | ((target: string, options?: unknown) => Promise<unknown>),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    opendir: (...args: Parameters<typeof actual.opendir>) =>
      opendirOverride.current
        ? opendirOverride.current(String(args[0]), args[1])
        : actual.opendir(...args),
  };
});

const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/logger.js")>()),
  logWarn: logWarnMock,
}));

// Defaults to a non-repository cwd: `ls-files` exits non-zero there, which is
// what sends the service to the disk walker. An empty successful listing is a
// different answer (everything under cwd is ignored) and lists nothing.
function createGitClient(): GitClient {
  return {
    checkIsRepo: vi.fn(async () => false),
    revparse: vi.fn(async () => ""),
    raw: vi.fn(async (): Promise<string> => {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    }),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x", "utf8");
}

type FakeEntry = { name: string; kind: "file" | "dir" };

interface FakeDirTally {
  /** Entries handed to the walker, which is all a lazy handle ever produces. */
  pulled: number;
  /** Times the iterator's `finally` ran: the handle's close on exhaustion, break or throw. */
  closed: number;
}

// A lazy stand-in for `fs.Dir`: nothing is produced until the walker pulls it,
// so `pulled` is exactly the number of directory entries the walk consumed.
function createFakeDir(
  entries: Iterable<FakeEntry>,
  options: { failAfter?: number } = {}
): { dir: unknown; tally: FakeDirTally } {
  const tally: FakeDirTally = { pulled: 0, closed: 0 };
  const dir = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const entry of entries) {
          if (options.failAfter !== undefined && tally.pulled >= options.failAfter) {
            throw Object.assign(new Error("read failed"), { code: "EIO" });
          }
          tally.pulled++;
          yield {
            name: entry.name,
            isFile: () => entry.kind === "file",
            isDirectory: () => entry.kind === "dir",
          };
        }
      } finally {
        tally.closed++;
      }
    },
  };
  return { dir, tally };
}

function stubOpendir(byPath: Map<string, unknown>): void {
  opendirOverride.current = async (target) => {
    const dir = byPath.get(target);
    if (dir === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return dir;
  };
}

type RealDir = Awaited<ReturnType<(typeof import("fs/promises"))["opendir"]>>;

// Real handles, kept so a test can look at them once the walk is over.
async function recordOpenedHandles(intercept?: (target: string) => void): Promise<RealDir[]> {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  const handles: RealDir[] = [];
  opendirOverride.current = async (target, options) => {
    intercept?.(target);
    const handle = await actual.opendir(target, options as never);
    handles.push(handle);
    return handle;
  };
  return handles;
}

// Reading a closed `fs.Dir` rejects, which is the one observable that a handle
// was released: its iterator closes it internally, so `close` is never called.
async function expectClosed(handle: { read(): Promise<unknown> }): Promise<void> {
  await expect(handle.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
}

describe("FileSearchService adversarial", () => {
  const tempDirs: string[] = [];
  // Each cached listing arms the module's sweep interval, and `vi.resetModules()`
  // hands the next test a different module with a different timer. Re-importing
  // the service after a reset would dispose the wrong one, so the instances are
  // tracked as they are created — they close over the module that armed the
  // timer. `unref()` stops these from holding the worker open; it does not stop
  // them retaining a 20,000-entry index or firing during a later test.
  const services: Array<{ dispose: () => void }> = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    opendirOverride.current = null;
    vi.restoreAllMocks();
    for (const service of services) service.dispose();
    services.length = 0;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  }, 60_000);

  async function createService() {
    const { FileSearchService } = await import("../FileSearchService.js");
    const service = new FileSearchService();
    services.push(service);
    return service;
  }

  it("deduplicates concurrent cold-cache loads for the same cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    const gitClient = createGitClient();
    const listDeferred = createDeferred<string>();
    gitClient.raw.mockReturnValue(listDeferred.promise);
    createStrictExitGitMock.mockReturnValue(gitClient);

    const service = await createService();
    const first = service.search({ cwd: dir, query: "read", limit: 5 });
    const second = service.search({ cwd: dir, query: "main", limit: 5 });

    listDeferred.resolve("README.md\0src/main.ts\0");

    await expect(Promise.all([first, second])).resolves.toEqual([["README.md"], ["src/main.ts"]]);
    expect(gitClient.raw).toHaveBeenCalledTimes(1);
  });

  it("skips unreadable subtrees and still returns matches from readable siblings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    const secretDir = path.join(dir, "secret");
    const visibleDir = path.join(dir, "visible");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.mkdirSync(visibleDir, { recursive: true });
    writeFile(path.join(secretDir, "hidden.txt"));
    writeFile(path.join(visibleDir, "match.txt"));

    const gitClient = createGitClient();
    createStrictExitGitMock.mockReturnValue(gitClient);
    let deniedOpens = 0;
    await recordOpenedHandles((target) => {
      if (target !== secretDir) return;
      deniedOpens++;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "match", limit: 10 });

    expect(deniedOpens).toBe(1);
    expect(result).toContain("visible/match.txt");
    expect(result).not.toContain("secret/hidden.txt");
  });

  it("stops reading a wide directory once the fallback budget is spent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    createStrictExitGitMock.mockReturnValue(createGitClient());

    // The root leaves exactly one slot of the 20,000-path budget, then a child
    // with far more entries than that: a skipped name (spends no budget), the
    // file that fills the last slot, and 100,000 more that must never be read.
    const root = createFakeDir(
      (function* () {
        for (let index = 0; index < 19_998; index++) {
          yield { name: `file-${index}.txt`, kind: "file" as const };
        }
        yield { name: "wide", kind: "dir" as const };
      })()
    );
    const wide = createFakeDir(
      (function* () {
        yield { name: ".DS_Store", kind: "file" as const };
        yield { name: "first.txt", kind: "file" as const };
        for (let index = 0; index < 100_000; index++) {
          yield { name: `late-${index}.txt`, kind: "file" as const };
        }
      })()
    );
    stubOpendir(
      new Map<string, unknown>([
        [dir, root.dir],
        [path.join(dir, "wide"), wide.dir],
      ])
    );

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "wide", limit: 10 });

    expect([...result].sort()).toEqual(["wide/", "wide/first.txt"]);
    expect(root.tally).toEqual({ pulled: 19_999, closed: 1 });
    expect(wide.tally).toEqual({ pulled: 2, closed: 1 });
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[FileSearchService] loadFilesFromDisk: hit fallback cap",
      {
        cwd: dir,
        cap: 20_000,
      }
    );
  });

  it("keeps what a failing directory read already produced and carries on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    createStrictExitGitMock.mockReturnValue(createGitClient());

    const root = createFakeDir(
      [
        { name: "kept.txt", kind: "file" },
        { name: "sub", kind: "dir" },
        { name: "lost.txt", kind: "file" },
      ],
      { failAfter: 2 }
    );
    const sub = createFakeDir([{ name: "inner.txt", kind: "file" }]);
    stubOpendir(
      new Map<string, unknown>([
        [dir, root.dir],
        [path.join(dir, "sub"), sub.dir],
      ])
    );

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 10 });

    expect([...result].sort()).toEqual(["kept.txt", "sub/", "sub/inner.txt"]);
    expect(root.tally).toEqual({ pulled: 2, closed: 1 });
    expect(sub.tally).toEqual({ pulled: 1, closed: 1 });
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("closes every directory handle it opens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    createStrictExitGitMock.mockReturnValue(createGitClient());
    writeFile(path.join(dir, "a", "b", "deep.txt"));
    writeFile(path.join(dir, "a", "top.txt"));
    writeFile(path.join(dir, "node_modules", "skipped.js"));

    const handles = await recordOpenedHandles();

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 10 });

    expect([...result].sort()).toEqual(["a/", "a/b/", "a/b/deep.txt", "a/top.txt"]);
    // cwd, a, a/b: node_modules is a skipped name and is never opened.
    expect(handles).toHaveLength(3);
    for (const handle of handles) await expectClosed(handle);
  });

  it("lists from the cwd itself inside a larger repository", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(repoRoot);
    const cwd = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(cwd, { recursive: true });

    const cwdClient = createGitClient();
    cwdClient.raw.mockResolvedValue("src/main.ts\0src/utils.ts\0");

    createStrictExitGitMock.mockImplementation((baseDir) => {
      if (baseDir === cwd) return cwdClient;
      throw new Error(`unexpected git client for ${baseDir}`);
    });

    const service = await createService();
    const result = await service.search({ cwd, query: "./src////main.ts", limit: 10 });

    expect(result).toEqual(["src/main.ts"]);
    expect(cwdClient.raw).toHaveBeenCalledWith([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
  });

  it(
    "enforces the fallback file cap before overflowing traversal results",
    // Populating the cap takes 20k file creations. Windows runners are an order
    // of magnitude slower at that than macOS/Linux and overran a flat 60s.
    { timeout: process.platform === "win32" ? 180_000 : 60_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
      tempDirs.push(dir);
      createStrictExitGitMock.mockReturnValue(createGitClient());
      // Deliberately not writeFile() here: its per-call recursive mkdirSync is
      // 19,999 redundant syscalls against a directory that already exists.
      for (let index = 0; index < 19_999; index++) {
        fs.writeFileSync(path.join(dir, `file-${index}.txt`), "x", "utf8");
      }
      writeFile(path.join(dir, "overflow", "sentinel.txt"));

      const handles = await recordOpenedHandles();

      const service = await createService();

      expect(await service.search({ cwd: dir, query: "", limit: 999 })).toHaveLength(100);
      // The walk stops at the cap inside the root, so `overflow` is never opened
      // and the root's handle is released without being read to the end.
      expect(handles).toHaveLength(1);
      await expectClosed(handles[0]);
      await expect(
        service.search({ cwd: dir, query: "file-19998.txt", limit: 5 })
      ).resolves.toEqual(["file-19998.txt"]);
      await expect(
        service.search({ cwd: dir, query: "overflow/sentinel.txt", limit: 5 })
      ).resolves.toEqual([]);
    }
  );

  it("clamps limits and preserves stable empty-query ordering with directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    const gitClient = createGitClient();
    gitClient.checkIsRepo.mockResolvedValue(true);
    gitClient.revparse.mockResolvedValue(`${dir}\n`);
    gitClient.raw.mockResolvedValue("a.ts\0src/index.ts\0pkg/tool.ts\0");
    createStrictExitGitMock.mockReturnValue(gitClient);

    const service = await createService();

    await expect(service.search({ cwd: dir, query: "", limit: 0 })).resolves.toEqual(["a.ts"]);
    await expect(service.search({ cwd: dir, query: "", limit: Number.NaN })).resolves.toEqual([
      "a.ts",
      "pkg/",
      "src/",
      "pkg/tool.ts",
      "src/index.ts",
    ]);
    await expect(service.search({ cwd: dir, query: "", limit: 999 })).resolves.toEqual([
      "a.ts",
      "pkg/",
      "src/",
      "pkg/tool.ts",
      "src/index.ts",
    ]);
  });

  it("skips well-known noise dirs in the fallback walker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    createStrictExitGitMock.mockReturnValue(createGitClient());

    writeFile(path.join(dir, "src", "real.ts"));
    writeFile(path.join(dir, "dist", "bundle.js"));
    writeFile(path.join(dir, ".next", "page.js"));
    writeFile(path.join(dir, ".cache", "blob.bin"));
    writeFile(path.join(dir, "__pycache__", "mod.pyc"));
    writeFile(path.join(dir, "coverage", "report.html"));

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 99 });

    expect(result).toContain("src/real.ts");
    expect(result.some((p) => p.startsWith("dist"))).toBe(false);
    expect(result.some((p) => p.startsWith(".next"))).toBe(false);
    expect(result.some((p) => p.startsWith(".cache"))).toBe(false);
    expect(result.some((p) => p.startsWith("__pycache__"))).toBe(false);
    expect(result.some((p) => p.startsWith("coverage"))).toBe(false);
  });

  it("normalises NFD filenames to NFC in the fallback walker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    createStrictExitGitMock.mockReturnValue(createGitClient());

    // "café.ts" using NFD: e + combining acute (́)
    const nfdName = "café.ts";
    writeFile(path.join(dir, nfdName));

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 5 });

    // Result should be NFC form (single composed é = é)
    expect(result).toContain("café.ts");
    expect(result).not.toContain(nfdName);
  });
});
