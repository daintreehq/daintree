import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const simpleGitMock = vi.hoisted(() => vi.fn());
const gitClientMock = vi.hoisted(() => ({
  checkIsRepo: vi.fn<() => Promise<boolean>>(),
  revparse: vi.fn<(args: string[]) => Promise<string>>(),
  raw: vi.fn<(args: string[]) => Promise<string>>(),
}));

vi.mock("simple-git", () => ({
  simpleGit: simpleGitMock,
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canopy-file-search-"));
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
    gitClientMock.checkIsRepo.mockResolvedValue(false);
    gitClientMock.revparse.mockResolvedValue("");
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
    const missingDir = path.join(os.tmpdir(), "canopy-does-not-exist", `${Date.now()}`);

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
    expect(gitClientMock.checkIsRepo).toHaveBeenCalledTimes(1);
  });

  it("uses git file listing when repository is available", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("README.md\nsrc/main.ts\nsrc/components/Button.tsx\n");

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
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\nsrc/components/Input.tsx\n");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "./src//components//button", limit: 5 });

    expect(result).toEqual(["src/components/Button.tsx"]);
  });

  it("reuses cached file list across repeated searches for same cwd", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("README.md\nsrc/main.ts\npackage.json\n");

    const service = await createService();
    const first = await service.search({ cwd: dir, query: "src", limit: 5 });
    const second = await service.search({ cwd: dir, query: "read", limit: 5 });

    expect(first).toContain("src/main.ts");
    expect(second).toContain("README.md");
    expect(gitClientMock.checkIsRepo).toHaveBeenCalledTimes(1);
    expect(gitClientMock.raw).toHaveBeenCalledTimes(1);
  });

  it("returns shortest paths first when query is empty", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    gitClientMock.checkIsRepo.mockResolvedValue(true);
    gitClientMock.revparse.mockResolvedValue(`${dir}\n`);
    gitClientMock.raw.mockResolvedValue("src/components/Button.tsx\na.ts\nREADME.md\n");

    const service = await createService();
    const result = await service.search({ cwd: dir, query: "", limit: 3 });

    expect(result).toEqual(["a.ts", "src/", "README.md"]);
  });
});
