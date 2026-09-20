import { describe, expect, it, vi } from "vitest";
import type { BuiltinPluginFsApi } from "../../../../../shared/types/plugin.js";
import { MAX_SOURCE_BYTES, readRevision, readSource, sha256Hex } from "../source.js";
import { MAX_CONCURRENT_SCANS, MAX_QUEUED_SCANS, ScanGate } from "../workspace.js";

/**
 * A fake `host.fs` with the bounded read the in-process host provides. It
 * answers from the size it was built with, exactly as the real one answers
 * from the opened descriptor, and records whether anything asked for a path
 * stat or an uncapped read — the two things the bounded path must no longer
 * need.
 */
function boundedFs(size: number, options: { isFile?: boolean; text?: string } = {}) {
  const readFileBytes = vi.fn(async () => new Uint8Array(size));
  const stat = vi.fn(async () => ({
    isDirectory: false,
    isFile: options.isFile ?? true,
    isSymbolicLink: false,
    size,
    mtimeMs: 0,
  }));
  const readFileBounded = vi.fn(async (_path: string, read: { limitBytes: number }) => {
    if (options.isFile === false) return { status: "not-a-file" as const };
    if (size > read.limitBytes) return { status: "too-large" as const };
    const bytes = options.text ? new TextEncoder().encode(options.text) : new Uint8Array(size);
    return { status: "ok" as const, bytes };
  });
  const fs = { readFileBytes, readFileBounded, stat } as unknown as BuiltinPluginFsApi;
  return { fs, readFileBytes, readFileBounded, stat };
}

/** A handle from before the bounded read existed — a proxied host, or an older double. */
function legacyFs(size: number, options: { statThrows?: boolean; isFile?: boolean } = {}) {
  const readFileBytes = vi.fn(async () => new Uint8Array(size));
  const stat = vi.fn(async () => {
    if (options.statThrows) throw new Error("no stat here");
    return {
      isDirectory: false,
      isFile: options.isFile ?? true,
      isSymbolicLink: false,
      size,
      mtimeMs: 0,
    };
  });
  return { fs: { readFileBytes, stat } as unknown as BuiltinPluginFsApi, readFileBytes, stat };
}

describe("source reads are bounded before they allocate", () => {
  it("refuses an oversized file without reading it", async () => {
    const big = boundedFs(MAX_SOURCE_BYTES + 1);

    expect(await readSource(big.fs, "/app/src/huge.svelte")).toEqual({ status: "too-large" });
    // The point of the change: the bytes never came into main at all.
    expect(big.readFileBytes).not.toHaveBeenCalled();
    expect(big.readFileBounded).toHaveBeenCalledWith(
      "/app/src/huge.svelte",
      expect.objectContaining({ limitBytes: MAX_SOURCE_BYTES })
    );
  });

  it("stops at the cap inside the read rather than measuring afterwards", async () => {
    // A file that outgrows the cap between being named and being read. The
    // bounded read stops one byte past the limit, so there is no window in
    // which main holds more than that and no post-read check to reach.
    const grown = boundedFs(MAX_SOURCE_BYTES * 400);

    expect(await readSource(grown.fs, "/app/src/growing.svelte")).toEqual({ status: "too-large" });
    expect(grown.readFileBytes).not.toHaveBeenCalled();
  });

  it("never reads something that is not a regular file", async () => {
    // A FIFO named `x.svelte` stats as size 0 and its read need never end, so
    // the cap alone would wave it through. The verdict comes from the opened
    // descriptor, which is what the fake reports here.
    const fifo = boundedFs(0, { isFile: false });

    expect(await readSource(fifo.fs, "/app/src/pipe.svelte")).toEqual({ status: "missing" });
    expect(await readRevision(fifo.fs, "/app/src/pipe.svelte")).toBeNull();
    expect(fifo.readFileBytes).not.toHaveBeenCalled();
  });

  it("reads a file within the cap as usual", async () => {
    const ok = boundedFs(4, { text: "<p>x" });

    expect(await readSource(ok.fs, "/app/src/small.svelte")).toMatchObject({
      status: "ok",
      text: "<p>x",
    });
  });

  it("decides from the opened file alone, never from a stat of the path", async () => {
    // This used to be "falls back to the read when the file cannot be stat'd":
    // a path stat ran first, and one that threw fell through to an unbounded
    // read. The bounded read takes its verdict from an fstat on the descriptor
    // it opened, so there is no separate stat left to fail — and a file the
    // path stat would have misreported is read under the cap regardless.
    const ok = boundedFs(4, { text: "<p>x" });

    expect(await readSource(ok.fs, "/app/src/small.svelte")).toMatchObject({ status: "ok" });
    expect(ok.stat).not.toHaveBeenCalled();
    expect(ok.readFileBytes).not.toHaveBeenCalled();
  });

  it("still bounds a handle that has no bounded read, the old way", async () => {
    // Test doubles and the out-of-process proxy have only stat-then-read. The
    // fallback keeps the behaviour that was there before, holes included: an
    // unreadable stat is not evidence of size, so the read still decides.
    const unknown = legacyFs(4, { statThrows: true });
    unknown.readFileBytes.mockResolvedValue(new TextEncoder().encode("<p>x"));

    expect(await readSource(unknown.fs, "/app/src/small.svelte")).toMatchObject({ status: "ok" });
    expect(unknown.readFileBytes).toHaveBeenCalled();

    const big = legacyFs(MAX_SOURCE_BYTES + 1);
    expect(await readSource(big.fs, "/app/src/huge.svelte")).toEqual({ status: "too-large" });
    expect(big.readFileBytes).not.toHaveBeenCalled();
  });
});

