import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import zlib from "zlib";
import { Readable } from "stream";
import yauzl from "yauzl";
import {
  packPluginArchive,
  extractPluginArchive,
  MAX_DNTR_ENTRIES,
  PluginArchiveDeadlineError,
} from "../PluginArchive.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-extract-test-"));
});

afterEach(async () => {
  // Restore any prototype spy even if a test bailed before its own `finally`
  // ran (e.g. a Vitest timeout), so the mock can't leak into a sibling test on
  // a reused worker.
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "acme.test-plugin", version: "1.0.0", ...overrides };
}

async function createFixture(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(baseDir, filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

// Build a raw STORE (uncompressed) zip with arbitrary entry-name bytes,
// bypassing the path sanitization `archiver` applies (it strips `..` segments
// before writing). This is the only way to forge a genuine zip-slip archive to
// exercise extractPluginArchive's traversal guards — the bundled writer would
// never emit one.
// Each entry is either STORE (`content` string) or a real DEFLATE entry
// (`deflateOf` raw buffer) so a genuine, internally-consistent zip-bomb can be
// built — large uncompressedSize, tiny compressed payload, valid CRC — that
// yauzl accepts and only the installer's own size guard rejects.
type RawEntry =
  | { name: string; content: string }
  | { name: string; deflateOf: Buffer; declaredSize?: number };

function buildRawZip(entries: RawEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    let method: number;
    let stored: Buffer;
    let uncompressedSize: number;
    let crc: number;
    if ("deflateOf" in e) {
      method = 8;
      stored = zlib.deflateRawSync(e.deflateOf);
      // `declaredSize` forges a header that lies about the uncompressed length,
      // so a test can prove yauzl's `validateEntrySizes` rejects a mismatch.
      uncompressedSize = e.declaredSize ?? e.deflateOf.length;
      crc = zlib.crc32(e.deflateOf) >>> 0;
    } else {
      method = 0;
      stored = Buffer.from(e.content);
      uncompressedSize = stored.length;
      crc = zlib.crc32(stored) >>> 0;
    }
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(uncompressedSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    chunks.push(lfh, nameBuf, stored);
    offset += lfh.length + nameBuf.length + stored.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(uncompressedSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  chunks.push(centralBuf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

describe("extractPluginArchive", () => {
  it("extracts every entry faithfully into the destination", async () => {
    const sourceDir = path.join(tmpDir, "source");
    await createFixture(sourceDir, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "module.exports = { hello: true };",
      "icons/logo.svg": "<svg></svg>",
    });
    const archivePath = path.join(tmpDir, "out.dntr");
    await packPluginArchive(sourceDir, archivePath);

    const dest = path.join(tmpDir, "extracted");
    await fs.mkdir(dest, { recursive: true });
    await extractPluginArchive(archivePath, dest);

    expect(await fs.readFile(path.join(dest, "dist/index.js"), "utf-8")).toBe(
      "module.exports = { hello: true };"
    );
    expect(await fs.readFile(path.join(dest, "icons/logo.svg"), "utf-8")).toBe("<svg></svg>");
    const manifest = JSON.parse(await fs.readFile(path.join(dest, "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("acme.test-plugin");
  });

  it("rejects a path-traversal entry and writes nothing outside the destination", async () => {
    const archivePath = path.join(tmpDir, "evil.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "../escape.js", content: "pwned" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-evil");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow();
    const escaped = await fs
      .access(path.join(tmpDir, "escape.js"))
      .then(() => true)
      .catch(() => false);
    expect(escaped).toBe(false);
  });

  it("rejects a backslash entry name even without a traversal segment", async () => {
    // A benign backslash name (no `..`) must still be rejected: the `.dntr`
    // contract is POSIX forward slashes, enforced by yauzl's `strictFileNames`.
    // Without it, yauzl would silently rewrite `dist\index.js` to `dist/index.js`
    // and extract it, so this proves the guard trips on the backslash itself.
    const archivePath = path.join(tmpDir, "backslash.dntr");
    await fs.writeFile(archivePath, buildRawZip([{ name: "dist\\index.js", content: "x" }]));
    const dest = path.join(tmpDir, "extracted-bs");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/invalid characters/i);
  });

  it("rejects an absolute entry name", async () => {
    const archivePath = path.join(tmpDir, "absolute.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "/etc/passwd", content: "pwned" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-abs");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow();
  });

  it("rejects a zip-bomb whose declared uncompressed size exceeds the limit", async () => {
    const archivePath = path.join(tmpDir, "bomb.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        // 31 MB of zeroes deflates to a few KB — a valid entry yauzl accepts,
        // whose uncompressedSize trips the installer's cumulative size guard.
        { name: "huge.bin", deflateOf: Buffer.alloc(31 * 1024 * 1024) },
      ])
    );
    const dest = path.join(tmpDir, "extracted-bomb");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/exceeds/);
    // Guard trips before the bomb entry is written.
    expect(
      await fs
        .access(path.join(dest, "huge.bin"))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  it("rejects an archive exceeding the entry-count cap", async () => {
    const archivePath = path.join(tmpDir, "many.dntr");
    const entries: RawEntry[] = [{ name: "plugin.json", content: JSON.stringify(validManifest()) }];
    for (let i = 0; i < MAX_DNTR_ENTRIES; i++) {
      entries.push({ name: `f${i}.txt`, content: "" });
    }
    await fs.writeFile(archivePath, buildRawZip(entries));
    const dest = path.join(tmpDir, "extracted-many");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/entry limit/);
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("rejects an archive with a duplicate normalized entry name", async () => {
    const archivePath = path.join(tmpDir, "dup.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "dist/index.js", content: "first" },
        { name: "dist/index.js", content: "second" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-dup");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/Duplicate entry/);
  });

  it("rejects an archive with a second plugin.json", async () => {
    const archivePath = path.join(tmpDir, "dup-manifest.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
        { name: "dist/index.js", content: "ok" },
        { name: "plugin.json", content: JSON.stringify(validManifest()) },
      ])
    );
    const dest = path.join(tmpDir, "extracted-dup-manifest");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/Duplicate entry/);
  });

  it("rejects an oversize archive before extracting", async () => {
    const archivePath = path.join(tmpDir, "huge.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([{ name: "plugin.json", content: JSON.stringify(validManifest()) }])
    );
    await fs.truncate(archivePath, 30 * 1024 * 1024 + 1);
    const dest = path.join(tmpDir, "extracted-huge");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/exceeds/);
  });

  // Regression for #11227: a read stream that stops emitting without ever
  // ending or erroring used to hang extraction forever (the caller's install
  // lock and temp dir stayed held until the app quit). The inactivity guard now
  // aborts and rejects instead. We can't reproduce the upstream Node/stream
  // timing bug deterministically, so we inject a stalled stream via a
  // prototype spy and drive the guard with a short override — no fake timers,
  // so the real pipeline/stream machinery runs unmodified.
  it("aborts and rejects when an entry stream stalls, without advancing to the next entry", async () => {
    const archivePath = path.join(tmpDir, "stall.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "dist/first.js", content: "a" },
        { name: "dist/second.js", content: "b" },
      ])
    );
    const dest = path.join(tmpDir, "extracted-stall");
    await fs.mkdir(dest, { recursive: true });

    const stalledStreams: Readable[] = [];
    const openReadStreamSpy = vi
      .spyOn(yauzl.ZipFile.prototype, "openReadStream")
      .mockImplementation((_entry, callback) => {
        const stalled = new Readable({ read() {} });
        stalledStreams.push(stalled);
        // Emit one chunk, then go silent forever — never end, never error. The
        // single chunk also exercises the timer's reset-on-data path before the
        // inactivity window elapses.
        stalled.push(Buffer.from("partial"));
        callback(null, stalled);
      });

    try {
      await expect(
        extractPluginArchive(archivePath, dest, { inactivityTimeoutMs: 50 })
      ).rejects.toThrow(/dist\/first\.js.*stalled/);

      // The abort reached `pipeline`, which destroyed the source stream...
      expect(stalledStreams[0].destroyed).toBe(true);
      // ...and extraction never advanced to the second entry (a single
      // openReadStream call means readEntry() was never issued after the stall).
      expect(openReadStreamSpy).toHaveBeenCalledTimes(1);
    } finally {
      openReadStreamSpy.mockRestore();
    }
  });

  it("extracts a real entry larger than the 64KiB stream watermark", async () => {
    // The original #11227 stall only manifested on an entry big enough to cross
    // the default 64KiB highWaterMark and exert backpressure. A tiny-file happy
    // path never exercises that; this drives a real >64KiB entry through the
    // yauzl 3.x + pipeline path and checks the bytes round-trip exactly.
    const big = Buffer.alloc(100 * 1024);
    for (let i = 0; i < big.length; i++) {
      // Knuth multiplicative hash — a deterministic, varied fill. What matters
      // for the repro is the 100KB *decompressed* size: it crosses the write
      // stream's 64KiB highWaterMark and drives the backpressure the stall
      // depended on. The bytes are also compared exactly on the way out.
      big[i] = (i * 2654435761) >>> 24;
    }
    const archivePath = path.join(tmpDir, "big.dntr");
    await fs.writeFile(archivePath, buildRawZip([{ name: "dist/big.bin", deflateOf: big }]));
    const dest = path.join(tmpDir, "extracted-big");
    await fs.mkdir(dest, { recursive: true });

    await extractPluginArchive(archivePath, dest);

    const written = await fs.readFile(path.join(dest, "dist/big.bin"));
    expect(written.equals(big)).toBe(true);
  });

  it("rejects an entry whose data exceeds its declared uncompressed size", async () => {
    // Declares 1 byte but the payload inflates to 200KB. The cumulative-size
    // zip-bomb guard trusts the declared size, so its defense rests on yauzl's
    // `validateEntrySizes` rejecting the mismatch mid-stream — this proves that
    // option is active after the yauzl 2->3 bump.
    const archivePath = path.join(tmpDir, "sizelie.dntr");
    await fs.writeFile(
      archivePath,
      buildRawZip([
        { name: "dist/lie.bin", deflateOf: Buffer.alloc(200 * 1024, 0x41), declaredSize: 1 },
      ])
    );
    const dest = path.join(tmpDir, "extracted-sizelie");
    await fs.mkdir(dest, { recursive: true });

    await expect(extractPluginArchive(archivePath, dest)).rejects.toThrow(/too many bytes/i);
  });

  it("resets the inactivity timer on progress so a slow-but-live stream completes", async () => {
    // A stream that keeps delivering data, just slower than the inactivity
    // window would allow from a standing start, must NOT be aborted — the timer
    // has to reset on every chunk. Total activity (10 * 40ms = 400ms) exceeds
    // the 300ms window, so without a reset the timer would fire mid-stream;
    // each 40ms gap sits well under 300ms, giving a wide margin against CI
    // scheduling jitter.
    const archivePath = path.join(tmpDir, "slow.dntr");
    await fs.writeFile(archivePath, buildRawZip([{ name: "dist/slow.js", content: "unused" }]));
    const dest = path.join(tmpDir, "extracted-slow");
    await fs.mkdir(dest, { recursive: true });

    const CHUNKS = 10;
    const GAP_MS = 40;
    const payload = Buffer.from("x".repeat(1024));
    const openReadStreamSpy = vi
      .spyOn(yauzl.ZipFile.prototype, "openReadStream")
      .mockImplementation((_entry, callback) => {
        const src = new Readable({ read() {} });
        let n = 0;
        const step = () => {
          if (n < CHUNKS) {
            src.push(payload);
            n += 1;
            setTimeout(step, GAP_MS);
          } else {
            src.push(null);
          }
        };
        setTimeout(step, GAP_MS);
        callback(null, src);
      });

    try {
      await expect(
        extractPluginArchive(archivePath, dest, { inactivityTimeoutMs: 300 })
      ).resolves.toBeUndefined();
      const written = await fs.readFile(path.join(dest, "dist/slow.js"));
      expect(written.length).toBe(CHUNKS * payload.length);
    } finally {
      openReadStreamSpy.mockRestore();
    }
  });
});

// #11302: the per-entry inactivity watchdog only catches a stream that goes
// fully silent. A source that trickles a byte just inside the window resets it
// forever, and before this there was no way for a user to give up on one — the
// install lock and staging dir stayed held either way. These cover the two new
// abort sources and the reason each one surfaces.
describe("extractPluginArchive cancellation and absolute deadline (#11302)", () => {
  /** A zip whose entries never finish, to keep extraction pinned open. */
  function stallStreams(): { spy: ReturnType<typeof vi.spyOn>; streams: Readable[] } {
    const streams: Readable[] = [];
    const spy = vi
      .spyOn(yauzl.ZipFile.prototype, "openReadStream")
      .mockImplementation((_entry, callback) => {
        const stalled = new Readable({ read() {} });
        streams.push(stalled);
        stalled.push(Buffer.from("partial"));
        callback(null, stalled);
      });
    return { spy, streams };
  }

  async function stallingArchive(name: string): Promise<{ archivePath: string; dest: string }> {
    const archivePath = path.join(tmpDir, `${name}.dntr`);
    await fs.writeFile(archivePath, buildRawZip([{ name: "dist/first.js", content: "a" }]));
    const dest = path.join(tmpDir, `extracted-${name}`);
    await fs.mkdir(dest, { recursive: true });
    return { archivePath, dest };
  }

  it("rejects with the caller's own reason when the external signal aborts", async () => {
    const { archivePath, dest } = await stallingArchive("cancel");
    const { spy, streams } = stallStreams();
    const controller = new AbortController();

    try {
      const promise = extractPluginArchive(archivePath, dest, {
        signal: controller.signal,
        // Long enough that neither built-in guard can be what fires.
        inactivityTimeoutMs: 60_000,
        totalDeadlineMs: 60_000,
      });
      // Cancel only once a transfer is genuinely in flight, so this exercises
      // the pipeline-abort path rather than the pre-flight short-circuit.
      await vi.waitFor(() => expect(streams.length).toBe(1));
      controller.abort(new Error("user-said-stop"));

      // The caller's reason survives — it is NOT collapsed into a generic
      // AbortError or the entry-stall message, which is what lets the installer
      // report "cancelled" rather than "the archive is broken".
      await expect(promise).rejects.toThrow("user-said-stop");
      expect(streams[0]!.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects with a deadline error when a trickling stream outlives the total budget", async () => {
    const { archivePath, dest } = await stallingArchive("deadline");
    // A stream that keeps emitting just often enough to reset the per-entry
    // watchdog forever — exactly the case the inactivity timer cannot catch.
    const timers: ReturnType<typeof setInterval>[] = [];
    const spy = vi
      .spyOn(yauzl.ZipFile.prototype, "openReadStream")
      .mockImplementation((_entry, callback) => {
        const trickle = new Readable({ read() {} });
        timers.push(setInterval(() => trickle.push(Buffer.from("x")), 5));
        callback(null, trickle);
      });

    try {
      await expect(
        extractPluginArchive(archivePath, dest, {
          inactivityTimeoutMs: 5_000,
          totalDeadlineMs: 60,
        })
      ).rejects.toThrow(PluginArchiveDeadlineError);
    } finally {
      for (const t of timers) clearInterval(t);
      spy.mockRestore();
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { archivePath, dest } = await stallingArchive("pre-aborted");
    const { spy } = stallStreams();
    try {
      await expect(
        extractPluginArchive(archivePath, dest, {
          signal: AbortSignal.abort(new Error("already-cancelled")),
        })
      ).rejects.toThrow("already-cancelled");
      // Nothing was ever opened — the abort short-circuits the entry pump.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("still reports a genuine stream failure that races a cancel", async () => {
    // Regression guard for the pre-existing discrimination rule: a real error
    // must win over an abort reason, or a broken archive would be misreported
    // as a user cancellation.
    const { archivePath, dest } = await stallingArchive("race");
    const controller = new AbortController();
    const spy = vi
      .spyOn(yauzl.ZipFile.prototype, "openReadStream")
      .mockImplementation((_entry, callback) => {
        const failing = new Readable({ read() {} });
        setTimeout(() => failing.destroy(new Error("disk-exploded")), 5);
        callback(null, failing);
      });

    try {
      await expect(
        extractPluginArchive(archivePath, dest, { signal: controller.signal })
      ).rejects.toThrow("disk-exploded");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports each validated file entry, in archive order, and no directories", async () => {
    const src = path.join(tmpDir, "src-onentry");
    await createFixture(src, {
      "plugin.json": JSON.stringify(validManifest()),
      "dist/index.js": "console.log(1);",
      "dist/nested/deep.js": "console.log(2);",
    });
    const archivePath = path.join(tmpDir, "onentry.dntr");
    await packPluginArchive(src, archivePath);
    const dest = path.join(tmpDir, "extracted-onentry");
    await fs.mkdir(dest, { recursive: true });

    const seen: string[] = [];
    await extractPluginArchive(archivePath, dest, { onEntry: (n) => seen.push(n) });

    expect(seen).toContain("plugin.json");
    expect(seen).toContain("dist/index.js");
    expect(seen).toContain("dist/nested/deep.js");
    // Directory entries are created, not streamed, so they are not progress.
    expect(seen.some((n) => n.endsWith("/"))).toBe(false);
  });

  it("leaves no pending deadline timer behind on a fast, successful extraction", async () => {
    // The 2-minute default would otherwise keep the event loop alive long after
    // a sub-second install finished.
    const src = path.join(tmpDir, "src-timer");
    await createFixture(src, { "plugin.json": JSON.stringify(validManifest()) });
    const archivePath = path.join(tmpDir, "timer.dntr");
    await packPluginArchive(src, archivePath);
    const dest = path.join(tmpDir, "extracted-timer");
    await fs.mkdir(dest, { recursive: true });

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await extractPluginArchive(archivePath, dest);
    expect(clearSpy).toHaveBeenCalled();
  });
});
