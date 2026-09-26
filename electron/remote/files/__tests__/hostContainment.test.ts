import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBeneath, openDirectoryBeneath } from "../hostContainment.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "contain-root-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "contain-out-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("openDirectoryBeneath", () => {
  it("holds a folder below the anchor and names entries inside it", async () => {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    const held = await openDirectoryBeneath(root, ["a", "b"]);
    if (held === null || held === "not-a-directory") throw new Error("expected a folder");
    try {
      expect(held.canonicalPath).toBe(path.join(root, "a", "b"));
      await held.verify();
      await fs.writeFile(held.entry("x.txt"), "x");
      expect(await fs.readFile(path.join(root, "a", "b", "x.txt"), "utf8")).toBe("x");
      expect(() => held.entry("../escape")).toThrow();
    } finally {
      await held.close();
    }
  });

  it("holds the anchor itself for no components", async () => {
    const held = await openDirectoryBeneath(root, []);
    if (held === null || held === "not-a-directory") throw new Error("expected a folder");
    expect(held.canonicalPath).toBe(root);
    await held.close();
  });

  it("follows a symlink that stays inside, and refuses one that leaves", async () => {
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "inside"));
    await fs.symlink(outside, path.join(root, "leaves"));
    const inside = await openDirectoryBeneath(root, ["inside"]);
    if (inside === null || inside === "not-a-directory") throw new Error("expected a folder");
    expect(inside.canonicalPath).toBe(path.join(root, "real"));
    await inside.close();
    expect(await openDirectoryBeneath(root, ["leaves"])).toBeNull();
  });

  it("refuses a path through an ancestor that is a symlink out of the anchor", async () => {
    await fs.mkdir(path.join(outside, "docs"));
    await fs.symlink(outside, path.join(root, "a"));
    expect(await openDirectoryBeneath(root, ["a", "docs"])).toBeNull();
  });

  it("won't start from an anchor swapped for a symlink after it was resolved", async () => {
    const anchor = path.join(root, "project");
    await fs.symlink(outside, anchor);
    expect(await openDirectoryBeneath(anchor, [])).toBeNull();
    expect(await openBeneath(anchor, ["f.txt"])).toBeNull();
  });

  it("reports a file where a folder was wanted", async () => {
    await fs.writeFile(path.join(root, "file.txt"), "x");
    expect(await openDirectoryBeneath(root, ["file.txt"])).toBe("not-a-directory");
    expect(await openDirectoryBeneath(root, ["missing"])).toBeNull();
    expect(await openDirectoryBeneath(root, [".."])).toBeNull();
  });

  it("never writes outside once an ancestor is swapped for a symlink out", async () => {
    await fs.mkdir(path.join(root, "a", "docs"), { recursive: true });
    await fs.mkdir(path.join(outside, "a", "docs"), { recursive: true });
    const held = await openDirectoryBeneath(root, ["a", "docs"]);
    if (held === null || held === "not-a-directory") throw new Error("expected a folder");
    await fs.rename(path.join(root, "a"), path.join(root, "a-moved"));
    await fs.symlink(path.join(outside, "a"), path.join(root, "a"));
    try {
      // The Linux path goes through the held descriptor and lands in the moved
      // folder; elsewhere verify() sees the chain no longer names it and stops.
      await held
        .verify()
        .then(() => fs.writeFile(held.entry("x.txt"), "x"))
        .catch(() => {});
    } finally {
      await held.close();
    }
    expect(await fs.readdir(path.join(outside, "a", "docs"))).toEqual([]);
  });
});

describe("openBeneath", () => {
  it("still opens a regular file and reports a folder as not-a-file", async () => {
    await fs.mkdir(path.join(root, "d"));
    await fs.writeFile(path.join(root, "d", "f.txt"), "hello");
    const opened = await openBeneath(root, ["d", "f.txt"]);
    if (opened === null || opened === "not-a-file") throw new Error("expected a file");
    expect(opened.canonicalPath).toBe(path.join(root, "d", "f.txt"));
    await opened.handle.close();
    expect(await openBeneath(root, ["d"])).toBe("not-a-file");
    expect(await openBeneath(root, [])).toBe("not-a-file");
  });
});