describe("the tracker's revision reads obey the same cap", () => {
  it("reports no revision for an oversized file, and never hashes it", async () => {
    const big = boundedFs(MAX_SOURCE_BYTES + 1);

    expect(await readRevision(big.fs, "/app/src/huge.svelte")).toBeNull();
    expect(big.readFileBytes).not.toHaveBeenCalled();
  });

  it("hashes a file within the cap", async () => {
    const ok = boundedFs(4, { text: "<p>x" });

    expect(await readRevision(ok.fs, "/app/src/small.svelte")).toBe(
      sha256Hex(new TextEncoder().encode("<p>x"))
    );
  });

  it("reports no revision for a file that is gone", async () => {
    const gone = boundedFs(4);
    gone.readFileBounded.mockRejectedValue(new Error("ENOENT"));

    expect(await readRevision(gone.fs, "/app/src/gone.svelte")).toBeNull();
  });
});

/**
 * The scan gate lives beside the source caps because it bounds the same thing
 * from the other end: how much scanning main will do at once, however often a
 * renderer asks.
 */
describe("worktree scans are bounded in number", () => {
  it("runs no more than the concurrency cap at a time", async () => {
    const gate = new ScanGate();
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const scans = Array.from({ length: MAX_CONCURRENT_SCANS + 3 }, () =>
      gate.run(null, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peak).toBe(MAX_CONCURRENT_SCANS);
    while (release.length > 0) {
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(scans);
    expect(peak).toBe(MAX_CONCURRENT_SCANS);
  });

  it("refuses a scan once the queue is full rather than growing it", async () => {
    const gate = new ScanGate();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    const held = Array.from({ length: MAX_CONCURRENT_SCANS + MAX_QUEUED_SCANS }, () =>
      gate.run(null, () => holding)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(gate.run(null, async () => undefined)).rejects.toThrow(/SCAN_BUSY/);

    open();
    await Promise.all(held);
  });

  it("drops a queued scan whose workspace closed before its turn came", async () => {
    // A queued scan nobody will read must not hold capacity until it reaches
    // the front: the close takes it out of the queue.
    const gate = new ScanGate();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    const held = Array.from({ length: MAX_CONCURRENT_SCANS }, () => gate.run(null, () => holding));
    const closing = new AbortController();
    let ranAfterClose = false;
    const queued = gate.run(
      null,
      async () => {
        ranAfterClose = true;
      },
      closing.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    closing.abort();

    await expect(queued).rejects.toThrow(/abort/i);
    open();
    await Promise.all(held);
    expect(ranAfterClose).toBe(false);
  });

  it("leaves no abort listener behind on a scan that waited its turn", async () => {
    // The signal is the workspace lifetime, not one scan's: a listener per
    // queued scan accumulates for as long as the workspace is open.
    const gate = new ScanGate();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    const held = Array.from({ length: MAX_CONCURRENT_SCANS }, () => gate.run(null, () => holding));
    const lifetime = new AbortController();
    let listeners = 0;
    const signal = lifetime.signal;
    const added = signal.addEventListener.bind(signal);
    const removed = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof added>) => {
      listeners += 1;
      return added(...args);
    }) as typeof added;
    signal.removeEventListener = ((...args: Parameters<typeof removed>) => {
      listeners -= 1;
      return removed(...args);
    }) as typeof removed;

    const queued = Array.from({ length: 8 }, () => gate.run(null, async () => "done", signal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listeners).toBe(8);

    open();
    await Promise.all(held);
    await Promise.all(queued);

    expect(listeners).toBe(0);
  });

  it("gives two askers with the same key one scan, not two", async () => {
    const gate = new ScanGate();
    let walks = 0;
    const walk = async () => {
      walks += 1;
      return "answer";
    };

    const [first, second] = await Promise.all([
      gate.run("worktree-a", walk),
      gate.run("worktree-a", walk),
    ]);

    expect([first, second]).toEqual(["answer", "answer"]);
    expect(walks).toBe(1);
    // The entry is cleared once it settles, so a later ask re-reads the tree.
    expect(await gate.run("worktree-a", walk)).toBe("answer");
    expect(walks).toBe(2);
  });
});
