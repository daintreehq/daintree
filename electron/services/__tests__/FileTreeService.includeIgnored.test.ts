import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { checkIgnoredPaths } from "../../utils/gitCheckIgnore.js";
import { FileTreeService, _resetBaseRealpathCacheForTests } from "../FileTreeService.js";

vi.mock("../../utils/gitCheckIgnore.js", () => ({
  checkIgnoredPaths: vi.fn(async () => new Set<string>()),
}));

const mockedCheckIgnoredPaths = vi.mocked(checkIgnoredPaths);

// `includeIgnored: true` is the file browser's raw-listing mode: skip the git
// check-ignore pass entirely (no subprocess, no annotation) and return every
// entry, including gitignored ones and `.git` (#11330). Default mode — the
// copy-tree picker — keeps its fail-closed, ignore-filtering behavior.
describe("FileTreeService raw-listing mode (includeIgnored)", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-ignored-"));
    service = new FileTreeService();
    _resetBaseRealpathCacheForTests();
    mockedCheckIgnoredPaths.mockReset();
    mockedCheckIgnoredPaths.mockResolvedValue(new Set<string>());

    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "dist", "bundle.js"), "//");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("drops ignored entries by default, preserving the copy-tree picker's behavior", async () => {
    mockedCheckIgnoredPaths.mockResolvedValue(new Set(["dist"]));

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.map((node) => node.path)).toEqual(["app.ts"]);
  });

  it("returns every entry in raw mode without running check-ignore", async () => {
    // Even a mock that would report `dist` ignored must not be consulted — raw
    // mode bypasses the pass entirely.
    mockedCheckIgnoredPaths.mockResolvedValue(new Set(["dist"]));

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    expect(nodes.map((node) => node.path).sort()).toEqual(["app.ts", "dist"]);
    expect(mockedCheckIgnoredPaths).not.toHaveBeenCalled();
  });

  it("never annotates entries with isIgnored in raw mode", async () => {
    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    for (const node of nodes) {
      expect(Object.hasOwn(node, "isIgnored")).toBe(false);
    }
  });

  it("surfaces .git in raw mode so the junk list can hide it transparently", async () => {
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    expect(nodes.some((node) => node.name === ".git")).toBe(true);
  });

  it("keeps .git out of the default (copy-tree) listing", async () => {
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.some((node) => node.name === ".git")).toBe(false);
  });

  it("still hides everything when check-ignore fails in default mode", async () => {
    mockedCheckIgnoredPaths.mockRejectedValue(new Error("git exploded"));

    const nodes = await service.getFileTree(tempDir);

    // Fail-closed: a broken git must never leak build output or secret-like
    // files into the default listing. Raw mode bypasses this path entirely, so
    // the safety property is untouched.
    expect(nodes).toEqual([]);
  });

  it("still drops symlinked entries in raw mode", async () => {
    // Symlink-drop is a containment property, independent of ignore filtering —
    // raw mode must not weaken it.
    try {
      await fs.symlink(path.join(tempDir, "app.ts"), path.join(tempDir, "link.ts"));
    } catch {
      // Some CI filesystems disallow symlinks; the drop is still asserted by the
      // absence below, and a failed symlink create just means no link exists.
    }

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    expect(nodes.some((node) => node.name === "link.ts")).toBe(false);
  });
});
