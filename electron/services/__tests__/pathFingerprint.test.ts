import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { createHash } from "crypto";
import os from "os";
import path from "path";
import { fingerprintPaths } from "../pathFingerprint.js";
import { FILE_PREVIEW_MAX_BYTES } from "../../utils/fileLimits.js";

/**
 * Exercised against a real filesystem rather than a mocked `fs`: the whole point
 * of the fingerprint is which physical changes it can and cannot distinguish,
 * and a mock would only ever confirm the assertions were written to match the
 * implementation.
 */
describe("fingerprintPaths", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-fingerprint-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is stable across samples when nothing changed", async () => {
    const file = path.join(root, "stable.txt");
    await fs.writeFile(file, "unchanged");

    const before = await fingerprintPaths(root, [root, file]);
    const after = await fingerprintPaths(root, [root, file]);

    expect(after).toEqual(before);
  });

  it("moves a file's fingerprint on a rewrite that preserves its length", async () => {
    // Same byte count on purpose: a fingerprint built from size alone would call
    // this unchanged, and an agent rewriting a line in place is the common case.
    const file = path.join(root, "edited.txt");
    await fs.writeFile(file, "aaaa");
    const [before] = await fingerprintPaths(root, [file]);

    await fs.writeFile(file, "bbbb");
    const [after] = await fingerprintPaths(root, [file]);

    expect(after).not.toBe(before);
  });

  it("folds previewable file contents into the fingerprint", async () => {
    const content = "content signal";
    const file = path.join(root, "content.txt");
    await fs.writeFile(file, content);

    const [fingerprint] = await fingerprintPaths(root, [file]);
    const digest = createHash("sha1").update(content).digest("hex").slice(0, 16);

    expect(fingerprint).toMatch(new RegExp(`:${digest}$`));
  });

  it("reads no more than the preview ceiling when a file grows after its stat", async () => {
    const file = path.join(root, "growing.log");
    await fs.writeFile(file, "start");
    const realOpen = fs.open;
    let bytesRead = 0;
    let closed = false;
    const spy = vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<{
        bytesRead: number;
      }>;
      let grown = false;
      const realClose = handle.close.bind(handle);
      return Object.assign(Object.create(handle) as FileHandle, {
        read: async (...readArgs: unknown[]) => {
          // A writer appends far past the ceiling once the descriptor is open.
          if (!grown) {
            grown = true;
            await fs.appendFile(file, Buffer.alloc(FILE_PREVIEW_MAX_BYTES * 4, 0x61));
          }
          const result = await realRead(...readArgs);
          bytesRead += result.bytesRead;
          return result;
        },
        close: async () => {
          closed = true;
          await realClose();
        },
      });
    }) as typeof fs.open);
    const [fingerprint] = await fingerprintPaths(root, [file]).finally(() => spy.mockRestore());

    // Past the ceiling the digest falls back to the metadata-only marker.
    expect(fingerprint).toMatch(/:-$/);
    expect(bytesRead).toBeLessThanOrEqual(FILE_PREVIEW_MAX_BYTES + 1);
    expect(closed).toBe(true);
  });

  it("closes the descriptor when the read fails", async () => {
    const file = path.join(root, "failing.txt");
    await fs.writeFile(file, "content");
    const realOpen = fs.open;
    let closed = false;
    const spy = vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<FileHandle>)(...args);
      const realClose = handle.close.bind(handle);
      return Object.assign(Object.create(handle) as FileHandle, {
        read: async () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
        close: async () => {
          closed = true;
          await realClose();
        },
      });
    }) as typeof fs.open);
    const [fingerprint] = await fingerprintPaths(root, [file]).finally(() => spy.mockRestore());

    expect(fingerprint).toBeNull();
    expect(closed).toBe(true);
  });

  it("digests a file of exactly the preview ceiling", async () => {
    const file = path.join(root, "exact.txt");
    const content = Buffer.alloc(FILE_PREVIEW_MAX_BYTES, 0x62);
    await fs.writeFile(file, content);

    const [fingerprint] = await fingerprintPaths(root, [file]);
    const digest = createHash("sha1").update(content).digest("hex").slice(0, 16);

    expect(fingerprint).toMatch(new RegExp(`:${digest}$`));
  });

  it("separates two directories that differ only in the names they hold", async () => {
    // Both are stamped to the same mtime and hold the same number of entries, so
    // the only thing left to tell them apart is the digest of their children —
    // which is what a same-count rename inside one directory relies on. Two
    // directories rather than one renamed twice, because `utimes` cannot restore
    // a nanosecond-precision mtime exactly and the comparison would then pass on
    // the timestamp instead of the digest.
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    await fs.mkdir(left);
    await fs.mkdir(right);
    await fs.writeFile(path.join(left, "one.txt"), "x");
    await fs.writeFile(path.join(right, "two.txt"), "x");

    const stamp = new Date(1_700_000_000_000);
    await fs.utimes(left, stamp, stamp);
    await fs.utimes(right, stamp, stamp);

    const [leftStats, rightStats] = await Promise.all([
      fs.stat(left, { bigint: true }),
      fs.stat(right, { bigint: true }),
    ]);
    // Precondition, at the same nanosecond precision the fingerprint uses:
    // without this the assertion below could pass on a timestamp difference and
    // prove nothing about the digest.
    expect(leftStats.mtimeNs).toBe(rightStats.mtimeNs);

    const [leftPrint, rightPrint] = await fingerprintPaths(root, [left, right]);
    expect(leftPrint).not.toBeNull();
    expect(leftPrint).not.toBe(rightPrint);
  });

  it("fingerprints a batch wider than its worker pool without losing positions", async () => {
    // More paths than the concurrency bound, alternating present and absent, so
    // an off-by-one in the pool's index handout would misalign the answers.
    const files = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const target = path.join(root, `batch-${index}`);
        if (index % 2 === 0) await fs.writeFile(target, `content-${index}`);
        return target;
      })
    );

    const results = await fingerprintPaths(root, files);

    expect(results).toHaveLength(files.length);
    expect(results.map((value) => value !== null)).toEqual(
      files.map((_, index) => index % 2 === 0)
    );
  });

  it("moves a directory's fingerprint on a rename that keeps the entry count", async () => {
    // The case a directory mtime alone cannot be trusted for: same number of
    // entries, and on a coarse-granularity filesystem potentially the same
    // timestamp. Only the hashed child-name list separates these two states.
    await fs.writeFile(path.join(root, "one.txt"), "x");
    await fs.writeFile(path.join(root, "two.txt"), "y");
    const [before] = await fingerprintPaths(root, [root]);

    await fs.rename(path.join(root, "two.txt"), path.join(root, "three.txt"));
    const [after] = await fingerprintPaths(root, [root]);

    expect(after).not.toBe(before);
  });

  it("distinguishes a file from a directory of the same name", async () => {
    // A delete-then-recreate that swaps an entry's kind is a change the tree
    // renders, and folding both to one fingerprint shape would hide it.
    const target = path.join(root, "swap");
    await fs.mkdir(target);
    const [asDirectory] = await fingerprintPaths(root, [target]);

    await fs.rmdir(target);
    await fs.writeFile(target, "now a file");
    const [asFile] = await fingerprintPaths(root, [target]);

    expect(asDirectory).not.toBeNull();
    expect(asFile).not.toBeNull();
    expect(asFile).not.toBe(asDirectory);
  });

  it("reports a path appearing and disappearing", async () => {
    const file = path.join(root, "transient.txt");

    const [absent] = await fingerprintPaths(root, [file]);
    await fs.writeFile(file, "here");
    const [present] = await fingerprintPaths(root, [file]);
    await fs.rm(file);
    const [goneAgain] = await fingerprintPaths(root, [file]);

    expect(absent).toBeNull();
    expect(present).not.toBeNull();
    expect(goneAgain).toBeNull();
  });

  it("refuses a path that resolves outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-outside-"));
    try {
      const secret = path.join(outside, "secret.txt");
      await fs.writeFile(secret, "not yours");
      const escape = path.join(root, "escape");
      await fs.symlink(outside, escape);

      // Both the direct path and the in-root symlink that reaches it: `stat`
      // follows intermediate links, so only resolving first keeps this from
      // being an existence probe for arbitrary paths.
      const [direct, viaSymlink] = await fingerprintPaths(root, [
        secret,
        path.join(escape, "secret.txt"),
      ]);

      expect(direct).toBeNull();
      expect(viaSymlink).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("answers every path with null once the root itself is gone", async () => {
    const file = path.join(root, "doomed.txt");
    await fs.writeFile(file, "x");
    const [before] = await fingerprintPaths(root, [file]);

    await fs.rm(root, { recursive: true, force: true });
    const after = await fingerprintPaths(root, [root, file]);

    expect(before).not.toBeNull();
    expect(after.every((value) => value === null)).toBe(true);
  });

  it("stops probing a root once a path inside it hangs, not only the root itself", async () => {
    // A dead mount below a live root: the root keeps answering instantly, so
    // the root-level probe never times out and only the member's own hang can
    // stop the caller re-issuing it every poll. `realpath` is stubbed to never
    // settle for that one path — the same shape as a disconnected share, which
    // takes the OS a minute or more to give up on.
    const member = path.join(root, "member.txt");
    await fs.writeFile(member, "readable");

    const beforeHang = await fingerprintPaths(root, [member]);

    const realRealpath = fs.realpath;
    const spy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(((target: string, options?: unknown) =>
        target === member
          ? new Promise<string>(() => {})
          : (realRealpath as (p: string, o?: unknown) => Promise<string>)(
              target,
              options
            )) as typeof fs.realpath);
    const duringHang = await fingerprintPaths(root, [member]).finally(() => spy.mockRestore());

    // Nothing is stubbed any more and both paths are still on disk, so the only
    // thing that can answer null now is the cooldown the hung member left on
    // its root — and it covers the root, not just the path that hung.
    const afterHang = await fingerprintPaths(root, [root, member]);

    expect(beforeHang.every((value) => value !== null)).toBe(true);
    expect(duringHang).toEqual([null]);
    expect(afterHang).toEqual([null, null]);
  });

  describe("wide directories", () => {
    // Synthetic listings served for one real directory: its realpath and stat
    // stay genuine, so mtime and count are pinned and only the digest of the
    // names can differ between samples.
    let wide: string;
    let wideRealPath: string;

    beforeEach(async () => {
      wide = path.join(root, "wide");
      await fs.mkdir(wide);
      // `readdir` sees the resolved path — macOS's tmpdir is itself a symlink.
      wideRealPath = await fs.realpath(wide);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Each entry's kind is read exactly once per digest, so this counts how
    // far hashing has got through the current listing.
    let hashed = 0;

    function entry(name: string, isDirectory = false) {
      return {
        name,
        isDirectory: () => {
          hashed++;
          return isDirectory;
        },
      };
    }

    function names(count: number) {
      return Array.from({ length: count }, (_, index) => entry(`file-${index}.ts`));
    }

    function serve(entries: ReturnType<typeof entry>[], onListed?: () => void) {
      const realReaddir = fs.readdir;
      return vi.spyOn(fs, "readdir").mockImplementation((async (
        target: string,
        options?: unknown
      ) => {
        if (target !== wideRealPath) {
          return (realReaddir as (t: string, o?: unknown) => Promise<unknown>)(target, options);
        }
        onListed?.();
        return entries;
      }) as typeof fs.readdir);
    }

    async function sample(entries: ReturnType<typeof entry>[]) {
      const spy = serve(entries);
      const [fingerprint] = await fingerprintPaths(root, [wide]).finally(() => spy.mockRestore());
      expect(fingerprint).not.toBeNull();
      return fingerprint;
    }

    function exhaustEverySlice() {
      // Every clock read lands past the slice budget, so the digest yields at
      // each checkpoint regardless of how fast the machine actually hashes.
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 50));
    }

    function freezeClock() {
      // No time ever passes, so the budget is never spent however many
      // checkpoints a listing crosses.
      vi.spyOn(performance, "now").mockReturnValue(0);
    }

    async function settleOrder(entries: ReturnType<typeof entry>[]) {
      // An Immediate queued the moment the listing is handed back can only run
      // before the fingerprint settles if hashing that listing gave the event
      // loop a turn: everything after `readdir` is otherwise microtasks.
      const order: string[] = [];
      let hashedWhenLoopRan = -1;
      serve(entries, () => {
        hashed = 0;
        setImmediate(() => {
          hashedWhenLoopRan = hashed;
          order.push("event loop");
        });
      });
      const [fingerprint] = await fingerprintPaths(root, [wide]);
      order.push("settled");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { fingerprint, order, hashedWhenLoopRan };
    }

    it("gives the event loop a turn while hashing a wide listing", async () => {
      const entries = names(5_000);
      freezeClock();
      const unyielded = await sample(entries);
      vi.restoreAllMocks();

      exhaustEverySlice();
      const { fingerprint, order, hashedWhenLoopRan } = await settleOrder(entries);

      expect(order).toEqual(["event loop", "settled"]);
      // The turn came part-way through, not after the whole listing was hashed.
      expect(hashedWhenLoopRan).toBeGreaterThan(0);
      expect(hashedWhenLoopRan).toBeLessThan(entries.length);
      // Yielding changes when the answer arrives, never what it is.
      expect(fingerprint).toBe(unyielded);
    });

    it("hashes a listing narrower than one checkpoint without yielding", async () => {
      exhaustEverySlice();
      const { order } = await settleOrder(names(100));

      expect(order).toEqual(["settled", "event loop"]);
    });

    it("hashes a wide listing straight through while it stays inside the budget", async () => {
      freezeClock();
      const { order } = await settleOrder(names(5_000));

      expect(order).toEqual(["settled", "event loop"]);
    });

    it("is independent of the order readdir returns entries in", async () => {
      const entries = [...names(3_000), entry("nested", true)];

      const forward = await sample(entries);
      const reversed = await sample([...entries].reverse());
      const shuffled = await sample(
        entries
          .filter((_, index) => index % 2 === 1)
          .concat(entries.filter((_, index) => index % 2 === 0))
      );

      expect(reversed).toBe(forward);
      expect(shuffled).toBe(forward);
    });

    it("moves on any single-entry rename, kind change, addition or removal among near-identical names", async () => {
      // Same directory mtime, long shared prefixes and one-character
      // differences: the shapes a weak per-entry hash folds together.
      const base = names(2_000);
      const variants = [base];
      for (const index of [0, 1, 9, 10, 99, 500, 1_023, 1_024, 1_999]) {
        const swap = (replacement: ReturnType<typeof entry>) =>
          base.map((item, at) => (at === index ? replacement : item));
        variants.push(
          swap(entry(`file-${index}.tsx`)),
          swap(entry(`file-${index}.t`)),
          swap(entry(`File-${index}.ts`)),
          swap(entry(`file-${index + 2_000}.ts`)),
          swap(entry(`file-${index}.ts`, true)),
          swap(entry(`file-${index}.ts\u0301`)),
          swap(entry(`file-${index}.ts\u{1F600}`))
        );
      }

      variants.push(base.slice(1), [...base, entry("file-2000.ts")]);

      const prints = new Set<string | null>();
      for (const variant of variants) prints.add(await sample(variant));

      expect(prints.size).toBe(variants.length);
    });
  });

  it("returns nothing for an empty request without touching the filesystem", async () => {
    expect(await fingerprintPaths(root, [])).toEqual([]);
  });

  it("refuses a relative root rather than resolving it against the process cwd", async () => {
    const results = await fingerprintPaths("relative/root", [path.join(root, "a.txt")]);
    expect(results).toEqual([null]);
  });
});
