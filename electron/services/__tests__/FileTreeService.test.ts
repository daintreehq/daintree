import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileTreeService } from "../FileTreeService.js";

// The temp dirs created below are NOT git repos — `git check-ignore` would
// reject and the service would fail-closed (hide every entry). Stub the
// helper so the integration tests only exercise fs/realpath/path logic.
vi.mock("../../utils/gitCheckIgnore.js", () => ({
  checkIgnoredPaths: vi.fn(async () => new Set<string>()),
}));

describe("FileTreeService", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-"));
    service = new FileTreeService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects leading path traversal attempts instead of remapping paths", async () => {
    await fs.mkdir(path.join(tempDir, "safe"), { recursive: true });

    await expect(service.getFileTree(tempDir, "../safe")).rejects.toThrow(
      "path traversal not allowed"
    );
  });

  it("rejects nested traversal segments", async () => {
    await fs.mkdir(path.join(tempDir, "safe"), { recursive: true });

    await expect(service.getFileTree(tempDir, "nested/../../safe")).rejects.toThrow(
      "path traversal not allowed"
    );
  });

  it("allows valid relative paths", async () => {
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "main.ts"), "console.log('ok');");

    const result = await service.getFileTree(tempDir, "src");

    expect(result).toEqual([
      expect.objectContaining({
        name: "main.ts",
        path: "src/main.ts",
        isDirectory: false,
      }),
    ]);
  });

  it("sorts sibling names in natural numeric order", async () => {
    // Deliberately non-natural creation order so a plain lexicographic sort
    // (which would place version_10 between version_1 and version_2) fails.
    const names = [
      "version_10",
      "version_1",
      "version_9",
      "version_2",
      "version_8",
      "version_3",
      "version_7",
      "version_4",
      "version_6",
      "version_5",
    ];
    for (const name of names) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);

    expect(result.map((node) => node.name)).toEqual([
      "version_1",
      "version_2",
      "version_3",
      "version_4",
      "version_5",
      "version_6",
      "version_7",
      "version_8",
      "version_9",
      "version_10",
    ]);
  });

  it("orders bare numeric names numerically and before alphanumeric names", async () => {
    for (const name of ["file2", "10", "2"]) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);

    expect(result.map((node) => node.name)).toEqual(["2", "10", "file2"]);
  });

  it("keeps directories before files regardless of name order", async () => {
    await fs.mkdir(path.join(tempDir, "z"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "a"), "");

    const result = await service.getFileTree(tempDir);

    expect(result.map(({ name, isDirectory }) => ({ name, isDirectory }))).toEqual([
      { name: "z", isDirectory: true },
      { name: "a", isDirectory: false },
    ]);
  });

  it("places leading-zero forms before the next numeric value", async () => {
    // Leading-zero variants share the same numeric value, so ICU numeric
    // collation compares them equal — their relative order is undefined. Assert
    // only the defined behavior: the whole 1-valued group sorts before file2.
    for (const name of ["file2", "file1", "file01", "file001"]) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);
    const names = result.map((node) => node.name);

    expect(names.slice(0, 3)).toEqual(expect.arrayContaining(["file1", "file01", "file001"]));
    expect(names[3]).toBe("file2");
  });

  it("blocks dirPath values that resolve through symlinks outside base path", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-outside-"));
    await fs.writeFile(path.join(outsideDir, "outside.txt"), "outside");

    const linkPath = path.join(tempDir, "external-link");

    try {
      try {
        await fs.symlink(outsideDir, linkPath, "dir");
      } catch (error) {
        // Some environments disallow symlink creation; skip instead of failing unrelated behavior.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          return;
        }
        throw error;
      }

      await expect(service.getFileTree(tempDir, "external-link")).rejects.toThrow(
        "path traversal not allowed"
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
