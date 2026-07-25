import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileTreeService } from "../FileTreeService.js";

// The temp dirs created below are NOT git repos, and that is no longer a
// special case: this service is a raw listing with no git dependency at all.
// Deciding what belongs in a context is `CopyTreeService.getFileTree`'s job
// (#11439).
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
    // The old lexicographic comparator sorts version_10 between version_1 and
    // version_2; assert the full natural order instead. Input is scrambled so
    // the result can't accidentally pass by echoing insertion order.
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

  it("orders bare numeric names numerically", async () => {
    for (const name of ["10", "2"]) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);

    expect(result.map((node) => node.name)).toEqual(["2", "10"]);
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

  it("breaks leading-zero ties deterministically rather than by readdir order", async () => {
    // Leading-zero variants share the same numeric value, so ICU numeric
    // collation ranks them equal; without a tiebreak the order would fall
    // through to filesystem enumeration order. Building the same set in two
    // opposite creation orders must therefore yield identical listings, with
    // the equal-valued group ahead of file2.
    const names = ["file2", "file1", "file01", "file001"];
    const forwardDir = path.join(tempDir, "forward");
    const reverseDir = path.join(tempDir, "reverse");
    await fs.mkdir(forwardDir);
    await fs.mkdir(reverseDir);
    for (const name of names) {
      await fs.writeFile(path.join(forwardDir, name), "");
    }
    for (const name of [...names].reverse()) {
      await fs.writeFile(path.join(reverseDir, name), "");
    }

    const forward = (await service.getFileTree(tempDir, "forward")).map((node) => node.name);
    const reverse = (await service.getFileTree(tempDir, "reverse")).map((node) => node.name);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual(["file001", "file01", "file1", "file2"]);
  });

  it("returns every entry including .git and gitignored paths", async () => {
    // Migrated from the old raw-mode suite. The listing takes no view on
    // visibility: the file browser hides entries client-side (#11330) and the
    // context picker asks CopyTree (#11439), so filtering anything here would
    // rob both callers of a choice.
    await fs.writeFile(path.join(tempDir, ".gitignore"), "dist/\n");
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.map((node) => node.name).sort()).toEqual([".git", ".gitignore", "app.ts", "dist"]);
  });

  it("omits symlinked entries", async () => {
    // Containment property, independent of any ignore filtering.
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");
    try {
      await fs.symlink(path.join(tempDir, "app.ts"), path.join(tempDir, "link.ts"));
    } catch (error) {
      // Only platforms that genuinely forbid symlinks may skip: without a link
      // on disk the assertion below proves nothing, so any other setup failure
      // has to surface rather than pass as a silent no-op.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.some((node) => node.name === "app.ts")).toBe(true);
    expect(nodes.some((node) => node.name === "link.ts")).toBe(false);
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
