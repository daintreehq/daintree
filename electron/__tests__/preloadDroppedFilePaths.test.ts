import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDroppedFilePathsBinding } from "../utils/droppedFilePaths.js";

const PRELOAD_CTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "preload.cts");

// `preload.cts` is CommonJS built for the Electron sandbox and is not
// transformable by Vitest, so the binding it exposes is exercised directly and
// its wiring is pinned by source.
async function preloadCode(): Promise<string> {
  return (await readFile(PRELOAD_CTS, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("native path recovery for dropped files", () => {
  it("maps each dropped File to its native path, positionally, with '' for one not on disk", () => {
    const a = new File(["a"], "a.txt");
    const pasted = new File(["b"], "image.png");
    const c = new File(["c"], "c.md");
    const known = new Map<File, string>([
      [a, "/work/a.txt"],
      [c, "/work/docs/c.md"],
    ]);
    const getPathForFile = vi.fn((file: File) => known.get(file) ?? "");
    const getDroppedFilePaths = buildDroppedFilePathsBinding<File>(getPathForFile);

    expect(getDroppedFilePaths([a, pasted, c])).toEqual(["/work/a.txt", "", "/work/docs/c.md"]);
    expect(getPathForFile.mock.calls.map(([file]) => file)).toEqual([a, pasted, c]);
  });

  it("accepts an array-like FileList and returns an empty list for no files", () => {
    const getPathForFile = vi.fn((file: File) => `/x/${file.name}`);
    const getDroppedFilePaths = buildDroppedFilePathsBinding<File>(getPathForFile);
    const one = new File(["1"], "one.txt");

    expect(getDroppedFilePaths([])).toEqual([]);
    expect(getPathForFile).not.toHaveBeenCalled();
    const fileList = { 0: one, length: 1 } as unknown as readonly File[];
    expect(getDroppedFilePaths(fileList)).toEqual(["/x/one.txt"]);
  });

  it("is wired to webUtils through the files namespace, never exposed as webUtils", async () => {
    const code = await preloadCode();

    expect(code).not.toMatch(/\bwebUtils\s*:/);
    expect(code).not.toContain("getDroppedFilePath:");
    expect(code.match(/webUtils\.getPathForFile\(/g) ?? []).toHaveLength(1);

    const start = code.indexOf("    files: {");
    expect(start, "files namespace not found in preload.cts").toBeGreaterThan(-1);
    const end = code.indexOf("\n    },", start);
    expect(end, "files namespace closing not found in preload.cts").toBeGreaterThan(start);
    expect(code.slice(start, end)).toMatch(
      /getDroppedFilePaths:\s*buildDroppedFilePathsBinding<File>\(\s*\(file\)\s*=>\s*webUtils\.getPathForFile\(file\),/
    );
  });

  it("tells the grant only the paths that resolved, and nothing for none", () => {
    const grant = vi.fn();
    const known = new Map<string, string>([["a.txt", "/work/a.txt"]]);
    const getDroppedFilePaths = buildDroppedFilePathsBinding<File>(
      (file) => known.get(file.name) ?? "",
      grant
    );
    expect(
      getDroppedFilePaths([new File(["a"], "a.txt"), new File(["b"], "synthetic.bin")])
    ).toEqual(["/work/a.txt", ""]);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith(["/work/a.txt"]);
    getDroppedFilePaths([new File(["b"], "synthetic.bin")]);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("records resolved paths in main only for a view attached to a remote host", async () => {
    const code = await preloadCode();
    const start = code.indexOf("    files: {");
    const end = code.indexOf("\n    },", start);
    // The grant rides a preload-only send, gated on the view's host argument;
    // a local view passes no grant and so sends nothing.
    expect(code.slice(start, end)).toMatch(
      /viewHostId\s*\?\s*\(paths\)\s*=>\s*ipcRenderer\.send\(CHANNELS\.FILE_TRANSFER_GRANT_LOCAL_SOURCES,\s*paths\)\s*:\s*undefined/
    );
    // Never exposed on the page's bridge.
    expect(code.match(/FILE_TRANSFER_GRANT_LOCAL_SOURCES/g) ?? []).toHaveLength(1);
  });
});
