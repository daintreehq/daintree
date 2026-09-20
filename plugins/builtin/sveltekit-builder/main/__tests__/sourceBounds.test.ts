import { describe, expect, it, vi } from "vitest";
import type { PluginFsApi } from "../../../../../shared/types/plugin.js";
import { MAX_SOURCE_BYTES, readRevision, readSource, sha256Hex } from "../source.js";

/**
 * A fake `host.fs` that records how much it was asked to hand over, so a test
 * can tell "refused after reading it all" from "never read it".
 */
function fakeFs(size: number, options: { statThrows?: boolean; isFile?: boolean } = {}) {
  const readFileBytes = vi.fn(async () => new Uint8Array(size));
  const stat = vi.fn(async () => {
    if (options.statThrows) throw new Error("no stat here");
    const isFile = options.isFile ?? true;
    return { isDirectory: false, isFile, isSymbolicLink: false, size, mtimeMs: 0 };
  });
  return { fs: { readFileBytes, stat } as unknown as PluginFsApi, readFileBytes, stat };
}

describe("source reads are bounded before they allocate", () => {
  it("refuses an oversized file without reading it", () => {
    const big = fakeFs(MAX_SOURCE_BYTES + 1);
    return readSource(big.fs, "/app/src/huge.svelte").then((result) => {
      expect(result).toEqual({ status: "too-large" });
      // The point of the change: the bytes never came into main at all.
      expect(big.readFileBytes).not.toHaveBeenCalled();
    });
  });

  it("still refuses a file that grew past the cap after the stat", async () => {
    // The stat says it fits and the read returns more — the race the stat
    // cannot close. The post-read check is what catches it.
    const grown = fakeFs(10);
    grown.readFileBytes.mockResolvedValueOnce(new Uint8Array(MAX_SOURCE_BYTES + 1));

    expect(await readSource(grown.fs, "/app/src/growing.svelte")).toEqual({ status: "too-large" });
    expect(grown.readFileBytes).toHaveBeenCalled();
  });

  it("never reads something that is not a regular file", async () => {
    // A FIFO named `x.svelte` stats as size 0 and its read need never end, so
    // the cap alone would wave it through.
    const fifo = fakeFs(0, { isFile: false });

    expect(await readSource(fifo.fs, "/app/src/pipe.svelte")).toEqual({ status: "missing" });
    expect(await readRevision(fifo.fs, "/app/src/pipe.svelte")).toBeNull();
    expect(fifo.readFileBytes).not.toHaveBeenCalled();
  });

  it("reads a file within the cap as usual", async () => {
    const ok = fakeFs(4);
    ok.readFileBytes.mockResolvedValue(new TextEncoder().encode("<p>x"));

    const result = await readSource(ok.fs, "/app/src/small.svelte");
    expect(result).toMatchObject({ status: "ok", text: "<p>x" });
  });

  it("falls back to the read when the file cannot be stat'd", async () => {
    // An unreadable stat is not evidence of size, so the read still decides.
    const unknown = fakeFs(4, { statThrows: true });
    unknown.readFileBytes.mockResolvedValue(new TextEncoder().encode("<p>x"));

    expect(await readSource(unknown.fs, "/app/src/small.svelte")).toMatchObject({ status: "ok" });
    expect(unknown.readFileBytes).toHaveBeenCalled();
  });
});

describe("the tracker's revision reads obey the same cap", () => {
  it("reports no revision for an oversized file, and never hashes it", async () => {
    const big = fakeFs(MAX_SOURCE_BYTES + 1);

    expect(await readRevision(big.fs, "/app/src/huge.svelte")).toBeNull();
    expect(big.readFileBytes).not.toHaveBeenCalled();
  });

  it("hashes a file within the cap", async () => {
    const ok = fakeFs(4);
    const bytes = new TextEncoder().encode("<p>x");
    ok.readFileBytes.mockResolvedValue(bytes);

    expect(await readRevision(ok.fs, "/app/src/small.svelte")).toBe(sha256Hex(bytes));
  });

  it("reports no revision for a file that is gone", async () => {
    const gone = fakeFs(4);
    gone.readFileBytes.mockRejectedValue(new Error("ENOENT"));

    expect(await readRevision(gone.fs, "/app/src/gone.svelte")).toBeNull();
  });
});
