import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD_CTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "preload.cts");

// Read as text: `preload.cts` is CommonJS built for the Electron sandbox and
// pulls in `electron` at module scope, so it cannot be imported here.
async function preloadSource(): Promise<string> {
  return readFile(PRELOAD_CTS, "utf8");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("native path recovery for dropped files", () => {
  it("is not exposed as a global webUtils bridge", async () => {
    const code = withoutComments(await preloadSource());

    expect(code).not.toMatch(/\bwebUtils\s*:/);
    expect(code).not.toContain("getDroppedFilePath:");
  });

  it("goes through exactly one purpose-named batch bridge under files", async () => {
    const code = withoutComments(await preloadSource());

    const calls = code.match(/webUtils\.getPathForFile\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const start = code.indexOf("    files: {");
    expect(start, "files namespace not found in preload.cts").toBeGreaterThan(-1);
    const end = code.indexOf("\n    },", start);
    expect(end, "files namespace closing not found in preload.cts").toBeGreaterThan(start);
    const block = code.slice(start, end);

    expect(block).toMatch(/getDroppedFilePaths:\s*\(files: readonly File\[\]\)/);
    expect(block).toContain("webUtils.getPathForFile(");
  });
});
