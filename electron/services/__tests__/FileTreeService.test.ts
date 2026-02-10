import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileTreeService } from "../FileTreeService.js";

describe("FileTreeService", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-file-tree-"));
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
        path: path.join("src", "main.ts"),
        isDirectory: false,
      }),
    ]);
  });

  it("blocks dirPath values that resolve through symlinks outside base path", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-file-tree-outside-"));
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
