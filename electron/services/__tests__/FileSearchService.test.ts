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

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    simpleGitMock.mockImplementation(() => gitClientMock);
    gitClientMock.env.mockReturnValue(gitClientMock);
    gitClientMock.checkIsRepo.mockResolvedValue(false);
    gitClientMock.revparse.mockRejectedValue(new Error("not a git repository"));
    gitClientMock.raw.mockResolvedValue("");
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function createService() {
    const { FileSearchService } = await import("../FileSearchService.js");
    return new FileSearchService();
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
    expect(gitClientMock.revparse).toHaveBeenCalledTimes(1);
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
    expect(gitClientMock.revparse).toHaveBeenCalledTimes(1);
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
