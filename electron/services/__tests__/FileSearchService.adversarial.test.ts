import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GitClient = {
  checkIsRepo: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  revparse: ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>>;
  raw: ReturnType<typeof vi.fn<(args: string[]) => Promise<string>>>;
};

const createHardenedGitMock = vi.hoisted(() => vi.fn<(cwd: string) => GitClient>());

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: createHardenedGitMock,
}));

function createGitClient(): GitClient {
  return {
    checkIsRepo: vi.fn(async () => false),
    revparse: vi.fn(async () => ""),
    raw: vi.fn(async () => ""),
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

describe("FileSearchService adversarial", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  }, 60_000);

  async function createService() {
    const { FileSearchService } = await import("../FileSearchService.js");
    return new FileSearchService();
  }

  it("deduplicates concurrent cold-cache loads for the same cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    const gitClient = createGitClient();
    const checkDeferred = createDeferred<boolean>();
    gitClient.checkIsRepo.mockReturnValue(checkDeferred.promise);
    gitClient.revparse.mockResolvedValue(`${dir}\n`);
    gitClient.raw.mockResolvedValue("README.md\0src/main.ts\0");
    createHardenedGitMock.mockReturnValue(gitClient);

    const service = await createService();
    const first = service.search({ cwd: dir, query: "read", limit: 5 });
    const second = service.search({ cwd: dir, query: "main", limit: 5 });

    checkDeferred.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual([["README.md"], ["src/main.ts"]]);
    expect(gitClient.checkIsRepo).toHaveBeenCalledTimes(1);
    expect(gitClient.raw).toHaveBeenCalledTimes(1);
  });

  it("does not reseed the cache with stale results after invalidate during an in-flight load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(dir);
    const gitClient = createGitClient();
    const rawDeferred = createDeferred<string>();
    gitClient.checkIsRepo.mockResolvedValue(true);
    gitClient.revparse.mockResolvedValue(`${dir}\n`);
    gitClient.raw.mockReturnValueOnce(rawDeferred.promise).mockResolvedValueOnce("beta.ts\0");
    createHardenedGitMock.mockReturnValue(gitClient);

    const service = await createService();
    const first = service.search({ cwd: dir, query: "alpha", limit: 5 });

    service.invalidate(dir);
    rawDeferred.resolve("alpha.ts\0");

    await expect(first).resolves.toEqual(["alpha.ts"]);
    await expect(service.search({ cwd: dir, query: "beta", limit: 5 })).resolves.toEqual([
      "beta.ts",
    ]);
    await expect(service.search({ cwd: dir, query: "beta", limit: 5 })).resolves.toEqual([
      "beta.ts",
    ]);
    expect(gitClient.raw).toHaveBeenCalledTimes(2);
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
    createHardenedGitMock.mockReturnValue(gitClient);
    const readdirSpy = vi.spyOn(fsPromises, "readdir");
    const originalReaddir =
      readdirSpy.getMockImplementation() ?? fsPromises.readdir.bind(fsPromises);
    readdirSpy.mockImplementation(async (target, options) => {
      if (String(target) === secretDir) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return originalReaddir(target, options as never);
    });

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "match", limit: 10 });

    expect(result).toContain("visible/match.txt");
    expect(result).not.toContain("secret/hidden.txt");
  });

  it("keeps git pathspecs rooted to the cwd inside a larger repository", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-adv-"));
    tempDirs.push(repoRoot);
    const cwd = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(cwd, { recursive: true });

    const repoClient = createGitClient();
    repoClient.raw.mockResolvedValue("packages/app/src/main.ts\0packages/app/src/utils.ts\0");
    const cwdClient = createGitClient();
    cwdClient.checkIsRepo.mockResolvedValue(true);
    cwdClient.revparse.mockResolvedValue(`${repoRoot}\n`);

    createHardenedGitMock.mockImplementation((baseDir) => {
      if (baseDir === repoRoot) {
        return repoClient;
      }
      return cwdClient;
    });

    const service = await createService();
    const result = await service.search({ cwd, query: "./src////main.ts", limit: 10 });

    expect(result).toEqual(["src/main.ts"]);
    expect(repoClient.raw).toHaveBeenCalledWith([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages/app",
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
      createHardenedGitMock.mockReturnValue(createGitClient());
      // Deliberately not writeFile() here: its per-call recursive mkdirSync is
      // 19,999 redundant syscalls against a directory that already exists.
      for (let index = 0; index < 19_999; index++) {
        fs.writeFileSync(path.join(dir, `file-${index}.txt`), "x", "utf8");
      }
      writeFile(path.join(dir, "overflow", "sentinel.txt"));

      const service = await createService();

      expect(await service.search({ cwd: dir, query: "", limit: 999 })).toHaveLength(100);
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
    createHardenedGitMock.mockReturnValue(gitClient);

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
    createHardenedGitMock.mockReturnValue(createGitClient());

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
    createHardenedGitMock.mockReturnValue(createGitClient());

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
