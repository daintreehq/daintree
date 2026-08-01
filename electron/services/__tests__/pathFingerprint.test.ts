import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fingerprintPaths } from "../pathFingerprint.js";

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

  it("returns one fingerprint per requested path, positionally", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "a");
    await fs.writeFile(b, "b");

    const [first, second, third] = await fingerprintPaths(root, [
      a,
      path.join(root, "missing.txt"),
      b,
    ]);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).not.toBeNull();
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

  it("is stable across repeated samples of an untouched wide directory", async () => {
    // Names enough entries that an implementation depending on enumeration order
    // has room to drift. It cannot force two different `readdir` orders, so it
    // pins stability rather than proving order-independence — the digest's
    // commutativity is what provides that, and the two-directory test above is
    // what proves the digest is consulted at all.
    const wide = path.join(root, "wide");
    await fs.mkdir(wide);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => fs.writeFile(path.join(wide, `f${index}`), "x"))
    );

    const [first] = await fingerprintPaths(root, [wide]);
    const [second] = await fingerprintPaths(root, [wide]);

    expect(first).toBe(second);
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

  it("returns nothing for an empty request without touching the filesystem", async () => {
    expect(await fingerprintPaths(root, [])).toEqual([]);
  });

  it("refuses a relative root rather than resolving it against the process cwd", async () => {
    const results = await fingerprintPaths("relative/root", [path.join(root, "a.txt")]);
    expect(results).toEqual([null]);
  });
});
