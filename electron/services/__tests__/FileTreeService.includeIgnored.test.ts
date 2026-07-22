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

describe("FileTreeService includeIgnored", () => {
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

  it("returns ignored entries flagged when the caller opts in", async () => {
    mockedCheckIgnoredPaths.mockResolvedValue(new Set(["dist"]));

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    expect(nodes.map((node) => [node.path, node.isIgnored === true])).toEqual([
      ["dist", true],
      ["app.ts", false],
    ]);
  });

  it("omits the flag entirely for entries git does not ignore", async () => {
    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    // Absent rather than `false`, so an opted-in listing serializes the same as
    // the default one for every clean entry.
    for (const node of nodes) {
      expect(Object.hasOwn(node, "isIgnored")).toBe(false);
    }
  });

  it("still hides everything when check-ignore fails, even with includeIgnored off", async () => {
    mockedCheckIgnoredPaths.mockRejectedValue(new Error("git exploded"));

    const nodes = await service.getFileTree(tempDir);

    // Fail-closed: a broken git must never leak build output or secret-like
    // files into the default listing.
    expect(nodes).toEqual([]);
  });

  it("marks every entry ignored when check-ignore fails and the caller opted in", async () => {
    mockedCheckIgnoredPaths.mockRejectedValue(new Error("git exploded"));

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    // Opting in must not weaken the fail-closed path into a silent "everything
    // is clean" — the entries appear, but honestly labelled.
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.isIgnored === true)).toBe(true);
  });

  it("keeps .git out of the listing regardless of the flag", async () => {
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });

    const nodes = await service.getFileTree(tempDir, "", { includeIgnored: true });

    expect(nodes.some((node) => node.name === ".git")).toBe(false);
  });
});
