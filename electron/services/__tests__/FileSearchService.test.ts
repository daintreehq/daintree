import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const simpleGitMock = vi.hoisted(() => vi.fn());
const gitClientMock: {
  env: ReturnType<typeof vi.fn>;
  checkIsRepo: ReturnType<typeof vi.fn>;
  revparse: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
} = vi.hoisted(() => ({
  env: vi.fn(),
  checkIsRepo: vi.fn<() => Promise<boolean>>(),
  revparse: vi.fn<(args: string[]) => Promise<string>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
}));
gitClientMock.env.mockReturnValue(gitClientMock);

vi.mock("simple-git", () => ({
  simpleGit: simpleGitMock,
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-search-"));
}

function writeFile(filePath: string, content = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("FileSearchService", () => {
  const tempDirs: string[] = [];
  const services: Array<{ dispose: () => void }> = [];

  // The cache decides expiry against `Date.now()`, so the TTL tests move the
  // clock rather than sleep. Offset zero is a pass-through, so every other test
  // in this file sees the real clock; full fake timers are avoided because the
  // service awaits real git and fs work.
  const realDateNow = Date.now;
  let clockOffsetMs = 0;

  function advanceClock(ms: number): void {
    clockOffsetMs += ms;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    clockOffsetMs = 0;
    Date.now = () => realDateNow.call(Date) + clockOffsetMs;
    simpleGitMock.mockImplementation(() => gitClientMock);
    gitClientMock.env.mockReturnValue(gitClientMock);
    gitClientMock.checkIsRepo.mockResolvedValue(false);
    gitClientMock.revparse.mockRejectedValue(new Error("not a git repository"));
    gitClientMock.raw.mockResolvedValue("");
  });

  afterEach(() => {
    Date.now = realDateNow;
    // `vi.resetModules()` hands the next test a fresh module — and a fresh
    // handle to a sweep interval the old module already armed. Disposing here
    // is what keeps those from accumulating across the file.
    for (const service of services) service.dispose();
    services.length = 0;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function createService() {
    const { FileSearchService } = await import("../FileSearchService.js");
    const service = new FileSearchService();
    services.push(service);
    return service;
  }

  function gitRepo(dir: string, listing: string): void {
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue(listing);
  }

  it("returns empty results when cwd does not exist", async () => {
    const service = await createService();
    const missingDir = path.join(os.tmpdir(), "daintree-does-not-exist", `${Date.now()}`);

    await expect(service.search({ cwd: missingDir, query: "readme" })).resolves.toEqual([]);
  });

  it("returns empty results when cwd is a file path", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const filePath = path.join(dir, "README.md");
    writeFile(filePath, "hello");

    const service = await createService();
    const result = await service.search({ cwd: filePath, query: "readme" });

    expect(result).toEqual([]);
  });

  it("falls back to filesystem traversal when cwd is not a git repo", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFile(path.join(dir, "README.md"));
    writeFile(path.join(dir, "src", "app.ts"));
    writeFile(path.join(dir, "docs", "guide.md"));

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "app", limit: 10 });

    expect(result).toContain("src/app.ts");
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
  });

  it("uses git file listing when repository is available", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("README.md\0src/main.ts\0src/components/Button.tsx\0");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "read", limit: 5 });

    expect(result[0]).toBe("README.md");
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
  });

  it("normalizes leading path syntax in queries", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\0src/components/Input.tsx\0");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "./src//components//button", limit: 5 });

    expect(result).toEqual(["src/components/Button.tsx"]);
  });

  it("reuses cached file list across repeated searches for same cwd", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("README.md\0src/main.ts\0package.json\0");

    const service = await createService();
    const first = await service.search({ cwd: dir, query: "src", limit: 5 });
    const second = await service.search({ cwd: dir, query: "read", limit: 5 });

    expect(first).toContain("src/main.ts");
    expect(second).toContain("README.md");
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
  });

  it("returns shortest paths first when query is empty", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\0a.ts\0README.md\0");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 3 });

    expect(result).toEqual(["a.ts", "src/", "README.md"]);
  });

  describe("searchNaturalLanguage", () => {
    it("resolves 'hybrid input bar component' to HybridInputBar.tsx", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue(
        "src/components/HybridInputBar.tsx\0src/components/Button.tsx\0src/App.tsx\0"
      );

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "hybrid input bar component",
        limit: 5,
      });

      expect(result[0]).toBe("src/components/HybridInputBar.tsx");
    });

    it("resolves 'app layout' to AppLayout.tsx", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue(
        "src/components/AppLayout.tsx\0src/App.tsx\0src/layout/Sidebar.tsx\0"
      );

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "app layout",
        limit: 5,
      });

      expect(result[0]).toBe("src/components/AppLayout.tsx");
    });

    it("returns empty array for query with only stop words", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/App.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "the component file",
        limit: 5,
      });

      expect(result).toEqual([]);
    });

    it("returns empty array for empty description", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/App.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "",
        limit: 5,
      });

      expect(result).toEqual([]);
    });

    it("skips directory entries", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/app/App.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "app",
        limit: 5,
      });

      expect(result).toEqual(["src/app/App.tsx"]);
      expect(result.every((r) => !r.endsWith("/"))).toBe(true);
    });

    it("handles snake_case and kebab-case filenames", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue(
        "src/voice_recording_service.ts\0src/file-search-service.ts\0src/other.ts\0"
      );

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "voice recording service",
        limit: 5,
      });

      expect(result[0]).toBe("src/voice_recording_service.ts");
    });

    it("does not match short tokens against unrelated longer words", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/useEffect.tsx\0src/UserSettings.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "us settings",
        limit: 5,
      });

      // "us" is short and must not loose-match "useEffect"; only "settings" matches
      // "Settings" in UserSettings (1/2 = 0.5 score), useEffect has no matches.
      expect(result).toEqual(["src/UserSettings.tsx"]);
    });

    it("splits digit boundaries so S3Client matches 's3 client'", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/S3Client.ts\0src/Other.ts\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "s3 client",
        limit: 5,
      });

      expect(result[0]).toBe("src/S3Client.ts");
    });

    it("ranks S3Client.ts above Client.ts when query is 's3 client'", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/Client.ts\0src/S3Client.ts\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "s3 client",
        limit: 5,
      });

      // Without query-side digit splitting, "s3" never matches and Client.ts
      // ties or beats S3Client.ts on path length. After the fix, query tokens
      // become ["s", "3", "client"] which fully match S3Client's words.
      expect(result[0]).toBe("src/S3Client.ts");
    });

    it("ranks AppLayout.tsx above ALayout.tsx when query is 'app layout'", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/ALayout.tsx\0src/AppLayout.tsx\0");

      const service = await createService();
      const result = await service.searchNaturalLanguage({
        cwd: dir,
        description: "app layout",
        limit: 5,
      });

      // Without the word-length guard, "app".startsWith("a") would falsely
      // match ALayout's "a" word, tying it with AppLayout and winning on
      // pathLen. The w.length >= 3 guard suppresses these false positives.
      expect(result[0]).toBe("src/AppLayout.tsx");
    });
  });

  describe("cache lifecycle", () => {
    it("stays warm across a pause the old ten-second TTL would have lapsed", async () => {
      // The reason for the change: a ten-second clock put the next keystroke
      // after any ordinary pause back on `git ls-files` plus a synchronous
      // index build, on the process that also serves every terminal's IPC.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0src/main.ts\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      advanceClock(11_000);
      const afterPause = await service.search({ cwd: dir, query: "main", limit: 5 });

      expect(afterPause).toContain("src/main.ts");
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    it("still reloads once the fallback TTL lapses", async () => {
      // A background worktree is on the git-only watch and never emits the
      // files-changed signal, so this clock is the only thing that refreshes
      // it. Losing it entirely would leave those listings stale for the life of
      // the process.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      advanceClock(300_001);
      await service.search({ cwd: dir, query: "read", limit: 5 });

      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("does not let a read extend the entry's life", async () => {
      // Expiry is absolute, not sliding. A sliding window would let a steadily
      // searched worktree with no watcher hold a stale index open forever.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      advanceClock(240_000);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      advanceClock(60_001);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidateUnder", () => {
    it("drops an index cached under a subdirectory of the invalidated root", async () => {
      // `files.search` is an ActionService action, so it is an MCP tool whose
      // `cwd` comes from the caller: an agent can cache an entry under a
      // subdirectory, which a root-only drop would leave to outlive every
      // change made to it.
      const dir = makeTempDir();
      tempDirs.push(dir);
      const nested = path.join(dir, "src");
      fs.mkdirSync(nested, { recursive: true });
      gitRepo(dir, "main.ts\0");

      const service = await createService();
      await service.search({ cwd: nested, query: "main", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      service.invalidateUnder(dir);
      await service.search({ cwd: nested, query: "main", limit: 5 });

      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("leaves a sibling whose name merely extends the root", async () => {
      const root = makeTempDir();
      tempDirs.push(root);
      const worktree = path.join(root, "repo");
      const sibling = path.join(root, "repo-other");
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      gitRepo(worktree, "main.ts\0");

      const service = await createService();
      await service.search({ cwd: worktree, query: "main", limit: 5 });
      await service.search({ cwd: sibling, query: "main", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);

      service.invalidateUnder(worktree);
      await service.search({ cwd: sibling, query: "main", limit: 5 });

      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("rebuilds lazily — the invalidation itself never touches git", async () => {
      // The watcher fires on every debounced flush; rebuilding eagerly there
      // would move the cold load onto the change instead of removing it.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });

      service.invalidateUnder(dir);
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);

      gitRepo(dir, "README.md\0src/NewlyAdded.ts\0");
      const afterChange = await service.search({ cwd: dir, query: "NewlyAdded", limit: 5 });

      expect(afterChange).toContain("src/NewlyAdded.ts");
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });

    it("fences a load already in flight when the invalidation lands", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      let releaseFirst!: (value: string) => void;
      let markRawStarted!: () => void;
      // `loadFileList` awaits an fs.stat and the hardened-git construction
      // before it reaches `raw`, so the invalidation has to wait for the load to
      // genuinely be in flight — firing it a tick early would test nothing.
      const rawStarted = new Promise<void>((resolve) => {
        markRawStarted = resolve;
      });
      gitClientMock.raw.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
            markRawStarted();
          })
      );

      const service = await createService();
      const inFlight = service.search({ cwd: dir, query: "stale", limit: 5 });
      await rawStarted;
      service.invalidateUnder(dir);
      releaseFirst("stale.ts\0");
      await inFlight;

      gitClientMock.raw.mockResolvedValue("fresh.ts\0");
      const afterFence = await service.search({ cwd: dir, query: "", limit: 5 });

      // The fenced load must not have seeded the cache: the next search sees
      // the post-change listing, not the one that was already in flight.
      expect(afterFence).toEqual(["fresh.ts"]);
    });
  });

  describe("sweep", () => {
    it("frees an expired index without anyone reading its key", async () => {
      // The defect the sweep exists for: `Cache.get` only drops the key it was
      // asked for, so an index for a worktree nobody revisits stayed resident.
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(service.getCacheStats().size).toBe(1);

      advanceClock(300_001);
      service.sweep();

      expect(service.getCacheStats().size).toBe(0);
    });

    it("keeps an index that has not expired", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });

      advanceClock(120_000);
      service.sweep();

      expect(service.getCacheStats().size).toBe(1);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
    });

    it("dispose drops every index", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitRepo(dir, "README.md\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "read", limit: 5 });
      service.dispose();

      expect(service.getCacheStats().size).toBe(0);
      await service.search({ cwd: dir, query: "read", limit: 5 });
      expect(gitClientMock.raw).toHaveBeenCalledTimes(2);
    });
  });

  describe("git ls-files NUL handling", () => {
    it("preserves filenames containing newlines and tabs via NUL-delimited output", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("src/weird\nname.ts\0src/with\ttab.ts\0clean.ts\0");

      const service = await createService();
      const result = await service.search({ cwd: dir, query: "", limit: 99 });

      expect(result).toContain("src/weird\nname.ts");
      expect(result).toContain("src/with\ttab.ts");
      expect(result).toContain("clean.ts");
    });

    it("passes -z to git ls-files", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      gitClientMock.checkIsRepo.mockResolvedValue(true);
      gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
      gitClientMock.raw.mockResolvedValue("a.ts\0");

      const service = await createService();
      await service.search({ cwd: dir, query: "a", limit: 5 });

      const callArgs = gitClientMock.raw.mock.calls[0][0];
      expect(callArgs).toContain("-z");
    });
  });
});
